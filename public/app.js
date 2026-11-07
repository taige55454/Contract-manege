/**
 * 合同与采购立项综合台账管理系统 - 前端交互核心 (public/app.js)
 * 特性：
 * 1. 多机协同静默同步：切回窗口或每 30 秒自动静默刷新列表与编号预览（弹窗打开或提交中自动避让，零闪烁、零打断）
 * 2. 乐观预览编号器：打开弹窗只读预览下一个最小空缺号，取消绝不占号；支持中间穿插自定义段实时拼接
 * 3. 内存零泄漏：关闭详情弹窗时立即清空 preview_container DOM 节点，释放 PDF iframe 与高清图片内存
 */

let currentModule = 'contracts'; // 'contracts' | 'procurement'
let lanToken = localStorage.getItem('lan_access_token') || '';
let currentContractRule = { prefix: 'HT-', date_format: 'YYYYMM', seq_digits: 3, suffix: '' };
let currentProcRule = { prefix: 'LX', date_format: 'YYYYMMDD', seq_digits: 3, suffix: '' };

let activeDetailContractId = null;
let activeDetailProcId = null;
let isSubmittingForm = false;
let isUploadingDetail = false;
let isSilentSyncing = false;
let searchDebounceTimer = null;

// ==================== 1. 统一请求封装与鉴权拦截 ====================
async function apiFetch(url, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  if (lanToken) {
    headers['X-LAN-Token'] = lanToken;
  }
  const resp = await fetch(url, { ...options, headers });
  if (resp.status === 401 && !url.includes('/api/auth/')) {
    showAuthOverlay();
    throw new Error('需要验证局域网访问密码');
  }
  return resp;
}

function appendTokenToUrl(url) {
  if (!lanToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(lanToken)}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(val) {
  const num = Number(val || 0);
  return '¥' + num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFileSize(bytes) {
  const b = Number(bytes || 0);
  if (b <= 0) return '0 KB';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toast_container');
  if (!container) {
    alert(msg);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast-item toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-hide');
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

// ==================== 2. 局域网密码锁与系统网络信息 ====================
async function checkAuthStatus() {
  try {
    const res = await apiFetch('/api/auth/status');
    const data = await res.json();
    const lockBadge = document.getElementById('lan_lock_badge');
    if (lockBadge) {
      lockBadge.textContent = data.has_password ? '🔒 密码保护已开启' : '🔓 密码保护未开启';
    }
    if (data.has_password && !data.authenticated) {
      showAuthOverlay();
      return false;
    }
    hideAuthOverlay();
    return true;
  } catch (e) {
    return false;
  }
}

function showAuthOverlay() {
  const el = document.getElementById('lan_auth_overlay');
  if (el) el.classList.remove('hidden');
}

function hideAuthOverlay() {
  const el = document.getElementById('lan_auth_overlay');
  if (el) el.classList.add('hidden');
}

async function handleLanUnlock(e) {
  if (e) e.preventDefault();
  const pwdInput = document.getElementById('lan_unlock_password');
  const errEl = document.getElementById('lan_unlock_error');
  const password = pwdInput ? pwdInput.value : '';
  if (errEl) errEl.textContent = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      if (errEl) errEl.textContent = data.message || '密码错误';
      return;
    }
    lanToken = data.token || '';
    localStorage.setItem('lan_access_token', lanToken);
    if (pwdInput) pwdInput.value = '';
    hideAuthOverlay();
    await initAppData();
    showToast('🔓 解锁成功，欢迎使用');
  } catch (err) {
    if (errEl) errEl.textContent = '网络请求失败，请检查服务是否运行';
  }
}

function openPasswordModal() {
  const modal = document.getElementById('password_modal');
  if (!modal) return;
  const cur = document.getElementById('pwd_current');
  const nw = document.getElementById('pwd_new');
  if (cur) cur.value = '';
  if (nw) nw.value = '';
  modal.classList.remove('hidden');
}

function closePasswordModal() {
  const modal = document.getElementById('password_modal');
  if (modal) modal.classList.add('hidden');
}

async function saveLanPassword(e) {
  if (e) e.preventDefault();
  const current_password = document.getElementById('pwd_current')?.value || '';
  const new_password = document.getElementById('pwd_new')?.value || '';
  try {
    const res = await apiFetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password, new_password })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || '设置密码失败', 'error');
      return;
    }
    if (data.token) {
      lanToken = data.token;
      localStorage.setItem('lan_access_token', lanToken);
    }
    closePasswordModal();
    await checkAuthStatus();
    showToast(data.message || '密码设置已更新');
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  }
}

async function loadSystemInfo() {
  try {
    const res = await apiFetch('/api/system-info');
    const data = await res.json();
    if (!data.success) return;
    const banner = document.getElementById('lan_url_display');
    if (banner) {
      const urls = data.lan_urls && data.lan_urls.length > 0 ? data.lan_urls.join(' 或 ') : data.local_url;
      banner.textContent = urls;
    }
  } catch (e) {}
}

// ==================== 3. 模块导航切换（合同台账 <-> 采购立项台账） ====================
function switchModule(mod) {
  currentModule = mod === 'procurement' ? 'procurement' : 'contracts';
  const btnContracts = document.getElementById('tab_btn_contracts');
  const btnProc = document.getElementById('tab_btn_procurement');
  const secContracts = document.getElementById('module_contracts');
  const secProc = document.getElementById('module_procurement');

  if (currentModule === 'contracts') {
    if (btnContracts) btnContracts.classList.add('active');
    if (btnProc) btnProc.classList.remove('active');
    if (secContracts) secContracts.classList.remove('hidden');
    if (secProc) secProc.classList.add('hidden');
    loadContractNoRule();
    loadContracts();
  } else {
    if (btnProc) btnProc.classList.add('active');
    if (btnContracts) btnContracts.classList.remove('active');
    if (secProc) secProc.classList.remove('hidden');
    if (secContracts) secContracts.classList.add('hidden');
    loadProcNoRule();
    loadProcurements();
  }
}

// ==================== 4. 合同编号规则与分段穿插编号器 ====================
async function loadContractNoRule() {
  try {
    const res = await apiFetch('/api/settings/contract-no-rule');
    const data = await res.json();
    if (!data.success) return;
    currentContractRule = data.rule;
    const previewBadge = document.getElementById('next_contract_no_preview');
    if (previewBadge) previewBadge.textContent = data.next_no || '';
  } catch (e) {}
}

function openRuleModal() {
  const modal = document.getElementById('rule_modal');
  if (!modal) return;
  document.getElementById('rule_prefix').value = currentContractRule.prefix || '';
  document.getElementById('rule_date_format').value = currentContractRule.date_format || 'YYYYMM';
  document.getElementById('rule_seq_digits').value = currentContractRule.seq_digits ?? 3;
  document.getElementById('rule_suffix').value = currentContractRule.suffix || '';
  updateRuleLiveSample();
  modal.classList.remove('hidden');
}

function closeRuleModal() {
  const modal = document.getElementById('rule_modal');
  if (modal) modal.classList.add('hidden');
}

function updateRuleLiveSample() {
  const prefix = document.getElementById('rule_prefix')?.value || '';
  const df = document.getElementById('rule_date_format')?.value || 'YYYYMM';
  const digits = parseInt(document.getElementById('rule_seq_digits')?.value ?? 3, 10) || 0;
  const suffix = document.getElementById('rule_suffix')?.value || '';
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  let dStr = '';
  if (df === 'YYYYMMDD') dStr = `${yyyy}${mm}${dd}`;
  else if (df === 'YYYYMM') dStr = `${yyyy}${mm}`;
  else if (df === 'YYYY') dStr = `${yyyy}`;
  const seqStr = digits > 0 ? String(1).padStart(digits, '0') : '';
  const sampleEl = document.getElementById('rule_live_sample');
  if (sampleEl) sampleEl.textContent = `${prefix}${dStr}${seqStr}${suffix}`;
}

async function saveContractNoRule(e) {
  if (e) e.preventDefault();
  const payload = {
    prefix: document.getElementById('rule_prefix')?.value || '',
    date_format: document.getElementById('rule_date_format')?.value || 'YYYYMM',
    seq_digits: Number(document.getElementById('rule_seq_digits')?.value ?? 3),
    suffix: document.getElementById('rule_suffix')?.value || ''
  };
  try {
    const res = await apiFetch('/api/settings/contract-no-rule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '保存规则失败', 'error');
      return;
    }
    currentContractRule = data.rule;
    const previewBadge = document.getElementById('next_contract_no_preview');
    if (previewBadge) previewBadge.textContent = data.next_no || '';
    closeRuleModal();
    showToast('⚙️ 合同编号规则已保存生效');
  } catch (err) {
    showToast(err.message || '保存规则异常', 'error');
  }
}

/**
 * 合同表单内：拉取后端最新可用流水号并填入分段编号器（乐观只读预览，不占数据库坑位）
 */
async function refreshFormNextContractNo() {
  const signDate = document.getElementById('sign_date')?.value || '';
  const midCustom = document.getElementById('no_seg_mid')?.value || '';
  try {
    const q = new URLSearchParams({ sign_date: signDate, mid_custom: midCustom });
    const res = await apiFetch(`/api/settings/contract-no-rule?${q.toString()}`);
    const data = await res.json();
    if (!data.success || !data.parts) return;
    const p = data.parts;
    const segPrefix = document.getElementById('no_seg_prefix');
    const segDate = document.getElementById('no_seg_date');
    const segSeq = document.getElementById('no_seg_seq');
    const segSuffix = document.getElementById('no_seg_suffix');
    if (segPrefix) segPrefix.value = p.prefix || '';
    if (segDate) segDate.value = p.date_part || '';
    if (segSeq) segSeq.value = p.seq_part || '';
    if (segSuffix) segSuffix.value = p.suffix || '';
    assembleSegmentedContractNo();
  } catch (e) {}
}

function assembleSegmentedContractNo() {
  const segPrefix = document.getElementById('no_seg_prefix')?.value || '';
  const segMid = document.getElementById('no_seg_mid')?.value || '';
  const segDate = document.getElementById('no_seg_date')?.value || '';
  const segSeq = document.getElementById('no_seg_seq')?.value || '';
  const segSuffix = document.getElementById('no_seg_suffix')?.value || '';
  const mainInput = document.getElementById('contract_no');
  if (mainInput) {
    mainInput.value = `${segPrefix}${segMid}${segDate}${segSeq}${segSuffix}`;
  }
}

// ==================== 5. 采购立项编号规则与分段编号器 ====================
async function loadProcNoRule() {
  try {
    const res = await apiFetch('/api/settings/procurement-no-rule');
    const data = await res.json();
    if (!data.success) return;
    currentProcRule = data.rule;
    const previewBadge = document.getElementById('next_proc_no_preview');
    if (previewBadge) previewBadge.textContent = data.next_no || '';
  } catch (e) {}
}

function openProcRuleModal() {
  const modal = document.getElementById('proc_rule_modal');
  if (!modal) return;
  document.getElementById('proc_rule_prefix').value = currentProcRule.prefix || '';
  document.getElementById('proc_rule_date_format').value = currentProcRule.date_format || 'YYYYMMDD';
  document.getElementById('proc_rule_seq_digits').value = currentProcRule.seq_digits ?? 3;
  document.getElementById('proc_rule_suffix').value = currentProcRule.suffix || '';
  updateProcRuleLiveSample();
  modal.classList.remove('hidden');
}

function closeProcRuleModal() {
  const modal = document.getElementById('proc_rule_modal');
  if (modal) modal.classList.add('hidden');
}

function updateProcRuleLiveSample() {
  const prefix = document.getElementById('proc_rule_prefix')?.value || '';
  const df = document.getElementById('proc_rule_date_format')?.value || 'YYYYMMDD';
  const digits = parseInt(document.getElementById('proc_rule_seq_digits')?.value ?? 3, 10) || 0;
  const suffix = document.getElementById('proc_rule_suffix')?.value || '';
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  let dStr = '';
  if (df === 'YYYYMMDD') dStr = `${yyyy}${mm}${dd}`;
  else if (df === 'YYYYMM') dStr = `${yyyy}${mm}`;
  else if (df === 'YYYY') dStr = `${yyyy}`;
  const seqStr = digits > 0 ? String(1).padStart(digits, '0') : '';
  const sampleEl = document.getElementById('proc_rule_live_sample');
  if (sampleEl) sampleEl.textContent = `${prefix}${dStr}${seqStr}${suffix}`;
}

async function saveProcNoRule(e) {
  if (e) e.preventDefault();
  const payload = {
    prefix: document.getElementById('proc_rule_prefix')?.value || '',
    date_format: document.getElementById('proc_rule_date_format')?.value || 'YYYYMMDD',
    seq_digits: Number(document.getElementById('proc_rule_seq_digits')?.value ?? 3),
    suffix: document.getElementById('proc_rule_suffix')?.value || ''
  };
  try {
    const res = await apiFetch('/api/settings/procurement-no-rule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '保存规则失败', 'error');
      return;
    }
    currentProcRule = data.rule;
    const previewBadge = document.getElementById('next_proc_no_preview');
    if (previewBadge) previewBadge.textContent = data.next_no || '';
    closeProcRuleModal();
    showToast('⚙️ 采购立项编号规则已保存生效');
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  }
}

async function refreshFormNextProcNo() {
  const approvalDate = document.getElementById('proc_approval_date')?.value || '';
  const midCustom = document.getElementById('proc_seg_mid')?.value || '';
  try {
    const q = new URLSearchParams({ approval_date: approvalDate, mid_custom: midCustom });
    const res = await apiFetch(`/api/settings/procurement-no-rule?${q.toString()}`);
    const data = await res.json();
    if (!data.success || !data.parts) return;
    const p = data.parts;
    const segPrefix = document.getElementById('proc_seg_prefix');
    const segDate = document.getElementById('proc_seg_date');
    const segSeq = document.getElementById('proc_seg_seq');
    const segSuffix = document.getElementById('proc_seg_suffix');
    if (segPrefix) segPrefix.value = p.prefix || '';
    if (segDate) segDate.value = p.date_part || '';
    if (segSeq) segSeq.value = p.seq_part || '';
    if (segSuffix) segSuffix.value = p.suffix || '';
    assembleSegmentedProcNo();
  } catch (e) {}
}

function assembleSegmentedProcNo() {
  const segPrefix = document.getElementById('proc_seg_prefix')?.value || '';
  const segMid = document.getElementById('proc_seg_mid')?.value || '';
  const segDate = document.getElementById('proc_seg_date')?.value || '';
  const segSeq = document.getElementById('proc_seg_seq')?.value || '';
  const segSuffix = document.getElementById('proc_seg_suffix')?.value || '';
  const mainInput = document.getElementById('procurement_no');
  if (mainInput) {
    mainInput.value = `${segPrefix}${segMid}${segDate}${segSeq}${segSuffix}`;
  }
}

// ==================== 6. 合同列表加载、筛选与增删改弹窗 ====================
function buildContractQueryParams() {
  const params = new URLSearchParams();
  const kw = document.getElementById('search_keyword')?.value?.trim() || '';
  const st = document.getElementById('filter_status')?.value || '';
  const ct = document.getElementById('filter_type')?.value || '';
  const sd = document.getElementById('filter_start_date')?.value || '';
  const ed = document.getElementById('filter_end_date')?.value || '';
  if (kw) params.set('keyword', kw);
  if (st) params.set('status', st);
  if (ct) params.set('contract_type', ct);
  if (sd) params.set('start_date', sd);
  if (ed) params.set('end_date', ed);
  return params;
}

function triggerSearchDebounce(type) {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    if (type === 'procurement') loadProcurements();
    else loadContracts();
  }, 250);
}

async function loadContracts() {
  try {
    const q = buildContractQueryParams();
    const res = await apiFetch(`/api/contracts?${q.toString()}`);
    const json = await res.json();
    if (!json.success) return;

    // 渲染顶部统计卡片
    if (json.stats) {
      const elTotal = document.getElementById('stat_total_count');
      const elAmount = document.getElementById('stat_total_amount');
      const elActive = document.getElementById('stat_active_count');
      const elComp = document.getElementById('stat_completed_count');
      if (elTotal) elTotal.textContent = json.stats.total_count || 0;
      if (elAmount) elAmount.textContent = formatMoney(json.stats.total_amount || 0);
      if (elActive) elActive.textContent = json.stats.active_count || 0;
      if (elComp) elComp.textContent = json.stats.completed_count || 0;
    }

    const tbody = document.getElementById('contract_tbody');
    if (!tbody) return;

    const list = json.data || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" class="empty-cell">暂无符合条件的合同台账记录</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(row => {
      const relCount = Array.isArray(row.related_files) ? row.related_files.length : 0;
      const scanBadge = row.file_name
        ? `<span class="badge badge-file" onclick="openDetailModal(${row.id})" title="点击在线预览扫描件">📄 扫描件</span>`
        : `<span class="badge badge-nofile" onclick="openDetailModal(${row.id})" title="点击补传扫描件">➕ 待上传</span>`;
      const relBadge = relCount > 0
        ? `<span class="badge badge-rel" onclick="openDetailModal(${row.id})">📎 资料(${relCount})</span>`
        : '';
      const procBadge = row.linked_procurement_no
        ? `<span class="badge badge-proc" onclick="openProcDetailModal(${row.procurement_id})" title="${escapeHtml(row.linked_project_name || '')}">🔗 ${escapeHtml(row.linked_procurement_no)}</span>`
        : `<span class="text-muted">未关联</span>`;

      let statusClass = 'status-active';
      if (row.status === '已完结') statusClass = 'status-done';
      else if (row.status === '已解除' || row.status === '异常中止') statusClass = 'status-warn';

      return `
        <tr>
          <td class="mono-cell">${escapeHtml(row.seq_no)}</td>
          <td class="mono-cell bold-cell">${escapeHtml(row.contract_no)}</td>
          <td>
            <div class="title-link" onclick="openDetailModal(${row.id})">${escapeHtml(row.contract_name)}</div>
            ${row.contract_type ? `<span class="sub-tag">${escapeHtml(row.contract_type)}</span>` : ''}
          </td>
          <td>
            <div class="party-line"><span class="party-label">甲:</span> ${escapeHtml(row.party_a)}</div>
            <div class="party-line"><span class="party-label">乙:</span> ${escapeHtml(row.party_b)}</div>
          </td>
          <td class="amount-cell">${formatMoney(row.amount)}</td>
          <td>${escapeHtml(row.sign_date)}</td>
          <td>${procBadge}</td>
          <td><span class="status-pill ${statusClass}">${escapeHtml(row.status)}</span></td>
          <td>${escapeHtml(row.owner || '-')}${row.department ? `<div class="sub-text">${escapeHtml(row.department)}</div>` : ''}</td>
          <td><div class="file-badges-wrap">${scanBadge}${relBadge}</div></td>
          <td class="action-cell">
            <button class="btn-link" onclick="openDetailModal(${row.id})">详情/附件</button>
            <button class="btn-link" onclick="openEditModal(${row.id})">编辑</button>
            <button class="btn-link btn-danger-link" onclick="deleteContract(${row.id}, '${escapeHtml(row.contract_no)}')">删除</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {}
}

function resetFilters() {
  ['search_keyword', 'filter_status', 'filter_type', 'filter_start_date', 'filter_end_date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  loadContracts();
}

async function populateProcurementSelect(selectedProcId = null) {
  const sel = document.getElementById('contract_procurement_id');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/procurements/simple-list');
    const json = await res.json();
    const list = json.data || [];
    let html = `<option value="">-- 不关联采购立项（直接签订） --</option>`;
    for (const p of list) {
      const isSelected = selectedProcId && Number(selectedProcId) === Number(p.id);
      const occupiedNote = (p.linked_contract_no && !isSelected) ? ` [已绑:${p.linked_contract_no}]` : '';
      html += `<option value="${p.id}" data-project="${escapeHtml(p.project_name)}" data-supplier="${escapeHtml(p.supplier || '')}" data-amount="${p.final_amount || p.budget_amount || 0}" ${isSelected ? 'selected' : ''}>${escapeHtml(p.procurement_no)} - ${escapeHtml(p.project_name)} (预算:${formatMoney(p.budget_amount)})${escapeHtml(occupiedNote)}</option>`;
    }
    sel.innerHTML = html;
  } catch (e) {}
}

function onSelectProcurementInContractForm() {
  const sel = document.getElementById('contract_procurement_id');
  if (!sel || !sel.value) return;
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return;
  const nameInput = document.getElementById('contract_name');
  const partyBInput = document.getElementById('party_b');
  const amountInput = document.getElementById('amount');
  if (nameInput && !nameInput.value.trim() && opt.dataset.project) {
    nameInput.value = opt.dataset.project;
  }
  if (partyBInput && !partyBInput.value.trim() && opt.dataset.supplier) {
    partyBInput.value = opt.dataset.supplier;
  }
  if (amountInput && (!amountInput.value || Number(amountInput.value) === 0) && Number(opt.dataset.amount) > 0) {
    amountInput.value = opt.dataset.amount;
  }
}

async function openCreateModal(prefillFromProc = null) {
  const modal = document.getElementById('contract_modal');
  const form = document.getElementById('contract_form');
  if (!modal || !form) return;
  form.reset();
  document.getElementById('contract_id').value = '';
  document.getElementById('modal_title').textContent = '新增合同台账';
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('sign_date').value = today;
  const midInput = document.getElementById('no_seg_mid');
  if (midInput) midInput.value = '';
  const currentFileTip = document.getElementById('current_file_tip');
  if (currentFileTip) currentFileTip.innerHTML = '';

  await populateProcurementSelect(prefillFromProc ? prefillFromProc.id : null);
  await refreshFormNextContractNo();

  if (prefillFromProc) {
    document.getElementById('contract_name').value = prefillFromProc.project_name || '';
    document.getElementById('party_b').value = prefillFromProc.supplier || '';
    document.getElementById('amount').value = prefillFromProc.final_amount || prefillFromProc.budget_amount || 0;
    document.getElementById('department').value = prefillFromProc.department || '';
    document.getElementById('owner').value = prefillFromProc.applicant || '';
    document.getElementById('phone').value = prefillFromProc.phone || '';
  }

  modal.classList.remove('hidden');
}

async function openEditModal(id) {
  try {
    const res = await apiFetch(`/api/contracts/${id}`);
    const json = await res.json();
    if (!json.success) return;
    const c = json.data;

    const modal = document.getElementById('contract_modal');
    const form = document.getElementById('contract_form');
    form.reset();

    document.getElementById('contract_id').value = c.id;
    document.getElementById('modal_title').textContent = `编辑合同：${c.contract_no}`;
    document.getElementById('contract_no').value = c.contract_no || '';
    document.getElementById('contract_name').value = c.contract_name || '';
    document.getElementById('contract_type').value = c.contract_type || '';
    document.getElementById('party_a').value = c.party_a || '';
    document.getElementById('party_b').value = c.party_b || '';
    document.getElementById('amount').value = c.amount ?? 0;
    document.getElementById('sign_date').value = c.sign_date || '';
    document.getElementById('start_date').value = c.start_date || '';
    document.getElementById('end_date').value = c.end_date || '';
    document.getElementById('status').value = c.status || '履行中';
    document.getElementById('owner').value = c.owner || '';
    document.getElementById('department').value = c.department || '';
    document.getElementById('phone').value = c.phone || '';
    document.getElementById('remarks').value = c.remarks || '';

    await populateProcurementSelect(c.procurement_id);

    const tip = document.getElementById('current_file_tip');
    if (tip) {
      if (c.file_name) {
        tip.innerHTML = `当前已存扫描件：<strong>${escapeHtml(c.file_orig_name)}</strong> (${formatFileSize(c.file_size)}) <label style="margin-left:10px;color:#dc2626;cursor:pointer;"><input type="checkbox" id="remove_file_chk"> 删除此扫描件</label>`;
      } else {
        tip.innerHTML = `<span class="text-muted">当前未上传主合同扫描件，可在下方选择文件上传</span>`;
      }
    }

    modal.classList.remove('hidden');
  } catch (e) {
    showToast('加载合同详情失败', 'error');
  }
}

function closeContractModal() {
  const modal = document.getElementById('contract_modal');
  if (modal) modal.classList.add('hidden');
}

async function submitContractForm(e) {
  if (e) e.preventDefault();
  if (isSubmittingForm) return;
  isSubmittingForm = true;

  const submitBtn = document.getElementById('contract_submit_btn');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const id = document.getElementById('contract_id').value;
    const fd = new FormData();
    fd.append('contract_no', document.getElementById('contract_no').value.trim());
    fd.append('contract_name', document.getElementById('contract_name').value.trim());
    fd.append('contract_type', document.getElementById('contract_type').value);
    fd.append('party_a', document.getElementById('party_a').value.trim());
    fd.append('party_b', document.getElementById('party_b').value.trim());
    fd.append('amount', document.getElementById('amount').value);
    fd.append('sign_date', document.getElementById('sign_date').value);
    fd.append('start_date', document.getElementById('start_date').value);
    fd.append('end_date', document.getElementById('end_date').value);
    fd.append('status', document.getElementById('status').value);
    fd.append('owner', document.getElementById('owner').value.trim());
    fd.append('department', document.getElementById('department').value.trim());
    fd.append('phone', document.getElementById('phone').value.trim());
    fd.append('remarks', document.getElementById('remarks').value.trim());
    fd.append('procurement_id', document.getElementById('contract_procurement_id')?.value || '');

    const removeChk = document.getElementById('remove_file_chk');
    if (removeChk && removeChk.checked) {
      fd.append('remove_file', '1');
    }

    const scanInput = document.getElementById('scan_file');
    if (scanInput && scanInput.files[0]) {
      fd.append('scan_file', scanInput.files[0]);
    }

    const relInput = document.getElementById('related_files');
    if (relInput && relInput.files.length > 0) {
      for (const f of relInput.files) {
        fd.append('related_files', f);
      }
    }

    const url = id ? `/api/contracts/${id}` : '/api/contracts';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, { method, body: fd });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || '保存失败', 'error');
      return;
    }

    closeContractModal();
    await loadContractNoRule();
    await loadContracts();
    showToast(data.message || '保存成功');
  } catch (err) {
    showToast(err.message || '网络异常，请重试', 'error');
  } finally {
    isSubmittingForm = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteContract(id, contractNo) {
  if (!confirm(`确定要彻底删除合同【${contractNo}】吗？\n删除后关联的物理扫描件与相关资料也将一并清空且不可恢复！`)) return;
  try {
    const res = await apiFetch(`/api/contracts/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '删除失败', 'error');
      return;
    }
    await loadContractNoRule();
    await loadContracts();
    showToast('🗑️ 合同及附件已彻底删除');
  } catch (e) {
    showToast('删除请求失败', 'error');
  }
}

// ==================== 7. 合同详情弹窗、在线预览与DOM句柄即时释放 ====================
async function openDetailModal(id) {
  activeDetailContractId = id;
  try {
    const res = await apiFetch(`/api/contracts/${id}`);
    const json = await res.json();
    if (!json.success) return;
    const c = json.data;

    const infoBox = document.getElementById('detail_info_grid');
    if (infoBox) {
      const procHtml = c.linked_procurement_no
        ? `<span class="badge badge-proc" style="cursor:pointer" onclick="closeDetailModal();openProcDetailModal(${c.procurement_id})">🔗 ${escapeHtml(c.linked_procurement_no)} (${escapeHtml(c.linked_project_name || '')})</span>`
        : '未关联采购立项';
      infoBox.innerHTML = `
        <div><strong>年度序号：</strong>${escapeHtml(c.seq_no)}</div>
        <div><strong>合同编号：</strong>${escapeHtml(c.contract_no)}</div>
        <div><strong>合同名称：</strong>${escapeHtml(c.contract_name)}</div>
        <div><strong>合同类型：</strong>${escapeHtml(c.contract_type || '-')}</div>
        <div><strong>甲方单位：</strong>${escapeHtml(c.party_a)}</div>
        <div><strong>乙方单位：</strong>${escapeHtml(c.party_b)}</div>
        <div><strong>合同金额：</strong><span class="amount-cell">${formatMoney(c.amount)}</span></div>
        <div><strong>签订日期：</strong>${escapeHtml(c.sign_date)}</div>
        <div><strong>履行期限：</strong>${escapeHtml(c.start_date || '-')} 至 ${escapeHtml(c.end_date || '-')}</div>
        <div><strong>当前状态：</strong>${escapeHtml(c.status)}</div>
        <div><strong>负责人/部门：</strong>${escapeHtml(c.owner || '-')} / ${escapeHtml(c.department || '-')}</div>
        <div><strong>关联采购立项：</strong>${procHtml}</div>
        <div style="grid-column: 1 / -1;"><strong>备注说明：</strong>${escapeHtml(c.remarks || '无')}</div>
      `;
    }

    renderMainScanSection(c);
    renderRelatedFilesSection(c.id, c.related_files || []);

    const modal = document.getElementById('detail_modal');
    if (modal) modal.classList.remove('hidden');
  } catch (e) {
    showToast('获取详情失败', 'error');
  }
}

function renderMainScanSection(c) {
  const container = document.getElementById('preview_container');
  const actionWrap = document.getElementById('main_scan_actions');
  if (!container) return;

  if (!c.file_name) {
    if (actionWrap) actionWrap.innerHTML = '';
    container.innerHTML = `
      <div class="empty-preview-box">
        <p>⚠️ 该合同尚未上传主合同扫描件</p>
        <label class="btn btn-primary" style="cursor:pointer;display:inline-block;margin-top:8px;">
          📤 立即上传主合同扫描件
          <input type="file" style="display:none" onchange="uploadQuickScanFile(${c.id}, this)">
        </label>
      </div>
    `;
    return;
  }

  const fileUrl = appendTokenToUrl(`/uploads/${c.file_name}`);
  if (actionWrap) {
    actionWrap.innerHTML = `
      <a class="btn btn-secondary btn-sm" href="${fileUrl}" download="${escapeHtml(c.file_orig_name || '合同扫描件')}">⬇️ 下载扫描件 (${escapeHtml(c.file_orig_name)})</a>
      <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin-left:8px;">
        🔄 替换扫描件
        <input type="file" style="display:none" onchange="uploadQuickScanFile(${c.id}, this)">
      </label>
    `;
  }

  renderFilePreviewIntoContainer(container, fileUrl, c.file_orig_name || c.file_name);
}

function renderFilePreviewIntoContainer(container, fileUrl, fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    container.innerHTML = `<iframe src="${fileUrl}" class="pdf-preview-frame" title="PDF预览"></iframe>`;
  } else if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
    container.innerHTML = `<div class="img-preview-wrap"><img src="${fileUrl}" alt="${escapeHtml(fileName)}" class="preview-img"></div>`;
  } else {
    container.innerHTML = `
      <div class="empty-preview-box">
        <p>📄 文件 <strong>${escapeHtml(fileName)}</strong> 为 Office/压缩包格式，请点击下载查看</p>
        <a class="btn btn-primary" href="${fileUrl}" download="${escapeHtml(fileName)}" style="margin-top:10px;display:inline-block;">⬇️ 立即下载该文件</a>
      </div>
    `;
  }
}

function renderRelatedFilesSection(contractId, files) {
  const listEl = document.getElementById('related_files_list');
  if (!listEl) return;
  if (!Array.isArray(files) || files.length === 0) {
    listEl.innerHTML = `<div class="text-muted" style="padding:8px 0;">暂无其他相关资料（可点击右上角“+ 追加上传相关资料”上传廉洁协议、补充协议、验收单等）</div>`;
    return;
  }
  listEl.innerHTML = files.map(f => {
    const url = appendTokenToUrl(`/uploads/${f.file_name}`);
    return `
      <div class="attachment-row">
        <div class="attachment-info">
          <span class="attachment-name" onclick="previewAttachmentInContractModal('${escapeHtml(url)}', '${escapeHtml(f.file_orig_name)}')">📎 ${escapeHtml(f.file_orig_name)}</span>
          <span class="attachment-meta">(${formatFileSize(f.file_size)} · ${escapeHtml(f.uploaded_at || '')})</span>
        </div>
        <div class="attachment-btns">
          <button class="btn-link" onclick="previewAttachmentInContractModal('${escapeHtml(url)}', '${escapeHtml(f.file_orig_name)}')">预览</button>
          <a class="btn-link" href="${url}" download="${escapeHtml(f.file_orig_name)}">下载</a>
          <button class="btn-link btn-danger-link" onclick="deleteRelatedFile(${contractId}, '${escapeHtml(f.id)}', '${escapeHtml(f.file_orig_name)}')">删除</button>
        </div>
      </div>
    `;
  }).join('');
}

function previewAttachmentInContractModal(fileUrl, origName) {
  const container = document.getElementById('preview_container');
  if (!container) return;
  renderFilePreviewIntoContainer(container, fileUrl, origName);
}

async function uploadQuickScanFile(contractId, inputEl) {
  if (!inputEl || !inputEl.files[0] || isUploadingDetail) return;
  isUploadingDetail = true;
  const fd = new FormData();
  fd.append('scan_file', inputEl.files[0]);
  try {
    const res = await apiFetch(`/api/contracts/${contractId}/upload-scan`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '上传失败', 'error');
      return;
    }
    showToast('✅ 主合同扫描件已更新');
    await openDetailModal(contractId);
    await loadContracts();
  } catch (e) {
    showToast('上传异常', 'error');
  } finally {
    isUploadingDetail = false;
    inputEl.value = '';
  }
}

async function uploadMoreRelatedFiles(inputEl) {
  if (!inputEl || !inputEl.files.length || !activeDetailContractId || isUploadingDetail) return;
  isUploadingDetail = true;
  const fd = new FormData();
  for (const f of inputEl.files) fd.append('related_files', f);
  try {
    const res = await apiFetch(`/api/contracts/${activeDetailContractId}/related-files`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '上传失败', 'error');
      return;
    }
    showToast(data.message || '相关资料已追加');
    renderRelatedFilesSection(activeDetailContractId, data.related_files || []);
    await loadContracts();
  } catch (e) {
    showToast('上传失败', 'error');
  } finally {
    isUploadingDetail = false;
    inputEl.value = '';
  }
}

async function deleteRelatedFile(contractId, fileId, origName) {
  if (!confirm(`确定要物理删除附件【${origName}】吗？`)) return;
  try {
    const res = await apiFetch(`/api/contracts/${contractId}/related-files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '删除失败', 'error');
      return;
    }
    showToast('🗑️ 附件已删除');
    renderRelatedFilesSection(contractId, data.related_files || []);
    await loadContracts();
  } catch (e) {
    showToast('删除失败', 'error');
  }
}

function closeDetailModal() {
  const modal = document.getElementById('detail_modal');
  if (modal) modal.classList.add('hidden');
  // 强制销毁 PDF <iframe> 与高清图片 DOM 句柄，100% 释放浏览器内存
  const previewContainer = document.getElementById('preview_container');
  if (previewContainer) previewContainer.innerHTML = '';
  activeDetailContractId = null;
}

// ==================== 8. 采购立项列表、增删改与一键转合同 ====================
function buildProcQueryParams() {
  const params = new URLSearchParams();
  const kw = document.getElementById('proc_search_keyword')?.value?.trim() || '';
  const st = document.getElementById('proc_filter_status')?.value || '';
  const pt = document.getElementById('proc_filter_type')?.value || '';
  const sd = document.getElementById('proc_filter_start_date')?.value || '';
  const ed = document.getElementById('proc_filter_end_date')?.value || '';
  if (kw) params.set('keyword', kw);
  if (st) params.set('status', st);
  if (pt) params.set('procurement_type', pt);
  if (sd) params.set('start_date', sd);
  if (ed) params.set('end_date', ed);
  return params;
}

async function loadProcurements() {
  try {
    const q = buildProcQueryParams();
    const res = await apiFetch(`/api/procurements?${q.toString()}`);
    const json = await res.json();
    if (!json.success) return;

    if (json.stats) {
      const elTotal = document.getElementById('proc_stat_total');
      const elBudget = document.getElementById('proc_stat_budget');
      const elFinal = document.getElementById('proc_stat_final');
      const elLinked = document.getElementById('proc_stat_linked');
      if (elTotal) elTotal.textContent = json.stats.total_count || 0;
      if (elBudget) elBudget.textContent = formatMoney(json.stats.total_budget || 0);
      if (elFinal) elFinal.textContent = formatMoney(json.stats.total_final || 0);
      if (elLinked) elLinked.textContent = json.stats.linked_count || 0;
    }

    const tbody = document.getElementById('proc_tbody');
    if (!tbody) return;
    const list = json.data || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" class="empty-cell">暂无符合条件的采购立项记录</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(row => {
      const fCount = Array.isArray(row.files) ? row.files.length : 0;
      const fileBadge = fCount > 0
        ? `<span class="badge badge-file" onclick="openProcDetailModal(${row.id})">📁 立项资料(${fCount})</span>`
        : `<span class="badge badge-nofile" onclick="openProcDetailModal(${row.id})">➕ 待传资料</span>`;

      const contractBadge = row.linked_contract_no
        ? `<span class="badge badge-proc" onclick="openDetailModal(${row.contract_id})" title="${escapeHtml(row.linked_contract_name || '')}">📄 ${escapeHtml(row.linked_contract_no)}</span>`
        : `<button class="btn-tiny-convert" onclick='convertProcToContract(${JSON.stringify({
            id: row.id,
            project_name: row.project_name,
            supplier: row.supplier,
            budget_amount: row.budget_amount,
            final_amount: row.final_amount,
            department: row.department,
            applicant: row.applicant,
            phone: row.phone
          }).replace(/'/g, "&#39;")})'>⚡ 一键转合同</button>`;

      return `
        <tr>
          <td class="mono-cell">${escapeHtml(row.seq_no)}</td>
          <td class="mono-cell bold-cell">${escapeHtml(row.procurement_no)}</td>
          <td>
            <div class="title-link" onclick="openProcDetailModal(${row.id})">${escapeHtml(row.project_name)}</div>
            <span class="sub-tag">${escapeHtml(row.procurement_type || '')} · ${escapeHtml(row.procurement_method || '')}</span>
          </td>
          <td class="amount-cell">${formatMoney(row.budget_amount)}</td>
          <td class="amount-cell">${row.final_amount > 0 ? formatMoney(row.final_amount) : '-'}</td>
          <td>${escapeHtml(row.approval_date)}</td>
          <td>${escapeHtml(row.department || '-')}<div class="sub-text">${escapeHtml(row.applicant || '')}</div></td>
          <td>${escapeHtml(row.supplier || '-')}</td>
          <td>${contractBadge}</td>
          <td>${fileBadge}</td>
          <td class="action-cell">
            <button class="btn-link" onclick="openProcDetailModal(${row.id})">资料/详情</button>
            <button class="btn-link" onclick="openEditProcModal(${row.id})">编辑</button>
            <button class="btn-link btn-danger-link" onclick="deleteProcurement(${row.id}, '${escapeHtml(row.procurement_no)}')">删除</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {}
}

function resetProcFilters() {
  ['proc_search_keyword', 'proc_filter_status', 'proc_filter_type', 'proc_filter_start_date', 'proc_filter_end_date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  loadProcurements();
}

function convertProcToContract(procObj) {
  switchModule('contracts');
  setTimeout(() => {
    openCreateModal(procObj);
  }, 80);
}

async function populateContractSelectForProc(selectedContractId = null) {
  const sel = document.getElementById('proc_contract_id');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/contracts/simple-list');
    const json = await res.json();
    const list = json.data || [];
    let html = `<option value="">-- 暂不关联合同（待后续签订） --</option>`;
    for (const c of list) {
      const isSelected = selectedContractId && Number(selectedContractId) === Number(c.id);
      const occupiedNote = (c.linked_procurement_no && !isSelected) ? ` [已绑:${c.linked_procurement_no}]` : '';
      html += `<option value="${c.id}" ${isSelected ? 'selected' : ''}>${escapeHtml(c.contract_no)} - ${escapeHtml(c.contract_name)} (${formatMoney(c.amount)})${escapeHtml(occupiedNote)}</option>`;
    }
    sel.innerHTML = html;
  } catch (e) {}
}

async function openCreateProcModal() {
  const modal = document.getElementById('proc_modal');
  const form = document.getElementById('proc_form');
  if (!modal || !form) return;
  form.reset();
  document.getElementById('proc_id').value = '';
  document.getElementById('proc_modal_title').textContent = '新增采购立项';
  document.getElementById('proc_approval_date').value = new Date().toISOString().slice(0, 10);
  const segMid = document.getElementById('proc_seg_mid');
  if (segMid) segMid.value = '';

  await populateContractSelectForProc(null);
  await refreshFormNextProcNo();
  modal.classList.remove('hidden');
}

async function openEditProcModal(id) {
  try {
    const res = await apiFetch(`/api/procurements/${id}`);
    const json = await res.json();
    if (!json.success) return;
    const p = json.data;

    const modal = document.getElementById('proc_modal');
    const form = document.getElementById('proc_form');
    form.reset();

    document.getElementById('proc_id').value = p.id;
    document.getElementById('proc_modal_title').textContent = `编辑采购立项：${p.procurement_no}`;
    document.getElementById('procurement_no').value = p.procurement_no || '';
    document.getElementById('project_name').value = p.project_name || '';
    document.getElementById('procurement_type').value = p.procurement_type || '货物类';
    document.getElementById('procurement_method').value = p.procurement_method || '询价采购';
    document.getElementById('budget_amount').value = p.budget_amount ?? 0;
    document.getElementById('final_amount').value = p.final_amount ?? 0;
    document.getElementById('proc_approval_date').value = p.approval_date || '';
    document.getElementById('proc_status').value = p.status || '立项审批中';
    document.getElementById('proc_department').value = p.department || '';
    document.getElementById('proc_applicant').value = p.applicant || '';
    document.getElementById('proc_phone').value = p.phone || '';
    document.getElementById('proc_supplier').value = p.supplier || '';
    document.getElementById('proc_remarks').value = p.remarks || '';

    await populateContractSelectForProc(p.contract_id);
    modal.classList.remove('hidden');
  } catch (e) {
    showToast('加载采购立项失败', 'error');
  }
}

function closeProcModal() {
  const modal = document.getElementById('proc_modal');
  if (modal) modal.classList.add('hidden');
}

async function submitProcForm(e) {
  if (e) e.preventDefault();
  if (isSubmittingForm) return;
  isSubmittingForm = true;

  const btn = document.getElementById('proc_submit_btn');
  if (btn) btn.disabled = true;

  try {
    const id = document.getElementById('proc_id').value;
    const fd = new FormData();
    fd.append('procurement_no', document.getElementById('procurement_no').value.trim());
    fd.append('project_name', document.getElementById('project_name').value.trim());
    fd.append('procurement_type', document.getElementById('procurement_type').value);
    fd.append('procurement_method', document.getElementById('procurement_method').value);
    fd.append('budget_amount', document.getElementById('budget_amount').value);
    fd.append('final_amount', document.getElementById('final_amount').value || 0);
    fd.append('approval_date', document.getElementById('proc_approval_date').value);
    fd.append('status', document.getElementById('proc_status').value);
    fd.append('department', document.getElementById('proc_department').value.trim());
    fd.append('applicant', document.getElementById('proc_applicant').value.trim());
    fd.append('phone', document.getElementById('proc_phone').value.trim());
    fd.append('supplier', document.getElementById('proc_supplier').value.trim());
    fd.append('remarks', document.getElementById('proc_remarks').value.trim());
    fd.append('contract_id', document.getElementById('proc_contract_id')?.value || '');

    const fileInput = document.getElementById('proc_files');
    if (fileInput && fileInput.files.length > 0) {
      for (const f of fileInput.files) fd.append('proc_files', f);
    }

    const url = id ? `/api/procurements/${id}` : '/api/procurements';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, { method, body: fd });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || '保存失败', 'error');
      return;
    }

    closeProcModal();
    await loadProcNoRule();
    await loadProcurements();
    showToast(data.message || '保存成功');
  } catch (err) {
    showToast(err.message || '网络错误', 'error');
  } finally {
    isSubmittingForm = false;
    if (btn) btn.disabled = false;
  }
}

async function deleteProcurement(id, procNo) {
  if (!confirm(`确定要彻底删除采购立项【${procNo}】吗？\n删除后立项文件夹下的所有附件也将同步物理清除！`)) return;
  try {
    const res = await apiFetch(`/api/procurements/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '删除失败', 'error');
      return;
    }
    await loadProcNoRule();
    await loadProcurements();
    showToast('🗑️ 采购立项及附件已彻底删除');
  } catch (e) {
    showToast('删除失败', 'error');
  }
}

// ==================== 9. 采购立项详情与附件管理弹窗 ====================
async function openProcDetailModal(id) {
  activeDetailProcId = id;
  try {
    const res = await apiFetch(`/api/procurements/${id}`);
    const json = await res.json();
    if (!json.success) return;
    const p = json.data;

    const infoGrid = document.getElementById('proc_detail_info_grid');
    if (infoGrid) {
      const cLink = p.linked_contract_no
        ? `<span class="badge badge-proc" style="cursor:pointer" onclick="closeProcDetailModal();openDetailModal(${p.contract_id})">📄 ${escapeHtml(p.linked_contract_no)} (${escapeHtml(p.linked_contract_name || '')})</span>`
        : '尚未关联转合同';
      infoGrid.innerHTML = `
        <div><strong>立项序号：</strong>${escapeHtml(p.seq_no)}</div>
        <div><strong>立项编号：</strong>${escapeHtml(p.procurement_no)}</div>
        <div><strong>项目名称：</strong>${escapeHtml(p.project_name)}</div>
        <div><strong>类型/方式：</strong>${escapeHtml(p.procurement_type)} / ${escapeHtml(p.procurement_method)}</div>
        <div><strong>预算金额：</strong><span class="amount-cell">${formatMoney(p.budget_amount)}</span></div>
        <div><strong>成交金额：</strong><span class="amount-cell">${formatMoney(p.final_amount)}</span></div>
        <div><strong>批准日期：</strong>${escapeHtml(p.approval_date)}</div>
        <div><strong>当前状态：</strong>${escapeHtml(p.status)}</div>
        <div><strong>申请部门/人：</strong>${escapeHtml(p.department || '-')} / ${escapeHtml(p.applicant || '-')}</div>
        <div><strong>供应商：</strong>${escapeHtml(p.supplier || '-')}</div>
        <div style="grid-column: 1 / -1;"><strong>关联合同：</strong>${cLink}</div>
        <div style="grid-column: 1 / -1;"><strong>备注说明：</strong>${escapeHtml(p.remarks || '无')}</div>
      `;
    }

    renderProcFilesList(p.id, p.files || []);
    const modal = document.getElementById('proc_detail_modal');
    if (modal) modal.classList.remove('hidden');
  } catch (e) {
    showToast('获取立项详情失败', 'error');
  }
}

function renderProcFilesList(procId, files) {
  const listEl = document.getElementById('proc_files_list');
  const previewBox = document.getElementById('proc_preview_container');
  if (!listEl) return;

  if (!Array.isArray(files) || files.length === 0) {
    listEl.innerHTML = `<div class="text-muted" style="padding:8px 0;">暂未上传立项附件（可点击右上角“+ 追加上传立项资料”上传审批表、询价单、比价纪要等）</div>`;
    if (previewBox) previewBox.innerHTML = `<div class="empty-preview-box"><p>暂无可预览的立项附件</p></div>`;
    return;
  }

  listEl.innerHTML = files.map(f => {
    const url = appendTokenToUrl(`/uploads/${f.file_name}`);
    return `
      <div class="attachment-row">
        <div class="attachment-info">
          <span class="attachment-name" onclick="previewFileInProcModal('${escapeHtml(url)}', '${escapeHtml(f.file_orig_name)}')">📎 ${escapeHtml(f.file_orig_name)}</span>
          <span class="attachment-meta">(${formatFileSize(f.file_size)} · ${escapeHtml(f.uploaded_at || '')})</span>
        </div>
        <div class="attachment-btns">
          <button class="btn-link" onclick="previewFileInProcModal('${escapeHtml(url)}', '${escapeHtml(f.file_orig_name)}')">预览</button>
          <a class="btn-link" href="${url}" download="${escapeHtml(f.file_orig_name)}">下载</a>
          <button class="btn-link btn-danger-link" onclick="deleteProcFile(${procId}, '${escapeHtml(f.id)}', '${escapeHtml(f.file_orig_name)}')">删除</button>
        </div>
      </div>
    `;
  }).join('');

  // 默认自动预览第一份文件
  const firstUrl = appendTokenToUrl(`/uploads/${files[0].file_name}`);
  previewFileInProcModal(firstUrl, files[0].file_orig_name);
}

function previewFileInProcModal(url, origName) {
  const previewBox = document.getElementById('proc_preview_container');
  if (!previewBox) return;
  renderFilePreviewIntoContainer(previewBox, url, origName);
}

async function uploadMoreProcFiles(inputEl) {
  if (!inputEl || !inputEl.files.length || !activeDetailProcId || isUploadingDetail) return;
  isUploadingDetail = true;
  const fd = new FormData();
  for (const f of inputEl.files) fd.append('proc_files', f);
  try {
    const res = await apiFetch(`/api/procurements/${activeDetailProcId}/files`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '上传失败', 'error');
      return;
    }
    showToast(data.message || '立项资料上传成功');
    renderProcFilesList(activeDetailProcId, data.files || []);
    await loadProcurements();
  } catch (e) {
    showToast('上传失败', 'error');
  } finally {
    isUploadingDetail = false;
    inputEl.value = '';
  }
}

async function deleteProcFile(procId, fileId, origName) {
  if (!confirm(`确定要物理删除立项资料【${origName}】吗？`)) return;
  try {
    const res = await apiFetch(`/api/procurements/${procId}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || '删除失败', 'error');
      return;
    }
    showToast('🗑️ 立项附件已物理删除');
    renderProcFilesList(procId, data.files || []);
    await loadProcurements();
  } catch (e) {
    showToast('删除失败', 'error');
  }
}

function closeProcDetailModal() {
  const modal = document.getElementById('proc_detail_modal');
  if (modal) modal.classList.add('hidden');
  // 强制清空立项预览 DOM 节点，释放内存
  const previewBox = document.getElementById('proc_preview_container');
  if (previewBox) previewBox.innerHTML = '';
  activeDetailProcId = null;
}

// ==================== 10. Excel 导出下载 ====================
function exportContractsExcel() {
  const q = buildContractQueryParams();
  window.location.href = appendTokenToUrl(`/api/contracts/export?${q.toString()}`);
}

function exportProcurementsExcel() {
  const q = buildProcQueryParams();
  window.location.href = appendTokenToUrl(`/api/procurements/export?${q.toString()}`);
}

function exportCombinedExcel() {
  window.location.href = appendTokenToUrl(`/api/export/combined`);
}

// ==================== 11. 多机局域网协同：智能避让静默同步引擎 ====================
function isAnyModalOpen() {
  const modalIds = [
    'lan_auth_overlay',
    'contract_modal',
    'detail_modal',
    'rule_modal',
    'proc_modal',
    'proc_detail_modal',
    'proc_rule_modal',
    'password_modal'
  ];
  for (const id of modalIds) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) return true;
  }
  return false;
}

async function silentSyncMultiClientData() {
  // 防重入锁 + 弹窗保护：若正在同步、正在提交表单、或者正打开任何弹窗/锁屏，则静默跳过，绝不打断用户操作或叠加请求
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

// ==================== 12. 页面初始化与全局快捷键 ====================
async function initAppData() {
  await loadSystemInfo();
  await loadContractNoRule();
  await loadProcNoRule();
  await loadContracts();
}

window.addEventListener('DOMContentLoaded', async () => {
  const authed = await checkAuthStatus();
  if (authed) {
    await initAppData();
  }

  // 搜索框输入防抖绑定
  const cSearch = document.getElementById('search_keyword');
  if (cSearch) cSearch.addEventListener('input', () => triggerSearchDebounce('contracts'));

  const pSearch = document.getElementById('proc_search_keyword');
  if (pSearch) pSearch.addEventListener('input', () => triggerSearchDebounce('procurement'));

  // ESC 键快速关闭顶层弹窗并释放预览内存
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDetailModal();
      closeProcDetailModal();
      closeContractModal();
      closeProcModal();
      closeRuleModal();
      closeProcRuleModal();
      closePasswordModal();
    }
  });

  // 多机协同 1：当用户从微信/WPS切回浏览器窗口时，立即静默同步最新台账与最新编号
  window.addEventListener('focus', () => {
    silentSyncMultiClientData();
  });

  // 多机协同 2：每 30 秒在后台静默同步一次列表（页面可见且无弹窗打开时触发）
  setInterval(() => {
    if (!document.hidden) {
      silentSyncMultiClientData();
    }
  }, 30000);
});
