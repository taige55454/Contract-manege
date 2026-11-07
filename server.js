const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();

// 1. 解析可读写的数据根目录（兼容打包成 .exe 后的只读 asar 环境）
const DATA_ROOT = process.env.DATA_ROOT || __dirname;
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const TMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.tmp');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TMP_UPLOAD_DIR)) fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });

function cleanTmpDir() {
  if (!fs.existsSync(TMP_UPLOAD_DIR)) return;
  try {
    for (const file of fs.readdirSync(TMP_UPLOAD_DIR)) {
      fs.unlinkSync(path.join(TMP_UPLOAD_DIR, file));
    }
  } catch (e) {}
}
cleanTmpDir();

// 2. 中间件配置
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
  }
}));

// 3. 初始化 SQLite 数据库（含系统设置表、合同主表、多方独立履约明细子表）
const dbPath = process.env.DB_PATH || path.join(DATA_ROOT, 'database.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

const DEFAULT_NO_RULE = JSON.stringify({
  prefix: 'HT-',
  date_part: 'YYYY-',
  seq_digits: 3,
  suffix: ''
});

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO app_settings (key, value) VALUES ('default_our_entity', '本单位默认签约主体（点击顶部可修改）');
  INSERT OR IGNORE INTO app_settings (key, value) VALUES ('contract_no_rule', '${DEFAULT_NO_RULE}');

  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  CREATE INDEX IF NOT EXISTS idx_contract_no ON contracts(contract_no);
  CREATE INDEX IF NOT EXISTS idx_counterparty ON contracts(counterparty);
  CREATE INDEX IF NOT EXISTS idx_sign_date ON contracts(sign_date);
  CREATE INDEX IF NOT EXISTS idx_expiry_date ON contracts(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_party_contract_id ON contract_parties(contract_id);
`);

// 自动平滑升级旧版数据库表结构（防止旧库缺少新增列）
function ensureSchemaUpgraded() {
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
}
ensureSchemaUpgraded();

// ==================== 工具与合同编号生成函数 ====================

function getContractNoRule() {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'contract_no_rule'`).get();
  let parsed = {};
  try {
    parsed = row ? JSON.parse(row.value) : {};
  } catch (e) {}
  return {
    prefix: typeof parsed.prefix === 'string' ? parsed.prefix : 'HT-',
    date_part: ['NONE', 'YYYY', 'YYYY-', 'YYYYMM', 'YYYYMM-', 'YYYYMMDD', 'YYYYMMDD-'].includes(parsed.date_part)
      ? parsed.date_part
      : 'YYYY-',
    seq_digits: Number.isInteger(Number(parsed.seq_digits))
      ? Math.min(8, Math.max(0, Number(parsed.seq_digits)))
      : 3,
    suffix: typeof parsed.suffix === 'string' ? parsed.suffix : ''
  };
}

function formatDateSegment(datePartRule) {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
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

// 根据当前保存的【前缀 + 日期段 + 流水号位数 + 后缀】规则，计算下一个可用合同编号
function generateNextContractNo(customRule = null) {
  const rule = customRule || getContractNoRule();
  const dateSeg = formatDateSegment(rule.date_part);
  const head = `${rule.prefix || ''}${dateSeg}`;
  const tail = `${rule.suffix || ''}`;
  const digits = Number(rule.seq_digits || 0);

  if (digits <= 0) {
    return `${head}${tail}`;
  }

  const allNos = db.prepare(`SELECT contract_no FROM contracts`).all().map(r => r.contract_no);
  let maxSeq = 0;

  for (const no of allNos) {
    if (!no || typeof no !== 'string') continue;
    if (no.startsWith(head) && (tail === '' || no.endsWith(tail))) {
      const middleLen = no.length - head.length - tail.length;
      if (middleLen > 0) {
        const middleStr = no.slice(head.length, no.length - tail.length);
        if (/^\d+$/.test(middleStr)) {
          const num = parseInt(middleStr, 10);
          if (num > maxSeq) maxSeq = num;
        }
      }
    }
  }

  let nextSeq = maxSeq + 1;
  let candidate = `${head}${String(nextSeq).padStart(digits, '0')}${tail}`;
  const existingSet = new Set(allNos);
  while (existingSet.has(candidate)) {
    nextSeq++;
    candidate = `${head}${String(nextSeq).padStart(digits, '0')}${tail}`;
  }

  return candidate;
}

function sanitizeFilenamePart(str) {
  if (!str) return '未命名';
  return String(str)
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

// 生成规范的扫描件文件名：{合同编号}+{合同名称}+{签订日期}.{ext}
function buildStandardAttachmentName(contractNo, contractName, signDate, ext) {
  const safeNo = sanitizeFilenamePart(contractNo);
  const safeName = sanitizeFilenamePart(contractName);
  const safeDate = sanitizeFilenamePart(signDate);
  const cleanExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return `${safeNo}+${safeName}+${safeDate}${cleanExt}`;
}

function removeFileIfExists(relativePath) {
  if (!relativePath) return;
  const fullPath = path.resolve(DATA_ROOT, relativePath);
  if (!fullPath.startsWith(UPLOAD_DIR)) return;
  if (fs.existsSync(fullPath)) {
    try { fs.unlinkSync(fullPath); } catch (err) { console.error('删除文件失败:', err.message); }
  }
}

function moveFileSafe(srcPath, destPath) {
  if (fs.existsSync(destPath)) {
    try { fs.unlinkSync(destPath); } catch (e) {}
  }
  try {
    fs.renameSync(srcPath, destPath);
  } catch (err) {
    fs.copyFileSync(srcPath, destPath);
    fs.unlinkSync(srcPath);
  }
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

function parseNullableFloat(val) {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function validateAndNormalizeTaxRate(taxRateRaw, partyIndex = 1) {
  if (!taxRateRaw || !String(taxRateRaw).trim()) return '';
  const str = String(taxRateRaw).trim().replace(/，/g, ',');
  if (str.includes(',') && !str.startsWith('*')) {
    throw new Error(`第 ${partyIndex} 个对方单位的税率包含多个值时，必须在最前面加上 * 号并用逗号隔开（例如：*6%,13%）`);
  }
  return str;
}

// 解析并校验多方独立履约数据（每方各有独立的摘要、金额、税率、保证金、质保金、备注）
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

    const cleanTax = validateAndNormalizeTaxRate(item.tax_rate, idx + 1);
    const amountVal = parseFloat(item.amount);

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
      perf_bond_pay_date: String(item.perf_bond_pay_date || '').trim(),
      perf_bond_return_date: String(item.perf_bond_return_date || '').trim(),
      warranty_bond_amount: parseNullableFloat(item.warranty_bond_amount),
      warranty_bond_expiry_date: String(item.warranty_bond_expiry_date || '').trim(),
      remark: String(item.remark || '').trim()
    };
  });

  // 汇总主表冗余字段（便于快速按总额/最早预警日期排序检索）
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

// 4. Multer 配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_UPLOAD_DIR),
  filename: (req, file, cb) => {
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `tmp_${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持上传 PDF、JPG、PNG 格式的扫描件'));
    }
  }
});

function buildQuery(queryParams) {
  const { contract_no, counterparty, contract_type, status, sort_by, sort_order } = queryParams;
  let sql = `SELECT * FROM contracts WHERE 1=1`;
  const params = [];

  if (contract_no && contract_no.trim()) {
    sql += ` AND (contract_no LIKE ? OR contract_name LIKE ? OR contract_summary LIKE ? OR counterparties_json LIKE ?)`;
    const kw = `%${contract_no.trim()}%`;
    params.push(kw, kw, kw, kw);
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

  const allowedSortFields = [
    'sign_date', 'start_date', 'expiry_date',
    'perf_bond_return_date', 'warranty_bond_expiry_date', 'created_at'
  ];
  const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
  const order = (sort_order && sort_order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

  sql += ` ORDER BY CASE WHEN ${sortField} = '' OR ${sortField} IS NULL THEN 1 ELSE 0 END, ${sortField} ${order}, id DESC`;
  return { sql, params };
}

const syncPartiesStmt = db.prepare(`
  INSERT INTO contract_parties (
    contract_id, party_index, company_name, credit_code, contact_person, contact_phone,
    bank_account_name, bank_account_no, bank_name, bank_code,
    item_summary, amount, amount_excl_tax, tax_rate, invoice_type, currency,
    perf_bond_amount, perf_bond_pay_date, perf_bond_return_date,
    warranty_bond_amount, warranty_bond_expiry_date, remark
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function syncContractParties(contractId, partiesList) {
  db.prepare(`DELETE FROM contract_parties WHERE contract_id = ?`).run(contractId);
  for (const p of partiesList) {
    syncPartiesStmt.run(
      contractId, p.party_index, p.company_name, p.credit_code, p.contact_person, p.contact_phone,
      p.bank_account_name, p.bank_account_no, p.bank_name, p.bank_code,
      p.item_summary, p.amount, p.amount_excl_tax, p.tax_rate, p.invoice_type, p.currency,
      p.perf_bond_amount, p.perf_bond_pay_date, p.perf_bond_return_date,
      p.warranty_bond_amount, p.warranty_bond_expiry_date, p.remark
    );
  }
}

// 辅助函数：读取某条合同的完整多方列表（自动兼容老数据）
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

// ==================== API 路由 ====================

// [GET/PUT] 默认我方签约主体设置
app.get('/api/settings/our-entity', (req, res) => {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'default_our_entity'`).get();
  res.json({ success: true, default_our_entity: row ? row.value : '' });
});

app.put('/api/settings/our-entity', (req, res) => {
  const val = String(req.body.default_our_entity || '').trim();
  if (!val) return res.status(400).json({ success: false, message: '默认我方主体名称不能为空' });
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('default_our_entity', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(val);
  res.json({ success: true, default_our_entity: val, message: '默认我方主体已保存' });
});

// [GET/PUT] 合同编号固定前缀/后缀与流水号规则设置
app.get('/api/settings/contract-no-rule', (req, res) => {
  const rule = getContractNoRule();
  const sample_next_no = generateNextContractNo(rule);
  res.json({ success: true, rule, sample_next_no });
});

app.put('/api/settings/contract-no-rule', (req, res) => {
  const prefix = String(req.body.prefix ?? '').trim();
  const suffix = String(req.body.suffix ?? '').trim();
  const date_part = ['NONE', 'YYYY', 'YYYY-', 'YYYYMM', 'YYYYMM-', 'YYYYMMDD', 'YYYYMMDD-'].includes(req.body.date_part)
    ? req.body.date_part
    : 'YYYY-';
  const seq_digits = Number.isInteger(Number(req.body.seq_digits))
    ? Math.min(8, Math.max(0, Number(req.body.seq_digits)))
    : 3;

  const newRule = { prefix, date_part, seq_digits, suffix };
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('contract_no_rule', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(newRule));

  const sample_next_no = generateNextContractNo(newRule);
  res.json({ success: true, rule: newRule, sample_next_no, message: '合同编号规则已保存' });
});

// [GET] 获取下一个自动生成的合同编号
app.get('/api/contracts/next-no', (req, res) => {
  const rule = getContractNoRule();
  const next_no = generateNextContractNo(rule);
  res.json({ success: true, next_no, rule });
});

// [GET] 获取合同台账列表
app.get('/api/contracts', (req, res) => {
  try {
    const { sql, params } = buildQuery(req.query);
    const rows = db.prepare(sql).all(...params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// [GET] 导出 Excel（多方自动拆分为多行，且前面公共列+尾部扫描件列自动跨行合并单元格）
app.get('/api/contracts/export', (req, res) => {
  try {
    const queryObj = req.query.scope === 'all'
      ? { sort_by: req.query.sort_by, sort_order: req.query.sort_order }
      : req.query;

    const { sql, params } = buildQuery(queryObj);
    const rows = db.prepare(sql).all(...params);

    // 共 29 列（索引 0~28）
    // 索引 0~7 为合同公共列（跨行合并），索引 8~27 为各相对方独立履约列（各填各的），索引 28 为扫描件归档名（跨行合并）
    const headers = [
      '合同编号', '合同名称', '合同类型', '我方签约主体', '签订日期', '开始履约日', '合同到期日', '合同状态',
      '履约摘要(分项)', '对方单位名称', '统一信用代码', '联系人', '联系方式', '收款账户名称', '收款账号', '开户行', '开户行号',
      '含税金额', '不含税价', '税率', '发票类型', '币种',
      '履约保证金', '保证金缴纳日', '保证金应退日', '质保金金额', '质保金到期日', '分项备注',
      '扫描件归档名'
    ];

    const aoa = [headers];
    const merges = [];
    const mergeColIndices = [0, 1, 2, 3, 4, 5, 6, 7, 28];

    let currentRowIdx = 1;

    for (const row of rows) {
      const parties = getContractPartiesList(row);
      const startRow = currentRowIdx;

      for (const p of parties) {
        aoa.push([
          row.contract_no,
          row.contract_name,
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
          Number(p.amount !== undefined ? p.amount : row.amount),
          p.amount_excl_tax !== null && p.amount_excl_tax !== undefined ? Number(p.amount_excl_tax) : '',
          p.tax_rate || '',
          p.invoice_type || '',
          p.currency || row.currency || 'CNY',
          p.perf_bond_amount !== null && p.perf_bond_amount !== undefined ? Number(p.perf_bond_amount) : '',
          p.perf_bond_pay_date || '',
          p.perf_bond_return_date || '',
          p.warranty_bond_amount !== null && p.warranty_bond_amount !== undefined ? Number(p.warranty_bond_amount) : '',
          p.warranty_bond_expiry_date || '',
          p.remark || row.remark || '',
          row.attachment_original_name || '未上传'
        ]);
        currentRowIdx++;
      }

      const endRow = currentRowIdx - 1;
      if (endRow > startRow) {
        for (const colIdx of mergeColIndices) {
          merges.push({
            s: { r: startRow, c: colIdx },
            e: { r: endRow, c: colIdx }
          });
        }
      }
    }

    const worksheet = xlsx.utils.aoa_to_sheet(aoa);
    worksheet['!merges'] = merges;
    worksheet['!cols'] = [
      { wch: 18 }, { wch: 22 }, { wch: 10 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
      { wch: 28 }, { wch: 24 }, { wch: 20 }, { wch: 10 }, { wch: 14 }, { wch: 22 }, { wch: 20 }, { wch: 20 }, { wch: 14 },
      { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 8 },
      { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 14 }, { wch: 13 }, { wch: 20 },
      { wch: 32 }
    ];

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, '合同台账');

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const fileName = encodeURIComponent(`合同台账_${new Date().toISOString().slice(0, 10)}.xlsx`);

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, message: '导出失败: ' + err.message });
  }
});

// [GET] 获取单条合同详情
app.get('/api/contracts/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: '未找到该合同记录' });
  res.json({ success: true, data: row });
});

// [POST] 新增合同
app.post('/api/contracts', upload.single('attachment'), (req, res) => {
  let archivedFile = null;
  try {
    const {
      contract_no, contract_name, contract_type, our_entity,
      sign_date, start_date, expiry_date, status
    } = req.body;

    if (!contract_no || !contract_name || !our_entity || !sign_date || !expiry_date) {
      throw new Error('请完整填写必填项（合同编号、名称、我方主体、签订日、到期日）');
    }

    const cleanNo = contract_no.trim();
    const cleanName = contract_name.trim();
    const cleanSignDate = sign_date.trim();
    const cleanStartDate = (start_date && start_date.trim()) ? start_date.trim() : cleanSignDate;

    const {
      counterpartySummary, summaryCombined, totalAmount, totalExcl,
      earliestPerfReturn, earliestWarrantyExpiry, counterpartiesJson, counterpartiesList
    } = parseCounterparties(req.body);

    const firstParty = counterpartiesList[0];

    const createTx = db.transaction(() => {
      if (req.file) {
        archivedFile = finalizeUploadedFile(req.file, cleanNo, cleanName, cleanSignDate);
      }

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
        cleanSignDate, cleanStartDate, expiry_date.trim(),
        totalAmount, totalExcl, firstParty.tax_rate, firstParty.invoice_type, firstParty.currency,
        firstParty.perf_bond_amount, firstParty.perf_bond_pay_date, earliestPerfReturn,
        firstParty.warranty_bond_amount, earliestWarrantyExpiry,
        status || '生效中', firstParty.remark,
        archivedFile ? archivedFile.attachment_path : null,
        archivedFile ? archivedFile.attachment_original_name : null
      );

      syncContractParties(info.lastInsertRowid, counterpartiesList);
      return info.lastInsertRowid;
    });

    const newId = createTx();
    res.json({ success: true, id: newId, message: '合同新增成功' });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    if (archivedFile) removeFileIfExists(archivedFile.attachment_path);

    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, message: '合同编号已存在，请确保唯一性' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// [PUT] 编辑合同
app.put('/api/contracts/:id', upload.single('attachment'), (req, res) => {
  let newlyArchivedFile = null;
  try {
    const existing = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
    if (!existing) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }

    const {
      contract_no, contract_name, contract_type, our_entity,
      sign_date, start_date, expiry_date, status
    } = req.body;

    const cleanNo = contract_no.trim();
    const cleanName = contract_name.trim();
    const cleanSignDate = sign_date.trim();
    const cleanStartDate = (start_date && start_date.trim()) ? start_date.trim() : cleanSignDate;

    const {
      counterpartySummary, summaryCombined, totalAmount, totalExcl,
      earliestPerfReturn, earliestWarrantyExpiry, counterpartiesJson, counterpartiesList
    } = parseCounterparties(req.body);

    const firstParty = counterpartiesList[0];

    const updateTx = db.transaction(() => {
      let attachment_path = existing.attachment_path;
      let attachment_original_name = existing.attachment_original_name;

      if (req.file) {
        removeFileIfExists(existing.attachment_path);
        newlyArchivedFile = finalizeUploadedFile(req.file, cleanNo, cleanName, cleanSignDate);
        attachment_path = newlyArchivedFile.attachment_path;
        attachment_original_name = newlyArchivedFile.attachment_original_name;
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

      db.prepare(`
        UPDATE contracts SET
          contract_no = ?, contract_name = ?, contract_summary = ?, contract_type = ?,
          our_entity = ?, counterparty = ?, counterparties_json = ?,
          sign_date = ?, start_date = ?, expiry_date = ?,
          amount = ?, amount_excl_tax = ?, tax_rate = ?, invoice_type = ?, currency = ?,
          perf_bond_amount = ?, perf_bond_pay_date = ?, perf_bond_return_date = ?,
          warranty_bond_amount = ?, warranty_bond_expiry_date = ?,
          status = ?, remark = ?,
          attachment_path = ?, attachment_original_name = ?,
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        cleanNo, cleanName, summaryCombined, contract_type,
        our_entity.trim(), counterpartySummary, counterpartiesJson,
        cleanSignDate, cleanStartDate, expiry_date.trim(),
        totalAmount, totalExcl, firstParty.tax_rate, firstParty.invoice_type, firstParty.currency,
        firstParty.perf_bond_amount, firstParty.perf_bond_pay_date, earliestPerfReturn,
        firstParty.warranty_bond_amount, earliestWarrantyExpiry,
        status, firstParty.remark,
        attachment_path, attachment_original_name, req.params.id
      );

      syncContractParties(req.params.id, counterpartiesList);
    });

    updateTx();
    res.json({ success: true, message: '合同更新成功' });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, message: '合同编号已被其他记录占用' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/contracts/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });

  removeFileIfExists(existing.attachment_path);
  db.prepare(`DELETE FROM contracts WHERE id = ?`).run(req.params.id);
  res.json({ success: true, message: '合同及关联扫描件已删除' });
});

app.post('/api/contracts/:id/attachment', upload.single('attachment'), (req, res) => {
  try {
    const existing = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
    if (!existing) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
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

    db.prepare(`
      UPDATE contracts
      SET attachment_path = ?, attachment_original_name = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(archived.attachment_path, archived.attachment_original_name, req.params.id);

    res.json({ success: true, message: '扫描件已按规范命名归档', data: archived });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/contracts/:id/attachment', (req, res) => {
  const existing = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });

  removeFileIfExists(existing.attachment_path);
  db.prepare(`
    UPDATE contracts
    SET attachment_path = NULL, attachment_original_name = NULL, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(req.params.id);

  res.json({ success: true, message: '扫描件已移除' });
});

app.get('/api/contracts/:id/download', (req, res) => {
  const existing = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
  if (!existing || !existing.attachment_path) {
    return res.status(404).send('该合同尚未上传扫描件');
  }
  const fullPath = path.resolve(DATA_ROOT, existing.attachment_path);
  if (!fullPath.startsWith(UPLOAD_DIR) || !fs.existsSync(fullPath)) {
    return res.status(404).send('扫描件物理文件不存在');
  }
  res.download(fullPath, existing.attachment_original_name);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: '扫描件大小不能超过 20MB' });
  }
  res.status(400).json({ success: false, message: err.message || '服务器请求处理异常' });
});

// ==================== 5. 可控服务启动与全量资源销毁接口 ====================
function startServer(port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const activeSockets = new Set();
    const server = app.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        server,
        shutdown: async () => {
          cleanTmpDir();
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
  const PORT = process.env.PORT || 3000;
  startServer(PORT, '127.0.0.1').then(({ port, shutdown }) => {
    console.log(`✅ 服务已启动: http://127.0.0.1:${port}`);
    process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
    process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
  });
}

module.exports = { app, db, startServer };
