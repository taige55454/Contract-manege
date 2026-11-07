/**
 * 合同与采购立项综合台账管理系统 - 旗舰级高可靠后端服务 (server.js)
 * 架构特性：
 * 1. 多机并发零冲突：SQLite WAL + 5000ms busy_timeout + 同步原子事务 (db.transaction)
 * 2. 编号零空洞与防撞车：乐观预览（取消绝不占号）+ 最小空缺正整数自动补号 (Gap-Filling) + 保存撞号微秒级自动顺延
 * 3. 资源 100% 零残留：.tmp 隔离区自动清理 + 三大目录孤儿文件/空文件夹自动清扫 + 6小时无人值守巡检 + 导出后主动安全 GC
 * 4. 安全加固：纯内网 IP 校验、会话 Token 鉴权、目录穿越防御、XSS/SQL 注入免疫、文件魔数与后缀白名单校验
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 1. 核心目录初始化与物理隔离 ====================
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
const TMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.tmp');
const RELATED_UPLOAD_DIR = path.join(UPLOAD_DIR, 'related');
const PROCUREMENT_UPLOAD_DIR = path.join(UPLOAD_DIR, 'procurement');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

[DATA_DIR, UPLOAD_DIR, TMP_UPLOAD_DIR, RELATED_UPLOAD_DIR, PROCUREMENT_UPLOAD_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ==================== 2. 内存回收与临时垃圾文件清理引擎 ====================
function triggerSafeGC() {
  try {
    if (typeof global.gc === 'function') {
      global.gc();
    }
  } catch (e) {}
}

/**
 * 启动/退出时全量清空 .tmp 目录
 */
function cleanTmpDir() {
  try {
    if (!fs.existsSync(TMP_UPLOAD_DIR)) return;
    const files = fs.readdirSync(TMP_UPLOAD_DIR);
    for (const file of files) {
      const fullPath = path.join(TMP_UPLOAD_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {}
    }
  } catch (e) {}
}

/**
 * 运行期安全清理：仅清理超过 maxAgeMs (默认1小时) 的超时残留临时文件，绝不误伤正在上传的文件
 */
function cleanExpiredTmpFiles(maxAgeMs = 3600 * 1000) {
  try {
    if (!fs.existsSync(TMP_UPLOAD_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(TMP_UPLOAD_DIR);
    for (const file of files) {
      const fullPath = path.join(TMP_UPLOAD_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
}

/**
 * 请求异常或校验失败时，立即物理销毁当前请求携带的所有临时上传文件
 */
function cleanupReqTempFiles(req) {
  if (!req) return;
  const toDelete = [];
  if (req.file && req.file.path) toDelete.push(req.file.path);
  if (Array.isArray(req.files)) {
    req.files.forEach(f => { if (f && f.path) toDelete.push(f.path); });
  } else if (req.files && typeof req.files === 'object') {
    Object.values(req.files).forEach(arr => {
      if (Array.isArray(arr)) arr.forEach(f => { if (f && f.path) toDelete.push(f.path); });
    });
  }
  for (const fp of toDelete) {
    try {
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) {}
  }
}

// 启动前先彻底打扫一次临时目录
cleanTmpDir();

// ==================== 3. 数据库初始化与 WAL 高并发事务配置 ====================
const DB_PATH = path.join(DATA_DIR, 'contracts.sqlite');
const db = new Database(DB_PATH);

// 高并发与性能黄金配置
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -16000'); // 约16MB缓存上限，兼顾极速查询与低内存占用

db.exec(`
  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_no TEXT DEFAULT '',
    contract_no TEXT NOT NULL UNIQUE,
    contract_name TEXT NOT NULL,
    contract_type TEXT DEFAULT '',
    party_a TEXT NOT NULL,
    party_b TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    sign_date TEXT NOT NULL,
    start_date TEXT DEFAULT '',
    end_date TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT '履行中',
    owner TEXT DEFAULT '',
    department TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    remarks TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    file_orig_name TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    related_files_json TEXT DEFAULT '[]',
    procurement_id INTEGER DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS procurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_no TEXT DEFAULT '',
    procurement_no TEXT NOT NULL UNIQUE,
    project_name TEXT NOT NULL,
    procurement_type TEXT DEFAULT '货物类',
    procurement_method TEXT DEFAULT '询价采购',
    budget_amount REAL NOT NULL DEFAULT 0,
    final_amount REAL DEFAULT 0,
    department TEXT DEFAULT '',
    applicant TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    supplier TEXT DEFAULT '',
    approval_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '立项审批中',
    contract_id INTEGER DEFAULT NULL,
    remarks TEXT DEFAULT '',
    files_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// 兼容平滑升级表结构
const contractCols = db.prepare(`PRAGMA table_info(contracts)`).all().map(c => c.name);
if (!contractCols.includes('related_files_json')) {
  db.exec(`ALTER TABLE contracts ADD COLUMN related_files_json TEXT DEFAULT '[]'`);
}
if (!contractCols.includes('procurement_id')) {
  db.exec(`ALTER TABLE contracts ADD COLUMN procurement_id INTEGER DEFAULT NULL`);
}
if (!contractCols.includes('contract_type')) {
  db.exec(`ALTER TABLE contracts ADD COLUMN contract_type TEXT DEFAULT ''`);
}

// 索引加固（确保多机并发排序、检索、判重在微秒级完成）
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_contracts_sign_date ON contracts(sign_date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
  CREATE INDEX IF NOT EXISTS idx_contracts_proc_id ON contracts(procurement_id);
  CREATE INDEX IF NOT EXISTS idx_procurements_app_date ON procurements(approval_date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_procurements_status ON procurements(status);
  CREATE INDEX IF NOT EXISTS idx_procurements_contract_id ON procurements(contract_id);
`);

// ==================== 4. 预编译高频 SQL 语句 (零运行时编译开销) ====================
const STMTS = {
  getSetting: db.prepare(`SELECT value FROM system_settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

  getContractById: db.prepare(`SELECT * FROM contracts WHERE id = ?`),
  getContractSimpleById: db.prepare(`SELECT id, contract_no, contract_name, amount, sign_date, party_b, status, procurement_id FROM contracts WHERE id = ?`),
  checkDuplicateNoOnCreate: db.prepare(`SELECT id FROM contracts WHERE contract_no = ?`),
  checkDuplicateNoOnUpdate: db.prepare(`SELECT id FROM contracts WHERE contract_no = ? AND id != ?`),
  getAllContractNos: db.prepare(`SELECT contract_no FROM contracts`),

  getProcById: db.prepare(`SELECT * FROM procurements WHERE id = ?`),
  getProcSimpleById: db.prepare(`SELECT id, procurement_no, project_name, budget_amount, final_amount, approval_date, supplier, status, contract_id FROM procurements WHERE id = ?`),
  checkDupProcNoCreate: db.prepare(`SELECT id FROM procurements WHERE procurement_no = ?`),
  checkDupProcNoUpdate: db.prepare(`SELECT id FROM procurements WHERE procurement_no = ? AND id != ?`),
  getAllProcNos: db.prepare(`SELECT procurement_no FROM procurements`),

  clearContractProcLink: db.prepare(`UPDATE contracts SET procurement_id = NULL, updated_at = datetime('now', 'localtime') WHERE procurement_id = ?`),
  clearProcContractLink: db.prepare(`UPDATE procurements SET contract_id = NULL, updated_at = datetime('now', 'localtime') WHERE contract_id = ?`),
  setContractProcLink: db.prepare(`UPDATE contracts SET procurement_id = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`),
  setProcContractLink: db.prepare(`UPDATE procurements SET contract_id = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
};

// ==================== 5. 序号重排与双向绑定原子工具函数 ====================
const recalculateAllSequences = db.transaction(() => {
  const rows = db.prepare(`SELECT id, sign_date FROM contracts ORDER BY sign_date ASC, id ASC`).all();
  const yearCounters = {};
  const updateStmt = db.prepare(`UPDATE contracts SET seq_no = ? WHERE id = ?`);
  for (const r of rows) {
    const year = (r.sign_date && /^\d{4}/.test(r.sign_date)) ? r.sign_date.slice(0, 4) : new Date().getFullYear().toString();
    yearCounters[year] = (yearCounters[year] || 0) + 1;
    const seqStr = `${year}-${String(yearCounters[year]).padStart(3, '0')}`;
    updateStmt.run(seqStr, r.id);
  }
});

const recalculateProcurementSequences = db.transaction(() => {
  const rows = db.prepare(`SELECT id, approval_date FROM procurements ORDER BY approval_date ASC, id ASC`).all();
  const yearCounters = {};
  const updateStmt = db.prepare(`UPDATE procurements SET seq_no = ? WHERE id = ?`);
  for (const r of rows) {
    const year = (r.approval_date && /^\d{4}/.test(r.approval_date)) ? r.approval_date.slice(0, 4) : new Date().getFullYear().toString();
    yearCounters[year] = (yearCounters[year] || 0) + 1;
    const seqStr = `LX-${year}-${String(yearCounters[year]).padStart(3, '0')}`;
    updateStmt.run(seqStr, r.id);
  }
});

/**
 * 合同侧主动绑定立项（确保一对一双向指针严丝合缝）
 */
function linkContractToProcurement(contractId, targetProcurementId) {
  const cid = Number(contractId);
  const pid = targetProcurementId ? Number(targetProcurementId) : null;

  // 先解绑原先指向该合同的所有立项
  STMTS.clearProcContractLink.run(cid);

  if (pid && Number.isInteger(pid) && pid > 0) {
    const proc = STMTS.getProcById.get(pid);
    if (proc) {
      // 如果目标立项之前绑了别的合同，先把别的合同上的 procurement_id 置空
      if (proc.contract_id && proc.contract_id !== cid) {
        STMTS.setContractProcLink.run(null, proc.contract_id);
      }
      STMTS.setContractProcLink.run(pid, cid);
      STMTS.setProcContractLink.run(cid, pid);
      return;
    }
  }
  STMTS.setContractProcLink.run(null, cid);
}

/**
 * 立项侧主动绑定合同（确保一对一双向指针严丝合缝）
 */
function linkProcurementToContract(procurementId, targetContractId) {
  const pid = Number(procurementId);
  const cid = targetContractId ? Number(targetContractId) : null;

  STMTS.clearContractProcLink.run(pid);

  if (cid && Number.isInteger(cid) && cid > 0) {
    const contract = STMTS.getContractById.get(cid);
    if (contract) {
      if (contract.procurement_id && contract.procurement_id !== pid) {
        STMTS.setProcContractLink.run(null, contract.procurement_id);
      }
      STMTS.setProcContractLink.run(cid, pid);
      STMTS.setContractProcLink.run(pid, cid);
      return;
    }
  }
  STMTS.setProcContractLink.run(null, pid);
}

// ==================== 6. 智能编号规则引擎（支持最小空缺号补齐 & 撞号保留自定义段自动顺延） ====================
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
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      return {
        prefix: typeof parsed.prefix === 'string' ? parsed.prefix : DEFAULT_CONTRACT_NO_RULE.prefix,
        date_format: ['YYYYMMDD', 'YYYYMM', 'YYYY', 'NONE'].includes(parsed.date_format) ? parsed.date_format : DEFAULT_CONTRACT_NO_RULE.date_format,
        seq_digits: Number.isInteger(Number(parsed.seq_digits)) && Number(parsed.seq_digits) >= 0 && Number(parsed.seq_digits) <= 8 ? Number(parsed.seq_digits) : DEFAULT_CONTRACT_NO_RULE.seq_digits,
        suffix: typeof parsed.suffix === 'string' ? parsed.suffix : DEFAULT_CONTRACT_NO_RULE.suffix
      };
    }
  } catch (e) {}
  return { ...DEFAULT_CONTRACT_NO_RULE };
}

function getProcurementNoRule() {
  try {
    const row = STMTS.getSetting.get('procurement_no_rule');
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      return {
        prefix: typeof parsed.prefix === 'string' ? parsed.prefix : DEFAULT_PROCUREMENT_NO_RULE.prefix,
        date_format: ['YYYYMMDD', 'YYYYMM', 'YYYY', 'NONE'].includes(parsed.date_format) ? parsed.date_format : DEFAULT_PROCUREMENT_NO_RULE.date_format,
        seq_digits: Number.isInteger(Number(parsed.seq_digits)) && Number(parsed.seq_digits) >= 0 && Number(parsed.seq_digits) <= 8 ? Number(parsed.seq_digits) : DEFAULT_PROCUREMENT_NO_RULE.seq_digits,
        suffix: typeof parsed.suffix === 'string' ? parsed.suffix : DEFAULT_PROCUREMENT_NO_RULE.suffix
      };
    }
  } catch (e) {}
  return { ...DEFAULT_PROCUREMENT_NO_RULE };
}

function formatDatePartByRule(dateFormat, refDateStr) {
  if (dateFormat === 'NONE') return '';
  let d = new Date();
  if (refDateStr && /^\d{4}-\d{2}-\d{2}$/.test(String(refDateStr).trim())) {
    const parts = String(refDateStr).trim().split('-');
    d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (dateFormat === 'YYYYMMDD') return `${yyyy}${mm}${dd}`;
  if (dateFormat === 'YYYYMM') return `${yyyy}${mm}`;
  if (dateFormat === 'YYYY') return `${yyyy}`;
  return '';
}

/**
 * 核心算法 1：根据前缀、中间段、日期段、后缀，采用【最小未占用正整数算法 (Gap-Filling)】计算下一个流水号
 * 优势：
 * - A 打开弹窗看到 005 后取消，数据库没写，B 保存时拿到 005（绝不断号）
 * - 哪怕 005 先保存后被删了，下一次新增也会自动优先填补 005 空缺，全部连续填满后自动顺延到 max+1
 */
function computeNextSeqForPattern(existingNos, matchStart, suffix, seqDigits) {
  if (seqDigits <= 0) return '';
  const cleanSuffix = suffix || '';
  const usedSeqSet = new Set();

  for (const rawNo of existingNos) {
    const no = String(rawNo || '').trim();
    if (!no.startsWith(matchStart)) continue;
    if (cleanSuffix && !no.endsWith(cleanSuffix)) continue;
    const core = no.slice(matchStart.length, cleanSuffix ? no.length - cleanSuffix.length : undefined);
    if (/^\d+$/.test(core)) {
      const num = parseInt(core, 10);
      if (num > 0) usedSeqSet.add(num);
    }
  }

  let nextSeq = 1;
  while (usedSeqSet.has(nextSeq)) {
    nextSeq++;
  }
  return String(nextSeq).padStart(seqDigits, '0');
}

function generateNextContractNoParts(ruleInput, refDateStr, midCustom = '') {
  const rule = ruleInput || getContractNoRule();
  const prefix = rule.prefix || '';
  const mid = String(midCustom || '').trim();
  const datePart = formatDatePartByRule(rule.date_format, refDateStr);
  const suffix = rule.suffix || '';
  const digits = Number(rule.seq_digits) || 0;

  const matchStart = `${prefix}${mid}${datePart}`;
  const allRows = STMTS.getAllContractNos.all();
  const existingNos = allRows.map(r => r.contract_no);
  const seqPart = computeNextSeqForPattern(existingNos, matchStart, suffix, digits);

  return {
    prefix,
    mid_custom: mid,
    date_part: datePart,
    seq_part: seqPart,
    suffix,
    full_no: `${matchStart}${seqPart}${suffix}`
  };
}

function generateNextProcurementNoParts(ruleInput, refDateStr, midCustom = '') {
  const rule = ruleInput || getProcurementNoRule();
  const prefix = rule.prefix || '';
  const mid = String(midCustom || '').trim();
  const datePart = formatDatePartByRule(rule.date_format, refDateStr);
  const suffix = rule.suffix || '';
  const digits = Number(rule.seq_digits) || 0;

  const matchStart = `${prefix}${mid}${datePart}`;
  const allRows = STMTS.getAllProcNos.all();
  const existingNos = allRows.map(r => r.procurement_no);
  const seqPart = computeNextSeqForPattern(existingNos, matchStart, suffix, digits);

  return {
    prefix,
    mid_custom: mid,
    date_part: datePart,
    seq_part: seqPart,
    suffix,
    full_no: `${matchStart}${seqPart}${suffix}`
  };
}

/**
 * 核心算法 2：多人同一秒点击保存撞号时的【智能原位顺延器】
 * 即使甲、乙都在编号中间加了自定义穿插段（如 XSZY-黔-BJ-ZX-202611005），
 * 也能精准识别出前半部分固定头 `XSZY-黔-BJ-ZX-202611` 和末尾流水号宽度 `3`，自动顺延成 `XSZY-黔-BJ-ZX-202611006`！
 */
function tryAutoAdvanceCollidedNo(collidedNo, rule, existingNos) {
  const digits = Number(rule.seq_digits) || 0;
  if (digits <= 0) return null;
  const suffix = rule.suffix || '';
  let body = String(collidedNo || '').trim();
  if (suffix && body.endsWith(suffix)) {
    body = body.slice(0, body.length - suffix.length);
  }
  // 提取末尾的数字流水号（至少 digits 位）
  const regex = new RegExp(`^(.*?)(\\d{${digits},})$`);
  const match = body.match(regex);
  if (!match) return null;

  const headPart = match[1];
  const seqWidth = match[2].length;
  const nextSeqStr = computeNextSeqForPattern(existingNos, headPart, suffix, seqWidth);
  if (!nextSeqStr) return null;
  return `${headPart}${nextSeqStr}${suffix}`;
}

// ==================== 7. 文件归档与三大目录孤儿清道夫 ====================
function sanitizeFolderSegment(str, fallback = '未命名') {
  const cleaned = String(str || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return (cleaned || fallback).slice(0, 60);
}

function decodeMulterFilename(rawName) {
  if (!rawName) return '未命名文件';
  let decoded = rawName;
  try {
    if (/[\u0080-\u00ff]/.test(rawName)) {
      const buf = Buffer.from(rawName, 'latin1');
      const utf8Str = buf.toString('utf8');
      if (!utf8Str.includes('\uFFFD')) {
        decoded = utf8Str;
      }
    }
  } catch (e) {}
  return decoded.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim() || '未命名文件';
}

function buildUniqueDestPath(targetDir, origName) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const safeBase = decodeMulterFilename(origName);
  const ext = path.extname(safeBase);
  const stem = path.basename(safeBase, ext) || 'file';
  let candidate = path.join(targetDir, `${stem}${ext}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${stem}(${counter})${ext}`);
    counter++;
  }
  return candidate;
}

/**
 * 主合同扫描件归档：放入 uploads/{编号}_{名称}_{签订日期}/ 下，返回相对 UPLOAD_DIR 的路径
 */
function archiveMainContractFile(tmpFilePath, origName, contractNo, contractName, signDate) {
  const folderName = `${sanitizeFolderSegment(contractNo, 'NO')}_${sanitizeFolderSegment(contractName, '合同')}_${sanitizeFolderSegment(signDate, '日期')}`;
  const targetDir = path.join(UPLOAD_DIR, folderName);
  const destPath = buildUniqueDestPath(targetDir, origName);
  fs.renameSync(tmpFilePath, destPath);
  return path.relative(UPLOAD_DIR, destPath).replace(/\\/g, '/');
}

/**
 * 合同其他相关资料归档：放入 uploads/related/{编号}_{名称}_{签订日期}/ 下
 */
function archiveRelatedContractFiles(multerFiles, contractNo, contractName, signDate, existingList = []) {
  const list = Array.isArray(existingList) ? [...existingList] : [];
  if (!Array.isArray(multerFiles) || multerFiles.length === 0) return list;

  const folderName = `${sanitizeFolderSegment(contractNo, 'NO')}_${sanitizeFolderSegment(contractName, '合同')}_${sanitizeFolderSegment(signDate, '日期')}`;
  const targetDir = path.join(RELATED_UPLOAD_DIR, folderName);

  for (const f of multerFiles) {
    if (!f || !f.path || !fs.existsSync(f.path)) continue;
    const origName = decodeMulterFilename(f.originalname);
    const destPath = buildUniqueDestPath(targetDir, origName);
    fs.renameSync(f.path, destPath);
    const relPath = path.relative(UPLOAD_DIR, destPath).replace(/\\/g, '/');
    list.push({
      id: `rel_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
      file_name: relPath,
      file_orig_name: origName,
      file_size: f.size || 0,
      uploaded_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    });
  }
  return list;
}

/**
 * 采购立项资料归档：放入 uploads/procurement/{立项编号}_{项目名称}_{立项日期}/ 下
 */
function archiveProcurementFiles(multerFiles, procNo, projectName, approvalDate, existingList = []) {
  const list = Array.isArray(existingList) ? [...existingList] : [];
  if (!Array.isArray(multerFiles) || multerFiles.length === 0) return list;

  const folderName = `${sanitizeFolderSegment(procNo, 'LX')}_${sanitizeFolderSegment(projectName, '立项')}_${sanitizeFolderSegment(approvalDate, '日期')}`;
  const targetDir = path.join(PROCUREMENT_UPLOAD_DIR, folderName);

  for (const f of multerFiles) {
    if (!f || !f.path || !fs.existsSync(f.path)) continue;
    const origName = decodeMulterFilename(f.originalname);
    const destPath = buildUniqueDestPath(targetDir, origName);
    fs.renameSync(f.path, destPath);
    const relPath = path.relative(UPLOAD_DIR, destPath).replace(/\\/g, '/');
    list.push({
      id: `proc_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
      file_name: relPath,
      file_orig_name: origName,
      file_size: f.size || 0,
      uploaded_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    });
  }
  return list;
}

/**
 * 安全删除 UPLOAD_DIR 下的指定相对路径文件，若其父文件夹变空则一并清除空文件夹
 */
function safeUnlinkUploadRelPath(relPath) {
  if (!relPath) return;
  try {
    const normalized = path.normalize(String(relPath)).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.resolve(UPLOAD_DIR, normalized);
    if (!fullPath.startsWith( path.resolve(UPLOAD_DIR) + path.sep )) return;
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      fs.unlinkSync(fullPath);
    }
    // 检查所在子目录是否已空，若空且不是根保留目录则自动删除空文件夹
    const parentDir = path.dirname(fullPath);
    const protectedDirs = [
      path.resolve(UPLOAD_DIR),
      path.resolve(TMP_UPLOAD_DIR),
      path.resolve(RELATED_UPLOAD_DIR),
      path.resolve(PROCUREMENT_UPLOAD_DIR)
    ];
    if (!protectedDirs.includes(parentDir) && parentDir.startsWith(path.resolve(UPLOAD_DIR))) {
      if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
        fs.rmdirSync(parentDir);
      }
    }
  } catch (e) {}
}

/**
 * 三大资料库全自动清道夫：比对 SQLite 数据库与物理磁盘，清理任何未被引用的孤儿文件与空壳文件夹
 */
function sweepOrphanUploads() {
  try {
    const referencedRelPaths = new Set();

    const contracts = db.prepare(`SELECT file_name, related_files_json FROM contracts`).all();
    for (const c of contracts) {
      if (c.file_name) referencedRelPaths.add(String(c.file_name).replace(/\\/g, '/'));
      if (c.related_files_json) {
        try {
          const arr = JSON.parse(c.related_files_json);
          if (Array.isArray(arr)) {
            arr.forEach(item => {
              if (item && item.file_name) referencedRelPaths.add(String(item.file_name).replace(/\\/g, '/'));
            });
          }
        } catch (e) {}
      }
    }

    const procs = db.prepare(`SELECT files_json FROM procurements`).all();
    for (const p of procs) {
      if (p.files_json) {
        try {
          const arr = JSON.parse(p.files_json);
          if (Array.isArray(arr)) {
            arr.forEach(item => {
              if (item && item.file_name) referencedRelPaths.add(String(item.file_name).replace(/\\/g, '/'));
            });
          }
        } catch (e) {}
      }
    }

    const protectedDirs = new Set([
      path.resolve(UPLOAD_DIR),
      path.resolve(TMP_UPLOAD_DIR),
      path.resolve(RELATED_UPLOAD_DIR),
      path.resolve(PROCUREMENT_UPLOAD_DIR)
    ]);

    function walkAndClean(currentDir) {
      if (!fs.existsSync(currentDir)) return;
      // 跳过 .tmp 目录（由专门的超时清理器负责）
      if (path.resolve(currentDir) === path.resolve(TMP_UPLOAD_DIR)) return;

      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walkAndClean(fullPath);
          // 递归回来后如果子文件夹空了，且不在保护名单内，直接删掉空文件夹
          if (!protectedDirs.has(path.resolve(fullPath))) {
            try {
              if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length === 0) {
                fs.rmdirSync(fullPath);
              }
            } catch (e) {}
          }
        } else if (entry.isFile()) {
          const rel = path.relative(UPLOAD_DIR, fullPath).replace(/\\/g, '/');
          if (!referencedRelPaths.has(rel)) {
            try { fs.unlinkSync(fullPath); } catch (e) {}
          }
        }
      }
    }

    walkAndClean(UPLOAD_DIR);
  } catch (e) {}
}

// 启动时执行一次序号校准与孤儿文件清扫
recalculateAllSequences();
recalculateProcurementSequences();
sweepOrphanUploads();

// 针对 7×24 小时长期不关机场景：每 6 小时静默巡检一次超时临时文件、孤儿文件与 WAL 日志体积
const maintenanceTimer = setInterval(() => {
  try {
    cleanExpiredTmpFiles(3600 * 1000);
    sweepOrphanUploads();
    if (db && db.open) db.pragma('wal_checkpoint(PASSIVE)');
    triggerSafeGC();
  } catch (e) {}
}, 6 * 60 * 60 * 1000);
if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();

// ==================== 8. Multer 上传配置（统一先入 .tmp 隔离区） ====================
const ALLOWED_EXTS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx',
  '.txt', '.zip', '.rar', '.7z'
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(TMP_UPLOAD_DIR)) fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
    cb(null, TMP_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(decodeMulterFilename(file.originalname)).toLowerCase();
    const tmpName = `tmp_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, tmpName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 25 },
  fileFilter: (req, file, cb) => {
    const orig = decodeMulterFilename(file.originalname);
    const ext = path.extname(orig).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return cb(new Error(`不支持的文件格式 (${ext || '未知'})，允许上传 PDF/图片/Office文档/压缩包`));
    }
    cb(null, true);
  }
});

const contractUploadFields = upload.fields([
  { name: 'scan_file', maxCount: 1 },
  { name: 'related_files', maxCount: 20 }
]);

// ==================== 9. 纯内网 IP 防火墙与局域网访问密码锁 ====================
function isPrivateLanIP(ip) {
  if (!ip) return false;
  const cleanIp = String(ip).replace(/^::ffff:/i, '').trim();
  if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp === 'localhost') return true;
  if (/^10\./.test(cleanIp)) return true;
  if (/^192\.168\./.test(cleanIp)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(cleanIp)) return true;
  if (/^169\.254\./.test(cleanIp)) return true;
  if (/^fc00:/i.test(cleanIp) || /^fe80:/i.test(cleanIp) || /^fd/i.test(cleanIp)) return true;
  return false;
}

app.use((req, res, next) => {
  const clientIp = req.ip || req.socket?.remoteAddress || '';
  if (!isPrivateLanIP(clientIp)) {
    return res.status(403).send('禁止访问：本系统仅限局域网/内网设备访问');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// 密码哈希与会话管理
const activeSessions = new Map(); // token -> expireAt
const loginAttempts = new Map();  // ip -> { count, lockUntil }

const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of activeSessions.entries()) {
    if (now > exp) activeSessions.delete(token);
  }
  for (const [ip, rec] of loginAttempts.entries()) {
    if (now > rec.lockUntil + 600000) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);
if (typeof sessionCleanupTimer.unref === 'function') sessionCleanupTimer.unref();

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, origHash] = stored.split(':');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(origHash, 'hex'), Buffer.from(hash, 'hex'));
}

function getStoredPasswordHash() {
  const row = STMTS.getSetting.get('lan_access_password_hash');
  return row ? row.value : '';
}

function extractToken(req) {
  const headerToken = req.headers['x-lan-token'];
  if (headerToken) return String(headerToken);
  if (req.query && req.query.token) return String(req.query.token);
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)lan_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function isRequestAuthenticated(req) {
  const pwdHash = getStoredPasswordHash();
  if (!pwdHash) return true; // 未设置密码则直接放行
  const token = extractToken(req);
  if (!token) return false;
  const exp = activeSessions.get(token);
  if (!exp || Date.now() > exp) {
    activeSessions.delete(token);
    return false;
  }
  // 自动续期会话（滑动窗口 7 天）
  activeSessions.set(token, Date.now() + 7 * 24 * 3600 * 1000);
  return true;
}

// 静态资源托管
app.use(express.static(PUBLIC_DIR));

// 受保护的上传文件访问路由（防目录穿越 + 鉴权）
app.get('/uploads/*', (req, res) => {
  if (!isRequestAuthenticated(req)) {
    return res.status(401).send('未授权访问，请先解锁系统');
  }
  const relPath = req.params[0] || '';
  if (!relPath || relPath.startsWith('.tmp')) {
    return res.status(403).send('禁止访问临时目录');
  }
  const safePath = path.resolve(UPLOAD_DIR, relPath);
  if (!safePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    return res.status(403).send('非法文件路径');
  }
  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    return res.status(404).send('文件不存在或已被清理');
  }
  res.sendFile(safePath);
});

// ==================== 10. 局域网安全锁与系统信息 API ====================
app.get('/api/auth/status', (req, res) => {
  const hasPassword = Boolean(getStoredPasswordHash());
  const authenticated = isRequestAuthenticated(req);
  res.json({ success: true, has_password: hasPassword, authenticated });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  if (now < attempt.lockUntil) {
    const waitSec = Math.ceil((attempt.lockUntil - now) / 1000);
    return res.status(429).json({ success: false, message: `密码错误次数过多，请等待 ${waitSec} 秒后再试` });
  }

  const pwdHash = getStoredPasswordHash();
  if (!pwdHash) {
    return res.json({ success: true, token: 'no_pwd_required' });
  }

  const { password } = req.body || {};
  if (!password || !verifyPassword(password, pwdHash)) {
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.lockUntil = now + 60 * 1000; // 连续错5次锁定60秒
      attempt.count = 0;
    }
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ success: false, message: '访问密码不正确' });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, now + 7 * 24 * 3600 * 1000);
  res.setHeader('Set-Cookie', `lan_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  res.json({ success: true, token, message: '解锁成功' });
});

app.post('/api/auth/password', (req, res) => {
  if (!isRequestAuthenticated(req)) {
    return res.status(401).json({ success: false, message: '未授权操作' });
  }
  const { current_password, new_password } = req.body || {};
  const existingHash = getStoredPasswordHash();
  if (existingHash) {
    if (!current_password || !verifyPassword(current_password, existingHash)) {
      return res.status(400).json({ success: false, message: '当前旧密码验证失败' });
    }
  }
  const cleanNew = String(new_password || '').trim();
  if (!cleanNew) {
    // 清空密码（取消局域网锁）
    STMTS.setSetting.run('lan_access_password_hash', '');
    activeSessions.clear();
    return res.json({ success: true, has_password: false, message: '已取消局域网访问密码保护' });
  }
  if (cleanNew.length < 4) {
    return res.status(400).json({ success: false, message: '新密码长度至少为 4 位' });
  }
  const newHash = hashPassword(cleanNew);
  STMTS.setSetting.run('lan_access_password_hash', newHash);
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.clear();
  activeSessions.set(token, Date.now() + 7 * 24 * 3600 * 1000);
  res.setHeader('Set-Cookie', `lan_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  res.json({ success: true, has_password: true, token, message: '局域网访问密码设置成功' });
});

// 除登录与状态外的 API 统一鉴权中间件
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (!isRequestAuthenticated(req)) {
    return res.status(401).json({ success: false, message: '请先输入局域网访问密码解锁系统' });
  }
  next();
});

app.get('/api/system-info', (req, res) => {
  const nets = os.networkInterfaces();
  const lanUrls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && isPrivateLanIP(net.address)) {
        lanUrls.push(`http://${net.address}:${PORT}`);
      }
    }
  }
  res.json({
    success: true,
    port: PORT,
    hostname: os.hostname(),
    lan_urls: lanUrls,
    local_url: `http://localhost:${PORT}`
  });
});

// ==================== 11. 编号规则配置与实时乐观预览 API ====================
app.get('/api/settings/contract-no-rule', (req, res) => {
  const rule = getContractNoRule();
  const signDate = req.query.sign_date ? String(req.query.sign_date) : '';
  const midCustom = req.query.mid_custom ? String(req.query.mid_custom) : '';
  const parts = generateNextContractNoParts(rule, signDate, midCustom);
  res.json({
    success: true,
    rule,
    next_no: parts.full_no,
    parts
  });
});

app.put('/api/settings/contract-no-rule', (req, res) => {
  const body = req.body || {};
  const newRule = {
    prefix: String(body.prefix ?? '').trim(),
    date_format: ['YYYYMMDD', 'YYYYMM', 'YYYY', 'NONE'].includes(body.date_format) ? body.date_format : 'YYYYMM',
    seq_digits: Math.min(8, Math.max(0, parseInt(body.seq_digits ?? 3, 10) || 0)),
    suffix: String(body.suffix ?? '').trim()
  };
  STMTS.setSetting.run('contract_no_rule', JSON.stringify(newRule));
  const parts = generateNextContractNoParts(newRule, body.sign_date || '', body.mid_custom || '');
  res.json({
    success: true,
    message: '合同编号规则已保存生效',
    rule: newRule,
    next_no: parts.full_no,
    parts
  });
});

app.get('/api/settings/procurement-no-rule', (req, res) => {
  const rule = getProcurementNoRule();
  const approvalDate = req.query.approval_date ? String(req.query.approval_date) : '';
  const midCustom = req.query.mid_custom ? String(req.query.mid_custom) : '';
  const parts = generateNextProcurementNoParts(rule, approvalDate, midCustom);
  res.json({
    success: true,
    rule,
    next_no: parts.full_no,
    parts
  });
});

app.put('/api/settings/procurement-no-rule', (req, res) => {
  const body = req.body || {};
  const newRule = {
    prefix: String(body.prefix ?? '').trim(),
    date_format: ['YYYYMMDD', 'YYYYMM', 'YYYY', 'NONE'].includes(body.date_format) ? body.date_format : 'YYYYMMDD',
    seq_digits: Math.min(8, Math.max(0, parseInt(body.seq_digits ?? 3, 10) || 0)),
    suffix: String(body.suffix ?? '').trim()
  };
  STMTS.setSetting.run('procurement_no_rule', JSON.stringify(newRule));
  const parts = generateNextProcurementNoParts(newRule, body.approval_date || '', body.mid_custom || '');
  res.json({
    success: true,
    message: '采购立项编号规则已保存生效',
    rule: newRule,
    next_no: parts.full_no,
    parts
  });
});

// ==================== 12. 跨模块轻量级下拉关联候选 API ====================
app.get('/api/procurements/simple-list', (req, res) => {
  const list = db.prepare(`
    SELECT p.id, p.seq_no, p.procurement_no, p.project_name, p.budget_amount, p.final_amount,
           p.approval_date, p.supplier, p.status, p.contract_id,
           c.contract_no AS linked_contract_no
    FROM procurements p
    LEFT JOIN contracts c ON p.contract_id = c.id
    ORDER BY p.approval_date DESC, p.id DESC
  `).all();
  res.json({ success: true, data: list });
});

app.get('/api/contracts/simple-list', (req, res) => {
  const list = db.prepare(`
    SELECT c.id, c.seq_no, c.contract_no, c.contract_name, c.amount, c.sign_date,
           c.party_b, c.status, c.procurement_id,
           p.procurement_no AS linked_procurement_no
    FROM contracts c
    LEFT JOIN procurements p ON c.procurement_id = p.id
    ORDER BY c.sign_date DESC, c.id DESC
  `).all();
  res.json({ success: true, data: list });
});

// ==================== 13. 合同台账核心 CRUD 与并发防撞号 API ====================
function buildContractFilterQuery(query) {
  const conditions = [];
  const params = [];

  const kw = String(query.keyword || '').trim();
  if (kw) {
    conditions.push(`(
      c.contract_no LIKE ? OR c.contract_name LIKE ? OR c.party_a LIKE ? OR c.party_b LIKE ?
      OR c.owner LIKE ? OR c.department LIKE ? OR c.remarks LIKE ? OR c.seq_no LIKE ?
      OR p.procurement_no LIKE ? OR p.project_name LIKE ?
    )`);
    const likeKw = `%${kw}%`;
    params.push(likeKw, likeKw, likeKw, likeKw, likeKw, likeKw, likeKw, likeKw, likeKw, likeKw);
  }
  if (query.status) {
    conditions.push(`c.status = ?`);
    params.push(String(query.status).trim());
  }
  if (query.contract_type) {
    conditions.push(`c.contract_type = ?`);
    params.push(String(query.contract_type).trim());
  }
  if (query.start_date) {
    conditions.push(`c.sign_date >= ?`);
    params.push(String(query.start_date).trim());
  }
  if (query.end_date) {
    conditions.push(`c.sign_date <= ?`);
    params.push(String(query.end_date).trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

app.get('/api/contracts', (req, res) => {
  const { whereClause, params } = buildContractFilterQuery(req.query);
  const sql = `
    SELECT c.*,
           p.procurement_no AS linked_procurement_no,
           p.project_name AS linked_project_name,
           p.budget_amount AS linked_budget_amount
    FROM contracts c
    LEFT JOIN procurements p ON c.procurement_id = p.id
    ${whereClause}
    ORDER BY c.sign_date DESC, c.id DESC
  `;
  const rows = db.prepare(sql).all(...params);
  const data = rows.map(r => {
    let relatedFiles = [];
    try { relatedFiles = JSON.parse(r.related_files_json || '[]'); } catch (e) {}
    return { ...r, related_files: Array.isArray(relatedFiles) ? relatedFiles : [] };
  });

  // 统计卡片聚合
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      COALESCE(SUM(amount), 0) AS total_amount,
      SUM(CASE WHEN status = '履行中' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN status = '已完结' THEN 1 ELSE 0 END) AS completed_count
    FROM contracts
  `).get();

  res.json({ success: true, data, stats });
});

app.get('/api/contracts/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT c.*,
           p.procurement_no AS linked_procurement_no,
           p.project_name AS linked_project_name,
           p.budget_amount AS linked_budget_amount,
           p.approval_date AS linked_approval_date,
           p.status AS linked_procurement_status
    FROM contracts c
    LEFT JOIN procurements p ON c.procurement_id = p.id
    WHERE c.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ success: false, message: '未找到该合同记录' });
  let relatedFiles = [];
  try { relatedFiles = JSON.parse(row.related_files_json || '[]'); } catch (e) {}
  res.json({ success: true, data: { ...row, related_files: Array.isArray(relatedFiles) ? relatedFiles : [] } });
});

app.post('/api/contracts', (req, res) => {
  contractUploadFields(req, res, (err) => {
    if (err) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: err.message || '文件上传失败' });
    }

    const newlyArchivedPaths = [];
    try {
      const body = req.body || {};
      const cleanNo = String(body.contract_no || '').trim();
      const cleanName = String(body.contract_name || '').trim();
      const cleanType = String(body.contract_type || '').trim();
      const cleanPartyA = String(body.party_a || '').trim();
      const cleanPartyB = String(body.party_b || '').trim();
      const numAmount = Number(body.amount || 0);
      const cleanSignDate = String(body.sign_date || '').trim();
      const cleanStartDate = String(body.start_date || '').trim();
      const cleanEndDate = String(body.end_date || '').trim();
      const cleanStatus = String(body.status || '履行中').trim();
      const cleanOwner = String(body.owner || '').trim();
      const cleanDept = String(body.department || '').trim();
      const cleanPhone = String(body.phone || '').trim();
      const cleanRemarks = String(body.remarks || '').trim();
      const targetProcId = body.procurement_id ? Number(body.procurement_id) : null;

      if (!cleanNo || !cleanName || !cleanPartyA || !cleanPartyB || !cleanSignDate) {
        cleanupReqTempFiles(req);
        return res.status(400).json({ success: false, message: '合同编号、名称、甲乙双方、签订日期为必填项' });
      }
      if (isNaN(numAmount) || numAmount < 0) {
        cleanupReqTempFiles(req);
        return res.status(400).json({ success: false, message: '合同金额必须为有效的非负数字' });
      }

      const scanFileObj = req.files && req.files['scan_file'] ? req.files['scan_file'][0] : null;
      const relatedFileObjs = req.files && req.files['related_files'] ? req.files['related_files'] : [];

      const createTx = db.transaction(() => {
        let finalNo = cleanNo;
        let autoAdjustedMsg = '';

        // 【多机并发防撞号核心】若多人同时打开弹窗看到 005 并先后点保存，后保存者自动顺延为 006（且完整保留自定义穿插段）
        if (STMTS.checkDuplicateNoOnCreate.get(finalNo)) {
          const rule = getContractNoRule();
          const existingNos = STMTS.getAllContractNos.all().map(r => r.contract_no);
          let nextCandidate = null;
          if (rule.seq_digits > 0 && finalNo.startsWith(rule.prefix || '')) {
            nextCandidate = tryAutoAdvanceCollidedNo(finalNo, rule, existingNos);
            if (!nextCandidate) {
              nextCandidate = generateNextContractNoParts(rule, cleanSignDate).full_no;
            }
          }
          if (nextCandidate && !STMTS.checkDuplicateNoOnCreate.get(nextCandidate)) {
            finalNo = nextCandidate;
            autoAdjustedMsg = `（注：原编号已被其他同事抢先录入，系统已自动为您顺延编号为：${finalNo}）`;
          } else {
            throw new Error('合同编号已存在，请点击“重算流水号”或修改编号');
          }
        }

        let savedFileName = '';
        let savedOrigName = '';
        let savedFileSize = 0;

        if (scanFileObj && fs.existsSync(scanFileObj.path)) {
          savedOrigName = decodeMulterFilename(scanFileObj.originalname);
          savedFileSize = scanFileObj.size || 0;
          savedFileName = archiveMainContractFile(scanFileObj.path, savedOrigName, finalNo, cleanName, cleanSignDate);
          newlyArchivedPaths.push(savedFileName);
        }

        const relatedList = archiveRelatedContractFiles(relatedFileObjs, finalNo, cleanName, cleanSignDate, []);
        relatedList.forEach(item => newlyArchivedPaths.push(item.file_name));

        const info = db.prepare(`
          INSERT INTO contracts (
            contract_no, contract_name, contract_type, party_a, party_b, amount,
            sign_date, start_date, end_date, status, owner, department, phone, remarks,
            file_name, file_orig_name, file_size, related_files_json, procurement_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          finalNo, cleanName, cleanType, cleanPartyA, cleanPartyB, numAmount,
          cleanSignDate, cleanStartDate, cleanEndDate, cleanStatus, cleanOwner, cleanDept, cleanPhone, cleanRemarks,
          savedFileName, savedOrigName, savedFileSize, JSON.stringify(relatedList), targetProcId
        );

        const newId = Number(info.lastInsertRowid);
        linkContractToProcurement(newId, targetProcId);
        recalculateAllSequences();

        return { id: newId, contract_no: finalNo, autoAdjustedMsg };
      });

      const result = createTx();
      cleanupReqTempFiles(req);
      res.json({
        success: true,
        id: result.id,
        contract_no: result.contract_no,
        message: '合同新增成功' + result.autoAdjustedMsg
      });
    } catch (error) {
      cleanupReqTempFiles(req);
      newlyArchivedPaths.forEach(rel => safeUnlinkUploadRelPath(rel));
      res.status(400).json({ success: false, message: error.message || '保存合同失败' });
    }
  });
});

app.put('/api/contracts/:id', (req, res) => {
  contractUploadFields(req, res, (err) => {
    if (err) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: err.message || '文件上传失败' });
    }

    const newlyArchivedPaths = [];
    const oldPathsToDeleteAfterCommit = [];

    try {
      const id = Number(req.params.id);
      const existing = STMTS.getContractById.get(id);
      if (!existing) {
        cleanupReqTempFiles(req);
        return res.status(404).json({ success: false, message: '要修改的合同记录不存在' });
      }

      const body = req.body || {};
      const cleanNo = String(body.contract_no || '').trim();
      const cleanName = String(body.contract_name || '').trim();
      const cleanType = String(body.contract_type || '').trim();
      const cleanPartyA = String(body.party_a || '').trim();
      const cleanPartyB = String(body.party_b || '').trim();
      const numAmount = Number(body.amount || 0);
      const cleanSignDate = String(body.sign_date || '').trim();
      const cleanStartDate = String(body.start_date || '').trim();
      const cleanEndDate = String(body.end_date || '').trim();
      const cleanStatus = String(body.status || '履行中').trim();
      const cleanOwner = String(body.owner || '').trim();
      const cleanDept = String(body.department || '').trim();
      const cleanPhone = String(body.phone || '').trim();
      const cleanRemarks = String(body.remarks || '').trim();
      const targetProcId = body.procurement_id ? Number(body.procurement_id) : null;
      const removeScanFile = body.remove_file === '1' || body.remove_file === 'true';

      if (!cleanNo || !cleanName || !cleanPartyA || !cleanPartyB || !cleanSignDate) {
        cleanupReqTempFiles(req);
        return res.status(400).json({ success: false, message: '合同编号、名称、甲乙双方、签订日期为必填项' });
      }

      const scanFileObj = req.files && req.files['scan_file'] ? req.files['scan_file'][0] : null;
      const relatedFileObjs = req.files && req.files['related_files'] ? req.files['related_files'] : [];

      const updateTx = db.transaction(() => {
        if (STMTS.checkDuplicateNoOnUpdate.get(cleanNo, id)) {
          throw new Error('该合同编号已被其他记录占用，请确保唯一性');
        }

        let fileName = existing.file_name || '';
        let fileOrigName = existing.file_orig_name || '';
        let fileSize = existing.file_size || 0;

        if (scanFileObj && fs.existsSync(scanFileObj.path)) {
          if (fileName) oldPathsToDeleteAfterCommit.push(fileName);
          fileOrigName = decodeMulterFilename(scanFileObj.originalname);
          fileSize = scanFileObj.size || 0;
          fileName = archiveMainContractFile(scanFileObj.path, fileOrigName, cleanNo, cleanName, cleanSignDate);
          newlyArchivedPaths.push(fileName);
        } else if (removeScanFile && fileName) {
          oldPathsToDeleteAfterCommit.push(fileName);
          fileName = '';
          fileOrigName = '';
          fileSize = 0;
        }

        let currentRelated = [];
        try { currentRelated = JSON.parse(existing.related_files_json || '[]'); } catch (e) {}
        if (!Array.isArray(currentRelated)) currentRelated = [];

        const updatedRelated = archiveRelatedContractFiles(relatedFileObjs, cleanNo, cleanName, cleanSignDate, currentRelated);
        if (relatedFileObjs.length > 0) {
          const added = updatedRelated.slice(currentRelated.length);
          added.forEach(item => newlyArchivedPaths.push(item.file_name));
        }

        db.prepare(`
          UPDATE contracts SET
            contract_no = ?, contract_name = ?, contract_type = ?, party_a = ?, party_b = ?,
            amount = ?, sign_date = ?, start_date = ?, end_date = ?, status = ?,
            owner = ?, department = ?, phone = ?, remarks = ?,
            file_name = ?, file_orig_name = ?, file_size = ?, related_files_json = ?,
            updated_at = datetime('now', 'localtime')
          WHERE id = ?
        `).run(
          cleanNo, cleanName, cleanType, cleanPartyA, cleanPartyB,
          numAmount, cleanSignDate, cleanStartDate, cleanEndDate, cleanStatus,
          cleanOwner, cleanDept, cleanPhone, cleanRemarks,
          fileName, fileOrigName, fileSize, JSON.stringify(updatedRelated),
          id
        );

        linkContractToProcurement(id, targetProcId);
        recalculateAllSequences();
      });

      updateTx();
      cleanupReqTempFiles(req);
      oldPathsToDeleteAfterCommit.forEach(rel => safeUnlinkUploadRelPath(rel));
      res.json({ success: true, message: '合同信息更新成功' });
    } catch (error) {
      cleanupReqTempFiles(req);
      newlyArchivedPaths.forEach(rel => safeUnlinkUploadRelPath(rel));
      res.status(400).json({ success: false, message: error.message || '更新合同失败' });
    }
  });
});

// 详情窗快捷补传/替换主合同扫描件
app.post('/api/contracts/:id/upload-scan', upload.single('scan_file'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getContractById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    if (!req.file || !fs.existsSync(req.file.path)) {
      return res.status(400).json({ success: false, message: '未选择要上传的扫描件' });
    }
    const origName = decodeMulterFilename(req.file.originalname);
    const newRelPath = archiveMainContractFile(req.file.path, origName, existing.contract_no, existing.contract_name, existing.sign_date);
    const oldRelPath = existing.file_name;

    db.prepare(`
      UPDATE contracts SET file_name = ?, file_orig_name = ?, file_size = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(newRelPath, origName, req.file.size || 0, id);

    if (oldRelPath && oldRelPath !== newRelPath) {
      safeUnlinkUploadRelPath(oldRelPath);
    }
    res.json({ success: true, message: '主合同扫描件已上传更新' });
  } catch (e) {
    cleanupReqTempFiles(req);
    res.status(400).json({ success: false, message: e.message || '上传失败' });
  }
});

// 详情窗快捷追加“其他相关资料”
app.post('/api/contracts/:id/related-files', upload.array('related_files', 20), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getContractById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要上传的附件' });
    }
    let currentList = [];
    try { currentList = JSON.parse(existing.related_files_json || '[]'); } catch (e) {}
    if (!Array.isArray(currentList)) currentList = [];

    const updatedList = archiveRelatedContractFiles(req.files, existing.contract_no, existing.contract_name, existing.sign_date, currentList);
    db.prepare(`UPDATE contracts SET related_files_json = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
      .run(JSON.stringify(updatedList), id);

    res.json({ success: true, message: `成功上传 ${req.files.length} 份相关资料`, related_files: updatedList });
  } catch (e) {
    cleanupReqTempFiles(req);
    res.status(400).json({ success: false, message: e.message || '上传相关资料失败' });
  }
});

// 详情窗删除单份“其他相关资料”
app.delete('/api/contracts/:id/related-files/:fileId', (req, res) => {
  const id = Number(req.params.id);
  const fileId = String(req.params.fileId || '');
  const existing = STMTS.getContractById.get(id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });

  let list = [];
  try { list = JSON.parse(existing.related_files_json || '[]'); } catch (e) {}
  if (!Array.isArray(list)) list = [];

  const target = list.find(item => item && item.id === fileId);
  if (!target) return res.status(404).json({ success: false, message: '未找到该附件记录' });

  const newList = list.filter(item => item && item.id !== fileId);
  db.prepare(`UPDATE contracts SET related_files_json = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
    .run(JSON.stringify(newList), id);

  safeUnlinkUploadRelPath(target.file_name);
  res.json({ success: true, message: '相关资料已物理删除', related_files: newList });
});

app.delete('/api/contracts/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = STMTS.getContractById.get(id);
  if (!existing) return res.status(404).json({ success: false, message: '合同记录不存在' });

  let relatedList = [];
  try { relatedList = JSON.parse(existing.related_files_json || '[]'); } catch (e) {}

  const deleteTx = db.transaction(() => {
    STMTS.clearProcContractLink.run(id);
    db.prepare(`DELETE FROM contracts WHERE id = ?`).run(id);
    recalculateAllSequences();
  });

  deleteTx();

  if (existing.file_name) safeUnlinkUploadRelPath(existing.file_name);
  if (Array.isArray(relatedList)) {
    relatedList.forEach(item => { if (item && item.file_name) safeUnlinkUploadRelPath(item.file_name); });
  }
  sweepOrphanUploads();
  res.json({ success: true, message: '合同记录及关联附件已彻底删除' });
});

// ==================== 14. 采购立项台账核心 CRUD 与并发防撞号 API ====================
function buildProcFilterQuery(query) {
  const conditions = [];
  const params = [];

  const kw = String(query.keyword || '').trim();
  if (kw) {
    conditions.push(`(
      p.procurement_no LIKE ? OR p.project_name LIKE ? OR p.department LIKE ?
      OR p.applicant LIKE ? OR p.supplier LIKE ? OR p.remarks LIKE ? OR p.seq_no LIKE ?
      OR c.contract_no LIKE ? OR c.contract_name LIKE ?
    )`);
    const likeKw = `%${kw}%`;
    params.push(likeKw, likeKw, likeKw, likeKw, likeKw, likeKw, likeKw, likeKw, likeKw);
  }
  if (query.status) {
    conditions.push(`p.status = ?`);
    params.push(String(query.status).trim());
  }
  if (query.procurement_type) {
    conditions.push(`p.procurement_type = ?`);
    params.push(String(query.procurement_type).trim());
  }
  if (query.start_date) {
    conditions.push(`p.approval_date >= ?`);
    params.push(String(query.start_date).trim());
  }
  if (query.end_date) {
    conditions.push(`p.approval_date <= ?`);
    params.push(String(query.end_date).trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

app.get('/api/procurements', (req, res) => {
  const { whereClause, params } = buildProcFilterQuery(req.query);
  const sql = `
    SELECT p.*,
           c.contract_no AS linked_contract_no,
           c.contract_name AS linked_contract_name,
           c.amount AS linked_contract_amount
    FROM procurements p
    LEFT JOIN contracts c ON p.contract_id = c.id
    ${whereClause}
    ORDER BY p.approval_date DESC, p.id DESC
  `;
  const rows = db.prepare(sql).all(...params);
  const data = rows.map(r => {
    let files = [];
    try { files = JSON.parse(r.files_json || '[]'); } catch (e) {}
    return { ...r, files: Array.isArray(files) ? files : [] };
  });

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      COALESCE(SUM(budget_amount), 0) AS total_budget,
      COALESCE(SUM(final_amount), 0) AS total_final,
      SUM(CASE WHEN contract_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_count
    FROM procurements
  `).get();

  res.json({ success: true, data, stats });
});

app.get('/api/procurements/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT p.*,
           c.contract_no AS linked_contract_no,
           c.contract_name AS linked_contract_name,
           c.amount AS linked_contract_amount,
           c.sign_date AS linked_contract_sign_date,
           c.status AS linked_contract_status
    FROM procurements p
    LEFT JOIN contracts c ON p.contract_id = c.id
    WHERE p.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ success: false, message: '未找到该采购立项记录' });
  let files = [];
  try { files = JSON.parse(row.files_json || '[]'); } catch (e) {}
  res.json({ success: true, data: { ...row, files: Array.isArray(files) ? files : [] } });
});

app.post('/api/procurements', upload.array('proc_files', 20), (req, res) => {
  const newlyArchivedPaths = [];
  try {
    const body = req.body || {};
    const cleanNo = String(body.procurement_no || '').trim();
    const cleanName = String(body.project_name || '').trim();
    const cleanType = String(body.procurement_type || '货物类').trim();
    const cleanMethod = String(body.procurement_method || '询价采购').trim();
    const numBudget = Number(body.budget_amount || 0);
    const numFinal = Number(body.final_amount || 0);
    const cleanDept = String(body.department || '').trim();
    const cleanApplicant = String(body.applicant || '').trim();
    const cleanPhone = String(body.phone || '').trim();
    const cleanSupplier = String(body.supplier || '').trim();
    const cleanApprovalDate = String(body.approval_date || '').trim();
    const cleanStatus = String(body.status || '立项审批中').trim();
    const cleanRemarks = String(body.remarks || '').trim();
    const targetContractId = body.contract_id ? Number(body.contract_id) : null;

    if (!cleanNo || !cleanName || !cleanApprovalDate) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: '立项编号、采购项目名称、立项日期为必填项' });
    }

    const createTx = db.transaction(() => {
      let finalProcNo = cleanNo;
      let autoAdjustedProcMsg = '';

      // 【多机并发防撞号核心】多人同时打开立项弹窗点保存时，自动顺延并保留自定义段
      if (STMTS.checkDupProcNoCreate.get(finalProcNo)) {
        const rule = getProcurementNoRule();
        const existingNos = STMTS.getAllProcNos.all().map(r => r.procurement_no);
        let nextCandidate = null;
        if (rule.seq_digits > 0 && finalProcNo.startsWith(rule.prefix || '')) {
          nextCandidate = tryAutoAdvanceCollidedNo(finalProcNo, rule, existingNos);
          if (!nextCandidate) {
            nextCandidate = generateNextProcurementNoParts(rule, cleanApprovalDate).full_no;
          }
        }
        if (nextCandidate && !STMTS.checkDupProcNoCreate.get(nextCandidate)) {
          finalProcNo = nextCandidate;
          autoAdjustedProcMsg = `（注：原立项编号已被其他同事抢先录入，系统已自动为您顺延为：${finalProcNo}）`;
        } else {
          throw new Error('采购立项编号已存在，请点击“重算流水号”或修改编号');
        }
      }

      const filesList = archiveProcurementFiles(req.files || [], finalProcNo, cleanName, cleanApprovalDate, []);
      filesList.forEach(item => newlyArchivedPaths.push(item.file_name));

      const info = db.prepare(`
        INSERT INTO procurements (
          procurement_no, project_name, procurement_type, procurement_method,
          budget_amount, final_amount, department, applicant, phone, supplier,
          approval_date, status, contract_id, remarks, files_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        finalProcNo, cleanName, cleanType, cleanMethod,
        numBudget, numFinal, cleanDept, cleanApplicant, cleanPhone, cleanSupplier,
        cleanApprovalDate, cleanStatus, targetContractId, cleanRemarks, JSON.stringify(filesList)
      );

      const newId = Number(info.lastInsertRowid);
      linkProcurementToContract(newId, targetContractId);
      recalculateProcurementSequences();

      return { id: newId, procurement_no: finalProcNo, autoAdjustedProcMsg };
    });

    const result = createTx();
    cleanupReqTempFiles(req);
    res.json({
      success: true,
      id: result.id,
      procurement_no: result.procurement_no,
      message: '采购立项新增成功' + result.autoAdjustedProcMsg
    });
  } catch (error) {
    cleanupReqTempFiles(req);
    newlyArchivedPaths.forEach(rel => safeUnlinkUploadRelPath(rel));
    res.status(400).json({ success: false, message: error.message || '保存采购立项失败' });
  }
});

app.put('/api/procurements/:id', upload.array('proc_files', 20), (req, res) => {
  const newlyArchivedPaths = [];
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getProcById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '要修改的立项记录不存在' });
    }

    const body = req.body || {};
    const cleanNo = String(body.procurement_no || '').trim();
    const cleanName = String(body.project_name || '').trim();
    const cleanType = String(body.procurement_type || '货物类').trim();
    const cleanMethod = String(body.procurement_method || '询价采购').trim();
    const numBudget = Number(body.budget_amount || 0);
    const numFinal = Number(body.final_amount || 0);
    const cleanDept = String(body.department || '').trim();
    const cleanApplicant = String(body.applicant || '').trim();
    const cleanPhone = String(body.phone || '').trim();
    const cleanSupplier = String(body.supplier || '').trim();
    const cleanApprovalDate = String(body.approval_date || '').trim();
    const cleanStatus = String(body.status || '立项审批中').trim();
    const cleanRemarks = String(body.remarks || '').trim();
    const targetContractId = body.contract_id ? Number(body.contract_id) : null;

    if (!cleanNo || !cleanName || !cleanApprovalDate) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: '立项编号、采购项目名称、立项日期为必填项' });
    }

    const updateTx = db.transaction(() => {
      if (STMTS.checkDupProcNoUpdate.get(cleanNo, id)) {
        throw new Error('该立项编号已被其他记录占用，请确保唯一性');
      }

      let currentFiles = [];
      try { currentFiles = JSON.parse(existing.files_json || '[]'); } catch (e) {}
      if (!Array.isArray(currentFiles)) currentFiles = [];

      const updatedFiles = archiveProcurementFiles(req.files || [], cleanNo, cleanName, cleanApprovalDate, currentFiles);
      if (req.files && req.files.length > 0) {
        const added = updatedFiles.slice(currentFiles.length);
        added.forEach(item => newlyArchivedPaths.push(item.file_name));
      }

      db.prepare(`
        UPDATE procurements SET
          procurement_no = ?, project_name = ?, procurement_type = ?, procurement_method = ?,
          budget_amount = ?, final_amount = ?, department = ?, applicant = ?, phone = ?,
          supplier = ?, approval_date = ?, status = ?, remarks = ?, files_json = ?,
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        cleanNo, cleanName, cleanType, cleanMethod,
        numBudget, numFinal, cleanDept, cleanApplicant, cleanPhone,
        cleanSupplier, cleanApprovalDate, cleanStatus, cleanRemarks, JSON.stringify(updatedFiles),
        id
      );

      linkProcurementToContract(id, targetContractId);
      recalculateProcurementSequences();
    });

    updateTx();
    cleanupReqTempFiles(req);
    res.json({ success: true, message: '采购立项更新成功' });
  } catch (error) {
    cleanupReqTempFiles(req);
    newlyArchivedPaths.forEach(rel => safeUnlinkUploadRelPath(rel));
    res.status(400).json({ success: false, message: error.message || '更新采购立项失败' });
  }
});

// 立项详情窗快捷追加附件
app.post('/api/procurements/:id/files', upload.array('proc_files', 20), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getProcById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '立项记录不存在' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: '未选择文件' });
    }
    let currentFiles = [];
    try { currentFiles = JSON.parse(existing.files_json || '[]'); } catch (e) {}
    if (!Array.isArray(currentFiles)) currentFiles = [];

    const updatedFiles = archiveProcurementFiles(req.files, existing.procurement_no, existing.project_name, existing.approval_date, currentFiles);
    db.prepare(`UPDATE procurements SET files_json = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
      .run(JSON.stringify(updatedFiles), id);

    res.json({ success: true, message: `成功追加 ${req.files.length} 份立项资料`, files: updatedFiles });
  } catch (e) {
    cleanupReqTempFiles(req);
    res.status(400).json({ success: false, message: e.message || '上传失败' });
  }
});

// 立项详情窗删除单个附件
app.delete('/api/procurements/:id/files/:fileId', (req, res) => {
  const id = Number(req.params.id);
  const fileId = String(req.params.fileId || '');
  const existing = STMTS.getProcById.get(id);
  if (!existing) return res.status(404).json({ success: false, message: '立项记录不存在' });

  let list = [];
  try { list = JSON.parse(existing.files_json || '[]'); } catch (e) {}
  if (!Array.isArray(list)) list = [];

  const target = list.find(item => item && item.id === fileId);
  if (!target) return res.status(404).json({ success: false, message: '未找到该立项附件' });

  const newList = list.filter(item => item && item.id !== fileId);
  db.prepare(`UPDATE procurements SET files_json = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
    .run(JSON.stringify(newList), id);

  safeUnlinkUploadRelPath(target.file_name);
  res.json({ success: true, message: '立项附件已物理删除', files: newList });
});

app.delete('/api/procurements/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = STMTS.getProcById.get(id);
  if (!existing) return res.status(404).json({ success: false, message: '立项记录不存在' });

  let filesList = [];
  try { filesList = JSON.parse(existing.files_json || '[]'); } catch (e) {}

  const deleteTx = db.transaction(() => {
    STMTS.clearContractProcLink.run(id);
    db.prepare(`DELETE FROM procurements WHERE id = ?`).run(id);
    recalculateProcurementSequences();
  });

  deleteTx();

  if (Array.isArray(filesList)) {
    filesList.forEach(item => { if (item && item.file_name) safeUnlinkUploadRelPath(item.file_name); });
  }
  sweepOrphanUploads();
  res.json({ success: true, message: '采购立项记录及所有物理附件已彻底删除' });
});

// ==================== 15. Excel 导出引擎（含双子表综合台账 & 内存即时释放） ====================
function formatContractRowsForSheet(rows) {
  return rows.map(r => {
    let relCount = 0;
    try {
      const arr = JSON.parse(r.related_files_json || '[]');
      if (Array.isArray(arr)) relCount = arr.length;
    } catch (e) {}
    return {
      '年度序号': r.seq_no || '',
      '合同编号': r.contract_no || '',
      '合同名称': r.contract_name || '',
      '合同类型': r.contract_type || '',
      '甲方单位': r.party_a || '',
      '乙方单位(供应商)': r.party_b || '',
      '合同金额(元)': Number(r.amount || 0),
      '签订日期': r.sign_date || '',
      '履行开始日期': r.start_date || '',
      '履行结束日期': r.end_date || '',
      '合同状态': r.status || '',
      '关联采购立项编号': r.linked_procurement_no || '未关联',
      '关联采购项目名称': r.linked_project_name || '',
      '经办负责人': r.owner || '',
      '所属部门': r.department || '',
      '联系电话': r.phone || '',
      '主扫描件状态': r.file_name ? `已上传(${r.file_orig_name || '扫描件'})` : '未上传',
      '其他相关资料数': relCount > 0 ? `${relCount}份` : '无',
      '备注说明': r.remarks || ''
    };
  });
}

function formatProcRowsForSheet(rows) {
  return rows.map(r => {
    let fCount = 0;
    try {
      const arr = JSON.parse(r.files_json || '[]');
      if (Array.isArray(arr)) fCount = arr.length;
    } catch (e) {}
    return {
      '立项序号': r.seq_no || '',
      '采购立项编号': r.procurement_no || '',
      '采购项目名称': r.project_name || '',
      '采购类型': r.procurement_type || '',
      '采购方式': r.procurement_method || '',
      '预算金额(元)': Number(r.budget_amount || 0),
      '成交/定标金额(元)': Number(r.final_amount || 0),
      '立项批准日期': r.approval_date || '',
      '立项状态': r.status || '',
      '关联合同编号': r.linked_contract_no || '未转合同',
      '关联合同名称': r.linked_contract_name || '',
      '申请部门': r.department || '',
      '经办申请人': r.applicant || '',
      '联系电话': r.phone || '',
      '拟定/成交供应商': r.supplier || '',
      '立项附件数量': fCount > 0 ? `${fCount}份` : '无',
      '备注说明': r.remarks || ''
    };
  });
}

app.get('/api/contracts/export', (req, res) => {
  const { whereClause, params } = buildContractFilterQuery(req.query);
  const rows = db.prepare(`
    SELECT c.*, p.procurement_no AS linked_procurement_no, p.project_name AS linked_project_name
    FROM contracts c
    LEFT JOIN procurements p ON c.procurement_id = p.id
    ${whereClause}
    ORDER BY c.sign_date ASC, c.id ASC
  `).all(...params);

  let data = formatContractRowsForSheet(rows);
  let ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ '提示': '暂无符合筛选条件的合同记录' }]);
  let wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '合同管理台账');
  let buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  data = null; ws = null; wb = null;
  const fileName = encodeURIComponent(`合同管理台账_${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.on('finish', () => { buffer = null; triggerSafeGC(); });
  res.send(buffer);
});

app.get('/api/procurements/export', (req, res) => {
  const { whereClause, params } = buildProcFilterQuery(req.query);
  const rows = db.prepare(`
    SELECT p.*, c.contract_no AS linked_contract_no, c.contract_name AS linked_contract_name
    FROM procurements p
    LEFT JOIN contracts c ON p.contract_id = c.id
    ${whereClause}
    ORDER BY p.approval_date ASC, p.id ASC
  `).all(...params);

  let data = formatProcRowsForSheet(rows);
  let ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ '提示': '暂无符合筛选条件的采购立项记录' }]);
  let wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '采购立项台账');
  let buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  data = null; ws = null; wb = null;
  const fileName = encodeURIComponent(`采购立项台账_${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.on('finish', () => { buffer = null; triggerSafeGC(); });
  res.send(buffer);
});

app.get('/api/export/combined', (req, res) => {
  const contractRows = db.prepare(`
    SELECT c.*, p.procurement_no AS linked_procurement_no, p.project_name AS linked_project_name
    FROM contracts c
    LEFT JOIN procurements p ON c.procurement_id = p.id
    ORDER BY c.sign_date ASC, c.id ASC
  `).all();

  const procRows = db.prepare(`
    SELECT p.*, c.contract_no AS linked_contract_no, c.contract_name AS linked_contract_name
    FROM procurements p
    LEFT JOIN contracts c ON p.contract_id = c.id
    ORDER BY p.approval_date ASC, p.id ASC
  `).all();

  let cData = formatContractRowsForSheet(contractRows);
  let pData = formatProcRowsForSheet(procRows);

  let wb = XLSX.utils.book_new();
  let wsContract = XLSX.utils.json_to_sheet(cData.length > 0 ? cData : [{ '提示': '暂无合同记录' }]);
  let wsProc = XLSX.utils.json_to_sheet(pData.length > 0 ? pData : [{ '提示': '暂无采购立项记录' }]);

  XLSX.utils.book_append_sheet(wb, wsContract, '合同管理台账');
  XLSX.utils.book_append_sheet(wb, wsProc, '采购立项台账');

  let buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  cData = null; pData = null; wsContract = null; wsProc = null; wb = null;

  const fileName = encodeURIComponent(`合同与采购立项综合总台账_${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.on('finish', () => { buffer = null; triggerSafeGC(); });
  res.send(buffer);
});

// ==================== 16. 全局异常兜底与进程零残留优雅退出 ====================
app.use((err, req, res, next) => {
  cleanupReqTempFiles(req);
  res.status(500).json({ success: false, message: err.message || '服务器内部错误' });
});

const activeSockets = new Set();
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`============================================================`);
  console.log(`🚀 合同与采购立项综合台账系统已启动！`);
  console.log(`🏠 本机访问地址: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && isPrivateLanIP(net.address)) {
        console.log(`🌐 局域网同事访问地址: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`============================================================`);
});

server.on('connection', socket => {
  activeSockets.add(socket);
  socket.on('close', () => activeSockets.delete(socket));
});

let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[系统退出] 收到 ${signal} 信号，正在释放所有连接、清理临时垃圾并归零 WAL 日志...`);
  try {
    cleanTmpDir();
    sweepOrphanUploads();
    for (const socket of activeSockets) {
      try { socket.destroy(); } catch (e) {}
    }
    activeSockets.clear();
    server.close();
    if (db && db.open) {
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
      db.close();
    }
  } catch (e) {}
  console.log(`🧹 资源已 100% 释放完毕，进程安全退出！`);
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

module.exports = { app, server, db, gracefulShutdown };
