/**
 * 合同与采购立项全生命周期管理系统 - 生产级后端服务 (零额外依赖完整版)
 * 仅依赖：express, better-sqlite3, multer (100% 匹配原 package.json 与 Electron 环境)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const Database = require('better-sqlite3');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ==================== 1. 核心目录初始化（兼容 Electron 环境变量与安全边界） ====================
const ROOT_DIR = __dirname;
const DATA_DIR = process.env.CONTRACT_DATA_DIR
  ? path.resolve(process.env.CONTRACT_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
const UPLOAD_DIR = process.env.CONTRACT_UPLOAD_DIR
  ? path.resolve(process.env.CONTRACT_UPLOAD_DIR)
  : path.join(ROOT_DIR, 'uploads');
const TMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.tmp');
const RELATED_UPLOAD_DIR = path.join(UPLOAD_DIR, 'related');
const PROCUREMENT_UPLOAD_DIR = path.join(UPLOAD_DIR, 'procurement');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

for (const dir of [DATA_DIR, UPLOAD_DIR, TMP_UPLOAD_DIR, RELATED_UPLOAD_DIR, PROCUREMENT_UPLOAD_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isSafePathWithin(targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase) && resolvedTarget !== path.resolve(baseDir);
}

function triggerSafeGC() {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch (e) {}
  }
}

// ==================== 2. 数据库初始化与高并发 WAL 配置 ====================
const DB_PATH = path.join(DATA_DIR, 'contracts.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -16000');

db.exec(`
  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_no TEXT NOT NULL DEFAULT '',
    contract_no TEXT NOT NULL UNIQUE,
    contract_name TEXT NOT NULL,
    contract_type TEXT NOT NULL DEFAULT '采购合同',
    party_a TEXT NOT NULL,
    party_b TEXT NOT NULL,
    party_c TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    sign_date TEXT NOT NULL,
    start_date TEXT NOT NULL DEFAULT '',
    end_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '履行中',
    department TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    file_original_name TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    file_uploaded_at TEXT NOT NULL DEFAULT '',
    procurement_id INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS contract_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    file_original_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS procurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_no TEXT NOT NULL DEFAULT '',
    procurement_no TEXT NOT NULL UNIQUE,
    project_name TEXT NOT NULL,
    procurement_type TEXT NOT NULL DEFAULT '货物采购',
    procurement_method TEXT NOT NULL DEFAULT '询价采购',
    budget_amount REAL NOT NULL DEFAULT 0,
    control_price REAL NOT NULL DEFAULT 0,
    final_amount REAL NOT NULL DEFAULT 0,
    department TEXT NOT NULL DEFAULT '',
    applicant TEXT NOT NULL DEFAULT '',
    approval_date TEXT NOT NULL,
    supplier_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '已立项待采购',
    contract_id INTEGER DEFAULT NULL,
    remark TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS procurement_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    procurement_id INTEGER NOT NULL,
    file_category TEXT NOT NULL DEFAULT '立项资料',
    file_path TEXT NOT NULL,
    file_original_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (procurement_id) REFERENCES procurements(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

const existingContractCols = new Set(db.prepare(`PRAGMA table_info(contracts)`).all().map(c => c.name));
if (!existingContractCols.has('party_c')) {
  db.exec(`ALTER TABLE contracts ADD COLUMN party_c TEXT NOT NULL DEFAULT ''`);
}
if (!existingContractCols.has('procurement_id')) {
  db.exec(`ALTER TABLE contracts ADD COLUMN procurement_id INTEGER DEFAULT NULL`);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_contracts_sign_date ON contracts(sign_date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
  CREATE INDEX IF NOT EXISTS idx_contracts_type ON contracts(contract_type);
  CREATE INDEX IF NOT EXISTS idx_contracts_proc_id ON contracts(procurement_id);
  CREATE INDEX IF NOT EXISTS idx_contract_files_cid ON contract_files(contract_id);
  CREATE INDEX IF NOT EXISTS idx_procurements_date ON procurements(approval_date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_procurements_status ON procurements(status);
  CREATE INDEX IF NOT EXISTS idx_procurements_cid ON procurements(contract_id);
  CREATE INDEX IF NOT EXISTS idx_procurement_files_pid ON procurement_files(procurement_id);
`);

// ==================== 3. 预编译高频 SQL 语句 ====================
const STMTS = {
  getSetting: db.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = ?`),
  setSetting: db.prepare(`
    INSERT INTO system_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = datetime('now', 'localtime')
  `),
  getContractById: db.prepare(`SELECT * FROM contracts WHERE id = ?`),
  checkDuplicateNoOnCreate: db.prepare(`SELECT id FROM contracts WHERE contract_no = ?`),
  checkDuplicateNoOnUpdate: db.prepare(`SELECT id FROM contracts WHERE contract_no = ? AND id != ?`),
  getRelatedFilesByContractId: db.prepare(`SELECT * FROM contract_files WHERE contract_id = ? ORDER BY id ASC`),
  getRelatedFileById: db.prepare(`SELECT * FROM contract_files WHERE id = ? AND contract_id = ?`),
  insertRelatedFile: db.prepare(`
    INSERT INTO contract_files (contract_id, file_path, file_original_name, file_size, uploaded_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  deleteRelatedFileById: db.prepare(`DELETE FROM contract_files WHERE id = ?`),

  getProcurementById: db.prepare(`SELECT * FROM procurements WHERE id = ?`),
  checkDupProcNoCreate: db.prepare(`SELECT id FROM procurements WHERE procurement_no = ?`),
  checkDupProcNoUpdate: db.prepare(`SELECT id FROM procurements WHERE procurement_no = ? AND id != ?`),
  getProcFilesByProcId: db.prepare(`SELECT * FROM procurement_files WHERE procurement_id = ? ORDER BY id ASC`),
  getProcFileById: db.prepare(`SELECT * FROM procurement_files WHERE id = ? AND procurement_id = ?`),
  insertProcFile: db.prepare(`
    INSERT INTO procurement_files (procurement_id, file_category, file_path, file_original_name, file_size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  deleteProcFileById: db.prepare(`DELETE FROM procurement_files WHERE id = ?`)
};

// ==================== 4. 编号规则与“零空洞（Gap-Filling）+ 自动顺延”引擎 ====================
const DEFAULT_CONTRACT_NO_RULE = {
  prefix: 'HT-',
  date_format: 'YYYYMM',
  seq_digits: 3,
  suffix: ''
};

const DEFAULT_PROCUREMENT_NO_RULE = {
  prefix: 'LX',
  date_format: 'YYYYMMDD',
  seq_digits: 3,
  suffix: ''
};

function getContractNoRule() {
  try {
    const row = STMTS.getSetting.get('contract_no_rule');
    if (row && row.setting_value) {
      const parsed = JSON.parse(row.setting_value);
      return {
        prefix: typeof parsed.prefix === 'string' ? parsed.prefix.trim() : DEFAULT_CONTRACT_NO_RULE.prefix,
        date_format: ['YYYY', 'YYYYMM', 'YYYYMMDD', 'NONE'].includes(parsed.date_format) ? parsed.date_format : DEFAULT_CONTRACT_NO_RULE.date_format,
        seq_digits: Number.isInteger(Number(parsed.seq_digits)) && Number(parsed.seq_digits) >= 0 && Number(parsed.seq_digits) <= 8
          ? Number(parsed.seq_digits)
          : DEFAULT_CONTRACT_NO_RULE.seq_digits,
        suffix: typeof parsed.suffix === 'string' ? parsed.suffix.trim() : ''
      };
    }
  } catch (e) {}
  return { ...DEFAULT_CONTRACT_NO_RULE };
}

function getProcurementNoRule() {
  try {
    const row = STMTS.getSetting.get('procurement_no_rule');
    if (row && row.setting_value) {
      const parsed = JSON.parse(row.setting_value);
      return {
        prefix: typeof parsed.prefix === 'string' ? parsed.prefix.trim() : DEFAULT_PROCUREMENT_NO_RULE.prefix,
        date_format: ['YYYY', 'YYYYMM', 'YYYYMMDD', 'NONE'].includes(parsed.date_format) ? parsed.date_format : DEFAULT_PROCUREMENT_NO_RULE.date_format,
        seq_digits: Number.isInteger(Number(parsed.seq_digits)) && Number(parsed.seq_digits) >= 0 && Number(parsed.seq_digits) <= 8
          ? Number(parsed.seq_digits)
          : DEFAULT_PROCUREMENT_NO_RULE.seq_digits,
        suffix: typeof parsed.suffix === 'string' ? parsed.suffix.trim() : ''
      };
    }
  } catch (e) {}
  return { ...DEFAULT_PROCUREMENT_NO_RULE };
}

function buildDatePartByFormat(dateFormat, dateStr) {
  const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '').trim())
    ? String(dateStr).trim()
    : new Date().toISOString().slice(0, 10);
  const [yyyy, mm, dd] = cleanDate.split('-');
  if (dateFormat === 'YYYY') return yyyy;
  if (dateFormat === 'YYYYMM') return `${yyyy}${mm}`;
  if (dateFormat === 'YYYYMMDD') return `${yyyy}${mm}${dd}`;
  return '';
}

function findNextAvailableSeqNumber(rows, fieldName, matchStart, suffix) {
  const usedSeqSet = new Set();
  const sfx = suffix || '';
  for (const row of rows) {
    const no = String(row[fieldName] || '').trim();
    if (no.startsWith(matchStart) && (!sfx || no.endsWith(sfx))) {
      const core = no.slice(matchStart.length, sfx ? no.length - sfx.length : undefined);
      if (/^\d+$/.test(core)) {
        const num = parseInt(core, 10);
        if (num > 0) usedSeqSet.add(num);
      }
    }
  }
  let nextSeq = 1;
  while (usedSeqSet.has(nextSeq)) {
    nextSeq++;
  }
  return nextSeq;
}

function generateNextContractNoParts(rule, referenceDateStr, customMid = '') {
  const prefix = rule.prefix || '';
  const suffix = rule.suffix || '';
  const mid = String(customMid || '').trim();
  const datePart = buildDatePartByFormat(rule.date_format, referenceDateStr);

  if (rule.seq_digits === 0) {
    return {
      prefix,
      mid_custom: mid,
      date_part: datePart,
      seq_part: '',
      suffix,
      full_no: `${prefix}${mid}${datePart}${suffix}`
    };
  }

  const matchStart = `${prefix}${mid}${datePart}`;
  const rows = db.prepare(`SELECT contract_no FROM contracts WHERE contract_no LIKE ?`).all(`${matchStart}%`);
  const nextSeq = findNextAvailableSeqNumber(rows, 'contract_no', matchStart, suffix);
  const seqPart = String(nextSeq).padStart(rule.seq_digits, '0');

  return {
    prefix,
    mid_custom: mid,
    date_part: datePart,
    seq_part: seqPart,
    suffix,
    full_no: `${matchStart}${seqPart}${suffix}`
  };
}

function generateNextProcurementNoParts(rule, referenceDateStr, customMid = '') {
  const prefix = rule.prefix || '';
  const suffix = rule.suffix || '';
  const mid = String(customMid || '').trim();
  const datePart = buildDatePartByFormat(rule.date_format, referenceDateStr);

  if (rule.seq_digits === 0) {
    return {
      prefix,
      mid_custom: mid,
      date_part: datePart,
      seq_part: '',
      suffix,
      full_no: `${prefix}${mid}${datePart}${suffix}`
    };
  }

  const matchStart = `${prefix}${mid}${datePart}`;
  const rows = db.prepare(`SELECT procurement_no FROM procurements WHERE procurement_no LIKE ?`).all(`${matchStart}%`);
  const nextSeq = findNextAvailableSeqNumber(rows, 'procurement_no', matchStart, suffix);
  const seqPart = String(nextSeq).padStart(rule.seq_digits, '0');

  return {
    prefix,
    mid_custom: mid,
    date_part: datePart,
    seq_part: seqPart,
    suffix,
    full_no: `${matchStart}${seqPart}${suffix}`
  };
}

function autoResolveDuplicateContractNo(conflictNo, signDate) {
  const rule = getContractNoRule();
  const sfx = rule.suffix || '';
  const body = sfx && conflictNo.endsWith(sfx) ? conflictNo.slice(0, conflictNo.length - sfx.length) : conflictNo;
  const tailMatch = body.match(/^(.*?)(\d+)$/);

  if (tailMatch && rule.seq_digits > 0) {
    const matchStart = tailMatch[1];
    const digitsLen = Math.max(rule.seq_digits, tailMatch[2].length);
    const rows = db.prepare(`SELECT contract_no FROM contracts WHERE contract_no LIKE ?`).all(`${matchStart}%`);
    const nextSeq = findNextAvailableSeqNumber(rows, 'contract_no', matchStart, sfx);
    const candidate = `${matchStart}${String(nextSeq).padStart(digitsLen, '0')}${sfx}`;
    if (!STMTS.checkDuplicateNoOnCreate.get(candidate)) {
      return candidate;
    }
  }

  if (rule.seq_digits > 0 && conflictNo.startsWith(rule.prefix || '')) {
    const nextParts = generateNextContractNoParts(rule, signDate);
    if (!STMTS.checkDuplicateNoOnCreate.get(nextParts.full_no)) {
      return nextParts.full_no;
    }
  }
  return null;
}

function autoResolveDuplicateProcNo(conflictNo, approvalDate) {
  const rule = getProcurementNoRule();
  const sfx = rule.suffix || '';
  const body = sfx && conflictNo.endsWith(sfx) ? conflictNo.slice(0, conflictNo.length - sfx.length) : conflictNo;
  const tailMatch = body.match(/^(.*?)(\d+)$/);

  if (tailMatch && rule.seq_digits > 0) {
    const matchStart = tailMatch[1];
    const digitsLen = Math.max(rule.seq_digits, tailMatch[2].length);
    const rows = db.prepare(`SELECT procurement_no FROM procurements WHERE procurement_no LIKE ?`).all(`${matchStart}%`);
    const nextSeq = findNextAvailableSeqNumber(rows, 'procurement_no', matchStart, sfx);
    const candidate = `${matchStart}${String(nextSeq).padStart(digitsLen, '0')}${sfx}`;
    if (!STMTS.checkDupProcNoCreate.get(candidate)) {
      return candidate;
    }
  }

  if (rule.seq_digits > 0 && conflictNo.startsWith(rule.prefix || '')) {
    const nextParts = generateNextProcurementNoParts(rule, approvalDate);
    if (!STMTS.checkDupProcNoCreate.get(nextParts.full_no)) {
      return nextParts.full_no;
    }
  }
  return null;
}

const recalculateAllSequences = db.transaction(() => {
  const rows = db.prepare(`
    SELECT id, seq_no, sign_date
    FROM contracts
    ORDER BY
      CASE WHEN sign_date IS NULL OR sign_date = '' THEN 1 ELSE 0 END ASC,
      sign_date ASC,
      id ASC
  `).all();

  const updateStmt = db.prepare(`UPDATE contracts SET seq_no = ? WHERE id = ?`);
  const yearCounters = {};

  for (const row of rows) {
    const yearMatch = String(row.sign_date || '').match(/^(\d{4})/);
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
    yearCounters[year] = (yearCounters[year] || 0) + 1;
    const expectedSeq = `${year}-${String(yearCounters[year]).padStart(3, '0')}`;
    if (row.seq_no !== expectedSeq) {
      updateStmt.run(expectedSeq, row.id);
    }
  }
});

const recalculateProcurementSequences = db.transaction(() => {
  const rows = db.prepare(`
    SELECT id, seq_no, approval_date
    FROM procurements
    ORDER BY
      CASE WHEN approval_date IS NULL OR approval_date = '' THEN 1 ELSE 0 END ASC,
      approval_date ASC,
      id ASC
  `).all();

  const updateStmt = db.prepare(`UPDATE procurements SET seq_no = ? WHERE id = ?`);
  const yearCounters = {};

  for (const row of rows) {
    const yearMatch = String(row.approval_date || '').match(/^(\d{4})/);
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
    yearCounters[year] = (yearCounters[year] || 0) + 1;
    const expectedSeq = `LX-${year}-${String(yearCounters[year]).padStart(3, '0')}`;
    if (row.seq_no !== expectedSeq) {
      updateStmt.run(expectedSeq, row.id);
    }
  }
});

recalculateAllSequences();
recalculateProcurementSequences();

// ==================== 5. 跨表双向关联同步引擎 ====================
function linkContractToProcurement(contractId, newProcurementId) {
  const cid = Number(contractId);
  const pid = newProcurementId ? Number(newProcurementId) : null;

  const oldContract = STMTS.getContractById.get(cid);
  if (oldContract && oldContract.procurement_id && oldContract.procurement_id !== pid) {
    db.prepare(`UPDATE procurements SET contract_id = NULL, status = CASE WHEN status = '已签合同' THEN '已完成采购待签合同' ELSE status END, updated_at = datetime('now', 'localtime') WHERE id = ? AND contract_id = ?`).run(oldContract.procurement_id, cid);
  }

  db.prepare(`UPDATE procurements SET contract_id = NULL WHERE contract_id = ? AND id != COALESCE(?, -1)`).run(cid, pid);

  if (pid) {
    const targetProc = STMTS.getProcurementById.get(pid);
    if (targetProc) {
      if (targetProc.contract_id && targetProc.contract_id !== cid) {
        db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(targetProc.contract_id);
      }
      db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(pid, cid);
      db.prepare(`UPDATE procurements SET contract_id = ?, status = '已签合同', updated_at = datetime('now', 'localtime') WHERE id = ?`).run(cid, pid);
    } else {
      db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(cid);
    }
  } else {
    db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(cid);
  }
}

function linkProcurementToContract(procurementId, newContractId) {
  const pid = Number(procurementId);
  const cid = newContractId ? Number(newContractId) : null;

  const oldProc = STMTS.getProcurementById.get(pid);
  if (oldProc && oldProc.contract_id && oldProc.contract_id !== cid) {
    db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ? AND procurement_id = ?`).run(oldProc.contract_id, pid);
  }

  db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE procurement_id = ? AND id != COALESCE(?, -1)`).run(pid, cid);

  if (cid) {
    const targetContract = STMTS.getContractById.get(cid);
    if (targetContract) {
      if (targetContract.procurement_id && targetContract.procurement_id !== pid) {
        db.prepare(`UPDATE procurements SET contract_id = NULL WHERE id = ?`).run(targetContract.procurement_id);
      }
      db.prepare(`UPDATE procurements SET contract_id = ?, status = '已签合同' WHERE id = ?`).run(cid, pid);
      db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(pid, cid);
    } else {
      db.prepare(`UPDATE procurements SET contract_id = NULL WHERE id = ?`).run(pid);
    }
  } else {
    db.prepare(`UPDATE procurements SET contract_id = NULL WHERE id = ?`).run(pid);
  }
}

// ==================== 6. 文件归档、重命名、物理删除与零残留清道夫 ====================
function sanitizeFilenameSegment(str, maxLen = 60) {
  return String(str || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || '未命名';
}

function decodeOriginalFilename(rawName) {
  if (!rawName) return '未命名文件';
  try {
    if (/[\u4e00-\u9fa5]/.test(rawName)) return rawName;
    const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
    if (/[\u4e00-\u9fa5]/.test(decoded) || !decoded.includes('')) {
      return decoded;
    }
  } catch (e) {}
  return rawName;
}

function buildStandardMainScanName(contractNo, contractName, signDate, ext) {
  const safeNo = sanitizeFilenameSegment(contractNo, 50);
  const safeName = sanitizeFilenameSegment(contractName, 60);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(signDate || '').trim()) ? String(signDate).trim() : '无日期';
  const cleanExt = (ext || '.pdf').toLowerCase();
  return `${safeNo}_${safeName}_${safeDate}${cleanExt}`;
}

function buildContractRelatedFolderName(contractNo, contractName, signDate) {
  const safeNo = sanitizeFilenameSegment(contractNo, 50);
  const safeName = sanitizeFilenameSegment(contractName, 60);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(signDate || '').trim()) ? String(signDate).trim() : '无日期';
  return `${safeNo}_${safeName}_${safeDate}`;
}

function buildProcurementFolderName(procurementNo, projectName, approvalDate) {
  const safeNo = sanitizeFilenameSegment(procurementNo, 50);
  const safeName = sanitizeFilenameSegment(projectName, 60);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(approvalDate || '').trim()) ? String(approvalDate).trim() : '无日期';
  return `${safeNo}_${safeName}_${safeDate}`;
}

function deletePhysicalFile(relativePathFromUploads) {
  if (!relativePathFromUploads) return;
  try {
    const absPath = path.join(UPLOAD_DIR, relativePathFromUploads);
    if (isSafePathWithin(absPath, UPLOAD_DIR) && fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
  } catch (e) {}
}

function removeEmptySubdirIfClean(absSubDir, baseParentDir) {
  if (!absSubDir || !isSafePathWithin(absSubDir, baseParentDir)) return;
  try {
    if (fs.existsSync(absSubDir) && fs.statSync(absSubDir).isDirectory()) {
      const items = fs.readdirSync(absSubDir);
      if (items.length === 0) {
        fs.rmdirSync(absSubDir);
      }
    }
  } catch (e) {}
}

function finalizeUploadedFile(tempFileObj, contractNo, contractName, signDate) {
  if (!tempFileObj || !tempFileObj.path || !fs.existsSync(tempFileObj.path)) return null;
  const origName = decodeOriginalFilename(tempFileObj.originalname);
  const ext = path.extname(origName) || '.pdf';
  const baseStandardName = buildStandardMainScanName(contractNo, contractName, signDate, ext);
  const nameWithoutExt = baseStandardName.slice(0, baseStandardName.length - ext.length);

  let finalFilename = baseStandardName;
  let counter = 1;
  while (fs.existsSync(path.join(UPLOAD_DIR, finalFilename))) {
    finalFilename = `${nameWithoutExt}(${counter})${ext}`;
    counter++;
  }

  const destAbsPath = path.join(UPLOAD_DIR, finalFilename);
  fs.renameSync(tempFileObj.path, destAbsPath);
  return {
    file_path: finalFilename,
    file_original_name: origName,
    file_size: tempFileObj.size || fs.statSync(destAbsPath).size,
    file_uploaded_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
  };
}

function renameExistingScanIfNeeded(currentFilePath, contractNo, contractName, signDate) {
  if (!currentFilePath) return '';
  const currentAbs = path.join(UPLOAD_DIR, currentFilePath);
  if (!isSafePathWithin(currentAbs, UPLOAD_DIR) || !fs.existsSync(currentAbs)) {
    return currentFilePath;
  }
  const ext = path.extname(currentFilePath) || '.pdf';
  const desiredBase = buildStandardMainScanName(contractNo, contractName, signDate, ext);
  if (currentFilePath === desiredBase) return currentFilePath;

  const nameWithoutExt = desiredBase.slice(0, desiredBase.length - ext.length);
  let targetName = desiredBase;
  let counter = 1;
  while (fs.existsSync(path.join(UPLOAD_DIR, targetName)) && targetName !== currentFilePath) {
    targetName = `${nameWithoutExt}(${counter})${ext}`;
    counter++;
  }
  try {
    fs.renameSync(currentAbs, path.join(UPLOAD_DIR, targetName));
    return targetName;
  } catch (e) {
    return currentFilePath;
  }
}

function archiveRelatedFilesForContract(contractId, contractNo, contractName, signDate, fileObjList) {
  if (!Array.isArray(fileObjList) || fileObjList.length === 0) return [];
  const folderName = buildContractRelatedFolderName(contractNo, contractName, signDate);
  const targetDirAbs = path.join(RELATED_UPLOAD_DIR, folderName);
  if (!fs.existsSync(targetDirAbs)) {
    fs.mkdirSync(targetDirAbs, { recursive: true });
  }

  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const archivedPaths = [];
  for (const f of fileObjList) {
    if (!f || !f.path || !fs.existsSync(f.path)) continue;
    const origName = decodeOriginalFilename(f.originalname);
    const ext = path.extname(origName);
    const rawBase = path.basename(origName, ext);
    const safeBase = sanitizeFilenameSegment(rawBase, 80);

    let finalName = `${safeBase}${ext}`;
    let counter = 1;
    while (fs.existsSync(path.join(targetDirAbs, finalName))) {
      finalName = `${safeBase}(${counter})${ext}`;
      counter++;
    }

    const destAbs = path.join(targetDirAbs, finalName);
    fs.renameSync(f.path, destAbs);
    const relPath = path.posix.join('related', folderName, finalName);
    archivedPaths.push(relPath);
    STMTS.insertRelatedFile.run(contractId, relPath, origName, f.size || fs.statSync(destAbs).size, nowStr);
  }
  return archivedPaths;
}

function syncRelatedFilesFolderIfNeeded(contractId, contractNo, contractName, signDate) {
  const files = STMTS.getRelatedFilesByContractId.all(contractId);
  if (!files || files.length === 0) return;

  const desiredFolder = buildContractRelatedFolderName(contractNo, contractName, signDate);
  const desiredDirAbs = path.join(RELATED_UPLOAD_DIR, desiredFolder);
  const updatePathStmt = db.prepare(`UPDATE contract_files SET file_path = ? WHERE id = ?`);
  const oldDirsToClean = new Set();

  for (const rf of files) {
    const oldAbs = path.join(UPLOAD_DIR, rf.file_path);
    if (!isSafePathWithin(oldAbs, RELATED_UPLOAD_DIR) || !fs.existsSync(oldAbs)) continue;

    const currentParentAbs = path.dirname(oldAbs);
    if (path.resolve(currentParentAbs) === path.resolve(desiredDirAbs)) continue;

    if (!fs.existsSync(desiredDirAbs)) {
      fs.mkdirSync(desiredDirAbs, { recursive: true });
    }

    const fileName = path.basename(oldAbs);
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let targetFileName = fileName;
    let counter = 1;
    while (fs.existsSync(path.join(desiredDirAbs, targetFileName))) {
      targetFileName = `${base}(${counter})${ext}`;
      counter++;
    }

    const newAbs = path.join(desiredDirAbs, targetFileName);
    try {
      fs.renameSync(oldAbs, newAbs);
      const newRel = path.posix.join('related', desiredFolder, targetFileName);
      updatePathStmt.run(newRel, rf.id);
      oldDirsToClean.add(currentParentAbs);
    } catch (e) {}
  }

  for (const oldDir of oldDirsToClean) {
    removeEmptySubdirIfClean(oldDir, RELATED_UPLOAD_DIR);
  }
}

function archiveFilesForProcurement(procurementId, procurementNo, projectName, approvalDate, fileObjList, category = '立项资料') {
  if (!Array.isArray(fileObjList) || fileObjList.length === 0) return [];
  const folderName = buildProcurementFolderName(procurementNo, projectName, approvalDate);
  const targetDirAbs = path.join(PROCUREMENT_UPLOAD_DIR, folderName);
  if (!fs.existsSync(targetDirAbs)) {
    fs.mkdirSync(targetDirAbs, { recursive: true });
  }

  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const cleanCat = String(category || '立项资料').trim().slice(0, 30) || '立项资料';
  const archivedPaths = [];

  for (const f of fileObjList) {
    if (!f || !f.path || !fs.existsSync(f.path)) continue;
    const origName = decodeOriginalFilename(f.originalname);
    const ext = path.extname(origName);
    const rawBase = path.basename(origName, ext);
    const safeBase = sanitizeFilenameSegment(rawBase, 80);

    let finalName = `${safeBase}${ext}`;
    let counter = 1;
    while (fs.existsSync(path.join(targetDirAbs, finalName))) {
      finalName = `${safeBase}(${counter})${ext}`;
      counter++;
    }

    const destAbs = path.join(targetDirAbs, finalName);
    fs.renameSync(f.path, destAbs);
    const relPath = path.posix.join('procurement', folderName, finalName);
    archivedPaths.push(relPath);
    STMTS.insertProcFile.run(procurementId, cleanCat, relPath, origName, f.size || fs.statSync(destAbs).size, nowStr);
  }
  return archivedPaths;
}

function syncProcurementFilesFolderIfNeeded(procurementId, procurementNo, projectName, approvalDate) {
  const files = STMTS.getProcFilesByProcId.all(procurementId);
  if (!files || files.length === 0) return;

  const desiredFolder = buildProcurementFolderName(procurementNo, projectName, approvalDate);
  const desiredDirAbs = path.join(PROCUREMENT_UPLOAD_DIR, desiredFolder);
  const updatePathStmt = db.prepare(`UPDATE procurement_files SET file_path = ? WHERE id = ?`);
  const oldDirsToClean = new Set();

  for (const pf of files) {
    const oldAbs = path.join(UPLOAD_DIR, pf.file_path);
    if (!isSafePathWithin(oldAbs, PROCUREMENT_UPLOAD_DIR) || !fs.existsSync(oldAbs)) continue;

    const currentParentAbs = path.dirname(oldAbs);
    if (path.resolve(currentParentAbs) === path.resolve(desiredDirAbs)) continue;

    if (!fs.existsSync(desiredDirAbs)) {
      fs.mkdirSync(desiredDirAbs, { recursive: true });
    }

    const fileName = path.basename(oldAbs);
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let targetFileName = fileName;
    let counter = 1;
    while (fs.existsSync(path.join(desiredDirAbs, targetFileName))) {
      targetFileName = `${base}(${counter})${ext}`;
      counter++;
    }

    const newAbs = path.join(desiredDirAbs, targetFileName);
    try {
      fs.renameSync(oldAbs, newAbs);
      const newRel = path.posix.join('procurement', desiredFolder, targetFileName);
      updatePathStmt.run(newRel, pf.id);
      oldDirsToClean.add(currentParentAbs);
    } catch (e) {}
  }

  for (const oldDir of oldDirsToClean) {
    removeEmptySubdirIfClean(oldDir, PROCUREMENT_UPLOAD_DIR);
  }
}

function cleanupReqTempFiles(req) {
  if (!req) return;
  const toDelete = [];
  if (req.file && req.file.path) toDelete.push(req.file.path);
  if (Array.isArray(req.files)) {
    for (const f of req.files) {
      if (f && f.path) toDelete.push(f.path);
    }
  } else if (req.files && typeof req.files === 'object') {
    for (const key of Object.keys(req.files)) {
      const arr = req.files[key];
      if (Array.isArray(arr)) {
        for (const f of arr) {
          if (f && f.path) toDelete.push(f.path);
        }
      }
    }
  }
  for (const p of toDelete) {
    try {
      if (isSafePathWithin(p, TMP_UPLOAD_DIR) && fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch (e) {}
  }
}

function cleanTmpDir() {
  try {
    if (!fs.existsSync(TMP_UPLOAD_DIR)) return;
    for (const item of fs.readdirSync(TMP_UPLOAD_DIR)) {
      const fullPath = path.join(TMP_UPLOAD_DIR, item);
      try {
        if (isSafePathWithin(fullPath, TMP_UPLOAD_DIR)) {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {}
    }
  } catch (e) {}
}

function sweepOrphanUploads() {
  try {
    const validMainFiles = new Set(
      db.prepare(`SELECT file_path FROM contracts WHERE file_path != ''`).all().map(r => r.file_path)
    );
    for (const item of fs.readdirSync(UPLOAD_DIR)) {
      if (item === '.tmp' || item === 'related' || item === 'procurement' || item.startsWith('.')) continue;
      const absPath = path.join(UPLOAD_DIR, item);
      try {
        const stat = fs.statSync(absPath);
        if (stat.isFile() && !validMainFiles.has(item)) {
          fs.unlinkSync(absPath);
        }
      } catch (e) {}
    }

    const validRelatedFiles = new Set(
      db.prepare(`SELECT file_path FROM contract_files`).all().map(r => r.file_path.replace(/\\/g, '/'))
    );
    if (fs.existsSync(RELATED_UPLOAD_DIR)) {
      for (const sub of fs.readdirSync(RELATED_UPLOAD_DIR)) {
        const subAbs = path.join(RELATED_UPLOAD_DIR, sub);
        try {
          if (!fs.statSync(subAbs).isDirectory()) {
            fs.unlinkSync(subAbs);
            continue;
          }
          for (const f of fs.readdirSync(subAbs)) {
            const relKey = path.posix.join('related', sub, f);
            const fAbs = path.join(subAbs, f);
            if (!validRelatedFiles.has(relKey) && isSafePathWithin(fAbs, RELATED_UPLOAD_DIR)) {
              try { fs.unlinkSync(fAbs); } catch (e) {}
            }
          }
          removeEmptySubdirIfClean(subAbs, RELATED_UPLOAD_DIR);
        } catch (e) {}
      }
    }

    const validProcFiles = new Set(
      db.prepare(`SELECT file_path FROM procurement_files`).all().map(r => r.file_path.replace(/\\/g, '/'))
    );
    if (fs.existsSync(PROCUREMENT_UPLOAD_DIR)) {
      for (const sub of fs.readdirSync(PROCUREMENT_UPLOAD_DIR)) {
        const subAbs = path.join(PROCUREMENT_UPLOAD_DIR, sub);
        try {
          if (!fs.statSync(subAbs).isDirectory()) {
            fs.unlinkSync(subAbs);
            continue;
          }
          for (const f of fs.readdirSync(subAbs)) {
            const relKey = path.posix.join('procurement', sub, f);
            const fAbs = path.join(subAbs, f);
            if (!validProcFiles.has(relKey) && isSafePathWithin(fAbs, PROCUREMENT_UPLOAD_DIR)) {
              try { fs.unlinkSync(fAbs); } catch (e) {}
            }
          }
          removeEmptySubdirIfClean(subAbs, PROCUREMENT_UPLOAD_DIR);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

cleanTmpDir();
sweepOrphanUploads();

const maintenanceTimer = setInterval(() => {
  try {
    if (fs.existsSync(TMP_UPLOAD_DIR)) {
      const now = Date.now();
      for (const f of fs.readdirSync(TMP_UPLOAD_DIR)) {
        const fp = path.join(TMP_UPLOAD_DIR, f);
        try {
          if (now - fs.statSync(fp).mtimeMs > 3600 * 1000) fs.unlinkSync(fp);
        } catch (e) {}
      }
    }
    sweepOrphanUploads();
    if (db && db.open) db.pragma('wal_checkpoint(PASSIVE)');
    triggerSafeGC();
  } catch (e) {}
}, 6 * 60 * 60 * 1000);
if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();

// ==================== 7. Multer 上传配置 ====================
const ALLOWED_EXTS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx',
  '.txt', '.zip', '.rar', '.7z', '.ofd'
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const orig = decodeOriginalFilename(file.originalname);
    const ext = (path.extname(orig) || '.bin').toLowerCase();
    cb(null, `tmp_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 25 },
  fileFilter: (req, file, cb) => {
    const orig = decodeOriginalFilename(file.originalname);
    const ext = path.extname(orig).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return cb(new Error(`不支持的文件格式 (${ext || '未知'})，允许上传 PDF/图片/Office文档/压缩包/OFD`));
    }
    cb(null, true);
  }
});

// ==================== 8. 中间件与局域网安全访问锁 ====================
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const ACCESS_SECRET_SEED = crypto.randomBytes(32).toString('hex');
const authRateLimitMap = new Map();

const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of authRateLimitMap.entries()) {
    if (now - record.lastAttempt > 15 * 60 * 1000) {
      authRateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);
if (typeof rateLimitCleanupTimer.unref === 'function') rateLimitCleanupTimer.unref();

function getSavedAccessCodeHash() {
  const row = STMTS.getSetting.get('lan_access_code_hash');
  return row ? row.setting_value : '';
}

function hashAccessCode(rawCode) {
  return crypto.createHash('sha256').update(`contract_sys_salt_${rawCode}`).digest('hex');
}

function generateAccessToken(codeHash) {
  return crypto.createHmac('sha256', ACCESS_SECRET_SEED).update(codeHash).digest('hex');
}

function verifyRequestAuthorized(req) {
  const savedHash = getSavedAccessCodeHash();
  if (!savedHash) return true;
  const expectedToken = generateAccessToken(savedHash);
  const clientToken = String(req.headers['x-access-token'] || req.query.token || '').trim();
  if (!clientToken || clientToken.length !== expectedToken.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(clientToken), Buffer.from(expectedToken));
  } catch (e) {
    return false;
  }
}

app.use(express.static(PUBLIC_DIR));

app.get('/api/auth/status', (req, res) => {
  const savedHash = getSavedAccessCodeHash();
  res.json({
    success: true,
    locked: Boolean(savedHash),
    authorized: verifyRequestAuthorized(req)
  });
});

app.post('/api/auth/verify', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const limitRec = authRateLimitMap.get(clientIp) || { count: 0, lastAttempt: now };
  if (now - limitRec.lastAttempt > 10 * 60 * 1000) limitRec.count = 0;
  if (limitRec.count >= 8) {
    return res.status(429).json({ success: false, message: '密码尝试过于频繁，请 10 分钟后再试' });
  }

  const savedHash = getSavedAccessCodeHash();
  if (!savedHash) {
    return res.json({ success: true, token: '', message: '当前未开启访问锁' });
  }
  const inputCode = String(req.body.access_code || req.body.code || '').trim();
  if (hashAccessCode(inputCode) !== savedHash) {
    limitRec.count += 1;
    limitRec.lastAttempt = now;
    authRateLimitMap.set(clientIp, limitRec);
    return res.status(401).json({ success: false, message: '访问口令错误' });
  }

  authRateLimitMap.delete(clientIp);
  return res.json({
    success: true,
    token: generateAccessToken(savedHash),
    message: '验证通过'
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    if (!verifyRequestAuthorized(req)) {
      return res.status(401).json({ success: false, locked: true, message: '需要输入局域网访问口令' });
    }
  }
  next();
});

app.use('/uploads', (req, res, next) => {
  const decodedRel = decodeURIComponent(req.path || '').replace(/^\/+/, '');
  if (!decodedRel || decodedRel.startsWith('.tmp')) {
    return res.status(403).send('Forbidden');
  }
  const absFile = path.join(UPLOAD_DIR, decodedRel);
  if (!isSafePathWithin(absFile, UPLOAD_DIR) || !fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    return res.status(404).send('文件不存在或已被移除');
  }
  if (req.query.download === '1') {
    const downloadName = req.query.filename ? path.basename(String(req.query.filename)) : path.basename(absFile);
    return res.download(absFile, downloadName);
  }
  res.sendFile(absFile);
});

app.post('/api/auth/set-code', (req, res) => {
  const newCode = String(req.body.new_code ?? req.body.access_code ?? '').trim();
  if (!newCode) {
    STMTS.setSetting.run('lan_access_code_hash', '');
    return res.json({ success: true, locked: false, token: '', message: '已关闭局域网访问口令锁' });
  }
  if (newCode.length < 4 || newCode.length > 32) {
    return res.status(400).json({ success: false, message: '访问口令长度需在 4~32 位之间' });
  }
  const hashed = hashAccessCode(newCode);
  STMTS.setSetting.run('lan_access_code_hash', hashed);
  return res.json({
    success: true,
    locked: true,
    token: generateAccessToken(hashed),
    message: '局域网访问口令设置成功'
  });
});

app.get(['/api/system/network', '/api/network-info'], (req, res) => {
  const interfaces = os.networkInterfaces();
  const lanUrls = [];
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
        lanUrls.push(`http://${net.address}:${PORT}`);
      }
    }
  }
  res.json({
    success: true,
    port: PORT,
    hostname: os.hostname(),
    ips,
    lan_urls: lanUrls,
    local_url: `http://localhost:${PORT}`,
    locked: Boolean(getSavedAccessCodeHash())
  });
});

// ==================== 9. 编号规则设置与预览路由 ====================
app.get('/api/settings/contract-no-rule', (req, res) => {
  const rule = getContractNoRule();
  const refDate = req.query.sign_date || new Date().toISOString().slice(0, 10);
  const customMid = req.query.mid_custom || '';
  const preview = generateNextContractNoParts(rule, refDate, customMid);
  res.json({
    success: true,
    rule,
    next_contract_no: preview.full_no,
    preview_parts: preview
  });
});

app.post('/api/settings/contract-no-rule', (req, res) => {
  const prefix = String(req.body.prefix ?? '').trim().slice(0, 30);
  const date_format = ['YYYY', 'YYYYMM', 'YYYYMMDD', 'NONE'].includes(req.body.date_format) ? req.body.date_format : 'YYYYMM';
  let seq_digits = parseInt(req.body.seq_digits, 10);
  if (isNaN(seq_digits) || seq_digits < 0 || seq_digits > 8) seq_digits = 3;
  const suffix = String(req.body.suffix ?? '').trim().slice(0, 20);

  const newRule = { prefix, date_format, seq_digits, suffix };
  STMTS.setSetting.run('contract_no_rule', JSON.stringify(newRule));
  const preview = generateNextContractNoParts(newRule, new Date().toISOString().slice(0, 10));
  res.json({
    success: true,
    message: '合同编号规则已保存',
    rule: newRule,
    next_contract_no: preview.full_no,
    preview_parts: preview
  });
});

app.get('/api/settings/procurement-no-rule', (req, res) => {
  const rule = getProcurementNoRule();
  const refDate = req.query.approval_date || new Date().toISOString().slice(0, 10);
  const customMid = req.query.mid_custom || '';
  const preview = generateNextProcurementNoParts(rule, refDate, customMid);
  res.json({
    success: true,
    rule,
    next_procurement_no: preview.full_no,
    preview_parts: preview
  });
});

app.post('/api/settings/procurement-no-rule', (req, res) => {
  const prefix = String(req.body.prefix ?? '').trim().slice(0, 30);
  const date_format = ['YYYY', 'YYYYMM', 'YYYYMMDD', 'NONE'].includes(req.body.date_format) ? req.body.date_format : 'YYYYMMDD';
  let seq_digits = parseInt(req.body.seq_digits, 10);
  if (isNaN(seq_digits) || seq_digits < 0 || seq_digits > 8) seq_digits = 3;
  const suffix = String(req.body.suffix ?? '').trim().slice(0, 20);

  const newRule = { prefix, date_format, seq_digits, suffix };
  STMTS.setSetting.run('procurement_no_rule', JSON.stringify(newRule));
  const preview = generateNextProcurementNoParts(newRule, new Date().toISOString().slice(0, 10));
  res.json({
    success: true,
    message: '采购立项编号规则已保存',
    rule: newRule,
    next_procurement_no: preview.full_no,
    preview_parts: preview
  });
});

// ==================== 10. 跨表下拉选项轻量接口 ====================
app.get('/api/options/procurements', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.seq_no, p.procurement_no, p.project_name, p.procurement_type,
           p.budget_amount, p.control_price, p.final_amount, p.department, p.applicant,
           p.supplier_name, p.status, p.contract_id,
           c.contract_no AS linked_contract_no
    FROM procurements p
    LEFT JOIN contracts c ON p.contract_id = c.id
    ORDER BY p.approval_date DESC, p.id DESC
  `).all();
  res.json({ success: true, data: rows });
});

app.get('/api/options/contracts', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.seq_no, c.contract_no, c.contract_name, c.contract_type,
           c.amount, c.party_a, c.party_b, c.department, c.owner, c.sign_date,
           c.procurement_id, p.procurement_no AS linked_procurement_no
    FROM contracts c
    LEFT JOIN procurements p ON c.procurement_id = p.id
    ORDER BY c.sign_date DESC, c.id DESC
  `).all();
  res.json({ success: true, data: rows });
});

// ==================== 11. 原生零依赖 SpreadsheetML (.xls) 专业报表生成引擎 ====================
function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSpreadsheetXmlWorkbook(sheets) {
  const worksheetXmlList = sheets.map(sheet => {
    const colCount = sheet.columns.length;
    const colDefs = sheet.columns.map(c => `<Column ss:AutoFitWidth="0" ss:Width="${c.width || 110}"/>`).join('');

    const headerCells = sheet.columns.map(c =>
      `<Cell ss:StyleID="sHeader"><Data ss:Type="String">${escapeXml(c.header)}</Data></Cell>`
    ).join('');

    const dataRowsXml = sheet.rows.map((r, idx) => {
      const rowStyle = idx % 2 === 1 ? 'sCellAlt' : 'sCell';
      const numStyle = idx % 2 === 1 ? 'sMoneyAlt' : 'sMoney';
      const centerStyle = idx % 2 === 1 ? 'sCenterAlt' : 'sCenter';

      const cells = sheet.columns.map(col => {
        const val = r[col.key];
        if (col.type === 'number') {
          const numVal = Number(val || 0);
          return `<Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${numVal}</Data></Cell>`;
        }
        const styleId = col.align === 'center' ? centerStyle : rowStyle;
        return `<Cell ss:StyleID="${styleId}"><Data ss:Type="String">${escapeXml(val ?? '')}</Data></Cell>`;
      }).join('');

      return `<Row ss:Height="22">${cells}</Row>`;
    }).join('\n');

    let summaryRowXml = '';
    if (sheet.summaryCells && sheet.summaryCells.length > 0) {
      const sCells = sheet.summaryCells.map(sc => {
        if (sc.type === 'number') {
          return `<Cell ss:StyleID="sTotalMoney"><Data ss:Type="Number">${Number(sc.value || 0)}</Data></Cell>`;
        }
        return `<Cell ss:StyleID="sTotalText"><Data ss:Type="String">${escapeXml(sc.value ?? '')}</Data></Cell>`;
      }).join('');
      summaryRowXml = `<Row ss:Height="26">${sCells}</Row>`;
    }

    return `
      <Worksheet ss:Name="${escapeXml(sheet.name)}">
        <Table ss:ExpandedColumnCount="${colCount}">
          ${colDefs}
          <Row ss:Height="34">
            <Cell ss:MergeAcross="${colCount - 1}" ss:StyleID="sTitle">
              <Data ss:Type="String">${escapeXml(sheet.title)}</Data>
            </Cell>
          </Row>
          <Row ss:Height="26">${headerCells}</Row>
          ${dataRowsXml}
          ${summaryRowXml}
        </Table>
        <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
          <FreezePanes/>
          <FrozenNoSplit/>
          <SplitHorizontal>2</SplitHorizontal>
          <TopRowBottomPane>2</TopRowBottomPane>
          <ActivePane>2</ActivePane>
        </WorksheetOptions>
      </Worksheet>
    `;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Alignment ss:Vertical="Center"/>
      <Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="#1E293B"/>
    </Style>
    <Style ss:ID="sTitle">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="微软雅黑" ss:Size="14" ss:Bold="1" ss:Color="#1E293B"/>
      <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="sHeader">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
      <Font ss:FontName="微软雅黑" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#1E40AF" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
      </Borders>
    </Style>
    <Style ss:ID="sCell">
      <Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
      </Borders>
    </Style>
    <Style ss:ID="sCellAlt">
      <Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1"/>
      <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
      </Borders>
    </Style>
    <Style ss:ID="sCenter">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
      </Borders>
    </Style>
    <Style ss:ID="sCenterAlt">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
      <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
      </Borders>
    </Style>
    <Style ss:ID="sMoney">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
      </Borders>
    </Style>
    <Style ss:ID="sMoneyAlt">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
      </Borders>
    </Style>
    <Style ss:ID="sTotalText">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="微软雅黑" ss:Size="10" ss:Bold="1" ss:Color="#1E3A8A"/>
      <Interior ss:Color="#DBEAFE" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="sTotalMoney">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <Font ss:FontName="微软雅黑" ss:Size="10" ss:Bold="1" ss:Color="#1E3A8A"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Interior ss:Color="#DBEAFE" ss:Pattern="Solid"/>
    </Style>
  </Styles>
  ${worksheetXmlList}
</Workbook>`;
}

function buildContractSheetConfig(rows) {
  const columns = [
    { header: '年度序号', key: 'seq_no', width: 90, align: 'center' },
    { header: '合同编号', key: 'contract_no', width: 150, align: 'center' },
    { header: '合同名称', key: 'contract_name', width: 210 },
    { header: '合同类型', key: 'contract_type', width: 95, align: 'center' },
    { header: '甲方单位', key: 'party_a', width: 160 },
    { header: '乙方单位', key: 'party_b', width: 160 },
    { header: '丙方单位', key: 'party_c', width: 130 },
    { header: '合同金额(元)', key: 'amount', width: 115, type: 'number' },
    { header: '签订日期', key: 'sign_date', width: 95, align: 'center' },
    { header: '生效日期', key: 'start_date', width: 95, align: 'center' },
    { header: '到期日期', key: 'end_date', width: 95, align: 'center' },
    { header: '履行状态', key: 'status', width: 90, align: 'center' },
    { header: '关联采购立项号', key: 'linked_procurement_no', width: 140, align: 'center' },
    { header: '所属部门', key: 'department', width: 100, align: 'center' },
    { header: '负责人', key: 'owner', width: 85, align: 'center' },
    { header: '附件情况', key: 'file_info', width: 125, align: 'center' },
    { header: '备注说明', key: 'remark', width: 180 }
  ];

  let totalAmount = 0;
  const formattedRows = rows.map(r => {
    totalAmount += Number(r.amount || 0);
    const fileDesc = [];
    if (r.file_path) fileDesc.push('主扫描件×1');
    if (Number(r.related_file_count) > 0) fileDesc.push(`相关资料×${r.related_file_count}`);
    return {
      seq_no: r.seq_no,
      contract_no: r.contract_no,
      contract_name: r.contract_name,
      contract_type: r.contract_type,
      party_a: r.party_a,
      party_b: r.party_b,
      party_c: r.party_c || '-',
      amount: Number(r.amount || 0),
      sign_date: r.sign_date,
      start_date: r.start_date || '-',
      end_date: r.end_date || '-',
      status: r.status,
      linked_procurement_no: r.linked_procurement_no || '未关联',
      department: r.department || '-',
      owner: r.owner || '-',
      file_info: fileDesc.length ? fileDesc.join(' + ') : '无附件',
      remark: r.remark || ''
    };
  });

  const summaryCells = columns.map((c, idx) => {
    if (idx === 0) return { value: '合计' };
    if (idx === 1) return { value: `共 ${rows.length} 份合同` };
    if (c.key === 'amount') return { type: 'number', value: Number(totalAmount.toFixed(2)) };
    return { value: '' };
  });

  return {
    name: '合同管理台账',
    title: `合同管理台账明细表（导出日期：${new Date().toISOString().slice(0, 10)}）`,
    columns,
    rows: formattedRows,
    summaryCells
  };
}

function buildProcurementSheetConfig(rows) {
  const columns = [
    { header: '立项序号', key: 'seq_no', width: 100, align: 'center' },
    { header: '采购立项编号', key: 'procurement_no', width: 150, align: 'center' },
    { header: '采购项目名称', key: 'project_name', width: 210 },
    { header: '采购类别', key: 'procurement_type', width: 95, align: 'center' },
    { header: '采购方式', key: 'procurement_method', width: 100, align: 'center' },
    { header: '预算金额(元)', key: 'budget_amount', width: 115, type: 'number' },
    { header: '控制价(元)', key: 'control_price', width: 115, type: 'number' },
    { header: '成交金额(元)', key: 'final_amount', width: 115, type: 'number' },
    { header: '节约金额(元)', key: 'saved_amount', width: 110, type: 'number' },
    { header: '申请部门', key: 'department', width: 100, align: 'center' },
    { header: '经办人', key: 'applicant', width: 90, align: 'center' },
    { header: '立项批准日期', key: 'approval_date', width: 95, align: 'center' },
    { header: '成交供应商', key: 'supplier_name', width: 165 },
    { header: '当前状态', key: 'status', width: 110, align: 'center' },
    { header: '关联主合同号', key: 'linked_contract_no', width: 145, align: 'center' },
    { header: '立项资料数', key: 'file_info', width: 95, align: 'center' },
    { header: '备注说明', key: 'remark', width: 180 }
  ];

  let sumBudget = 0;
  let sumControl = 0;
  let sumFinal = 0;

  const formattedRows = rows.map(r => {
    const b = Number(r.budget_amount || 0);
    const c = Number(r.control_price || 0);
    const f = Number(r.final_amount || 0);
    const saved = f > 0 && b > 0 ? b - f : 0;
    sumBudget += b;
    sumControl += c;
    sumFinal += f;

    return {
      seq_no: r.seq_no,
      procurement_no: r.procurement_no,
      project_name: r.project_name,
      procurement_type: r.procurement_type,
      procurement_method: r.procurement_method,
      budget_amount: b,
      control_price: c,
      final_amount: f,
      saved_amount: saved,
      department: r.department || '-',
      applicant: r.applicant || '-',
      approval_date: r.approval_date,
      supplier_name: r.supplier_name || '-',
      status: r.status,
      linked_contract_no: r.linked_contract_no || '暂未签合同',
      file_info: Number(r.file_count) > 0 ? `${r.file_count} 份资料` : '无资料',
      remark: r.remark || ''
    };
  });

  const summaryCells = columns.map((c, idx) => {
    if (idx === 0) return { value: '合计' };
    if (idx === 1) return { value: `共 ${rows.length} 项立项` };
    if (c.key === 'budget_amount') return { type: 'number', value: Number(sumBudget.toFixed(2)) };
    if (c.key === 'control_price') return { type: 'number', value: Number(sumControl.toFixed(2)) };
    if (c.key === 'final_amount') return { type: 'number', value: Number(sumFinal.toFixed(2)) };
    if (c.key === 'saved_amount') return { type: 'number', value: Number((sumBudget - sumFinal).toFixed(2)) };
    return { value: '' };
  });

  return {
    name: '采购立项台账',
    title: `采购立项管理台账明细表（导出日期：${new Date().toISOString().slice(0, 10)}）`,
    columns,
    rows: formattedRows,
    summaryCells
  };
}

// ==================== 12. 合同管理 CRUD 与导出路由（注意 /export 必须在 /:id 之前） ====================
function buildContractFilterQuery(query) {
  const conditions = [];
  const params = [];

  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    const kw = `%${keyword}%`;
    conditions.push(`(
      c.seq_no LIKE ? OR c.contract_no LIKE ? OR c.contract_name LIKE ? OR
      c.party_a LIKE ? OR c.party_b LIKE ? OR c.party_c LIKE ? OR
      c.department LIKE ? OR c.owner LIKE ? OR c.remark LIKE ? OR
      IFNULL(p.procurement_no, '') LIKE ? OR IFNULL(p.project_name, '') LIKE ?
    )`);
    params.push(kw, kw, kw, kw, kw, kw, kw, kw, kw, kw, kw);
  }

  if (query.contract_type) {
    conditions.push(`c.contract_type = ?`);
    params.push(String(query.contract_type).trim());
  }
  if (query.status) {
    conditions.push(`c.status = ?`);
    params.push(String(query.status).trim());
  }
  if (query.year && /^\d{4}$/.test(String(query.year).trim())) {
    conditions.push(`c.sign_date LIKE ?`);
    params.push(`${String(query.year).trim()}-%`);
  }
  if (query.start_date) {
    conditions.push(`c.sign_date >= ?`);
    params.push(String(query.start_date).trim());
  }
  if (query.end_date) {
    conditions.push(`c.sign_date <= ?`);
    params.push(String(query.end_date).trim());
  }
  if (query.has_file === 'yes') {
    conditions.push(`(c.file_path != '' OR EXISTS (SELECT 1 FROM contract_files cf WHERE cf.contract_id = c.id))`);
  } else if (query.has_file === 'no') {
    conditions.push(`(c.file_path = '' AND NOT EXISTS (SELECT 1 FROM contract_files cf WHERE cf.contract_id = c.id))`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

// 导出合同台账（放在 /api/contracts/:id 之前防止被拦截）
app.get(['/api/contracts/export', '/api/export/excel'], (req, res) => {
  try {
    const { whereClause, params } = buildContractFilterQuery(req.query);
    const rows = db.prepare(`
      SELECT c.*, p.procurement_no AS linked_procurement_no,
             (SELECT COUNT(*) FROM contract_files cf WHERE cf.contract_id = c.id) AS related_file_count
      FROM contracts c
      LEFT JOIN procurements p ON c.procurement_id = p.id
      ${whereClause}
      ORDER BY c.sign_date DESC, c.id DESC
    `).all(...params);

    let xml = buildSpreadsheetXmlWorkbook([buildContractSheetConfig(rows)]);
    const fileName = encodeURIComponent(`合同管理台账_${new Date().toISOString().slice(0, 10)}.xls`);
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
    res.on('finish', () => {
      xml = null;
      triggerSafeGC();
    });
    res.send(xml);
  } catch (err) {
    res.status(500).json({ success: false, message: '导出失败: ' + err.message });
  }
});

app.get('/api/contracts', (req, res) => {
  const { whereClause, params } = buildContractFilterQuery(req.query);

  const listSql = `
    SELECT c.*,
           p.procurement_no AS linked_procurement_no,
           p.project_name AS linked_procurement_name,
           (SELECT COUNT(*) FROM contract_files cf WHERE cf.contract_id = c.id) AS related_file_count
    FROM contracts c
    LEFT JOIN procurements p ON c.procurement_id = p.id
    ${whereClause}
    ORDER BY c.sign_date DESC, c.id DESC
  `;
  const rows = db.prepare(listSql).all(...params);

  let totalAmount = 0;
  let activeCount = 0;
  let completedCount = 0;
  let withFileCount = 0;
  for (const r of rows) {
    totalAmount += Number(r.amount || 0);
    if (r.status === '履行中') activeCount++;
    if (r.status === '已完结') completedCount++;
    if (r.file_path || Number(r.related_file_count) > 0) withFileCount++;
  }

  res.json({
    success: true,
    data: rows,
    stats: {
      total_count: rows.length,
      total_amount: Number(totalAmount.toFixed(2)),
      active_count: activeCount,
      completed_count: completedCount,
      with_file_count: withFileCount
    }
  });
});

app.get('/api/contracts/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT c.*,
           p.procurement_no AS linked_procurement_no,
           p.project_name AS linked_procurement_name,
           p.budget_amount AS linked_budget_amount,
           p.final_amount AS linked_final_amount
    FROM contracts c
    LEFT JOIN procurements p ON c.procurement_id = p.id
    WHERE c.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ success: false, message: '未找到该合同记录' });
  row.related_files = STMTS.getRelatedFilesByContractId.all(id);
  res.json({ success: true, data: row });
});

const contractUploadFields = upload.fields([
  { name: 'scan_file', maxCount: 1 },
  { name: 'related_files', maxCount: 20 }
]);

app.post('/api/contracts', contractUploadFields, (req, res) => {
  let newlyArchivedMainFile = '';
  let newlyArchivedRelatedFiles = [];

  try {
    const cleanNo = String(req.body.contract_no || '').trim();
    const cleanName = String(req.body.contract_name || '').trim();
    const cleanType = String(req.body.contract_type || '采购合同').trim();
    const cleanPartyA = String(req.body.party_a || '').trim();
    const cleanPartyB = String(req.body.party_b || '').trim();
    const cleanPartyC = String(req.body.party_c || '').trim();
    const cleanAmount = Math.max(0, Number(req.body.amount) || 0);
    const cleanSignDate = String(req.body.sign_date || '').trim();
    const cleanStartDate = String(req.body.start_date || '').trim();
    const cleanEndDate = String(req.body.end_date || '').trim();
    const cleanStatus = String(req.body.status || '履行中').trim();
    const cleanDept = String(req.body.department || '').trim();
    const cleanOwner = String(req.body.owner || '').trim();
    const cleanRemark = String(req.body.remark || '').trim();
    const cleanProcId = req.body.procurement_id ? Number(req.body.procurement_id) : null;

    if (!cleanNo || !cleanName || !cleanPartyA || !cleanPartyB || !cleanSignDate) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: '合同编号、合同名称、甲方、乙方、签订日期为必填项' });
    }

    const scanFileObj = req.files && req.files.scan_file ? req.files.scan_file[0] : null;
    const relatedFileObjs = req.files && req.files.related_files ? req.files.related_files : [];

    let finalNo = cleanNo;
    let autoAdjustedMsg = '';

    const createTx = db.transaction(() => {
      if (STMTS.checkDuplicateNoOnCreate.get(finalNo)) {
        const resolvedNo = autoResolveDuplicateContractNo(finalNo, cleanSignDate);
        if (resolvedNo) {
          finalNo = resolvedNo;
          autoAdjustedMsg = `（注：原编号已被其他同事抢先录入，系统已自动为您顺延编号为：${finalNo}）`;
        } else {
          throw new Error('合同编号已存在，请确保唯一性');
        }
      }

      let fileMeta = { file_path: '', file_original_name: '', file_size: 0, file_uploaded_at: '' };
      if (scanFileObj) {
        fileMeta = finalizeUploadedFile(scanFileObj, finalNo, cleanName, cleanSignDate) || fileMeta;
        if (fileMeta.file_path) newlyArchivedMainFile = fileMeta.file_path;
      }

      const info = db.prepare(`
        INSERT INTO contracts (
          seq_no, contract_no, contract_name, contract_type,
          party_a, party_b, party_c, amount,
          sign_date, start_date, end_date, status,
          department, owner, remark,
          file_path, file_original_name, file_size, file_uploaded_at,
          procurement_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '', finalNo, cleanName, cleanType,
        cleanPartyA, cleanPartyB, cleanPartyC, cleanAmount,
        cleanSignDate, cleanStartDate, cleanEndDate, cleanStatus,
        cleanDept, cleanOwner, cleanRemark,
        fileMeta.file_path, fileMeta.file_original_name, fileMeta.file_size, fileMeta.file_uploaded_at,
        cleanProcId
      );

      const newContractId = info.lastInsertRowid;
      linkContractToProcurement(newContractId, cleanProcId);

      if (relatedFileObjs.length > 0) {
        newlyArchivedRelatedFiles = archiveRelatedFilesForContract(newContractId, finalNo, cleanName, cleanSignDate, relatedFileObjs);
      }

      recalculateAllSequences();
      return newContractId;
    });

    const newId = createTx();
    cleanupReqTempFiles(req);
    const created = STMTS.getContractById.get(newId);
    res.json({
      success: true,
      message: '合同新增成功' + autoAdjustedMsg,
      auto_adjusted_no: autoAdjustedMsg ? finalNo : null,
      data: created
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    if (newlyArchivedMainFile) deletePhysicalFile(newlyArchivedMainFile);
    for (const rp of newlyArchivedRelatedFiles) deletePhysicalFile(rp);
    res.status(400).json({ success: false, message: err.message || '新增合同失败' });
  }
});

app.put('/api/contracts/:id', contractUploadFields, (req, res) => {
  let newlyArchivedMainFile = '';
  let newlyArchivedRelatedFiles = [];

  try {
    const id = Number(req.params.id);
    const existing = STMTS.getContractById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '要修改的合同不存在' });
    }

    const cleanNo = String(req.body.contract_no || '').trim();
    const cleanName = String(req.body.contract_name || '').trim();
    const cleanType = String(req.body.contract_type || '采购合同').trim();
    const cleanPartyA = String(req.body.party_a || '').trim();
    const cleanPartyB = String(req.body.party_b || '').trim();
    const cleanPartyC = String(req.body.party_c || '').trim();
    const cleanAmount = Math.max(0, Number(req.body.amount) || 0);
    const cleanSignDate = String(req.body.sign_date || '').trim();
    const cleanStartDate = String(req.body.start_date || '').trim();
    const cleanEndDate = String(req.body.end_date || '').trim();
    const cleanStatus = String(req.body.status || '履行中').trim();
    const cleanDept = String(req.body.department || '').trim();
    const cleanOwner = String(req.body.owner || '').trim();
    const cleanRemark = String(req.body.remark || '').trim();
    const cleanProcId = req.body.procurement_id ? Number(req.body.procurement_id) : null;
    const removeFile = req.body.remove_file === '1' || req.body.remove_file === 'true';

    if (!cleanNo || !cleanName || !cleanPartyA || !cleanPartyB || !cleanSignDate) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: '合同编号、合同名称、甲方、乙方、签订日期为必填项' });
    }

    const scanFileObj = req.files && req.files.scan_file ? req.files.scan_file[0] : null;
    const relatedFileObjs = req.files && req.files.related_files ? req.files.related_files : [];

    let oldMainFileToDeleteAfterCommit = '';

    const updateTx = db.transaction(() => {
      if (STMTS.checkDuplicateNoOnUpdate.get(cleanNo, id)) {
        throw new Error(`合同编号 "${cleanNo}" 已被其他记录占用`);
      }

      let fileMeta = {
        file_path: existing.file_path,
        file_original_name: existing.file_original_name,
        file_size: existing.file_size,
        file_uploaded_at: existing.file_uploaded_at
      };

      if (scanFileObj) {
        if (existing.file_path) oldMainFileToDeleteAfterCommit = existing.file_path;
        fileMeta = finalizeUploadedFile(scanFileObj, cleanNo, cleanName, cleanSignDate) || fileMeta;
        if (fileMeta.file_path) newlyArchivedMainFile = fileMeta.file_path;
      } else if (removeFile) {
        if (existing.file_path) oldMainFileToDeleteAfterCommit = existing.file_path;
        fileMeta = { file_path: '', file_original_name: '', file_size: 0, file_uploaded_at: '' };
      } else if (existing.file_path) {
        fileMeta.file_path = renameExistingScanIfNeeded(existing.file_path, cleanNo, cleanName, cleanSignDate);
      }

      db.prepare(`
        UPDATE contracts SET
          contract_no = ?, contract_name = ?, contract_type = ?,
          party_a = ?, party_b = ?, party_c = ?, amount = ?,
          sign_date = ?, start_date = ?, end_date = ?, status = ?,
          department = ?, owner = ?, remark = ?,
          file_path = ?, file_original_name = ?, file_size = ?, file_uploaded_at = ?,
          procurement_id = ?,
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        cleanNo, cleanName, cleanType,
        cleanPartyA, cleanPartyB, cleanPartyC, cleanAmount,
        cleanSignDate, cleanStartDate, cleanEndDate, cleanStatus,
        cleanDept, cleanOwner, cleanRemark,
        fileMeta.file_path, fileMeta.file_original_name, fileMeta.file_size, fileMeta.file_uploaded_at,
        cleanProcId,
        id
      );

      linkContractToProcurement(id, cleanProcId);
      syncRelatedFilesFolderIfNeeded(id, cleanNo, cleanName, cleanSignDate);

      if (relatedFileObjs.length > 0) {
        newlyArchivedRelatedFiles = archiveRelatedFilesForContract(id, cleanNo, cleanName, cleanSignDate, relatedFileObjs);
      }

      recalculateAllSequences();
    });

    updateTx();
    if (oldMainFileToDeleteAfterCommit) deletePhysicalFile(oldMainFileToDeleteAfterCommit);
    cleanupReqTempFiles(req);
    res.json({ success: true, message: '合同更新成功', data: STMTS.getContractById.get(id) });
  } catch (err) {
    cleanupReqTempFiles(req);
    if (newlyArchivedMainFile) deletePhysicalFile(newlyArchivedMainFile);
    for (const rp of newlyArchivedRelatedFiles) deletePhysicalFile(rp);
    res.status(400).json({ success: false, message: err.message || '更新合同失败' });
  }
});

app.post('/api/contracts/:id/upload', upload.single('scan_file'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getContractById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: '请选择要上传的扫描件' });
    }
    if (existing.file_path) {
      deletePhysicalFile(existing.file_path);
    }
    const meta = finalizeUploadedFile(req.file, existing.contract_no, existing.contract_name, existing.sign_date);
    db.prepare(`
      UPDATE contracts
      SET file_path = ?, file_original_name = ?, file_size = ?, file_uploaded_at = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(meta.file_path, meta.file_original_name, meta.file_size, meta.file_uploaded_at, id);

    res.json({ success: true, message: '主合同扫描件上传成功', data: STMTS.getContractById.get(id) });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message || '上传失败' });
  }
});

app.post('/api/contracts/:id/related-files', upload.array('related_files', 20), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getContractById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: '未选择任何文件' });
    }
    archiveRelatedFilesForContract(id, existing.contract_no, existing.contract_name, existing.sign_date, req.files);
    res.json({
      success: true,
      message: `成功上传 ${req.files.length} 份相关资料`,
      related_files: STMTS.getRelatedFilesByContractId.all(id)
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message || '上传失败' });
  }
});

app.delete('/api/contracts/:id/related-files/:fileId', (req, res) => {
  const contractId = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  const fileRec = STMTS.getRelatedFileById.get(fileId, contractId);
  if (!fileRec) {
    return res.status(404).json({ success: false, message: '未找到该附件记录' });
  }
  const absFile = path.join(UPLOAD_DIR, fileRec.file_path);
  const parentDir = path.dirname(absFile);

  STMTS.deleteRelatedFileById.run(fileId);
  deletePhysicalFile(fileRec.file_path);
  removeEmptySubdirIfClean(parentDir, RELATED_UPLOAD_DIR);

  res.json({
    success: true,
    message: '附件已删除',
    related_files: STMTS.getRelatedFilesByContractId.all(contractId)
  });
});

app.delete('/api/contracts/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = STMTS.getContractById.get(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: '合同记录不存在' });
  }
  const relatedFiles = STMTS.getRelatedFilesByContractId.all(id);

  const deleteTx = db.transaction(() => {
    linkContractToProcurement(id, null);
    db.prepare(`DELETE FROM contracts WHERE id = ?`).run(id);
    recalculateAllSequences();
  });
  deleteTx();

  if (existing.file_path) {
    deletePhysicalFile(existing.file_path);
  }
  const dirsToCheck = new Set();
  for (const rf of relatedFiles) {
    dirsToCheck.add(path.dirname(path.join(UPLOAD_DIR, rf.file_path)));
    deletePhysicalFile(rf.file_path);
  }
  for (const d of dirsToCheck) {
    removeEmptySubdirIfClean(d, RELATED_UPLOAD_DIR);
  }

  res.json({ success: true, message: '合同及其关联附件已彻底删除' });
});

// ==================== 13. 采购立项管理 CRUD 与导出路由 ====================
function buildProcurementFilterQuery(query) {
  const conditions = [];
  const params = [];

  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    const kw = `%${keyword}%`;
    conditions.push(`(
      p.seq_no LIKE ? OR p.procurement_no LIKE ? OR p.project_name LIKE ? OR
      p.department LIKE ? OR p.applicant LIKE ? OR p.supplier_name LIKE ? OR
      p.remark LIKE ? OR IFNULL(c.contract_no, '') LIKE ? OR IFNULL(c.contract_name, '') LIKE ?
    )`);
    params.push(kw, kw, kw, kw, kw, kw, kw, kw, kw);
  }

  if (query.procurement_type) {
    conditions.push(`p.procurement_type = ?`);
    params.push(String(query.procurement_type).trim());
  }
  if (query.procurement_method) {
    conditions.push(`p.procurement_method = ?`);
    params.push(String(query.procurement_method).trim());
  }
  if (query.status) {
    conditions.push(`p.status = ?`);
    params.push(String(query.status).trim());
  }
  if (query.year && /^\d{4}$/.test(String(query.year).trim())) {
    conditions.push(`p.approval_date LIKE ?`);
    params.push(`${String(query.year).trim()}-%`);
  }
  if (query.start_date) {
    conditions.push(`p.approval_date >= ?`);
    params.push(String(query.start_date).trim());
  }
  if (query.end_date) {
    conditions.push(`p.approval_date <= ?`);
    params.push(String(query.end_date).trim());
  }
  if (query.has_file === 'yes') {
    conditions.push(`EXISTS (SELECT 1 FROM procurement_files pf WHERE pf.procurement_id = p.id)`);
  } else if (query.has_file === 'no') {
    conditions.push(`NOT EXISTS (SELECT 1 FROM procurement_files pf WHERE pf.procurement_id = p.id)`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

// 导出采购立项台账（放在 /api/procurements/:id 之前）
app.get('/api/procurements/export', (req, res) => {
  try {
    const { whereClause, params } = buildProcurementFilterQuery(req.query);
    const rows = db.prepare(`
      SELECT p.*, c.contract_no AS linked_contract_no,
             (SELECT COUNT(*) FROM procurement_files pf WHERE pf.procurement_id = p.id) AS file_count
      FROM procurements p
      LEFT JOIN contracts c ON p.contract_id = c.id
      ${whereClause}
      ORDER BY p.approval_date DESC, p.id DESC
    `).all(...params);

    let xml = buildSpreadsheetXmlWorkbook([buildProcurementSheetConfig(rows)]);
    const fileName = encodeURIComponent(`采购立项台账_${new Date().toISOString().slice(0, 10)}.xls`);
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
    res.on('finish', () => {
      xml = null;
      triggerSafeGC();
    });
    res.send(xml);
  } catch (err) {
    res.status(500).json({ success: false, message: '导出立项台账失败: ' + err.message });
  }
});

// 一键导出【合同+采购立项】双子表合集工作簿
app.get('/api/export/combined', (req, res) => {
  try {
    const contractRows = db.prepare(`
      SELECT c.*, p.procurement_no AS linked_procurement_no,
             (SELECT COUNT(*) FROM contract_files cf WHERE cf.contract_id = c.id) AS related_file_count
      FROM contracts c
      LEFT JOIN procurements p ON c.procurement_id = p.id
      ORDER BY c.sign_date DESC, c.id DESC
    `).all();

    const procRows = db.prepare(`
      SELECT p.*, c.contract_no AS linked_contract_no,
             (SELECT COUNT(*) FROM procurement_files pf WHERE pf.procurement_id = p.id) AS file_count
      FROM procurements p
      LEFT JOIN contracts c ON p.contract_id = c.id
      ORDER BY p.approval_date DESC, p.id DESC
    `).all();

    const sheet1 = buildContractSheetConfig(contractRows);
    sheet1.name = '1-合同管理总台账';
    const sheet2 = buildProcurementSheetConfig(procRows);
    sheet2.name = '2-采购立项总台账';

    let xml = buildSpreadsheetXmlWorkbook([sheet1, sheet2]);
    const fileName = encodeURIComponent(`合同与采购立项综合总台账_${new Date().toISOString().slice(0, 10)}.xls`);
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
    res.on('finish', () => {
      xml = null;
      triggerSafeGC();
    });
    res.send(xml);
  } catch (err) {
    res.status(500).json({ success: false, message: '导出综合台账失败: ' + err.message });
  }
});

app.get('/api/procurements', (req, res) => {
  const { whereClause, params } = buildProcurementFilterQuery(req.query);

  const sql = `
    SELECT p.*,
           c.contract_no AS linked_contract_no,
           c.contract_name AS linked_contract_name,
           c.amount AS linked_contract_amount,
           (SELECT COUNT(*) FROM procurement_files pf WHERE pf.procurement_id = p.id) AS file_count
    FROM procurements p
    LEFT JOIN contracts c ON p.contract_id = c.id
    ${whereClause}
    ORDER BY p.approval_date DESC, p.id DESC
  `;
  const rows = db.prepare(sql).all(...params);

  let totalBudget = 0;
  let totalFinal = 0;
  let linkedContractCount = 0;
  let withFileCount = 0;

  for (const r of rows) {
    totalBudget += Number(r.budget_amount || 0);
    totalFinal += Number(r.final_amount || 0);
    if (r.contract_id) linkedContractCount++;
    if (Number(r.file_count) > 0) withFileCount++;
  }

  res.json({
    success: true,
    data: rows,
    stats: {
      total_count: rows.length,
      total_budget: Number(totalBudget.toFixed(2)),
      total_final: Number(totalFinal.toFixed(2)),
      saved_amount: Number((totalBudget - totalFinal).toFixed(2)),
      linked_contract_count: linkedContractCount,
      with_file_count: withFileCount
    }
  });
});

app.get('/api/procurements/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT p.*,
           c.contract_no AS linked_contract_no,
           c.contract_name AS linked_contract_name,
           c.amount AS linked_contract_amount,
           c.sign_date AS linked_contract_sign_date
    FROM procurements p
    LEFT JOIN contracts c ON p.contract_id = c.id
    WHERE p.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ success: false, message: '未找到该采购立项记录' });
  row.files = STMTS.getProcFilesByProcId.all(id);
  res.json({ success: true, data: row });
});

app.post('/api/procurements', upload.array('proc_files', 20), (req, res) => {
  let newlyArchivedFiles = [];

  try {
    const cleanNo = String(req.body.procurement_no || '').trim();
    const cleanName = String(req.body.project_name || '').trim();
    const cleanType = String(req.body.procurement_type || '货物采购').trim();
    const cleanMethod = String(req.body.procurement_method || '询价采购').trim();
    const cleanBudget = Math.max(0, Number(req.body.budget_amount) || 0);
    const cleanControl = Math.max(0, Number(req.body.control_price) || 0);
    const cleanFinal = Math.max(0, Number(req.body.final_amount) || 0);
    const cleanDept = String(req.body.department || '').trim();
    const cleanApplicant = String(req.body.applicant || '').trim();
    const cleanApprovalDate = String(req.body.approval_date || '').trim();
    const cleanSupplier = String(req.body.supplier_name || '').trim();
    const cleanStatus = String(req.body.status || '已立项待采购').trim();
    const cleanContractId = req.body.contract_id ? Number(req.body.contract_id) : null;
    const cleanRemark = String(req.body.remark || '').trim();
    const fileCategory = String(req.body.file_category || '立项审批表/资料').trim();

    if (!cleanNo || !cleanName || !cleanApprovalDate) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: '采购立项编号、采购项目名称、立项批准日期为必填项' });
    }

    let finalProcNo = cleanNo;
    let autoAdjustedProcMsg = '';

    const createTx = db.transaction(() => {
      if (STMTS.checkDupProcNoCreate.get(finalProcNo)) {
        const resolvedNo = autoResolveDuplicateProcNo(finalProcNo, cleanApprovalDate);
        if (resolvedNo) {
          finalProcNo = resolvedNo;
          autoAdjustedProcMsg = `（注：原立项编号已被其他同事抢先录入，系统已自动为您顺延编号为：${finalProcNo}）`;
        } else {
          throw new Error('采购立项编号已存在，请确保唯一性');
        }
      }

      const info = db.prepare(`
        INSERT INTO procurements (
          seq_no, procurement_no, project_name, procurement_type, procurement_method,
          budget_amount, control_price, final_amount,
          department, applicant, approval_date, supplier_name,
          status, contract_id, remark
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '', finalProcNo, cleanName, cleanType, cleanMethod,
        cleanBudget, cleanControl, cleanFinal,
        cleanDept, cleanApplicant, cleanApprovalDate, cleanSupplier,
        cleanStatus, cleanContractId, cleanRemark
      );

      const newProcId = info.lastInsertRowid;
      linkProcurementToContract(newProcId, cleanContractId);

      if (req.files && req.files.length > 0) {
        newlyArchivedFiles = archiveFilesForProcurement(newProcId, finalProcNo, cleanName, cleanApprovalDate, req.files, fileCategory);
      }

      recalculateProcurementSequences();
      return newProcId;
    });

    const newId = createTx();
    cleanupReqTempFiles(req);
    res.json({
      success: true,
      message: '采购立项新增成功' + autoAdjustedProcMsg,
      auto_adjusted_no: autoAdjustedProcMsg ? finalProcNo : null,
      data: STMTS.getProcurementById.get(newId)
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    for (const fp of newlyArchivedFiles) deletePhysicalFile(fp);
    res.status(400).json({ success: false, message: err.message || '新增采购立项失败' });
  }
});

app.put('/api/procurements/:id', upload.array('proc_files', 20), (req, res) => {
  let newlyArchivedFiles = [];

  try {
    const id = Number(req.params.id);
    const existing = STMTS.getProcurementById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '要修改的采购立项记录不存在' });
    }

    const cleanNo = String(req.body.procurement_no || '').trim();
    const cleanName = String(req.body.project_name || '').trim();
    const cleanType = String(req.body.procurement_type || '货物采购').trim();
    const cleanMethod = String(req.body.procurement_method || '询价采购').trim();
    const cleanBudget = Math.max(0, Number(req.body.budget_amount) || 0);
    const cleanControl = Math.max(0, Number(req.body.control_price) || 0);
    const cleanFinal = Math.max(0, Number(req.body.final_amount) || 0);
    const cleanDept = String(req.body.department || '').trim();
    const cleanApplicant = String(req.body.applicant || '').trim();
    const cleanApprovalDate = String(req.body.approval_date || '').trim();
    const cleanSupplier = String(req.body.supplier_name || '').trim();
    const cleanStatus = String(req.body.status || '已立项待采购').trim();
    const cleanContractId = req.body.contract_id ? Number(req.body.contract_id) : null;
    const cleanRemark = String(req.body.remark || '').trim();
    const fileCategory = String(req.body.file_category || '立项审批表/资料').trim();

    if (!cleanNo || !cleanName || !cleanApprovalDate) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: '采购立项编号、采购项目名称、立项批准日期为必填项' });
    }

    const updateTx = db.transaction(() => {
      if (STMTS.checkDupProcNoUpdate.get(cleanNo, id)) {
        throw new Error(`采购立项编号 "${cleanNo}" 已被其他记录占用`);
      }

      db.prepare(`
        UPDATE procurements SET
          procurement_no = ?, project_name = ?, procurement_type = ?, procurement_method = ?,
          budget_amount = ?, control_price = ?, final_amount = ?,
          department = ?, applicant = ?, approval_date = ?, supplier_name = ?,
          status = ?, contract_id = ?, remark = ?,
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        cleanNo, cleanName, cleanType, cleanMethod,
        cleanBudget, cleanControl, cleanFinal,
        cleanDept, cleanApplicant, cleanApprovalDate, cleanSupplier,
        cleanStatus, cleanContractId, cleanRemark,
        id
      );

      linkProcurementToContract(id, cleanContractId);
      syncProcurementFilesFolderIfNeeded(id, cleanNo, cleanName, cleanApprovalDate);

      if (req.files && req.files.length > 0) {
        newlyArchivedFiles = archiveFilesForProcurement(id, cleanNo, cleanName, cleanApprovalDate, req.files, fileCategory);
      }

      recalculateProcurementSequences();
    });

    updateTx();
    cleanupReqTempFiles(req);
    res.json({ success: true, message: '采购立项更新成功', data: STMTS.getProcurementById.get(id) });
  } catch (err) {
    cleanupReqTempFiles(req);
    for (const fp of newlyArchivedFiles) deletePhysicalFile(fp);
    res.status(400).json({ success: false, message: err.message || '更新采购立项失败' });
  }
});

app.post('/api/procurements/:id/files', upload.array('proc_files', 20), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getProcurementById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '采购立项记录不存在' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要上传的立项资料' });
    }
    const cat = String(req.body.file_category || '立项资料').trim();
    archiveFilesForProcurement(id, existing.procurement_no, existing.project_name, existing.approval_date, req.files, cat);
    res.json({
      success: true,
      message: `成功上传 ${req.files.length} 份立项资料`,
      files: STMTS.getProcFilesByProcId.all(id)
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message || '上传失败' });
  }
});

app.delete('/api/procurements/:id/files/:fileId', (req, res) => {
  const procId = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  const fileRec = STMTS.getProcFileById.get(fileId, procId);
  if (!fileRec) {
    return res.status(404).json({ success: false, message: '未找到该立项资料' });
  }
  const absFile = path.join(UPLOAD_DIR, fileRec.file_path);
  const parentDir = path.dirname(absFile);

  STMTS.deleteProcFileById.run(fileId);
  deletePhysicalFile(fileRec.file_path);
  removeEmptySubdirIfClean(parentDir, PROCUREMENT_UPLOAD_DIR);

  res.json({
    success: true,
    message: '立项资料已删除',
    files: STMTS.getProcFilesByProcId.all(procId)
  });
});

app.delete('/api/procurements/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = STMTS.getProcurementById.get(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: '采购立项记录不存在' });
  }
  const files = STMTS.getProcFilesByProcId.all(id);

  const deleteTx = db.transaction(() => {
    linkProcurementToContract(id, null);
    db.prepare(`DELETE FROM procurements WHERE id = ?`).run(id);
    recalculateProcurementSequences();
  });
  deleteTx();

  const dirsToCheck = new Set();
  for (const pf of files) {
    dirsToCheck.add(path.dirname(path.join(UPLOAD_DIR, pf.file_path)));
    deletePhysicalFile(pf.file_path);
  }
  for (const d of dirsToCheck) {
    removeEmptySubdirIfClean(d, PROCUREMENT_UPLOAD_DIR);
  }

  res.json({ success: true, message: '采购立项及其全部附件已彻底删除' });
});

// 全局异常兜底与临时文件零残留清理中间件
app.use((err, req, res, next) => {
  cleanupReqTempFiles(req);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: '单个文件大小不能超过 50MB' });
    }
    return res.status(400).json({ success: false, message: `文件上传异常: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message || '请求处理失败' });
  }
  next();
});


// ==================== 14. 服务启动与优雅退出全量资源释放 ====================
const activeSockets = new Set();
let serverInstance = null;

function startServer(customPort = PORT, customHost = HOST) {
  serverInstance = app.listen(customPort, customHost, () => {
    const addr = serverInstance.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : customPort;
    console.log(`========================================================`);
    console.log(`🚀 合同与采购立项全生命周期管理系统已启动！`);
    console.log(`👉 本机访问地址: http://localhost:${actualPort}`);
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`🌐 局域网共享地址: http://${net.address}:${actualPort}`);
        }
      }
    }
    console.log(`========================================================`);
  });

  serverInstance.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  return serverInstance;
}

/**
 * 标准异步资源释放函数（支持 await shutdown()，供 test-smoke.js 与 Electron 主进程安全调用）
 * 不直接强行调用 process.exit，让测试脚本或主进程自然优雅走完断言并退出
 */
function shutdown() {
  return new Promise((resolve) => {
    try {
      cleanTmpDir();
      sweepOrphanUploads();
    } catch (e) {}

    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch (e) {}
    }
    activeSockets.clear();

    const closeDb = () => {
      try {
        if (db && db.open) {
          db.pragma('wal_checkpoint(TRUNCATE)');
          db.close();
        }
      } catch (e) {}
      resolve();
    };

    if (serverInstance) {
      const srv = serverInstance;
      serverInstance = null;
      srv.close(() => closeDb());
      setTimeout(() => closeDb(), 1000).unref();
    } else {
      closeDb();
    }
  });
}

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[${signal}] 正在安全释放资源并清理临时文件...`);
  await shutdown();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('exit', () => {
  try {
    cleanTmpDir();
    if (db && db.open) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    }
  } catch (e) {}
});

if (require.main === module) {
  startServer(PORT, HOST);
}

module.exports = {
  app,
  db,
  startServer,
  shutdown,
  closeServer: shutdown,
  gracefulShutdown
};
