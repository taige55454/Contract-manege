const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const Database = require('better-sqlite3');
const XLSX = require('xlsx-js-style');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ==================== 1. 存储路径与上传目录初始化 ====================
const DATA_ROOT = process.env.DATA_ROOT || __dirname;
const DB_PATH = process.env.DB_PATH || path.join(DATA_ROOT, 'database.sqlite');
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const RELATED_UPLOAD_DIR = path.join(UPLOAD_DIR, 'related');
const PROC_UPLOAD_DIR = path.join(UPLOAD_DIR, 'procurement');

[UPLOAD_DIR, RELATED_UPLOAD_DIR, PROC_UPLOAD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function decodeFilename(name) {
  if (!name) return 'file';
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (decoded.includes('\ufffd')) return name;
    return decoded;
  } catch (e) {
    return name;
  }
}

function sanitizeFileToken(str, maxLen = 85) {
  return String(str || 'UNNAMED')
    .trim()
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLen) || 'UNNAMED';
}

/**
 * 构建规范化的资料文件夹名称：序号_编号_名称
 * 例如：2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同
 */
function buildStandardFolderName(seqNo, codeNo, itemName) {
  const s = sanitizeFileToken(seqNo || '0000-000', 15);
  const c = sanitizeFileToken(codeNo || 'NO', 35);
  const n = sanitizeFileToken(itemName || '未命名', 50);
  return `${s}_${c}_${n}`;
}

function escapeExcelFormulaStr(str) {
  return String(str ?? '').replace(/"/g, '""');
}

function getLocalTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 服务端智能税率规范化：
 * 单税率 "6" -> "6%"；多税率 "6，9" -> "*6%、9%"
 */
function normalizeSmartTaxRateServer(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  if (str === '免税' || str === '0' || str === '0%') return str === '免税' ? '免税' : '0%';

  const hasLeadingStar = str.startsWith('*') || str.startsWith('＊');
  const tokens = str
    .replace(/^[＊*]+/, '')
    .split(/[,，、/／;；\s+]+/)
    .map(t => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return '';

  const formatted = tokens.map(t => {
    const clean = t.replace(/^[＊*]+/, '');
    if (/^\d+(\.\d+)?$/.test(clean)) return `${clean}%`;
    if (/^\d+(\.\d+)?%$/.test(clean)) return clean;
    return clean;
  });

  if (formatted.length > 1 || hasLeadingStar) {
    return '*' + formatted.join('、');
  }
  return formatted[0];
}

function resolveSafeUploadPath(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  const cleanRel = relPath.replace(/^[/\\]+/, '');
  const absRoot = path.resolve(UPLOAD_DIR);
  const absTarget = path.resolve(UPLOAD_DIR, cleanRel);
  const relCheck = path.relative(absRoot, absTarget);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
  return absTarget;
}

function removeEmptyParentDir(absFilePath) {
  try {
    const parentDir = path.dirname(absFilePath);
    const absRoot = path.resolve(UPLOAD_DIR);
    const absRelRoot = path.resolve(RELATED_UPLOAD_DIR);
    const absProcRoot = path.resolve(PROC_UPLOAD_DIR);
    if (parentDir !== absRoot && parentDir !== absRelRoot && parentDir !== absProcRoot) {
      if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
        fs.rmdirSync(parentDir);
      }
    }
  } catch (e) {}
}

function safeUnlinkUploadFile(relPath) {
  try {
    const absTarget = resolveSafeUploadPath(relPath);
    if (absTarget && fs.existsSync(absTarget) && fs.statSync(absTarget).isFile()) {
      fs.unlinkSync(absTarget);
      removeEmptyParentDir(absTarget);
    }
  } catch (e) {
    console.warn('清理旧附件失败:', e.message);
  }
}

function cleanupUploadedReqFiles(req) {
  if (!req) return;
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  else if (req.files && typeof req.files === 'object') {
    for (const arr of Object.values(req.files)) {
      if (Array.isArray(arr)) files.push(...arr);
    }
  }
  for (const f of files) {
    try {
      if (f.path && fs.existsSync(f.path)) {
        fs.unlinkSync(f.path);
        removeEmptyParentDir(f.path);
      }
    } catch (e) {}
  }
}

// ==================== 2. 数据库初始化与平滑演进 ====================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_no TEXT DEFAULT '2026-001',
    contract_no TEXT NOT NULL UNIQUE,
    contract_name TEXT NOT NULL,
    contract_type TEXT DEFAULT '采购',
    our_entity TEXT NOT NULL,
    counterparty TEXT DEFAULT '',
    credit_code TEXT DEFAULT '',
    contact_person TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    bank_account_name TEXT DEFAULT '',
    bank_account_no TEXT DEFAULT '',
    bank_name TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    tax_rate TEXT DEFAULT '',
    amount_excl_tax REAL DEFAULT 0,
    invoice_type TEXT DEFAULT '增值税专用发票',
    currency TEXT DEFAULT 'CNY',
    sign_date TEXT NOT NULL,
    start_date TEXT NOT NULL,
    expiry_date TEXT NOT NULL,
    status TEXT DEFAULT '生效中',
    summary TEXT DEFAULT '',
    perf_bond_amount REAL DEFAULT 0,
    perf_bond_status TEXT DEFAULT '无',
    perf_bond_return_date TEXT DEFAULT '',
    warranty_bond_amount REAL DEFAULT 0,
    warranty_bond_status TEXT DEFAULT '无',
    warranty_bond_expiry_date TEXT DEFAULT '',
    counterparties_json TEXT DEFAULT '[]',
    attachment_path TEXT DEFAULT '',
    attachment_original_name TEXT DEFAULT '',
    procurement_id INTEGER DEFAULT NULL,
    remark TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS contract_related_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    file_original_name TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    uploaded_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS procurement_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_no TEXT DEFAULT '2026-001',
    procurement_no TEXT NOT NULL UNIQUE,
    project_name TEXT NOT NULL,
    project_type TEXT DEFAULT '服务类项目',
    cost_department TEXT DEFAULT '',
    budget_amount REAL DEFAULT 0,
    budget_subject TEXT DEFAULT '',
    procurement_type TEXT DEFAULT '小额零星采购',
    procurement_method TEXT DEFAULT '合作谈判',
    approval_date TEXT DEFAULT '',
    decision_date TEXT DEFAULT '',
    completion_date TEXT DEFAULT '',
    supplier_name TEXT DEFAULT '',
    deal_amount REAL DEFAULT 0,
    has_contract TEXT DEFAULT '否',
    contract_id INTEGER DEFAULT NULL,
    contract_no_manual TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS procurement_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    procurement_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    file_original_name TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    uploaded_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (procurement_id) REFERENCES procurement_projects(id) ON DELETE CASCADE
  );
`);

const existingCols = db.prepare(`PRAGMA table_info(contracts)`).all().map(c => c.name);
const alterCols = [
  ['seq_no', "TEXT DEFAULT '2026-001'"],
  ['counterparties_json', "TEXT DEFAULT '[]'"],
  ['procurement_id', 'INTEGER DEFAULT NULL'],
  ['remark', "TEXT DEFAULT ''"]
];
for (const [col, def] of alterCols) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE contracts ADD COLUMN ${col} ${def}`);
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_contracts_sign_date ON contracts(sign_date);
  CREATE INDEX IF NOT EXISTS idx_contracts_expiry_date ON contracts(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
  CREATE INDEX IF NOT EXISTS idx_contracts_proc_id ON contracts(procurement_id);
  CREATE INDEX IF NOT EXISTS idx_related_contract_id ON contract_related_files(contract_id);
  CREATE INDEX IF NOT EXISTS idx_proc_approval_date ON procurement_projects(approval_date);
  CREATE INDEX IF NOT EXISTS idx_proc_contract_id ON procurement_projects(contract_id);
  CREATE INDEX IF NOT EXISTS idx_proc_files_pid ON procurement_files(procurement_id);
`);

// ==================== 3. 全局脱敏预设配置与编号规则 ====================
const DEFAULT_CONTRACT_RULE = {
  prefix: 'HT-ABC-',
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

const DEFAULT_LAN_SECURITY = {
  enabled: true,
  passcode: '888888'
};

const DEFAULT_DROPDOWN_PRESETS = {
  contract_types: ['采购', '服务', '销售', '框架', '其他'],
  contract_statuses: ['草稿', '生效中', '已到期', '已终止'],
  project_types: ['服务类项目', '货物类项目', '设备采购', '工程类项目', '其他'],
  cost_departments: ['综合管理部', '部门费用预算', '市场营销部', '运营管理部', '财务部', 'ABC分公司'],
  procurement_types: ['小额零星采购', '二级集中采购', '一级集中采购', '分散采购', '其他'],
  procurement_methods: ['合作谈判', '邀请竞争谈判', '公开竞争谈判', '邀请询比', '公开询比', '单一来源采购'],
  budget_subjects: ['办公费', '运输费', '其他固定资产采购', '日常安全费用', '其他外包项目', '租赁费', '中介费', '装修费', '其他福利费'],
  invoice_types: ['增值税专用发票', '增值税普通发票', '数电专票', '数电普票']
};

db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('default_our_entity', 'ABC公司')`).run();
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('contract_no_rule', ?)`).run(JSON.stringify(DEFAULT_CONTRACT_RULE));
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('procurement_no_rule', ?)`).run(JSON.stringify(DEFAULT_PROC_RULE));
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('lan_security', ?)`).run(JSON.stringify(DEFAULT_LAN_SECURITY));
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('dropdown_presets', ?)`).run(JSON.stringify(DEFAULT_DROPDOWN_PRESETS));
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('lan_secret_salt', ?)`).run(crypto.randomBytes(24).toString('hex'));

const entRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'default_our_entity'`).get();
if (!entRow || !String(entRow.value || '').trim()) {
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_our_entity', 'ABC公司')`).run();
}

function getDropdownPresets() {
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'dropdown_presets'`).get();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      const result = {};
      for (const k of Object.keys(DEFAULT_DROPDOWN_PRESETS)) {
        result[k] = Array.isArray(parsed[k]) && parsed[k].length > 0 ? parsed[k] : DEFAULT_DROPDOWN_PRESETS[k];
      }
      return result;
    }
  } catch (e) {}
  return { ...DEFAULT_DROPDOWN_PRESETS };
}

function getDynamicContractStatusPairServer() {
  const presets = getDropdownPresets();
  const list = presets.contract_statuses || ['草稿', '生效中', '已到期', '已终止'];
  const activeLabel = list.find(s => /生效|履行|执行|正常|进行/.test(s)) || '生效中';
  const expiredLabel = list.find(s => /到期|过期|期满|超期|逾期/.test(s)) || '已到期';
  return { activeLabel, expiredLabel };
}

// ==================== 4. 局域网安全口令鉴权中间件 ====================
function getLanSecurityConfig() {
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'lan_security'`).get();
    if (row && row.value) return { ...DEFAULT_LAN_SECURITY, ...JSON.parse(row.value) };
  } catch (e) {}
  return { ...DEFAULT_LAN_SECURITY };
}

function getLanSecretSalt() {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'lan_secret_salt'`).get();
  return (row && row.value) || 'default_salt_cm';
}

function makeLanToken(passcode, timestamp = Date.now()) {
  const ts = String(timestamp);
  const sig = crypto.createHmac('sha256', getLanSecretSalt()).update(`${passcode}|${ts}`).digest('hex');
  return `${ts}.${sig}`;
}

function verifyLanToken(token, passcode) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [tsStr, sig] = token.split('.');
  const ts = Number(tsStr);
  if (!ts || isNaN(ts)) return false;
  if (Date.now() - ts > 12 * 3600 * 1000) return false;
  const expectedSig = crypto.createHmac('sha256', getLanSecretSalt()).update(`${passcode}|${tsStr}`).digest('hex');
  return sig === expectedSig;
}

function isLocalhostRequest(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function getLanIPv4Addresses() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

app.get('/api/lan-auth/status', (req, res) => {
  const cfg = getLanSecurityConfig();
  const isLocal = isLocalhostRequest(req);
  const clientToken = req.headers['x-lan-token'] || req.query.token || '';
  const needPasscode = Boolean(cfg.passcode && String(cfg.passcode).trim());
  const isAuthed = isLocal || !needPasscode || verifyLanToken(clientToken, String(cfg.passcode).trim());

  res.json({
    success: true,
    is_localhost: isLocal,
    enabled: cfg.enabled !== false,
    locked: !isLocal && needPasscode,
    authorized: isAuthed,
    lan_urls: getLanIPv4Addresses().map(ip => `http://${ip}:${PORT}`),
    port: PORT,
    ...(isLocal ? { passcode: cfg.passcode || '' } : {})
  });
});

app.post('/api/lan-auth/login', (req, res) => {
  const cfg = getLanSecurityConfig();
  if (cfg.enabled === false && !isLocalhostRequest(req)) {
    return res.status(403).json({ success: false, message: '主机已关闭局域网外部访问权限' });
  }
  const inputCode = String(req.body.passcode || '').trim();
  const targetCode = String(cfg.passcode || '').trim();
  if (targetCode && inputCode !== targetCode) {
    return res.status(401).json({ success: false, message: '内网访问口令不正确，请联系主机管理员' });
  }
  res.json({ success: true, token: makeLanToken(targetCode) });
});

app.post('/api/lan-auth/config', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ success: false, message: '仅允许主机本机修改局域网安全配置' });
  }
  const nextCfg = {
    enabled: req.body.enabled !== false && req.body.enabled !== 'false',
    passcode: String(req.body.passcode ?? '').trim()
  };
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lan_security', ?)`).run(JSON.stringify(nextCfg));
  res.json({ success: true, config: nextCfg, token: makeLanToken(nextCfg.passcode) });
});

function lanAuthGuard(req, res, next) {
  if (isLocalhostRequest(req)) return next();
  const cfg = getLanSecurityConfig();
  if (cfg.enabled === false) {
    return res.status(403).json({ success: false, locked: true, message: '主机已关闭局域网访问' });
  }
  const targetCode = String(cfg.passcode || '').trim();
  if (!targetCode) return next();
  const clientToken = req.headers['x-lan-token'] || req.query.token || '';
  if (verifyLanToken(clientToken, targetCode)) return next();
  return res.status(401).json({ success: false, locked: true, message: '需要输入内网访问口令' });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', lanAuthGuard);

// ==================== 5. 智能日期解析、年份序号重排与规范化文件夹同步引擎 ====================
function normalizeSmartDateStr(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  if (/^\d{5}$/.test(str)) {
    const serial = parseInt(str, 10);
    if (serial >= 20000 && serial <= 80000) {
      const utcMs = (serial - 25569) * 86400 * 1000;
      const d = new Date(utcMs);
      if (!isNaN(d.getTime())) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
    }
  }
  if (/^\d{8}$/.test(str)) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  }
  const fullMatch = str.match(/^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/);
  if (fullMatch) {
    return `${fullMatch[1]}-${String(parseInt(fullMatch[2], 10)).padStart(2, '0')}-${String(parseInt(fullMatch[3], 10)).padStart(2, '0')}`;
  }
  const shortMatch = str.match(/^(\d{1,2})[-./月](\d{1,2})日?$/);
  if (shortMatch) {
    const curYear = new Date().getFullYear();
    return `${curYear}-${String(parseInt(shortMatch[1], 10)).padStart(2, '0')}-${String(parseInt(shortMatch[2], 10)).padStart(2, '0')}`;
  }
  return str;
}

function computeAutoContractStatus(inputStatus, expiryDateStr) {
  const { activeLabel, expiredLabel } = getDynamicContractStatusPairServer();
  const status = String(inputStatus || activeLabel).trim();
  const exp = normalizeSmartDateStr(expiryDateStr);
  if (!exp || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return status;

  const today = getLocalTodayStr();
  if ((status === activeLabel || status === '生效中') && exp < today) return expiredLabel;
  if ((status === expiredLabel || status === '已到期') && exp >= today) return activeLabel;
  return status;
}

function autoRefreshExpiredContractsInDB() {
  const today = getLocalTodayStr();
  const { activeLabel, expiredLabel } = getDynamicContractStatusPairServer();
  db.prepare(`
    UPDATE contracts
    SET status = ?, updated_at = datetime('now', 'localtime')
    WHERE (status = ? OR status = '生效中') AND expiry_date != '' AND expiry_date < ?
  `).run(expiredLabel, activeLabel, today);
}

/**
 * 将合同其他资料所在的文件夹自动规范化为：uploads/related/序号_合同编号_合同名称/
 */
function syncContractRelatedFolderOnDisk(contractId) {
  const c = db.prepare(`SELECT id, seq_no, contract_no, contract_name FROM contracts WHERE id = ?`).get(contractId);
  if (!c) return;
  const files = db.prepare(`SELECT id, file_path, file_original_name FROM contract_related_files WHERE contract_id = ?`).all(contractId);
  if (files.length === 0) return;

  const idealFolder = buildStandardFolderName(c.seq_no, c.contract_no, c.contract_name);
  const targetDir = path.join(RELATED_UPLOAD_DIR, idealFolder);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const updateStmt = db.prepare(`UPDATE contract_related_files SET file_path = ? WHERE id = ?`);
  for (const f of files) {
    const absOld = resolveSafeUploadPath(f.file_path);
    if (!absOld || !fs.existsSync(absOld)) continue;

    const currentBase = path.basename(absOld);
    const ext = path.extname(currentBase) || path.extname(f.file_original_name) || '';
    const origStem = sanitizeFileToken(path.basename(f.file_original_name || currentBase, ext), 55);
    const noToken = sanitizeFileToken(c.contract_no, 35);

    let newFileName = currentBase;
    if (/^(CONTRACT_|FILE_|TEMP)/i.test(currentBase)) {
      newFileName = `${noToken}_${origStem}${ext}`;
    }

    let absNew = path.join(targetDir, newFileName);
    if (path.resolve(absOld) === path.resolve(absNew)) continue;

    if (fs.existsSync(absNew)) {
      newFileName = `${noToken}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}_${origStem}${ext}`;
      absNew = path.join(targetDir, newFileName);
    }

    try {
      fs.renameSync(absOld, absNew);
      removeEmptyParentDir(absOld);
      const newRelPath = path.relative(UPLOAD_DIR, absNew).split(path.sep).join('/');
      updateStmt.run(newRelPath, f.id);
    } catch (e) {
      console.warn('迁移合同关联附件目录失败:', e.message);
    }
  }
}

/**
 * 将采购立项资料所在的文件夹自动规范化为：uploads/procurement/序号_立项编号_项目名称/
 */
function syncProcurementFolderOnDisk(procId) {
  const p = db.prepare(`SELECT id, seq_no, procurement_no, project_name FROM procurement_projects WHERE id = ?`).get(procId);
  if (!p) return;
  const files = db.prepare(`SELECT id, file_path, file_original_name FROM procurement_files WHERE procurement_id = ?`).all(procId);
  if (files.length === 0) return;

  const idealFolder = buildStandardFolderName(p.seq_no, p.procurement_no, p.project_name);
  const targetDir = path.join(PROC_UPLOAD_DIR, idealFolder);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const updateStmt = db.prepare(`UPDATE procurement_files SET file_path = ? WHERE id = ?`);
  for (const f of files) {
    const absOld = resolveSafeUploadPath(f.file_path);
    if (!absOld || !fs.existsSync(absOld)) continue;

    const currentBase = path.basename(absOld);
    const ext = path.extname(currentBase) || path.extname(f.file_original_name) || '';
    const origStem = sanitizeFileToken(path.basename(f.file_original_name || currentBase, ext), 55);
    const noToken = sanitizeFileToken(p.procurement_no, 35);

    let newFileName = currentBase;
    if (/^(PROC_|FILE_|TEMP)/i.test(currentBase)) {
      newFileName = `${noToken}_${origStem}${ext}`;
    }

    let absNew = path.join(targetDir, newFileName);
    if (path.resolve(absOld) === path.resolve(absNew)) continue;

    if (fs.existsSync(absNew)) {
      newFileName = `${noToken}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}_${origStem}${ext}`;
      absNew = path.join(targetDir, newFileName);
    }

    try {
      fs.renameSync(absOld, absNew);
      removeEmptyParentDir(absOld);
      const newRelPath = path.relative(UPLOAD_DIR, absNew).split(path.sep).join('/');
      updateStmt.run(newRelPath, f.id);
    } catch (e) {
      console.warn('迁移采购立项附件目录失败:', e.message);
    }
  }
}

/**
 * 合同台账序号重排（统一为 YYYY-001）并同步所有关联资料文件夹名称
 */
function recalculateAllSeqNos() {
  const all = db.prepare(`SELECT id, sign_date, contract_no FROM contracts ORDER BY sign_date ASC, contract_no ASC, id ASC`).all();
  const yearCounter = {};
  const updateStmt = db.prepare(`UPDATE contracts SET seq_no = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of all) {
      const year = (row.sign_date && row.sign_date.slice(0, 4)) || String(new Date().getFullYear());
      yearCounter[year] = (yearCounter[year] || 0) + 1;
      const formattedSeq = `${year}-${String(yearCounter[year]).padStart(3, '0')}`;
      updateStmt.run(formattedSeq, row.id);
    }
  });
  tx();
  for (const row of all) {
    syncContractRelatedFolderOnDisk(row.id);
  }
}

/**
 * 采购立项台账序号重排（统一为 YYYY-001）并同步所有立项资料文件夹名称
 */
function recalculateAllProcurementSeqNos() {
  const all = db.prepare(`SELECT id, approval_date, procurement_no FROM procurement_projects ORDER BY approval_date ASC, procurement_no ASC, id ASC`).all();
  const yearCounter = {};
  const updateStmt = db.prepare(`UPDATE procurement_projects SET seq_no = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of all) {
      const year = (row.approval_date && row.approval_date.slice(0, 4)) || String(new Date().getFullYear());
      yearCounter[year] = (yearCounter[year] || 0) + 1;
      const formattedSeq = `${year}-${String(yearCounter[year]).padStart(3, '0')}`;
      updateStmt.run(formattedSeq, row.id);
    }
  });
  tx();
  for (const row of all) {
    syncProcurementFolderOnDisk(row.id);
  }
}

recalculateAllSeqNos();
recalculateAllProcurementSeqNos();
autoRefreshExpiredContractsInDB();

// ==================== 6. 合同与采购编号自动生成引擎（支持夹心自定义段） ====================
function getRuleFromSetting(key, fallback) {
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
    if (row && row.value) return { ...fallback, ...JSON.parse(row.value) };
  } catch (e) {}
  return { ...fallback };
}

function formatRuleDateSegment(dateFmt, dateStr) {
  const clean = normalizeSmartDateStr(dateStr);
  const now = new Date();
  let yyyy = String(now.getFullYear());
  let mm = String(now.getMonth() + 1).padStart(2, '0');
  let dd = String(now.getDate()).padStart(2, '0');

  if (clean && /^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    yyyy = clean.slice(0, 4);
    mm = clean.slice(5, 7);
    dd = clean.slice(8, 10);
  }
  switch (dateFmt) {
    case 'YYYY': return yyyy;
    case 'YYYY-': return `${yyyy}-`;
    case 'YYYYMM': return `${yyyy}${mm}`;
    case 'YYYYMM-': return `${yyyy}${mm}-`;
    case 'YYYYMMDD': return `${yyyy}${mm}${dd}`;
    case 'YYYYMMDD-': return `${yyyy}${mm}${dd}-`;
    default: return '';
  }
}

function generateNextNoByTable({ tableName, colName, dateColName, ruleKey, fallbackRule, dateVal, midCustom }) {
  const rule = getRuleFromSetting(ruleKey, fallbackRule);
  const prefix = String(rule.prefix || '');
  const midPart = midCustom !== undefined ? String(midCustom) : String(rule.default_mid || '');
  const suffix = String(rule.suffix || '');
  const digits = Number(rule.seq_digits ?? 3);
  const datePart = formatRuleDateSegment(rule.date_part, dateVal);
  const fullPrefix = `${prefix}${midPart}${datePart}`;

  const cleanDate = normalizeSmartDateStr(dateVal);
  const targetYear = (cleanDate && cleanDate.slice(0, 4)) || String(new Date().getFullYear());

  let rows = [];
  if (rule.reset_yearly !== false) {
    rows = db.prepare(`SELECT ${colName} AS no FROM ${tableName} WHERE substr(${dateColName}, 1, 4) = ?`).all(targetYear);
  } else {
    rows = db.prepare(`SELECT ${colName} AS no FROM ${tableName}`).all();
  }

  let maxSeq = 0;
  for (const r of rows) {
    const no = String(r.no || '');
    if (fullPrefix && !no.startsWith(fullPrefix)) continue;
    if (suffix && !no.endsWith(suffix)) continue;
    const middle = no.slice(fullPrefix.length, suffix ? no.length - suffix.length : undefined);
    if (/^\d+$/.test(middle)) {
      const n = parseInt(middle, 10);
      if (n > maxSeq) maxSeq = n;
    } else {
      const tailMatch = middle.match(/(\d+)$/);
      if (tailMatch) {
        const n = parseInt(tailMatch[1], 10);
        if (n > maxSeq) maxSeq = n;
      }
    }
  }

  let nextNum = maxSeq + 1;
  let seqPart = digits > 0 ? String(nextNum).padStart(digits, '0') : '';
  let candidate = `${fullPrefix}${seqPart}${suffix}`;

  const checkExistStmt = db.prepare(`SELECT 1 FROM ${tableName} WHERE ${colName} = ?`);
  while (digits > 0 && checkExistStmt.get(candidate)) {
    nextNum++;
    seqPart = String(nextNum).padStart(digits, '0');
    candidate = `${fullPrefix}${seqPart}${suffix}`;
  }

  return {
    rule,
    prefix,
    mid_part: midPart,
    date_part: datePart,
    seq_part: seqPart,
    suffix,
    next_no: candidate
  };
}

function resolveAvailableNoOnInsert(inputNo, options) {
  const cleanNo = String(inputNo || '').trim();
  const checkStmt = db.prepare(`SELECT 1 FROM ${options.tableName} WHERE ${options.colName} = ?`);
  if (cleanNo && !checkStmt.get(cleanNo)) return cleanNo;
  return generateNextNoByTable(options).next_no;
}

// ==================== 7. 对方单位明细解析与文件上传规则 ====================
function parseCounterpartiesFromBody(body) {
  let list = [];
  if (body.counterparties_json) {
    try {
      const parsed = JSON.parse(body.counterparties_json);
      if (Array.isArray(parsed)) list = parsed;
    } catch (e) {}
  }
  if (list.length === 0) {
    list = [{
      company_name: body.counterparty || '',
      credit_code: body.credit_code || '',
      summary: body.summary || '',
      contact_person: body.contact_person || '',
      contact_phone: body.contact_phone || '',
      bank_account_name: body.bank_account_name || '',
      bank_account_no: body.bank_account_no || '',
      bank_name: body.bank_name || '',
      bank_code: body.bank_code || '',
      amount: Number(body.amount || 0),
      tax_rate: body.tax_rate || '',
      amount_excl_tax: Number(body.amount_excl_tax || 0),
      invoice_type: body.invoice_type || '增值税专用发票',
      currency: body.currency || 'CNY',
      perf_bond_amount: Number(body.perf_bond_amount || 0),
      perf_bond_status: body.perf_bond_status || '无',
      perf_bond_return_date: normalizeSmartDateStr(body.perf_bond_return_date || ''),
      warranty_bond_amount: Number(body.warranty_bond_amount || 0),
      warranty_bond_status: body.warranty_bond_status || '无',
      warranty_bond_expiry_date: normalizeSmartDateStr(body.warranty_bond_expiry_date || ''),
      remark: body.remark || ''
    }];
  }

  return list.map(item => {
    const amt = Number(item.amount || 0);
    const normTax = normalizeSmartTaxRateServer(item.tax_rate);
    let excl = Number(item.amount_excl_tax || 0);
    if (!excl && amt > 0 && !normTax.startsWith('*')) {
      const rNum = parseFloat(normTax.replace('%', ''));
      if (!isNaN(rNum) && rNum >= 0) {
        excl = Number((amt / (1 + rNum / 100)).toFixed(2));
      }
    }
    const perfAmt = Number(item.perf_bond_amount || 0);
    const warrantyAmt = Number(item.warranty_bond_amount || 0);
    return {
      company_name: String(item.company_name || '').trim(),
      credit_code: String(item.credit_code || '').trim(),
      summary: String(item.summary || '').trim(),
      contact_person: String(item.contact_person || '').trim(),
      contact_phone: String(item.contact_phone || '').trim(),
      bank_account_name: String(item.bank_account_name || '').trim(),
      bank_account_no: String(item.bank_account_no || '').trim(),
      bank_name: String(item.bank_name || '').trim(),
      bank_code: String(item.bank_code || '').trim(),
      amount: amt,
      tax_rate: normTax,
      amount_excl_tax: excl,
      invoice_type: String(item.invoice_type || '增值税专用发票').trim(),
      currency: String(item.currency || 'CNY').trim(),
      perf_bond_amount: perfAmt,
      perf_bond_status: perfAmt > 0 ? (item.perf_bond_status === '已退' ? '已退' : '未退') : '无',
      perf_bond_return_date: normalizeSmartDateStr(item.perf_bond_return_date || ''),
      warranty_bond_amount: warrantyAmt,
      warranty_bond_status: warrantyAmt > 0 ? (item.warranty_bond_status === '已退' ? '已退' : '未退') : '无',
      warranty_bond_expiry_date: normalizeSmartDateStr(item.warranty_bond_expiry_date || ''),
      remark: String(item.remark || '').trim()
    };
  });
}

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'related_files') {
      let folderToken = '';
      if (req.params && req.params.id) {
        const cRow = db.prepare(`SELECT seq_no, contract_no, contract_name FROM contracts WHERE id = ?`).get(req.params.id);
        if (cRow) folderToken = buildStandardFolderName(cRow.seq_no, cRow.contract_no, cRow.contract_name);
      }
      if (!folderToken) {
        folderToken = buildStandardFolderName('TEMP', req.body?.contract_no || 'NEW', req.body?.contract_name || 'CONTRACT');
      }
      const targetDir = path.join(RELATED_UPLOAD_DIR, folderToken);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    } else if (file.fieldname === 'procurement_files') {
      let folderToken = '';
      if (req.params && req.params.id) {
        const pRow = db.prepare(`SELECT seq_no, procurement_no, project_name FROM procurement_projects WHERE id = ?`).get(req.params.id);
        if (pRow) folderToken = buildStandardFolderName(pRow.seq_no, pRow.procurement_no, pRow.project_name);
      }
      if (!folderToken) {
        folderToken = buildStandardFolderName('TEMP', req.body?.procurement_no || 'NEW', req.body?.project_name || 'PROC');
      }
      const targetDir = path.join(PROC_UPLOAD_DIR, folderToken);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    } else {
      cb(null, UPLOAD_DIR);
    }
  },
  filename: (req, file, cb) => {
    const orig = decodeFilename(file.originalname);
    const ext = path.extname(orig) || '.pdf';
    const baseOrig = sanitizeFileToken(path.basename(orig, ext), 55);

    if (file.fieldname === 'attachment') {
      let cNo = req.body?.contract_no;
      if (!cNo && req.params?.id) {
        const cRow = db.prepare(`SELECT contract_no FROM contracts WHERE id = ?`).get(req.params.id);
        if (cRow) cNo = cRow.contract_no;
      }
      const token = sanitizeFileToken(cNo || `CONTRACT_${Date.now()}`, 45);
      let finalName = `${token}${ext}`;
      if (fs.existsSync(path.join(UPLOAD_DIR, finalName))) {
        finalName = `${token}_${Date.now()}${ext}`;
      }
      cb(null, finalName);
    } else if (file.fieldname === 'related_files') {
      let cNo = req.body?.contract_no;
      if (!cNo && req.params?.id) {
        const cRow = db.prepare(`SELECT contract_no FROM contracts WHERE id = ?`).get(req.params.id);
        if (cRow) cNo = cRow.contract_no;
      }
      const prefixToken = sanitizeFileToken(cNo || 'HT', 35);
      cb(null, `${prefixToken}_${baseOrig}${ext}`);
    } else {
      let pNo = req.body?.procurement_no;
      if (!pNo && req.params?.id) {
        const pRow = db.prepare(`SELECT procurement_no FROM procurement_projects WHERE id = ?`).get(req.params.id);
        if (pRow) pNo = pRow.procurement_no;
      }
      const prefixToken = sanitizeFileToken(pNo || 'LX', 35);
      cb(null, `${prefixToken}_${baseOrig}${ext}`);
    }
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

function renameMainScanToMatchContractNo(currentRelPath, contractNo) {
  if (!currentRelPath) return '';
  const absOld = resolveSafeUploadPath(currentRelPath);
  if (!absOld || !fs.existsSync(absOld)) return currentRelPath;

  const ext = path.extname(absOld) || '.pdf';
  const safeToken = sanitizeFileToken(contractNo);
  const idealRelName = `${safeToken}${ext}`;
  if (currentRelPath === idealRelName) return currentRelPath;

  let absNew = path.join(UPLOAD_DIR, idealRelName);
  let finalRelName = idealRelName;
  if (fs.existsSync(absNew) && path.resolve(absNew) !== path.resolve(absOld)) {
    finalRelName = `${safeToken}_${Date.now()}${ext}`;
    absNew = path.join(UPLOAD_DIR, finalRelName);
  }
  try {
    fs.renameSync(absOld, absNew);
    return finalRelName;
  } catch (e) {
    return currentRelPath;
  }
}

app.get('/uploads/*', lanAuthGuard, (req, res) => {
  const relPath = req.params[0] || '';
  const absTarget = resolveSafeUploadPath(relPath);
  if (!absTarget || !fs.existsSync(absTarget) || !fs.statSync(absTarget).isFile()) {
    return res.status(404).send('文件不存在或已被移除');
  }
  if (req.query.download === '1') {
    const customName = req.query.filename ? path.basename(String(req.query.filename)) : path.basename(absTarget);
    return res.download(absTarget, customName);
  }
  return res.sendFile(absTarget);
});

// ==================== 8. 系统设置与自定义预设 API ====================
app.get('/api/settings/presets', (req, res) => {
  res.json({ success: true, presets: getDropdownPresets(), defaults: DEFAULT_DROPDOWN_PRESETS });
});

app.post('/api/settings/presets', (req, res) => {
  if (req.body && req.body.reset_defaults) {
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('dropdown_presets', ?)`).run(JSON.stringify(DEFAULT_DROPDOWN_PRESETS));
    return res.json({ success: true, presets: DEFAULT_DROPDOWN_PRESETS });
  }
  const current = getDropdownPresets();
  const incoming = req.body.presets || {};
  const nextPresets = {};
  for (const key of Object.keys(DEFAULT_DROPDOWN_PRESETS)) {
    if (Array.isArray(incoming[key])) {
      const cleaned = incoming[key].map(s => String(s || '').trim()).filter(Boolean);
      nextPresets[key] = cleaned.length > 0 ? Array.from(new Set(cleaned)) : current[key];
    } else if (typeof incoming[key] === 'string') {
      const cleaned = incoming[key].split(/[\r\n,，、;；]+/).map(s => s.trim()).filter(Boolean);
      nextPresets[key] = cleaned.length > 0 ? Array.from(new Set(cleaned)) : current[key];
    } else {
      nextPresets[key] = current[key];
    }
  }
  if (!nextPresets.contract_statuses.some(s => /生效|履行|执行|正常|进行/.test(s))) {
    nextPresets.contract_statuses.push('生效中');
  }
  if (!nextPresets.contract_statuses.some(s => /到期|过期|期满|超期|逾期/.test(s))) {
    nextPresets.contract_statuses.push('已到期');
  }

  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('dropdown_presets', ?)`).run(JSON.stringify(nextPresets));
  res.json({ success: true, presets: nextPresets });
});

app.get('/api/settings/our-entity', (req, res) => {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'default_our_entity'`).get();
  res.json({ success: true, our_entity: row ? row.value : 'ABC公司' });
});

app.post('/api/settings/our-entity', (req, res) => {
  const val = String(req.body.our_entity || '').trim();
  if (!val) return res.status(400).json({ success: false, message: '名称不能为空' });
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_our_entity', ?)`).run(val);
  res.json({ success: true, our_entity: val });
});

app.get('/api/settings/no-rule', (req, res) => {
  const preview = generateNextNoByTable({
    tableName: 'contracts',
    colName: 'contract_no',
    dateColName: 'sign_date',
    ruleKey: 'contract_no_rule',
    fallbackRule: DEFAULT_CONTRACT_RULE
  });
  res.json({ success: true, ...preview });
});

app.post('/api/settings/no-rule', (req, res) => {
  const b = req.body || {};
  const nextRule = {
    prefix: String(b.prefix ?? 'HT-ABC-').trim(),
    default_mid: String(b.default_mid ?? '').trim(),
    date_part: ['NONE', 'YYYY', 'YYYY-', 'YYYYMM', 'YYYYMM-', 'YYYYMMDD', 'YYYYMMDD-'].includes(b.date_part) ? b.date_part : 'YYYYMM',
    seq_digits: Math.min(6, Math.max(0, parseInt(b.seq_digits ?? 3, 10))),
    suffix: String(b.suffix ?? '').trim(),
    reset_yearly: b.reset_yearly !== false && b.reset_yearly !== 'false'
  };
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('contract_no_rule', ?)`).run(JSON.stringify(nextRule));
  const preview = generateNextNoByTable({
    tableName: 'contracts',
    colName: 'contract_no',
    dateColName: 'sign_date',
    ruleKey: 'contract_no_rule',
    fallbackRule: DEFAULT_CONTRACT_RULE
  });
  res.json({ success: true, ...preview });
});

app.get('/api/contracts/next-no', (req, res) => {
  const preview = generateNextNoByTable({
    tableName: 'contracts',
    colName: 'contract_no',
    dateColName: 'sign_date',
    ruleKey: 'contract_no_rule',
    fallbackRule: DEFAULT_CONTRACT_RULE,
    dateVal: req.query.sign_date,
    midCustom: req.query.mid_custom
  });
  res.json({ success: true, ...preview });
});

app.get('/api/settings/proc-no-rule', (req, res) => {
  const preview = generateNextNoByTable({
    tableName: 'procurement_projects',
    colName: 'procurement_no',
    dateColName: 'approval_date',
    ruleKey: 'procurement_no_rule',
    fallbackRule: DEFAULT_PROC_RULE
  });
  res.json({ success: true, ...preview });
});

app.post('/api/settings/proc-no-rule', (req, res) => {
  const b = req.body || {};
  const nextRule = {
    prefix: String(b.prefix ?? 'LX').trim(),
    default_mid: String(b.default_mid ?? '').trim(),
    date_part: ['NONE', 'YYYY', 'YYYY-', 'YYYYMM', 'YYYYMM-', 'YYYYMMDD', 'YYYYMMDD-'].includes(b.date_part) ? b.date_part : 'YYYYMMDD',
    seq_digits: Math.min(6, Math.max(0, parseInt(b.seq_digits ?? 3, 10))),
    suffix: String(b.suffix ?? '').trim(),
    reset_yearly: b.reset_yearly !== false && b.reset_yearly !== 'false'
  };
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('procurement_no_rule', ?)`).run(JSON.stringify(nextRule));
  const preview = generateNextNoByTable({
    tableName: 'procurement_projects',
    colName: 'procurement_no',
    dateColName: 'approval_date',
    ruleKey: 'procurement_no_rule',
    fallbackRule: DEFAULT_PROC_RULE
  });
  res.json({ success: true, ...preview });
});

app.get('/api/procurements/next-no', (req, res) => {
  const preview = generateNextNoByTable({
    tableName: 'procurement_projects',
    colName: 'procurement_no',
    dateColName: 'approval_date',
    ruleKey: 'procurement_no_rule',
    fallbackRule: DEFAULT_PROC_RULE,
    dateVal: req.query.approval_date,
    midCustom: req.query.mid_custom
  });
  res.json({ success: true, ...preview });
});

// ==================== 9. 合同与采购双向排他绑定、一键解绑与水合引擎 ====================
/**
 * 同步合同 -> 采购立项的双向排他绑定：
 * - 当 allowAutoMatchManual=true（新增合同时）且未选立项，可自动吸附预填了该合同号的未绑定立项
 * - 当 allowAutoMatchManual=false（编辑合同主動解绑时），彻底清除双端绑定与预填合同号
 */
function syncContractProcurementLink(contractId, contractNo, procurementId, allowAutoMatchManual = false) {
  // 1. 先清理旧绑定到该合同的所有采购立项
  db.prepare(`
    UPDATE procurement_projects
    SET contract_id = NULL,
        contract_no_manual = CASE WHEN contract_id = ? THEN '' ELSE contract_no_manual END,
        has_contract = CASE WHEN contract_id = ? THEN '否' ELSE has_contract END
    WHERE contract_id = ?
  `).run(contractId, contractId, contractId);

  let targetProcId = procurementId ? Number(procurementId) : null;
  if (!targetProcId && allowAutoMatchManual && contractNo) {
    const matchedProc = db.prepare(`
      SELECT id FROM procurement_projects
      WHERE contract_no_manual = ? AND (contract_id IS NULL OR contract_id = ?)
    `).get(contractNo, contractId);
    if (matchedProc) targetProcId = matchedProc.id;
  }

  if (targetProcId) {
    // 确保一对一排他：若目标立项此前绑了其他合同，先解绑旧合同
    db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE procurement_id = ? AND id != ?`).run(targetProcId, contractId);
    db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(targetProcId, contractId);
    db.prepare(`
      UPDATE procurement_projects
      SET contract_id = ?, has_contract = '是', contract_no_manual = ?
      WHERE id = ?
    `).run(contractId, contractNo, targetProcId);
  } else {
    db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(contractId);
    if (contractNo && !allowAutoMatchManual) {
      db.prepare(`
        UPDATE procurement_projects
        SET contract_id = NULL, contract_no_manual = '', has_contract = '否'
        WHERE contract_no_manual = ?
      `).run(contractNo);
    }
  }
}

/**
 * 原子解绑：解除指定合同与采购立项之间的双向关联
 */
function unbindContractAndProcurement({ contractId = null, procurementId = null }) {
  const tx = db.transaction(() => {
    if (contractId) {
      const cRow = db.prepare(`SELECT id, contract_no, procurement_id FROM contracts WHERE id = ?`).get(contractId);
      if (cRow) {
        db.prepare(`UPDATE contracts SET procurement_id = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(cRow.id);
        db.prepare(`
          UPDATE procurement_projects
          SET contract_id = NULL, contract_no_manual = '', has_contract = '否', updated_at = datetime('now', 'localtime')
          WHERE contract_id = ? OR id = ? OR (contract_no_manual != '' AND contract_no_manual = ?)
        `).run(cRow.id, cRow.procurement_id || -1, cRow.contract_no);
      }
    }
    if (procurementId) {
      const pRow = db.prepare(`SELECT id, contract_id, contract_no_manual FROM procurement_projects WHERE id = ?`).get(procurementId);
      if (pRow) {
        db.prepare(`
          UPDATE procurement_projects
          SET contract_id = NULL, contract_no_manual = '', has_contract = '否', updated_at = datetime('now', 'localtime')
          WHERE id = ?
        `).run(pRow.id);
        db.prepare(`
          UPDATE contracts
          SET procurement_id = NULL, updated_at = datetime('now', 'localtime')
          WHERE procurement_id = ? OR id = ? OR (contract_no != '' AND contract_no = ?)
        `).run(pRow.id, pRow.contract_id || -1, pRow.contract_no_manual || '');
      }
    }
  });
  tx();
}

function hydrateContractRow(row) {
  if (!row) return null;
  let parties = [];
  try {
    parties = JSON.parse(row.counterparties_json || '[]');
  } catch (e) {}
  if (!Array.isArray(parties) || parties.length === 0) {
    parties = [{
      company_name: row.counterparty || '',
      credit_code: row.credit_code || '',
      summary: row.summary || '',
      contact_person: row.contact_person || '',
      contact_phone: row.contact_phone || '',
      bank_account_name: row.bank_account_name || '',
      bank_account_no: row.bank_account_no || '',
      bank_name: row.bank_name || '',
      bank_code: '',
      amount: Number(row.amount || 0),
      tax_rate: normalizeSmartTaxRateServer(row.tax_rate || ''),
      amount_excl_tax: Number(row.amount_excl_tax || 0),
      invoice_type: row.invoice_type || '增值税专用发票',
      currency: row.currency || 'CNY',
      perf_bond_amount: Number(row.perf_bond_amount || 0),
      perf_bond_status: row.perf_bond_status || '无',
      perf_bond_return_date: row.perf_bond_return_date || '',
      warranty_bond_amount: Number(row.warranty_bond_amount || 0),
      warranty_bond_status: row.warranty_bond_status || '无',
      warranty_bond_expiry_date: row.warranty_bond_expiry_date || '',
      remark: ''
    }];
  } else {
    parties = parties.map(cp => ({
      ...cp,
      bank_code: cp.bank_code || '',
      tax_rate: normalizeSmartTaxRateServer(cp.tax_rate || '')
    }));
  }

  const related_files = db.prepare(`SELECT * FROM contract_related_files WHERE contract_id = ? ORDER BY id ASC`).all(row.id);

  let linked_procurement = null;
  const procRow = row.procurement_id
    ? db.prepare(`SELECT * FROM procurement_projects WHERE id = ?`).get(row.procurement_id)
    : db.prepare(`SELECT * FROM procurement_projects WHERE contract_id = ? OR (contract_no_manual != '' AND contract_no_manual = ?)`).get(row.id, row.contract_no);

  if (procRow) {
    // 若数据库单侧外键尚未写回，自动自愈补齐双向指针
    if (row.procurement_id !== procRow.id || procRow.contract_id !== row.id) {
      try {
        db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(procRow.id, row.id);
        db.prepare(`UPDATE procurement_projects SET contract_id = ?, has_contract = '是', contract_no_manual = ? WHERE id = ?`).run(row.id, row.contract_no, procRow.id);
      } catch (e) {}
    }
    const procFiles = db.prepare(`SELECT * FROM procurement_files WHERE procurement_id = ? ORDER BY id ASC`).all(procRow.id);
    linked_procurement = { ...procRow, files: procFiles };
  }

  return {
    ...row,
    counterparties: parties,
    related_files,
    linked_procurement
  };
}

/**
 * 采购立项行水合：
 * 支持三重双向反查（按 contract_id / 按 contracts.procurement_id / 按预填合同号），
 * 确保关联合同后 100% 拿到合同的 attachment_path（主合同扫描件路径）用于生成 Excel 超链接！
 */
function hydrateProcurementRow(row) {
  if (!row) return null;
  const files = db.prepare(`SELECT * FROM procurement_files WHERE procurement_id = ? ORDER BY id ASC`).all(row.id);
  let linked_contract = null;

  let cRow = null;
  if (row.contract_id) {
    cRow = db.prepare(`SELECT id, seq_no, contract_no, contract_name, status, attachment_path, attachment_original_name, procurement_id FROM contracts WHERE id = ?`).get(row.contract_id);
  }
  if (!cRow) {
    cRow = db.prepare(`SELECT id, seq_no, contract_no, contract_name, status, attachment_path, attachment_original_name, procurement_id FROM contracts WHERE procurement_id = ?`).get(row.id);
  }
  if (!cRow && row.contract_no_manual) {
    cRow = db.prepare(`SELECT id, seq_no, contract_no, contract_name, status, attachment_path, attachment_original_name, procurement_id FROM contracts WHERE contract_no = ?`).get(row.contract_no_manual);
  }

  if (cRow) {
    // 自动自愈同步双端外键，确保数据绝对一致
    if (row.contract_id !== cRow.id || cRow.procurement_id !== row.id) {
      try {
        db.prepare(`UPDATE procurement_projects SET contract_id = ?, has_contract = '是', contract_no_manual = ? WHERE id = ?`).run(cRow.id, cRow.contract_no, row.id);
        db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(row.id, cRow.id);
        row.contract_id = cRow.id;
        row.has_contract = '是';
        row.contract_no_manual = cRow.contract_no;
      } catch (e) {}
    }
    const cRelFiles = db.prepare(`SELECT * FROM contract_related_files WHERE contract_id = ? ORDER BY id ASC`).all(cRow.id);
    linked_contract = { ...cRow, related_files: cRelFiles };
  }
  return {
    ...row,
    files,
    linked_contract
  };
}

// ==================== 10. 查询过滤函数与 Excel 导出构建器（前置以避免 :id 路由拦截） ====================
function queryFilteredContracts(query = {}) {
  autoRefreshExpiredContractsInDB();

  const {
    no, counterparty, year, type, status,
    date_field, date_from, date_to,
    sort_by = 'seq_no', sort_order = 'asc'
  } = query;

  const conditions = [];
  const params = {};

  if (no && no.trim()) {
    conditions.push(`(contract_no LIKE @no OR contract_name LIKE @no OR seq_no LIKE @no OR summary LIKE @no OR remark LIKE @no OR counterparties_json LIKE @no)`);
    params.no = `%${no.trim()}%`;
  }
  if (counterparty && counterparty.trim()) {
    conditions.push(`(counterparty LIKE @cp OR counterparties_json LIKE @cp OR our_entity LIKE @cp)`);
    params.cp = `%${counterparty.trim()}%`;
  }
  if (year && year.trim()) {
    conditions.push(`substr(sign_date, 1, 4) = @year`);
    params.year = year.trim();
  }
  if (type && type.trim()) {
    conditions.push(`contract_type = @type`);
    params.type = type.trim();
  }
  if (status && status.trim()) {
    conditions.push(`status = @status`);
    params.status = status.trim();
  }

  const allowedDateFields = ['sign_date', 'start_date', 'expiry_date'];
  const targetDateCol = allowedDateFields.includes(date_field) ? date_field : 'sign_date';
  const normFrom = normalizeSmartDateStr(date_from);
  const normTo = normalizeSmartDateStr(date_to);
  if (normFrom) {
    conditions.push(`${targetDateCol} >= @date_from`);
    params.date_from = normFrom;
  }
  if (normTo) {
    conditions.push(`${targetDateCol} <= @date_to`);
    params.date_to = normTo;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const dir = String(sort_order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  let orderClause = `ORDER BY substr(sign_date, 1, 4) ${dir}, CAST(substr(seq_no, 6) AS INTEGER) ${dir}, id ${dir}`;
  if (sort_by === 'contract_no') orderClause = `ORDER BY contract_no ${dir}, id ${dir}`;
  else if (sort_by === 'sign_date') orderClause = `ORDER BY sign_date ${dir}, id ${dir}`;
  else if (sort_by === 'expiry_date') orderClause = `ORDER BY expiry_date ${dir}, id ${dir}`;

  const rawRows = db.prepare(`SELECT * FROM contracts ${whereClause} ${orderClause}`).all(params);
  return rawRows.map(hydrateContractRow);
}

function queryFilteredProcurements(query = {}) {
  const { kw, year, type, dept, has_contract, sort_order = 'asc' } = query;
  const conditions = [];
  const params = {};

  if (kw && kw.trim()) {
    conditions.push(`(seq_no LIKE @kw OR procurement_no LIKE @kw OR project_name LIKE @kw OR supplier_name LIKE @kw OR budget_subject LIKE @kw OR contract_no_manual LIKE @kw OR remark LIKE @kw)`);
    params.kw = `%${kw.trim()}%`;
  }
  if (year && year.trim()) {
    conditions.push(`substr(approval_date, 1, 4) = @year`);
    params.year = year.trim();
  }
  if (type && type.trim()) {
    conditions.push(`project_type = @type`);
    params.type = type.trim();
  }
  if (dept && dept.trim()) {
    conditions.push(`cost_department LIKE @dept`);
    params.dept = `%${dept.trim()}%`;
  }
  if (has_contract && has_contract.trim()) {
    conditions.push(`has_contract = @has_contract`);
    params.has_contract = has_contract.trim();
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const dir = String(sort_order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderClause = `ORDER BY substr(approval_date, 1, 4) ${dir}, CAST(substr(seq_no, 6) AS INTEGER) ${dir}, id ${dir}`;

  const rawRows = db.prepare(`SELECT * FROM procurement_projects ${whereClause} ${orderClause}`).all(params);
  return rawRows.map(hydrateProcurementRow);
}

function buildBorderSpec(isGroupBottom = false) {
  return {
    top: { style: 'thin', color: { rgb: 'CBD5E1' } },
    bottom: isGroupBottom
      ? { style: 'medium', color: { rgb: '64748B' } }
      : { style: 'thin', color: { rgb: 'CBD5E1' } },
    left: { style: 'thin', color: { rgb: 'CBD5E1' } },
    right: { style: 'thin', color: { rgb: 'CBD5E1' } }
  };
}

/**
 * 合同台账 Excel 构建器：
 * - 共 34 列 (索引 0 ~ 33，对应 A ~ AH 列)
 * - 关联采购立项号列：若关联立项上传了立项资料，直接在立项号上加超链接（显示文字仍为立项号）
 * - 主合同扫描件列：直接显示文件名（如 HT-ABC-xxx.pdf）并带超链接
 * - 第 1、2 行无底色填充，所有行高统一为 50 磅 (hpt: 50)
 */
function buildContractWorksheet(rows) {
  const headers = [
    '序号', '合同编号', '合同名称', '合同类型', '我方签约主体',
    '签订日期', '开始履约日', '合同到期日', '状态',
    '履约摘要', '对方单位名称', '统一社会信用代码',
    '联系人', '联系电话', '收款账户名称', '收款银行账号', '开户银行', '开户行号',
    '含税金额(元)', '不含税价(元)', '税率', '发票类型', '币种',
    '履约保证金(元)', '保证金状态', '保证金应退日',
    '质保金金额(元)', '质保金状态', '质保金到期日', '备注',
    '主合同扫描件', '关联采购立项号', '其他相关资料', '本合同含税总额(元)'
  ];

  const aoa = [
    ['企业合同管理台账总表'],
    headers
  ];

  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }
  ];

  const rowMeta = [];
  let currentRowIdx = 2;

  rows.forEach((c, groupIdx) => {
    const parties = c.counterparties && c.counterparties.length > 0 ? c.counterparties : [{}];
    const span = parties.length;
    const startRow = currentRowIdx;
    const endRow = currentRowIdx + span - 1;
    const isOddGroup = groupIdx % 2 === 1;

    const totalContractAmt = parties.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const procNo = c.linked_procurement ? c.linked_procurement.procurement_no : '';
    const procFiles = (c.linked_procurement && c.linked_procurement.files) || [];
    const relFiles = c.related_files || [];
    const scanFileName = c.attachment_path ? path.basename(c.attachment_path) : '';

    parties.forEach((cp, pIdx) => {
      const combinedRemark = [cp.remark, c.remark].filter(Boolean).join('\n');
      const rowData = [
        c.seq_no || '',
        c.contract_no || '',
        c.contract_name || '',
        c.contract_type || '',
        c.our_entity || '',
        c.sign_date || '',
        c.start_date || '',
        c.expiry_date || '',
        c.status || '',
        cp.summary || '',
        cp.company_name || '',
        cp.credit_code || '',
        cp.contact_person || '',
        cp.contact_phone || '',
        cp.bank_account_name || '',
        cp.bank_account_no || '',
        cp.bank_name || '',
        cp.bank_code || '',
        Number(cp.amount || 0),
        Number(cp.amount_excl_tax || 0),
        normalizeSmartTaxRateServer(cp.tax_rate || ''),
        cp.invoice_type || '',
        cp.currency || 'CNY',
        Number(cp.perf_bond_amount || 0),
        cp.perf_bond_status || '无',
        cp.perf_bond_return_date || '',
        Number(cp.warranty_bond_amount || 0),
        cp.warranty_bond_status || '无',
        cp.warranty_bond_expiry_date || '',
        combinedRemark,
        scanFileName || '未上传',
        procNo || '未关联',
        relFiles.length > 0 ? (relFiles.length === 1 ? relFiles[0].file_original_name : `${relFiles[0].file_original_name} 等${relFiles.length}份`) : '无',
        totalContractAmt
      ];
      aoa.push(rowData);
      rowMeta[currentRowIdx] = {
        isOddGroup,
        isGroupBottom: pIdx === span - 1,
        c,
        scanFileName,
        procNo,
        procFiles,
        relFiles,
        isFirstInGroup: pIdx === 0
      };
      currentRowIdx++;
    });

    if (span > 1) {
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 30, 31, 32, 33].forEach(colIdx => {
        merges.push({ s: { r: startRow, c: colIdx }, e: { r: endRow, c: colIdx } });
      });
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;

  ws['!cols'] = [
    { wch: 11 }, { wch: 18 }, { wch: 18 }, { wch: 8 },  { wch: 14 },
    { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 9 },
    { wch: 28 }, { wch: 16 }, { wch: 18 },
    { wch: 9 },  { wch: 13 }, { wch: 18 }, { wch: 19 }, { wch: 18 }, { wch: 14 },
    { wch: 13 }, { wch: 13 }, { wch: 10 }, { wch: 15 }, { wch: 7 },
    { wch: 13 }, { wch: 9 },  { wch: 11 },
    { wch: 13 }, { wch: 9 },  { wch: 11 }, { wch: 26 },
    { wch: 22 }, { wch: 18 }, { wch: 20 }, { wch: 15 }
  ];

  // 所有行高统一设为 50 磅
  ws['!rows'] = [];
  for (let r = 0; r < currentRowIdx; r++) {
    ws['!rows'][r] = { hpt: 50 };
  }

  const centerCols = new Set([0, 1, 3, 4, 5, 6, 7, 8, 11, 12, 13, 15, 17, 20, 21, 22, 24, 25, 27, 28, 30, 31, 32]);
  const moneyCols = new Set([18, 19, 23, 26, 33]);

  for (let r = 0; r < currentRowIdx; r++) {
    for (let c = 0; c < headers.length; c++) {
      const cellRef = XLSX.utils.encode_cell({ r, c });
      if (!ws[cellRef]) ws[cellRef] = { t: 's', v: '' };

      if (r === 0) {
        ws[cellRef].s = {
          font: { name: '微软雅黑', sz: 14, bold: true, color: { rgb: '000000' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: buildBorderSpec(false)
        };
      } else if (r === 1) {
        ws[cellRef].s = {
          font: { name: '微软雅黑', sz: 10, bold: true, color: { rgb: '000000' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: buildBorderSpec(true)
        };
      } else {
        const meta = rowMeta[r];
        const bgRgb = meta.isOddGroup ? 'F8FAFC' : 'FFFFFF';
        const hAlign = moneyCols.has(c) ? 'right' : (centerCols.has(c) ? 'center' : 'left');

        if (meta.isFirstInGroup) {
          if (c === 30 && meta.c.attachment_path) {
            const relUrl = escapeExcelFormulaStr(`uploads/${meta.c.attachment_path}`);
            const label = escapeExcelFormulaStr(meta.scanFileName);
            ws[cellRef] = { t: 's', f: `HYPERLINK("${relUrl}","${label}")`, v: meta.scanFileName };
          } else if (c === 31 && meta.procNo && meta.procFiles.length > 0) {
            const relUrl = escapeExcelFormulaStr(`uploads/${meta.procFiles[0].file_path}`);
            const label = escapeExcelFormulaStr(meta.procNo);
            ws[cellRef] = { t: 's', f: `HYPERLINK("${relUrl}","${label}")`, v: meta.procNo };
          } else if (c === 32 && meta.relFiles.length > 0) {
            const relUrl = escapeExcelFormulaStr(`uploads/${meta.relFiles[0].file_path}`);
            const dispText = meta.relFiles.length === 1
              ? meta.relFiles[0].file_original_name
              : `${meta.relFiles[0].file_original_name} 等${meta.relFiles.length}份`;
            const label = escapeExcelFormulaStr(dispText);
            ws[cellRef] = { t: 's', f: `HYPERLINK("${relUrl}","${label}")`, v: dispText };
          }
        }

        const isHyperlinkCell = Boolean(ws[cellRef].f && String(ws[cellRef].f).startsWith('HYPERLINK'));
        const isMultiTaxCell = c === 20 && String(ws[cellRef].v || '').startsWith('*');

        ws[cellRef].s = {
          font: {
            name: '微软雅黑',
            sz: 10,
            bold: c === 1 || c === 18 || c === 33 || isMultiTaxCell,
            underline: isHyperlinkCell,
            color: { rgb: isHyperlinkCell ? '2563EB' : (isMultiTaxCell ? '92400E' : '0F172A') }
          },
          fill: { fgColor: { rgb: bgRgb } },
          alignment: { horizontal: hAlign, vertical: 'center', wrapText: true },
          border: buildBorderSpec(meta.isGroupBottom),
          ...(moneyCols.has(c) ? { numFmt: '#,##0.00' } : {})
        };
      }
    }
  }

  return ws;
}

/**
 * 采购立项台账 Excel 构建器：
 * - 共 18 列 (索引 0 ~ 17，对应 A ~ R 列)
 * - 第 16 列 (索引 15，P 列：关联合同编号)：只要关联的合同上传了主合同扫描件（attachment_path），
 *   直接在合同编号上生成超链接（显示文字仍为合同编号，点击直接打开合同扫描件）！
 */
function buildProcurementWorksheet(rows) {
  const headers = [
    '序号', '项目立项编号', '项目名称', '立项类型', '费用承担部门',
    '预算金额(元)', '预算科目名称', '采购类型', '采购方式',
    '立项时间', '决策时间', '采购完成时间', '成交供应商全称',
    '成交金额(元)', '是否签合同', '关联合同编号', '备注', '立项相关资料'
  ];

  const aoa = [
    ['企业采购项目立项台账总表'],
    headers
  ];

  rows.forEach(p => {
    const cNo = p.linked_contract ? p.linked_contract.contract_no : (p.contract_no_manual || '');
    const files = p.files || [];
    const fileLabel = files.length > 0
      ? (files.length === 1 ? files[0].file_original_name : `${files[0].file_original_name} 等${files.length}份`)
      : '未上传';
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
      cNo || '-',
      p.remark || '',
      fileLabel
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
  ws['!cols'] = [
    { wch: 11 }, { wch: 16 }, { wch: 20 }, { wch: 12 }, { wch: 14 },
    { wch: 13 }, { wch: 14 }, { wch: 13 }, { wch: 13 },
    { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 18 },
    { wch: 13 }, { wch: 9 },  { wch: 18 }, { wch: 24 }, { wch: 22 }
  ];

  const totalRows = aoa.length;
  ws['!rows'] = [];
  for (let r = 0; r < totalRows; r++) {
    ws['!rows'][r] = { hpt: 50 };
  }

  const centerCols = new Set([0, 1, 3, 4, 6, 7, 8, 9, 10, 11, 14, 15, 17]);
  const moneyCols = new Set([5, 13]);

  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < headers.length; c++) {
      const cellRef = XLSX.utils.encode_cell({ r, c });
      if (!ws[cellRef]) ws[cellRef] = { t: 's', v: '' };

      if (r === 0) {
        ws[cellRef].s = {
          font: { name: '微软雅黑', sz: 14, bold: true, color: { rgb: '000000' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: buildBorderSpec(false)
        };
      } else if (r === 1) {
        ws[cellRef].s = {
          font: { name: '微软雅黑', sz: 10, bold: true, color: { rgb: '000000' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: buildBorderSpec(true)
        };
      } else {
        const pItem = rows[r - 2];
        const isOddRow = (r - 2) % 2 === 1;
        const bgRgb = isOddRow ? 'F8FAFC' : 'FFFFFF';
        const hAlign = moneyCols.has(c) ? 'right' : (centerCols.has(c) ? 'center' : 'left');

        if (c === 15 && pItem.linked_contract) {
          // 优先链接到关联合同的主合同扫描件；若未传主扫描件但有其他资料，则回退链接到第一份其他资料
          const targetContractFile = pItem.linked_contract.attachment_path
            || (pItem.linked_contract.related_files && pItem.linked_contract.related_files[0] && pItem.linked_contract.related_files[0].file_path)
            || '';
          if (targetContractFile) {
            const relUrl = escapeExcelFormulaStr(`uploads/${targetContractFile}`);
            const label = escapeExcelFormulaStr(pItem.linked_contract.contract_no);
            ws[cellRef] = { t: 's', f: `HYPERLINK("${relUrl}","${label}")`, v: pItem.linked_contract.contract_no };
          }
        } else if (c === 17 && pItem.files && pItem.files.length > 0) {
          const relUrl = escapeExcelFormulaStr(`uploads/${pItem.files[0].file_path}`);
          const dispText = pItem.files.length === 1
            ? pItem.files[0].file_original_name
            : `${pItem.files[0].file_original_name} 等${pItem.files.length}份`;
          const label = escapeExcelFormulaStr(dispText);
          ws[cellRef] = { t: 's', f: `HYPERLINK("${relUrl}","${label}")`, v: dispText };
        }

        const isHyperlinkCell = Boolean(ws[cellRef].f && String(ws[cellRef].f).startsWith('HYPERLINK'));
        ws[cellRef].s = {
          font: {
            name: '微软雅黑',
            sz: 10,
            bold: c === 1 || c === 13,
            underline: isHyperlinkCell,
            color: { rgb: isHyperlinkCell ? '2563EB' : '0F172A' }
          },
          fill: { fgColor: { rgb: bgRgb } },
          alignment: { horizontal: hAlign, vertical: 'center', wrapText: true },
          border: buildBorderSpec(false),
          ...(moneyCols.has(c) ? { numFmt: '#,##0.00' } : {})
        };
      }
    }
  }

  return ws;
}

// ==================== 11. Excel 三大导出路由（置于 :id 路由之前，彻底杜绝路由冲突） ====================
app.get('/api/export/excel', (req, res) => {
  try {
    const query = req.query.mode === 'all' ? {} : req.query;
    const rows = queryFilteredContracts(query);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildContractWorksheet(rows), '合同台账');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = encodeURIComponent(`企业合同管理台账_${getLocalTodayStr()}.xlsx`);
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"; filename*=UTF-8''${fname}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).send('导出合同Excel失败: ' + err.message);
  }
});

app.get('/api/procurements/export', (req, res) => {
  try {
    const query = req.query.mode === 'all' ? {} : req.query;
    const rows = queryFilteredProcurements(query);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildProcurementWorksheet(rows), '采购项目台账');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = encodeURIComponent(`企业采购项目立项台账_${getLocalTodayStr()}.xlsx`);
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"; filename*=UTF-8''${fname}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).send('导出采购Excel失败: ' + err.message);
  }
});

app.get('/api/export/combined', (req, res) => {
  try {
    const contractRows = queryFilteredContracts({});
    const procRows = queryFilteredProcurements({});
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildContractWorksheet(contractRows), '合同台账');
    XLSX.utils.book_append_sheet(wb, buildProcurementWorksheet(procRows), '采购项目台账');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = encodeURIComponent(`企业合同与采购项目双台账总表_${getLocalTodayStr()}.xlsx`);
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"; filename*=UTF-8''${fname}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).send('导出合并总表失败: ' + err.message);
  }
});

// ==================== 12. 合同管理 CRUD 与解绑 API ====================
app.get('/api/contracts', (req, res) => {
  try {
    const rows = queryFilteredContracts(req.query);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/contracts/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: '未找到该合同' });
  res.json({ success: true, data: hydrateContractRow(row) });
});

app.post('/api/contracts/:id/unbind-procurement', (req, res) => {
  try {
    const id = Number(req.params.id);
    unbindContractAndProcurement({ contractId: id });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

const contractUploadFields = upload.fields([
  { name: 'attachment', maxCount: 1 },
  { name: 'related_files', maxCount: 30 }
]);

app.post('/api/contracts', contractUploadFields, (req, res) => {
  try {
    const b = req.body;
    const parties = parseCounterpartiesFromBody(b);
    const first = parties[0] || {};
    const totalAmount = parties.reduce((s, p) => s + Number(p.amount || 0), 0);
    const totalExcl = parties.reduce((s, p) => s + Number(p.amount_excl_tax || 0), 0);

    const mainFile = req.files && req.files['attachment'] ? req.files['attachment'][0] : null;
    const relatedFiles = (req.files && req.files['related_files']) || [];

    const signDate = normalizeSmartDateStr(b.sign_date);
    const startDate = normalizeSmartDateStr(b.start_date);
    const expiryDate = normalizeSmartDateStr(b.expiry_date);
    const autoStatus = computeAutoContractStatus(b.status, expiryDate);

    let newId = null;
    let finalContractNo = '';

    const createTx = db.transaction(() => {
      finalContractNo = resolveAvailableNoOnInsert(b.contract_no, {
        tableName: 'contracts',
        colName: 'contract_no',
        dateColName: 'sign_date',
        ruleKey: 'contract_no_rule',
        fallbackRule: DEFAULT_CONTRACT_RULE,
        dateVal: signDate
      });

      const finalMainPath = mainFile ? renameMainScanToMatchContractNo(mainFile.filename, finalContractNo) : '';

      const stmt = db.prepare(`
        INSERT INTO contracts (
          contract_no, contract_name, contract_type, our_entity,
          counterparty, credit_code, contact_person, contact_phone,
          bank_account_name, bank_account_no, bank_name,
          amount, tax_rate, amount_excl_tax, invoice_type, currency,
          sign_date, start_date, expiry_date, status, summary,
          perf_bond_amount, perf_bond_status, perf_bond_return_date,
          warranty_bond_amount, warranty_bond_status, warranty_bond_expiry_date,
          counterparties_json, attachment_path, attachment_original_name, procurement_id, remark
        ) VALUES (
          @contract_no, @contract_name, @contract_type, @our_entity,
          @counterparty, @credit_code, @contact_person, @contact_phone,
          @bank_account_name, @bank_account_no, @bank_name,
          @amount, @tax_rate, @amount_excl_tax, @invoice_type, @currency,
          @sign_date, @start_date, @expiry_date, @status, @summary,
          @perf_bond_amount, @perf_bond_status, @perf_bond_return_date,
          @warranty_bond_amount, @warranty_bond_status, @warranty_bond_expiry_date,
          @counterparties_json, @attachment_path, @attachment_original_name, @procurement_id, @remark
        )
      `);

      const info = stmt.run({
        contract_no: finalContractNo,
        contract_name: (b.contract_name || '').trim(),
        contract_type: b.contract_type || '采购',
        our_entity: (b.our_entity || '').trim(),
        counterparty: parties.map(p => p.company_name).filter(Boolean).join(' / '),
        credit_code: first.credit_code || '',
        contact_person: first.contact_person || '',
        contact_phone: first.contact_phone || '',
        bank_account_name: first.bank_account_name || '',
        bank_account_no: first.bank_account_no || '',
        bank_name: first.bank_name || '',
        amount: totalAmount,
        tax_rate: first.tax_rate || '',
        amount_excl_tax: totalExcl,
        invoice_type: first.invoice_type || '增值税专用发票',
        currency: first.currency || 'CNY',
        sign_date: signDate,
        start_date: startDate,
        expiry_date: expiryDate,
        status: autoStatus,
        summary: parties.map(p => p.summary).filter(Boolean).join('\n'),
        perf_bond_amount: first.perf_bond_amount || 0,
        perf_bond_status: first.perf_bond_status || '无',
        perf_bond_return_date: first.perf_bond_return_date || '',
        warranty_bond_amount: first.warranty_bond_amount || 0,
        warranty_bond_status: first.warranty_bond_status || '无',
        warranty_bond_expiry_date: first.warranty_bond_expiry_date || '',
        counterparties_json: JSON.stringify(parties),
        attachment_path: finalMainPath,
        attachment_original_name: mainFile ? decodeFilename(mainFile.originalname) : '',
        procurement_id: b.procurement_id ? Number(b.procurement_id) : null,
        remark: (b.remark || '').trim()
      });

      newId = info.lastInsertRowid;

      const relStmt = db.prepare(`
        INSERT INTO contract_related_files (contract_id, file_path, file_original_name, file_size)
        VALUES (?, ?, ?, ?)
      `);
      for (const rf of relatedFiles) {
        const relPath = path.relative(UPLOAD_DIR, rf.path).split(path.sep).join('/');
        relStmt.run(newId, relPath, decodeFilename(rf.originalname), rf.size || 0);
      }

      // 新增合同时 allowAutoMatchManual = true，允许自动匹配预填了该合同号的未绑定立项
      syncContractProcurementLink(newId, finalContractNo, b.procurement_id, true);
      recalculateAllSeqNos();
    });

    createTx();
    res.json({ success: true, id: newId, contract_no: finalContractNo });
  } catch (err) {
    cleanupUploadedReqFiles(req);
    res.status(400).json({ success: false, message: err.message });
  }
});

app.put('/api/contracts/:id', contractUploadFields, (req, res) => {
  try {
    const id = Number(req.params.id);
    const old = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(id);
    if (!old) {
      cleanupUploadedReqFiles(req);
      return res.status(404).json({ success: false, message: '记录不存在' });
    }

    const b = req.body;
    const parties = parseCounterpartiesFromBody(b);
    const first = parties[0] || {};
    const totalAmount = parties.reduce((s, p) => s + Number(p.amount || 0), 0);
    const totalExcl = parties.reduce((s, p) => s + Number(p.amount_excl_tax || 0), 0);

    const newContractNo = (b.contract_no || '').trim();
    const mainFile = req.files && req.files['attachment'] ? req.files['attachment'][0] : null;
    const relatedFiles = (req.files && req.files['related_files']) || [];

    const signDate = normalizeSmartDateStr(b.sign_date);
    const startDate = normalizeSmartDateStr(b.start_date);
    const expiryDate = normalizeSmartDateStr(b.expiry_date);
    const autoStatus = computeAutoContractStatus(b.status, expiryDate);

    const updateTx = db.transaction(() => {
      let attachment_path = old.attachment_path;
      let attachment_original_name = old.attachment_original_name;

      if (mainFile) {
        attachment_path = renameMainScanToMatchContractNo(mainFile.filename, newContractNo);
        attachment_original_name = decodeFilename(mainFile.originalname);
      } else if (attachment_path && old.contract_no !== newContractNo) {
        attachment_path = renameMainScanToMatchContractNo(attachment_path, newContractNo);
      }

      db.prepare(`
        UPDATE contracts SET
          contract_no = @contract_no,
          contract_name = @contract_name,
          contract_type = @contract_type,
          our_entity = @our_entity,
          counterparty = @counterparty,
          credit_code = @credit_code,
          contact_person = @contact_person,
          contact_phone = @contact_phone,
          bank_account_name = @bank_account_name,
          bank_account_no = @bank_account_no,
          bank_name = @bank_name,
          amount = @amount,
          tax_rate = @tax_rate,
          amount_excl_tax = @amount_excl_tax,
          invoice_type = @invoice_type,
          currency = @currency,
          sign_date = @sign_date,
          start_date = @start_date,
          expiry_date = @expiry_date,
          status = @status,
          summary = @summary,
          perf_bond_amount = @perf_bond_amount,
          perf_bond_status = @perf_bond_status,
          perf_bond_return_date = @perf_bond_return_date,
          warranty_bond_amount = @warranty_bond_amount,
          warranty_bond_status = @warranty_bond_status,
          warranty_bond_expiry_date = @warranty_bond_expiry_date,
          counterparties_json = @counterparties_json,
          attachment_path = @attachment_path,
          attachment_original_name = @attachment_original_name,
          procurement_id = @procurement_id,
          remark = @remark,
          updated_at = datetime('now', 'localtime')
        WHERE id = @id
      `).run({
        id,
        contract_no: newContractNo,
        contract_name: (b.contract_name || '').trim(),
        contract_type: b.contract_type || '采购',
        our_entity: (b.our_entity || '').trim(),
        counterparty: parties.map(p => p.company_name).filter(Boolean).join(' / '),
        credit_code: first.credit_code || '',
        contact_person: first.contact_person || '',
        contact_phone: first.contact_phone || '',
        bank_account_name: first.bank_account_name || '',
        bank_account_no: first.bank_account_no || '',
        bank_name: first.bank_name || '',
        amount: totalAmount,
        tax_rate: first.tax_rate || '',
        amount_excl_tax: totalExcl,
        invoice_type: first.invoice_type || '增值税专用发票',
        currency: first.currency || 'CNY',
        sign_date: signDate,
        start_date: startDate,
        expiry_date: expiryDate,
        status: autoStatus,
        summary: parties.map(p => p.summary).filter(Boolean).join('\n'),
        perf_bond_amount: first.perf_bond_amount || 0,
        perf_bond_status: first.perf_bond_status || '无',
        perf_bond_return_date: first.perf_bond_return_date || '',
        warranty_bond_amount: first.warranty_bond_amount || 0,
        warranty_bond_status: first.warranty_bond_status || '无',
        warranty_bond_expiry_date: first.warranty_bond_expiry_date || '',
        counterparties_json: JSON.stringify(parties),
        attachment_path,
        attachment_original_name,
        procurement_id: b.procurement_id ? Number(b.procurement_id) : null,
        remark: (b.remark || '').trim()
      });

      const relStmt = db.prepare(`
        INSERT INTO contract_related_files (contract_id, file_path, file_original_name, file_size)
        VALUES (?, ?, ?, ?)
      `);
      for (const rf of relatedFiles) {
        const relPath = path.relative(UPLOAD_DIR, rf.path).split(path.sep).join('/');
        relStmt.run(id, relPath, decodeFilename(rf.originalname), rf.size || 0);
      }

      // 编辑合同时 allowAutoMatchManual = false，若用户清空了关联立项则彻底解绑
      syncContractProcurementLink(id, newContractNo, b.procurement_id, false);
      recalculateAllSeqNos();

      if (mainFile && old.attachment_path && old.attachment_path !== attachment_path) {
        safeUnlinkUploadFile(old.attachment_path);
      }
    });

    updateTx();
    res.json({ success: true });
  } catch (err) {
    cleanupUploadedReqFiles(req);
    const msg = err.message.includes('UNIQUE') ? '该合同编号已存在，请勿重复' : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

app.post('/api/contracts/:id/attachment', upload.single('attachment'), (req, res) => {
  try {
    const old = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
    if (!old || !req.file) {
      cleanupUploadedReqFiles(req);
      return res.status(400).json({ success: false, message: '上传失败' });
    }
    const finalMainPath = renameMainScanToMatchContractNo(req.file.filename, old.contract_no);
    if (old.attachment_path && old.attachment_path !== finalMainPath) {
      safeUnlinkUploadFile(old.attachment_path);
    }
    const origName = decodeFilename(req.file.originalname);
    db.prepare(`
      UPDATE contracts
      SET attachment_path = ?, attachment_original_name = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(finalMainPath, origName, req.params.id);

    res.json({ success: true, attachment_path: finalMainPath, attachment_original_name: origName });
  } catch (err) {
    cleanupUploadedReqFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/contracts/:id/related-files', upload.array('related_files', 30), (req, res) => {
  try {
    const old = db.prepare(`SELECT id FROM contracts WHERE id = ?`).get(req.params.id);
    if (!old) {
      cleanupUploadedReqFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    const files = req.files || [];
    const relStmt = db.prepare(`
      INSERT INTO contract_related_files (contract_id, file_path, file_original_name, file_size)
      VALUES (?, ?, ?, ?)
    `);
    for (const rf of files) {
      const relPath = path.relative(UPLOAD_DIR, rf.path).split(path.sep).join('/');
      relStmt.run(old.id, relPath, decodeFilename(rf.originalname), rf.size || 0);
    }
    syncContractRelatedFolderOnDisk(old.id);
    const allRel = db.prepare(`SELECT * FROM contract_related_files WHERE contract_id = ? ORDER BY id ASC`).all(old.id);
    res.json({ success: true, related_files: allRel });
  } catch (err) {
    cleanupUploadedReqFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/contracts/:id/related-files/:fileId', (req, res) => {
  const fRow = db.prepare(`SELECT * FROM contract_related_files WHERE id = ? AND contract_id = ?`).get(req.params.fileId, req.params.id);
  if (!fRow) return res.status(404).json({ success: false, message: '附件不存在' });
  safeUnlinkUploadFile(fRow.file_path);
  db.prepare(`DELETE FROM contract_related_files WHERE id = ?`).run(fRow.id);
  res.json({ success: true });
});

app.delete('/api/contracts/:id', (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(id);
  if (old) {
    if (old.attachment_path) safeUnlinkUploadFile(old.attachment_path);
    const rels = db.prepare(`SELECT * FROM contract_related_files WHERE contract_id = ?`).all(id);
    for (const r of rels) safeUnlinkUploadFile(r.file_path);
  }
  unbindContractAndProcurement({ contractId: id });
  db.prepare(`DELETE FROM contracts WHERE id = ?`).run(id);
  recalculateAllSeqNos();
  res.json({ success: true });
});

// ==================== 13. 采购项目立项台账 CRUD 与解绑 API ====================
app.get('/api/procurements', (req, res) => {
  try {
    const rows = queryFilteredProcurements(req.query);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/procurements/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM procurement_projects WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: '未找到该采购立项' });
  res.json({ success: true, data: hydrateProcurementRow(row) });
});

app.post('/api/procurements/:id/unbind-contract', (req, res) => {
  try {
    const id = Number(req.params.id);
    unbindContractAndProcurement({ procurementId: id });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/procurements', upload.array('procurement_files', 30), (req, res) => {
  try {
    const b = req.body;
    const files = req.files || [];
    const approvalDate = normalizeSmartDateStr(b.approval_date);
    const decisionDate = normalizeSmartDateStr(b.decision_date);
    const completionDate = normalizeSmartDateStr(b.completion_date);

    let newProcId = null;
    let finalProcNo = '';

    const createProcTx = db.transaction(() => {
      finalProcNo = resolveAvailableNoOnInsert(b.procurement_no, {
        tableName: 'procurement_projects',
        colName: 'procurement_no',
        dateColName: 'approval_date',
        ruleKey: 'procurement_no_rule',
        fallbackRule: DEFAULT_PROC_RULE,
        dateVal: approvalDate
      });

      let targetContractId = b.contract_id ? Number(b.contract_id) : null;
      let manualContractNo = String(b.contract_no_manual || '').trim();

      if (targetContractId) {
        const cRow = db.prepare(`SELECT id, contract_no FROM contracts WHERE id = ?`).get(targetContractId);
        if (cRow) manualContractNo = cRow.contract_no;
      } else if (manualContractNo) {
        const cRow = db.prepare(`SELECT id FROM contracts WHERE contract_no = ?`).get(manualContractNo);
        if (cRow) targetContractId = cRow.id;
      }

      if (targetContractId) {
        // 确保一对一排他：若目标合同此前绑了其他立项，先解除旧立项绑定
        db.prepare(`UPDATE procurement_projects SET contract_id = NULL, contract_no_manual = '', has_contract = '否' WHERE contract_id = ?`).run(targetContractId);
      }

      const info = db.prepare(`
        INSERT INTO procurement_projects (
          procurement_no, project_name, project_type, cost_department,
          budget_amount, budget_subject, procurement_type, procurement_method,
          approval_date, decision_date, completion_date,
          supplier_name, deal_amount, has_contract, contract_id, contract_no_manual, remark
        ) VALUES (
          @procurement_no, @project_name, @project_type, @cost_department,
          @budget_amount, @budget_subject, @procurement_type, @procurement_method,
          @approval_date, @decision_date, @completion_date,
          @supplier_name, @deal_amount, @has_contract, @contract_id, @contract_no_manual, @remark
        )
      `).run({
        procurement_no: finalProcNo,
        project_name: (b.project_name || '').trim(),
        project_type: b.project_type || '服务类项目',
        cost_department: (b.cost_department || '').trim(),
        budget_amount: Number(b.budget_amount || 0),
        budget_subject: (b.budget_subject || '').trim(),
        procurement_type: b.procurement_type || '小额零星采购',
        procurement_method: (b.procurement_method || '合作谈判').trim(),
        approval_date: approvalDate,
        decision_date: decisionDate,
        completion_date: completionDate,
        supplier_name: (b.supplier_name || '').trim(),
        deal_amount: Number(b.deal_amount || 0),
        has_contract: targetContractId ? '是' : (b.has_contract || '否'),
        contract_id: targetContractId,
        contract_no_manual: manualContractNo,
        remark: (b.remark || '').trim()
      });

      newProcId = info.lastInsertRowid;

      if (targetContractId) {
        db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(newProcId, targetContractId);
      }

      const fStmt = db.prepare(`
        INSERT INTO procurement_files (procurement_id, file_path, file_original_name, file_size)
        VALUES (?, ?, ?, ?)
      `);
      for (const pf of files) {
        const relPath = path.relative(UPLOAD_DIR, pf.path).split(path.sep).join('/');
        fStmt.run(newProcId, relPath, decodeFilename(pf.originalname), pf.size || 0);
      }

      recalculateAllProcurementSeqNos();
    });

    createProcTx();
    res.json({ success: true, id: newProcId, procurement_no: finalProcNo });
  } catch (err) {
    cleanupUploadedReqFiles(req);
    res.status(400).json({ success: false, message: err.message });
  }
});

app.put('/api/procurements/:id', upload.array('procurement_files', 30), (req, res) => {
  try {
    const id = Number(req.params.id);
    const old = db.prepare(`SELECT * FROM procurement_projects WHERE id = ?`).get(id);
    if (!old) {
      cleanupUploadedReqFiles(req);
      return res.status(404).json({ success: false, message: '立项记录不存在' });
    }

    const b = req.body;
    const files = req.files || [];
    const approvalDate = normalizeSmartDateStr(b.approval_date);
    const decisionDate = normalizeSmartDateStr(b.decision_date);
    const completionDate = normalizeSmartDateStr(b.completion_date);

    const updateProcTx = db.transaction(() => {
      db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE procurement_id = ?`).run(id);
      if (old.contract_id) {
        db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(old.contract_id);
      }

      let targetContractId = b.contract_id ? Number(b.contract_id) : null;
      let manualContractNo = String(b.contract_no_manual || '').trim();

      if (targetContractId) {
        const cRow = db.prepare(`SELECT id, contract_no FROM contracts WHERE id = ?`).get(targetContractId);
        if (cRow) manualContractNo = cRow.contract_no;
      } else if (manualContractNo) {
        const cRow = db.prepare(`SELECT id FROM contracts WHERE contract_no = ?`).get(manualContractNo);
        if (cRow) targetContractId = cRow.id;
      }

      if (targetContractId) {
        db.prepare(`UPDATE procurement_projects SET contract_id = NULL, contract_no_manual = '', has_contract = '否' WHERE contract_id = ? AND id != ?`).run(targetContractId, id);
      }

      db.prepare(`
        UPDATE procurement_projects SET
          procurement_no = @procurement_no,
          project_name = @project_name,
          project_type = @project_type,
          cost_department = @cost_department,
          budget_amount = @budget_amount,
          budget_subject = @budget_subject,
          procurement_type = @procurement_type,
          procurement_method = @procurement_method,
          approval_date = @approval_date,
          decision_date = @decision_date,
          completion_date = @completion_date,
          supplier_name = @supplier_name,
          deal_amount = @deal_amount,
          has_contract = @has_contract,
          contract_id = @contract_id,
          contract_no_manual = @contract_no_manual,
          remark = @remark,
          updated_at = datetime('now', 'localtime')
        WHERE id = @id
      `).run({
        id,
        procurement_no: (b.procurement_no || '').trim(),
        project_name: (b.project_name || '').trim(),
        project_type: b.project_type || '服务类项目',
        cost_department: (b.cost_department || '').trim(),
        budget_amount: Number(b.budget_amount || 0),
        budget_subject: (b.budget_subject || '').trim(),
        procurement_type: b.procurement_type || '小额零星采购',
        procurement_method: (b.procurement_method || '合作谈判').trim(),
        approval_date: approvalDate,
        decision_date: decisionDate,
        completion_date: completionDate,
        supplier_name: (b.supplier_name || '').trim(),
        deal_amount: Number(b.deal_amount || 0),
        has_contract: targetContractId ? '是' : (b.has_contract || '否'),
        contract_id: targetContractId,
        contract_no_manual: manualContractNo,
        remark: (b.remark || '').trim()
      });

      if (targetContractId) {
        db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(id, targetContractId);
      }

      const fStmt = db.prepare(`
        INSERT INTO procurement_files (procurement_id, file_path, file_original_name, file_size)
        VALUES (?, ?, ?, ?)
      `);
      for (const pf of files) {
        const relPath = path.relative(UPLOAD_DIR, pf.path).split(path.sep).join('/');
        fStmt.run(id, relPath, decodeFilename(pf.originalname), pf.size || 0);
      }

      recalculateAllProcurementSeqNos();
    });

    updateProcTx();
    res.json({ success: true });
  } catch (err) {
    cleanupUploadedReqFiles(req);
    const msg = err.message.includes('UNIQUE') ? '该立项编号已存在，请勿重复' : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

app.post('/api/procurements/:id/files', upload.array('procurement_files', 30), (req, res) => {
  try {
    const old = db.prepare(`SELECT id FROM procurement_projects WHERE id = ?`).get(req.params.id);
    if (!old) {
      cleanupUploadedReqFiles(req);
      return res.status(404).json({ success: false, message: '采购立项不存在' });
    }
    const files = req.files || [];
    const fStmt = db.prepare(`
      INSERT INTO procurement_files (procurement_id, file_path, file_original_name, file_size)
      VALUES (?, ?, ?, ?)
    `);
    for (const pf of files) {
      const relPath = path.relative(UPLOAD_DIR, pf.path).split(path.sep).join('/');
      fStmt.run(old.id, relPath, decodeFilename(pf.originalname), pf.size || 0);
    }
    syncProcurementFolderOnDisk(old.id);
    const allFiles = db.prepare(`SELECT * FROM procurement_files WHERE procurement_id = ? ORDER BY id ASC`).all(old.id);
    res.json({ success: true, files: allFiles });
  } catch (err) {
    cleanupUploadedReqFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/procurements/:id/files/:fileId', (req, res) => {
  const fRow = db.prepare(`SELECT * FROM procurement_files WHERE id = ? AND procurement_id = ?`).get(req.params.fileId, req.params.id);
  if (!fRow) return res.status(404).json({ success: false, message: '文件不存在' });
  safeUnlinkUploadFile(fRow.file_path);
  db.prepare(`DELETE FROM procurement_files WHERE id = ?`).run(fRow.id);
  res.json({ success: true });
});

app.delete('/api/procurements/:id', (req, res) => {
  const id = Number(req.params.id);
  const files = db.prepare(`SELECT * FROM procurement_files WHERE procurement_id = ?`).all(id);
  for (const f of files) safeUnlinkUploadFile(f.file_path);
  unbindContractAndProcurement({ procurementId: id });
  db.prepare(`DELETE FROM procurement_projects WHERE id = ?`).run(id);
  recalculateAllProcurementSeqNos();
  res.json({ success: true });
});

// ==================== 14. 服务启动与优雅退出封装 ====================
let activeServer = null;

function startServer(port = PORT, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    try {
      const srv = app.listen(port, host, () => {
        activeServer = srv;
        const actualPort = srv.address().port;
        console.log(`✅ 台账服务已启动: http://127.0.0.1:${actualPort}`);
        resolve({
          server: srv,
          port: actualPort,
          shutdown: () => new Promise(resClose => {
            srv.close(() => {
              try { db.close(); } catch (e) {}
              resClose();
            });
          })
        });
      });
      srv.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

if (require.main === module) {
  startServer(PORT, '0.0.0.0').catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}

module.exports = { app, db, startServer };
