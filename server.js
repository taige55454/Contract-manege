/**
 * 企业合同与采购项目台账管理系统 - 核心后端服务 (v2.4.0 生产终极版)
 * 100% 匹配 main.js + test-smoke.js + 原版 public/index.html + public/app.js
 * 核心能力：
 * 1. 夹心式分段编号引擎（支持前缀 + 穿插自定义段 + 日期段 + 零空洞(Gap-Filling)流水号 + 后缀 + 并发撞号顺延）
 * 2. 顺序可逆的双向互锁引擎（无论先录采购预填合同号，还是先录合同后绑采购，均自动双向挂钩并穿透附件）
 * 3. 智能日期解析器（支持 Excel 序列号如 46099、点号 2026.3.18、斜杠、简写 3.18 自动转 YYYY-MM-DD）
 * 4. 合同到期状态自动流转引擎（基于本地时区零点：过期自动由“生效中”流转为“已到期”，续签延长自动恢复“生效中”，严格保护“草稿/已终止”等特殊状态）
 * 5. 自定义下拉选项与预设词库引擎（8大分类自由增删改、一键恢复默认、多机实时同步）
 * 6. 三大文件物理隔离归档 + 改名自动同步文件夹 + 孤儿文件清道夫 + 优雅退出零句柄残留
 * 7. 基于 xlsx-js-style 的专业双子表导出（黄金自适应列宽 + 隔行斑马纹 + 合同表 AE/AF/AG 三列超链接 + 采购表 R/S 两列超链接）
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const Database = require('better-sqlite3');
const multer = require('multer');
const XLSX = require('xlsx-js-style');

const app = express();
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const DEFAULT_HOST = process.env.HOST || '0.0.0.0';

// ==================== 1. 目录与环境变量初始化（100% 兼容 main.js 与 test-smoke.js） ====================
const ROOT_DIR = __dirname;
const DATA_ROOT = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : (process.env.CONTRACT_DATA_DIR ? path.resolve(process.env.CONTRACT_DATA_DIR) : ROOT_DIR);

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_ROOT, 'database.sqlite');

const UPLOAD_DIR = process.env.CONTRACT_UPLOAD_DIR
  ? path.resolve(process.env.CONTRACT_UPLOAD_DIR)
  : path.join(DATA_ROOT, 'uploads');

const TMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.tmp');
const RELATED_UPLOAD_DIR = path.join(UPLOAD_DIR, 'related');
const PROCUREMENT_UPLOAD_DIR = path.join(UPLOAD_DIR, 'procurement');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

for (const dir of [path.dirname(DB_PATH), UPLOAD_DIR, TMP_UPLOAD_DIR, RELATED_UPLOAD_DIR, PROCUREMENT_UPLOAD_DIR, PUBLIC_DIR]) {
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
    try { global.gc(); } catch (e) {}
  }
}

// 获取本地时区（如北京时间）的 YYYY-MM-DD 字符串，避免 UTC 时差导致早上 8 点前日期滞后一天
function getLocalTodayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ==================== 2. 智能日期解析引擎（支持 Excel 序列号 46099 与 2026.3.18） ====================
function normalizeSmartDate(rawInput, fallbackToday = false) {
  if (rawInput === null || rawInput === undefined) {
    return fallbackToday ? getLocalTodayStr() : '';
  }
  const str = String(rawInput).trim();
  if (!str) {
    return fallbackToday ? getLocalTodayStr() : '';
  }

  // 1. Excel 日期序列号（如 46099 -> 2026-03-18）
  if (/^\d{5}$/.test(str)) {
    const serial = parseInt(str, 10);
    if (serial >= 20000 && serial <= 80000) {
      const utcDays = serial - 25569;
      const utcValue = utcDays * 86400 * 1000;
      const d = new Date(utcValue);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
      }
    }
  }

  // 2. 纯 8 位数字 20260318
  if (/^\d{8}$/.test(str)) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  }

  // 3. YYYY-M-D, YYYY.M.D, YYYY/M/D, YYYY年M月D日
  const fullMatch = str.match(/^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/);
  if (fullMatch) {
    const yyyy = fullMatch[1];
    const mm = String(parseInt(fullMatch[2], 10)).padStart(2, '0');
    const dd = String(parseInt(fullMatch[3], 10)).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // 4. 简写 M.D 或 M-D 或 M/D（默认补当前年份）
  const shortMatch = str.match(/^(\d{1,2})[-./月](\d{1,2})日?$/);
  if (shortMatch) {
    const yyyy = new Date().getFullYear();
    const mm = String(parseInt(shortMatch[1], 10)).padStart(2, '0');
    const dd = String(parseInt(shortMatch[2], 10)).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  return str;
}

// ==================== 3. 数据库初始化与表结构创建 ====================
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_no TEXT NOT NULL DEFAULT '',
    contract_no TEXT NOT NULL UNIQUE,
    contract_name TEXT NOT NULL,
    contract_type TEXT NOT NULL DEFAULT '采购',
    status TEXT NOT NULL DEFAULT '生效中',
    our_entity TEXT NOT NULL DEFAULT '',
    sign_date TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL DEFAULT '',
    expiry_date TEXT NOT NULL DEFAULT '',
    counterparties_json TEXT NOT NULL DEFAULT '[]',
    total_amount REAL NOT NULL DEFAULT 0,
    attachment_path TEXT NOT NULL DEFAULT '',
    attachment_original_name TEXT NOT NULL DEFAULT '',
    attachment_size INTEGER NOT NULL DEFAULT 0,
    procurement_id INTEGER DEFAULT NULL,
    remark TEXT NOT NULL DEFAULT '',
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
    project_type TEXT NOT NULL DEFAULT '服务类项目',
    cost_department TEXT NOT NULL DEFAULT '',
    budget_amount REAL NOT NULL DEFAULT 0,
    budget_subject TEXT NOT NULL DEFAULT '',
    procurement_type TEXT NOT NULL DEFAULT '小额零星采购',
    procurement_method TEXT NOT NULL DEFAULT '合作谈判',
    approval_date TEXT NOT NULL DEFAULT '',
    decision_date TEXT NOT NULL DEFAULT '',
    completion_date TEXT NOT NULL DEFAULT '',
    supplier_name TEXT NOT NULL DEFAULT '',
    deal_amount REAL NOT NULL DEFAULT 0,
    has_contract TEXT NOT NULL DEFAULT '否',
    contract_id INTEGER DEFAULT NULL,
    contract_no_manual TEXT NOT NULL DEFAULT '',
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

  CREATE INDEX IF NOT EXISTS idx_contracts_sign_date ON contracts(sign_date ASC, id ASC);
  CREATE INDEX IF NOT EXISTS idx_contracts_no ON contracts(contract_no);
  CREATE INDEX IF NOT EXISTS idx_contracts_proc_id ON contracts(procurement_id);
  CREATE INDEX IF NOT EXISTS idx_procurements_date ON procurements(approval_date ASC, id ASC);
  CREATE INDEX IF NOT EXISTS idx_procurements_no ON procurements(procurement_no);
  CREATE INDEX IF NOT EXISTS idx_procurements_cid ON procurements(contract_id);
  CREATE INDEX IF NOT EXISTS idx_procurements_cno_manual ON procurements(contract_no_manual);
`);

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
  getContractByNo: db.prepare(`SELECT * FROM contracts WHERE contract_no = ?`),
  checkDupContractNoCreate: db.prepare(`SELECT id FROM contracts WHERE contract_no = ?`),
  checkDupContractNoUpdate: db.prepare(`SELECT id FROM contracts WHERE contract_no = ? AND id != ?`),
  getRelatedFilesByCid: db.prepare(`SELECT * FROM contract_files WHERE contract_id = ? ORDER BY id ASC`),
  getRelatedFileById: db.prepare(`SELECT * FROM contract_files WHERE id = ? AND contract_id = ?`),
  insertRelatedFile: db.prepare(`
    INSERT INTO contract_files (contract_id, file_path, file_original_name, file_size, uploaded_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  deleteRelatedFileById: db.prepare(`DELETE FROM contract_files WHERE id = ?`),

  getProcurementById: db.prepare(`SELECT * FROM procurements WHERE id = ?`),
  getProcurementByNo: db.prepare(`SELECT * FROM procurements WHERE procurement_no = ?`),
  checkDupProcNoCreate: db.prepare(`SELECT id FROM procurements WHERE procurement_no = ?`),
  checkDupProcNoUpdate: db.prepare(`SELECT id FROM procurements WHERE procurement_no = ? AND id != ?`),
  getProcFilesByPid: db.prepare(`SELECT * FROM procurement_files WHERE procurement_id = ? ORDER BY id ASC`),
  getProcFileById: db.prepare(`SELECT * FROM procurement_files WHERE id = ? AND procurement_id = ?`),
  insertProcFile: db.prepare(`
    INSERT INTO procurement_files (procurement_id, file_category, file_path, file_original_name, file_size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  deleteProcFileById: db.prepare(`DELETE FROM procurement_files WHERE id = ?`),

  autoExpireContracts: db.prepare(`
    UPDATE contracts
    SET status = '已到期', updated_at = datetime('now', 'localtime')
    WHERE status = '生效中'
      AND expiry_date != ''
      AND expiry_date < ?
  `)
};

/**
 * 合同到期状态自动流转引擎：
 * 1. 自动扫描数据库中所有 status = '生效中' 且 expiry_date < 今天(本地时区) 的合同，将其批量更新为 '已到期'
 * 2. 严格保护 '草稿'、'已终止'、'已解除' 等非生效状态，绝不误改
 */
function autoRefreshExpiredContractStatus() {
  try {
    const today = getLocalTodayStr();
    STMTS.autoExpireContracts.run(today);
  } catch (e) {}
}

/**
 * 录入或编辑合同时，根据到期日智能校准合同状态：
 * - 若到期日已过（expiryDate < today）且状态选的是 '生效中' -> 自动转为 '已到期'
 * - 若续签/延长了到期日（expiryDate >= today）且原状态是 '已到期' -> 自动恢复为 '生效中'
 */
function computeSmartContractStatus(rawStatus, expiryDateStr) {
  const status = String(rawStatus || '生效中').trim();
  const exp = String(expiryDateStr || '').trim();
  if (!exp || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return status;

  const today = getLocalTodayStr();
  if (exp < today && status === '生效中') {
    return '已到期';
  }
  if (exp >= today && status === '已到期') {
    return '生效中';
  }
  return status;
}

// ==================== 4. 夹心式编号引擎与自定义下拉预设引擎 ====================
const DEFAULT_CONTRACT_RULE = {
  prefix: 'XSZY-黔-BJ-',
  default_mid: '',
  date_part: 'YYYYMM',
  seq_digits: 3,
  suffix: '',
  reset_yearly: true
};

const DEFAULT_PROC_RULE = {
  prefix: 'LX',
  default_mid: '',
  date_part: 'YYYYMMDD',
  seq_digits: 3,
  suffix: '',
  reset_yearly: true
};

// 100% 匹配原版 index.html 的默认下拉预设词库
const DEFAULT_DROPDOWN_PRESETS = {
  contract_types: ['采购', '服务', '销售', '框架', '其他'],
  contract_statuses: ['草稿', '生效中', '已到期', '已终止'],
  project_types: ['服务类项目', '货物类项目', '设备采购', '工程类项目', '其他'],
  cost_departments: ['综合管理部', '省区费用预算', '市场营销部', '运营管理部', '财务部', '毕节自营店'],
  procurement_types: ['小额零星采购', '二级集中采购', '一级集中采购', '分散采购', '其他'],
  procurement_methods: ['合作谈判', '邀请竞争谈判', '公开竞争谈判', '邀请询比', '公开询比', '单一来源采购'],
  budget_subjects: ['办公费', '运输费', '其他固定资产采购', '日常安全费用', '其他外包项目', '租赁费', '中介费', '装修费', '其他福利费'],
  invoice_types: ['增值税专用发票', '增值税普通发票', '数电专票', '数电普票']
};

function normalizePresetArray(input, fallbackArr) {
  let rawList = [];
  if (Array.isArray(input)) {
    rawList = input;
  } else if (typeof input === 'string') {
    rawList = input.split(/[\r\n,，、;；]+/);
  }
  const cleaned = [];
  const seen = new Set();
  for (const item of rawList) {
    const s = String(item || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      cleaned.push(s);
    }
  }
  return cleaned.length > 0 ? cleaned : [...fallbackArr];
}

function getDropdownPresets() {
  try {
    const row = STMTS.getSetting.get('dropdown_presets');
    if (row && row.setting_value) {
      const parsed = JSON.parse(row.setting_value);
      const result = {};
      for (const key of Object.keys(DEFAULT_DROPDOWN_PRESETS)) {
        result[key] = normalizePresetArray(parsed[key], DEFAULT_DROPDOWN_PRESETS[key]);
      }
      return result;
    }
  } catch (e) {}
  const copy = {};
  for (const key of Object.keys(DEFAULT_DROPDOWN_PRESETS)) {
    copy[key] = [...DEFAULT_DROPDOWN_PRESETS[key]];
  }
  return copy;
}

function getContractNoRule() {
  try {
    const row = STMTS.getSetting.get('contract_no_rule');
    if (row && row.setting_value) {
      const p = JSON.parse(row.setting_value);
      return {
        prefix: typeof p.prefix === 'string' ? p.prefix : DEFAULT_CONTRACT_RULE.prefix,
        default_mid: typeof p.default_mid === 'string' ? p.default_mid : '',
        date_part: p.date_part || p.date_format || DEFAULT_CONTRACT_RULE.date_part,
        seq_digits: Number.isInteger(Number(p.seq_digits)) ? Number(p.seq_digits) : 3,
        suffix: typeof p.suffix === 'string' ? p.suffix : '',
        reset_yearly: p.reset_yearly !== undefined ? Boolean(p.reset_yearly) : true
      };
    }
  } catch (e) {}
  return { ...DEFAULT_CONTRACT_RULE };
}

function getProcNoRule() {
  try {
    const row = STMTS.getSetting.get('procurement_no_rule');
    if (row && row.setting_value) {
      const p = JSON.parse(row.setting_value);
      return {
        prefix: typeof p.prefix === 'string' ? p.prefix : DEFAULT_PROC_RULE.prefix,
        default_mid: typeof p.default_mid === 'string' ? p.default_mid : '',
        date_part: p.date_part || p.date_format || DEFAULT_PROC_RULE.date_part,
        seq_digits: Number.isInteger(Number(p.seq_digits)) ? Number(p.seq_digits) : 3,
        suffix: typeof p.suffix === 'string' ? p.suffix : '',
        reset_yearly: p.reset_yearly !== undefined ? Boolean(p.reset_yearly) : true
      };
    }
  } catch (e) {}
  return { ...DEFAULT_PROC_RULE };
}

function getDefaultOurEntity() {
  const row = STMTS.getSetting.get('default_our_entity');
  return row && row.setting_value ? row.setting_value : '毕节自营公司';
}

function formatDateSegment(fmt, rawDateStr) {
  const norm = normalizeSmartDate(rawDateStr, true);
  const match = norm.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const yyyy = match ? match[1] : String(new Date().getFullYear());
  const mm = match ? match[2] : String(new Date().getMonth() + 1).padStart(2, '0');
  const dd = match ? match[3] : String(new Date().getDate()).padStart(2, '0');

  switch (fmt) {
    case 'YYYY': return `${yyyy}`;
    case 'YYYY-': return `${yyyy}-`;
    case 'YYYYMM': return `${yyyy}${mm}`;
    case 'YYYYMM-': return `${yyyy}${mm}-`;
    case 'YYYYMMDD': return `${yyyy}${mm}${dd}`;
    case 'YYYYMMDD-': return `${yyyy}${mm}${dd}-`;
    case 'NONE': return '';
    default: return `${yyyy}${mm}`;
  }
}

/**
 * 零空洞（Gap-Filling）流水号查找器：
 * 查找当前前缀+穿插段+日期段下，第一个未被占用的正整数（1, 2, 3...）
 * 删掉中间记录自动补空缺；取消录入不占号；全满自动顺延！
 */
function findSmallestMissingSeq(rows, colName, matchStart, suffix) {
  const used = new Set();
  const sfx = suffix || '';
  for (const r of rows) {
    const val = String(r[colName] || '').trim();
    if (val.startsWith(matchStart) && (!sfx || val.endsWith(sfx))) {
      const midCore = val.slice(matchStart.length, sfx ? val.length - sfx.length : undefined);
      if (/^\d+$/.test(midCore)) {
        const n = parseInt(midCore, 10);
        if (n > 0) used.add(n);
      }
    }
  }
  let seq = 1;
  while (used.has(seq)) {
    seq++;
  }
  return seq;
}

function buildNextContractNo(rule, signDateStr, customMidParam) {
  const prefix = rule.prefix || '';
  const mid = customMidParam !== undefined ? String(customMidParam).trim() : (rule.default_mid || '');
  const dateStr = formatDateSegment(rule.date_part, signDateStr);
  const suffix = rule.suffix || '';
  const digits = Number(rule.seq_digits ?? 3);

  if (digits <= 0) {
    const full = `${prefix}${mid}${dateStr}${suffix}`;
    return {
      prefix,
      mid_custom: mid,
      date_part: dateStr,
      seq_part: '',
      suffix,
      next_no: full,
      full_no: full
    };
  }

  const matchStart = `${prefix}${mid}${dateStr}`;
  const rows = db.prepare(`SELECT contract_no FROM contracts WHERE contract_no LIKE ?`).all(`${matchStart}%`);
  const nextNum = findSmallestMissingSeq(rows, 'contract_no', matchStart, suffix);
  const seqStr = String(nextNum).padStart(digits, '0');
  const full = `${matchStart}${seqStr}${suffix}`;

  return {
    prefix,
    mid_custom: mid,
    date_part: dateStr,
    seq_part: seqStr,
    suffix,
    next_no: full,
    full_no: full
  };
}

function buildNextProcNo(rule, approvalDateStr, customMidParam) {
  const prefix = rule.prefix || '';
  const mid = customMidParam !== undefined ? String(customMidParam).trim() : (rule.default_mid || '');
  const dateStr = formatDateSegment(rule.date_part, approvalDateStr);
  const suffix = rule.suffix || '';
  const digits = Number(rule.seq_digits ?? 3);

  if (digits <= 0) {
    const full = `${prefix}${mid}${dateStr}${suffix}`;
    return {
      prefix,
      mid_custom: mid,
      date_part: dateStr,
      seq_part: '',
      suffix,
      next_no: full,
      full_no: full
    };
  }

  const matchStart = `${prefix}${mid}${dateStr}`;
  const rows = db.prepare(`SELECT procurement_no FROM procurements WHERE procurement_no LIKE ?`).all(`${matchStart}%`);
  const nextNum = findSmallestMissingSeq(rows, 'procurement_no', matchStart, suffix);
  const seqStr = String(nextNum).padStart(digits, '0');
  const full = `${matchStart}${seqStr}${suffix}`;

  return {
    prefix,
    mid_custom: mid,
    date_part: dateStr,
    seq_part: seqStr,
    suffix,
    next_no: full,
    full_no: full
  };
}

function resolveConflictNo(conflictNo, tableType) {
  const isContract = tableType === 'contract';
  const rule = isContract ? getContractNoRule() : getProcNoRule();
  const sfx = rule.suffix || '';
  const body = sfx && conflictNo.endsWith(sfx) ? conflictNo.slice(0, conflictNo.length - sfx.length) : conflictNo;
  const match = body.match(/^(.*?)(\d+)$/);
  if (!match) return null;

  const matchStart = match[1];
  const digitsLen = Math.max(Number(rule.seq_digits || 3), match[2].length);
  const col = isContract ? 'contract_no' : 'procurement_no';
  const table = isContract ? 'contracts' : 'procurements';
  const rows = db.prepare(`SELECT ${col} FROM ${table} WHERE ${col} LIKE ?`).all(`${matchStart}%`);
  const nextNum = findSmallestMissingSeq(rows, col, matchStart, sfx);
  return `${matchStart}${String(nextNum).padStart(digitsLen, '0')}${sfx}`;
}

const recalculateContractSeqNos = db.transaction(() => {
  const rule = getContractNoRule();
  const rows = db.prepare(`
    SELECT id, seq_no, sign_date
    FROM contracts
    ORDER BY
      CASE WHEN sign_date IS NULL OR sign_date = '' THEN 1 ELSE 0 END ASC,
      sign_date ASC,
      id ASC
  `).all();

  const updateStmt = db.prepare(`UPDATE contracts SET seq_no = ? WHERE id = ?`);
  const counters = {};
  let globalCounter = 0;

  for (const r of rows) {
    let expected;
    if (rule.reset_yearly) {
      const ym = String(r.sign_date || '').match(/^(\d{4})/);
      const y = ym ? ym[1] : String(new Date().getFullYear());
      counters[y] = (counters[y] || 0) + 1;
      expected = `${y}-${String(counters[y]).padStart(3, '0')}`;
    } else {
      globalCounter++;
      expected = String(globalCounter).padStart(3, '0');
    }
    if (r.seq_no !== expected) {
      updateStmt.run(expected, r.id);
    }
  }
});

const recalculateProcSeqNos = db.transaction(() => {
  const rule = getProcNoRule();
  const rows = db.prepare(`
    SELECT id, seq_no, approval_date
    FROM procurements
    ORDER BY
      CASE WHEN approval_date IS NULL OR approval_date = '' THEN 1 ELSE 0 END ASC,
      approval_date ASC,
      id ASC
  `).all();

  const updateStmt = db.prepare(`UPDATE procurements SET seq_no = ? WHERE id = ?`);
  const counters = {};
  let globalCounter = 0;

  for (const r of rows) {
    let expected;
    if (rule.reset_yearly) {
      const ym = String(r.approval_date || '').match(/^(\d{4})/);
      const y = ym ? ym[1] : String(new Date().getFullYear());
      counters[y] = (counters[y] || 0) + 1;
      expected = String(counters[y]);
    } else {
      globalCounter++;
      expected = String(globalCounter);
    }
    if (r.seq_no !== expected) {
      updateStmt.run(expected, r.id);
    }
  }
});

recalculateContractSeqNos();
recalculateProcSeqNos();
autoRefreshExpiredContractStatus();

// ==================== 5. 顺序可逆的双向互锁引擎 ====================
function syncBidirectionalLinkFromContract(contractId, contractNo, explicitProcId) {
  const cid = Number(contractId);
  let targetProcId = explicitProcId ? Number(explicitProcId) : null;

  // 若未显式指定 procurement_id，自动检测是否有采购立项预先填写了相同的 contract_no_manual
  if (!targetProcId && contractNo) {
    const matchedProc = db.prepare(`
      SELECT id FROM procurements
      WHERE TRIM(contract_no_manual) = ? AND (contract_id IS NULL OR contract_id = ?)
      ORDER BY id DESC LIMIT 1
    `).get(contractNo, cid);
    if (matchedProc) {
      targetProcId = matchedProc.id;
    }
  }

  // 解绑旧立项
  db.prepare(`
    UPDATE procurements
    SET contract_id = NULL, updated_at = datetime('now', 'localtime')
    WHERE contract_id = ? AND id != COALESCE(?, -1)
  `).run(cid, targetProcId);

  if (targetProcId) {
    const proc = STMTS.getProcurementById.get(targetProcId);
    if (proc) {
      if (proc.contract_id && proc.contract_id !== cid) {
        db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(proc.contract_id);
      }
      db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(targetProcId, cid);
      db.prepare(`
        UPDATE procurements
        SET contract_id = ?, has_contract = '是', contract_no_manual = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(cid, contractNo, targetProcId);
      return;
    }
  }
  db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(cid);
}

function syncBidirectionalLinkFromProcurement(procId, explicitContractId, manualContractNo) {
  const pid = Number(procId);
  let targetContractId = explicitContractId ? Number(explicitContractId) : null;
  const cleanManualNo = String(manualContractNo || '').trim();

  // 若未显式选择 contract_id，但填了 contract_no_manual，自动查找是否已有对应合同
  if (!targetContractId && cleanManualNo) {
    const matchedContract = STMTS.getContractByNo.get(cleanManualNo);
    if (matchedContract) {
      targetContractId = matchedContract.id;
    }
  }

  // 解绑旧合同
  db.prepare(`
    UPDATE contracts
    SET procurement_id = NULL, updated_at = datetime('now', 'localtime')
    WHERE procurement_id = ? AND id != COALESCE(?, -1)
  `).run(pid, targetContractId);

  if (targetContractId) {
    const c = STMTS.getContractById.get(targetContractId);
    if (c) {
      if (c.procurement_id && c.procurement_id !== pid) {
        db.prepare(`UPDATE procurements SET contract_id = NULL WHERE id = ?`).run(c.procurement_id);
      }
      db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(pid, targetContractId);
      db.prepare(`
        UPDATE procurements
        SET contract_id = ?, has_contract = '是', contract_no_manual = ?
        WHERE id = ?
      `).run(targetContractId, c.contract_no, pid);
      return;
    }
  }
  db.prepare(`UPDATE procurements SET contract_id = NULL WHERE id = ?`).run(pid);
}

// ==================== 6. 三大文件物理归档、改名同步与零残留清道夫引擎 ====================
function sanitizeSegment(str, maxLen = 60) {
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
    if (/[\u4e00-\u9fa5]/.test(decoded) || !decoded.includes('\ufffd')) {
      return decoded;
    }
  } catch (e) {}
  return rawName;
}

function buildFolderKey(noStr, nameStr) {
  return `${sanitizeSegment(noStr, 50)}_${sanitizeSegment(nameStr, 60)}`;
}

function deletePhysicalFile(relFromUploads) {
  if (!relFromUploads) return;
  try {
    const abs = path.join(UPLOAD_DIR, relFromUploads);
    if (isSafePathWithin(abs, UPLOAD_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      fs.unlinkSync(abs);
    }
  } catch (e) {}
}

function removeEmptySubdirIfClean(absSubDir, baseParentDir) {
  if (!absSubDir || !isSafePathWithin(absSubDir, baseParentDir)) return;
  try {
    if (fs.existsSync(absSubDir) && fs.statSync(absSubDir).isDirectory()) {
      if (fs.readdirSync(absSubDir).length === 0) {
        fs.rmdirSync(absSubDir);
      }
    }
  } catch (e) {}
}

function archiveMainContractAttachment(tempFile, contractNo, contractName) {
  if (!tempFile || !tempFile.path || !fs.existsSync(tempFile.path)) return null;
  const origName = decodeOriginalFilename(tempFile.originalname);
  const ext = (path.extname(origName) || '.pdf').toLowerCase();
  const base = `${sanitizeSegment(contractNo, 50)}_${sanitizeSegment(contractName, 60)}`;

  let finalName = `${base}${ext}`;
  let idx = 1;
  while (fs.existsSync(path.join(UPLOAD_DIR, finalName))) {
    finalName = `${base}(${idx})${ext}`;
    idx++;
  }
  const destAbs = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(tempFile.path, destAbs);
  return {
    attachment_path: finalName,
    attachment_original_name: origName,
    attachment_size: tempFile.size || fs.statSync(destAbs).size
  };
}

function archiveContractRelatedFiles(contractId, contractNo, contractName, files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const folder = buildFolderKey(contractNo, contractName);
  const targetDir = path.join(RELATED_UPLOAD_DIR, folder);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const saved = [];
  for (const f of files) {
    if (!f || !f.path || !fs.existsSync(f.path)) continue;
    const origName = decodeOriginalFilename(f.originalname);
    const ext = path.extname(origName);
    const base = sanitizeSegment(path.basename(origName, ext), 80);

    let fname = `${base}${ext}`;
    let idx = 1;
    while (fs.existsSync(path.join(targetDir, fname))) {
      fname = `${base}(${idx})${ext}`;
      idx++;
    }
    const destAbs = path.join(targetDir, fname);
    fs.renameSync(f.path, destAbs);
    const relPath = path.posix.join('related', folder, fname);
    saved.push(relPath);
    STMTS.insertRelatedFile.run(contractId, relPath, origName, f.size || fs.statSync(destAbs).size, nowStr);
  }
  return saved;
}

function archiveProcurementFiles(procId, procNo, projectName, files, category = '立项资料') {
  if (!Array.isArray(files) || files.length === 0) return [];
  const folder = buildFolderKey(procNo, projectName);
  const targetDir = path.join(PROCUREMENT_UPLOAD_DIR, folder);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const saved = [];
  for (const f of files) {
    if (!f || !f.path || !fs.existsSync(f.path)) continue;
    const origName = decodeOriginalFilename(f.originalname);
    const ext = path.extname(origName);
    const base = sanitizeSegment(path.basename(origName, ext), 80);

    let fname = `${base}${ext}`;
    let idx = 1;
    while (fs.existsSync(path.join(targetDir, fname))) {
      fname = `${base}(${idx})${ext}`;
      idx++;
    }
    const destAbs = path.join(targetDir, fname);
    fs.renameSync(f.path, destAbs);
    const relPath = path.posix.join('procurement', folder, fname);
    saved.push(relPath);
    STMTS.insertProcFile.run(procId, category, relPath, origName, f.size || fs.statSync(destAbs).size, nowStr);
  }
  return saved;
}

// 当修改合同编号或合同名称时，自动同步重命名主扫描件与 related 专属文件夹
function syncContractFilesOnRename(contractId, oldNo, oldName, newNo, newName, currentAttachmentPath) {
  let finalAttachmentPath = currentAttachmentPath || '';
  if (oldNo === newNo && oldName === newName) return finalAttachmentPath;

  if (finalAttachmentPath) {
    const oldMainAbs = path.join(UPLOAD_DIR, finalAttachmentPath);
    if (isSafePathWithin(oldMainAbs, UPLOAD_DIR) && fs.existsSync(oldMainAbs)) {
      const ext = path.extname(finalAttachmentPath) || '.pdf';
      const base = `${sanitizeSegment(newNo, 50)}_${sanitizeSegment(newName, 60)}`;
      let targetName = `${base}${ext}`;
      let idx = 1;
      while (fs.existsSync(path.join(UPLOAD_DIR, targetName)) && targetName !== finalAttachmentPath) {
        targetName = `${base}(${idx})${ext}`;
        idx++;
      }
      try {
        fs.renameSync(oldMainAbs, path.join(UPLOAD_DIR, targetName));
        finalAttachmentPath = targetName;
      } catch (e) {}
    }
  }

  const oldFolder = buildFolderKey(oldNo, oldName);
  const newFolder = buildFolderKey(newNo, newName);
  if (oldFolder !== newFolder) {
    const oldDirAbs = path.join(RELATED_UPLOAD_DIR, oldFolder);
    const newDirAbs = path.join(RELATED_UPLOAD_DIR, newFolder);
    if (isSafePathWithin(oldDirAbs, RELATED_UPLOAD_DIR) && fs.existsSync(oldDirAbs)) {
      try {
        if (!fs.existsSync(newDirAbs)) {
          fs.renameSync(oldDirAbs, newDirAbs);
        } else {
          for (const f of fs.readdirSync(oldDirAbs)) {
            fs.renameSync(path.join(oldDirAbs, f), path.join(newDirAbs, f));
          }
          removeEmptySubdirIfClean(oldDirAbs, RELATED_UPLOAD_DIR);
        }
        const relFiles = STMTS.getRelatedFilesByCid.all(contractId);
        const updStmt = db.prepare(`UPDATE contract_files SET file_path = ? WHERE id = ?`);
        for (const rf of relFiles) {
          const fname = path.posix.basename(rf.file_path.replace(/\\/g, '/'));
          updStmt.run(path.posix.join('related', newFolder, fname), rf.id);
        }
      } catch (e) {}
    }
  }
  return finalAttachmentPath;
}

// 当修改采购立项编号或项目名称时，自动同步重命名 procurement 专属文件夹
function syncProcurementFilesOnRename(procId, oldNo, oldName, newNo, newName) {
  const oldFolder = buildFolderKey(oldNo, oldName);
  const newFolder = buildFolderKey(newNo, newName);
  if (oldFolder === newFolder) return;

  const oldDirAbs = path.join(PROCUREMENT_UPLOAD_DIR, oldFolder);
  const newDirAbs = path.join(PROCUREMENT_UPLOAD_DIR, newFolder);
  if (isSafePathWithin(oldDirAbs, PROCUREMENT_UPLOAD_DIR) && fs.existsSync(oldDirAbs)) {
    try {
      if (!fs.existsSync(newDirAbs)) {
        fs.renameSync(oldDirAbs, newDirAbs);
      } else {
        for (const f of fs.readdirSync(oldDirAbs)) {
          fs.renameSync(path.join(oldDirAbs, f), path.join(newDirAbs, f));
        }
        removeEmptySubdirIfClean(oldDirAbs, PROCUREMENT_UPLOAD_DIR);
      }
      const pFiles = STMTS.getProcFilesByPid.all(procId);
      const updStmt = db.prepare(`UPDATE procurement_files SET file_path = ? WHERE id = ?`);
      for (const pf of pFiles) {
        const fname = path.posix.basename(pf.file_path.replace(/\\/g, '/'));
        updStmt.run(path.posix.join('procurement', newFolder, fname), pf.id);
      }
    } catch (e) {}
  }
}

function cleanupReqTempFiles(req) {
  if (!req) return;
  const list = [];
  if (req.file && req.file.path) list.push(req.file.path);
  if (Array.isArray(req.files)) {
    for (const f of req.files) if (f && f.path) list.push(f.path);
  } else if (req.files && typeof req.files === 'object') {
    for (const k of Object.keys(req.files)) {
      for (const f of (req.files[k] || [])) {
        if (f && f.path) list.push(f.path);
      }
    }
  }
  for (const p of list) {
    try {
      if (isSafePathWithin(p, TMP_UPLOAD_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
  }
}

function cleanTmpDir() {
  try {
    if (!fs.existsSync(TMP_UPLOAD_DIR)) return;
    for (const item of fs.readdirSync(TMP_UPLOAD_DIR)) {
      const fp = path.join(TMP_UPLOAD_DIR, item);
      if (isSafePathWithin(fp, TMP_UPLOAD_DIR)) {
        try { fs.unlinkSync(fp); } catch (e) {}
      }
    }
  } catch (e) {}
}

// 孤儿文件与空目录清道夫（确保磁盘与 SQLite 记录 100% 对齐，零垃圾残留）
function sweepOrphanUploads() {
  try {
    if (!db || !db.open) return;
    const validMain = new Set(
      db.prepare(`SELECT attachment_path FROM contracts WHERE attachment_path != ''`).all().map(r => r.attachment_path)
    );
    for (const item of fs.readdirSync(UPLOAD_DIR)) {
      if (item === '.tmp' || item === 'related' || item === 'procurement' || item.startsWith('.')) continue;
      const abs = path.join(UPLOAD_DIR, item);
      try {
        if (fs.statSync(abs).isFile() && !validMain.has(item)) fs.unlinkSync(abs);
      } catch (e) {}
    }

    const validRel = new Set(
      db.prepare(`SELECT file_path FROM contract_files`).all().map(r => r.file_path.replace(/\\/g, '/'))
    );
    if (fs.existsSync(RELATED_UPLOAD_DIR)) {
      for (const sub of fs.readdirSync(RELATED_UPLOAD_DIR)) {
        const subAbs = path.join(RELATED_UPLOAD_DIR, sub);
        try {
          if (!fs.statSync(subAbs).isDirectory()) continue;
          for (const f of fs.readdirSync(subAbs)) {
            const relKey = path.posix.join('related', sub, f);
            const fAbs = path.join(subAbs, f);
            if (!validRel.has(relKey) && isSafePathWithin(fAbs, RELATED_UPLOAD_DIR)) {
              try { fs.unlinkSync(fAbs); } catch (e) {}
            }
          }
          removeEmptySubdirIfClean(subAbs, RELATED_UPLOAD_DIR);
        } catch (e) {}
      }
    }

    const validProc = new Set(
      db.prepare(`SELECT file_path FROM procurement_files`).all().map(r => r.file_path.replace(/\\/g, '/'))
    );
    if (fs.existsSync(PROCUREMENT_UPLOAD_DIR)) {
      for (const sub of fs.readdirSync(PROCUREMENT_UPLOAD_DIR)) {
        const subAbs = path.join(PROCUREMENT_UPLOAD_DIR, sub);
        try {
          if (!fs.statSync(subAbs).isDirectory()) continue;
          for (const f of fs.readdirSync(subAbs)) {
            const relKey = path.posix.join('procurement', sub, f);
            const fAbs = path.join(subAbs, f);
            if (!validProc.has(relKey) && isSafePathWithin(fAbs, PROCUREMENT_UPLOAD_DIR)) {
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

// ==================== 7. Multer 上传配置 ====================
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
  limits: { fileSize: 50 * 1024 * 1024, files: 30 }
});

// ==================== 8. 中间件与内网访问安全口令控制 ====================
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const SECRET_SEED = crypto.randomBytes(32).toString('hex');

function getLanSecurityConfig() {
  try {
    const row = STMTS.getSetting.get('lan_security_config');
    if (row && row.setting_value) {
      return JSON.parse(row.setting_value);
    }
  } catch (e) {}
  return { enabled: true, passcode: '' };
}

function isLocalhostRequest(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function makeLanToken(passcode) {
  return crypto.createHmac('sha256', SECRET_SEED).update(String(passcode || '')).digest('hex');
}

function isRequestAuthorized(req) {
  if (isLocalhostRequest(req)) return true;
  const cfg = getLanSecurityConfig();
  if (!cfg.enabled) return false;
  if (!cfg.passcode) return true;
  const expected = makeLanToken(cfg.passcode);
  const clientToken = String(req.headers['x-lan-token'] || req.headers['x-access-token'] || req.query.token || '').trim();
  return clientToken === expected;
}

app.use(express.static(PUBLIC_DIR));

app.get(['/api/lan-auth/status', '/api/auth/status'], (req, res) => {
  const cfg = getLanSecurityConfig();
  const isLocal = isLocalhostRequest(req);
  const authed = isRequestAuthorized(req);
  const interfaces = os.networkInterfaces();
  const lanUrls = [];
  const currentPort = serverInstance && serverInstance.port ? serverInstance.port : DEFAULT_PORT;

  for (const name of Object.keys(interfaces)) {
    if (/vmware|virtualbox|vbox|hyper-v|wsl|docker|vethernet|loopback/i.test(name)) continue;
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        lanUrls.push(`http://${net.address}:${currentPort}`);
      }
    }
  }

  res.json({
    success: true,
    is_localhost: isLocal,
    enabled: cfg.enabled,
    locked: Boolean(cfg.passcode) && !isLocal,
    authorized: authed,
    passcode: isLocal ? cfg.passcode : undefined,
    port: currentPort,
    lan_urls: lanUrls
  });
});

app.post(['/api/lan-auth/login', '/api/auth/verify'], (req, res) => {
  const cfg = getLanSecurityConfig();
  if (!cfg.enabled && !isLocalhostRequest(req)) {
    return res.status(403).json({ success: false, message: '主机管理员已关闭内网访问权限' });
  }
  const code = String(req.body.passcode || req.body.access_code || req.body.code || '').trim();
  if (cfg.passcode && code !== cfg.passcode) {
    return res.status(401).json({ success: false, message: '内网访问口令错误，请核对后重试' });
  }
  res.json({
    success: true,
    token: cfg.passcode ? makeLanToken(cfg.passcode) : '',
    message: '口令验证成功'
  });
});

app.post(['/api/lan-auth/config', '/api/auth/set-code'], (req, res) => {
  const enabled = req.body.enabled !== undefined ? Boolean(req.body.enabled) : true;
  const passcode = String(req.body.passcode ?? req.body.new_code ?? '').trim();
  const newCfg = { enabled, passcode };
  STMTS.setSetting.run('lan_security_config', JSON.stringify(newCfg));
  res.json({
    success: true,
    enabled,
    passcode,
    token: passcode ? makeLanToken(passcode) : '',
    message: '内网安全设置已保存'
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    if (!isRequestAuthorized(req)) {
      return res.status(401).json({ success: false, locked: true, message: '需要验证内网访问口令' });
    }
  }
  next();
});

app.use('/uploads', (req, res) => {
  const decodedRel = decodeURIComponent(req.path || '').replace(/^\/+/, '');
  if (!decodedRel || decodedRel.startsWith('.tmp')) {
    return res.status(403).send('Forbidden');
  }
  const absFile = path.join(UPLOAD_DIR, decodedRel);
  if (!isSafePathWithin(absFile, UPLOAD_DIR) || !fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    return res.status(404).send('文件不存在或已被移除');
  }
  if (req.query.download === '1') {
    const dlName = req.query.filename ? path.basename(String(req.query.filename)) : path.basename(absFile);
    return res.download(absFile, dlName);
  }
  res.sendFile(absFile);
});

// ==================== 9. 编号规则、默认主体、下拉预设与夹心取号 API ====================
app.get(['/api/settings/our-entity', '/api/settings/default-entity'], (req, res) => {
  res.json({ success: true, our_entity: getDefaultOurEntity() });
});

app.post(['/api/settings/our-entity', '/api/settings/default-entity'], (req, res) => {
  const entity = String(req.body.our_entity || '').trim() || '毕节自营公司';
  STMTS.setSetting.run('default_our_entity', entity);
  res.json({ success: true, our_entity: entity, message: '默认我方签约主体已更新' });
});

app.get('/api/settings/presets', (req, res) => {
  res.json({
    success: true,
    presets: getDropdownPresets(),
    defaults: DEFAULT_DROPDOWN_PRESETS
  });
});

app.post('/api/settings/presets', (req, res) => {
  try {
    if (req.body && req.body.reset_defaults) {
      STMTS.setSetting.run('dropdown_presets', JSON.stringify(DEFAULT_DROPDOWN_PRESETS));
      return res.json({
        success: true,
        presets: getDropdownPresets(),
        message: '已恢复默认下拉选项预设'
      });
    }
    const current = getDropdownPresets();
    const incoming = req.body.presets || req.body || {};
    const updated = {};
    for (const key of Object.keys(DEFAULT_DROPDOWN_PRESETS)) {
      updated[key] = incoming[key] !== undefined
        ? normalizePresetArray(incoming[key], DEFAULT_DROPDOWN_PRESETS[key])
        : current[key];
    }
    STMTS.setSetting.run('dropdown_presets', JSON.stringify(updated));
    res.json({
      success: true,
      presets: updated,
      message: '下拉选项与预设词库已保存'
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || '保存预设失败' });
  }
});

app.get(['/api/settings/no-rule', '/api/settings/contract-no-rule'], (req, res) => {
  const rule = getContractNoRule();
  const preview = buildNextContractNo(rule, req.query.sign_date, req.query.mid_custom);
  res.json({
    success: true,
    rule,
    next_no: preview.next_no,
    next_contract_no: preview.next_no,
    preview_parts: preview
  });
});

app.post(['/api/settings/no-rule', '/api/settings/contract-no-rule'], (req, res) => {
  const current = getContractNoRule();
  const newRule = {
    prefix: String(req.body.prefix ?? current.prefix).trim(),
    default_mid: String(req.body.default_mid ?? current.default_mid).trim(),
    date_part: String(req.body.date_part || req.body.date_format || current.date_part),
    seq_digits: Number.isInteger(Number(req.body.seq_digits)) ? Number(req.body.seq_digits) : 3,
    suffix: String(req.body.suffix ?? current.suffix).trim(),
    reset_yearly: req.body.reset_yearly !== undefined ? Boolean(req.body.reset_yearly) : true
  };
  STMTS.setSetting.run('contract_no_rule', JSON.stringify(newRule));
  recalculateContractSeqNos();
  const preview = buildNextContractNo(newRule);
  res.json({
    success: true,
    rule: newRule,
    next_no: preview.next_no,
    next_contract_no: preview.next_no,
    preview_parts: preview,
    message: '合同编号规则已保存'
  });
});

app.get('/api/contracts/next-no', (req, res) => {
  const rule = getContractNoRule();
  const signDate = req.query.sign_date || getLocalTodayStr();
  const midCustom = req.query.mid_custom !== undefined ? req.query.mid_custom : rule.default_mid;
  const parts = buildNextContractNo(rule, signDate, midCustom);
  res.json({
    success: true,
    rule,
    ...parts
  });
});

app.get(['/api/settings/proc-no-rule', '/api/settings/procurement-no-rule'], (req, res) => {
  const rule = getProcNoRule();
  const preview = buildNextProcNo(rule, req.query.approval_date, req.query.mid_custom);
  res.json({
    success: true,
    rule,
    next_no: preview.next_no,
    next_procurement_no: preview.next_no,
    preview_parts: preview
  });
});

app.post(['/api/settings/proc-no-rule', '/api/settings/procurement-no-rule'], (req, res) => {
  const current = getProcNoRule();
  const newRule = {
    prefix: String(req.body.prefix ?? current.prefix).trim(),
    default_mid: String(req.body.default_mid ?? current.default_mid).trim(),
    date_part: String(req.body.date_part || req.body.date_format || current.date_part),
    seq_digits: Number.isInteger(Number(req.body.seq_digits)) ? Number(req.body.seq_digits) : 3,
    suffix: String(req.body.suffix ?? current.suffix).trim(),
    reset_yearly: req.body.reset_yearly !== undefined ? Boolean(req.body.reset_yearly) : true
  };
  STMTS.setSetting.run('procurement_no_rule', JSON.stringify(newRule));
  recalculateProcSeqNos();
  const preview = buildNextProcNo(newRule);
  res.json({
    success: true,
    rule: newRule,
    next_no: preview.next_no,
    next_procurement_no: preview.next_no,
    preview_parts: preview,
    message: '采购立项编号规则已保存'
  });
});

app.get('/api/procurements/next-no', (req, res) => {
  const rule = getProcNoRule();
  const approvalDate = req.query.approval_date || getLocalTodayStr();
  const midCustom = req.query.mid_custom !== undefined ? req.query.mid_custom : rule.default_mid;
  const parts = buildNextProcNo(rule, approvalDate, midCustom);
  res.json({
    success: true,
    rule,
    ...parts
  });
});

// ==================== 10. 合同与采购详情组装器（跨模块附件穿透） ====================
function parseCounterparties(jsonStr, fallbackRow = {}) {
  let list = [];
  try {
    list = JSON.parse(jsonStr || '[]');
  } catch (e) {
    list = [];
  }
  if (!Array.isArray(list) || list.length === 0) {
    list = [{
      company_name: fallbackRow.party_b || '',
      credit_code: '',
      contact_person: '',
      contact_phone: '',
      bank_account_name: '',
      bank_account_no: '',
      bank_name: '',
      summary: fallbackRow.remark || '',
      amount: Number(fallbackRow.total_amount || 0),
      amount_excl_tax: Number(fallbackRow.total_amount || 0),
      tax_rate: '',
      invoice_type: '',
      currency: 'CNY',
      perf_bond_amount: 0,
      perf_bond_status: '无',
      perf_bond_return_date: '',
      warranty_bond_amount: 0,
      warranty_bond_status: '无',
      warranty_bond_expiry_date: '',
      remark: ''
    }];
  }
  return list.map(item => {
    const amount = Number(item.amount ?? 0);
    const taxRateNum = parseFloat(String(item.tax_rate ?? '').replace('%', ''));
    let excl = Number(item.amount_excl_tax ?? 0);
    if (!excl && amount > 0 && !isNaN(taxRateNum) && taxRateNum >= 0) {
      excl = Number((amount / (1 + taxRateNum / 100)).toFixed(2));
    } else if (!excl && amount > 0) {
      excl = amount;
    }
    return {
      company_name: String(item.company_name || '').trim(),
      credit_code: String(item.credit_code || '').trim(),
      contact_person: String(item.contact_person || '').trim(),
      contact_phone: String(item.contact_phone || '').trim(),
      bank_account_name: String(item.bank_account_name || '').trim(),
      bank_account_no: String(item.bank_account_no || '').trim(),
      bank_name: String(item.bank_name || '').trim(),
      summary: String(item.summary || '').trim(),
      amount,
      amount_excl_tax: excl,
      tax_rate: String(item.tax_rate ?? '').trim(),
      invoice_type: String(item.invoice_type || '增值税专用发票').trim(),
      currency: String(item.currency || 'CNY').trim(),
      perf_bond_amount: Number(item.perf_bond_amount || 0),
      perf_bond_status: String(item.perf_bond_status || '无').trim(),
      perf_bond_return_date: normalizeSmartDate(item.perf_bond_return_date || ''),
      warranty_bond_amount: Number(item.warranty_bond_amount || 0),
      warranty_bond_status: String(item.warranty_bond_status || '无').trim(),
      warranty_bond_expiry_date: normalizeSmartDate(item.warranty_bond_expiry_date || ''),
      remark: String(item.remark || '').trim()
    };
  });
}

function enrichContractRecord(row) {
  if (!row) return null;
  const counterparties = parseCounterparties(row.counterparties_json, row);
  const relatedFiles = STMTS.getRelatedFilesByCid.all(row.id);

  let linkedProcurement = null;
  if (row.procurement_id) {
    const pRow = STMTS.getProcurementById.get(row.procurement_id);
    if (pRow) {
      const pFiles = STMTS.getProcFilesByPid.all(pRow.id);
      linkedProcurement = {
        ...pRow,
        files: pFiles,
        folder_rel_path: `uploads/procurement/${buildFolderKey(pRow.procurement_no, pRow.project_name)}`
      };
    }
  }

  return {
    ...row,
    counterparties,
    related_files: relatedFiles,
    related_folder_rel_path: `uploads/related/${buildFolderKey(row.contract_no, row.contract_name)}`,
    linked_procurement: linkedProcurement
  };
}

function enrichProcurementRecord(row) {
  if (!row) return null;
  const files = STMTS.getProcFilesByPid.all(row.id);
  let linkedContract = null;
  if (row.contract_id) {
    const cRow = STMTS.getContractById.get(row.contract_id);
    if (cRow) {
      linkedContract = {
        ...cRow,
        related_files: STMTS.getRelatedFilesByCid.all(cRow.id)
      };
    }
  }
  return {
    ...row,
    files,
    folder_rel_path: `uploads/procurement/${buildFolderKey(row.procurement_no, row.project_name)}`,
    linked_contract: linkedContract
  };
}

// ==================== 11. 合同台账 CRUD 路由 ====================
function queryFilteredContracts(query = {}) {
  // 每次查询或导出前，自动将已过期的“生效中”合同刷新为“已到期”
  autoRefreshExpiredContractStatus();

  const rows = db.prepare(`SELECT * FROM contracts`).all();
  let list = rows.map(r => enrichContractRecord(r));

  const kwNo = String(query.keyword || query.no || '').trim().toLowerCase();
  const kwCp = String(query.counterparty || '').trim().toLowerCase();
  const year = String(query.year || '').trim();
  const cType = String(query.contract_type || query.type || '').trim();
  const status = String(query.status || '').trim();
  const dateField = String(query.date_field || 'sign_date').trim();
  const dateFrom = normalizeSmartDate(query.date_from || query.start_date || '');
  const dateTo = normalizeSmartDate(query.date_to || query.end_date || '');

  list = list.filter(c => {
    if (kwNo) {
      const hitBase = [c.seq_no, c.contract_no, c.contract_name, c.remark, c.linked_procurement?.procurement_no]
        .some(v => String(v || '').toLowerCase().includes(kwNo));
      const hitSummary = c.counterparties.some(cp => String(cp.summary || '').toLowerCase().includes(kwNo));
      if (!hitBase && !hitSummary) return false;
    }
    if (kwCp) {
      const hitOur = String(c.our_entity || '').toLowerCase().includes(kwCp);
      const hitParty = c.counterparties.some(cp =>
        String(cp.company_name || '').toLowerCase().includes(kwCp) ||
        String(cp.credit_code || '').toLowerCase().includes(kwCp)
      );
      if (!hitOur && !hitParty) return false;
    }
    if (year && !String(c.sign_date || '').startsWith(year)) return false;
    if (cType && c.contract_type !== cType) return false;
    if (status && c.status !== status) return false;

    if (dateFrom || dateTo) {
      let targetDates = [];
      if (['sign_date', 'start_date', 'expiry_date'].includes(dateField)) {
        targetDates = [c[dateField] || ''];
      } else {
        targetDates = c.counterparties.map(cp => cp[dateField] || '').filter(Boolean);
      }
      if (targetDates.length === 0) return false;
      const matchDate = targetDates.some(d => {
        if (!d) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
        return true;
      });
      if (!matchDate) return false;
    }
    return true;
  });

  const sortBy = String(query.sort_by || 'seq_no');
  const sortOrder = String(query.sort_order || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;

  list.sort((a, b) => {
    let va = a[sortBy] ?? a.sign_date ?? '';
    let vb = b[sortBy] ?? b.sign_date ?? '';
    if (sortBy === 'perf_bond_return_date' || sortBy === 'warranty_bond_expiry_date') {
      va = a.counterparties.map(cp => cp[sortBy] || '9999-99-99').sort()[0] || '9999-99-99';
      vb = b.counterparties.map(cp => cp[sortBy] || '9999-99-99').sort()[0] || '9999-99-99';
    }
    if (va < vb) return -1 * sortOrder;
    if (va > vb) return 1 * sortOrder;
    return (a.id - b.id) * sortOrder;
  });

  return list;
}

app.get('/api/contracts', (req, res) => {
  const list = queryFilteredContracts(req.query);
  res.json({ success: true, data: list });
});

app.get('/api/contracts/:id', (req, res) => {
  autoRefreshExpiredContractStatus();
  const row = STMTS.getContractById.get(Number(req.params.id));
  if (!row) return res.status(404).json({ success: false, message: '合同不存在' });
  res.json({ success: true, data: enrichContractRecord(row) });
});

const contractUploadMiddleware = upload.fields([
  { name: 'attachment', maxCount: 1 },
  { name: 'scan_file', maxCount: 1 },
  { name: 'related_files', maxCount: 25 }
]);

app.post('/api/contracts', contractUploadMiddleware, (req, res) => {
  let savedMainFile = '';
  let savedRelatedFiles = [];

  try {
    let finalNo = String(req.body.contract_no || '').trim();
    const contractName = String(req.body.contract_name || '').trim();
    const contractType = String(req.body.contract_type || '采购').trim();
    const rawStatus = String(req.body.status || '生效中').trim();
    const ourEntity = String(req.body.our_entity || req.body.party_a || getDefaultOurEntity()).trim();
    const signDate = normalizeSmartDate(req.body.sign_date, true);
    const startDate = normalizeSmartDate(req.body.start_date || signDate);
    const expiryDate = normalizeSmartDate(req.body.expiry_date || req.body.end_date || '');
    const status = computeSmartContractStatus(rawStatus, expiryDate);
    const explicitProcId = req.body.procurement_id ? Number(req.body.procurement_id) : null;
    const remark = String(req.body.remark || '').trim();

    if (!finalNo || !contractName) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: '合同编号与合同名称为必填项' });
    }

    const counterparties = parseCounterparties(req.body.counterparties_json, {
      party_b: req.body.party_b,
      total_amount: req.body.amount,
      remark
    });
    const totalAmount = counterparties.reduce((sum, item) => sum + Number(item.amount || 0), 0);

    const mainFileObj = (req.files?.attachment && req.files.attachment[0]) || (req.files?.scan_file && req.files.scan_file[0]) || null;
    const relatedFileObjs = req.files?.related_files || [];

    let autoAdjustedMsg = '';

    const createTx = db.transaction(() => {
      if (STMTS.checkDupContractNoCreate.get(finalNo)) {
        const resolved = resolveConflictNo(finalNo, 'contract');
        if (resolved && !STMTS.checkDupContractNoCreate.get(resolved)) {
          finalNo = resolved;
          autoAdjustedMsg = `（原编号已被占用，已自动顺延为 ${finalNo}）`;
        } else {
          throw new Error(`合同编号 ${finalNo} 已存在`);
        }
      }

      let attMeta = { attachment_path: '', attachment_original_name: '', attachment_size: 0 };
      if (mainFileObj) {
        attMeta = archiveMainContractAttachment(mainFileObj, finalNo, contractName) || attMeta;
        if (attMeta.attachment_path) savedMainFile = attMeta.attachment_path;
      }

      const info = db.prepare(`
        INSERT INTO contracts (
          seq_no, contract_no, contract_name, contract_type, status,
          our_entity, sign_date, start_date, expiry_date,
          counterparties_json, total_amount,
          attachment_path, attachment_original_name, attachment_size,
          procurement_id, remark
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '', finalNo, contractName, contractType, status,
        ourEntity, signDate, startDate, expiryDate,
        JSON.stringify(counterparties), totalAmount,
        attMeta.attachment_path, attMeta.attachment_original_name, attMeta.attachment_size,
        explicitProcId, remark
      );

      const newId = Number(info.lastInsertRowid);
      syncBidirectionalLinkFromContract(newId, finalNo, explicitProcId);

      if (relatedFileObjs.length > 0) {
        savedRelatedFiles = archiveContractRelatedFiles(newId, finalNo, contractName, relatedFileObjs);
      }

      recalculateContractSeqNos();
      return newId;
    });

    const newContractId = createTx();
    cleanupReqTempFiles(req);
    const detail = enrichContractRecord(STMTS.getContractById.get(newContractId));
    res.json({
      success: true,
      id: newContractId,
      message: '合同保存成功' + autoAdjustedMsg,
      data: detail
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    if (savedMainFile) deletePhysicalFile(savedMainFile);
    for (const rp of savedRelatedFiles) deletePhysicalFile(rp);
    res.status(400).json({ success: false, message: err.message || '新增合同失败' });
  }
});

app.put('/api/contracts/:id', contractUploadMiddleware, (req, res) => {
  let savedMainFile = '';
  let savedRelatedFiles = [];

  try {
    const id = Number(req.params.id);
    const existing = STMTS.getContractById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }

    const finalNo = String(req.body.contract_no || existing.contract_no).trim();
    const contractName = String(req.body.contract_name || existing.contract_name).trim();
    const contractType = String(req.body.contract_type || existing.contract_type).trim();
    const rawStatus = String(req.body.status || existing.status).trim();
    const ourEntity = String(req.body.our_entity || existing.our_entity).trim();
    const signDate = normalizeSmartDate(req.body.sign_date || existing.sign_date, true);
    const startDate = normalizeSmartDate(req.body.start_date || existing.start_date);
    const expiryDate = normalizeSmartDate(req.body.expiry_date !== undefined ? req.body.expiry_date : existing.expiry_date);
    const status = computeSmartContractStatus(rawStatus, expiryDate);
    const explicitProcId = req.body.procurement_id !== undefined
      ? (req.body.procurement_id ? Number(req.body.procurement_id) : null)
      : existing.procurement_id;
    const remark = String(req.body.remark ?? existing.remark).trim();

    const counterparties = req.body.counterparties_json
      ? parseCounterparties(req.body.counterparties_json)
      : parseCounterparties(existing.counterparties_json);
    const totalAmount = counterparties.reduce((sum, item) => sum + Number(item.amount || 0), 0);

    const mainFileObj = (req.files?.attachment && req.files.attachment[0]) || (req.files?.scan_file && req.files.scan_file[0]) || null;
    const relatedFileObjs = req.files?.related_files || [];
    let oldMainToDelete = '';

    const updateTx = db.transaction(() => {
      if (STMTS.checkDupContractNoUpdate.get(finalNo, id)) {
        throw new Error(`合同编号 ${finalNo} 已被其他记录占用`);
      }

      const syncedOldAttachmentPath = syncContractFilesOnRename(
        id,
        existing.contract_no,
        existing.contract_name,
        finalNo,
        contractName,
        existing.attachment_path
      );

      let attMeta = {
        attachment_path: syncedOldAttachmentPath,
        attachment_original_name: existing.attachment_original_name,
        attachment_size: existing.attachment_size
      };

      if (mainFileObj) {
        if (syncedOldAttachmentPath) oldMainToDelete = syncedOldAttachmentPath;
        attMeta = archiveMainContractAttachment(mainFileObj, finalNo, contractName) || attMeta;
        if (attMeta.attachment_path) savedMainFile = attMeta.attachment_path;
      }

      db.prepare(`
        UPDATE contracts SET
          contract_no = ?, contract_name = ?, contract_type = ?, status = ?,
          our_entity = ?, sign_date = ?, start_date = ?, expiry_date = ?,
          counterparties_json = ?, total_amount = ?,
          attachment_path = ?, attachment_original_name = ?, attachment_size = ?,
          procurement_id = ?, remark = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        finalNo, contractName, contractType, status,
        ourEntity, signDate, startDate, expiryDate,
        JSON.stringify(counterparties), totalAmount,
        attMeta.attachment_path, attMeta.attachment_original_name, attMeta.attachment_size,
        explicitProcId, remark, id
      );

      syncBidirectionalLinkFromContract(id, finalNo, explicitProcId);

      if (relatedFileObjs.length > 0) {
        savedRelatedFiles = archiveContractRelatedFiles(id, finalNo, contractName, relatedFileObjs);
      }

      recalculateContractSeqNos();
    });

    updateTx();
    if (oldMainToDelete) deletePhysicalFile(oldMainToDelete);
    cleanupReqTempFiles(req);
    res.json({
      success: true,
      id,
      message: '合同更新成功',
      data: enrichContractRecord(STMTS.getContractById.get(id))
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    if (savedMainFile) deletePhysicalFile(savedMainFile);
    for (const rp of savedRelatedFiles) deletePhysicalFile(rp);
    res.status(400).json({ success: false, message: err.message || '更新合同失败' });
  }
});

// 详情弹窗内直接补传/替换主合同扫描件
app.post('/api/contracts/:id/attachment', upload.single('attachment'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getContractById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: '未选择文件' });
    }
    if (existing.attachment_path) {
      deletePhysicalFile(existing.attachment_path);
    }
    const meta = archiveMainContractAttachment(req.file, existing.contract_no, existing.contract_name);
    db.prepare(`
      UPDATE contracts
      SET attachment_path = ?, attachment_original_name = ?, attachment_size = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(meta.attachment_path, meta.attachment_original_name, meta.attachment_size, id);

    cleanupReqTempFiles(req);
    res.json({
      success: true,
      message: '主合同扫描件上传成功',
      data: enrichContractRecord(STMTS.getContractById.get(id))
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/contracts/:id/related-files', upload.array('related_files', 25), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getContractById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    archiveContractRelatedFiles(id, existing.contract_no, existing.contract_name, req.files || []);
    cleanupReqTempFiles(req);
    res.json({
      success: true,
      message: '关联资料上传成功',
      data: enrichContractRecord(STMTS.getContractById.get(id))
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/contracts/:id/related-files/:fileId', (req, res) => {
  const cid = Number(req.params.id);
  const fid = Number(req.params.fileId);
  const fRec = STMTS.getRelatedFileById.get(fid, cid);
  if (!fRec) return res.status(404).json({ success: false, message: '文件不存在' });

  const parentDir = path.dirname(path.join(UPLOAD_DIR, fRec.file_path));
  STMTS.deleteRelatedFileById.run(fid);
  deletePhysicalFile(fRec.file_path);
  removeEmptySubdirIfClean(parentDir, RELATED_UPLOAD_DIR);

  res.json({
    success: true,
    message: '附件已删除',
    data: enrichContractRecord(STMTS.getContractById.get(cid))
  });
});

app.delete('/api/contracts/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = STMTS.getContractById.get(id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });
  const relFiles = STMTS.getRelatedFilesByCid.all(id);

  db.transaction(() => {
    syncBidirectionalLinkFromContract(id, '', null);
    db.prepare(`DELETE FROM contracts WHERE id = ?`).run(id);
    recalculateContractSeqNos();
  })();

  if (existing.attachment_path) deletePhysicalFile(existing.attachment_path);
  const dirs = new Set();
  for (const rf of relFiles) {
    dirs.add(path.dirname(path.join(UPLOAD_DIR, rf.file_path)));
    deletePhysicalFile(rf.file_path);
  }
  for (const d of dirs) removeEmptySubdirIfClean(d, RELATED_UPLOAD_DIR);

  res.json({ success: true, message: '合同及关联附件已彻底删除' });
});

// ==================== 12. 采购项目立项台账 CRUD 路由 ====================
function queryFilteredProcurements(query = {}) {
  const rows = db.prepare(`SELECT * FROM procurements`).all();
  let list = rows.map(r => enrichProcurementRecord(r));

  const kw = String(query.keyword || query.kw || '').trim().toLowerCase();
  const year = String(query.year || '').trim();
  const pType = String(query.project_type || query.type || '').trim();
  const dept = String(query.cost_department || query.dept || '').trim().toLowerCase();
  const hasContract = String(query.has_contract || '').trim();

  list = list.filter(p => {
    if (kw) {
      const hit = [
        p.seq_no, p.procurement_no, p.project_name, p.supplier_name,
        p.budget_subject, p.contract_no_manual, p.linked_contract?.contract_no, p.remark
      ].some(v => String(v || '').toLowerCase().includes(kw));
      if (!hit) return false;
    }
    if (year && !String(p.approval_date || '').startsWith(year)) return false;
    if (pType && p.project_type !== pType) return false;
    if (dept && !String(p.cost_department || '').toLowerCase().includes(dept)) return false;
    if (hasContract && p.has_contract !== hasContract) return false;
    return true;
  });

  const sortOrder = String(query.sort_order || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
  list.sort((a, b) => {
    const da = a.approval_date || '';
    const dbDate = b.approval_date || '';
    if (da < dbDate) return -1 * sortOrder;
    if (da > dbDate) return 1 * sortOrder;
    return (a.id - b.id) * sortOrder;
  });

  return list;
}

app.get('/api/procurements', (req, res) => {
  const list = queryFilteredProcurements(req.query);
  res.json({ success: true, data: list });
});

app.get('/api/procurements/:id', (req, res) => {
  const row = STMTS.getProcurementById.get(Number(req.params.id));
  if (!row) return res.status(404).json({ success: false, message: '采购立项不存在' });
  res.json({ success: true, data: enrichProcurementRecord(row) });
});

const procUploadMiddleware = upload.fields([
  { name: 'procurement_files', maxCount: 25 },
  { name: 'proc_files', maxCount: 25 }
]);

app.post('/api/procurements', procUploadMiddleware, (req, res) => {
  let savedFiles = [];

  try {
    let finalProcNo = String(req.body.procurement_no || '').trim();
    const projectName = String(req.body.project_name || '').trim();
    const projectType = String(req.body.project_type || '服务类项目').trim();
    const costDepartment = String(req.body.cost_department || req.body.department || '').trim();
    const budgetAmount = Number(req.body.budget_amount || 0);
    const budgetSubject = String(req.body.budget_subject || '').trim();
    const procurementType = String(req.body.procurement_type || '小额零星采购').trim();
    const procurementMethod = String(req.body.procurement_method || '合作谈判').trim();
    const approvalDate = normalizeSmartDate(req.body.approval_date, true);
    const decisionDate = normalizeSmartDate(req.body.decision_date || '');
    const completionDate = normalizeSmartDate(req.body.completion_date || '');
    const supplierName = String(req.body.supplier_name || '').trim();
    const dealAmount = Number(req.body.deal_amount ?? req.body.final_amount ?? 0);
    const explicitContractId = req.body.contract_id ? Number(req.body.contract_id) : null;
    const contractNoManual = String(req.body.contract_no_manual || '').trim();
    const hasContract = (explicitContractId || req.body.has_contract === '是') ? '是' : '否';
    const remark = String(req.body.remark || '').trim();

    if (!finalProcNo || !projectName) {
      cleanupReqTempFiles(req);
      return res.status(400).json({ success: false, message: '采购立项编号与项目名称为必填项' });
    }

    const uploadedFiles = [
      ...(req.files?.procurement_files || []),
      ...(req.files?.proc_files || [])
    ];

    let autoAdjustedMsg = '';

    const createTx = db.transaction(() => {
      if (STMTS.checkDupProcNoCreate.get(finalProcNo)) {
        const resolved = resolveConflictNo(finalProcNo, 'procurement');
        if (resolved && !STMTS.checkDupProcNoCreate.get(resolved)) {
          finalProcNo = resolved;
          autoAdjustedMsg = `（原编号已被占用，已自动顺延为 ${finalProcNo}）`;
        } else {
          throw new Error(`采购立项编号 ${finalProcNo} 已存在`);
        }
      }

      const info = db.prepare(`
        INSERT INTO procurements (
          seq_no, procurement_no, project_name, project_type, cost_department,
          budget_amount, budget_subject, procurement_type, procurement_method,
          approval_date, decision_date, completion_date,
          supplier_name, deal_amount, has_contract,
          contract_id, contract_no_manual, remark
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '', finalProcNo, projectName, projectType, costDepartment,
        budgetAmount, budgetSubject, procurementType, procurementMethod,
        approvalDate, decisionDate, completionDate,
        supplierName, dealAmount, hasContract,
        explicitContractId, contractNoManual, remark
      );

      const newProcId = Number(info.lastInsertRowid);
      syncBidirectionalLinkFromProcurement(newProcId, explicitContractId, contractNoManual);

      if (uploadedFiles.length > 0) {
        savedFiles = archiveProcurementFiles(newProcId, finalProcNo, projectName, uploadedFiles);
      }

      recalculateProcSeqNos();
      return newProcId;
    });

    const newId = createTx();
    cleanupReqTempFiles(req);
    res.json({
      success: true,
      id: newId,
      message: '采购立项保存成功' + autoAdjustedMsg,
      data: enrichProcurementRecord(STMTS.getProcurementById.get(newId))
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    for (const fp of savedFiles) deletePhysicalFile(fp);
    res.status(400).json({ success: false, message: err.message || '保存采购立项失败' });
  }
});

app.put('/api/procurements/:id', procUploadMiddleware, (req, res) => {
  let savedFiles = [];

  try {
    const id = Number(req.params.id);
    const existing = STMTS.getProcurementById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '采购立项不存在' });
    }

    const finalProcNo = String(req.body.procurement_no || existing.procurement_no).trim();
    const projectName = String(req.body.project_name || existing.project_name).trim();
    const projectType = String(req.body.project_type || existing.project_type).trim();
    const costDepartment = String(req.body.cost_department ?? existing.cost_department).trim();
    const budgetAmount = Number(req.body.budget_amount ?? existing.budget_amount);
    const budgetSubject = String(req.body.budget_subject ?? existing.budget_subject).trim();
    const procurementType = String(req.body.procurement_type || existing.procurement_type).trim();
    const procurementMethod = String(req.body.procurement_method || existing.procurement_method).trim();
    const approvalDate = normalizeSmartDate(req.body.approval_date || existing.approval_date, true);
    const decisionDate = normalizeSmartDate(req.body.decision_date ?? existing.decision_date);
    const completionDate = normalizeSmartDate(req.body.completion_date ?? existing.completion_date);
    const supplierName = String(req.body.supplier_name ?? existing.supplier_name).trim();
    const dealAmount = Number(req.body.deal_amount ?? existing.deal_amount);
    const explicitContractId = req.body.contract_id !== undefined
      ? (req.body.contract_id ? Number(req.body.contract_id) : null)
      : existing.contract_id;
    const contractNoManual = String(req.body.contract_no_manual ?? existing.contract_no_manual).trim();
    const hasContract = String(req.body.has_contract || (explicitContractId ? '是' : existing.has_contract)).trim();
    const remark = String(req.body.remark ?? existing.remark).trim();

    const uploadedFiles = [
      ...(req.files?.procurement_files || []),
      ...(req.files?.proc_files || [])
    ];

    const updateTx = db.transaction(() => {
      if (STMTS.checkDupProcNoUpdate.get(finalProcNo, id)) {
        throw new Error(`采购立项编号 ${finalProcNo} 已被占用`);
      }

      syncProcurementFilesOnRename(
        id,
        existing.procurement_no,
        existing.project_name,
        finalProcNo,
        projectName
      );

      db.prepare(`
        UPDATE procurements SET
          procurement_no = ?, project_name = ?, project_type = ?, cost_department = ?,
          budget_amount = ?, budget_subject = ?, procurement_type = ?, procurement_method = ?,
          approval_date = ?, decision_date = ?, completion_date = ?,
          supplier_name = ?, deal_amount = ?, has_contract = ?,
          contract_id = ?, contract_no_manual = ?, remark = ?,
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        finalProcNo, projectName, projectType, costDepartment,
        budgetAmount, budgetSubject, procurementType, procurementMethod,
        approvalDate, decisionDate, completionDate,
        supplierName, dealAmount, hasContract,
        explicitContractId, contractNoManual, remark, id
      );

      syncBidirectionalLinkFromProcurement(id, explicitContractId, contractNoManual);

      if (uploadedFiles.length > 0) {
        savedFiles = archiveProcurementFiles(id, finalProcNo, projectName, uploadedFiles);
      }

      recalculateProcSeqNos();
    });

    updateTx();
    cleanupReqTempFiles(req);
    res.json({
      success: true,
      id,
      message: '采购立项更新成功',
      data: enrichProcurementRecord(STMTS.getProcurementById.get(id))
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    for (const fp of savedFiles) deletePhysicalFile(fp);
    res.status(400).json({ success: false, message: err.message || '更新立项失败' });
  }
});

app.post('/api/procurements/:id/files', procUploadMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = STMTS.getProcurementById.get(id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '采购立项不存在' });
    }
    const files = [
      ...(req.files?.procurement_files || []),
      ...(req.files?.proc_files || [])
    ];
    archiveProcurementFiles(id, existing.procurement_no, existing.project_name, files);
    cleanupReqTempFiles(req);
    res.json({
      success: true,
      message: '立项资料上传成功',
      data: enrichProcurementRecord(STMTS.getProcurementById.get(id))
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/procurements/:id/files/:fileId', (req, res) => {
  const pid = Number(req.params.id);
  const fid = Number(req.params.fileId);
  const fRec = STMTS.getProcFileById.get(fid, pid);
  if (!fRec) return res.status(404).json({ success: false, message: '资料不存在' });

  const parentDir = path.dirname(path.join(UPLOAD_DIR, fRec.file_path));
  STMTS.deleteProcFileById.run(fid);
  deletePhysicalFile(fRec.file_path);
  removeEmptySubdirIfClean(parentDir, PROCUREMENT_UPLOAD_DIR);

  res.json({
    success: true,
    message: '立项资料已删除',
    data: enrichProcurementRecord(STMTS.getProcurementById.get(pid))
  });
});

app.delete('/api/procurements/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = STMTS.getProcurementById.get(id);
  if (!existing) return res.status(404).json({ success: false, message: '采购立项不存在' });
  const files = STMTS.getProcFilesByPid.all(id);

  db.transaction(() => {
    syncBidirectionalLinkFromProcurement(id, null, '');
    db.prepare(`DELETE FROM procurements WHERE id = ?`).run(id);
    recalculateProcSeqNos();
  })();

  const dirs = new Set();
  for (const pf of files) {
    dirs.add(path.dirname(path.join(UPLOAD_DIR, pf.file_path)));
    deletePhysicalFile(pf.file_path);
  }
  for (const d of dirs) removeEmptySubdirIfClean(d, PROCUREMENT_UPLOAD_DIR);

  res.json({ success: true, message: '采购立项及关联资料已彻底删除' });
});

// ==================== 13. 基于 xlsx-js-style 的专业双子表导出引擎（黄金列宽 + 100% 匹配 test-smoke.js 断言） ====================
function createContractWorksheet(contracts) {
  const headers = [
    '序号', '合同编号', '合同名称', '合同类型', '我方签约主体',
    '签订日期', '开始履约日', '合同到期日', '合同状态', '关联采购立项号',
    '履约摘要', '对方单位名称', '统一社会信用代码', '联系人', '联系电话',
    '收款账户名称', '收款银行账号', '开户银行', '含税金额(元)', '不含税金额(元)',
    '税率(%)', '发票类型', '币种', '履约保证金(元)', '保证金状态',
    '保证金应退日', '质保金(元)', '质保金状态', '质保金到期日', '分项备注',
    '① 合同扫描件(超链接)', '② 采购立项资料夹(超链接)', '③ 合同其他附件夹(超链接)'
  ];

  const aoa = [
    ['企业合同管理台账明细表'],
    headers
  ];

  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }
  ];

  let currentRowIdx = 2; // Row 3 (0-based 2)，对应 AE3, AF3, AG3
  const rowGroupParity = [];
  const formulaCells = [];

  contracts.forEach((c, cIdx) => {
    const parties = c.counterparties && c.counterparties.length > 0 ? c.counterparties : [{}];
    const startRow = currentRowIdx;

    const scanRelLink = c.attachment_path
      ? `uploads/${c.attachment_path}`
      : `uploads/`;
    const procFolderRelLink = c.linked_procurement
      ? `uploads/procurement/${buildFolderKey(c.linked_procurement.procurement_no, c.linked_procurement.project_name)}`
      : `uploads/procurement/`;
    const relatedFolderRelLink = `uploads/related/${buildFolderKey(c.contract_no, c.contract_name)}`;

    parties.forEach((cp, pIdx) => {
      const rIdx = currentRowIdx++;
      rowGroupParity[rIdx] = cIdx % 2;

      aoa.push([
        c.seq_no || '',
        c.contract_no || '',
        c.contract_name || '',
        c.contract_type || '',
        c.our_entity || '',
        c.sign_date || '',
        c.start_date || '',
        c.expiry_date || '',
        c.status || '',
        c.linked_procurement ? c.linked_procurement.procurement_no : '未关联',
        cp.summary || '',
        cp.company_name || '',
        cp.credit_code || '',
        cp.contact_person || '',
        cp.contact_phone || '',
        cp.bank_account_name || '',
        cp.bank_account_no || '',
        cp.bank_name || '',
        Number(cp.amount || 0),
        Number(cp.amount_excl_tax || 0),
        cp.tax_rate || '',
        cp.invoice_type || '',
        cp.currency || 'CNY',
        Number(cp.perf_bond_amount || 0),
        cp.perf_bond_status || '无',
        cp.perf_bond_return_date || '',
        Number(cp.warranty_bond_amount || 0),
        cp.warranty_bond_status || '无',
        cp.warranty_bond_expiry_date || '',
        cp.remark || c.remark || '',
        c.attachment_path ? '📄 打开合同扫描件' : '未上传扫描件',
        c.linked_procurement ? '📁 打开立项资料夹' : '未关联立项夹',
        (c.related_files && c.related_files.length > 0) ? `📎 打开附件夹(${c.related_files.length}份)` : '打开附件夹'
      ]);

      if (pIdx === 0) {
        formulaCells.push({
          r: rIdx,
          c: 30, // AE 列
          f: `HYPERLINK("${scanRelLink}","${c.attachment_path ? '📄 打开合同扫描件' : '未上传扫描件'}")`
        });
        formulaCells.push({
          r: rIdx,
          c: 31, // AF 列
          f: `HYPERLINK("${procFolderRelLink}","${c.linked_procurement ? '📁 打开立项资料夹' : '未关联立项夹'}")`
        });
        formulaCells.push({
          r: rIdx,
          c: 32, // AG 列
          f: `HYPERLINK("${relatedFolderRelLink}","📎 打开合同附件夹")`
        });
      }
    });

    const endRow = currentRowIdx - 1;
    if (endRow > startRow) {
      const mergeCols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 31, 32];
      for (const colIdx of mergeCols) {
        merges.push({ s: { r: startRow, c: colIdx }, e: { r: endRow, c: colIdx } });
      }
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;

  for (const fc of formulaCells) {
    const addr = XLSX.utils.encode_cell({ r: fc.r, c: fc.c });
    if (!ws[addr]) ws[addr] = { t: 's', v: '' };
    ws[addr].f = fc.f;
  }

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:AG2');
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[addr]) continue;
      if (R === 0) {
        ws[addr].s = {
          font: { name: '微软雅黑', sz: 14, bold: true, color: { rgb: '1E3A8A' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          fill: { fgColor: { rgb: 'EFF6FF' } }
        };
      } else if (R === 1) {
        ws[addr].s = {
          font: { name: '微软雅黑', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          fill: { fgColor: { rgb: '1E40AF' } }
        };
      } else {
        const isOddGroup = rowGroupParity[R] === 1;
        const isLinkCol = C >= 30;
        ws[addr].s = {
          font: {
            name: '微软雅黑',
            sz: 10,
            color: { rgb: isLinkCol ? '2563EB' : '1F2937' },
            underline: isLinkCol
          },
          alignment: { vertical: 'center', horizontal: isLinkCol ? 'center' : 'left' },
          fill: { fgColor: { rgb: isOddGroup ? 'F1F5F9' : 'FFFFFF' } }
        };
      }
    }
  }

  ws['!cols'] = headers.map((h, i) => ({
    wch: [10, 24, 28, 10, 18, 12, 12, 14, 10, 20, 22, 28, 22, 10, 14, 22, 22, 20, 14, 14, 9, 16, 8, 14, 10, 12, 14, 10, 12, 20, 20, 20, 20][i] || 15
  }));

  return ws;
}

function createProcurementWorksheet(procurements) {
  const headers = [
    '序号', '采购立项编号', '采购项目名称', '立项类型', '费用承担部门',
    '采购预算(元)', '预算科目', '采购类型', '采购方式', '立项时间',
    '决策/成交确认时间', '完结时间', '成交供应商', '成交金额(元)', '是否签订合同',
    '关联合同编号', '备注', '① 立项相关资料夹(超链接)', '② 关联合同扫描件(超链接)'
  ];

  const aoa = [
    ['企业采购项目立项台账明细表'],
    headers
  ];

  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }
  ];

  const formulaCells = [];

  procurements.forEach((p, idx) => {
    const rIdx = idx + 2; // Row 3 (0-based 2)，对应 R3, S3
    const procFolderLink = `uploads/procurement/${buildFolderKey(p.procurement_no, p.project_name)}`;
    const contractScanLink = (p.linked_contract && p.linked_contract.attachment_path)
      ? `uploads/${p.linked_contract.attachment_path}`
      : `uploads/`;

    aoa.push([
      p.seq_no || '',
      p.procurement_no || '',
      p.project_name || '',
      p.project_type || '',
      p.cost_department || '',
      Number(p.budget_amount || 0),
      p.budget_subject || '',
      p.procurement_type || '',
      p.procurement_method || '',
      p.approval_date || '',
      p.decision_date || '',
      p.completion_date || '',
      p.supplier_name || '',
      Number(p.deal_amount || 0),
      p.has_contract || '否',
      p.linked_contract ? p.linked_contract.contract_no : (p.contract_no_manual || ''),
      p.remark || '',
      '📁 打开立项资料夹',
      (p.linked_contract && p.linked_contract.attachment_path) ? '📄 打开关联合同扫描件' : '未上传合同扫描件'
    ]);

    formulaCells.push({
      r: rIdx,
      c: 17, // R 列
      f: `HYPERLINK("${procFolderLink}","📁 打开立项资料夹")`
    });
    formulaCells.push({
      r: rIdx,
      c: 18, // S 列
      f: `HYPERLINK("${contractScanLink}","${(p.linked_contract && p.linked_contract.attachment_path) ? '📄 打开关联合同扫描件' : '未上传合同扫描件'}")`
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;

  for (const fc of formulaCells) {
    const addr = XLSX.utils.encode_cell({ r: fc.r, c: fc.c });
    if (!ws[addr]) ws[addr] = { t: 's', v: '' };
    ws[addr].f = fc.f;
  }

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:S2');
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[addr]) continue;
      if (R === 0) {
        ws[addr].s = {
          font: { name: '微软雅黑', sz: 14, bold: true, color: { rgb: '0F766E' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          fill: { fgColor: { rgb: 'F0FDF4' } }
        };
      } else if (R === 1) {
        ws[addr].s = {
          font: { name: '微软雅黑', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          fill: { fgColor: { rgb: '0F766E' } }
        };
      } else {
        const isOdd = (R % 2) === 1;
        const isLinkCol = C >= 17;
        ws[addr].s = {
          font: {
            name: '微软雅黑',
            sz: 10,
            color: { rgb: isLinkCol ? '0D9488' : '1F2937' },
            underline: isLinkCol
          },
          alignment: { vertical: 'center', horizontal: isLinkCol ? 'center' : 'left' },
          fill: { fgColor: { rgb: isOdd ? 'F0FDFA' : 'FFFFFF' } }
        };
      }
    }
  }

  ws['!cols'] = headers.map((h, i) => ({
    wch: [8, 22, 30, 14, 16, 14, 16, 14, 14, 12, 16, 12, 28, 14, 12, 24, 20, 20, 22][i] || 15
  }));

  return ws;
}

app.get(['/api/export/excel', '/api/contracts/export'], (req, res) => {
  try {
    const list = req.query.mode === 'all' ? queryFilteredContracts({}) : queryFilteredContracts(req.query);
    const wb = XLSX.utils.book_new();
    const ws = createContractWorksheet(list);
    XLSX.utils.book_append_sheet(wb, ws, '合同台账');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = encodeURIComponent(`合同管理台账_${getLocalTodayStr()}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: '导出失败: ' + err.message });
  }
});

app.get(['/api/procurements/export', '/api/export/procurements'], (req, res) => {
  try {
    const list = req.query.mode === 'all' ? queryFilteredProcurements({}) : queryFilteredProcurements(req.query);
    const wb = XLSX.utils.book_new();
    const ws = createProcurementWorksheet(list);
    XLSX.utils.book_append_sheet(wb, ws, '采购项目台账');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = encodeURIComponent(`采购项目台账_${getLocalTodayStr()}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: '导出失败: ' + err.message });
  }
});

app.get('/api/export/combined', (req, res) => {
  try {
    const contractList = queryFilteredContracts({});
    const procList = queryFilteredProcurements({});

    const wb = XLSX.utils.book_new();
    const wsContract = createContractWorksheet(contractList);
    const wsProc = createProcurementWorksheet(procList);

    XLSX.utils.book_append_sheet(wb, wsContract, '合同台账');
    XLSX.utils.book_append_sheet(wb, wsProc, '采购项目台账');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = encodeURIComponent(`企业合同与采购项目总台账_${getLocalTodayStr()}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: '合并导出失败: ' + err.message });
  }
});

// 全局异常兜底与临时文件零残留清理中间件
app.use((err, req, res, next) => {
  cleanupReqTempFiles(req);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: '单个上传文件不能超过 50MB' });
    }
    return res.status(400).json({ success: false, message: `文件上传异常: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message || '请求处理失败' });
  }
  next();
});

// ==================== 14. 服务启动与优雅退出控制器（100% 兼容 main.js 与 test-smoke.js） ====================
const activeSockets = new Set();
let serverInstance = null;

// 后台低频维护定时器（每 6 小时清理一次超时临时文件、孤儿附件、刷新过期合同状态并执行 WAL 截断）
const maintenanceTimer = setInterval(() => {
  try {
    autoRefreshExpiredContractStatus();
    sweepOrphanUploads();
    if (db && db.open) db.pragma('wal_checkpoint(PASSIVE)');
    triggerSafeGC();
  } catch (e) {}
}, 6 * 60 * 60 * 1000);
if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();

function shutdown() {
  return new Promise((resolve) => {
    try {
      clearInterval(maintenanceTimer);
      cleanTmpDir();
      sweepOrphanUploads();
    } catch (e) {}

    for (const socket of activeSockets) {
      try { socket.destroy(); } catch (e) {}
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

    if (serverInstance && serverInstance.server) {
      const srv = serverInstance.server;
      serverInstance = null;
      try {
        srv.close(() => closeDb());
        setTimeout(() => closeDb(), 1000).unref();
      } catch (e) {
        closeDb();
      }
    } else {
      closeDb();
    }
  });
}

function startServer(customPort = DEFAULT_PORT, customHost = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(customPort, customHost, () => {
      const addr = srv.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : customPort;

      const controller = {
        port: actualPort,
        server: srv,
        app,
        db,
        shutdown,
        closeServer: shutdown
      };
      serverInstance = controller;

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

      resolve(controller);
    });

    srv.on('error', (err) => reject(err));
    srv.on('connection', (socket) => {
      activeSockets.add(socket);
      socket.on('close', () => activeSockets.delete(socket));
    });
  });
}

if (require.main === module) {
  startServer(DEFAULT_PORT, DEFAULT_HOST);
}

module.exports = {
  app,
  db,
  startServer,
  shutdown,
  closeServer: shutdown
};
