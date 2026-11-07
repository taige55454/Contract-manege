const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. 确保上传目录与临时目录存在
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.tmp');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TMP_UPLOAD_DIR)) fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });

// 2. 中间件配置
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 静态托管扫描件供浏览器内置预览（设置 inline 与 UTF-8 文件名支持）
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// 3. 初始化 SQLite 数据库与自动平滑迁移
const dbPath = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
    party_role TEXT NOT NULL DEFAULT '对方单位',
    company_name TEXT NOT NULL,
    credit_code TEXT NOT NULL,
    contact_person TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    bank_account_name TEXT DEFAULT '',
    bank_account_no TEXT DEFAULT '',
    bank_name TEXT DEFAULT '',
    bank_code TEXT DEFAULT '',
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_contract_no ON contracts(contract_no);
  CREATE INDEX IF NOT EXISTS idx_counterparty ON contracts(counterparty);
  CREATE INDEX IF NOT EXISTS idx_sign_date ON contracts(sign_date);
  CREATE INDEX IF NOT EXISTS idx_expiry_date ON contracts(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_party_contract_id ON contract_parties(contract_id);
`);

// 兼容旧版数据库平滑升级（若从 v1 升级，自动补齐新增列）
const existingCols = db.prepare(`PRAGMA table_info(contracts)`).all().map(c => c.name);
const alterColumns = [
  ['contract_summary', `TEXT DEFAULT ''`],
  ['counterparties_json', `TEXT NOT NULL DEFAULT '[]'`],
  ['start_date', `TEXT DEFAULT ''`],
  ['amount_excl_tax', `REAL DEFAULT NULL`],
  ['tax_rate', `TEXT DEFAULT ''`],
  ['invoice_type', `TEXT DEFAULT ''`],
  ['perf_bond_amount', `REAL DEFAULT NULL`],
  ['perf_bond_pay_date', `TEXT DEFAULT ''`],
  ['perf_bond_return_date', `TEXT DEFAULT ''`],
  ['warranty_bond_amount', `REAL DEFAULT NULL`],
  ['warranty_bond_expiry_date', `TEXT DEFAULT ''`]
];
for (const [col, def] of alterColumns) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE contracts ADD COLUMN ${col} ${def}`);
  }
}

// ==================== 工具与安全校验函数 ====================

// 清洗文件名中的非法系统字符，防止路径穿越与写入失败
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

// 安全删除物理文件（带目录边界检查，防止越权删除）
function removeFileIfExists(relativePath) {
  if (!relativePath) return;
  const fullPath = path.resolve(__dirname, relativePath);
  if (!fullPath.startsWith(UPLOAD_DIR)) return;
  if (fs.existsSync(fullPath)) {
    try { fs.unlinkSync(fullPath); } catch (err) { console.error('文件清理失败:', err.message); }
  }
}

// 将临时上传的文件归档为标准命名文件
function finalizeUploadedFile(tempFile, contractNo, contractName, signDate) {
  const ext = path.extname(tempFile.originalname).toLowerCase();
  const standardName = buildStandardAttachmentName(contractNo, contractName, signDate, ext);
  const targetFullPath = path.join(UPLOAD_DIR, standardName);

  // 如果目标同名文件已存在则先覆盖移除
  if (fs.existsSync(targetFullPath)) {
    try { fs.unlinkSync(targetFullPath); } catch (e) {}
  }
  fs.renameSync(tempFile.path, targetFullPath);
  return {
    attachment_path: `uploads/${standardName}`,
    attachment_original_name: standardName
  };
}

// 解析可空浮点数
function parseNullableFloat(val) {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

// 校验税率格式：可为空；若多税率，必须以 * 开头并用英文或中文逗号分隔
function validateAndNormalizeTaxRate(taxRateRaw) {
  if (!taxRateRaw || !String(taxRateRaw).trim()) return '';
  const str = String(taxRateRaw).trim().replace(/，/g, ',');
  if (str.includes(',') && !str.startsWith('*')) {
    throw new Error('填写多个税率时，必须在最前面加上 * 号并用逗号隔开（例如：*6%,13%）');
  }
  return str;
}

// 解析并校验多方对方单位数据
function parseCounterparties(body) {
  let list = [];
  if (body.counterparties_json) {
    try {
      list = typeof body.counterparties_json === 'string'
        ? JSON.parse(body.counterparties_json)
        : body.counterparties_json;
    } catch (e) {
      throw new Error('对方单位多方数据格式解析失败');
    }
  } else if (body.counterparty) {
    // 兼容简单单文本提交
    list = [{
      company_name: String(body.counterparty).trim(),
      credit_code: String(body.credit_code || '未填').trim(),
      contact_person: '',
      contact_phone: '',
      bank_account_name: '',
      bank_account_no: '',
      bank_name: '',
      bank_code: ''
    }];
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('请至少添加一方对方单位信息');
  }

  const normalized = list.map((item, idx) => {
    const company_name = String(item.company_name || '').trim();
    const credit_code = String(item.credit_code || '').trim();
    if (!company_name) throw new Error(`第 ${idx + 1} 个对方单位的“单位名称”不能为空`);
    if (!credit_code) throw new Error(`第 ${idx + 1} 个对方单位（${company_name}）的“统一信用代码”不能为空`);
    return {
      company_name,
      credit_code,
      contact_person: String(item.contact_person || '').trim(),
      contact_phone: String(item.contact_phone || '').trim(),
      bank_account_name: String(item.bank_account_name || '').trim(),
      bank_account_no: String(item.bank_account_no || '').trim(),
      bank_name: String(item.bank_name || '').trim(),
      bank_code: String(item.bank_code || '').trim()
    };
  });

  const summaryNames = normalized.map(p => p.company_name).join('、');
  return {
    counterpartySummary: summaryNames,
    counterpartiesJson: JSON.stringify(normalized),
    counterpartiesList: normalized
  };
}

// 4. 配置 Multer 文件上传（先暂存至 .tmp 目录，校验通过后按规则重命名）
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
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持上传 PDF、JPG、PNG 格式的扫描件'));
    }
  }
});

// 构建动态筛选与排序 SQL（供列表查询与 Excel 导出复用）
function buildQuery(queryParams) {
  const { contract_no, counterparty, contract_type, status, sort_by, sort_order } = queryParams;
  let sql = `SELECT * FROM contracts WHERE 1=1`;
  const params = [];

  if (contract_no && contract_no.trim()) {
    sql += ` AND (contract_no LIKE ? OR contract_name LIKE ? OR contract_summary LIKE ?)`;
    const kw = `%${contract_no.trim()}%`;
    params.push(kw, kw, kw);
  }
  if (counterparty && counterparty.trim()) {
    // 支持按我方主体、对方单位名称、统一信用代码或联系人搜索
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

// 同步更新子表 contract_parties
const syncPartiesStmt = db.prepare(`
  INSERT INTO contract_parties (
    contract_id, company_name, credit_code, contact_person, contact_phone,
    bank_account_name, bank_account_no, bank_name, bank_code
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function syncContractParties(contractId, partiesList) {
  db.prepare(`DELETE FROM contract_parties WHERE contract_id = ?`).run(contractId);
  for (const p of partiesList) {
    syncPartiesStmt.run(
      contractId, p.company_name, p.credit_code, p.contact_person, p.contact_phone,
      p.bank_account_name, p.bank_account_no, p.bank_name, p.bank_code
    );
  }
}

// ==================== API 路由 ====================

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

// [GET] 导出 Excel（严格与页面表格列顺序一致，并包含对方多方明细展开列）
app.get('/api/contracts/export', (req, res) => {
  try {
    const queryObj = req.query.scope === 'all'
      ? { sort_by: req.query.sort_by, sort_order: req.query.sort_order }
      : req.query;

    const { sql, params } = buildQuery(queryObj);
    const rows = db.prepare(sql).all(...params);

    const excelData = rows.map(row => {
      let parties = [];
      try { parties = JSON.parse(row.counterparties_json || '[]'); } catch (e) {}
      const formattedParties = parties.map((p, idx) => {
        const parts = [`[${idx + 1}] ${p.company_name} (信用代码:${p.credit_code})`];
        if (p.contact_person || p.contact_phone) parts.push(`联系人:${p.contact_person || '-'} ${p.contact_phone || ''}`);
        if (p.bank_account_no || p.bank_name) {
          parts.push(`收款:${p.bank_account_name || '-'} | 账号:${p.bank_account_no || '-'} | 开户行:${p.bank_name || '-'}(行号:${p.bank_code || '-'})`);
        }
        return parts.join(' ');
      }).join('；\n');

      return {
        '合同编号': row.contract_no,
        '合同名称': row.contract_name,
        '合同摘要': row.contract_summary || '',
        '合同类型': row.contract_type,
        '我方签约主体(可多方)': row.our_entity,
        '对方单位(汇总)': row.counterparty,
        '对方单位详细信息(多方)': formattedParties || row.counterparty,
        '签订日期': row.sign_date,
        '开始履约日期': row.start_date || row.sign_date,
        '到期日期': row.expiry_date,
        '含税总金额': Number(row.amount),
        '不含税金额': row.amount_excl_tax !== null ? Number(row.amount_excl_tax) : '',
        '税率': row.tax_rate || '',
        '发票类型': row.invoice_type || '',
        '币种': row.currency,
        '履约保证金(元)': row.perf_bond_amount !== null ? Number(row.perf_bond_amount) : '',
        '保证金缴纳日期': row.perf_bond_pay_date || '',
        '保证金应退日期': row.perf_bond_return_date || '',
        '质保金(元)': row.warranty_bond_amount !== null ? Number(row.warranty_bond_amount) : '',
        '质保金到期日期': row.warranty_bond_expiry_date || '',
        '合同状态': row.status,
        '扫描件归档名': row.attachment_original_name || '未上传',
        '备注': row.remark || ''
      };
    });

    const worksheet = xlsx.utils.json_to_sheet(excelData);
    worksheet['!cols'] = [
      { wch: 16 }, { wch: 22 }, { wch: 26 }, { wch: 10 }, { wch: 22 },
      { wch: 24 }, { wch: 48 }, { wch: 13 }, { wch: 13 }, { wch: 13 },
      { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 8 },
      { wch: 15 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
      { wch: 10 }, { wch: 32 }, { wch: 24 }
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

// [POST] 新增合同（事务级写入 + 扫描件按 合同编号+合同名称+签订日期 命名）
app.post('/api/contracts', upload.single('attachment'), (req, res) => {
  let archivedFile = null;
  try {
    const {
      contract_no, contract_name, contract_summary, contract_type, our_entity,
      sign_date, start_date, expiry_date, amount, amount_excl_tax,
      tax_rate, invoice_type, currency,
      perf_bond_amount, perf_bond_pay_date, perf_bond_return_date,
      warranty_bond_amount, warranty_bond_expiry_date, status, remark
    } = req.body;

    if (!contract_no || !contract_name || !our_entity || !sign_date || !expiry_date) {
      throw new Error('请完整填写必填项（合同编号、名称、我方主体、签订日、到期日）');
    }

    const cleanNo = contract_no.trim();
    const cleanName = contract_name.trim();
    const cleanSignDate = sign_date.trim();
    const cleanStartDate = (start_date && start_date.trim()) ? start_date.trim() : cleanSignDate;
    const cleanTaxRate = validateAndNormalizeTaxRate(tax_rate);
    const { counterpartySummary, counterpartiesJson, counterpartiesList } = parseCounterparties(req.body);

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
        cleanNo, cleanName, (contract_summary || '').trim(), contract_type,
        our_entity.trim(), counterpartySummary, counterpartiesJson,
        cleanSignDate, cleanStartDate, expiry_date.trim(),
        parseFloat(amount) || 0, parseNullableFloat(amount_excl_tax),
        cleanTaxRate, (invoice_type || '').trim(), (currency || 'CNY').trim(),
        parseNullableFloat(perf_bond_amount), (perf_bond_pay_date || '').trim(), (perf_bond_return_date || '').trim(),
        parseNullableFloat(warranty_bond_amount), (warranty_bond_expiry_date || '').trim(),
        status || '生效中', (remark || '').trim(),
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

// [PUT] 编辑合同（若修改了编号/名称/签订日，自动同步重命名已有扫描件）
app.put('/api/contracts/:id', upload.single('attachment'), (req, res) => {
  let newlyArchivedFile = null;
  try {
    const existing = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
    if (!existing) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: '合同不存在' });
    }

    const {
      contract_no, contract_name, contract_summary, contract_type, our_entity,
      sign_date, start_date, expiry_date, amount, amount_excl_tax,
      tax_rate, invoice_type, currency,
      perf_bond_amount, perf_bond_pay_date, perf_bond_return_date,
      warranty_bond_amount, warranty_bond_expiry_date, status, remark
    } = req.body;

    const cleanNo = contract_no.trim();
    const cleanName = contract_name.trim();
    const cleanSignDate = sign_date.trim();
    const cleanStartDate = (start_date && start_date.trim()) ? start_date.trim() : cleanSignDate;
    const cleanTaxRate = validateAndNormalizeTaxRate(tax_rate);
    const { counterpartySummary, counterpartiesJson, counterpartiesList } = parseCounterparties(req.body);

    const updateTx = db.transaction(() => {
      let attachment_path = existing.attachment_path;
      let attachment_original_name = existing.attachment_original_name;

      if (req.file) {
        // 上传了新扫描件：删除旧文件，并将新文件按 合同编号+合同名称+签订日期 归档
        removeFileIfExists(existing.attachment_path);
        newlyArchivedFile = finalizeUploadedFile(req.file, cleanNo, cleanName, cleanSignDate);
        attachment_path = newlyArchivedFile.attachment_path;
        attachment_original_name = newlyArchivedFile.attachment_original_name;
      } else if (existing.attachment_path) {
        // 未上传新扫描件，但检查是否修改了编号/名称/签订日期，若是则同步重命名磁盘文件
        const oldFullPath = path.resolve(__dirname, existing.attachment_path);
        if (fs.existsSync(oldFullPath)) {
          const ext = path.extname(oldFullPath);
          const expectedName = buildStandardAttachmentName(cleanNo, cleanName, cleanSignDate, ext);
          const expectedRelPath = `uploads/${expectedName}`;
          if (expectedRelPath !== existing.attachment_path) {
            const newFullPath = path.join(UPLOAD_DIR, expectedName);
            fs.renameSync(oldFullPath, newFullPath);
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
        cleanNo, cleanName, (contract_summary || '').trim(), contract_type,
        our_entity.trim(), counterpartySummary, counterpartiesJson,
        cleanSignDate, cleanStartDate, expiry_date.trim(),
        parseFloat(amount) || 0, parseNullableFloat(amount_excl_tax),
        cleanTaxRate, (invoice_type || '').trim(), (currency || 'CNY').trim(),
        parseNullableFloat(perf_bond_amount), (perf_bond_pay_date || '').trim(), (perf_bond_return_date || '').trim(),
        parseNullableFloat(warranty_bond_amount), (warranty_bond_expiry_date || '').trim(),
        status, (remark || '').trim(),
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

// [DELETE] 删除整条合同记录
app.delete('/api/contracts/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: '合同不存在' });

  removeFileIfExists(existing.attachment_path);
  db.prepare(`DELETE FROM contracts WHERE id = ?`).run(req.params.id);
  res.json({ success: true, message: '合同及关联扫描件已删除' });
});

// [POST] 详情页单独上传/替换扫描件（自动以 合同编号+合同名称+签订日期 命名）
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

// [DELETE] 仅删除合同关联的扫描件
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

// [GET] 下载扫描件（文件名即为 合同编号+合同名称+签订日期.ext）
app.get('/api/contracts/:id/download', (req, res) => {
  const existing = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(req.params.id);
  if (!existing || !existing.attachment_path) {
    return res.status(404).send('该合同尚未上传扫描件');
  }
  const fullPath = path.resolve(__dirname, existing.attachment_path);
  if (!fullPath.startsWith(UPLOAD_DIR) || !fs.existsSync(fullPath)) {
    return res.status(404).send('扫描件物理文件不存在');
  }
  res.download(fullPath, existing.attachment_original_name);
});

// 全局错误拦截中间件
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: '扫描件大小不能超过 20MB' });
  }
  res.status(400).json({ success: false, message: err.message || '服务器请求处理异常' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 企业合同台账管理系统 v2.0 已启动: http://localhost:${PORT}`);
  });
}

module.exports = { app, db };
