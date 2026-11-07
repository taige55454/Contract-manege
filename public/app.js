let currentContracts = [];

// HTML 转义防止 XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// 格式化金额
function fmtMoney(val) {
  if (val === null || val === undefined || val === '') return '-';
  const num = Number(val);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
}

/**
 * 核心特性：到期日由绿到红平滑光谱颜色计算（越接近到期日颜色越红越深）
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} contractStatus - 合同状态（已终止则置灰不告警）
 */
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

  // 90天以上为安全翠绿(Hue=130)，0天为正红(Hue=0)，逾期为深暗红
  const maxSafeDays = 90;
  let bg = '';
  let fg = '#ffffff';
  let tip = '';

  if (diffDays < 0) {
    // 已逾期：深暗红警报
    bg = 'hsl(0, 82%, 30%)';
    tip = `已逾期 ${Math.abs(diffDays)} 天`;
  } else if (diffDays <= maxSafeDays) {
    // 0 ~ 90天：Hue 从 0 (红) 线性平滑插值到 130 (绿)；越接近0天，Lightness 越深(34% -> 42%)
    const ratio = diffDays / maxSafeDays; // 0(今天) ~ 1(90天后)
    const hue = Math.round(ratio * 130);
    const saturation = Math.round(80 - ratio * 15); // 越临近饱和度越高
    const lightness = Math.round(35 + ratio * 8);   // 越临近颜色越深
    bg = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    tip = diffDays === 0 ? '今日到期!' : `剩 ${diffDays} 天`;
  } else {
    // 超过 90 天：清爽浅绿底深绿字
    bg = 'hsl(135, 55%, 90%)';
    fg = 'hsl(135, 75%, 22%)';
    tip = `剩 ${diffDays} 天`;
  }

  const prefix = prefixLabel ? `${escapeHtml(prefixLabel)}: ` : '';
  return `<span class="due-chip" style="background:${bg};color:${fg};" title="${escapeHtml(tip)}">
    ${prefix}${escapeHtml(dateStr)} <small>(${escapeHtml(tip)})</small>
  </span>`;
}

// 收集筛选与排序条件
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

// 加载台账列表
async function loadContracts() {
  const params = getFilterParams();
  const res = await fetch(`/api/contracts?${params.toString()}`);
  const result = await res.json();
  if (!result.success) return alert(result.message);

  currentContracts = result.data;
  const tbody = document.getElementById('contract_tbody');
  if (currentContracts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="20" style="text-align:center;color:#6b7280;padding:28px;">暂无匹配的合同台账记录</td></tr>`;
    return;
  }

  tbody.innerHTML = currentContracts.map(c => {
    let parties = [];
    try { parties = JSON.parse(c.counterparties_json || '[]'); } catch (e) {}
    const partiesHtml = parties.length > 0
      ? parties.map(p => `<span class="party-tag" title="信用代码: ${escapeHtml(p.credit_code)} | 联系人: ${escapeHtml(p.contact_person || '-')} ${escapeHtml(p.contact_phone || '')}">${escapeHtml(p.company_name)}</span>`).join('')
      : escapeHtml(c.counterparty);

    // 履约保证金列展示
    let perfBondHtml = '<span style="color:#9ca3af;">-</span>';
    if (c.perf_bond_amount !== null || c.perf_bond_return_date) {
      const amtStr = c.perf_bond_amount !== null ? `¥${fmtMoney(c.perf_bond_amount)} ` : '';
      const badge = c.perf_bond_return_date ? renderDueAlertBadge(c.perf_bond_return_date, c.status, '应退') : '';
      perfBondHtml = `<div>${amtStr}${badge}</div>`;
    }

    // 质保金列展示
    let warrantyHtml = '<span style="color:#9ca3af;">-</span>';
    if (c.warranty_bond_amount !== null || c.warranty_bond_expiry_date) {
      const amtStr = c.warranty_bond_amount !== null ? `¥${fmtMoney(c.warranty_bond_amount)} ` : '';
      const badge = c.warranty_bond_expiry_date ? renderDueAlertBadge(c.warranty_bond_expiry_date, c.status, '到期') : '';
      warrantyHtml = `<div>${amtStr}${badge}</div>`;
    }

    return `
      <tr>
        <td><strong>${escapeHtml(c.contract_no)}</strong></td>
        <td>${escapeHtml(c.contract_name)}</td>
        <td class="summary-cell" title="${escapeHtml(c.contract_summary || '')}">${escapeHtml(c.contract_summary || '-')}</td>
        <td>${escapeHtml(c.contract_type)}</td>
        <td>${escapeHtml(c.our_entity)}</td>
        <td>${partiesHtml}</td>
        <td>${escapeHtml(c.sign_date)}</td>
        <td>${escapeHtml(c.start_date || c.sign_date)}</td>
        <td>${renderDueAlertBadge(c.expiry_date, c.status)}</td>
        <td class="text-right"><strong>${fmtMoney(c.amount)}</strong></td>
        <td class="text-right">${fmtMoney(c.amount_excl_tax)}</td>
        <td>${escapeHtml(c.tax_rate || '-')}</td>
        <td>${escapeHtml(c.invoice_type || '-')}</td>
        <td>${escapeHtml(c.currency)}</td>
        <td>${perfBondHtml}</td>
        <td>${warrantyHtml}</td>
        <td><span class="badge badge-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
        <td>
          ${c.attachment_path
            ? `<a class="link-btn" onclick="openDetailModal(${c.id})" title="点击在线预览扫描件">📎 ${escapeHtml(c.attachment_original_name)}</a>`
            : `<span style="color:#9ca3af;">无扫描件</span>`}
        </td>
        <td class="summary-cell" title="${escapeHtml(c.remark || '')}">${escapeHtml(c.remark || '-')}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="openDetailModal(${c.id})">详情 / 扫描件</button>
          <button class="btn btn-outline btn-sm" onclick="openFormModal(${c.id})">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="deleteContract(${c.id})">删除</button>
        </td>
      </tr>
    `;
  }).join('');
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

// 导出 Excel
function exportExcel(scope) {
  const params = getFilterParams();
  params.set('scope', scope);
  window.location.href = `/api/contracts/export?${params.toString()}`;
}

// 签订日期变更时，若开始履约日为空或未手动改过，默认自动同步为签订日
function syncStartDateDefault() {
  const signDate = document.getElementById('f_sign_date').value;
  const startDateInput = document.getElementById('f_start_date');
  if (!startDateInput.value || startDateInput.dataset.autoSync === 'true') {
    startDateInput.value = signDate;
    startDateInput.dataset.autoSync = 'true';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const startDateInput = document.getElementById('f_start_date');
  if (startDateInput) {
    startDateInput.addEventListener('input', () => {
      startDateInput.dataset.autoSync = 'false';
    });
  }
  loadContracts();
});

// ==================== 多方对方单位动态卡片管理 ====================

function addCounterpartyCard(data = {}) {
  const container = document.getElementById('counterparties_container');
  const index = container.children.length + 1;
  const card = document.createElement('div');
  card.className = 'party-card';
  card.innerHTML = `
    <div class="party-card-header">
      <span class="party-title">对方签约单位 #${index}</span>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeCounterpartyCard(this)">移除此方</button>
    </div>
    <div class="form-grid-4">
      <div class="form-group">
        <label>单位名称 *</label>
        <input type="text" class="p_company_name" value="${escapeHtml(data.company_name || '')}" placeholder="对方公司全称" required />
      </div>
      <div class="form-group">
        <label>统一社会信用代码 *</label>
        <input type="text" class="p_credit_code" value="${escapeHtml(data.credit_code || '')}" placeholder="18位统一信用代码" required />
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
    </div>
  `;
  container.appendChild(card);
  renumberCounterpartyCards();
}

function removeCounterpartyCard(btn) {
  const container = document.getElementById('counterparties_container');
  if (container.children.length <= 1) {
    return alert('合同至少需要保留一个对方单位！');
  }
  btn.closest('.party-card').remove();
  renumberCounterpartyCards();
}

function renumberCounterpartyCards() {
  const cards = document.querySelectorAll('#counterparties_container .party-card');
  cards.forEach((card, idx) => {
    card.querySelector('.party-title').innerText = `对方签约单位 #${idx + 1}`;
  });
}

function collectCounterpartiesFromDOM() {
  const cards = document.querySelectorAll('#counterparties_container .party-card');
  return Array.from(cards).map(card => ({
    company_name: card.querySelector('.p_company_name').value.trim(),
    credit_code: card.querySelector('.p_credit_code').value.trim(),
    contact_person: card.querySelector('.p_contact_person').value.trim(),
    contact_phone: card.querySelector('.p_contact_phone').value.trim(),
    bank_account_name: card.querySelector('.p_bank_account_name').value.trim(),
    bank_account_no: card.querySelector('.p_bank_account_no').value.trim(),
    bank_name: card.querySelector('.p_bank_name').value.trim(),
    bank_code: card.querySelector('.p_bank_code').value.trim()
  }));
}

// 打开新增 / 编辑弹窗
function openFormModal(id = null) {
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
      document.getElementById('f_contract_summary').value = c.contract_summary || '';
      document.getElementById('f_contract_type').value = c.contract_type;
      document.getElementById('f_status').value = c.status;
      document.getElementById('f_our_entity').value = c.our_entity;
      document.getElementById('f_sign_date').value = c.sign_date;
      document.getElementById('f_start_date').value = c.start_date || c.sign_date;
      document.getElementById('f_expiry_date').value = c.expiry_date;
      document.getElementById('f_amount').value = c.amount;
      document.getElementById('f_amount_excl_tax').value = c.amount_excl_tax !== null ? c.amount_excl_tax : '';
      document.getElementById('f_tax_rate').value = c.tax_rate || '';
      document.getElementById('f_invoice_type').value = c.invoice_type || '';
      document.getElementById('f_currency').value = c.currency || 'CNY';
      document.getElementById('f_perf_bond_amount').value = c.perf_bond_amount !== null ? c.perf_bond_amount : '';
      document.getElementById('f_perf_bond_pay_date').value = c.perf_bond_pay_date || '';
      document.getElementById('f_perf_bond_return_date').value = c.perf_bond_return_date || '';
      document.getElementById('f_warranty_bond_amount').value = c.warranty_bond_amount !== null ? c.warranty_bond_amount : '';
      document.getElementById('f_warranty_bond_expiry_date').value = c.warranty_bond_expiry_date || '';
      document.getElementById('f_remark').value = c.remark || '';

      let parties = [];
      try { parties = JSON.parse(c.counterparties_json || '[]'); } catch (e) {}
      if (parties.length > 0) {
        parties.forEach(p => addCounterpartyCard(p));
      } else {
        addCounterpartyCard({ company_name: c.counterparty, credit_code: '未录入' });
      }
    }
  } else {
    // 默认新建 1 个对方单位卡片
    addCounterpartyCard();
  }

  document.getElementById('form_modal').classList.remove('hidden');
}

function closeFormModal() {
  document.getElementById('form_modal').classList.add('hidden');
}

// 提交新增或编辑表单
async function submitContractForm(e) {
  e.preventDefault();
  const taxRateVal = document.getElementById('f_tax_rate').value.trim().replace(/，/g, ',');
  if (taxRateVal.includes(',') && !taxRateVal.startsWith('*')) {
    return alert('【税率格式提示】填写多个税率时，必须在最前面加 * 号并用逗号隔开，例如：*6%,13%');
  }

  const parties = collectCounterpartiesFromDOM();
  const id = document.getElementById('form_id').value;
  const formData = new FormData(document.getElementById('contract_form'));
  formData.set('tax_rate', taxRateVal);
  formData.set('counterparties_json', JSON.stringify(parties));

  const url = id ? `/api/contracts/${id}` : '/api/contracts';
  const method = id ? 'PUT' : 'POST';

  const res = await fetch(url, { method, body: formData });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  closeFormModal();
  loadContracts();
}

// 删除合同
async function deleteContract(id) {
  if (!confirm('确认删除该条合同台账及其关联的扫描件吗？此操作不可恢复。')) return;
  const res = await fetch(`/api/contracts/${id}`, { method: 'DELETE' });
  const result = await res.json();
  if (!result.success) return alert(result.message);
  loadContracts();
}

// 打开详情与扫描件预览弹窗
async function openDetailModal(id) {
  const res = await fetch(`/api/contracts/${id}`);
  const result = await res.json();
  if (!result.success) return alert(result.message);

  const c = result.data;
  let parties = [];
  try { parties = JSON.parse(c.counterparties_json || '[]'); } catch (e) {}

  const partiesDetailHtml = parties.map((p, idx) => `
    <div style="border-top:1px dashed #e5e7eb;padding-top:6px;margin-top:6px;">
      <div class="detail-row"><span class="label">对方单位 #${idx + 1}</span><span class="val">${escapeHtml(p.company_name)}</span></div>
      <div class="detail-row"><span class="label">统一信用代码</span><span class="val">${escapeHtml(p.credit_code)}</span></div>
      <div class="detail-row"><span class="label">联系人 / 电话</span><span class="val">${escapeHtml(p.contact_person || '-')} / ${escapeHtml(p.contact_phone || '-')}</span></div>
      <div class="detail-row"><span class="label">收款账户 / 账号</span><span class="val">${escapeHtml(p.bank_account_name || '-')} / ${escapeHtml(p.bank_account_no || '-')}</span></div>
      <div class="detail-row"><span class="label">开户行 / 行号</span><span class="val">${escapeHtml(p.bank_name || '-')} (${escapeHtml(p.bank_code || '-')})</span></div>
    </div>
  `).join('');

  document.getElementById('detail_fields').innerHTML = `
    <div class="detail-card">
      <h4>📌 基础信息与履约周期</h4>
      <div class="detail-row"><span class="label">合同编号</span><span class="val">${escapeHtml(c.contract_no)}</span></div>
      <div class="detail-row"><span class="label">合同名称</span><span class="val">${escapeHtml(c.contract_name)}</span></div>
      <div class="detail-row"><span class="label">合同摘要</span><span class="val">${escapeHtml(c.contract_summary || '-')}</span></div>
      <div class="detail-row"><span class="label">类型 / 状态</span><span class="val">${escapeHtml(c.contract_type)} · <span class="badge badge-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></span></div>
      <div class="detail-row"><span class="label">签订日期</span><span class="val">${escapeHtml(c.sign_date)}</span></div>
      <div class="detail-row"><span class="label">开始履约日期</span><span class="val">${escapeHtml(c.start_date || c.sign_date)}</span></div>
      <div class="detail-row"><span class="label">合同到期日</span><span class="val">${renderDueAlertBadge(c.expiry_date, c.status)}</span></div>
    </div>

    <div class="detail-card">
      <h4>🏢 签约多方主体明细</h4>
      <div class="detail-row"><span class="label">我方签约主体</span><span class="val">${escapeHtml(c.our_entity)}</span></div>
      ${partiesDetailHtml}
    </div>

    <div class="detail-card">
      <h4>💰 财税与保证金/质保金</h4>
      <div class="detail-row"><span class="label">含税总价</span><span class="val">${fmtMoney(c.amount)} ${escapeHtml(c.currency)}</span></div>
      <div class="detail-row"><span class="label">不含税价</span><span class="val">${fmtMoney(c.amount_excl_tax)}</span></div>
      <div class="detail-row"><span class="label">税率 / 发票类型</span><span class="val">${escapeHtml(c.tax_rate || '-')} / ${escapeHtml(c.invoice_type || '-')}</span></div>
      <div class="detail-row"><span class="label">履约保证金</span><span class="val">${fmtMoney(c.perf_bond_amount)} (缴纳:${escapeHtml(c.perf_bond_pay_date || '-')})</span></div>
      <div class="detail-row"><span class="label">保证金应退时间</span><span class="val">${renderDueAlertBadge(c.perf_bond_return_date, c.status)}</span></div>
      <div class="detail-row"><span class="label">质保金金额</span><span class="val">${fmtMoney(c.warranty_bond_amount)}</span></div>
      <div class="detail-row"><span class="label">质保金到期时间</span><span class="val">${renderDueAlertBadge(c.warranty_bond_expiry_date, c.status)}</span></div>
      <div class="detail-row"><span class="label">备注</span><span class="val">${escapeHtml(c.remark || '-')}</span></div>
    </div>
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
  // 主动卸载 iframe 内的 PDF 渲染器句柄，释放内存
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
