const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const XLSX = require('xlsx-js-style');
const path = require('path');
const fs = require('fs');

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// 安全响应头加固
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// 1. 解析可读写的数据根目录
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || __dirname);
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const TMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.tmp');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TMP_UPLOAD_DIR)) fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });

// 主动触发安全 GC（当启动参数含 --expose-gc 时生效）
function triggerSafeGC() {
  if (typeof global.gc === 'function') {
    setImmediate(() => {
      try { global.gc(); } catch (e) {}
    });
  }
}

// 获取本地时区当天日期字符串 (YYYY-MM-DD)，修复 toISOString() 在早上 8 点前差一天的时区 Bug
function getLocalTodayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 清理临时上传目录 .tmp
function cleanTmpDir() {
  if (!fs.existsSync(TMP_UPLOAD_DIR)) return;
  try {
    for (const file of fs.readdirSync(TMP_UPLOAD_DIR)) {
      try { fs.unlinkSync(path.join(TMP_UPLOAD_DIR, file)); } catch (e) {}
    }
  } catch (e) {}
}
cleanTmpDir();

// 2. 中间件配置
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

app.use('/uploads', express.static(UPLOAD_DIR, {
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
  }
}));

// 3. 初始化 SQLite 数据库（配置极低内存占用与外键级联保护）
const dbPath = process.env.DB_PATH || path.join(DATA_ROOT, 'database.sqlite');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -4000'); // 严格限制页缓存为 4MB
db.pragma('mmap_size = 0');      // 关闭 mmap 映射，防止虚增进程工作集内存

const DEFAULT_NO_RULE = JSON.stringify({
  prefix: 'HT-',
  date_part: 'YYYY-',
  seq_digits: 3,
  suffix: '',
  reset_yearly: true
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
  CREATE INDEX IF NOT EXISTS idx_seq_year_no ON contracts(seq_year, seq_no);
  CREATE INDEX IF NOT EXISTS idx_party_contract_id ON contract_parties(contract_id);
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

  // 清理可能因为历史版本遗留的无主子表记录
  db.exec(`DELETE FROM contract_parties WHERE contract_id NOT IN (SELECT id FROM contracts)`);
}
ensureSchemaUpgraded();

// ==================== 高频 SQL 预编译缓存池 (Prepared Statements) ====================
const STMTS = {
  getSetting: db.prepare(`SELECT value FROM app_settings WHERE key = ?`),
  upsertSetting: db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  getAllContractNos: db.prepare(`SELECT contract_no FROM contracts`),
  getAllForSeq: db.prepare(`SELECT id, sign_date FROM contracts ORDER BY sign_date ASC, id ASC`),
  updateSeq: db.prepare(`UPDATE contracts SET seq_year = ?, seq_no = ?, seq_label = ? WHERE id = ?`),
  getDistinctYears: db.prepare(`SELECT DISTINCT seq_year FROM contracts WHERE seq_year IS NOT NULL ORDER BY seq_year DESC`),
  getContractById: db.prepare(`SELECT * FROM contracts WHERE id = ?`),
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
  getAllAttachmentPaths: db.prepare(`SELECT attachment_path FROM contracts WHERE attachment_path IS NOT NULL AND attachment_path != ''`)
};

/**
 * 自动清扫孤儿扫描件（防止异常中断或历史操作导致的磁盘垃圾文件堆积）
 */
function sweepOrphanUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  try {
    const referencedSet = new Set(
      STMTS.getAllAttachmentPaths.all()
        .map(r => path.basename(String(r.attachment_path)).toLowerCase())
    );
    const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        if (!referencedSet.has(entry.name.toLowerCase())) {
          try { fs.unlinkSync(path.join(UPLOAD_DIR, entry.name)); } catch (e) {}
        }
      }
    }
  } catch (e) {}
}
sweepOrphanUploads();

// ==================== 智能日期、智能税率与按年断号重编核心函数 ====================

function smartParseDate(rawInput, fieldLabel = '日期', isRequired = false) {
  if (rawInput === undefined || rawInput === null || String(rawInput).trim() === '') {
    if (isRequired) throw new Error(`${fieldLabel}不能为空`);
    return '';
  }

  let s = String(rawInput).trim()
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
    throw new Error(`${fieldLabel}格式无法识别（输入值：“${rawInput}”）。支持如 2026-6-3、2026.3.5、2026/2/4 或简写 6.3`);
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

  if (str.startsWith('*')) {
    str = str.slice(1);
  }

  const parts = str.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  const formattedParts = parts.map(part => {
    if (/^\d+(\.\d+)?$/.test(part)) {
      return `${part}%`;
    }
    return part;
  });

  if (formattedParts.length > 1) {
    return `*${formattedParts.join(',')}`;
  }
  return formattedParts[0];
}

function getContractNoRule() {
  const row = STMTS.getSetting.get('contract_no_rule');
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
    suffix: typeof parsed.suffix === 'string' ? parsed.suffix : '',
    reset_yearly: parsed.reset_yearly !== false
  };
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
recalculateAllSequences();

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

function generateNextContractNoParts(customRule = null, signDateStr = '') {
  const rule = customRule || getContractNoRule();
  const dateSeg = formatDateSegment(rule.date_part, signDateStr);
  const prefix = rule.prefix || '';
  const suffix = rule.suffix || '';
  const head = `${prefix}${dateSeg}`;
  const tail = suffix;
  const digits = Number(rule.seq_digits || 0);

  const allNos = STMTS.getAllContractNos.all().map(r => r.contract_no);
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
  let middleDefault = digits > 0 ? String(nextSeq).padStart(digits, '0') : '';
  let fullNo = `${head}${middleDefault}${tail}`;

  if (digits > 0) {
    const existingSet = new Set(allNos);
    while (existingSet.has(fullNo)) {
      nextSeq++;
      middleDefault = String(nextSeq).padStart(digits, '0');
      fullNo = `${head}${middleDefault}${tail}`;
    }
  }

  return {
    prefix,
    date_seg: dateSeg,
    middle_default: middleDefault,
    suffix,
    full_no: fullNo,
    rule
  };
}

function sanitizeFilenamePart(str) {
  if (!str) return '未命名';
  return String(str)
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function buildStandardAttachmentName(contractNo, contractName, signDate, ext) {
  const safeNo = sanitizeFilenamePart(contractNo);
  const safeName = sanitizeFilenamePart(contractName);
  const safeDate = sanitizeFilenamePart(signDate);
  const cleanExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return `${safeNo}+${safeName}+${safeDate}${cleanExt}`;
}

// 严格边界校验的物理文件安全删除
function removeFileIfExists(relativePath) {
  if (!relativePath) return;
  const fullPath = path.resolve(DATA_ROOT, relativePath);
  const uploadDirWithSep = UPLOAD_DIR.endsWith(path.sep) ? UPLOAD_DIR : UPLOAD_DIR + path.sep;
  if (fullPath !== UPLOAD_DIR && !fullPath.startsWith(uploadDirWithSep)) return;
  if (fs.existsSync(fullPath)) {
    try { fs.unlinkSync(fullPath); } catch (err) { console.error('删除文件失败:', err.message); }
  }
}

// 安全移动文件（防止 Windows 大小写不敏感文件系统下同路径误删）
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
    fs.copyFileSync(absSrc, absDest);
    try { fs.unlinkSync(absSrc); } catch (e) {}
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

// ==================== API 路由 ====================

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
  const suffix = String(req.body.suffix ?? '').trim();
  const date_part = ['NONE', 'YYYY', 'YYYY-', 'YYYYMM', 'YYYYMM-', 'YYYYMMDD', 'YYYYMMDD-'].includes(req.body.date_part)
    ? req.body.date_part
    : 'YYYY-';
  const seq_digits = Number.isInteger(Number(req.body.seq_digits))
    ? Math.min(8, Math.max(0, Number(req.body.seq_digits)))
    : 3;
  const reset_yearly = req.body.reset_yearly !== false && req.body.reset_yearly !== 'false';

  const newRule = { prefix, date_part, seq_digits, suffix, reset_yearly };
  STMTS.upsertSetting.run('contract_no_rule', JSON.stringify(newRule));

  recalculateAllSequences();
  const parts = generateNextContractNoParts(newRule);
  res.json({ success: true, rule: newRule, sample_next_no: parts.full_no, parts, message: '编号与按年重编规则已保存' });
});

app.get('/api/contracts/next-no', (req, res) => {
  const rule = getContractNoRule();
  const parts = generateNextContractNoParts(rule, req.query.sign_date || '');
  res.json({ success: true, next_no: parts.full_no, parts, rule });
});

app.get('/api/contracts', (req, res) => {
  try {
    const { sql, params } = buildQuery(req.query, 'ASC');
    const rows = db.prepare(sql).all(...params);
    const years = STMTS.getDistinctYears.all().map(r => r.seq_year);
    res.json({ success: true, data: rows, years });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== [GET] 导出深度美化的 Excel 台账（带主动内存释放） ====================
app.get('/api/contracts/export', (req, res) => {
  let aoa = null;
  let worksheet = null;
  let workbook = null;
  let buffer = null;

  try {
    const exportQuery = req.query.scope === 'all'
      ? { sort_by: 'seq_no', sort_order: 'ASC' }
      : { ...req.query, sort_by: 'seq_no', sort_order: 'ASC' };

    const { sql, params } = buildQuery(exportQuery, 'ASC');
    const rows = db.prepare(sql).all(...params);

    const headers = [
      '序号', '合同编号', '合同名称', '合同类型', '我方签约主体', '签订日期', '开始履约日', '合同到期日', '合同状态',
      '履约摘要(分项)', '对方单位名称', '统一信用代码', '联系人', '联系方式', '收款账户名称', '收款账号', '开户行', '开户行号',
      '含税金额', '不含税价', '税率', '发票类型', '币种',
      '履约保证金', '保证金缴纳日', '保证金应退日', '质保金金额', '质保金到期日', '分项备注',
      '合同扫描件(相对路径超链接)'
    ];

    const colSpecs = [
      { wch: 12, align: 'center', type: 'text' },   // 0: 序号
      { wch: 20, align: 'center', type: 'text' },   // 1: 合同编号
      { wch: 24, align: 'left',   type: 'text' },   // 2: 合同名称
      { wch: 10, align: 'center', type: 'text' },   // 3: 合同类型
      { wch: 24, align: 'left',   type: 'text' },   // 4: 我方签约主体
      { wch: 13, align: 'center', type: 'date' },   // 5: 签订日期 (纯年月日)
      { wch: 13, align: 'center', type: 'date' },   // 6: 开始履约日 (纯年月日)
      { wch: 13, align: 'center', type: 'date' },   // 7: 合同到期日 (纯年月日)
      { wch: 10, align: 'center', type: 'text' },   // 8: 合同状态
      { wch: 30, align: 'left',   type: 'text' },   // 9: 履约摘要(分项)
      { wch: 24, align: 'left',   type: 'text' },   // 10: 对方单位名称
      { wch: 22, align: 'center', type: 'code' },   // 11: 统一信用代码 (防科学计数)
      { wch: 11, align: 'center', type: 'text' },   // 12: 联系人
      { wch: 15, align: 'center', type: 'code' },   // 13: 联系方式 (防科学计数)
      { wch: 24, align: 'left',   type: 'text' },   // 14: 收款账户名称
      { wch: 24, align: 'center', type: 'code' },   // 15: 收款账号 (防科学计数)
      { wch: 22, align: 'left',   type: 'text' },   // 16: 开户行
      { wch: 16, align: 'center', type: 'code' },   // 17: 开户行号 (防科学计数)
      { wch: 16, align: 'right',  type: 'money' },  // 18: 含税金额 (会计格式)
      { wch: 16, align: 'right',  type: 'money' },  // 19: 不含税价 (会计格式)
      { wch: 12, align: 'center', type: 'text' },   // 20: 税率
      { wch: 16, align: 'center', type: 'text' },   // 21: 发票类型
      { wch: 8,  align: 'center', type: 'text' },   // 22: 币种
      { wch: 15, align: 'right',  type: 'money' },  // 23: 履约保证金 (会计格式)
      { wch: 13, align: 'center', type: 'date' },   // 24: 保证金缴纳日 (纯年月日)
      { wch: 13, align: 'center', type: 'date' },   // 25: 保证金应退日 (纯年月日)
      { wch: 15, align: 'right',  type: 'money' },  // 26: 质保金金额 (会计格式)
      { wch: 13, align: 'center', type: 'date' },   // 27: 质保金到期日 (纯年月日)
      { wch: 22, align: 'left',   type: 'text' },   // 28: 分项备注
      { wch: 36, align: 'center', type: 'link' }    // 29: 扫描件相对路径超链接
    ];

    const thinBorder = {
      top:    { style: 'thin', color: { rgb: 'CBD5E1' } },
      bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
      left:   { style: 'thin', color: { rgb: 'CBD5E1' } },
      right:  { style: 'thin', color: { rgb: 'CBD5E1' } }
    };

    const bannerText = '💡 【扫描件超链接使用说明】最后一列为相对路径超链接（指向 ./uploads/ 文件夹）。请将本 Excel 表放置在与【uploads】文件夹同级的目录下（例如直接放入程序数据目录 ContractData 下，或将本表与 uploads 文件夹一起打包拷贝），即可直接点击最后一列蓝色超链接打开合同扫描件！';
    const bannerRow = headers.map((_, idx) => ({
      v: idx === 0 ? bannerText : '',
      t: 's',
      s: {
        font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: '92400E' } },
        fill: { fgColor: { rgb: 'FEF3C7' } },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
        border: thinBorder
      }
    }));

    const headerRow = headers.map(h => ({
      v: h,
      t: 's',
      s: {
        font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '1E3A8A' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: thinBorder
      }
    }));

    aoa = [bannerRow, headerRow];
    const merges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }
    ];
    const mergeColIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 29];
    const rowHeights = [{ hpt: 26 }, { hpt: 28 }];

    function buildStyledCell(rawVal, colIdx, bgRgb, linkMeta = null) {
      const spec = colSpecs[colIdx];
      const baseStyle = {
        font: { name: 'Microsoft YaHei', sz: 10, color: { rgb: '1F2937' } },
        fill: { fgColor: { rgb: bgRgb } },
        alignment: { horizontal: spec.align, vertical: 'center', wrapText: true },
        border: thinBorder
      };

      if (spec.type === 'link') {
        if (linkMeta && linkMeta.relPath) {
          baseStyle.font = {
            name: 'Microsoft YaHei',
            sz: 10,
            color: { rgb: '2563EB' },
            underline: true
          };
          return {
            v: linkMeta.displayText,
            t: 's',
            l: {
              Target: linkMeta.relPath,
              Tooltip: `点击打开扫描件: ${linkMeta.relPath}（需将本Excel置于 uploads 文件夹同级目录）`
            },
            s: baseStyle
          };
        }
        baseStyle.font.color = { rgb: '9CA3AF' };
        return { v: '未上传', t: 's', s: baseStyle };
      }

      if (spec.type === 'code') {
        baseStyle.numFmt = '@';
        return {
          v: rawVal !== null && rawVal !== undefined ? String(rawVal) : '',
          t: 's',
          s: baseStyle
        };
      }

      if (spec.type === 'money') {
        if (rawVal === null || rawVal === undefined || rawVal === '') {
          return { v: '', t: 's', s: baseStyle };
        }
        const num = Number(rawVal);
        if (Number.isFinite(num)) {
          baseStyle.numFmt = '#,##0.00';
          return { v: num, t: 'n', s: baseStyle };
        }
        return { v: String(rawVal), t: 's', s: baseStyle };
      }

      if (spec.type === 'date') {
        if (!rawVal || !String(rawVal).trim()) {
          return { v: '', t: 's', s: baseStyle };
        }
        const serialInt = dateStrToExcelSerialInt(rawVal);
        if (serialInt !== null) {
          baseStyle.numFmt = 'yyyy-mm-dd';
          return { v: serialInt, t: 'n', s: baseStyle };
        }
        return { v: String(rawVal).trim(), t: 's', s: baseStyle };
      }

      return {
        v: rawVal !== null && rawVal !== undefined ? String(rawVal) : '',
        t: 's',
        s: baseStyle
      };
    }

    let currentRowIdx = 2;

    rows.forEach((row, contractIndex) => {
      const parties = getContractPartiesList(row);
      const startRow = currentRowIdx;
      const bgRgb = (contractIndex % 2 === 1) ? 'F1F5F9' : 'FFFFFF';

      const linkMeta = row.attachment_path
        ? {
            relPath: row.attachment_path.replace(/\\/g, '/'),
            displayText: `📎 点击打开扫描件 (${row.attachment_original_name || path.basename(row.attachment_path)})`
          }
        : null;

      for (const p of parties) {
        const rawValues = [
          row.seq_label || String(row.seq_no || ''),
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
          ''
        ];

        const styledRow = rawValues.map((val, colIdx) => buildStyledCell(val, colIdx, bgRgb, colIdx === 29 ? linkMeta : null));
        aoa.push(styledRow);
        rowHeights.push({ hpt: 22 });
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
    });

    worksheet = XLSX.utils.aoa_to_sheet(aoa);
    worksheet['!merges'] = merges;
    worksheet['!cols'] = colSpecs.map(c => ({ wch: c.wch }));
    worksheet['!rows'] = rowHeights;

    workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '合同台账');

    buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const fileName = encodeURIComponent(`合同台账_${getLocalTodayStr()}.xlsx`);

    // 立即解除大型中间对象引用，协助 V8 垃圾回收器释放内存
    aoa = null;
    worksheet = null;
    workbook = null;

    res.on('finish', () => {
      buffer = null;
      triggerSafeGC();
    });

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    aoa = null;
    worksheet = null;
    workbook = null;
    buffer = null;
    triggerSafeGC();
    res.status(500).json({ success: false, message: '导出失败: ' + err.message });
  }
});

app.get('/api/contracts/:id', (req, res) => {
  const row = STMTS.getContractById.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: '未找到该合同记录' });
  res.json({ success: true, data: row });
});

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
    const cleanSignDate = smartParseDate(sign_date, '签订日期', true);
    const cleanStartDate = (start_date && String(start_date).trim())
      ? smartParseDate(start_date, '开始履约日期', true)
      : cleanSignDate;
    const cleanExpiryDate = smartParseDate(expiry_date, '合同到期日期', true);

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
        cleanSignDate, cleanStartDate, cleanExpiryDate,
        totalAmount, totalExcl, firstParty.tax_rate, firstParty.invoice_type, firstParty.currency,
        firstParty.perf_bond_amount, firstParty.perf_bond_pay_date, earliestPerfReturn,
        firstParty.warranty_bond_amount, earliestWarrantyExpiry,
        status || '生效中', firstParty.remark,
        archivedFile ? archivedFile.attachment_path : null,
        archivedFile ? archivedFile.attachment_original_name : null
      );

      syncContractParties(info.lastInsertRowid, counterpartiesList);
      recalculateAllSequences();
      return info.lastInsertRowid;
    });

    const newId = createTx();
    if (req.file) triggerSafeGC();
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

app.put('/api/contracts/:id', upload.single('attachment'), (req, res) => {
  let newlyArchivedFile = null;
  try {
    const existing = STMTS.getContractById.get(req.params.id);
    if (!existing) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      return res.status(404).json({ success: false, message: '合同不存在' });
    }

    const {
      contract_no, contract_name, contract_type, our_entity,
      sign_date, start_date, expiry_date, status
    } = req.body;

    const cleanNo = contract_no.trim();
    const cleanName = contract_name.trim();
    const cleanSignDate = smartParseDate(sign_date, '签订日期', true);
    const cleanStartDate = (start_date && String(start_date).trim())
      ? smartParseDate(start_date, '开始履约日期', true)
      : cleanSignDate;
    const cleanExpiryDate = smartParseDate(expiry_date, '合同到期日期', true);

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
        cleanSignDate, cleanStartDate, cleanExpiryDate,
        totalAmount, totalExcl, firstParty.tax_rate, firstParty.invoice_type, firstParty.currency,
        firstParty.perf_bond_amount, firstParty.perf_bond_pay_date, earliestPerfReturn,
        firstParty.warranty_bond_amount, earliestWarrantyExpiry,
        status, firstParty.remark,
        attachment_path, attachment_original_name, req.params.id
      );

      syncContractParties(req.params.id, counterpartiesList);
      recalculateAllSequences();
    });

    updateTx();
    if (req.file) triggerSafeGC();
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
  const existing = STMTS.getContractById.get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });

  const deleteTx = db.transaction(() => {
    STMTS.deletePartiesByContractId.run(req.params.id);
    STMTS.deleteContractById.run(req.params.id);
    recalculateAllSequences();
  });
  deleteTx();
  removeFileIfExists(existing.attachment_path);

  res.json({ success: true, message: '合同及关联扫描件已删除' });
});

app.post('/api/contracts/:id/attachment', upload.single('attachment'), (req, res) => {
  try {
    const existing = STMTS.getContractById.get(req.params.id);
    if (!existing) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
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

    triggerSafeGC();
    res.json({ success: true, message: '扫描件已按规范命名归档', data: archived });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/contracts/:id/attachment', (req, res) => {
  const existing = STMTS.getContractById.get(req.params.id);
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
  const existing = STMTS.getContractById.get(req.params.id);
  if (!existing || !existing.attachment_path) {
    return res.status(404).send('该合同尚未上传扫描件');
  }
  const fullPath = path.resolve(DATA_ROOT, existing.attachment_path);
  const uploadDirWithSep = UPLOAD_DIR.endsWith(path.sep) ? UPLOAD_DIR : UPLOAD_DIR + path.sep;
  if (!fullPath.startsWith(uploadDirWithSep) || !fs.existsSync(fullPath)) {
    return res.status(404).send('扫描件物理文件不存在');
  }
  res.download(fullPath, existing.attachment_original_name);
});

app.use((err, req, res, next) => {
  if (req.file && req.file.path && fs.existsSync(req.file.path)) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
  }
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
  const PORT = process.env.PORT || 3000;
  startServer(PORT, '127.0.0.1').then(({ port, shutdown }) => {
    console.log(`✅ 服务已启动: http://127.0.0.1:${port}`);
    process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
    process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
  });
}

module.exports = { app, db, startServer, sweepOrphanUploads };
