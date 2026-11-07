let currentContracts = [];
let defaultOurEntity = '';
let contractNoRule = {
  prefix: 'HT-',
  date_part: 'YYYY-',
  seq_digits: 3,
  suffix: ''
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function fmtMoney(val) {
  if (val === null || val === undefined || val === '') return '-';
  const num = Number(val);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
}

// 到期日由绿到红平滑光谱颜色计算（越接近到期日颜色越红越深）
function renderDueAlertBadge(dateStr, contractStatus = '生效中', prefixLabel = '') {
  if (!dateStr || !String(dateStr).trim()) return '<span style="color:#9ca3af;">-</span>';
  if (contractStatus === '已终止') {
    return `<span class="due-chip" style="background:#e5e7eb;color:#4b5563;">${escapeHtml(dateStr)} (已终止)</span>`;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  if (isNaN(target.getTime())) return escapeHtml(dateStr);

  const diffDays = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
  const maxSafeDays = 90;
  let bg = '';
  let fg = '#ffffff';
  let tip = '';

  if (diffDays < 0) {
    bg = 'hsl(0, 82%, 30%)';
    tip = `已逾期 ${Math.abs(diffDays)} 天`;
  } else if (diffDays <= maxSafeDays) {
    const ratio = diffDays / maxSafeDays;
    const hue = Math.round(ratio * 130);
    const saturation = Math.round(80 - ratio * 15);
    const lightness = Math.round(35 + ratio * 8);
    bg = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    tip = diffDays === 0 ? '今日到期!' : `剩 ${diffDays} 天`;
  } else {
    bg = 'hsl(135, 55%, 90%)';
    fg = 'hsl(135, 75%, 22%)';
    tip = `剩 ${diffDays} 天`;
  }

  const prefix = prefixLabel ? `${escapeHtml(prefixLabel)}: ` : '';
  return `<span class="due-chip" style="background:${bg};color:${fg};" title="${escapeHtml(tip)}">
    ${prefix}${escapeHtml(dateStr)} <small>(${escapeHtml(tip)})</small>
  </span>`;
}

// ==================== 合同编号固定前缀/后缀与流水号规则管理 ====================
async function loadContractNoRule() {
  try {
    const res = await fetch('/api/settings/contract-no-rule');
    const result = await res.json();
    if (result.success) {
      contractNoRule = result.rule;
      document.getElementById('display_no_rule').innerText = result.sample_next_no || '未设置';
    }
  } catch (e) {}
}

function formatClientDatePart(datePartRule) {
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
    default: return '';
  }
}

function updateNoRulePreview() {
  const prefix = document.getElementById('rule_prefix').value.trim();
  const datePart = document.getElementById('rule_date_part').value;
  const digits = Number(document.getElementById('rule_seq_digits').value || 0);
  const suffix = document.getElementById('rule_suffix').value.trim();
  const dateStr = formatClientDatePart(datePart);
  const seqStr = digits > 0 ? String(1).padStart(digits, '0') : '[手填编号]';
  document.getElementById('rule_live_preview').innerText = `${prefix}${dateStr}${seqStr}${suffix}`;
}

function openNoRuleModal() {
  document.getElementById('rule_prefix').value = contractNoRule.prefix || '';
  document.getElementById('rule_date_part').value = contractNoRule.date_part || 'YYYY-';
  document.getElementById('rule_seq_digits').value = String(contractNoRule.seq_digits ?? 3);
  document.getElementById('rule_suffix').value = contractNoRule.suffix || '';
  updateNoRulePreview();
  document.getElementById('no_rule_modal').classList.remove('hidden');
}

function closeNoRuleModal() {
  document.getElementById('no_rule_modal').classList.add('hidden');
}

async function saveNoRuleForm(e) {
  e.preventDefault();
  const payload = {
    prefix: document.getElementById('rule_prefix').value.trim(),
    date_part: document.getElementById('rule_date_part').value,
    seq_digits: Number(document.getElementById('rule_seq_digits').value),
    suffix: document.getElementById('rule_suffix').value.trim()
  };

  const res = await fetch('/api/settings/contract-no-rule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  contractNoRule = result.rule;
  document.getElementById('display_no_rule').innerText = result.sample_next_no;
  closeNoRuleModal();

  // 如果当前正处于“新增合同”弹窗打开状态，同步刷新里面的合同编号
  const formModal = document.getElementById('form_modal');
  const formId = document.getElementById('form_id').value;
  if (!formModal.classList.contains('hidden') && !formId) {
    document.getElementById('f_contract_no').value = result.sample_next_no;
  }
}

async function fillAutoContractNo() {
  try {
    const res = await fetch('/api/contracts/next-no');
    const result = await res.json();
    if (result.success) {
      document.getElementById('f_contract_no').value = result.next_no;
      document.getElementById('display_no_rule').innerText = result.next_no;
    }
  } catch (e) {}
}

// ==================== 默认我方签约主体管理 ====================
async function loadDefaultOurEntity() {
  try {
    const res = await fetch('/api/settings/our-entity');
    const result = await res.json();
    if (result.success) {
      defaultOurEntity = result.default_our_entity;
      document.getElementById('display_default_entity').innerText = defaultOurEntity;
    }
  } catch (e) {}
}

async function changeDefaultOurEntity() {
  const newVal = prompt('请输入本台账默认带出的【我方签约主体】全称（后续新增合同时将自动填入，且允许单次修改）：', defaultOurEntity);
  if (newVal === null) return;
  if (!newVal.trim()) return alert('默认我方主体名称不能为空！');

  const res = await fetch('/api/settings/our-entity', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_our_entity: newVal.trim() })
  });
  const result = await res.json();
  if (!result.success) return alert(result.message);
  defaultOurEntity = result.default_our_entity;
  document.getElementById('display_default_entity').innerText = defaultOurEntity;
}

// 解析单条合同的多方履约行列表
function parseContractParties(c) {
  let parties = [];
  try { parties = JSON.parse(c.counterparties_json || '[]'); } catch (e) {}
  if (!Array.isArray(parties) || parties.length === 0) {
    parties = [{
      company_name: c.counterparty || '-',
      credit_code: '-',
      contact_person: '',
      contact_phone: '',
      bank_account_name: '',
      bank_account_no: '',
      bank_name: '',
      bank_code: '',
      item_summary: c.contract_summary || '',
      amount: c.amount,
      amount_excl_tax: c.amount_excl_tax,
      tax_rate: c.tax_rate || '',
      invoice_type: c.invoice_type || '',
      currency: c.currency || 'CNY',
      perf_bond_amount: c.perf_bond_amount,
      perf_bond_pay_date: c.perf_bond_pay_date || '',
      perf_bond_return_date: c.perf_bond_return_date || '',
      warranty_bond_amount: c.warranty_bond_amount,
      warranty_bond_expiry_date: c.warranty_bond_expiry_date || '',
      remark: c.remark || ''
    }];
  }
  return parties;
}

function getFilterParams() {
  return new URLSearchParams({
    contract_no: document.getElementById('filter_no').value.trim(),
    counterparty: document.getElementById('filter_counterparty').value.trim(),
    contract_type: document.getElementById('filter_type').value,
    status: document.getElementById('filter_status').value,
    sort_by: document.getElementById('sort_by').value,
    sort_order: document.getElementById('sort_order').value
  });
}

// 加载台账列表（支持多对方单位拆分为多行 + 公共字段自动 rowspan 合并单元格）
async function loadContracts() {
  const params = getFilterParams();
  const res = await fetch(`/api/contracts?${params.toString()}`);
  const result = await res.json();
  if (!result.success) return alert(result.message);

  currentContracts = result.data;
  const tbody = document.getElementById('contract_tbody');
  if (currentContracts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="23" style="text-align:center;color:#6b7280;padding:28px;">暂无匹配的合同台账记录</td></tr>`;
    return;
  }

  const htmlRows = [];

  for (const c of currentContracts) {
    const parties = parseContractParties(c);
    const spanCount = parties.length;

    parties.forEach((p, idx) => {
      const isFirstRow = idx === 0;
      const isLastRow = idx === spanCount - 1;

      // 履约保证金展示
      let perfBondHtml = '<span style="color:#9ca3af;">-</span>';
      if ((p.perf_bond_amount !== null && p.perf_bond_amount !== undefined && p.perf_bond_amount !== '') || p.perf_bond_return_date) {
        const amtStr = (p.perf_bond_amount !== null && p.perf_bond_amount !== undefined && p.perf_bond_amount !== '') ? `¥${fmtMoney(p.perf_bond_amount)} ` : '';
        const payStr = p.perf_bond_pay_date ? `<small style="color:#6b7280;">(缴:${escapeHtml(p.perf_bond_pay_date)})</small> ` : '';
        const badge = p.perf_bond_return_date ? renderDueAlertBadge(p.perf_bond_return_date, c.status, '应退') : '';
        perfBondHtml = `<div>${amtStr}${payStr}${badge}</div>`;
      }

      // 质保金展示
      let warrantyHtml = '<span style="color:#9ca3af;">-</span>';
      if ((p.warranty_bond_amount !== null && p.warranty_bond_amount !== undefined && p.warranty_bond_amount !== '') || p.warranty_bond_expiry_date) {
        const amtStr = (p.warranty_bond_amount !== null && p.warranty_bond_amount !== undefined && p.warranty_bond_amount !== '') ? `¥${fmtMoney(p.warranty_bond_amount)} ` : '';
        const badge = p.warranty_bond_expiry_date ? renderDueAlertBadge(p.warranty_bond_expiry_date, c.status, '到期') : '';
        warrantyHtml = `<div>${amtStr}${badge}</div>`;
      }

      const contactStr = (p.contact_person || p.contact_phone)
        ? `${escapeHtml(p.contact_person || '-')} ${escapeHtml(p.contact_phone || '')}`
        : '-';

      const bankParts = [];
      if (p.bank_account_name) bankParts.push(`户名:${p.bank_account_name}`);
      if (p.bank_account_no) bankParts.push(`账号:${p.bank_account_no}`);
      if (p.bank_name) bankParts.push(`开户行:${p.bank_name}`);
      if (p.bank_code) bankParts.push(`行号:${p.bank_code}`);
      const bankSummary = bankParts.length > 0 ? bankParts.join(' | ') : '-';

      htmlRows.push(`
        <tr class="${isLastRow ? 'contract-group-end' : ''}">
          ${isFirstRow ? `
            <td class="merged-cell" rowspan="${spanCount}"><strong>${escapeHtml(c.contract_no)}</strong></td>
            <td class="merged-cell" rowspan="${spanCount}">${escapeHtml(c.contract_name)}</td>
            <td class="merged-cell" rowspan="${spanCount}">${escapeHtml(c.contract_type)}</td>
            <td class="merged-cell" rowspan="${spanCount}">${escapeHtml(c.our_entity)}</td>
            <td class="merged-cell" rowspan="${spanCount}">${escapeHtml(c.sign_date)}</td>
            <td class="merged-cell" rowspan="${spanCount}">${escapeHtml(c.start_date || c.sign_date)}</td>
            <td class="merged-cell" rowspan="${spanCount}">${renderDueAlertBadge(c.expiry_date, c.status)}</td>
            <td class="merged-cell" rowspan="${spanCount}"><span class="badge badge-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
          ` : ''}
          <!-- 各对方单位独立履约列 -->
          <td class="summary-cell" title="${escapeHtml(p.item_summary || '')}">${escapeHtml(p.item_summary || '-')}</td>
          <td><strong>${escapeHtml(p.company_name)}</strong></td>
          <td>${escapeHtml(p.credit_code)}</td>
          <td>${contactStr}</td>
          <td class="summary-cell" title="${escapeHtml(bankSummary)}">${escapeHtml(bankSummary)}</td>
          <td class="text-right"><strong>${fmtMoney(p.amount)}</strong></td>
          <td class="text-right">${fmtMoney(p.amount_excl_tax)}</td>
          <td>${escapeHtml(p.tax_rate || '-')}</td>
          <td>${escapeHtml(p.invoice_type || '-')}</td>
          <td>${escapeHtml(p.currency || c.currency || 'CNY')}</td>
          <td>${perfBondHtml}</td>
          <td>${warrantyHtml}</td>
          <td class="summary-cell" title="${escapeHtml(p.remark || '')}">${escapeHtml(p.remark || '-')}</td>
          ${isFirstRow ? `
            <td class="merged-cell" rowspan="${spanCount}">
              ${c.attachment_path
                ? `<a class="link-btn" onclick="openDetailModal(${c.id})" title="点击在线预览扫描件">📎 ${escapeHtml(c.attachment_original_name)}</a>`
                : `<span style="color:#9ca3af;">无扫描件</span>`}
            </td>
            <td class="merged-cell" rowspan="${spanCount}">
              <button class="btn btn-outline btn-sm" onclick="openDetailModal(${c.id})">详情 / 扫描件</button>
              <button class="btn btn-outline btn-sm" onclick="openFormModal(${c.id})">编辑</button>
              <button class="btn btn-danger btn-sm" onclick="deleteContract(${c.id})">删除</button>
            </td>
          ` : ''}
        </tr>
      `);
    });
  }

  tbody.innerHTML = htmlRows.join('');
}

function resetFilters() {
  document.getElementById('filter_no').value = '';
  document.getElementById('filter_counterparty').value = '';
  document.getElementById('filter_type').value = '';
  document.getElementById('filter_status').value = '';
  document.getElementById('sort_by').value = 'created_at';
  document.getElementById('sort_order').value = 'DESC';
  loadContracts();
}

function exportExcel(scope) {
  const params = getFilterParams();
  params.set('scope', scope);
  window.location.href = `/api/contracts/export?${params.toString()}`;
}

function syncStartDateDefault() {
  const signDate = document.getElementById('f_sign_date').value;
  const startDateInput = document.getElementById('f_start_date');
  if (!startDateInput.value || startDateInput.dataset.autoSync === 'true') {
    startDateInput.value = signDate;
    startDateInput.dataset.autoSync = 'true';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const startDateInput = document.getElementById('f_start_date');
  if (startDateInput) {
    startDateInput.addEventListener('input', () => {
      startDateInput.dataset.autoSync = 'false';
    });
  }
  await loadContractNoRule();
  await loadDefaultOurEntity();
  await loadContracts();
});

// ==================== 多方对方单位及独立履约行卡片管理 ====================

function addCounterpartyCard(data = {}) {
  const container = document.getElementById('counterparties_container');
  const index = container.children.length + 1;
  const card = document.createElement('div');
  card.className = 'party-card';
  card.innerHTML = `
    <div class="party-card-header">
      <span class="party-title">对方单位及独立履约行 #${index}</span>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeCounterpartyCard(this)">移除此履约方</button>
    </div>
    <div class="form-grid-4">
      <div class="form-group">
        <label>对方单位名称 *</label>
        <input type="text" class="p_company_name" value="${escapeHtml(data.company_name || '')}" placeholder="对方公司全称" required />
      </div>
      <div class="form-group">
        <label>统一社会信用代码 *</label>
        <input type="text" class="p_credit_code" value="${escapeHtml(data.credit_code || '')}" placeholder="18位信用代码" required />
      </div>
      <div class="form-group span-2">
        <label>本方履约摘要 <small class="muted">(简要概括该相对方的具体履约义务，各写各的)</small></label>
        <input type="text" class="p_item_summary" value="${escapeHtml(data.item_summary || '')}"
          placeholder="示例：负责核心数据库软件授权交付及3年原厂二线技术支持服务" />
      </div>

      <div class="form-group">
        <label>联系人 <small class="muted">(可留空)</small></label>
        <input type="text" class="p_contact_person" value="${escapeHtml(data.contact_person || '')}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>联系方式 <small class="muted">(可留空)</small></label>
        <input type="text" class="p_contact_phone" value="${escapeHtml(data.contact_phone || '')}" placeholder="手机号或座机" />
      </div>
      <div class="form-group">
        <label>收款账户名称 <small class="muted">(可留空)</small></label>
        <input type="text" class="p_bank_account_name" value="${escapeHtml(data.bank_account_name || '')}" placeholder="一般同单位名称" />
      </div>
      <div class="form-group">
        <label>收款银行账号 <small class="muted">(可留空)</small></label>
        <input type="text" class="p_bank_account_no" value="${escapeHtml(data.bank_account_no || '')}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>开户行名称 <small class="muted">(可留空)</small></label>
        <input type="text" class="p_bank_name" value="${escapeHtml(data.bank_name || '')}" placeholder="如：招行深圳高新园支行" />
      </div>
      <div class="form-group">
        <label>开户行行号 <small class="muted">(可留空)</small></label>
        <input type="text" class="p_bank_code" value="${escapeHtml(data.bank_code || '')}" placeholder="12位联行号，选填" />
      </div>

      <div class="party-sub-divider">💰 该相对方独立价款、税率、保证金与质保金信息：</div>

      <div class="form-group">
        <label>含税金额 * <small class="muted">(默认含税价)</small></label>
        <input type="number" step="0.01" class="p_amount" value="${data.amount !== undefined ? data.amount : '0.00'}" required />
      </div>
      <div class="form-group">
        <label>不含税价 <small class="muted">(可留空)</small></label>
        <input type="number" step="0.01" class="p_amount_excl_tax" value="${data.amount_excl_tax !== null && data.amount_excl_tax !== undefined ? data.amount_excl_tax : ''}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>税率 <small class="muted">(多税率前加*并用,隔开)</small></label>
        <input type="text" class="p_tax_rate" value="${escapeHtml(data.tax_rate || '')}" placeholder="如 13% 或 *6%,13%" />
      </div>
      <div class="form-group">
        <label>发票类型 <small class="muted">(可留空)</small></label>
        <input type="text" class="p_invoice_type" list="invoice_type_list" value="${escapeHtml(data.invoice_type || '')}" placeholder="可选或手填" />
      </div>
      <div class="form-group">
        <label>币种 *</label>
        <input type="text" class="p_currency" value="${escapeHtml(data.currency || 'CNY')}" required />
      </div>
      <div class="form-group">
        <label>履约保证金 <small class="muted">(可留空)</small></label>
        <input type="number" step="0.01" class="p_perf_bond_amount" value="${data.perf_bond_amount !== null && data.perf_bond_amount !== undefined ? data.perf_bond_amount : ''}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>保证金缴纳时间 <small class="muted">(可留空)</small></label>
        <input type="date" class="p_perf_bond_pay_date" value="${escapeHtml(data.perf_bond_pay_date || '')}" />
      </div>
      <div class="form-group">
        <label>保证金应退时间 <small class="muted">(预警)</small></label>
        <input type="date" class="p_perf_bond_return_date" value="${escapeHtml(data.perf_bond_return_date || '')}" />
      </div>
      <div class="form-group">
        <label>质保金金额 <small class="muted">(可留空)</small></label>
        <input type="number" step="0.01" class="p_warranty_bond_amount" value="${data.warranty_bond_amount !== null && data.warranty_bond_amount !== undefined ? data.warranty_bond_amount : ''}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>质保金到期时间 <small class="muted">(预警)</small></label>
        <input type="date" class="p_warranty_bond_expiry_date" value="${escapeHtml(data.warranty_bond_expiry_date || '')}" />
      </div>
      <div class="form-group span-2">
        <label>分项备注 <small class="muted">(可留空)</small></label>
        <input type="text" class="p_remark" value="${escapeHtml(data.remark || '')}" placeholder="针对该相对方的补充说明..." />
      </div>
    </div>
  `;
  container.appendChild(card);
  renumberCounterpartyCards();
}

function removeCounterpartyCard(btn) {
  const container = document.getElementById('counterparties_container');
  if (container.children.length <= 1) {
    return alert('合同至少需要保留一个对方单位履约行！');
  }
  btn.closest('.party-card').remove();
  renumberCounterpartyCards();
}

function renumberCounterpartyCards() {
  const cards = document.querySelectorAll('#counterparties_container .party-card');
  cards.forEach((card, idx) => {
    card.querySelector('.party-title').innerText = `对方单位及独立履约行 #${idx + 1}`;
  });
}

function collectCounterpartiesFromDOM() {
  const cards = document.querySelectorAll('#counterparties_container .party-card');
  return Array.from(cards).map((card, idx) => {
    const taxRateVal = card.querySelector('.p_tax_rate').value.trim().replace(/，/g, ',');
    if (taxRateVal.includes(',') && !taxRateVal.startsWith('*')) {
      throw new Error(`第 ${idx + 1} 个对方单位的税率填写了多个值，必须在最前面加 * 号并用逗号隔开（如：*6%,13%）`);
    }
    return {
      company_name: card.querySelector('.p_company_name').value.trim(),
      credit_code: card.querySelector('.p_credit_code').value.trim(),
      item_summary: card.querySelector('.p_item_summary').value.trim(),
      contact_person: card.querySelector('.p_contact_person').value.trim(),
      contact_phone: card.querySelector('.p_contact_phone').value.trim(),
      bank_account_name: card.querySelector('.p_bank_account_name').value.trim(),
      bank_account_no: card.querySelector('.p_bank_account_no').value.trim(),
      bank_name: card.querySelector('.p_bank_name').value.trim(),
      bank_code: card.querySelector('.p_bank_code').value.trim(),
      amount: card.querySelector('.p_amount').value,
      amount_excl_tax: card.querySelector('.p_amount_excl_tax').value,
      tax_rate: taxRateVal,
      invoice_type: card.querySelector('.p_invoice_type').value.trim(),
      currency: card.querySelector('.p_currency').value.trim() || 'CNY',
      perf_bond_amount: card.querySelector('.p_perf_bond_amount').value,
      perf_bond_pay_date: card.querySelector('.p_perf_bond_pay_date').value,
      perf_bond_return_date: card.querySelector('.p_perf_bond_return_date').value,
      warranty_bond_amount: card.querySelector('.p_warranty_bond_amount').value,
      warranty_bond_expiry_date: card.querySelector('.p_warranty_bond_expiry_date').value,
      remark: card.querySelector('.p_remark').value.trim()
    };
  });
}

// 打开新增 / 编辑弹窗
async function openFormModal(id = null) {
  const form = document.getElementById('contract_form');
  form.reset();
  document.getElementById('form_id').value = id || '';
  document.getElementById('form_modal_title').innerText = id ? '编辑合同台账' : '新增合同台账';
  const container = document.getElementById('counterparties_container');
  container.innerHTML = '';

  const startDateInput = document.getElementById('f_start_date');
  startDateInput.dataset.autoSync = id ? 'false' : 'true';

  if (id) {
    const c = currentContracts.find(item => item.id === id);
    if (c) {
      document.getElementById('f_contract_no').value = c.contract_no;
      document.getElementById('f_contract_name').value = c.contract_name;
      document.getElementById('f_contract_type').value = c.contract_type;
      document.getElementById('f_status').value = c.status;
      document.getElementById('f_our_entity').value = c.our_entity;
      document.getElementById('f_sign_date').value = c.sign_date;
      document.getElementById('f_start_date').value = c.start_date || c.sign_date;
      document.getElementById('f_expiry_date').value = c.expiry_date;

      const parties = parseContractParties(c);
      parties.forEach(p => addCounterpartyCard(p));
    }
  } else {
    // 新增合同时：自动带出默认我方签约主体（可改）+ 自动按前缀/后缀规则生成下一个合同编号（可改）
    document.getElementById('f_our_entity').value = defaultOurEntity;
    addCounterpartyCard();
    await fillAutoContractNo();
  }

  document.getElementById('form_modal').classList.remove('hidden');
}

function closeFormModal() {
  document.getElementById('form_modal').classList.add('hidden');
}

async function submitContractForm(e) {
  e.preventDefault();
  let parties = [];
  try {
    parties = collectCounterpartiesFromDOM();
  } catch (err) {
    return alert(err.message);
  }

  const id = document.getElementById('form_id').value;
  const formData = new FormData(document.getElementById('contract_form'));
  formData.set('counterparties_json', JSON.stringify(parties));

  const url = id ? `/api/contracts/${id}` : '/api/contracts';
  const method = id ? 'PUT' : 'POST';

  const res = await fetch(url, { method, body: formData });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  closeFormModal();
  await loadContractNoRule();
  await loadContracts();
}

async function deleteContract(id) {
  if (!confirm('确认删除该条合同台账及其关联的扫描件吗？此操作不可恢复。')) return;
  const res = await fetch(`/api/contracts/${id}`, { method: 'DELETE' });
  const result = await res.json();
  if (!result.success) return alert(result.message);
  await loadContractNoRule();
  await loadContracts();
}

async function openDetailModal(id) {
  const res = await fetch(`/api/contracts/${id}`);
  const result = await res.json();
  if (!result.success) return alert(result.message);

  const c = result.data;
  const parties = parseContractParties(c);

  const partiesDetailHtml = parties.map((p, idx) => `
    <div class="detail-card">
      <h4>🏢 对方单位及独立履约行 #${idx + 1}：${escapeHtml(p.company_name)}</h4>
      <div class="detail-row"><span class="label">统一社会信用代码</span><span class="val">${escapeHtml(p.credit_code)}</span></div>
      <div class="detail-row"><span class="label">本方履约摘要</span><span class="val">${escapeHtml(p.item_summary || '-')}</span></div>
      <div class="detail-row"><span class="label">联系人 / 联系方式</span><span class="val">${escapeHtml(p.contact_person || '-')} / ${escapeHtml(p.contact_phone || '-')}</span></div>
      <div class="detail-row"><span class="label">收款户名 / 账号</span><span class="val">${escapeHtml(p.bank_account_name || '-')} / ${escapeHtml(p.bank_account_no || '-')}</span></div>
      <div class="detail-row"><span class="label">开户行 / 行号</span><span class="val">${escapeHtml(p.bank_name || '-')} (${escapeHtml(p.bank_code || '-')})</span></div>
      <div class="detail-row"><span class="label">含税金额 / 不含税价</span><span class="val">${fmtMoney(p.amount)} / ${fmtMoney(p.amount_excl_tax)} (${escapeHtml(p.currency || 'CNY')})</span></div>
      <div class="detail-row"><span class="label">税率 / 发票类型</span><span class="val">${escapeHtml(p.tax_rate || '-')} / ${escapeHtml(p.invoice_type || '-')}</span></div>
      <div class="detail-row"><span class="label">履约保证金</span><span class="val">${fmtMoney(p.perf_bond_amount)} (缴纳:${escapeHtml(p.perf_bond_pay_date || '-')})</span></div>
      <div class="detail-row"><span class="label">保证金应退时间</span><span class="val">${renderDueAlertBadge(p.perf_bond_return_date, c.status)}</span></div>
      <div class="detail-row"><span class="label">质保金金额</span><span class="val">${fmtMoney(p.warranty_bond_amount)}</span></div>
      <div class="detail-row"><span class="label">质保金到期时间</span><span class="val">${renderDueAlertBadge(p.warranty_bond_expiry_date, c.status)}</span></div>
      <div class="detail-row"><span class="label">分项备注</span><span class="val">${escapeHtml(p.remark || '-')}</span></div>
    </div>
  `).join('');

  document.getElementById('detail_fields').innerHTML = `
    <div class="detail-card">
      <h4>📌 合同公共主信息 (合计含税总额: ${fmtMoney(c.amount)})</h4>
      <div class="detail-row"><span class="label">合同编号</span><span class="val">${escapeHtml(c.contract_no)}</span></div>
      <div class="detail-row"><span class="label">合同名称</span><span class="val">${escapeHtml(c.contract_name)}</span></div>
      <div class="detail-row"><span class="label">类型 / 状态</span><span class="val">${escapeHtml(c.contract_type)} · <span class="badge badge-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></span></div>
      <div class="detail-row"><span class="label">我方签约主体</span><span class="val">${escapeHtml(c.our_entity)}</span></div>
      <div class="detail-row"><span class="label">签订 / 开始履约日</span><span class="val">${escapeHtml(c.sign_date)} / ${escapeHtml(c.start_date || c.sign_date)}</span></div>
      <div class="detail-row"><span class="label">合同到期日</span><span class="val">${renderDueAlertBadge(c.expiry_date, c.status)}</span></div>
    </div>
    ${partiesDetailHtml}
  `;

  const toolbar = document.getElementById('attachment_toolbar');
  const preview = document.getElementById('preview_container');

  if (c.attachment_path) {
    const isPdf = c.attachment_path.toLowerCase().endsWith('.pdf');
    toolbar.innerHTML = `
      <div><strong>归档扫描件：</strong><code>${escapeHtml(c.attachment_original_name)}</code></div>
      <div style="display:flex;gap:8px;">
        <a class="btn btn-primary btn-sm" href="/api/contracts/${c.id}/download">⬇ 下载原件</a>
        <label class="btn btn-outline btn-sm" style="margin:0;">
          🔄 替换扫描件
          <input type="file" hidden accept=".pdf,.jpg,.jpeg,.png" onchange="uploadAttachmentInDetail(${c.id}, this)" />
        </label>
        <button class="btn btn-danger btn-sm" onclick="deleteAttachmentInDetail(${c.id})">🗑 删除扫描件</button>
      </div>
    `;
    const cacheBuster = `?t=${Date.now()}`;
    preview.innerHTML = isPdf
      ? `<iframe src="/${encodeURI(c.attachment_path)}${cacheBuster}"></iframe>`
      : `<img src="/${encodeURI(c.attachment_path)}${cacheBuster}" alt="合同扫描件预览" />`;
  } else {
    toolbar.innerHTML = `
      <div><span style="color:#6b7280;">当前未关联扫描件（上传后自动按“合同编号+合同名称+签订日期”命名）</span></div>
      <label class="btn btn-primary btn-sm" style="margin:0;">
        + 上传扫描件 (PDF/JPG/PNG)
        <input type="file" hidden accept=".pdf,.jpg,.jpeg,.png" onchange="uploadAttachmentInDetail(${c.id}, this)" />
      </label>
    `;
    preview.innerHTML = `<div class="empty-preview">暂无扫描件，请点击右上角按钮上传</div>`;
  }

  document.getElementById('detail_modal').classList.remove('hidden');
}

function closeDetailModal() {
  document.getElementById('detail_modal').classList.add('hidden');
  const preview = document.getElementById('preview_container');
  const iframe = preview.querySelector('iframe');
  if (iframe) {
    iframe.src = 'about:blank';
  }
  preview.innerHTML = '';
}

async function uploadAttachmentInDetail(id, fileInput) {
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append('attachment', fileInput.files[0]);

  const res = await fetch(`/api/contracts/${id}/attachment`, { method: 'POST', body: formData });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  await openDetailModal(id);
  loadContracts();
}

async function deleteAttachmentInDetail(id) {
  if (!confirm('确认删除该合同的扫描件吗？（合同台账记录将保留）')) return;
  const res = await fetch(`/api/contracts/${id}/attachment`, { method: 'DELETE' });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  await openDetailModal(id);
  loadContracts();
}
