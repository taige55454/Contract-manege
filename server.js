const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const XLSX = require('xlsx-js-style');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// ==================== 0. 网络层与身份识别辅助函数 ====================

function isLoopbackAddress(ipStr) {
  if (!ipStr) return false;
  const ip = String(ipStr).trim().toLowerCase();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isAllowedLanOrLocalHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname).trim().toLowerCase();
  if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]') return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^[a-z0-9_-]+(\.local)?$/i.test(h)) return true;
  return false;
}

function getHostLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    if (/vmware|virtualbox|vbox|hyper-v|wsl|docker|vethernet|loopback/i.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips.length > 0 ? ips : ['127.0.0.1'];
}

app.use((req, res, next) => {
  const hostHeader = String(req.headers.host || '').replace(/^\[(.*)\](:\d+)?$/, '$1').split(':')[0];
  if (!isAllowedLanOrLocalHost(hostHeader)) {
    return res.status(403).send('Forbidden: LAN or Localhost access only');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// 1. 解析可读写的数据根目录与三大文件物理目录结构
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || __dirname);
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const RELATED_ROOT_DIR = path.join(UPLOAD_DIR, 'related');
const PROCUREMENT_ROOT_DIR = path.join(UPLOAD_DIR, 'procurement');
const TMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.tmp');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(RELATED_ROOT_DIR)) fs.mkdirSync(RELATED_ROOT_DIR, { recursive: true });
if (!fs.existsSync(PROCUREMENT_ROOT_DIR)) fs.mkdirSync(PROCUREMENT_ROOT_DIR, { recursive: true });
if (!fs.existsSync(TMP_UPLOAD_DIR)) fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });

function triggerSafeGC() {
  if (typeof global.gc === 'function') {
    setImmediate(() => {
      try { global.gc(); } catch (e) {}
    });
  }
}

function getLocalTodayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function cleanTmpDir() {
  if (!fs.existsSync(TMP_UPLOAD_DIR)) return;
  try {
    for (const file of fs.readdirSync(TMP_UPLOAD_DIR)) {
      try { fs.unlinkSync(path.join(TMP_UPLOAD_DIR, file)); } catch (e) {}
    }
  } catch (e) {}
}
cleanTmpDir();

// 2. 初始化 SQLite 数据库（开启 WAL + busy_timeout 5000ms 支持内网多机并发写入）
const dbPath = process.env.DB_PATH || path.join(DATA_ROOT, 'database.sqlite');
const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -4000');
db.pragma('mmap_size = 0');

// 默认合同编号规则（支持中间穿插自定义段 default_mid）
const DEFAULT_NO_RULE = JSON.stringify({
  prefix: 'XSZY-黔-BJ-',
  default_mid: '',
  date_part: 'YYYYMM',
  seq_digits: 3,
  suffix: '',
  reset_yearly: true
});

// 默认采购立项编号规则（贴合 LX20260318024 规律：LX + YYYYMMDD + 3位流水号）
const DEFAULT_PROC_NO_RULE = JSON.stringify({
  prefix: 'LX',
  default_mid: '',
  date_part: 'YYYYMMDD',
  seq_digits: 3,
  suffix: '',
  reset_yearly: true
});

function hashPasscode(rawCode) {
  return crypto.createHash('sha256').update(`contract_lan_salt:${String(rawCode)}`).digest('hex');
}

const DEFAULT_LAN_AUTH = JSON.stringify({
  enabled: true,
  passcode_hash: hashPasscode('888888'),
  passcode_plain: '888888'
});

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO app_settings (key, value) VALUES ('default_our_entity', '毕节自营公司');
  INSERT OR IGNORE INTO app_settings (key, value) VALUES ('contract_no_rule', '${DEFAULT_NO_RULE}');
  INSERT OR IGNORE INTO app_settings (key, value) VALUES ('procurement_no_rule', '${DEFAULT_PROC_NO_RULE}');
  INSERT OR IGNORE INTO app_settings (key, value) VALUES ('lan_auth_config', '${DEFAULT_LAN_AUTH}');

  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_year INTEGER DEFAULT 2026,
    seq_no INTEGER DEFAULT 1,
    seq_label TEXT DEFAULT '',
    contract_no TEXT NOT NULL UNIQUE,
    contract_name TEXT NOT NULL,
    contract_summary TEXT DEFAULT '',
    contract_type TEXT NOT NULL CHECK(contract_type IN ('采购', '销售', '框架', '服务', '其他')),
    our_entity TEXT NOT NULL,
    counterparty TEXT NOT NULL,
    counterparties_json TEXT NOT NULL DEFAULT '[]',
    sign_date TEXT NOT NULL,
    start_date TEXT NOT NULL,
    expiry_date TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    amount_excl_tax REAL DEFAULT NULL,
    tax_rate TEXT DEFAULT '',
    invoice_type TEXT DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'CNY',
    perf_bond_amount REAL DEFAULT NULL,
    perf_bond_pay_date TEXT DEFAULT '',
    perf_bond_return_date TEXT DEFAULT '',
    warranty_bond_amount REAL DEFAULT NULL,
    warranty_bond_expiry_date TEXT DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('草稿', '生效中', '已到期', '已终止')),
    remark TEXT DEFAULT '',
    attachment_path TEXT DEFAULT NULL,
    attachment_original_name TEXT DEFAULT NULL,
    related_folder_path TEXT DEFAULT NULL,
    procurement_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS contract_parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    party_index INTEGER NOT NULL DEFAULT 1,
    company_name TEXT NOT NULL,
    credit_code TEXT NOT NULL,
    contact_person TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    bank_account_name TEXT DEFAULT '',
    bank_account_no TEXT DEFAULT '',
    bank_name TEXT DEFAULT '',
    bank_code TEXT DEFAULT '',
    item_summary TEXT DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    amount_excl_tax REAL DEFAULT NULL,
    tax_rate TEXT DEFAULT '',
    invoice_type TEXT DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'CNY',
    perf_bond_amount REAL DEFAULT NULL,
    perf_bond_pay_date TEXT DEFAULT '',
    perf_bond_return_date TEXT DEFAULT '',
    warranty_bond_amount REAL DEFAULT NULL,
    warranty_bond_expiry_date TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contract_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS procurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq_year INTEGER DEFAULT 2026,
    seq_no INTEGER DEFAULT 1,
    seq_label TEXT DEFAULT '',
    procurement_no TEXT NOT NULL UNIQUE,
    project_name TEXT NOT NULL,
    project_type TEXT DEFAULT '服务类项目',
    cost_department TEXT DEFAULT '',
    budget_amount REAL DEFAULT NULL,
    budget_subject TEXT DEFAULT '',
    procurement_type TEXT DEFAULT '小额零星采购',
    procurement_method TEXT DEFAULT '合作谈判',
    approval_date TEXT DEFAULT '',
    decision_date TEXT DEFAULT '',
    completion_date TEXT DEFAULT '',
    supplier_name TEXT DEFAULT '',
    deal_amount REAL DEFAULT NULL,
    has_contract TEXT DEFAULT '否',
    contract_id INTEGER DEFAULT NULL,
    contract_no_manual TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    folder_path TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS procurement_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    procurement_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (procurement_id) REFERENCES procurements(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_contract_no ON contracts(contract_no);
  CREATE INDEX IF NOT EXISTS idx_counterparty ON contracts(counterparty);
  CREATE INDEX IF NOT EXISTS idx_sign_date ON contracts(sign_date);
  CREATE INDEX IF NOT EXISTS idx_expiry_date ON contracts(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_seq_year_no ON contracts(seq_year, seq_no);
  CREATE INDEX IF NOT EXISTS idx_party_contract_id ON contract_parties(contract_id);
  CREATE INDEX IF NOT EXISTS idx_attach_contract_id ON contract_attachments(contract_id);
  CREATE INDEX IF NOT EXISTS idx_proc_no ON procurements(procurement_no);
  CREATE INDEX IF NOT EXISTS idx_proc_contract_id ON procurements(contract_id);
  CREATE INDEX IF NOT EXISTS idx_proc_attach_pid ON procurement_attachments(procurement_id);
`);

function ensureSchemaUpgraded() {
  const contractCols = db.prepare(`PRAGMA table_info(contracts)`).all().map(c => c.name);
  const addContractColIfMissing = (colName, colDef) => {
    if (!contractCols.includes(colName)) {
      db.exec(`ALTER TABLE contracts ADD COLUMN ${colName} ${colDef}`);
    }
  };
  addContractColIfMissing('seq_year', 'INTEGER DEFAULT 2026');
  addContractColIfMissing('seq_no', 'INTEGER DEFAULT 1');
  addContractColIfMissing('seq_label', "TEXT DEFAULT ''");
  addContractColIfMissing('related_folder_path', 'TEXT DEFAULT NULL');
  addContractColIfMissing('procurement_id', 'INTEGER DEFAULT NULL');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contract_proc_id ON contracts(procurement_id)`);

  const partyCols = db.prepare(`PRAGMA table_info(contract_parties)`).all().map(c => c.name);
  const addPartyColIfMissing = (colName, colDef) => {
    if (!partyCols.includes(colName)) {
      db.exec(`ALTER TABLE contract_parties ADD COLUMN ${colName} ${colDef}`);
    }
  };
  addPartyColIfMissing('party_index', 'INTEGER NOT NULL DEFAULT 1');
  addPartyColIfMissing('item_summary', "TEXT DEFAULT ''");
  addPartyColIfMissing('amount', 'REAL NOT NULL DEFAULT 0');
  addPartyColIfMissing('amount_excl_tax', 'REAL DEFAULT NULL');
  addPartyColIfMissing('tax_rate', "TEXT DEFAULT ''");
  addPartyColIfMissing('invoice_type', "TEXT DEFAULT ''");
  addPartyColIfMissing('currency', "TEXT NOT NULL DEFAULT 'CNY'");
  addPartyColIfMissing('perf_bond_amount', 'REAL DEFAULT NULL');
  addPartyColIfMissing('perf_bond_pay_date', "TEXT DEFAULT ''");
  addPartyColIfMissing('perf_bond_return_date', "TEXT DEFAULT ''");
  addPartyColIfMissing('warranty_bond_amount', 'REAL DEFAULT NULL');
  addPartyColIfMissing('warranty_bond_expiry_date', "TEXT DEFAULT ''");
  addPartyColIfMissing('remark', "TEXT DEFAULT ''");

  db.exec(`DELETE FROM contract_parties WHERE contract_id NOT IN (SELECT id FROM contracts)`);
  db.exec(`DELETE FROM contract_attachments WHERE contract_id NOT IN (SELECT id FROM contracts)`);
  db.exec(`DELETE FROM procurement_attachments WHERE procurement_id NOT IN (SELECT id FROM procurements)`);
}
ensureSchemaUpgraded();

// ==================== 高频 SQL 预编译缓存池 ====================
const STMTS = {
  getSetting: db.prepare(`SELECT value FROM app_settings WHERE key = ?`),
  upsertSetting: db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  getAllContractNos: db.prepare(`SELECT contract_no FROM contracts`),
  checkDuplicateNoOnCreate: db.prepare(`SELECT id FROM contracts WHERE contract_no = ?`),
  checkDuplicateNoOnUpdate: db.prepare(`SELECT id FROM contracts WHERE contract_no = ? AND id != ?`),
  getAllForSeq: db.prepare(`SELECT id, sign_date FROM contracts ORDER BY sign_date ASC, id ASC`),
  updateSeq: db.prepare(`UPDATE contracts SET seq_year = ?, seq_no = ?, seq_label = ? WHERE id = ?`),
  getDistinctYears: db.prepare(`SELECT DISTINCT seq_year FROM contracts WHERE seq_year IS NOT NULL ORDER BY seq_year DESC`),
  getContractById: db.prepare(`SELECT * FROM contracts WHERE id = ?`),
  getContractByNo: db.prepare(`SELECT * FROM contracts WHERE contract_no = ?`),
  deleteContractById: db.prepare(`DELETE FROM contracts WHERE id = ?`),
  deletePartiesByContractId: db.prepare(`DELETE FROM contract_parties WHERE contract_id = ?`),
  insertParty: db.prepare(`
    INSERT INTO contract_parties (
      contract_id, party_index, company_name, credit_code, contact_person, contact_phone,
      bank_account_name, bank_account_no, bank_name, bank_code,
      item_summary, amount, amount_excl_tax, tax_rate, invoice_type, currency,
      perf_bond_amount, perf_bond_pay_date, perf_bond_return_date,
      warranty_bond_amount, warranty_bond_expiry_date, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getAllAttachmentPaths: db.prepare(`SELECT attachment_path FROM contracts WHERE attachment_path IS NOT NULL AND attachment_path != ''`),
  getRelatedByContractId: db.prepare(`SELECT * FROM contract_attachments WHERE contract_id = ? ORDER BY id ASC`),
  getAllRelatedRows: db.prepare(`SELECT * FROM contract_attachments ORDER BY id ASC`),
  getRelatedById: db.prepare(`SELECT * FROM contract_attachments WHERE id = ?`),
  insertRelated: db.prepare(`INSERT INTO contract_attachments (contract_id, file_name, file_path, file_size) VALUES (?, ?, ?, ?)`),
  updateRelatedPathById: db.prepare(`UPDATE contract_attachments SET file_path = ? WHERE id = ?`),
  deleteRelatedById: db.prepare(`DELETE FROM contract_attachments WHERE id = ?`),
  deleteRelatedByContractId: db.prepare(`DELETE FROM contract_attachments WHERE contract_id = ?`),
  updateContractRelatedFolder: db.prepare(`UPDATE contracts SET related_folder_path = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`),
  updateContractMainAttachment: db.prepare(`UPDATE contracts SET attachment_path = ?, attachment_original_name = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`),

  // 采购立项预编译语句
  getAllProcNos: db.prepare(`SELECT procurement_no FROM procurements`),
  checkDupProcNoCreate: db.prepare(`SELECT id FROM procurements WHERE procurement_no = ?`),
  checkDupProcNoUpdate: db.prepare(`SELECT id FROM procurements WHERE procurement_no = ? AND id != ?`),
  getAllProcForSeq: db.prepare(`SELECT id, approval_date, procurement_no FROM procurements ORDER BY CASE WHEN approval_date = '' OR approval_date IS NULL THEN 1 ELSE 0 END, approval_date ASC, id ASC`),
  updateProcSeq: db.prepare(`UPDATE procurements SET seq_year = ?, seq_no = ?, seq_label = ? WHERE id = ?`),
  getDistinctProcYears: db.prepare(`SELECT DISTINCT seq_year FROM procurements WHERE seq_year IS NOT NULL ORDER BY seq_year DESC`),
  getProcById: db.prepare(`SELECT * FROM procurements WHERE id = ?`),
  deleteProcById: db.prepare(`DELETE FROM procurements WHERE id = ?`),
  getProcFilesByPid: db.prepare(`SELECT * FROM procurement_attachments WHERE procurement_id = ? ORDER BY id ASC`),
  getAllProcFileRows: db.prepare(`SELECT * FROM procurement_attachments ORDER BY id ASC`),
  getProcFileById: db.prepare(`SELECT * FROM procurement_attachments WHERE id = ?`),
  insertProcFile: db.prepare(`INSERT INTO procurement_attachments (procurement_id, file_name, file_path, file_size) VALUES (?, ?, ?, ?)`),
  updateProcFilePathById: db.prepare(`UPDATE procurement_attachments SET file_path = ? WHERE id = ?`),
  deleteProcFileById: db.prepare(`DELETE FROM procurement_attachments WHERE id = ?`),
  deleteProcFilesByPid: db.prepare(`DELETE FROM procurement_attachments WHERE procurement_id = ?`),
  updateProcFolder: db.prepare(`UPDATE procurements SET folder_path = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
};

// ==================== 内网访问口令鉴权、签名 Cookie 与防暴力破解核心引擎 ====================

const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const AUTH_COOKIE_NAME = 'cm_lan_token';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const loginRateLimitMap = new Map();
const MAX_LOGIN_FAILS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginRateLimitMap.entries()) {
    if (now - record.lastAttempt > LOCKOUT_DURATION_MS) {
      loginRateLimitMap.delete(ip);
    }
  }
}, 10 * 60 * 1000);
if (typeof rateLimitCleanupTimer.unref === 'function') {
  rateLimitCleanupTimer.unref();
}

function getLanAuthConfig() {
  const row = STMTS.getSetting.get('lan_auth_config');
  let parsed = {};
  try { parsed = row ? JSON.parse(row.value) : {}; } catch (e) {}
  const plain = typeof parsed.passcode_plain === 'string' && parsed.passcode_plain.length >= 4
    ? parsed.passcode_plain
    : '888888';
  return {
    enabled: parsed.enabled !== false,
    passcode_hash: parsed.passcode_hash || hashPasscode(plain),
    passcode_plain: plain
  };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
    }
  }
  return out;
}

function createSignedLanToken(passcodeHash) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const pwdFp = passcodeHash.slice(0, 16);
  const payload = `${exp}.${pwdFp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySignedLanToken(token, currentPasscodeHash) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, pwdFp, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  if (pwdFp !== currentPasscodeHash.slice(0, 16)) return false;

  const payload = `${expStr}.${pwdFp}`;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch (e) {
    return false;
  }
}

function isRequestAuthenticated(req) {
  if (isLoopbackAddress(req.socket.remoteAddress)) {
    return { ok: true, isLocalhost: true };
  }
  const cfg = getLanAuthConfig();
  if (!cfg.enabled) {
    return { ok: false, isLocalhost: false, reason: '主机管理员已关闭内网共享访问权限' };
  }
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE_NAME];
  if (verifySignedLanToken(token, cfg.passcode_hash)) {
    return { ok: true, isLocalhost: false };
  }
  return { ok: false, isLocalhost: false, reason: '需要输入内网访问验证口令' };
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// ==================== 鉴权与内网安全管理公开接口 ====================

app.get('/api/auth/status', (req, res) => {
  const auth = isRequestAuthenticated(req);
  const cfg = getLanAuthConfig();
  const currentPort = req.socket.localPort;
  res.json({
    success: true,
    authenticated: auth.ok,
    is_localhost: auth.isLocalhost,
    lan_enabled: cfg.enabled,
    reason: auth.reason || '',
    lan_info: auth.isLocalhost ? {
      enabled: cfg.enabled,
      passcode: cfg.passcode_plain,
      port: currentPort,
      lan_urls: getHostLanIPs().map(ip => `http://${ip}:${currentPort}`)
    } : null
  });
});

app.post('/api/auth/login', (req, res) => {
  const clientIp = String(req.socket.remoteAddress || 'unknown');
  if (isLoopbackAddress(clientIp)) {
    return res.json({ success: true, message: '本机免密直连' });
  }

  const cfg = getLanAuthConfig();
  if (!cfg.enabled) {
    return res.status(403).json({ success: false, message: '主机已关闭内网访问通道，请联系主机管理员开启' });
  }

  const now = Date.now();
  const rateRecord = loginRateLimitMap.get(clientIp) || { fails: 0, lockUntil: 0, lastAttempt: now };
  if (rateRecord.lockUntil > now) {
    const waitMin = Math.ceil((rateRecord.lockUntil - now) / 60000);
    return res.status(429).json({
      success: false,
      message: `口令连续输错次数过多，已触发安全锁定，请 ${waitMin} 分钟后再试`
    });
  }

  const inputCode = String(req.body.passcode || '').trim();
  if (!inputCode) {
    return res.status(400).json({ success: false, message: '请输入内网访问验证口令' });
  }

  const inputHash = hashPasscode(inputCode);
  let isMatch = false;
  try {
    isMatch = crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(cfg.passcode_hash));
  } catch (e) {
    isMatch = false;
  }

  if (!isMatch) {
    rateRecord.fails += 1;
    rateRecord.lastAttempt = now;
    if (rateRecord.fails >= MAX_LOGIN_FAILS) {
      rateRecord.lockUntil = now + LOCKOUT_DURATION_MS;
    }
    loginRateLimitMap.set(clientIp, rateRecord);
    const left = Math.max(0, MAX_LOGIN_FAILS - rateRecord.fails);
    return res.status(401).json({
      success: false,
      message: left > 0
        ? `验证口令错误（还剩 ${left} 次尝试机会）`
        : '验证口令连续错误 5 次，当前 IP 已被临时锁定 15 分钟'
    });
  }

  loginRateLimitMap.delete(clientIp);
  const token = createSignedLanToken(cfg.passcode_hash);
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`
  );
  res.json({ success: true, message: '口令验证通过，欢迎进入合同与采购台账系统' });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ success: true, message: '已锁定并退出当前内网会话' });
});

app.put('/api/settings/lan-security', (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return res.status(403).json({ success: false, message: '安全限制：仅允许在运行服务的本机电脑上修改内网口令与安全设置！' });
  }

  const enabled = req.body.enabled !== false && req.body.enabled !== 'false';
  const newPasscode = String(req.body.passcode || '').trim();
  if (newPasscode.length < 4 || newPasscode.length > 32) {
    return res.status(400).json({ success: false, message: '内网验证口令长度需在 4 ~ 32 位之间' });
  }

  const newConfig = {
    enabled,
    passcode_hash: hashPasscode(newPasscode),
    passcode_plain: newPasscode
  };
  STMTS.upsertSetting.run('lan_auth_config', JSON.stringify(newConfig));
  loginRateLimitMap.clear();

  const currentPort = req.socket.localPort;
  res.json({
    success: true,
    message: '内网安全设置已更新（若修改了口令，此前已登录的其他内网设备需使用新口令重新验证）',
    lan_info: {
      enabled: newConfig.enabled,
      passcode: newConfig.passcode_plain,
      port: currentPort,
      lan_urls: getHostLanIPs().map(ip => `http://${ip}:${currentPort}`)
    }
  });
});

// ==================== 全局安全拦截守卫 ====================

app.use('/uploads', (req, res, next) => {
  const auth = isRequestAuthenticated(req);
  if (!auth.ok) {
    return res.status(401).send('Unauthorized: 请先完成内网访问口令验证后再查看扫描件或立项资料');
  }
  next();
}, express.static(UPLOAD_DIR, {
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.use('/api', (req, res, next) => {
  const auth = isRequestAuthenticated(req);
  if (!auth.ok) {
    return res.status(401).json({
      success: false,
      require_auth: true,
      lan_enabled: getLanAuthConfig().enabled,
      message: auth.reason || '请先输入内网访问验证口令'
    });
  }
  next();
});

// ==================== 文件命名、专属文件夹同步与孤儿垃圾清扫核心函数 ====================

function sanitizeFilenamePart(str, maxLen = 80) {
  if (!str) return '未命名';
  const cleaned = String(str)
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/\.+$/g, '')
    .slice(0, maxLen);
  return cleaned || '未命名';
}

function buildStandardFolderName(noStr, nameStr, dateStr) {
  const safeNo = sanitizeFilenamePart(noStr, 50);
  const safeName = sanitizeFilenamePart(nameStr, 60);
  const safeDate = sanitizeFilenamePart(dateStr || '无日期', 20);
  return `${safeNo}+${safeName}+${safeDate}`;
}

function buildStandardAttachmentName(contractNo, contractName, signDate, ext) {
  const base = buildStandardFolderName(contractNo, contractName, signDate);
  const cleanExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return `${base}${cleanExt}`;
}

function isPathInsideDir(targetFullPath, baseDirPath) {
  const resolvedTarget = path.resolve(targetFullPath);
  const resolvedBase = path.resolve(baseDirPath);
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return resolvedTarget.startsWith(baseWithSep);
}

function removeFileIfExists(relativePath) {
  if (!relativePath) return;
  const fullPath = path.resolve(DATA_ROOT, relativePath);
  if (!isPathInsideDir(fullPath, UPLOAD_DIR)) return;
  if (fs.existsSync(fullPath)) {
    try { fs.unlinkSync(fullPath); } catch (err) { console.error('删除文件失败:', err.message); }
  }
}

function removeFolderIfExists(relativeFolderPath, allowedRootDir = UPLOAD_DIR) {
  if (!relativeFolderPath) return;
  const fullPath = path.resolve(DATA_ROOT, relativeFolderPath);
  if (!isPathInsideDir(fullPath, allowedRootDir)) return;
  if (fs.existsSync(fullPath)) {
    try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch (err) { console.error('删除文件夹失败:', err.message); }
  }
}

function moveFileSafe(srcPath, destPath) {
  const absSrc = path.resolve(srcPath);
  const absDest = path.resolve(destPath);
  if (absSrc === absDest) return;

  const isSameFileIgnoreCase = process.platform === 'win32' && absSrc.toLowerCase() === absDest.toLowerCase();
  if (!isSameFileIgnoreCase && fs.existsSync(absDest)) {
    try { fs.unlinkSync(absDest); } catch (e) {}
  }
  try {
    fs.renameSync(absSrc, absDest);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw new Error('附件或资料文件正被其他软件（如 PDF 阅读器/Word/WPS）打开占用，请先关闭打开的文档后再保存修改！');
    }
    fs.copyFileSync(absSrc, absDest);
    try { fs.unlinkSync(absSrc); } catch (e) {}
  }
}

function moveFolderSafe(oldFolderAbs, newFolderAbs) {
  const absOld = path.resolve(oldFolderAbs);
  const absNew = path.resolve(newFolderAbs);
  if (absOld === absNew || !fs.existsSync(absOld)) return;

  const isSameIgnoreCase = process.platform === 'win32' && absOld.toLowerCase() === absNew.toLowerCase();
  try {
    if (isSameIgnoreCase) {
      const tmpDir = `${absOld}_tmp_${Date.now()}`;
      fs.renameSync(absOld, tmpDir);
      fs.renameSync(tmpDir, absNew);
      return;
    }

    if (!fs.existsSync(absNew)) {
      fs.renameSync(absOld, absNew);
      return;
    }
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw new Error('检测到关联资料或立项资料正被 Word/WPS/资源管理器打开占用，无法同步重命名文件夹！请先关闭打开的文档后再修改。');
    }
  }

  fs.mkdirSync(absNew, { recursive: true });
  for (const item of fs.readdirSync(absOld)) {
    moveFileSafe(path.join(absOld, item), path.join(absNew, item));
  }
  try { fs.rmSync(absOld, { recursive: true, force: true }); } catch (e) {}
}

function finalizeUploadedFile(tempFile, contractNo, contractName, signDate) {
  const ext = path.extname(tempFile.originalname).toLowerCase();
  const standardName = buildStandardAttachmentName(contractNo, contractName, signDate, ext);
  const targetFullPath = path.join(UPLOAD_DIR, standardName);
  moveFileSafe(tempFile.path, targetFullPath);
  return {
    attachment_path: `uploads/${standardName}`,
    attachment_original_name: standardName
  };
}

function archiveRelatedFilesForContract(contractId, contractNo, contractName, signDate, tempFiles) {
  if (!Array.isArray(tempFiles) || tempFiles.length === 0) return null;

  const folderName = buildStandardFolderName(contractNo, contractName, signDate);
  const relFolderPath = `uploads/related/${folderName}`;
  const absFolderPath = path.join(RELATED_ROOT_DIR, folderName);

  if (!fs.existsSync(absFolderPath)) {
    fs.mkdirSync(absFolderPath, { recursive: true });
  }

  for (const f of tempFiles) {
    const ext = path.extname(f.originalname);
    const baseRaw = path.basename(f.originalname, ext);
    const safeBase = sanitizeFilenamePart(baseRaw, 90);
    const safeExt = sanitizeFilenamePart(ext.replace(/^\./, ''), 15);
    const dotExt = safeExt ? `.${safeExt}` : '';

    let finalFileName = `${safeBase}${dotExt}`;
    let counter = 1;
    while (fs.existsSync(path.join(absFolderPath, finalFileName))) {
      finalFileName = `${safeBase}(${counter})${dotExt}`;
      counter++;
    }

    const destFullPath = path.join(absFolderPath, finalFileName);
    moveFileSafe(f.path, destFullPath);
    const relFilePath = `${relFolderPath}/${finalFileName}`;

    STMTS.insertRelated.run(contractId, finalFileName, relFilePath, f.size || 0);
  }

  STMTS.updateContractRelatedFolder.run(relFolderPath, contractId);
  return relFolderPath;
}

function syncRelatedFolderOnContractChange(contractId, oldFolderRelPath, newNo, newName, newSignDate) {
  const existingFiles = STMTS.getRelatedByContractId.all(contractId);
  if (existingFiles.length === 0) {
    if (oldFolderRelPath) {
      removeFolderIfExists(oldFolderRelPath, RELATED_ROOT_DIR);
      STMTS.updateContractRelatedFolder.run(null, contractId);
    }
    return null;
  }

  const expectedFolderName = buildStandardFolderName(newNo, newName, newSignDate);
  const expectedRelFolder = `uploads/related/${expectedFolderName}`;
  const newAbsFolder = path.join(RELATED_ROOT_DIR, expectedFolderName);

  let oldRelFolder = oldFolderRelPath;
  if (!oldRelFolder && existingFiles[0] && existingFiles[0].file_path) {
    oldRelFolder = path.posix.dirname(existingFiles[0].file_path.replace(/\\/g, '/'));
  }

  if (oldRelFolder && oldRelFolder !== expectedRelFolder) {
    const oldAbsFolder = path.resolve(DATA_ROOT, oldRelFolder);
    if (isPathInsideDir(oldAbsFolder, RELATED_ROOT_DIR) && fs.existsSync(oldAbsFolder)) {
      moveFolderSafe(oldAbsFolder, newAbsFolder);
    }
  }

  if (!fs.existsSync(newAbsFolder)) {
    fs.mkdirSync(newAbsFolder, { recursive: true });
  }

  for (const item of existingFiles) {
    const fileName = path.basename(item.file_path);
    const updatedFilePath = `${expectedRelFolder}/${fileName}`;
    if (updatedFilePath !== item.file_path) {
      STMTS.updateRelatedPathById.run(updatedFilePath, item.id);
    }
  }

  STMTS.updateContractRelatedFolder.run(expectedRelFolder, contractId);
  return expectedRelFolder;
}

function archiveFilesForProcurement(procId, procNo, projectName, approvalDate, tempFiles) {
  if (!Array.isArray(tempFiles) || tempFiles.length === 0) return null;

  const folderName = buildStandardFolderName(procNo, projectName, approvalDate || '无日期');
  const relFolderPath = `uploads/procurement/${folderName}`;
  const absFolderPath = path.join(PROCUREMENT_ROOT_DIR, folderName);

  if (!fs.existsSync(absFolderPath)) {
    fs.mkdirSync(absFolderPath, { recursive: true });
  }

  for (const f of tempFiles) {
    const ext = path.extname(f.originalname);
    const baseRaw = path.basename(f.originalname, ext);
    const safeBase = sanitizeFilenamePart(baseRaw, 90);
    const safeExt = sanitizeFilenamePart(ext.replace(/^\./, ''), 15);
    const dotExt = safeExt ? `.${safeExt}` : '';

    let finalFileName = `${safeBase}${dotExt}`;
    let counter = 1;
    while (fs.existsSync(path.join(absFolderPath, finalFileName))) {
      finalFileName = `${safeBase}(${counter})${dotExt}`;
      counter++;
    }

    const destFullPath = path.join(absFolderPath, finalFileName);
    moveFileSafe(f.path, destFullPath);
    const relFilePath = `${relFolderPath}/${finalFileName}`;

    STMTS.insertProcFile.run(procId, finalFileName, relFilePath, f.size || 0);
  }

  STMTS.updateProcFolder.run(relFolderPath, procId);
  return relFolderPath;
}

function syncProcurementFolderOnChange(procId, oldFolderRelPath, newNo, newName, newApprovalDate) {
  const existingFiles = STMTS.getProcFilesByPid.all(procId);
  if (existingFiles.length === 0) {
    if (oldFolderRelPath) {
      removeFolderIfExists(oldFolderRelPath, PROCUREMENT_ROOT_DIR);
      STMTS.updateProcFolder.run(null, procId);
    }
    return null;
  }

  const expectedFolderName = buildStandardFolderName(newNo, newName, newApprovalDate || '无日期');
  const expectedRelFolder = `uploads/procurement/${expectedFolderName}`;
  const newAbsFolder = path.join(PROCUREMENT_ROOT_DIR, expectedFolderName);

  let oldRelFolder = oldFolderRelPath;
  if (!oldRelFolder && existingFiles[0] && existingFiles[0].file_path) {
    oldRelFolder = path.posix.dirname(existingFiles[0].file_path.replace(/\\/g, '/'));
  }

  if (oldRelFolder && oldRelFolder !== expectedRelFolder) {
    const oldAbsFolder = path.resolve(DATA_ROOT, oldRelFolder);
    if (isPathInsideDir(oldAbsFolder, PROCUREMENT_ROOT_DIR) && fs.existsSync(oldAbsFolder)) {
      moveFolderSafe(oldAbsFolder, newAbsFolder);
    }
  }

  if (!fs.existsSync(newAbsFolder)) {
    fs.mkdirSync(newAbsFolder, { recursive: true });
  }

  for (const item of existingFiles) {
    const fileName = path.basename(item.file_path);
    const updatedFilePath = `${expectedRelFolder}/${fileName}`;
    if (updatedFilePath !== item.file_path) {
      STMTS.updateProcFilePathById.run(updatedFilePath, item.id);
    }
  }

  STMTS.updateProcFolder.run(expectedRelFolder, procId);
  return expectedRelFolder;
}

function sweepOrphanUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  try {
    const referencedMainFiles = new Set(
      STMTS.getAllAttachmentPaths.all()
        .map(r => path.basename(String(r.attachment_path)).toLowerCase())
    );
    const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        if (!referencedMainFiles.has(entry.name.toLowerCase())) {
          try { fs.unlinkSync(path.join(UPLOAD_DIR, entry.name)); } catch (e) {}
        }
      }
    }

    const sweepSubDir = (rootDir, allRows) => {
      if (!fs.existsSync(rootDir)) return;
      const referencedSet = new Set(
        allRows.map(r => path.resolve(DATA_ROOT, String(r.file_path)).toLowerCase())
      );
      const folderEntries = fs.readdirSync(rootDir, { withFileTypes: true });
      for (const dirEntry of folderEntries) {
        const fullEntryPath = path.join(rootDir, dirEntry.name);
        if (dirEntry.isFile()) {
          try { fs.unlinkSync(fullEntryPath); } catch (e) {}
        } else if (dirEntry.isDirectory()) {
          const subFiles = fs.readdirSync(fullEntryPath);
          for (const sf of subFiles) {
            const sfFull = path.join(fullEntryPath, sf);
            if (!referencedSet.has(path.resolve(sfFull).toLowerCase())) {
              try { fs.unlinkSync(sfFull); } catch (e) {}
            }
          }
          if (fs.readdirSync(fullEntryPath).length === 0) {
            try { fs.rmSync(fullEntryPath, { recursive: true, force: true }); } catch (e) {}
          }
        }
      }
    };

    sweepSubDir(RELATED_ROOT_DIR, STMTS.getAllRelatedRows.all());
    sweepSubDir(PROCUREMENT_ROOT_DIR, STMTS.getAllProcFileRows.all());
  } catch (e) {}
}
sweepOrphanUploads();

// ==================== 智能日期（支持 Excel 序列号如 46099 / 46115.6313）、智能税率与按年重编 ====================

function smartParseDate(rawInput, fieldLabel = '日期', isRequired = false) {
  if (rawInput === undefined || rawInput === null || String(rawInput).trim() === '') {
    if (isRequired) throw new Error(`${fieldLabel}不能为空`);
    return '';
  }

  const rawTrim = String(rawInput).trim();

  if (/^\d{5}(\.\d+)?$/.test(rawTrim)) {
    const serial = Math.floor(Number(rawTrim));
    if (serial >= 25000 && serial <= 80000) {
      const utcMs = (serial - 25569) * 86400000;
      const dt = new Date(utcMs);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  let s = rawTrim
    .replace(/[年/.。、_]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/\s+/g, '');

  const currentYear = new Date().getFullYear();
  let year, month, day;

  if (/^\d{8}$/.test(s)) {
    year = parseInt(s.slice(0, 4), 10);
    month = parseInt(s.slice(4, 6), 10);
    day = parseInt(s.slice(6, 8), 10);
  } else if (/^(\d{4})-(\d{1,2})-(\d{1,2})$/.test(s)) {
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    year = parseInt(m[1], 10);
    month = parseInt(m[2], 10);
    day = parseInt(m[3], 10);
  } else if (/^(\d{2})-(\d{1,2})-(\d{1,2})$/.test(s)) {
    const m = s.match(/^(\d{2})-(\d{1,2})-(\d{1,2})$/);
    year = 2000 + parseInt(m[1], 10);
    month = parseInt(m[2], 10);
    day = parseInt(m[3], 10);
  } else if (/^(\d{1,2})-(\d{1,2})$/.test(s)) {
    const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
    year = currentYear;
    month = parseInt(m[1], 10);
    day = parseInt(m[2], 10);
  } else {
    throw new Error(`${fieldLabel}格式无法识别（输入值：“${rawInput}”）。支持如 2026-6-3、2026.3.5、简写 6.3 或 Excel 日期序列号 46099`);
  }

  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`${fieldLabel}数值超出有效日历范围（输入值：“${rawInput}”）`);
  }

  const checkDate = new Date(year, month - 1, day);
  if (checkDate.getFullYear() !== year || checkDate.getMonth() + 1 !== month || checkDate.getDate() !== day) {
    throw new Error(`${fieldLabel}不存在该日历天（输入值：“${rawInput}”）`);
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function validateAndNormalizeTaxRate(taxRateRaw) {
  if (taxRateRaw === undefined || taxRateRaw === null || !String(taxRateRaw).trim()) return '';
  let str = String(taxRateRaw).trim()
    .replace(/＊/g, '*')
    .replace(/％/g, '%')
    .replace(/[，、；;/\s]+/g, ',');

  if (str.startsWith('*')) str = str.slice(1);
  const parts = str.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  const formattedParts = parts.map(part => (/^\d+(\.\d+)?$/.test(part) ? `${part}%` : part));
  return formattedParts.length > 1 ? `*${formattedParts.join(',')}` : formattedParts[0];
}

// ==================== 合同编号与采购立项编号通用 4 段夹心式规则引擎 ====================

const ALLOWED_DATE_PARTS = ['NONE', 'YYYY', 'YYYY-', 'YYYYMM', 'YYYYMM-', 'YYYYMMDD', 'YYYYMMDD-'];

function getContractNoRule() {
  const row = STMTS.getSetting.get('contract_no_rule');
  let parsed = {};
  try { parsed = row ? JSON.parse(row.value) : {}; } catch (e) {}
  return {
    prefix: typeof parsed.prefix === 'string' ? parsed.prefix : 'XSZY-黔-BJ-',
    default_mid: typeof parsed.default_mid === 'string' ? parsed.default_mid : '',
    date_part: ALLOWED_DATE_PARTS.includes(parsed.date_part) ? parsed.date_part : 'YYYYMM',
    seq_digits: Number.isInteger(Number(parsed.seq_digits))
      ? Math.min(8, Math.max(0, Number(parsed.seq_digits)))
      : 3,
    suffix: typeof parsed.suffix === 'string' ? parsed.suffix : '',
    reset_yearly: parsed.reset_yearly !== false
  };
}

function getProcurementNoRule() {
  const row = STMTS.getSetting.get('procurement_no_rule');
  let parsed = {};
  try { parsed = row ? JSON.parse(row.value) : {}; } catch (e) {}
  return {
    prefix: typeof parsed.prefix === 'string' ? parsed.prefix : 'LX',
    default_mid: typeof parsed.default_mid === 'string' ? parsed.default_mid : '',
    date_part: ALLOWED_DATE_PARTS.includes(parsed.date_part) ? parsed.date_part : 'YYYYMMDD',
    seq_digits: Number.isInteger(Number(parsed.seq_digits))
      ? Math.min(8, Math.max(0, Number(parsed.seq_digits)))
      : 3,
    suffix: typeof parsed.suffix === 'string' ? parsed.suffix : '',
    reset_yearly: parsed.reset_yearly !== false
  };
}

function formatDateSegment(datePartRule, baseDateStr = '') {
  let targetDate = new Date();
  if (baseDateStr) {
    try {
      const normalized = smartParseDate(baseDateStr);
      if (normalized) targetDate = new Date(normalized + 'T00:00:00');
    } catch (e) {}
  }
  const yyyy = String(targetDate.getFullYear());
  const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getDate()).padStart(2, '0');
  switch (datePartRule) {
    case 'YYYY': return yyyy;
    case 'YYYY-': return `${yyyy}-`;
    case 'YYYYMM': return `${yyyy}${mm}`;
    case 'YYYYMM-': return `${yyyy}${mm}-`;
    case 'YYYYMMDD': return `${yyyy}${mm}${dd}`;
    case 'YYYYMMDD-': return `${yyyy}${mm}${dd}-`;
    case 'NONE':
    default:
      return '';
  }
}

function generateSegmentedNoParts(rule, existingNosList, baseDateStr = '', customMidOverride = null) {
  const prefix = rule.prefix || '';
  const midCustom = customMidOverride !== null ? String(customMidOverride) : (rule.default_mid || '');
  const dateSeg = formatDateSegment(rule.date_part, baseDateStr);
  const suffix = rule.suffix || '';
  const head = `${prefix}${midCustom}${dateSeg}`;
  const tail = suffix;
  const digits = Number(rule.seq_digits || 0);

  let maxSeq = 0;
  for (const no of existingNosList) {
    if (!no || typeof no !== 'string') continue;
    if (no.startsWith(head) && (tail === '' || no.endsWith(tail))) {
      const seqLen = no.length - head.length - tail.length;
      if (seqLen > 0) {
        const seqStr = no.slice(head.length, no.length - tail.length);
        if (/^\d+$/.test(seqStr)) {
          const num = parseInt(seqStr, 10);
          if (num > maxSeq) maxSeq = num;
        }
      }
    }
  }

  let nextSeq = maxSeq + 1;
  let seqDefault = digits > 0 ? String(nextSeq).padStart(digits, '0') : '';
  let fullNo = `${head}${seqDefault}${tail}`;

  if (digits > 0) {
    const existingSet = new Set(existingNosList);
    while (existingSet.has(fullNo)) {
      nextSeq++;
      seqDefault = String(nextSeq).padStart(digits, '0');
      fullNo = `${head}${seqDefault}${tail}`;
    }
  }

  return {
    prefix,
    mid_custom: midCustom,
    date_seg: dateSeg,
    middle_default: seqDefault,
    suffix,
    full_no: fullNo,
    rule
  };
}

function generateNextContractNoParts(customRule = null, signDateStr = '', customMid = null) {
  const rule = customRule || getContractNoRule();
  const allNos = STMTS.getAllContractNos.all().map(r => r.contract_no);
  return generateSegmentedNoParts(rule, allNos, signDateStr, customMid);
}

function generateNextProcurementNoParts(customRule = null, approvalDateStr = '', customMid = null) {
  const rule = customRule || getProcurementNoRule();
  const allNos = STMTS.getAllProcNos.all().map(r => r.procurement_no);
  return generateSegmentedNoParts(rule, allNos, approvalDateStr, customMid);
}

const recalculateAllSequences = db.transaction(() => {
  const rule = getContractNoRule();
  const resetYearly = rule.reset_yearly !== false;
  const rows = STMTS.getAllForSeq.all();

  const yearCounters = {};
  let globalCounter = 0;

  for (const r of rows) {
    const yearMatch = String(r.sign_date || '').match(/^(\d{4})/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

    if (resetYearly) {
      yearCounters[year] = (yearCounters[year] || 0) + 1;
      const seqNo = yearCounters[year];
      const seqLabel = `${year}-${String(seqNo).padStart(3, '0')}`;
      STMTS.updateSeq.run(year, seqNo, seqLabel, r.id);
    } else {
      globalCounter += 1;
      const seqLabel = String(globalCounter).padStart(3, '0');
      STMTS.updateSeq.run(year, globalCounter, seqLabel, r.id);
    }
  }
});

const recalculateProcurementSequences = db.transaction(() => {
  const rule = getProcurementNoRule();
  const resetYearly = rule.reset_yearly !== false;
  const rows = STMTS.getAllProcForSeq.all();
  const yearCounters = {};
  let globalCounter = 0;

  for (const r of rows) {
    let year = new Date().getFullYear();
    const dateMatch = String(r.approval_date || '').match(/^(\d{4})/);
    const noMatch = String(r.procurement_no || '').match(/20\d{2}/);
    if (dateMatch) year = parseInt(dateMatch[1], 10);
    else if (noMatch) year = parseInt(noMatch[0], 10);

    if (resetYearly) {
      yearCounters[year] = (yearCounters[year] || 0) + 1;
      const seqNo = yearCounters[year];
      STMTS.updateProcSeq.run(year, seqNo, String(seqNo), r.id);
    } else {
      globalCounter += 1;
      STMTS.updateProcSeq.run(year, globalCounter, String(globalCounter), r.id);
    }
  }
});

recalculateAllSequences();
recalculateProcurementSequences();

// ==================== 顺序可逆：合同台账 <-> 采购台账 双向自动互锁关联引擎 ====================

function linkContractToProcurement(contractId, contractNo, targetProcId) {
  const cid = Number(contractId);
  const pid = targetProcId ? Number(targetProcId) : null;

  const oldProcs = db.prepare(`SELECT id FROM procurements WHERE contract_id = ?`).all(cid);
  for (const oldP of oldProcs) {
    if (oldP.id !== pid) {
      db.prepare(`UPDATE procurements SET contract_id = NULL WHERE id = ?`).run(oldP.id);
    }
  }

  if (pid) {
    const procRow = STMTS.getProcById.get(pid);
    if (procRow) {
      db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE procurement_id = ? AND id != ?`).run(pid, cid);
      db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(pid, cid);
      db.prepare(`
        UPDATE procurements
        SET contract_id = ?, has_contract = '是', contract_no_manual = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(cid, contractNo, pid);
      return;
    }
  }

  const matchedByNo = db.prepare(`SELECT id FROM procurements WHERE contract_no_manual = ? AND (contract_id IS NULL OR contract_id = ?)`).get(contractNo, cid);
  if (matchedByNo) {
    db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(matchedByNo.id, cid);
    db.prepare(`UPDATE procurements SET contract_id = ?, has_contract = '是' WHERE id = ?`).run(cid, matchedByNo.id);
  } else {
    db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(cid);
  }
}

function linkProcurementToContract(procId, targetContractId, manualContractNo, hasContractFlag) {
  const pid = Number(procId);
  let cid = targetContractId ? Number(targetContractId) : null;
  let finalManualNo = String(manualContractNo || '').trim();
  let finalHasContract = hasContractFlag === '是' ? '是' : '否';

  if (!cid && finalManualNo) {
    const matchedContract = STMTS.getContractByNo.get(finalManualNo);
    if (matchedContract) {
      cid = matchedContract.id;
    }
  }

  const oldContracts = db.prepare(`SELECT id FROM contracts WHERE procurement_id = ?`).all(pid);
  for (const oldC of oldContracts) {
    if (oldC.id !== cid) {
      db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE id = ?`).run(oldC.id);
    }
  }

  if (cid) {
    const cRow = STMTS.getContractById.get(cid);
    if (cRow) {
      db.prepare(`UPDATE procurements SET contract_id = NULL WHERE contract_id = ? AND id != ?`).run(cid, pid);
      db.prepare(`UPDATE contracts SET procurement_id = ? WHERE id = ?`).run(pid, cid);
      finalManualNo = cRow.contract_no;
      finalHasContract = '是';
      db.prepare(`UPDATE procurements SET contract_id = ?, contract_no_manual = ?, has_contract = ? WHERE id = ?`)
        .run(cid, finalManualNo, finalHasContract, pid);
      return;
    }
  }

  db.prepare(`UPDATE procurements SET contract_id = NULL, contract_no_manual = ?, has_contract = ? WHERE id = ?`)
    .run(finalManualNo, finalHasContract, pid);
}

// ==================== 多方解析与文件上传配置 ====================

function parseNullableFloat(val) {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function parseCounterparties(body) {
  let list = [];
  if (body.counterparties_json) {
    try {
      list = typeof body.counterparties_json === 'string'
        ? JSON.parse(body.counterparties_json)
        : body.counterparties_json;
    } catch (e) {
      throw new Error('对方单位多方履约数据格式解析失败');
    }
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('请至少添加一方对方单位及履约明细');
  }

  const normalized = list.map((item, idx) => {
    const company_name = String(item.company_name || '').trim();
    const credit_code = String(item.credit_code || '').trim();
    if (!company_name) throw new Error(`第 ${idx + 1} 个对方单位的“单位名称”不能为空`);
    if (!credit_code) throw new Error(`第 ${idx + 1} 个对方单位（${company_name}）的“统一信用代码”不能为空`);

    const cleanTax = validateAndNormalizeTaxRate(item.tax_rate);
    const amountVal = parseFloat(item.amount);

    const perfPayDate = smartParseDate(item.perf_bond_pay_date, `第 ${idx + 1} 方保证金缴纳时间`, false);
    const perfReturnDate = smartParseDate(item.perf_bond_return_date, `第 ${idx + 1} 方保证金应退时间`, false);
    const warrantyExpiryDate = smartParseDate(item.warranty_bond_expiry_date, `第 ${idx + 1} 方质保金到期时间`, false);

    return {
      party_index: idx + 1,
      company_name,
      credit_code,
      contact_person: String(item.contact_person || '').trim(),
      contact_phone: String(item.contact_phone || '').trim(),
      bank_account_name: String(item.bank_account_name || '').trim(),
      bank_account_no: String(item.bank_account_no || '').trim(),
      bank_name: String(item.bank_name || '').trim(),
      bank_code: String(item.bank_code || '').trim(),
      item_summary: String(item.item_summary || '').trim(),
      amount: Number.isFinite(amountVal) ? amountVal : 0,
      amount_excl_tax: parseNullableFloat(item.amount_excl_tax),
      tax_rate: cleanTax,
      invoice_type: String(item.invoice_type || '').trim(),
      currency: String(item.currency || body.currency || 'CNY').trim(),
      perf_bond_amount: parseNullableFloat(item.perf_bond_amount),
      perf_bond_pay_date: perfPayDate,
      perf_bond_return_date: perfReturnDate,
      warranty_bond_amount: parseNullableFloat(item.warranty_bond_amount),
      warranty_bond_expiry_date: warrantyExpiryDate,
      remark: String(item.remark || '').trim()
    };
  });

  const counterpartySummary = normalized.map(p => p.company_name).join('、');
  const summaryCombined = normalized.map(p => p.item_summary).filter(Boolean).join('；');
  const totalAmount = normalized.reduce((acc, p) => acc + (p.amount || 0), 0);
  const totalExcl = normalized.some(p => p.amount_excl_tax !== null)
    ? normalized.reduce((acc, p) => acc + (p.amount_excl_tax || 0), 0)
    : null;

  const earliestPerfReturn = normalized.map(p => p.perf_bond_return_date).filter(Boolean).sort()[0] || '';
  const earliestWarrantyExpiry = normalized.map(p => p.warranty_bond_expiry_date).filter(Boolean).sort()[0] || '';

  return {
    counterpartySummary,
    summaryCombined,
    totalAmount,
    totalExcl,
    earliestPerfReturn,
    earliestWarrantyExpiry,
    counterpartiesJson: JSON.stringify(normalized),
    counterpartiesList: normalized
  };
}

function decodeUploadFilename(file) {
  if (!file._utf8Decoded) {
    if (/[\u0080-\u00ff]/.test(file.originalname) && !/[\u0100-\uffff]/.test(file.originalname)) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    }
    file._utf8Decoded = true;
  }
  return file.originalname;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const origName = decodeUploadFilename(file);
    const ext = path.extname(origName).toLowerCase();
    cb(null, `tmp_${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`);
  }
});

const MAIN_SCAN_MIMES = ['application/pdf', 'image/jpeg', 'image/png'];
const FORBIDDEN_EXTS = ['.exe', '.bat', '.cmd', '.vbs', '.ps1', '.sh', '.dll', '.com', '.scr', '.msi'];

const uploadContractFiles = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024, files: 35 },
  fileFilter: (req, file, cb) => {
    const decodedName = decodeUploadFilename(file);
    const ext = path.extname(decodedName).toLowerCase();
    if (file.fieldname === 'attachment') {
      if (MAIN_SCAN_MIMES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('主合同扫描件仅支持 PDF、JPG、PNG 格式'));
      }
    } else if (file.fieldname === 'related_files' || file.fieldname === 'procurement_files') {
      if (FORBIDDEN_EXTS.includes(ext)) {
        cb(new Error(`出于安全原因，禁止上传可执行脚本或程序文件 (${ext})`));
      } else {
        cb(null, true);
      }
    } else {
      cb(null, true);
    }
  }
});

function cleanupReqTempFiles(req) {
  if (req.file && req.file.path && fs.existsSync(req.file.path)) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
  }
  if (req.files) {
    const allFiles = Array.isArray(req.files)
      ? req.files
      : Object.values(req.files).flat();
    for (const f of allFiles) {
      if (f && f.path && fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path); } catch (e) {}
      }
    }
  }
}

function buildQuery(queryParams, defaultSortOrder = 'ASC') {
  const {
    contract_no, counterparty, contract_type, status,
    sign_year, date_field, date_from, date_to,
    sort_by, sort_order
  } = queryParams;

  let sql = `SELECT * FROM contracts WHERE 1=1`;
  const params = [];

  if (contract_no && contract_no.trim()) {
    sql += ` AND (seq_label LIKE ? OR contract_no LIKE ? OR contract_name LIKE ? OR contract_summary LIKE ? OR counterparties_json LIKE ?)`;
    const kw = `%${contract_no.trim()}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  if (counterparty && counterparty.trim()) {
    sql += ` AND (counterparty LIKE ? OR our_entity LIKE ? OR counterparties_json LIKE ?)`;
    const cpKw = `%${counterparty.trim()}%`;
    params.push(cpKw, cpKw, cpKw);
  }
  if (contract_type && contract_type.trim()) {
    sql += ` AND contract_type = ?`;
    params.push(contract_type.trim());
  }
  if (status && status.trim()) {
    sql += ` AND status = ?`;
    params.push(status.trim());
  }
  if (sign_year && String(sign_year).trim()) {
    sql += ` AND (seq_year = ? OR sign_date LIKE ?)`;
    const yr = String(sign_year).trim();
    params.push(Number(yr), `${yr}-%`);
  }

  const allowedDateFields = [
    'sign_date', 'start_date', 'expiry_date',
    'perf_bond_return_date', 'warranty_bond_expiry_date'
  ];
  const targetDateCol = allowedDateFields.includes(date_field) ? date_field : 'sign_date';

  if (date_from && String(date_from).trim()) {
    try {
      const cleanFrom = smartParseDate(date_from, '筛选起始日期', false);
      if (cleanFrom) {
        sql += ` AND ${targetDateCol} != '' AND ${targetDateCol} >= ?`;
        params.push(cleanFrom);
      }
    } catch (e) {}
  }

  if (date_to && String(date_to).trim()) {
    try {
      const cleanTo = smartParseDate(date_to, '筛选截止日期', false);
      if (cleanTo) {
        sql += ` AND ${targetDateCol} != '' AND ${targetDateCol} <= ?`;
        params.push(cleanTo);
      }
    } catch (e) {}
  }

  const allowedSortFields = [
    'seq_no', 'sign_date', 'start_date', 'expiry_date',
    'perf_bond_return_date', 'warranty_bond_expiry_date', 'created_at'
  ];
  const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'seq_no';
  const order = sort_order
    ? (sort_order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC')
    : defaultSortOrder;

  if (sortField === 'seq_no') {
    sql += ` ORDER BY seq_year ${order}, seq_no ${order}, id ${order}`;
  } else {
    sql += ` ORDER BY CASE WHEN ${sortField} = '' OR ${sortField} IS NULL THEN 1 ELSE 0 END, ${sortField} ${order}, seq_year ASC, seq_no ASC`;
  }

  return { sql, params };
}

function syncContractParties(contractId, partiesList) {
  STMTS.deletePartiesByContractId.run(contractId);
  for (const p of partiesList) {
    STMTS.insertParty.run(
      contractId, p.party_index, p.company_name, p.credit_code, p.contact_person, p.contact_phone,
      p.bank_account_name, p.bank_account_no, p.bank_name, p.bank_code,
      p.item_summary ? String(p.item_summary).trim() : '',
      p.amount, p.amount_excl_tax, p.tax_rate, p.invoice_type, p.currency,
      p.perf_bond_amount, p.perf_bond_pay_date, p.perf_bond_return_date,
      p.warranty_bond_amount, p.warranty_bond_expiry_date, p.remark
    );
  }
}

function getContractPartiesList(row) {
  let parties = [];
  try { parties = JSON.parse(row.counterparties_json || '[]'); } catch (e) {}
  if (!Array.isArray(parties) || parties.length === 0) {
    parties = [{
      party_index: 1,
      company_name: row.counterparty || '',
      credit_code: '',
      contact_person: '',
      contact_phone: '',
      bank_account_name: '',
      bank_account_no: '',
      bank_name: '',
      bank_code: '',
      item_summary: row.contract_summary || '',
      amount: row.amount || 0,
      amount_excl_tax: row.amount_excl_tax,
      tax_rate: row.tax_rate || '',
      invoice_type: row.invoice_type || '',
      currency: row.currency || 'CNY',
      perf_bond_amount: row.perf_bond_amount,
      perf_bond_pay_date: row.perf_bond_pay_date || '',
      perf_bond_return_date: row.perf_bond_return_date || '',
      warranty_bond_amount: row.warranty_bond_amount,
      warranty_bond_expiry_date: row.warranty_bond_expiry_date || '',
      remark: row.remark || ''
    }];
  }
  return parties;
}

function enrichContractsWithAttachmentsAndProcurement(contractRows) {
  if (!Array.isArray(contractRows) || contractRows.length === 0) return contractRows;

  const allRelated = STMTS.getAllRelatedRows.all();
  const relMap = {};
  for (const item of allRelated) {
    if (!relMap[item.contract_id]) relMap[item.contract_id] = [];
    relMap[item.contract_id].push(item);
  }

  const allProcs = db.prepare(`SELECT id, procurement_no, project_name, approval_date, cost_department, folder_path, contract_id FROM procurements`).all();
  const procById = {};
  const procByContractId = {};
  for (const p of allProcs) {
    procById[p.id] = p;
    if (p.contract_id) procByContractId[p.contract_id] = p;
  }

  const allProcFiles = STMTS.getAllProcFileRows.all();
  const procFilesMap = {};
  for (const pf of allProcFiles) {
    if (!procFilesMap[pf.procurement_id]) procFilesMap[pf.procurement_id] = [];
    procFilesMap[pf.procurement_id].push(pf);
  }

  for (const row of contractRows) {
    row.related_files = relMap[row.id] || [];
    const linkedProc = (row.procurement_id && procById[row.procurement_id])
      ? procById[row.procurement_id]
      : (procByContractId[row.id] || null);

    if (linkedProc) {
      row.procurement_id = linkedProc.id;
      row.linked_procurement = {
        id: linkedProc.id,
        procurement_no: linkedProc.procurement_no,
        project_name: linkedProc.project_name,
        approval_date: linkedProc.approval_date,
        cost_department: linkedProc.cost_department,
        folder_path: linkedProc.folder_path,
        files: procFilesMap[linkedProc.id] || []
      };
    } else {
      row.linked_procurement = null;
    }
  }
  return contractRows;
}

function enrichProcurementsWithFilesAndContract(procRows) {
  if (!Array.isArray(procRows) || procRows.length === 0) return procRows;

  const allProcFiles = STMTS.getAllProcFileRows.all();
  const procFilesMap = {};
  for (const pf of allProcFiles) {
    if (!procFilesMap[pf.procurement_id]) procFilesMap[pf.procurement_id] = [];
    procFilesMap[pf.procurement_id].push(pf);
  }

  const allContracts = db.prepare(`SELECT id, contract_no, contract_name, sign_date, attachment_path, attachment_original_name, procurement_id FROM contracts`).all();
  const contractById = {};
  const contractByProcId = {};
  const contractByNo = {};
  for (const c of allContracts) {
    contractById[c.id] = c;
    if (c.procurement_id) contractByProcId[c.procurement_id] = c;
    if (c.contract_no) contractByNo[c.contract_no] = c;
  }

  for (const row of procRows) {
    row.procurement_files = procFilesMap[row.id] || [];
    const linkedC = (row.contract_id && contractById[row.contract_id])
      ? contractById[row.contract_id]
      : (contractByProcId[row.id] || (row.contract_no_manual ? contractByNo[row.contract_no_manual] : null));

    if (linkedC) {
      row.contract_id = linkedC.id;
      row.linked_contract = {
        id: linkedC.id,
        contract_no: linkedC.contract_no,
        contract_name: linkedC.contract_name,
        sign_date: linkedC.sign_date,
        attachment_path: linkedC.attachment_path,
        attachment_original_name: linkedC.attachment_original_name
      };
    } else {
      row.linked_contract = null;
    }
  }
  return procRows;
}

function dateStrToExcelSerialInt(dateStr) {
  if (!dateStr || !String(dateStr).trim()) return null;
  const m = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utcMs = Date.UTC(y, mo - 1, d);
  return Math.round(utcMs / 86400000) + 25569;
}

// ==================== Excel 报表美观构建引擎（支持单表导出 & 双子表同时导出） ====================

const EXCEL_THIN_BORDER = {
  top:    { style: 'thin', color: { rgb: 'CBD5E1' } },
  bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
  left:   { style: 'thin', color: { rgb: 'CBD5E1' } },
  right:  { style: 'thin', color: { rgb: 'CBD5E1' } }
};

function buildStyledExcelCell(rawVal, spec, bgRgb, linkMeta = null) {
  const baseStyle = {
    font: { name: 'Microsoft YaHei', sz: 10, color: { rgb: '1F2937' } },
    fill: { fgColor: { rgb: bgRgb } },
    alignment: { horizontal: spec.align, vertical: 'center', wrapText: true },
    border: EXCEL_THIN_BORDER
  };

  if (spec.type === 'link') {
    if (linkMeta && linkMeta.relPath) {
      baseStyle.font = {
        name: 'Microsoft YaHei',
        sz: 10,
        bold: true,
        color: { rgb: linkMeta.colorRgb || '2563EB' },
        underline: true
      };
      const safeTarget = String(linkMeta.relPath).replace(/"/g, '""');
      const safeLabel = String(linkMeta.displayText).replace(/"/g, '""');
      return {
        v: linkMeta.displayText,
        t: 's',
        f: `HYPERLINK("${safeTarget}","${safeLabel}")`,
        s: baseStyle
      };
    }
    baseStyle.font.color = { rgb: '9CA3AF' };
    return { v: linkMeta && linkMeta.emptyText ? linkMeta.emptyText : '未上传', t: 's', s: baseStyle };
  }

  if (spec.type === 'code') {
    baseStyle.numFmt = '@';
    return { v: rawVal !== null && rawVal !== undefined ? String(rawVal) : '', t: 's', s: baseStyle };
  }

  if (spec.type === 'money') {
    if (rawVal === null || rawVal === undefined || rawVal === '') return { v: '', t: 's', s: baseStyle };
    const num = Number(rawVal);
    if (Number.isFinite(num)) {
      baseStyle.numFmt = '#,##0.00';
      return { v: num, t: 'n', s: baseStyle };
    }
    return { v: String(rawVal), t: 's', s: baseStyle };
  }

  if (spec.type === 'date') {
    if (!rawVal || !String(rawVal).trim()) return { v: '', t: 's', s: baseStyle };
    const serialInt = dateStrToExcelSerialInt(rawVal);
    if (serialInt !== null) {
      baseStyle.numFmt = 'yyyy-mm-dd';
      return { v: serialInt, t: 'n', s: baseStyle };
    }
    return { v: String(rawVal).trim(), t: 's', s: baseStyle };
  }

  return { v: rawVal !== null && rawVal !== undefined ? String(rawVal) : '', t: 's', s: baseStyle };
}

// 构建第 1 子表：《合同台账》Worksheet（隔行浅蓝灰填充 + 3列超链接）
function buildContractWorksheet(rows) {
  const headers = [
    '序号', '合同编号', '合同名称', '关联采购立项', '合同类型', '我方签约主体', '签订日期', '开始履约日', '合同到期日', '合同状态',
    '履约摘要(分项)', '对方单位名称', '统一信用代码', '联系人', '联系方式', '收款账户名称', '收款账号', '开户行', '开户行号',
    '含税金额', '不含税价', '税率', '发票类型', '币种',
    '履约保证金', '保证金缴纳日', '保证金应退日', '质保金金额', '质保金到期日', '分项备注',
    '合同扫描件(超链接)', '采购立项资料(超链接)', '其他关联资料(超链接)'
  ];

  const colSpecs = [
    { wch: 11, align: 'center', type: 'text' },
    { wch: 22, align: 'center', type: 'text' },
    { wch: 25, align: 'left',   type: 'text' },
    { wch: 25, align: 'left',   type: 'text' },
    { wch: 10, align: 'center', type: 'text' },
    { wch: 22, align: 'left',   type: 'text' },
    { wch: 13, align: 'center', type: 'date' },
    { wch: 13, align: 'center', type: 'date' },
    { wch: 13, align: 'center', type: 'date' },
    { wch: 10, align: 'center', type: 'text' },
    { wch: 26, align: 'left',   type: 'text' },
    { wch: 24, align: 'left',   type: 'text' },
    { wch: 22, align: 'center', type: 'code' },
    { wch: 11, align: 'center', type: 'text' },
    { wch: 15, align: 'center', type: 'code' },
    { wch: 24, align: 'left',   type: 'text' },
    { wch: 24, align: 'center', type: 'code' },
    { wch: 22, align: 'left',   type: 'text' },
    { wch: 16, align: 'center', type: 'code' },
    { wch: 15, align: 'right',  type: 'money' },
    { wch: 15, align: 'right',  type: 'money' },
    { wch: 11, align: 'center', type: 'text' },
    { wch: 15, align: 'center', type: 'text' },
    { wch: 8,  align: 'center', type: 'text' },
    { wch: 14, align: 'right',  type: 'money' },
    { wch: 13, align: 'center', type: 'date' },
    { wch: 13, align: 'center', type: 'date' },
    { wch: 14, align: 'right',  type: 'money' },
    { wch: 13, align: 'center', type: 'date' },
    { wch: 20, align: 'left',   type: 'text' },
    { wch: 32, align: 'center', type: 'link' },
    { wch: 34, align: 'center', type: 'link' },
    { wch: 34, align: 'center', type: 'link' }
  ];

  const bannerText = '💡 【企业合同管理台账】最后三列自带【合同扫描件】、【关联采购立项资料夹】、【合同其他关联资料夹】超链接。请将本 Excel 放置在与【uploads】文件夹同级的目录下，点击即可直接打开对应扫描件或资料夹！';
  const bannerRow = headers.map((_, idx) => ({
    v: idx === 0 ? bannerText : '',
    t: 's',
    s: {
      font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: '92400E' } },
      fill: { fgColor: { rgb: 'FEF3C7' } },
      alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
      border: EXCEL_THIN_BORDER
    }
  }));

  const headerRow = headers.map(h => ({
    v: h,
    t: 's',
    s: {
      font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '1E3A8A' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: EXCEL_THIN_BORDER
    }
  }));

  const aoa = [bannerRow, headerRow];
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
  const mergeColIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 31, 32];
  const rowHeights = [{ hpt: 26 }, { hpt: 28 }];

  let currentRowIdx = 2;

  rows.forEach((row, contractIndex) => {
    const parties = getContractPartiesList(row);
    const startRow = currentRowIdx;
    // 隔行填充柔和浅蓝灰色斑马纹 (F1F5F9 vs FFFFFF)
    const bgRgb = (contractIndex % 2 === 1) ? 'F1F5F9' : 'FFFFFF';

    const scanLinkMeta = row.attachment_path
      ? {
          relPath: row.attachment_path.replace(/\\/g, '/'),
          displayText: `📎 打开扫描件 (${row.attachment_original_name || path.basename(row.attachment_path)})`,
          colorRgb: '2563EB'
        }
      : { emptyText: '无扫描件' };

    const lp = row.linked_procurement;
    const lpFilesCount = lp && Array.isArray(lp.files) ? lp.files.length : 0;
    const lpFolderRel = (lp && lpFilesCount > 0)
      ? (lp.folder_path || `uploads/procurement/${buildStandardFolderName(lp.procurement_no, lp.project_name, lp.approval_date || '无日期')}`).replace(/\\/g, '/')
      : null;

    const procFolderLinkMeta = lpFolderRel
      ? {
          relPath: lpFolderRel,
          displayText: `📑 打开立项资料夹 (${lp.procurement_no} 共${lpFilesCount}份)`,
          colorRgb: '7C3AED'
        }
      : { emptyText: lp ? '立项未传资料' : '未关联立项' };

    const relatedCount = Array.isArray(row.related_files) ? row.related_files.length : 0;
    const folderRelPath = (relatedCount > 0)
      ? (row.related_folder_path || `uploads/related/${buildStandardFolderName(row.contract_no, row.contract_name, row.sign_date)}`).replace(/\\/g, '/')
      : null;

    const relatedFolderLinkMeta = folderRelPath
      ? {
          relPath: folderRelPath,
          displayText: `📂 打开其他附件夹 (共${relatedCount}份: ${path.basename(folderRelPath)})`,
          colorRgb: '0D9488'
        }
      : { emptyText: '无其他附件' };

    const procDisplayStr = lp ? `${lp.procurement_no} (${lp.project_name})` : '-';

    for (const p of parties) {
      const rawValues = [
        row.seq_label || String(row.seq_no || ''),
        row.contract_no,
        row.contract_name,
        procDisplayStr,
        row.contract_type,
        row.our_entity,
        row.sign_date,
        row.start_date || row.sign_date,
        row.expiry_date,
        row.status,
        p.item_summary || row.contract_summary || '',
        p.company_name || '',
        p.credit_code || '',
        p.contact_person || '',
        p.contact_phone || '',
        p.bank_account_name || '',
        p.bank_account_no || '',
        p.bank_name || '',
        p.bank_code || '',
        p.amount !== undefined ? p.amount : row.amount,
        p.amount_excl_tax !== null && p.amount_excl_tax !== undefined ? p.amount_excl_tax : '',
        p.tax_rate || '',
        p.invoice_type || '',
        p.currency || row.currency || 'CNY',
        p.perf_bond_amount !== null && p.perf_bond_amount !== undefined ? p.perf_bond_amount : '',
        p.perf_bond_pay_date || '',
        p.perf_bond_return_date || '',
        p.warranty_bond_amount !== null && p.warranty_bond_amount !== undefined ? p.warranty_bond_amount : '',
        p.warranty_bond_expiry_date || '',
        p.remark || row.remark || '',
        '',
        '',
        ''
      ];

      const styledRow = rawValues.map((val, colIdx) => {
        let meta = null;
        if (colIdx === 30) meta = scanLinkMeta;
        if (colIdx === 31) meta = procFolderLinkMeta;
        if (colIdx === 32) meta = relatedFolderLinkMeta;
        return buildStyledExcelCell(val, colSpecs[colIdx], bgRgb, meta);
      });
      aoa.push(styledRow);
      rowHeights.push({ hpt: 22 });
      currentRowIdx++;
    }

    const endRow = currentRowIdx - 1;
    if (endRow > startRow) {
      for (const colIdx of mergeColIndices) {
        merges.push({ s: { r: startRow, c: colIdx }, e: { r: endRow, c: colIdx } });
      }
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;
  ws['!cols'] = colSpecs.map(c => ({ wch: c.wch }));
  ws['!rows'] = rowHeights;
  return ws;
}

// 构建第 2 子表：《采购项目台账》Worksheet（隔行浅青绿斑马纹填充 + 立项资料夹超链接 + 合同扫描件超链接）
function buildProcurementWorksheet(rows) {
  const headers = [
    '序号', '采购立项编号', '采购项目名称', '立项类型', '费用承担部门',
    '采购预算', '预算科目', '采购类型', '采购方式',
    '立项时间', '采购决策/成交确认时间', '完结时间',
    '成交供应商', '成交金额', '是否签订合同', '合同编号', '备注',
    '立项相关资料(专属文件夹超链接)', '关联合同扫描件(超链接)'
  ];

  const colSpecs = [
    { wch: 8,  align: 'center', type: 'text' },
    { wch: 19, align: 'center', type: 'text' },
    { wch: 30, align: 'left',   type: 'text' },
    { wch: 14, align: 'center', type: 'text' },
    { wch: 18, align: 'center', type: 'text' },
    { wch: 14, align: 'right',  type: 'money' },
    { wch: 18, align: 'center', type: 'text' },
    { wch: 15, align: 'center', type: 'text' },
    { wch: 15, align: 'center', type: 'text' },
    { wch: 13, align: 'center', type: 'date' },
    { wch: 19, align: 'center', type: 'date' },
    { wch: 13, align: 'center', type: 'date' },
    { wch: 28, align: 'left',   type: 'text' },
    { wch: 14, align: 'right',  type: 'money' },
    { wch: 12, align: 'center', type: 'text' },
    { wch: 24, align: 'center', type: 'text' },
    { wch: 22, align: 'left',   type: 'text' },
    { wch: 36, align: 'center', type: 'link' },
    { wch: 34, align: 'center', type: 'link' }
  ];

  const titleRow = headers.map((_, idx) => ({
    v: idx === 0 ? '2026年采购项目立项台账（自带【立项相关资料夹】与【关联合同扫描件】双超链接）' : '',
    t: 's',
    s: {
      font: { name: 'Microsoft YaHei', sz: 12, bold: true, color: { rgb: '115E59' } },
      fill: { fgColor: { rgb: 'CCFBF1' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: EXCEL_THIN_BORDER
    }
  }));

  const headerRow = headers.map(h => ({
    v: h,
    t: 's',
    s: {
      font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '0F766E' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: EXCEL_THIN_BORDER
    }
  }));

  const aoa = [titleRow, headerRow];
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
  const rowHeights = [{ hpt: 28 }, { hpt: 28 }];

  rows.forEach((row, idx) => {
    // 隔行填充浅色斑马纹 (F0FDFA vs FFFFFF)
    const bgRgb = (idx % 2 === 1) ? 'F0FDFA' : 'FFFFFF';
    const procFilesCount = Array.isArray(row.procurement_files) ? row.procurement_files.length : 0;
    const procFolderRel = procFilesCount > 0
      ? (row.folder_path || `uploads/procurement/${buildStandardFolderName(row.procurement_no, row.project_name, row.approval_date || '无日期')}`).replace(/\\/g, '/')
      : null;

    const procLinkMeta = procFolderRel
      ? {
          relPath: procFolderRel,
          displayText: `📑 打开立项资料夹 (共${procFilesCount}份: ${path.basename(procFolderRel)})`,
          colorRgb: '7C3AED'
        }
      : { emptyText: '未上传立项资料' };

    const lc = row.linked_contract;
    const scanLinkMeta = (lc && lc.attachment_path)
      ? {
          relPath: lc.attachment_path.replace(/\\/g, '/'),
          displayText: `📎 打开合同扫描件 (${lc.attachment_original_name || lc.contract_no})`,
          colorRgb: '2563EB'
        }
      : { emptyText: lc ? '合同未传扫描件' : '未关联合同' };

    const displayContractNo = lc ? lc.contract_no : (row.contract_no_manual || '');

    const rawVals = [
      row.seq_no || (idx + 1),
      row.procurement_no,
      row.project_name,
      row.project_type || '',
      row.cost_department || '',
      row.budget_amount !== null && row.budget_amount !== undefined ? row.budget_amount : '',
      row.budget_subject || '',
      row.procurement_type || '',
      row.procurement_method || '',
      row.approval_date || '',
      row.decision_date || '',
      row.completion_date || '',
      row.supplier_name || '',
      row.deal_amount !== null && row.deal_amount !== undefined ? row.deal_amount : '',
      row.has_contract || '否',
      displayContractNo,
      row.remark || '',
      '',
      ''
    ];

    const styledRow = rawVals.map((val, cIdx) => {
      let meta = null;
      if (cIdx === 17) meta = procLinkMeta;
      if (cIdx === 18) meta = scanLinkMeta;
      return buildStyledExcelCell(val, colSpecs[cIdx], bgRgb, meta);
    });

    aoa.push(styledRow);
    rowHeights.push({ hpt: 22 });
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;
  ws['!cols'] = colSpecs.map(c => ({ wch: c.wch }));
  ws['!rows'] = rowHeights;
  return ws;
}

// ==================== 公共下拉选项 & 双台账合并导出接口 ====================

app.get('/api/options/linking', (req, res) => {
  const contracts = db.prepare(`
    SELECT id, contract_no, contract_name, counterparty, amount, sign_date, procurement_id, attachment_path, attachment_original_name
    FROM contracts ORDER BY id DESC
  `).all();
  const procurements = db.prepare(`
    SELECT id, procurement_no, project_name, project_type, cost_department, supplier_name, deal_amount, approval_date, contract_id, contract_no_manual
    FROM procurements ORDER BY id DESC
  `).all();
  res.json({ success: true, contracts, procurements });
});

// 顶部一键同时导出双台账总表（第一子表：合同台账，第二子表：采购项目台账）
app.get('/api/export/combined', (req, res) => {
  let wb = null;
  let wsContract = null;
  let wsProc = null;
  let buffer = null;
  try {
    const cQuery = buildQuery({ sort_by: 'seq_no', sort_order: 'ASC' }, 'ASC');
    const contractRows = enrichContractsWithAttachmentsAndProcurement(db.prepare(cQuery.sql).all(...cQuery.params));

    const pQuery = buildProcurementQuery({ sort_order: 'ASC' });
    const procRows = enrichProcurementsWithFilesAndContract(db.prepare(pQuery.sql).all(...pQuery.params));

    wsContract = buildContractWorksheet(contractRows);
    wsProc = buildProcurementWorksheet(procRows);

    wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsContract, '合同台账');
    XLSX.utils.book_append_sheet(wb, wsProc, '采购项目台账');

    buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileName = encodeURIComponent(`合同与采购项目总台账_${getLocalTodayStr()}.xlsx`);

    wsContract = null;
    wsProc = null;
    wb = null;

    res.on('finish', () => {
      buffer = null;
      triggerSafeGC();
    });

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    wsContract = null;
    wsProc = null;
    wb = null;
    buffer = null;
    triggerSafeGC();
    res.status(500).json({ success: false, message: '合并导出失败: ' + err.message });
  }
});

// ==================== 合同台账与编号规则 API 路由 ====================

app.get('/api/settings/our-entity', (req, res) => {
  const row = STMTS.getSetting.get('default_our_entity');
  res.json({ success: true, default_our_entity: row ? row.value : '' });
});

app.put('/api/settings/our-entity', (req, res) => {
  const val = String(req.body.default_our_entity || '').trim();
  if (!val) return res.status(400).json({ success: false, message: '默认我方主体名称不能为空' });
  STMTS.upsertSetting.run('default_our_entity', val);
  res.json({ success: true, default_our_entity: val, message: '默认我方主体已更新' });
});

app.get('/api/settings/contract-no-rule', (req, res) => {
  const rule = getContractNoRule();
  const parts = generateNextContractNoParts(rule);
  res.json({ success: true, rule, sample_next_no: parts.full_no, parts });
});

app.put('/api/settings/contract-no-rule', (req, res) => {
  const prefix = String(req.body.prefix ?? '').trim();
  const default_mid = String(req.body.default_mid ?? '').trim();
  const suffix = String(req.body.suffix ?? '').trim();
  const date_part = ALLOWED_DATE_PARTS.includes(req.body.date_part) ? req.body.date_part : 'YYYYMM';
  const seq_digits = Number.isInteger(Number(req.body.seq_digits))
    ? Math.min(8, Math.max(0, Number(req.body.seq_digits)))
    : 3;
  const reset_yearly = req.body.reset_yearly !== false && req.body.reset_yearly !== 'false';

  const newRule = { prefix, default_mid, date_part, seq_digits, suffix, reset_yearly };
  STMTS.upsertSetting.run('contract_no_rule', JSON.stringify(newRule));

  recalculateAllSequences();
  const parts = generateNextContractNoParts(newRule);
  res.json({ success: true, rule: newRule, sample_next_no: parts.full_no, parts, message: '合同编号规则已保存' });
});

app.get('/api/settings/procurement-no-rule', (req, res) => {
  const rule = getProcurementNoRule();
  const parts = generateNextProcurementNoParts(rule);
  res.json({ success: true, rule, sample_next_no: parts.full_no, parts });
});

app.put('/api/settings/procurement-no-rule', (req, res) => {
  const prefix = String(req.body.prefix ?? '').trim();
  const default_mid = String(req.body.default_mid ?? '').trim();
  const suffix = String(req.body.suffix ?? '').trim();
  const date_part = ALLOWED_DATE_PARTS.includes(req.body.date_part) ? req.body.date_part : 'YYYYMMDD';
  const seq_digits = Number.isInteger(Number(req.body.seq_digits))
    ? Math.min(8, Math.max(0, Number(req.body.seq_digits)))
    : 3;
  const reset_yearly = req.body.reset_yearly !== false && req.body.reset_yearly !== 'false';

  const newRule = { prefix, default_mid, date_part, seq_digits, suffix, reset_yearly };
  STMTS.upsertSetting.run('procurement_no_rule', JSON.stringify(newRule));

  recalculateProcurementSequences();
  const parts = generateNextProcurementNoParts(newRule);
  res.json({ success: true, rule: newRule, sample_next_no: parts.full_no, parts, message: '采购立项编号规则已保存' });
});

app.get('/api/contracts/next-no', (req, res) => {
  const rule = getContractNoRule();
  const customMid = req.query.mid_custom !== undefined ? req.query.mid_custom : null;
  const parts = generateNextContractNoParts(rule, req.query.sign_date || '', customMid);
  res.json({ success: true, next_no: parts.full_no, parts, rule });
});

app.get('/api/contracts', (req, res) => {
  try {
    const { sql, params } = buildQuery(req.query, 'ASC');
    const rows = enrichContractsWithAttachmentsAndProcurement(db.prepare(sql).all(...params));
    const years = STMTS.getDistinctYears.all().map(r => r.seq_year);
    res.json({ success: true, data: rows, years });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/contracts/export', (req, res) => {
  let ws = null;
  let wb = null;
  let buffer = null;
  try {
    const exportQuery = req.query.scope === 'all'
      ? { sort_by: 'seq_no', sort_order: 'ASC' }
      : { ...req.query, sort_by: 'seq_no', sort_order: 'ASC' };

    const { sql, params } = buildQuery(exportQuery, 'ASC');
    const rows = enrichContractsWithAttachmentsAndProcurement(db.prepare(sql).all(...params));

    ws = buildContractWorksheet(rows);
    wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '合同台账');

    buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileName = encodeURIComponent(`合同台账_${getLocalTodayStr()}.xlsx`);

    ws = null;
    wb = null;

    res.on('finish', () => {
      buffer = null;
      triggerSafeGC();
    });

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    ws = null;
    wb = null;
    buffer = null;
    triggerSafeGC();
    res.status(500).json({ success: false, message: '导出合同台账失败: ' + err.message });
  }
});

app.get('/api/contracts/:id', (req, res) => {
  const row = STMTS.getContractById.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: '未找到该合同记录' });
  enrichContractsWithAttachmentsAndProcurement([row]);
  res.json({ success: true, data: row });
});

const multiUploadFields = uploadContractFiles.fields([
  { name: 'attachment', maxCount: 1 },
  { name: 'related_files', maxCount: 30 }
]);

app.post('/api/contracts', multiUploadFields, (req, res) => {
  let archivedFile = null;
  let createdRelatedFolder = null;
  try {
    const {
      contract_no, contract_name, contract_type, our_entity,
      sign_date, start_date, expiry_date, status, procurement_id
    } = req.body;

    if (!contract_no || !contract_name || !our_entity || !sign_date || !expiry_date) {
      throw new Error('请完整填写必填项（合同编号、名称、我方主体、签订日、到期日）');
    }

    const cleanNo = contract_no.trim();
    const cleanName = contract_name.trim();
    const cleanSignDate = smartParseDate(sign_date, '签订日期', true);
    const cleanStartDate = (start_date && String(start_date).trim())
      ? smartParseDate(start_date, '开始履约日期', true)
      : cleanSignDate;
    const cleanExpiryDate = smartParseDate(expiry_date, '合同到期日期', true);

    if (STMTS.checkDuplicateNoOnCreate.get(cleanNo)) {
      throw new Error('合同编号已存在，请确保唯一性');
    }

    const {
      counterpartySummary, summaryCombined, totalAmount, totalExcl,
      earliestPerfReturn, earliestWarrantyExpiry, counterpartiesJson, counterpartiesList
    } = parseCounterparties(req.body);

    const firstParty = counterpartiesList[0];
    const mainTempFile = (req.files && req.files.attachment && req.files.attachment[0]) ? req.files.attachment[0] : null;
    const relatedTempFiles = (req.files && req.files.related_files) ? req.files.related_files : [];

    const createTx = db.transaction(() => {
      const stmt = db.prepare(`
        INSERT INTO contracts (
          contract_no, contract_name, contract_summary, contract_type,
          our_entity, counterparty, counterparties_json,
          sign_date, start_date, expiry_date,
          amount, amount_excl_tax, tax_rate, invoice_type, currency,
          perf_bond_amount, perf_bond_pay_date, perf_bond_return_date,
          warranty_bond_amount, warranty_bond_expiry_date,
          status, remark, attachment_path, attachment_original_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const info = stmt.run(
        cleanNo, cleanName, summaryCombined, contract_type,
        our_entity.trim(), counterpartySummary, counterpartiesJson,
        cleanSignDate, cleanStartDate, cleanExpiryDate,
        totalAmount, totalExcl, firstParty.tax_rate, firstParty.invoice_type, firstParty.currency,
        firstParty.perf_bond_amount, firstParty.perf_bond_pay_date, earliestPerfReturn,
        firstParty.warranty_bond_amount, earliestWarrantyExpiry,
        status || '生效中', firstParty.remark,
        null, null
      );

      const newContractId = info.lastInsertRowid;
      syncContractParties(newContractId, counterpartiesList);
      linkContractToProcurement(newContractId, cleanNo, procurement_id);

      if (mainTempFile) {
        archivedFile = finalizeUploadedFile(mainTempFile, cleanNo, cleanName, cleanSignDate);
        STMTS.updateContractMainAttachment.run(
          archivedFile.attachment_path,
          archivedFile.attachment_original_name,
          newContractId
        );
      }

      if (relatedTempFiles.length > 0) {
        createdRelatedFolder = archiveRelatedFilesForContract(
          newContractId,
          cleanNo,
          cleanName,
          cleanSignDate,
          relatedTempFiles
        );
      }

      recalculateAllSequences();
      return newContractId;
    });

    const newId = createTx();
    if (mainTempFile || relatedTempFiles.length > 0) triggerSafeGC();
    res.json({ success: true, id: newId, message: '合同新增成功' });
  } catch (err) {
    cleanupReqTempFiles(req);
    if (archivedFile) removeFileIfExists(archivedFile.attachment_path);
    if (createdRelatedFolder) removeFolderIfExists(createdRelatedFolder, RELATED_ROOT_DIR);

    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, message: '合同编号已存在，请确保唯一性' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

app.put('/api/contracts/:id', multiUploadFields, (req, res) => {
  try {
    const existing = STMTS.getContractById.get(req.params.id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }

    const {
      contract_no, contract_name, contract_type, our_entity,
      sign_date, start_date, expiry_date, status, procurement_id
    } = req.body;

    if (!contract_no || !contract_name || !our_entity || !sign_date || !expiry_date) {
      throw new Error('请完整填写必填项（合同编号、名称、我方主体、签订日、到期日）');
    }

    const cleanNo = contract_no.trim();
    const cleanName = contract_name.trim();
    const cleanSignDate = smartParseDate(sign_date, '签订日期', true);
    const cleanStartDate = (start_date && String(start_date).trim())
      ? smartParseDate(start_date, '开始履约日期', true)
      : cleanSignDate;
    const cleanExpiryDate = smartParseDate(expiry_date, '合同到期日期', true);

    if (STMTS.checkDuplicateNoOnUpdate.get(cleanNo, req.params.id)) {
      throw new Error('合同编号已被其他记录占用，请修改后重试');
    }

    const {
      counterpartySummary, summaryCombined, totalAmount, totalExcl,
      earliestPerfReturn, earliestWarrantyExpiry, counterpartiesJson, counterpartiesList
    } = parseCounterparties(req.body);

    const firstParty = counterpartiesList[0];
    const mainTempFile = (req.files && req.files.attachment && req.files.attachment[0]) ? req.files.attachment[0] : null;
    const relatedTempFiles = (req.files && req.files.related_files) ? req.files.related_files : [];

    const updateTx = db.transaction(() => {
      db.prepare(`
        UPDATE contracts SET
          contract_no = ?, contract_name = ?, contract_summary = ?, contract_type = ?,
          our_entity = ?, counterparty = ?, counterparties_json = ?,
          sign_date = ?, start_date = ?, expiry_date = ?,
          amount = ?, amount_excl_tax = ?, tax_rate = ?, invoice_type = ?, currency = ?,
          perf_bond_amount = ?, perf_bond_pay_date = ?, perf_bond_return_date = ?,
          warranty_bond_amount = ?, warranty_bond_expiry_date = ?,
          status = ?, remark = ?,
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        cleanNo, cleanName, summaryCombined, contract_type,
        our_entity.trim(), counterpartySummary, counterpartiesJson,
        cleanSignDate, cleanStartDate, cleanExpiryDate,
        totalAmount, totalExcl, firstParty.tax_rate, firstParty.invoice_type, firstParty.currency,
        firstParty.perf_bond_amount, firstParty.perf_bond_pay_date, earliestPerfReturn,
        firstParty.warranty_bond_amount, earliestWarrantyExpiry,
        status, firstParty.remark,
        req.params.id
      );

      linkContractToProcurement(Number(req.params.id), cleanNo, procurement_id);

      syncRelatedFolderOnContractChange(
        Number(req.params.id),
        existing.related_folder_path,
        cleanNo,
        cleanName,
        cleanSignDate
      );

      let attachment_path = existing.attachment_path;
      let attachment_original_name = existing.attachment_original_name;

      if (mainTempFile) {
        removeFileIfExists(existing.attachment_path);
        const newlyArchived = finalizeUploadedFile(mainTempFile, cleanNo, cleanName, cleanSignDate);
        attachment_path = newlyArchived.attachment_path;
        attachment_original_name = newlyArchived.attachment_original_name;
      } else if (existing.attachment_path) {
        const oldFullPath = path.resolve(DATA_ROOT, existing.attachment_path);
        if (fs.existsSync(oldFullPath)) {
          const ext = path.extname(oldFullPath);
          const expectedName = buildStandardAttachmentName(cleanNo, cleanName, cleanSignDate, ext);
          const expectedRelPath = `uploads/${expectedName}`;
          if (expectedRelPath !== existing.attachment_path) {
            const newFullPath = path.join(UPLOAD_DIR, expectedName);
            moveFileSafe(oldFullPath, newFullPath);
            attachment_path = expectedRelPath;
            attachment_original_name = expectedName;
          }
        }
      }

      STMTS.updateContractMainAttachment.run(attachment_path, attachment_original_name, req.params.id);

      if (relatedTempFiles.length > 0) {
        archiveRelatedFilesForContract(
          Number(req.params.id),
          cleanNo,
          cleanName,
          cleanSignDate,
          relatedTempFiles
        );
      }

      syncContractParties(req.params.id, counterpartiesList);
      recalculateAllSequences();
    });

    updateTx();
    if (mainTempFile || relatedTempFiles.length > 0) triggerSafeGC();
    res.json({ success: true, message: '合同更新成功' });
  } catch (err) {
    cleanupReqTempFiles(req);
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, message: '合同编号已被其他记录占用' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/contracts/:id', (req, res) => {
  const existing = STMTS.getContractById.get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });

  const relatedFolder = existing.related_folder_path ||
    `uploads/related/${buildStandardFolderName(existing.contract_no, existing.contract_name, existing.sign_date)}`;

  const deleteTx = db.transaction(() => {
    db.prepare(`UPDATE procurements SET contract_id = NULL WHERE contract_id = ?`).run(req.params.id);
    STMTS.deleteRelatedByContractId.run(req.params.id);
    STMTS.deletePartiesByContractId.run(req.params.id);
    STMTS.deleteContractById.run(req.params.id);
    recalculateAllSequences();
  });
  deleteTx();

  removeFileIfExists(existing.attachment_path);
  removeFolderIfExists(relatedFolder, RELATED_ROOT_DIR);

  res.json({ success: true, message: '合同、扫描件及合同其他关联资料已删除（采购立项记录本身保留）' });
});

// ==================== 主合同扫描件 & 合同其他关联资料独立接口 ====================

app.post('/api/contracts/:id/attachment', uploadContractFiles.single('attachment'), (req, res) => {
  try {
    const existing = STMTS.getContractById.get(req.params.id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    if (!req.file) return res.status(400).json({ success: false, message: '请选择要上传的扫描件' });

    removeFileIfExists(existing.attachment_path);
    const archived = finalizeUploadedFile(
      req.file,
      existing.contract_no,
      existing.contract_name,
      existing.sign_date
    );

    STMTS.updateContractMainAttachment.run(archived.attachment_path, archived.attachment_original_name, req.params.id);

    triggerSafeGC();
    res.json({ success: true, message: '扫描件已按规范命名归档', data: archived });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/contracts/:id/attachment', (req, res) => {
  const existing = STMTS.getContractById.get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });

  removeFileIfExists(existing.attachment_path);
  STMTS.updateContractMainAttachment.run(null, null, req.params.id);

  res.json({ success: true, message: '扫描件已移除' });
});

app.get('/api/contracts/:id/download', (req, res) => {
  const existing = STMTS.getContractById.get(req.params.id);
  if (!existing || !existing.attachment_path) {
    return res.status(404).send('该合同尚未上传扫描件');
  }
  const fullPath = path.resolve(DATA_ROOT, existing.attachment_path);
  if (!isPathInsideDir(fullPath, UPLOAD_DIR) || !fs.existsSync(fullPath)) {
    return res.status(404).send('扫描件物理文件不存在');
  }
  res.download(fullPath, existing.attachment_original_name);
});

app.post('/api/contracts/:id/related', uploadContractFiles.array('related_files', 30), (req, res) => {
  try {
    const existing = STMTS.getContractById.get(req.params.id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: '请选择至少一份关联资料文件' });
    }

    const tx = db.transaction(() => {
      return archiveRelatedFilesForContract(
        existing.id,
        existing.contract_no,
        existing.contract_name,
        existing.sign_date,
        req.files
      );
    });
    const folderPath = tx();
    triggerSafeGC();

    res.json({
      success: true,
      message: `已成功归档 ${req.files.length} 份关联资料至专属文件夹`,
      related_folder_path: folderPath,
      related_files: STMTS.getRelatedByContractId.all(existing.id)
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/contracts/:id/related/:attId/download', (req, res) => {
  const att = STMTS.getRelatedById.get(req.params.attId);
  if (!att || String(att.contract_id) !== String(req.params.id)) {
    return res.status(404).send('未找到该关联资料记录');
  }
  const fullPath = path.resolve(DATA_ROOT, att.file_path);
  if (!isPathInsideDir(fullPath, RELATED_ROOT_DIR) || !fs.existsSync(fullPath)) {
    return res.status(404).send('关联资料物理文件不存在');
  }
  res.download(fullPath, att.file_name);
});

app.delete('/api/contracts/:id/related/:attId', (req, res) => {
  const existing = STMTS.getContractById.get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });

  const att = STMTS.getRelatedById.get(req.params.attId);
  if (!att || String(att.contract_id) !== String(req.params.id)) {
    return res.status(404).json({ success: false, message: '未找到该关联资料' });
  }

  removeFileIfExists(att.file_path);
  STMTS.deleteRelatedById.run(att.id);

  const remaining = STMTS.getRelatedByContractId.all(existing.id);
  if (remaining.length === 0) {
    const folderPath = existing.related_folder_path || path.posix.dirname(att.file_path.replace(/\\/g, '/'));
    removeFolderIfExists(folderPath, RELATED_ROOT_DIR);
    STMTS.updateContractRelatedFolder.run(null, existing.id);
  }

  res.json({ success: true, message: '该份关联资料已删除' });
});

// ==================== 采购项目立项台账全套 API 路由 ====================

function buildProcurementQuery(queryParams) {
  const { keyword, project_type, cost_department, has_contract, year, sort_order } = queryParams || {};
  let sql = `SELECT * FROM procurements WHERE 1=1`;
  const params = [];

  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim()}%`;
    sql += ` AND (procurement_no LIKE ? OR project_name LIKE ? OR supplier_name LIKE ? OR budget_subject LIKE ? OR contract_no_manual LIKE ? OR remark LIKE ?)`;
    params.push(kw, kw, kw, kw, kw, kw);
  }
  if (project_type && project_type.trim()) {
    sql += ` AND project_type = ?`;
    params.push(project_type.trim());
  }
  if (cost_department && cost_department.trim()) {
    sql += ` AND cost_department LIKE ?`;
    params.push(`%${cost_department.trim()}%`);
  }
  if (has_contract && has_contract.trim()) {
    sql += ` AND has_contract = ?`;
    params.push(has_contract.trim());
  }
  if (year && String(year).trim()) {
    const yr = String(year).trim();
    sql += ` AND (seq_year = ? OR approval_date LIKE ?)`;
    params.push(Number(yr), `${yr}-%`);
  }

  const order = (sort_order && sort_order.toUpperCase() === 'DESC') ? 'DESC' : 'ASC';
  sql += ` ORDER BY seq_year ${order}, seq_no ${order}, id ${order}`;
  return { sql, params };
}

app.get('/api/procurements/next-no', (req, res) => {
  const rule = getProcurementNoRule();
  const customMid = req.query.mid_custom !== undefined ? req.query.mid_custom : null;
  const parts = generateNextProcurementNoParts(rule, req.query.approval_date || '', customMid);
  res.json({ success: true, next_no: parts.full_no, parts, rule });
});

app.get('/api/procurements', (req, res) => {
  try {
    const { sql, params } = buildProcurementQuery(req.query);
    const rows = enrichProcurementsWithFilesAndContract(db.prepare(sql).all(...params));
    const years = STMTS.getDistinctProcYears.all().map(r => r.seq_year);
    res.json({ success: true, data: rows, years });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/procurements/export', (req, res) => {
  let ws = null;
  let wb = null;
  let buffer = null;
  try {
    const exportQuery = req.query.scope === 'all' ? { sort_order: 'ASC' } : { ...req.query, sort_order: 'ASC' };
    const { sql, params } = buildProcurementQuery(exportQuery);
    const rows = enrichProcurementsWithFilesAndContract(db.prepare(sql).all(...params));

    ws = buildProcurementWorksheet(rows);
    wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '采购项目台账');

    buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileName = encodeURIComponent(`采购项目台账_${getLocalTodayStr()}.xlsx`);

    ws = null;
    wb = null;

    res.on('finish', () => {
      buffer = null;
      triggerSafeGC();
    });

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    ws = null;
    wb = null;
    buffer = null;
    triggerSafeGC();
    res.status(500).json({ success: false, message: '导出采购台账失败: ' + err.message });
  }
});

app.get('/api/procurements/:id', (req, res) => {
  const row = STMTS.getProcById.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: '未找到该采购立项记录' });
  enrichProcurementsWithFilesAndContract([row]);
  res.json({ success: true, data: row });
});

app.post('/api/procurements', uploadContractFiles.array('procurement_files', 30), (req, res) => {
  let createdProcFolder = null;
  try {
    const {
      procurement_no, project_name, project_type, cost_department,
      budget_amount, budget_subject, procurement_type, procurement_method,
      approval_date, decision_date, completion_date,
      supplier_name, deal_amount, has_contract, contract_id, contract_no_manual, remark
    } = req.body;

    if (!procurement_no || !project_name) {
      throw new Error('请填写必填项：采购立项编号、采购项目名称');
    }

    const cleanNo = procurement_no.trim();
    const cleanName = project_name.trim();
    if (STMTS.checkDupProcNoCreate.get(cleanNo)) {
      throw new Error('采购立项编号已存在，请确保唯一性');
    }

    const cleanApprovalDate = smartParseDate(approval_date, '立项时间', false);
    const cleanDecisionDate = smartParseDate(decision_date, '采购决策/成交确认时间', false);
    const cleanCompletionDate = smartParseDate(completion_date, '完结时间', false);

    const tempFiles = req.files || [];

    const createTx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO procurements (
          procurement_no, project_name, project_type, cost_department,
          budget_amount, budget_subject, procurement_type, procurement_method,
          approval_date, decision_date, completion_date,
          supplier_name, deal_amount, has_contract, contract_no_manual, remark
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cleanNo,
        cleanName,
        String(project_type || '服务类项目').trim(),
        String(cost_department || '').trim(),
        parseNullableFloat(budget_amount),
        String(budget_subject || '').trim(),
        String(procurement_type || '小额零星采购').trim(),
        String(procurement_method || '合作谈判').trim(),
        cleanApprovalDate,
        cleanDecisionDate,
        cleanCompletionDate,
        String(supplier_name || '').trim(),
        parseNullableFloat(deal_amount),
        has_contract === '是' ? '是' : '否',
        String(contract_no_manual || '').trim(),
        String(remark || '').trim()
      );

      const newProcId = info.lastInsertRowid;

      linkProcurementToContract(newProcId, contract_id, contract_no_manual, has_contract);

      if (tempFiles.length > 0) {
        createdProcFolder = archiveFilesForProcurement(
          newProcId,
          cleanNo,
          cleanName,
          cleanApprovalDate,
          tempFiles
        );
      }

      recalculateProcurementSequences();
      return newProcId;
    });

    const newId = createTx();
    if (tempFiles.length > 0) triggerSafeGC();
    res.json({ success: true, id: newId, message: '采购立项新增成功' });
  } catch (err) {
    cleanupReqTempFiles(req);
    if (createdProcFolder) removeFolderIfExists(createdProcFolder, PROCUREMENT_ROOT_DIR);
    res.status(400).json({ success: false, message: err.message });
  }
});

app.put('/api/procurements/:id', uploadContractFiles.array('procurement_files', 30), (req, res) => {
  try {
    const existing = STMTS.getProcById.get(req.params.id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '未找到该采购立项记录' });
    }

    const {
      procurement_no, project_name, project_type, cost_department,
      budget_amount, budget_subject, procurement_type, procurement_method,
      approval_date, decision_date, completion_date,
      supplier_name, deal_amount, has_contract, contract_id, contract_no_manual, remark
    } = req.body;

    if (!procurement_no || !project_name) {
      throw new Error('请填写必填项：采购立项编号、采购项目名称');
    }

    const cleanNo = procurement_no.trim();
    const cleanName = project_name.trim();
    if (STMTS.checkDupProcNoUpdate.get(cleanNo, req.params.id)) {
      throw new Error('采购立项编号已被其他记录占用');
    }

    const cleanApprovalDate = smartParseDate(approval_date, '立项时间', false);
    const cleanDecisionDate = smartParseDate(decision_date, '采购决策/成交确认时间', false);
    const cleanCompletionDate = smartParseDate(completion_date, '完结时间', false);
    const tempFiles = req.files || [];

    const updateTx = db.transaction(() => {
      db.prepare(`
        UPDATE procurements SET
          procurement_no = ?, project_name = ?, project_type = ?, cost_department = ?,
          budget_amount = ?, budget_subject = ?, procurement_type = ?, procurement_method = ?,
          approval_date = ?, decision_date = ?, completion_date = ?,
          supplier_name = ?, deal_amount = ?, remark = ?,
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        cleanNo,
        cleanName,
        String(project_type || '服务类项目').trim(),
        String(cost_department || '').trim(),
        parseNullableFloat(budget_amount),
        String(budget_subject || '').trim(),
        String(procurement_type || '小额零星采购').trim(),
        String(procurement_method || '合作谈判').trim(),
        cleanApprovalDate,
        cleanDecisionDate,
        cleanCompletionDate,
        String(supplier_name || '').trim(),
        parseNullableFloat(deal_amount),
        String(remark || '').trim(),
        req.params.id
      );

      linkProcurementToContract(Number(req.params.id), contract_id, contract_no_manual, has_contract);

      syncProcurementFolderOnChange(
        Number(req.params.id),
        existing.folder_path,
        cleanNo,
        cleanName,
        cleanApprovalDate
      );

      if (tempFiles.length > 0) {
        archiveFilesForProcurement(
          Number(req.params.id),
          cleanNo,
          cleanName,
          cleanApprovalDate,
          tempFiles
        );
      }

      recalculateProcurementSequences();
    });

    updateTx();
    if (tempFiles.length > 0) triggerSafeGC();
    res.json({ success: true, message: '采购立项更新成功' });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/procurements/:id', (req, res) => {
  const existing = STMTS.getProcById.get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '未找到该采购立项记录' });

  const procFolder = existing.folder_path ||
    `uploads/procurement/${buildStandardFolderName(existing.procurement_no, existing.project_name, existing.approval_date || '无日期')}`;

  const delTx = db.transaction(() => {
    db.prepare(`UPDATE contracts SET procurement_id = NULL WHERE procurement_id = ?`).run(req.params.id);
    STMTS.deleteProcFilesByPid.run(req.params.id);
    STMTS.deleteProcById.run(req.params.id);
    recalculateProcurementSequences();
  });
  delTx();

  removeFolderIfExists(procFolder, PROCUREMENT_ROOT_DIR);
  res.json({ success: true, message: '采购立项及其专属资料夹已删除（关联合同本身保留）' });
});

app.post('/api/procurements/:id/files', uploadContractFiles.array('procurement_files', 30), (req, res) => {
  try {
    const existing = STMTS.getProcById.get(req.params.id);
    if (!existing) {
      cleanupReqTempFiles(req);
      return res.status(404).json({ success: false, message: '采购立项不存在' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要上传的立项相关资料' });
    }

    const tx = db.transaction(() => {
      return archiveFilesForProcurement(
        existing.id,
        existing.procurement_no,
        existing.project_name,
        existing.approval_date,
        req.files
      );
    });
    const folderPath = tx();
    triggerSafeGC();

    res.json({
      success: true,
      message: `已成功归档 ${req.files.length} 份立项相关资料`,
      folder_path: folderPath,
      procurement_files: STMTS.getProcFilesByPid.all(existing.id)
    });
  } catch (err) {
    cleanupReqTempFiles(req);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/procurements/:id/files/:fileId/download', (req, res) => {
  const f = STMTS.getProcFileById.get(req.params.fileId);
  if (!f || String(f.procurement_id) !== String(req.params.id)) {
    return res.status(404).send('未找到该立项资料记录');
  }
  const fullPath = path.resolve(DATA_ROOT, f.file_path);
  if (!isPathInsideDir(fullPath, PROCUREMENT_ROOT_DIR) || !fs.existsSync(fullPath)) {
    return res.status(404).send('立项资料物理文件不存在');
  }
  res.download(fullPath, f.file_name);
});

app.delete('/api/procurements/:id/files/:fileId', (req, res) => {
  const existing = STMTS.getProcById.get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '采购立项不存在' });

  const f = STMTS.getProcFileById.get(req.params.fileId);
  if (!f || String(f.procurement_id) !== String(req.params.id)) {
    return res.status(404).json({ success: false, message: '未找到该立项资料' });
  }

  removeFileIfExists(f.file_path);
  STMTS.deleteProcFileById.run(f.id);

  const remaining = STMTS.getProcFilesByPid.all(existing.id);
  if (remaining.length === 0) {
    const folderPath = existing.folder_path || path.posix.dirname(f.file_path.replace(/\\/g, '/'));
    removeFolderIfExists(folderPath, PROCUREMENT_ROOT_DIR);
    STMTS.updateProcFolder.run(null, existing.id);
  }

  res.json({ success: true, message: '该份立项资料已删除' });
});

app.use((err, req, res, next) => {
  cleanupReqTempFiles(req);
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: '单个文件大小不能超过 30MB' });
  }
  res.status(400).json({ success: false, message: err.message || '服务器请求处理异常' });
});

// ==================== 5. 可控服务启动与全量资源销毁接口 ====================
function startServer(port = 0, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const activeSockets = new Set();
    const server = app.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        server,
        shutdown: async () => {
          clearInterval(rateLimitCleanupTimer);
          loginRateLimitMap.clear();
          cleanTmpDir();
          sweepOrphanUploads();
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          for (const socket of activeSockets) {
            try { socket.destroy(); } catch (e) {}
          }
          activeSockets.clear();
          await new Promise((resClose) => server.close(() => resClose()));
          if (db && db.open) {
            try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
            try { db.pragma('optimize'); } catch (e) {}
            try { db.close(); } catch (e) {}
          }
        }
      });
    });

    server.on('connection', (socket) => {
      activeSockets.add(socket);
      socket.on('close', () => activeSockets.delete(socket));
    });

    server.on('error', reject);
  });
}

if (require.main === module) {
  const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 0;
  startServer(PORT, '0.0.0.0').then(({ port, shutdown }) => {
    console.log(`✅ 服务已启动 (动态端口: ${port}, 本机免密: http://127.0.0.1:${port})`);
    process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
    process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
  });
}

module.exports = { app, db, startServer, sweepOrphanUploads };
