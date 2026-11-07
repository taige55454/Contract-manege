/**
 * 合同与采购立项全生命周期管理系统 - 前端核心逻辑 (Ultimate Edition)
 * 特性：
 * 1. 合同台账 + 采购立项台账双模块无缝切换与跨表联动自动回填
 * 2. 分段式可视化编号构建器（支持自由穿插自定义段、实时合成预览、零空洞顺延提示）
 * 3. 多机局域网协同：窗口激活与后台定时静默同步（带弹窗/提交防重入锁，绝不打断输入）
 * 4. 预览弹窗关闭时立即销毁 iframe/img 节点，确保浏览器长期使用 0 内存泄漏
 */

let currentModule = 'contracts'; // 'contracts' | 'procurement'
let allContracts = [];
let allProcurements = [];

let contractNoRule = { prefix: 'HT-', date_format: 'YYYYMM', seq_digits: 3, suffix: '' };
let procNoRule = { prefix: 'LX', date_format: 'YYYYMMDD', seq_digits: 3, suffix: '' };

let contractPreviewParts = { prefix: 'HT-', mid_custom: '', date_part: '', seq_part: '001', suffix: '', full_no: '' };
let procPreviewParts = { prefix: 'LX', mid_custom: '', date_part: '', seq_part: '001', suffix: '', full_no: '' };

let currentDetailContract = null;
let currentDetailProcurement = null;

// 防重入状态锁
let isSubmittingForm = false;
let isUploadingDetail = false;
let isSilentSyncing = false;

const TOKEN_STORAGE_KEY = 'contract_sys_lan_token';

// ==================== 1. 统一请求封装与防 XSS 工具 ====================
function getAccessToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
}

function setAccessToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function withTokenUrl(url) {
  const token = getAccessToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

async function apiFetch(url, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  const token = getAccessToken();
  if (token) {
    headers['x-access-token'] = token;
  }
  const resp = await fetch(url, { ...options, headers });
  if (resp.status === 401) {
    showLanAuthOverlay();
    throw new Error('需要验证局域网访问口令');
  }
  return resp;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(num) {
  const n = Number(num || 0);
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFileSize(bytes) {
  const b = Number(bytes || 0);
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toast_container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast-item toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 4500 : 3200);
}

// ==================== 2. 顶部模块切换与年份筛选初始化 ====================
function initYearSelects() {
  const curYear = new Date().getFullYear();
  const cYearSel = document.getElementById('filter_year');
  const pYearSel = document.getElementById('proc_filter_year');
  for (let y = curYear + 1; y >= curYear - 8; y--) {
    if (cYearSel) cYearSel.insertAdjacentHTML('beforeend', `<option value="${y}">${y}年</option>`);
    if (pYearSel) pYearSel.insertAdjacentHTML('beforeend', `<option value="${y}">${y}年</option>`);
  }
}

async function switchModule(mod) {
  currentModule = mod === 'procurement' ? 'procurement' : 'contracts';
  document.getElementById('tab_btn_contracts')?.classList.toggle('active', currentModule === 'contracts');
  document.getElementById('tab_btn_procurement')?.classList.toggle('active', currentModule === 'procurement');

  document.getElementById('module_contracts_view')?.classList.toggle('hidden', currentModule !== 'contracts');
  document.getElementById('module_procurement_view')?.classList.toggle('hidden', currentModule !== 'procurement');

  if (currentModule === 'procurement') {
    await loadProcNoRule();
    await loadProcurements();
  } else {
    await loadContractNoRule();
    await loadContracts();
  }
}

// ==================== 3. 编号规则设置与“分段式编号构建器” ====================
async function loadContractNoRule() {
  try {
    const resp = await apiFetch('/api/settings/contract-no-rule');
    const json = await resp.json();
    if (json.success) {
      contractNoRule = json.rule;
      contractPreviewParts = json.preview_parts || contractPreviewParts;
      const badge = document.getElementById('next_no_preview_badge');
      if (badge) badge.textContent = json.next_contract_no || '未设固定规则';
    }
  } catch (e) {}
}

async function loadProcNoRule() {
  try {
    const resp = await apiFetch('/api/settings/procurement-no-rule');
    const json = await resp.json();
    if (json.success) {
      procNoRule = json.rule;
      procPreviewParts = json.preview_parts || procPreviewParts;
      const badge = document.getElementById('next_proc_no_preview_badge');
      if (badge) badge.textContent = json.next_procurement_no || '未设固定规则';
    }
  } catch (e) {}
}

function openNoRuleModal() {
  document.getElementById('rule_prefix').value = contractNoRule.prefix || '';
  document.getElementById('rule_date_format').value = contractNoRule.date_format || 'YYYYMM';
  document.getElementById('rule_seq_digits').value = String(contractNoRule.seq_digits ?? 3);
  document.getElementById('rule_suffix').value = contractNoRule.suffix || '';
  updateRuleModalLivePreview();
  document.getElementById('no_rule_modal').classList.remove('hidden');
}

function closeNoRuleModal() {
  document.getElementById('no_rule_modal').classList.add('hidden');
}

function applyRulePreset(prefix, dateFmt, digits, suffix) {
  document.getElementById('rule_prefix').value = prefix;
  document.getElementById('rule_date_format').value = dateFmt;
  document.getElementById('rule_seq_digits').value = String(digits);
  document.getElementById('rule_suffix').value = suffix;
  updateRuleModalLivePreview();
}

function updateRuleModalLivePreview() {
  const prefix = document.getElementById('rule_prefix').value.trim();
  const dateFmt = document.getElementById('rule_date_format').value;
  const digits = parseInt(document.getElementById('rule_seq_digits').value, 10) || 0;
  const suffix = document.getElementById('rule_suffix').value.trim();

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  let dateStr = '';
  if (dateFmt === 'YYYY') dateStr = `${yyyy}`;
  else if (dateFmt === 'YYYYMM') dateStr = `${yyyy}${mm}`;
  else if (dateFmt === 'YYYYMMDD') dateStr = `${yyyy}${mm}${dd}`;

  const seqStr = digits > 0 ? String(1).padStart(digits, '0') : '';
  document.getElementById('rule_live_preview').textContent = `${prefix}${dateStr}${seqStr}${suffix}` || '（纯手动输入）';
}

async function saveNoRuleForm(e) {
  e.preventDefault();
  try {
    const payload = {
      prefix: document.getElementById('rule_prefix').value.trim(),
      date_format: document.getElementById('rule_date_format').value,
      seq_digits: Number(document.getElementById('rule_seq_digits').value),
      suffix: document.getElementById('rule_suffix').value.trim()
    };
    const resp = await apiFetch('/api/settings/contract-no-rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast('合同编号规则已保存生效');
    closeNoRuleModal();
    await loadContractNoRule();
  } catch (err) {
    showToast(err.message || '保存规则失败', 'error');
  }
}

// 采购立项编号规则弹窗
function openProcNoRuleModal() {
  document.getElementById('proc_rule_prefix').value = procNoRule.prefix || '';
  document.getElementById('proc_rule_date_format').value = procNoRule.date_format || 'YYYYMMDD';
  document.getElementById('proc_rule_seq_digits').value = String(procNoRule.seq_digits ?? 3);
  document.getElementById('proc_rule_suffix').value = procNoRule.suffix || '';
  updateProcRuleModalLivePreview();
  document.getElementById('proc_no_rule_modal').classList.remove('hidden');
}

function closeProcNoRuleModal() {
  document.getElementById('proc_no_rule_modal').classList.add('hidden');
}

function applyProcRulePreset(prefix, dateFmt, digits, suffix) {
  document.getElementById('proc_rule_prefix').value = prefix;
  document.getElementById('proc_rule_date_format').value = dateFmt;
  document.getElementById('proc_rule_seq_digits').value = String(digits);
  document.getElementById('proc_rule_suffix').value = suffix;
  updateProcRuleModalLivePreview();
}

function updateProcRuleModalLivePreview() {
  const prefix = document.getElementById('proc_rule_prefix').value.trim();
  const dateFmt = document.getElementById('proc_rule_date_format').value;
  const digits = parseInt(document.getElementById('proc_rule_seq_digits').value, 10) || 0;
  const suffix = document.getElementById('proc_rule_suffix').value.trim();

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  let dateStr = '';
  if (dateFmt === 'YYYY') dateStr = `${yyyy}`;
  else if (dateFmt === 'YYYYMM') dateStr = `${yyyy}${mm}`;
  else if (dateFmt === 'YYYYMMDD') dateStr = `${yyyy}${mm}${dd}`;

  const seqStr = digits > 0 ? String(1).padStart(digits, '0') : '';
  document.getElementById('proc_rule_live_preview').textContent = `${prefix}${dateStr}${seqStr}${suffix}` || '（纯手动输入）';
}

async function saveProcNoRuleForm(e) {
  e.preventDefault();
  try {
    const payload = {
      prefix: document.getElementById('proc_rule_prefix').value.trim(),
      date_format: document.getElementById('proc_rule_date_format').value,
      seq_digits: Number(document.getElementById('proc_rule_seq_digits').value),
      suffix: document.getElementById('proc_rule_suffix').value.trim()
    };
    const resp = await apiFetch('/api/settings/procurement-no-rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast('采购立项编号规则已保存');
    closeProcNoRuleModal();
    await loadProcNoRule();
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  }
}

// 分段式编号实时拼接器（合同 & 立项通用）
function syncContractNoFromSegments() {
  const pfx = document.getElementById('seg_c_prefix')?.value.trim() || '';
  const mid = document.getElementById('seg_c_mid')?.value.trim() || '';
  const dt = document.getElementById('seg_c_date')?.value.trim() || '';
  const seq = document.getElementById('seg_c_seq')?.value.trim() || '';
  const sfx = document.getElementById('seg_c_suffix')?.value.trim() || '';
  const targetInput = document.getElementById('f_contract_no');
  if (targetInput) {
    targetInput.value = `${pfx}${mid}${dt}${seq}${sfx}`;
  }
}

async function refreshContractNoSegmentsByDateAndMid() {
  const signDate = document.getElementById('f_sign_date')?.value || new Date().toISOString().slice(0, 10);
  const midCustom = document.getElementById('seg_c_mid')?.value.trim() || '';
  try {
    const resp = await apiFetch(`/api/settings/contract-no-rule?sign_date=${encodeURIComponent(signDate)}&mid_custom=${encodeURIComponent(midCustom)}`);
    const json = await resp.json();
    if (json.success && json.preview_parts) {
      const p = json.preview_parts;
      document.getElementById('seg_c_prefix').value = p.prefix || '';
      document.getElementById('seg_c_date').value = p.date_part || '';
      document.getElementById('seg_c_seq').value = p.seq_part || '';
      document.getElementById('seg_c_suffix').value = p.suffix || '';
      syncContractNoFromSegments();
    }
  } catch (e) {}
}

function syncProcNoFromSegments() {
  const pfx = document.getElementById('seg_p_prefix')?.value.trim() || '';
  const mid = document.getElementById('seg_p_mid')?.value.trim() || '';
  const dt = document.getElementById('seg_p_date')?.value.trim() || '';
  const seq = document.getElementById('seg_p_seq')?.value.trim() || '';
  const sfx = document.getElementById('seg_p_suffix')?.value.trim() || '';
  const targetInput = document.getElementById('p_procurement_no');
  if (targetInput) {
    targetInput.value = `${pfx}${mid}${dt}${seq}${sfx}`;
  }
}

async function refreshProcNoSegmentsByDateAndMid() {
  const approvalDate = document.getElementById('p_approval_date')?.value || new Date().toISOString().slice(0, 10);
  const midCustom = document.getElementById('seg_p_mid')?.value.trim() || '';
  try {
    const resp = await apiFetch(`/api/settings/procurement-no-rule?approval_date=${encodeURIComponent(approvalDate)}&mid_custom=${encodeURIComponent(midCustom)}`);
    const json = await resp.json();
    if (json.success && json.preview_parts) {
      const p = json.preview_parts;
      document.getElementById('seg_p_prefix').value = p.prefix || '';
      document.getElementById('seg_p_date').value = p.date_part || '';
      document.getElementById('seg_p_seq').value = p.seq_part || '';
      document.getElementById('seg_p_suffix').value = p.suffix || '';
      syncProcNoFromSegments();
    }
  } catch (e) {}
}

// ==================== 4. 合同台账列表加载、筛选、新增与编辑 ====================
function getContractFilterParams() {
  const params = new URLSearchParams();
  const kw = document.getElementById('filter_keyword')?.value.trim();
  const type = document.getElementById('filter_type')?.value;
  const status = document.getElementById('filter_status')?.value;
  const year = document.getElementById('filter_year')?.value;
  const startDate = document.getElementById('filter_start_date')?.value;
  const endDate = document.getElementById('filter_end_date')?.value;
  const hasFile = document.getElementById('filter_has_file')?.value;

  if (kw) params.set('keyword', kw);
  if (type) params.set('contract_type', type);
  if (status) params.set('status', status);
  if (year) params.set('year', year);
  if (startDate) params.set('start_date', startDate);
  if (endDate) params.set('end_date', endDate);
  if (hasFile) params.set('has_file', hasFile);
  return params;
}

async function loadContracts() {
  try {
    const params = getContractFilterParams();
    const resp = await apiFetch(`/api/contracts?${params.toString()}`);
    const json = await resp.json();
    if (!json.success) return;

    allContracts = json.data || [];
    renderContractStats(json.stats);
    renderContractTable(allContracts);
  } catch (err) {
    if (err.message !== '需要验证局域网访问口令') {
      showToast('加载合同列表失败', 'error');
    }
  }
}

function renderContractStats(stats) {
  if (!stats) return;
  document.getElementById('stat_total_count').textContent = stats.total_count || 0;
  document.getElementById('stat_total_amount').textContent = formatMoney(stats.total_amount || 0);
  document.getElementById('stat_active_count').textContent = stats.active_count || 0;
  document.getElementById('stat_with_file_count').textContent = stats.with_file_count || 0;
}

function getStatusBadgeClass(status) {
  if (status === '履行中' || status === '采购进行中') return 'badge-blue';
  if (status === '已完结' || status === '已签合同' || status === '已完成采购待签合同') return 'badge-green';
  if (status === '已解除' || status === '归档终止' || status === '已取消/终止') return 'badge-red';
  return 'badge-amber';
}

function renderContractTable(rows) {
  const tbody = document.getElementById('contract_tbody');
  if (!tbody) return;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row">暂无匹配的合同台账记录，点击右上角【+ 新增合同】开始录入</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const hasMain = Boolean(r.file_path);
    const relCount = Number(r.related_file_count || 0);
    let fileTagHtml = `<span class="file-tag none">未上传</span>`;
    if (hasMain && relCount > 0) {
      fileTagHtml = `<span class="file-tag ok" onclick="openContractDetail(${r.id})">📄 主件 + 📎${relCount}份</span>`;
    } else if (hasMain) {
      fileTagHtml = `<span class="file-tag ok" onclick="openContractDetail(${r.id})">📄 已传扫描件</span>`;
    } else if (relCount > 0) {
      fileTagHtml = `<span class="file-tag ok" onclick="openContractDetail(${r.id})">📎 资料×${relCount}</span>`;
    }

    const procBadge = r.linked_procurement_no
      ? `<span class="link-chip" title="${escapeHtml(r.linked_procurement_name || '')}" onclick="jumpToProcurementDetail(${r.procurement_id})">🔗 ${escapeHtml(r.linked_procurement_no)}</span>`
      : `<span class="text-muted">-</span>`;

    const partiesHtml = `
      <div class="party-line"><strong>甲：</strong>${escapeHtml(r.party_a)}</div>
      <div class="party-line"><strong>乙：</strong>${escapeHtml(r.party_b)}</div>
      ${r.party_c ? `<div class="party-line"><strong>丙：</strong>${escapeHtml(r.party_c)}</div>` : ''}
    `;

    return `
      <tr>
        <td class="mono-cell">${escapeHtml(r.seq_no)}</td>
        <td class="mono-cell font-semibold">${escapeHtml(r.contract_no)}</td>
        <td>
          <div class="title-link" onclick="openContractDetail(${r.id})">${escapeHtml(r.contract_name)}</div>
          ${r.department || r.owner ? `<div class="sub-meta">${escapeHtml(r.department || '')} ${escapeHtml(r.owner || '')}</div>` : ''}
        </td>
        <td><span class="type-pill">${escapeHtml(r.contract_type)}</span></td>
        <td class="parties-cell">${partiesHtml}</td>
        <td class="money-cell">${formatMoney(r.amount)}</td>
        <td class="center-cell">${escapeHtml(r.sign_date)}</td>
        <td class="center-cell"><span class="status-badge ${getStatusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        <td class="center-cell">${procBadge}</td>
        <td class="center-cell">${fileTagHtml}</td>
        <td class="remark-cell" title="${escapeHtml(r.remark || '')}">${escapeHtml(r.remark || '-')}</td>
        <td class="action-cell">
          <button class="btn-link" onclick="openContractDetail(${r.id})">预览/附件</button>
          <button class="btn-link" onclick="openEditContractModal(${r.id})">编辑</button>
          <button class="btn-link danger" onclick="deleteContract(${r.id}, '${escapeHtml(r.contract_no)}')">删除</button>
        </td>
      </tr>
    `;
  }).join('');
}

function resetContractFilters() {
  document.getElementById('filter_keyword').value = '';
  document.getElementById('filter_type').value = '';
  document.getElementById('filter_status').value = '';
  document.getElementById('filter_year').value = '';
  document.getElementById('filter_start_date').value = '';
  document.getElementById('filter_end_date').value = '';
  document.getElementById('filter_has_file').value = '';
  loadContracts();
}

async function loadProcurementOptionsForContractForm(selectedProcId = null) {
  const sel = document.getElementById('f_procurement_id');
  if (!sel) return;
  try {
    const resp = await apiFetch('/api/options/procurements');
    const json = await resp.json();
    const list = json.data || [];
    sel.innerHTML = `<option value="">-- 不关联 / 暂未关联采购立项 --</option>` + list.map(p => {
      const boundTip = p.linked_contract_no && Number(p.id) !== Number(selectedProcId)
        ? ` [已绑:${p.linked_contract_no}]`
        : '';
      return `<option value="${p.id}"
        data-name="${escapeHtml(p.project_name)}"
        data-dept="${escapeHtml(p.department || '')}"
        data-applicant="${escapeHtml(p.applicant || '')}"
        data-supplier="${escapeHtml(p.supplier_name || '')}"
        data-amount="${p.final_amount || p.budget_amount || 0}">
        ${escapeHtml(p.procurement_no)} - ${escapeHtml(p.project_name)}${escapeHtml(boundTip)}
      </option>`;
    }).join('');
    if (selectedProcId) sel.value = String(selectedProcId);
  } catch (e) {}
}

function onSelectLinkedProcurementChange() {
  const sel = document.getElementById('f_procurement_id');
  if (!sel || !sel.value) return;
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return;

  const nameInput = document.getElementById('f_contract_name');
  const partyBInput = document.getElementById('f_party_b');
  const amountInput = document.getElementById('f_amount');
  const deptInput = document.getElementById('f_department');
  const ownerInput = document.getElementById('f_owner');

  if (nameInput && !nameInput.value.trim() && opt.dataset.name) nameInput.value = opt.dataset.name;
  if (partyBInput && !partyBInput.value.trim() && opt.dataset.supplier) partyBInput.value = opt.dataset.supplier;
  if (amountInput && (!amountInput.value || Number(amountInput.value) === 0) && Number(opt.dataset.amount) > 0) {
    amountInput.value = opt.dataset.amount;
  }
  if (deptInput && !deptInput.value.trim() && opt.dataset.dept) deptInput.value = opt.dataset.dept;
  if (ownerInput && !ownerInput.value.trim() && opt.dataset.applicant) ownerInput.value = opt.dataset.applicant;
}

async function openCreateContractModal() {
  document.getElementById('contract_form').reset();
  document.getElementById('f_id').value = '';
  document.getElementById('contract_modal_title').textContent = '新增合同台账';
  document.getElementById('existing_file_box').classList.add('hidden');
  document.getElementById('f_remove_file').value = '0';

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('f_sign_date').value = today;
  document.getElementById('seg_c_mid').value = '';

  await loadProcurementOptionsForContractForm(null);
  await refreshContractNoSegmentsByDateAndMid();
  document.getElementById('contract_modal').classList.remove('hidden');
}

async function openEditContractModal(id) {
  try {
    const resp = await apiFetch(`/api/contracts/${id}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    const c = json.data;

    document.getElementById('contract_form').reset();
    document.getElementById('f_id').value = c.id;
    document.getElementById('contract_modal_title').textContent = `编辑合同：${c.contract_no}`;

    await loadProcurementOptionsForContractForm(c.procurement_id);

    document.getElementById('f_contract_no').value = c.contract_no;
    document.getElementById('seg_c_prefix').value = contractNoRule.prefix || '';
    document.getElementById('seg_c_mid').value = '';
    document.getElementById('seg_c_date').value = '';
    document.getElementById('seg_c_seq').value = '';
    document.getElementById('seg_c_suffix').value = contractNoRule.suffix || '';

    document.getElementById('f_contract_name').value = c.contract_name;
    document.getElementById('f_contract_type').value = c.contract_type;
    document.getElementById('f_party_a').value = c.party_a;
    document.getElementById('f_party_b').value = c.party_b;
    document.getElementById('f_party_c').value = c.party_c || '';
    document.getElementById('f_amount').value = c.amount;
    document.getElementById('f_sign_date').value = c.sign_date;
    document.getElementById('f_start_date').value = c.start_date || '';
    document.getElementById('f_end_date').value = c.end_date || '';
    document.getElementById('f_status').value = c.status;
    document.getElementById('f_department').value = c.department || '';
    document.getElementById('f_owner').value = c.owner || '';
    document.getElementById('f_remark').value = c.remark || '';
    document.getElementById('f_remove_file').value = '0';

    const fileBox = document.getElementById('existing_file_box');
    if (c.file_path) {
      fileBox.classList.remove('hidden');
      document.getElementById('existing_file_name').textContent = `${c.file_original_name || c.file_path} (${formatFileSize(c.file_size)})`;
    } else {
      fileBox.classList.add('hidden');
    }

    document.getElementById('contract_modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message || '读取合同信息失败', 'error');
  }
}

function markRemoveExistingScan() {
  document.getElementById('f_remove_file').value = '1';
  document.getElementById('existing_file_box').classList.add('hidden');
  showToast('已标记移除原主扫描件，点击保存后生效');
}

function closeContractModal() {
  document.getElementById('contract_modal').classList.add('hidden');
}

async function submitContractForm(e) {
  e.preventDefault();
  if (isSubmittingForm) return;
  isSubmittingForm = true;
  const submitBtn = document.getElementById('contract_submit_btn');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const id = document.getElementById('f_id').value;
    const fd = new FormData();
    fd.append('contract_no', document.getElementById('f_contract_no').value.trim());
    fd.append('contract_name', document.getElementById('f_contract_name').value.trim());
    fd.append('contract_type', document.getElementById('f_contract_type').value);
    fd.append('party_a', document.getElementById('f_party_a').value.trim());
    fd.append('party_b', document.getElementById('f_party_b').value.trim());
    fd.append('party_c', document.getElementById('f_party_c').value.trim());
    fd.append('amount', document.getElementById('f_amount').value || '0');
    fd.append('sign_date', document.getElementById('f_sign_date').value);
    fd.append('start_date', document.getElementById('f_start_date').value);
    fd.append('end_date', document.getElementById('f_end_date').value);
    fd.append('status', document.getElementById('f_status').value);
    fd.append('department', document.getElementById('f_department').value.trim());
    fd.append('owner', document.getElementById('f_owner').value.trim());
    fd.append('remark', document.getElementById('f_remark').value.trim());
    fd.append('procurement_id', document.getElementById('f_procurement_id').value || '');
    fd.append('remove_file', document.getElementById('f_remove_file').value);

    const scanInput = document.getElementById('f_scan_file');
    if (scanInput && scanInput.files[0]) {
      fd.append('scan_file', scanInput.files[0]);
    }
    const relInput = document.getElementById('f_related_files');
    if (relInput && relInput.files.length > 0) {
      for (const f of relInput.files) {
        fd.append('related_files', f);
      }
    }

    const url = id ? `/api/contracts/${id}` : '/api/contracts';
    const method = id ? 'PUT' : 'POST';
    const resp = await apiFetch(url, { method, body: fd });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);

    showToast(json.message || '保存成功');
    closeContractModal();
    await loadContractNoRule();
    await loadContracts();
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  } finally {
    isSubmittingForm = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteContract(id, contractNo) {
  if (!confirm(`确定要彻底删除合同【${contractNo}】吗？\n删除后，关联的主扫描件及所有附件将同步从磁盘物理清除，且后续序号将自动重排对齐！`)) {
    return;
  }
  try {
    const resp = await apiFetch(`/api/contracts/${id}`, { method: 'DELETE' });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast(json.message);
    await loadContractNoRule();
    await loadContracts();
  } catch (err) {
    showToast(err.message || '删除失败', 'error');
  }
}

// ==================== 5. 合同详情与多模态预览弹窗（关闭即销毁 DOM 防泄漏） ====================
async function openContractDetail(id) {
  try {
    const resp = await apiFetch(`/api/contracts/${id}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    currentDetailContract = json.data;
    renderContractDetailModal(currentDetailContract);
    document.getElementById('detail_modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message || '获取详情失败', 'error');
  }
}

function renderContractDetailModal(c) {
  document.getElementById('d_title').textContent = `${c.contract_no} - ${c.contract_name}`;
  const procInfo = c.linked_procurement_no
    ? `<span class="link-chip" onclick="closeDetailModal(); jumpToProcurementDetail(${c.procurement_id})">🔗 ${escapeHtml(c.linked_procurement_no)} (${escapeHtml(c.linked_procurement_name || '')})</span>`
    : '未关联采购立项';

  document.getElementById('d_meta_grid').innerHTML = `
    <div><strong>年度序号：</strong>${escapeHtml(c.seq_no)}</div>
    <div><strong>合同类型：</strong>${escapeHtml(c.contract_type)}</div>
    <div><strong>合同金额：</strong><span class="money-text">${formatMoney(c.amount)}</span></div>
    <div><strong>履行状态：</strong><span class="status-badge ${getStatusBadgeClass(c.status)}">${escapeHtml(c.status)}</span></div>
    <div><strong>甲方单位：</strong>${escapeHtml(c.party_a)}</div>
    <div><strong>乙方单位：</strong>${escapeHtml(c.party_b)}</div>
    ${c.party_c ? `<div><strong>丙方单位：</strong>${escapeHtml(c.party_c)}</div>` : ''}
    <div><strong>签订日期：</strong>${escapeHtml(c.sign_date)}</div>
    <div><strong>履行期限：</strong>${escapeHtml(c.start_date || '未填')} 至 ${escapeHtml(c.end_date || '未填')}</div>
    <div><strong>部门/负责人：</strong>${escapeHtml(c.department || '-')} / ${escapeHtml(c.owner || '-')}</div>
    <div style="grid-column: span 2;"><strong>关联采购立项：</strong>${procInfo}</div>
    <div style="grid-column: span 2;"><strong>备注说明：</strong>${escapeHtml(c.remark || '无')}</div>
  `;

  renderContractAttachmentList(c);
  if (c.file_path) {
    previewAttachmentInContainer(c.file_path, c.file_original_name || c.file_path, 'preview_container');
  } else if (c.related_files && c.related_files.length > 0) {
    previewAttachmentInContainer(c.related_files[0].file_path, c.related_files[0].file_original_name, 'preview_container');
  } else {
    document.getElementById('preview_container').innerHTML = `<div class="empty-preview">暂未上传主合同扫描件或相关资料，可在上方一键补传</div>`;
  }
}

function renderContractAttachmentList(c) {
  const box = document.getElementById('d_attachments_list');
  const items = [];

  if (c.file_path) {
    const dlUrl = withTokenUrl(`/uploads/${encodeURI(c.file_path)}?download=1&filename=${encodeURIComponent(c.file_path)}`);
    items.push(`
      <div class="att-card main-att">
        <div class="att-info" onclick="previewAttachmentInContainer('${escapeHtml(c.file_path)}', '${escapeHtml(c.file_original_name || c.file_path)}', 'preview_container')">
          <span class="att-badge">主合同扫描件</span>
          <span class="att-name">${escapeHtml(c.file_path)}</span>
          <span class="att-size">(${formatFileSize(c.file_size)})</span>
        </div>
        <div class="att-actions">
          <button class="btn-xs" onclick="previewAttachmentInContainer('${escapeHtml(c.file_path)}', '${escapeHtml(c.file_original_name || c.file_path)}', 'preview_container')">预览</button>
          <a class="btn-xs" href="${dlUrl}">下载</a>
        </div>
      </div>
    `);
  }

  for (const rf of (c.related_files || [])) {
    const dlUrl = withTokenUrl(`/uploads/${encodeURI(rf.file_path)}?download=1&filename=${encodeURIComponent(rf.file_original_name)}`);
    items.push(`
      <div class="att-card">
        <div class="att-info" onclick="previewAttachmentInContainer('${escapeHtml(rf.file_path)}', '${escapeHtml(rf.file_original_name)}', 'preview_container')">
          <span class="att-badge secondary">相关资料</span>
          <span class="att-name">${escapeHtml(rf.file_original_name)}</span>
          <span class="att-size">(${formatFileSize(rf.file_size)})</span>
        </div>
        <div class="att-actions">
          <button class="btn-xs" onclick="previewAttachmentInContainer('${escapeHtml(rf.file_path)}', '${escapeHtml(rf.file_original_name)}', 'preview_container')">预览</button>
          <a class="btn-xs" href="${dlUrl}">下载</a>
          <button class="btn-xs danger" onclick="deleteContractRelatedFile(${c.id}, ${rf.id})">删除</button>
        </div>
      </div>
    `);
  }

  box.innerHTML = items.length > 0 ? items.join('') : `<div class="text-muted">暂无任何附件</div>`;
}

function previewAttachmentInContainer(relPath, displayName, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = ''; // 先释放旧 DOM 节点

  const url = withTokenUrl(`/uploads/${encodeURI(relPath)}`);
  const dlUrl = withTokenUrl(`/uploads/${encodeURI(relPath)}?download=1&filename=${encodeURIComponent(displayName)}`);
  const ext = (relPath.split('.').pop() || '').toLowerCase();

  if (ext === 'pdf') {
    container.innerHTML = `<iframe src="${url}" class="pdf-frame" title="${escapeHtml(displayName)}"></iframe>`;
  } else if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
    container.innerHTML = `<div class="img-preview-wrap"><img src="${url}" alt="${escapeHtml(displayName)}" /></div>`;
  } else {
    container.innerHTML = `
      <div class="empty-preview">
        <p>当前文件 <strong>${escapeHtml(displayName)}</strong> 为 ${ext.toUpperCase()} 格式，不支持浏览器直接内嵌渲染。</p>
        <p style="margin-top:12px;"><a class="btn btn-primary" href="${dlUrl}">📥 点击下载到本地查看</a></p>
      </div>
    `;
  }
}

async function quickUploadMainScan(inputEl) {
  if (!currentDetailContract || !inputEl.files[0] || isUploadingDetail) return;
  isUploadingDetail = true;
  try {
    const fd = new FormData();
    fd.append('scan_file', inputEl.files[0]);
    const resp = await apiFetch(`/api/contracts/${currentDetailContract.id}/upload`, { method: 'POST', body: fd });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast('主合同扫描件已上传更新');
    inputEl.value = '';
    await openContractDetail(currentDetailContract.id);
    await loadContracts();
  } catch (err) {
    showToast(err.message || '上传失败', 'error');
  } finally {
    isUploadingDetail = false;
  }
}

async function quickUploadRelatedFiles(inputEl) {
  if (!currentDetailContract || !inputEl.files.length || isUploadingDetail) return;
  isUploadingDetail = true;
  try {
    const fd = new FormData();
    for (const f of inputEl.files) fd.append('related_files', f);
    const resp = await apiFetch(`/api/contracts/${currentDetailContract.id}/related-files`, { method: 'POST', body: fd });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast(json.message);
    inputEl.value = '';
    await openContractDetail(currentDetailContract.id);
    await loadContracts();
  } catch (err) {
    showToast(err.message || '上传失败', 'error');
  } finally {
    isUploadingDetail = false;
  }
}

async function deleteContractRelatedFile(contractId, fileId) {
  if (!confirm('确认删除该份相关资料附件？删除后将从硬盘物理清除！')) return;
  try {
    const resp = await apiFetch(`/api/contracts/${contractId}/related-files/${fileId}`, { method: 'DELETE' });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast('附件已物理删除');
    await openContractDetail(contractId);
    await loadContracts();
  } catch (err) {
    showToast(err.message || '删除失败', 'error');
  }
}

function closeDetailModal() {
  document.getElementById('detail_modal').classList.add('hidden');
  const container = document.getElementById('preview_container');
  if (container) container.innerHTML = ''; // 彻底销毁 iframe/img 句柄释放浏览器内存
  currentDetailContract = null;
}

// ==================== 6. 采购立项台账加载、CRUD 与跨表跳转 ====================
function getProcFilterParams() {
  const params = new URLSearchParams();
  const kw = document.getElementById('proc_filter_keyword')?.value.trim();
  const type = document.getElementById('proc_filter_type')?.value;
  const method = document.getElementById('proc_filter_method')?.value;
  const status = document.getElementById('proc_filter_status')?.value;
  const year = document.getElementById('proc_filter_year')?.value;
  const hasFile = document.getElementById('proc_filter_has_file')?.value;

  if (kw) params.set('keyword', kw);
  if (type) params.set('procurement_type', type);
  if (method) params.set('procurement_method', method);
  if (status) params.set('status', status);
  if (year) params.set('year', year);
  if (hasFile) params.set('has_file', hasFile);
  return params;
}

async function loadProcurements() {
  try {
    const params = getProcFilterParams();
    const resp = await apiFetch(`/api/procurements?${params.toString()}`);
    const json = await resp.json();
    if (!json.success) return;

    allProcurements = json.data || [];
    renderProcStats(json.stats);
    renderProcTable(allProcurements);
  } catch (err) {
    if (err.message !== '需要验证局域网访问口令') {
      showToast('加载采购立项失败', 'error');
    }
  }
}

function renderProcStats(stats) {
  if (!stats) return;
  document.getElementById('p_stat_total_count').textContent = stats.total_count || 0;
  document.getElementById('p_stat_total_budget').textContent = formatMoney(stats.total_budget || 0);
  document.getElementById('p_stat_total_final').textContent = formatMoney(stats.total_final || 0);
  document.getElementById('p_stat_linked_count').textContent = stats.linked_contract_count || 0;
}

function renderProcTable(rows) {
  const tbody = document.getElementById('procurement_tbody');
  if (!tbody) return;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row">暂无采购立项记录，点击右上角【+ 新增采购立项】开始录入</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const fCount = Number(r.file_count || 0);
    const fileTag = fCount > 0
      ? `<span class="file-tag ok" onclick="openProcurementDetail(${r.id})">📁 立项资料×${fCount}</span>`
      : `<span class="file-tag none">未上传</span>`;

    const contractChip = r.linked_contract_no
      ? `<span class="link-chip" title="${escapeHtml(r.linked_contract_name || '')}" onclick="jumpToContractDetail(${r.contract_id})">📄 ${escapeHtml(r.linked_contract_no)}</span>`
      : `<span class="text-muted">暂未签合同</span>`;

    return `
      <tr>
        <td class="mono-cell">${escapeHtml(r.seq_no)}</td>
        <td class="mono-cell font-semibold">${escapeHtml(r.procurement_no)}</td>
        <td>
          <div class="title-link" onclick="openProcurementDetail(${r.id})">${escapeHtml(r.project_name)}</div>
          ${r.supplier_name ? `<div class="sub-meta">供应商：${escapeHtml(r.supplier_name)}</div>` : ''}
        </td>
        <td class="center-cell">
          <span class="type-pill">${escapeHtml(r.procurement_type)}</span>
          <div class="sub-meta">${escapeHtml(r.procurement_method)}</div>
        </td>
        <td class="money-cell">${formatMoney(r.budget_amount)}</td>
        <td class="money-cell">${r.final_amount > 0 ? formatMoney(r.final_amount) : '<span class="text-muted">待定</span>'}</td>
        <td class="center-cell">${escapeHtml(r.department || '-')} / ${escapeHtml(r.applicant || '-')}</td>
        <td class="center-cell">${escapeHtml(r.approval_date)}</td>
        <td class="center-cell"><span class="status-badge ${getStatusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        <td class="center-cell">${contractChip}</td>
        <td class="center-cell">${fileTag}</td>
        <td class="action-cell">
          <button class="btn-link" onclick="openProcurementDetail(${r.id})">资料/详情</button>
          <button class="btn-link" onclick="openEditProcurementModal(${r.id})">编辑</button>
          <button class="btn-link danger" onclick="deleteProcurement(${r.id}, '${escapeHtml(r.procurement_no)}')">删除</button>
        </td>
      </tr>
    `;
  }).join('');
}

function resetProcFilters() {
  document.getElementById('proc_filter_keyword').value = '';
  document.getElementById('proc_filter_type').value = '';
  document.getElementById('proc_filter_method').value = '';
  document.getElementById('proc_filter_status').value = '';
  document.getElementById('proc_filter_year').value = '';
  document.getElementById('proc_filter_has_file').value = '';
  loadProcurements();
}

async function loadContractOptionsForProcForm(selectedContractId = null) {
  const sel = document.getElementById('p_contract_id');
  if (!sel) return;
  try {
    const resp = await apiFetch('/api/options/contracts');
    const json = await resp.json();
    const list = json.data || [];
    sel.innerHTML = `<option value="">-- 暂未签订合同 / 后续再关联 --</option>` + list.map(c => {
      const boundTip = c.linked_procurement_no && Number(c.id) !== Number(selectedContractId)
        ? ` [已绑:${c.linked_procurement_no}]`
        : '';
      return `<option value="${c.id}">${escapeHtml(c.contract_no)} - ${escapeHtml(c.contract_name)} (${formatMoney(c.amount)})${escapeHtml(boundTip)}</option>`;
    }).join('');
    if (selectedContractId) sel.value = String(selectedContractId);
  } catch (e) {}
}

async function openCreateProcurementModal() {
  document.getElementById('procurement_form').reset();
  document.getElementById('p_id').value = '';
  document.getElementById('proc_modal_title').textContent = '新增采购立项与资料归档';

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('p_approval_date').value = today;
  document.getElementById('seg_p_mid').value = '';

  await loadContractOptionsForProcForm(null);
  await refreshProcNoSegmentsByDateAndMid();
  document.getElementById('procurement_modal').classList.remove('hidden');
}

async function openEditProcurementModal(id) {
  try {
    const resp = await apiFetch(`/api/procurements/${id}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    const p = json.data;

    document.getElementById('procurement_form').reset();
    document.getElementById('p_id').value = p.id;
    document.getElementById('proc_modal_title').textContent = `编辑采购立项：${p.procurement_no}`;

    await loadContractOptionsForProcForm(p.contract_id);

    document.getElementById('p_procurement_no').value = p.procurement_no;
    document.getElementById('seg_p_prefix').value = procNoRule.prefix || '';
    document.getElementById('seg_p_mid').value = '';
    document.getElementById('seg_p_date').value = '';
    document.getElementById('seg_p_seq').value = '';
    document.getElementById('seg_p_suffix').value = procNoRule.suffix || '';

    document.getElementById('p_project_name').value = p.project_name;
    document.getElementById('p_procurement_type').value = p.procurement_type;
    document.getElementById('p_procurement_method').value = p.procurement_method;
    document.getElementById('p_budget_amount').value = p.budget_amount;
    document.getElementById('p_control_price').value = p.control_price;
    document.getElementById('p_final_amount').value = p.final_amount;
    document.getElementById('p_department').value = p.department || '';
    document.getElementById('p_applicant').value = p.applicant || '';
    document.getElementById('p_approval_date').value = p.approval_date;
    document.getElementById('p_supplier_name').value = p.supplier_name || '';
    document.getElementById('p_status').value = p.status;
    document.getElementById('p_remark').value = p.remark || '';

    document.getElementById('procurement_modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message || '读取立项详情失败', 'error');
  }
}

function closeProcurementModal() {
  document.getElementById('procurement_modal').classList.add('hidden');
}

async function submitProcurementForm(e) {
  e.preventDefault();
  if (isSubmittingForm) return;
  isSubmittingForm = true;
  const submitBtn = document.getElementById('proc_submit_btn');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const id = document.getElementById('p_id').value;
    const fd = new FormData();
    fd.append('procurement_no', document.getElementById('p_procurement_no').value.trim());
    fd.append('project_name', document.getElementById('p_project_name').value.trim());
    fd.append('procurement_type', document.getElementById('p_procurement_type').value);
    fd.append('procurement_method', document.getElementById('p_procurement_method').value);
    fd.append('budget_amount', document.getElementById('p_budget_amount').value || '0');
    fd.append('control_price', document.getElementById('p_control_price').value || '0');
    fd.append('final_amount', document.getElementById('p_final_amount').value || '0');
    fd.append('department', document.getElementById('p_department').value.trim());
    fd.append('applicant', document.getElementById('p_applicant').value.trim());
    fd.append('approval_date', document.getElementById('p_approval_date').value);
    fd.append('supplier_name', document.getElementById('p_supplier_name').value.trim());
    fd.append('status', document.getElementById('p_status').value);
    fd.append('contract_id', document.getElementById('p_contract_id').value || '');
    fd.append('remark', document.getElementById('p_remark').value.trim());
    fd.append('file_category', document.getElementById('p_file_category').value || '立项审批表/资料');

    const filesInput = document.getElementById('p_proc_files');
    if (filesInput && filesInput.files.length > 0) {
      for (const f of filesInput.files) {
        fd.append('proc_files', f);
      }
    }

    const url = id ? `/api/procurements/${id}` : '/api/procurements';
    const method = id ? 'PUT' : 'POST';
    const resp = await apiFetch(url, { method, body: fd });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);

    showToast(json.message || '保存成功');
    closeProcurementModal();
    await loadProcNoRule();
    await loadProcurements();
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  } finally {
    isSubmittingForm = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteProcurement(id, procNo) {
  if (!confirm(`确定要彻底删除采购立项【${procNo}】吗？\n删除后，该立项下的所有资料文件与文件夹将同步从硬盘物理删除！`)) {
    return;
  }
  try {
    const resp = await apiFetch(`/api/procurements/${id}`, { method: 'DELETE' });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast(json.message);
    await loadProcNoRule();
    await loadProcurements();
  } catch (err) {
    showToast(err.message || '删除失败', 'error');
  }
}

// 采购立项详情与附件预览弹窗
async function openProcurementDetail(id) {
  try {
    const resp = await apiFetch(`/api/procurements/${id}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    currentDetailProcurement = json.data;
    renderProcurementDetailModal(currentDetailProcurement);
    document.getElementById('proc_detail_modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message || '获取立项详情失败', 'error');
  }
}

function renderProcurementDetailModal(p) {
  document.getElementById('pd_title').textContent = `${p.procurement_no} - ${p.project_name}`;
  const contractInfo = p.linked_contract_no
    ? `<span class="link-chip" onclick="closeProcDetailModal(); jumpToContractDetail(${p.contract_id})">📄 ${escapeHtml(p.linked_contract_no)} (${escapeHtml(p.linked_contract_name || '')})</span>`
    : '暂未关联主合同';

  document.getElementById('pd_meta_grid').innerHTML = `
    <div><strong>立项序号：</strong>${escapeHtml(p.seq_no)}</div>
    <div><strong>类别/方式：</strong>${escapeHtml(p.procurement_type)} / ${escapeHtml(p.procurement_method)}</div>
    <div><strong>预算金额：</strong><span class="money-text">${formatMoney(p.budget_amount)}</span></div>
    <div><strong>控制价/最高限价：</strong>${formatMoney(p.control_price)}</div>
    <div><strong>中标/成交金额：</strong><span class="money-text">${p.final_amount > 0 ? formatMoney(p.final_amount) : '待定'}</span></div>
    <div><strong>立项状态：</strong><span class="status-badge ${getStatusBadgeClass(p.status)}">${escapeHtml(p.status)}</span></div>
    <div><strong>申请部门/经办人：</strong>${escapeHtml(p.department || '-')} / ${escapeHtml(p.applicant || '-')}</div>
    <div><strong>立项批准日期：</strong>${escapeHtml(p.approval_date)}</div>
    <div><strong>成交供应商：</strong>${escapeHtml(p.supplier_name || '待定')}</div>
    <div><strong>关联主合同：</strong>${contractInfo}</div>
    <div style="grid-column: span 2;"><strong>备注说明：</strong>${escapeHtml(p.remark || '无')}</div>
  `;

  const files = p.files || [];
  const listEl = document.getElementById('pd_attachments_list');
  if (files.length === 0) {
    listEl.innerHTML = `<div class="text-muted">暂未上传任何立项资料</div>`;
    document.getElementById('proc_preview_container').innerHTML = `<div class="empty-preview">暂无立项资料可预览，可在上方选择分类并补传资料</div>`;
  } else {
    listEl.innerHTML = files.map(f => {
      const dlUrl = withTokenUrl(`/uploads/${encodeURI(f.file_path)}?download=1&filename=${encodeURIComponent(f.file_original_name)}`);
      return `
        <div class="att-card">
          <div class="att-info" onclick="previewAttachmentInContainer('${escapeHtml(f.file_path)}', '${escapeHtml(f.file_original_name)}', 'proc_preview_container')">
            <span class="att-badge">${escapeHtml(f.file_category || '立项资料')}</span>
            <span class="att-name">${escapeHtml(f.file_original_name)}</span>
            <span class="att-size">(${formatFileSize(f.file_size)})</span>
          </div>
          <div class="att-actions">
            <button class="btn-xs" onclick="previewAttachmentInContainer('${escapeHtml(f.file_path)}', '${escapeHtml(f.file_original_name)}', 'proc_preview_container')">预览</button>
            <a class="btn-xs" href="${dlUrl}">下载</a>
            <button class="btn-xs danger" onclick="deleteProcFile(${p.id}, ${f.id})">删除</button>
          </div>
        </div>
      `;
    }).join('');
    previewAttachmentInContainer(files[0].file_path, files[0].file_original_name, 'proc_preview_container');
  }
}

async function quickUploadProcFiles(inputEl) {
  if (!currentDetailProcurement || !inputEl.files.length || isUploadingDetail) return;
  isUploadingDetail = true;
  try {
    const fd = new FormData();
    const cat = document.getElementById('pd_quick_category')?.value || '立项资料';
    fd.append('file_category', cat);
    for (const f of inputEl.files) fd.append('proc_files', f);

    const resp = await apiFetch(`/api/procurements/${currentDetailProcurement.id}/files`, { method: 'POST', body: fd });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast(json.message);
    inputEl.value = '';
    await openProcurementDetail(currentDetailProcurement.id);
    await loadProcurements();
  } catch (err) {
    showToast(err.message || '上传立项资料失败', 'error');
  } finally {
    isUploadingDetail = false;
  }
}

async function deleteProcFile(procId, fileId) {
  if (!confirm('确认删除该份立项资料？删除后将从硬盘物理清除！')) return;
  try {
    const resp = await apiFetch(`/api/procurements/${procId}/files/${fileId}`, { method: 'DELETE' });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    showToast('立项资料已物理删除');
    await openProcurementDetail(procId);
    await loadProcurements();
  } catch (err) {
    showToast(err.message || '删除失败', 'error');
  }
}

function closeProcDetailModal() {
  document.getElementById('proc_detail_modal').classList.add('hidden');
  const container = document.getElementById('proc_preview_container');
  if (container) container.innerHTML = ''; // 立即销毁预览 DOM 释放内存
  currentDetailProcurement = null;
}

// 跨模块跳转查看详情
async function jumpToProcurementDetail(procId) {
  if (!procId) return;
  await switchModule('procurement');
  await openProcurementDetail(procId);
}

async function jumpToContractDetail(contractId) {
  if (!contractId) return;
  await switchModule('contracts');
  await openContractDetail(contractId);
}

// ==================== 7. Excel 报表导出 ====================
function exportContractsExcel() {
  const params = getContractFilterParams();
  window.location.href = withTokenUrl(`/api/contracts/export?${params.toString()}`);
}

function exportProcurementsExcel() {
  const params = getProcFilterParams();
  window.location.href = withTokenUrl(`/api/procurements/export?${params.toString()}`);
}

function exportCombinedExcel() {
  window.location.href = withTokenUrl('/api/export/combined');
}

// ==================== 8. 局域网共享弹窗与口令锁 ====================
async function openLanShareModal() {
  try {
    const resp = await apiFetch('/api/system/network');
    const json = await resp.json();
    const listEl = document.getElementById('lan_url_list');
    if (json.lan_urls && json.lan_urls.length > 0) {
      listEl.innerHTML = json.lan_urls.map(u => `
        <div class="lan-url-item">
          <code>${escapeHtml(u)}</code>
          <button class="btn-xs" onclick="navigator.clipboard.writeText('${escapeHtml(u)}'); showToast('已复制局域网链接');">复制地址</button>
        </div>
      `).join('');
    } else {
      listEl.innerHTML = `<div class="text-muted">未检测到局域网网卡 IP，本机可使用 ${escapeHtml(json.local_url)}</div>`;
    }
    document.getElementById('lan_modal').classList.remove('hidden');
  } catch (e) {
    showToast('获取网络信息失败', 'error');
  }
}

function closeLanShareModal() {
  document.getElementById('lan_modal').classList.add('hidden');
}

async function saveLanAccessCode() {
  const code = document.getElementById('lan_new_code').value.trim();
  try {
    const resp = await apiFetch('/api/auth/set-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_code: code })
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    setAccessToken(json.token || '');
    document.getElementById('lan_new_code').value = '';
    showToast(json.message);
  } catch (err) {
    showToast(err.message || '设置口令失败', 'error');
  }
}

function showLanAuthOverlay() {
  document.getElementById('lan_auth_overlay')?.classList.remove('hidden');
}

async function submitLanAuthVerify(e) {
  e.preventDefault();
  const code = document.getElementById('lan_auth_input').value.trim();
  try {
    const resp = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_code: code })
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message);
    setAccessToken(json.token || '');
    document.getElementById('lan_auth_overlay').classList.add('hidden');
    document.getElementById('lan_auth_input').value = '';
    showToast('口令验证成功');
    await switchModule(currentModule);
  } catch (err) {
    showToast(err.message || '口令错误', 'error');
  }
}

// ==================== 9. 多机局域网协同：窗口激活与定时静默同步 ====================
function isAnyModalOpen() {
  const modalIds = [
    'lan_auth_overlay',
    'contract_modal',
    'procurement_modal',
    'detail_modal',
    'proc_detail_modal',
    'no_rule_modal',
    'proc_no_rule_modal',
    'lan_modal'
  ];
  for (const id of modalIds) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) return true;
  }
  return false;
}

async function silentSyncMultiClientData() {
  // 防打扰保护：若用户正在弹窗中录入/编辑/预览，或正在上传/提交，绝不执行静默刷新
  if (isSilentSyncing || isSubmittingForm || isUploadingDetail || isAnyModalOpen()) return;
  isSilentSyncing = true;
  try {
    if (currentModule === 'procurement') {
      await loadProcNoRule();
      await loadProcurements();
    } else {
      await loadContractNoRule();
      await loadContracts();
    }
  } catch (e) {
  } finally {
    isSilentSyncing = false;
  }
}

window.addEventListener('focus', () => {
  silentSyncMultiClientData();
});

setInterval(() => {
  if (!document.hidden) {
    silentSyncMultiClientData();
  }
}, 30000);

// ==================== 10. 页面启动入口 ====================
window.addEventListener('DOMContentLoaded', async () => {
  initYearSelects();
  try {
    const resp = await fetch('/api/auth/status', {
      headers: getAccessToken() ? { 'x-access-token': getAccessToken() } : {}
    });
    const json = await resp.json();
    if (json.locked && !json.authorized) {
      showLanAuthOverlay();
      return;
    }
  } catch (e) {}

  await loadContractNoRule();
  await loadProcNoRule();
  await loadContracts();
});
