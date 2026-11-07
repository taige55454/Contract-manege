let currentModule = 'contract'; // 'contract' | 'procurement'
let currentContracts = [];
let currentProcurements = [];
let linkingOptions = { contracts: [], procurements: [] };
let defaultOurEntity = '';
let isFreeContractNoMode = false;
let isFreeProcNoMode = false;
let isSubmittingForm = false;
let isUploadingDetail = false;
let hostLanInfo = null;

let contractNoRule = {
  prefix: 'XSZY-黔-BJ-',
  default_mid: '',
  date_part: 'YYYYMM',
  seq_digits: 3,
  suffix: '',
  reset_yearly: true
};

let procNoRule = {
  prefix: 'LX',
  default_mid: '',
  date_part: 'YYYYMMDD',
  seq_digits: 3,
  suffix: '',
  reset_yearly: true
};

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    showLanAuthOverlay('内网访问口令已更新或会话已过期，请重新输入验证口令');
  }
  return res;
}

function getLocalTodayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function encodeFilePathForUrl(relPath) {
  if (!relPath) return '';
  return String(relPath)
    .replace(/\\/g, '/')
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

function fmtMoney(val) {
  if (val === null || val === undefined || val === '') return '-';
  const num = Number(val);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
}

// ==================== 顶部模块切换 & 一键同时导出双子表总台账 ====================

async function switchModuleTab(moduleName) {
  currentModule = moduleName;
  const tabContract = document.getElementById('tab_btn_contract');
  const tabProc = document.getElementById('tab_btn_procurement');
  const viewContract = document.getElementById('view_contract');
  const viewProc = document.getElementById('view_procurement');
  const hdrContract = document.getElementById('header_group_contract');
  const hdrProc = document.getElementById('header_group_procurement');

  if (moduleName === 'procurement') {
    tabContract.classList.remove('active');
    tabProc.classList.add('active');
    viewContract.classList.add('hidden');
    viewProc.classList.remove('hidden');
    hdrContract.classList.add('hidden');
    hdrProc.classList.remove('hidden');
    await loadProcNoRule();
    await loadProcurements();
  } else {
    tabProc.classList.remove('active');
    tabContract.classList.add('active');
    viewProc.classList.add('hidden');
    viewContract.classList.remove('hidden');
    hdrProc.classList.add('hidden');
    hdrContract.classList.remove('hidden');
    await loadContractNoRule();
    await loadContracts();
  }
}

function exportCombinedWorkbook() {
  window.location.href = '/api/export/combined';
}

async function fetchLinkingOptions() {
  try {
    const res = await apiFetch('/api/options/linking');
    if (res.status === 401) return;
    const result = await res.json();
    if (result.success) {
      linkingOptions = {
        contracts: result.contracts || [],
        procurements: result.procurements || []
      };
    }
  } catch (e) {}
}

// ==================== 内网口令鉴权与本机安全控制逻辑 ====================

function showLanAuthOverlay(errorMsg = '') {
  const overlay = document.getElementById('lan_auth_overlay');
  const errBox = document.getElementById('lan_auth_error');
  overlay.classList.remove('hidden');
  if (errorMsg) {
    errBox.innerText = errorMsg;
    errBox.classList.remove('hidden');
  } else {
    errBox.classList.add('hidden');
  }
  setTimeout(() => {
    const input = document.getElementById('lan_auth_passcode_input');
    if (input) input.focus();
  }, 50);
}

function hideLanAuthOverlay() {
  document.getElementById('lan_auth_overlay').classList.add('hidden');
  document.getElementById('lan_auth_error').classList.add('hidden');
  document.getElementById('lan_auth_passcode_input').value = '';
}

function updateHostLanBarUI(lanInfo) {
  hostLanInfo = lanInfo;
  const bar = document.getElementById('host_lan_bar');
  const statusEl = document.getElementById('display_lan_status');
  if (!lanInfo) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  if (lanInfo.enabled) {
    statusEl.innerText = `已开启 (口令: ${lanInfo.passcode} | 端口: ${lanInfo.port})`;
    statusEl.style.color = '#166534';
  } else {
    statusEl.innerText = '已关闭内网访问';
    statusEl.style.color = '#dc2626';
  }
}

async function checkAuthAndInitApp() {
  try {
    const res = await fetch('/api/auth/status');
    const result = await res.json();

    if (result.is_localhost) {
      hideLanAuthOverlay();
      document.getElementById('btn_lan_logout').classList.add('hidden');
      updateHostLanBarUI(result.lan_info);
      await loadContractNoRule();
      await loadProcNoRule();
      await loadDefaultOurEntity();
      await loadContracts();
      return;
    }

    document.getElementById('host_lan_bar').classList.add('hidden');
    if (result.authenticated) {
      hideLanAuthOverlay();
      document.getElementById('btn_lan_logout').classList.remove('hidden');
      await loadContractNoRule();
      await loadProcNoRule();
      await loadDefaultOurEntity();
      await loadContracts();
    } else {
      const msg = result.lan_enabled === false
        ? '主机管理员当前已关闭内网共享访问权限'
        : '';
      showLanAuthOverlay(msg);
    }
  } catch (err) {
    console.error('鉴权检查失败:', err);
  }
}

async function submitLanAuthForm(e) {
  e.preventDefault();
  const input = document.getElementById('lan_auth_passcode_input');
  const btn = document.getElementById('btn_lan_login');
  const passcode = input.value.trim();
  if (!passcode) return;

  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode })
    });
    const result = await res.json();
    if (!result.success) {
      showLanAuthOverlay(result.message || '口令验证失败');
      return;
    }
    hideLanAuthOverlay();
    document.getElementById('btn_lan_logout').classList.remove('hidden');
    await loadContractNoRule();
    await loadProcNoRule();
    await loadDefaultOurEntity();
    if (currentModule === 'procurement') {
      await loadProcurements();
    } else {
      await loadContracts();
    }
  } catch (err) {
    showLanAuthOverlay('网络请求异常，请重试');
  } finally {
    btn.disabled = false;
  }
}

async function logoutLanSession() {
  await fetch('/api/auth/logout', { method: 'POST' });
  currentContracts = [];
  currentProcurements = [];
  document.getElementById('contract_tbody').innerHTML = '';
  document.getElementById('procurement_tbody').innerHTML = '';
  document.getElementById('btn_lan_logout').classList.add('hidden');
  showLanAuthOverlay('您已安全锁定并退出当前内网会话');
}

function openLanSecurityModal() {
  if (!hostLanInfo) return;
  document.getElementById('lan_enabled_checkbox').checked = hostLanInfo.enabled !== false;
  document.getElementById('lan_passcode_input').value = hostLanInfo.passcode || '888888';
  const urlsHtml = (hostLanInfo.lan_urls || []).map(u => `<div>🌐 ${escapeHtml(u)}</div>`).join('');
  document.getElementById('lan_urls_box').innerHTML = urlsHtml || '未检测到局域网网卡';
  document.getElementById('lan_security_modal').classList.remove('hidden');
}

function closeLanSecurityModal() {
  document.getElementById('lan_security_modal').classList.add('hidden');
}

async function saveLanSecurityForm(e) {
  e.preventDefault();
  const enabled = document.getElementById('lan_enabled_checkbox').checked;
  const passcode = document.getElementById('lan_passcode_input').value.trim();
  if (passcode.length < 4) return alert('验证口令至少需要 4 位字符！');

  const res = await apiFetch('/api/settings/lan-security', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, passcode })
  });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  updateHostLanBarUI(result.lan_info);
  openLanSecurityModal();
  alert('✅ ' + result.message);
}

function copyLanInviteText() {
  if (!hostLanInfo) return;
  const url = (hostLanInfo.lan_urls && hostLanInfo.lan_urls[0]) || '';
  const code = document.getElementById('lan_passcode_input').value.trim() || hostLanInfo.passcode;
  const text = `【企业合同与采购台账系统 - 内网协同访问】\n访问网址（本次随机端口）：${url}\n验证口令：${code}\n（电脑或手机连同一Wi-Fi均可打开，首次输入口令后全天免重复输入）`;
  navigator.clipboard.writeText(text).then(() => {
    alert('📋 已成功复制【内网随机端口网址 + 验证口令】！');
  }).catch(() => {
    prompt('请复制以下内网访问信息：', text);
  });
}

// ==================== 前端智能日期（含 Excel 序列号如 46099 自动识别）与智能税率 ====================

function smartParseDateClient(rawVal) {
  if (!rawVal || !String(rawVal).trim()) return '';
  const rawTrim = String(rawVal).trim();

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
  let y, m, d;

  if (/^\d{8}$/.test(s)) {
    y = parseInt(s.slice(0, 4), 10);
    m = parseInt(s.slice(4, 6), 10);
    d = parseInt(s.slice(6, 8), 10);
  } else if (/^(\d{4})-(\d{1,2})-(\d{1,2})$/.test(s)) {
    const match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    y = parseInt(match[1], 10);
    m = parseInt(match[2], 10);
    d = parseInt(match[3], 10);
  } else if (/^(\d{2})-(\d{1,2})-(\d{1,2})$/.test(s)) {
    const match = s.match(/^(\d{2})-(\d{1,2})-(\d{1,2})$/);
    y = 2000 + parseInt(match[1], 10);
    m = parseInt(match[2], 10);
    d = parseInt(match[3], 10);
  } else if (/^(\d{1,2})-(\d{1,2})$/.test(s)) {
    const match = s.match(/^(\d{1,2})-(\d{1,2})$/);
    y = currentYear;
    m = parseInt(match[1], 10);
    d = parseInt(match[2], 10);
  } else {
    return null;
  }

  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() + 1 !== m || check.getDate() !== d) return null;

  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeDateInputElem(inputEl) {
  if (!inputEl) return;
  const val = inputEl.value.trim();
  if (!val) {
    inputEl.style.borderColor = '#d1d5db';
    return;
  }
  const parsed = smartParseDateClient(val);
  if (parsed) {
    inputEl.value = parsed;
    inputEl.style.borderColor = '#d1d5db';
  } else {
    inputEl.style.borderColor = '#dc2626';
  }
}

function onSignDateBlur(inputEl) {
  normalizeDateInputElem(inputEl);
  syncStartDateDefault();
  const formId = document.getElementById('form_id').value;
  if (!formId && !isFreeContractNoMode) {
    fillAutoContractNo(inputEl.value);
  }
}

function onProcApprovalDateBlur(inputEl) {
  normalizeDateInputElem(inputEl);
  const procFormId = document.getElementById('p_form_id').value;
  if (!procFormId && !isFreeProcNoMode) {
    fillAutoProcurementNo(inputEl.value);
  }
}

function pickDateToInput(datePickerEl, targetInputId, isSignDate) {
  if (!datePickerEl.value) return;
  const target = document.getElementById(targetInputId);
  target.value = datePickerEl.value;
  target.style.borderColor = '#d1d5db';
  datePickerEl.value = '';
  if (isSignDate) {
    onSignDateBlur(target);
  }
}

function smartFormatTaxRateClient(rawVal) {
  if (!rawVal || !String(rawVal).trim()) return '';
  let str = String(rawVal).trim()
    .replace(/＊/g, '*')
    .replace(/％/g, '%')
    .replace(/[，、；;/\s]+/g, ',');

  if (str.startsWith('*')) str = str.slice(1);
  const parts = str.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  const formatted = parts.map(p => (/^\d+(\.\d+)?$/.test(p) ? `${p}%` : p));
  return formatted.length > 1 ? `*${formatted.join(',')}` : formatted[0];
}

function normalizeTaxInputElem(inputEl) {
  if (!inputEl) return;
  inputEl.value = smartFormatTaxRateClient(inputEl.value);
}

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

// ==================== 合同编号 & 采购立项编号：4 段夹心式规则设置与实时合成 ====================

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

async function loadContractNoRule() {
  try {
    const res = await apiFetch('/api/settings/contract-no-rule');
    const result = await res.json();
    if (result.success) {
      contractNoRule = result.rule;
      document.getElementById('display_no_rule').innerText = result.sample_next_no || '未设置';
    }
  } catch (e) {}
}

function updateNoRulePreview() {
  const prefix = document.getElementById('rule_prefix').value.trim();
  const mid = document.getElementById('rule_default_mid').value.trim();
  const datePart = document.getElementById('rule_date_part').value;
  const digits = Number(document.getElementById('rule_seq_digits').value || 0);
  const suffix = document.getElementById('rule_suffix').value.trim();
  const dateStr = formatClientDatePart(datePart);
  const seqStr = digits > 0 ? String(1).padStart(digits, '0') : '[补全项]';
  document.getElementById('rule_live_preview').innerText = `${prefix}${mid}${dateStr}${seqStr}${suffix}`;
}

function openNoRuleModal() {
  document.getElementById('rule_prefix').value = contractNoRule.prefix || '';
  document.getElementById('rule_default_mid').value = contractNoRule.default_mid || '';
  document.getElementById('rule_date_part').value = contractNoRule.date_part || 'YYYYMM';
  document.getElementById('rule_seq_digits').value = String(contractNoRule.seq_digits ?? 3);
  document.getElementById('rule_suffix').value = contractNoRule.suffix || '';
  document.getElementById('rule_reset_yearly').checked = contractNoRule.reset_yearly !== false;
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
    default_mid: document.getElementById('rule_default_mid').value.trim(),
    date_part: document.getElementById('rule_date_part').value,
    seq_digits: Number(document.getElementById('rule_seq_digits').value),
    suffix: document.getElementById('rule_suffix').value.trim(),
    reset_yearly: document.getElementById('rule_reset_yearly').checked
  };

  const res = await apiFetch('/api/settings/contract-no-rule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  contractNoRule = result.rule;
  document.getElementById('display_no_rule').innerText = result.sample_next_no;
  closeNoRuleModal();
  if (!document.getElementById('form_modal').classList.contains('hidden') && !document.getElementById('form_id').value) {
    await fillAutoContractNo(document.getElementById('f_sign_date').value);
  }
  await loadContracts();
}

function syncSegmentedContractNo() {
  if (isFreeContractNoMode) return;
  const prefix = document.getElementById('seg_prefix').innerText;
  const midCustom = document.getElementById('seg_mid_custom_input').value.trim();
  const dateSeg = document.getElementById('seg_date').innerText;
  const middle = document.getElementById('seg_middle_input').value.trim();
  const suffix = document.getElementById('seg_suffix').innerText;
  document.getElementById('f_contract_no').value = `${prefix}${midCustom}${dateSeg}${middle}${suffix}`;
}

function onContractMidCustomChange() {
  const signDateVal = document.getElementById('f_sign_date').value;
  const customMid = document.getElementById('seg_mid_custom_input').value.trim();
  fillAutoContractNo(signDateVal, customMid);
}

function setContractNoEditorMode(freeMode) {
  isFreeContractNoMode = freeMode;
  const segBox = document.getElementById('segmented_no_box');
  const freeInput = document.getElementById('f_contract_no');
  const hint = document.getElementById('no_mode_hint');
  const toggleBtn = document.getElementById('toggle_no_mode_btn');

  if (freeMode) {
    segBox.classList.add('hidden');
    freeInput.classList.remove('hidden');
    hint.innerText = '(纯自由手填模式)';
    toggleBtn.innerText = '🔒 切换夹心分段模式';
  } else {
    segBox.classList.remove('hidden');
    freeInput.classList.add('hidden');
    hint.innerText = '(灰底预设段中间可穿插手填)';
    toggleBtn.innerText = '✏️ 切换纯自由手填';
    syncSegmentedContractNo();
  }
}

function toggleFreeContractNoMode() {
  setContractNoEditorMode(!isFreeContractNoMode);
}

async function fillAutoContractNo(signDateVal = '', customMidOverride = null) {
  try {
    const params = new URLSearchParams();
    if (signDateVal) params.set('sign_date', signDateVal);
    if (customMidOverride !== null) params.set('mid_custom', customMidOverride);
    const res = await apiFetch(`/api/contracts/next-no?${params.toString()}`);
    const result = await res.json();
    if (result.success && result.parts) {
      const p = result.parts;
      document.getElementById('seg_prefix').innerText = p.prefix || '';
      if (customMidOverride === null) {
        document.getElementById('seg_mid_custom_input').value = p.mid_custom || '';
      }
      document.getElementById('seg_date').innerText = p.date_seg || '';
      document.getElementById('seg_middle_input').value = p.middle_default || '';
      document.getElementById('seg_suffix').innerText = p.suffix || '';
      document.getElementById('f_contract_no').value = result.next_no;
      document.getElementById('display_no_rule').innerText = result.next_no;
    }
  } catch (e) {}
}

// ---- 采购立项编号规则与 4 段夹心编号器 ----

async function loadProcNoRule() {
  try {
    const res = await apiFetch('/api/settings/procurement-no-rule');
    const result = await res.json();
    if (result.success) {
      procNoRule = result.rule;
      document.getElementById('display_proc_no_rule').innerText = result.sample_next_no || 'LX...';
    }
  } catch (e) {}
}

function updateProcNoRulePreview() {
  const prefix = document.getElementById('prule_prefix').value.trim();
  const mid = document.getElementById('prule_default_mid').value.trim();
  const datePart = document.getElementById('prule_date_part').value;
  const digits = Number(document.getElementById('prule_seq_digits').value || 0);
  const suffix = document.getElementById('prule_suffix').value.trim();
  const dateStr = formatClientDatePart(datePart);
  const seqStr = digits > 0 ? String(1).padStart(digits, '0') : '[补全项]';
  document.getElementById('prule_live_preview').innerText = `${prefix}${mid}${dateStr}${seqStr}${suffix}`;
}

function openProcNoRuleModal() {
  document.getElementById('prule_prefix').value = procNoRule.prefix || '';
  document.getElementById('prule_default_mid').value = procNoRule.default_mid || '';
  document.getElementById('prule_date_part').value = procNoRule.date_part || 'YYYYMMDD';
  document.getElementById('prule_seq_digits').value = String(procNoRule.seq_digits ?? 3);
  document.getElementById('prule_suffix').value = procNoRule.suffix || '';
  document.getElementById('prule_reset_yearly').checked = procNoRule.reset_yearly !== false;
  updateProcNoRulePreview();
  document.getElementById('proc_no_rule_modal').classList.remove('hidden');
}

function closeProcNoRuleModal() {
  document.getElementById('proc_no_rule_modal').classList.add('hidden');
}

async function saveProcNoRuleForm(e) {
  e.preventDefault();
  const payload = {
    prefix: document.getElementById('prule_prefix').value.trim(),
    default_mid: document.getElementById('prule_default_mid').value.trim(),
    date_part: document.getElementById('prule_date_part').value,
    seq_digits: Number(document.getElementById('prule_seq_digits').value),
    suffix: document.getElementById('prule_suffix').value.trim(),
    reset_yearly: document.getElementById('prule_reset_yearly').checked
  };

  const res = await apiFetch('/api/settings/procurement-no-rule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  procNoRule = result.rule;
  document.getElementById('display_proc_no_rule').innerText = result.sample_next_no;
  closeProcNoRuleModal();
  if (!document.getElementById('proc_form_modal').classList.contains('hidden') && !document.getElementById('p_form_id').value) {
    await fillAutoProcurementNo(document.getElementById('p_approval_date').value);
  }
  await loadProcurements();
}

function syncSegmentedProcNo() {
  if (isFreeProcNoMode) return;
  const prefix = document.getElementById('p_seg_prefix').innerText;
  const midCustom = document.getElementById('p_seg_mid_custom_input').value.trim();
  const dateSeg = document.getElementById('p_seg_date').innerText;
  const middle = document.getElementById('p_seg_middle_input').value.trim();
  const suffix = document.getElementById('p_seg_suffix').innerText;
  document.getElementById('p_procurement_no').value = `${prefix}${midCustom}${dateSeg}${middle}${suffix}`;
}

function onProcMidCustomChange() {
  const approvalDateVal = document.getElementById('p_approval_date').value;
  const customMid = document.getElementById('p_seg_mid_custom_input').value.trim();
  fillAutoProcurementNo(approvalDateVal, customMid);
}

function setProcNoEditorMode(freeMode) {
  isFreeProcNoMode = freeMode;
  const segBox = document.getElementById('p_segmented_no_box');
  const freeInput = document.getElementById('p_procurement_no');
  const hint = document.getElementById('p_no_mode_hint');
  const toggleBtn = document.getElementById('toggle_p_no_mode_btn');

  if (freeMode) {
    segBox.classList.add('hidden');
    freeInput.classList.remove('hidden');
    hint.innerText = '(纯自由手填模式)';
    toggleBtn.innerText = '🔒 切换夹心分段模式';
  } else {
    segBox.classList.remove('hidden');
    freeInput.classList.add('hidden');
    hint.innerText = '(灰底预设段中间可穿插手填)';
    toggleBtn.innerText = '✏️ 切换纯自由手填';
    syncSegmentedProcNo();
  }
}

function toggleFreeProcNoMode() {
  setProcNoEditorMode(!isFreeProcNoMode);
}

async function fillAutoProcurementNo(approvalDateVal = '', customMidOverride = null) {
  try {
    const params = new URLSearchParams();
    if (approvalDateVal) params.set('approval_date', approvalDateVal);
    if (customMidOverride !== null) params.set('mid_custom', customMidOverride);
    const res = await apiFetch(`/api/procurements/next-no?${params.toString()}`);
    const result = await res.json();
    if (result.success && result.parts) {
      const p = result.parts;
      document.getElementById('p_seg_prefix').innerText = p.prefix || '';
      if (customMidOverride === null) {
        document.getElementById('p_seg_mid_custom_input').value = p.mid_custom || '';
      }
      document.getElementById('p_seg_date').innerText = p.date_seg || '';
      document.getElementById('p_seg_middle_input').value = p.middle_default || '';
      document.getElementById('p_seg_suffix').innerText = p.suffix || '';
      document.getElementById('p_procurement_no').value = result.next_no;
      document.getElementById('display_proc_no_rule').innerText = result.next_no;
    }
  } catch (e) {}
}

async function loadDefaultOurEntity() {
  try {
    const res = await apiFetch('/api/settings/our-entity');
    const result = await res.json();
    if (result.success) {
      defaultOurEntity = result.default_our_entity;
      document.getElementById('display_default_entity').innerText = defaultOurEntity;
    }
  } catch (e) {}
}

function openOurEntityModal() {
  document.getElementById('modal_our_entity_input').value = defaultOurEntity;
  document.getElementById('our_entity_modal').classList.remove('hidden');
}

function closeOurEntityModal() {
  document.getElementById('our_entity_modal').classList.add('hidden');
}

async function saveOurEntityForm(e) {
  e.preventDefault();
  const newVal = document.getElementById('modal_our_entity_input').value.trim();
  if (!newVal) return alert('默认我方主体名称不能为空！');

  const res = await apiFetch('/api/settings/our-entity', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_our_entity: newVal })
  });
  const result = await res.json();
  if (!result.success) return alert(result.message);

  defaultOurEntity = result.default_our_entity;
  document.getElementById('display_default_entity').innerText = defaultOurEntity;
  closeOurEntityModal();
}

// ==================== 合同台账列表加载与渲染 ====================

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
  const fromEl = document.getElementById('filter_date_from');
  const toEl = document.getElementById('filter_date_to');
  normalizeDateInputElem(fromEl);
  normalizeDateInputElem(toEl);

  return new URLSearchParams({
    contract_no: document.getElementById('filter_no').value.trim(),
    counterparty: document.getElementById('filter_counterparty').value.trim(),
    sign_year: document.getElementById('filter_year').value,
    contract_type: document.getElementById('filter_type').value,
    status: document.getElementById('filter_status').value,
    date_field: document.getElementById('filter_date_field').value,
    date_from: fromEl.value.trim(),
    date_to: toEl.value.trim(),
    sort_by: document.getElementById('sort_by').value,
    sort_order: document.getElementById('sort_order').value
  });
}

function populateYearSelect(selectId, yearsFromDb = [], labelSuffix = '年') {
  const select = document.getElementById(selectId);
  if (!select) return;
  const currentVal = select.value;
  const curYear = new Date().getFullYear();
  const yearSet = new Set([curYear + 1, curYear, curYear - 1, curYear - 2, ...yearsFromDb]);
  const sortedYears = Array.from(yearSet).filter(Boolean).sort((a, b) => b - a);

  select.innerHTML = `<option value="">全部年份</option>` +
    sortedYears.map(y => `<option value="${y}">${y} ${labelSuffix}</option>`).join('');
  if (currentVal) select.value = currentVal;
}

async function loadContracts() {
  try {
    const params = getFilterParams();
    const res = await apiFetch(`/api/contracts?${params.toString()}`);
    if (res.status === 401) return;
    const result = await res.json();
    if (!result.success) return alert(result.message);

    currentContracts = result.data;
    populateYearSelect('filter_year', result.years || []);

    const tbody = document.getElementById('contract_tbody');
    if (currentContracts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="26" style="text-align:center;color:#6b7280;padding:28px;">暂无匹配的合同台账记录</td></tr>`;
      return;
    }

    const htmlRows = [];

    currentContracts.forEach((c, contractIndex) => {
      const parties = parseContractParties(c);
      const spanCount = parties.length;
      const groupStripeClass = (contractIndex % 2 === 1) ? 'contract-group-odd' : 'contract-group-even';
      const relatedList = Array.isArray(c.related_files) ? c.related_files : [];
      const lp = c.linked_procurement;
      const lpFilesCount = lp && Array.isArray(lp.files) ? lp.files.length : 0;

      let procCellHtml = `<span style="color:#9ca3af;font-size:12px;">未关联立项</span>`;
      if (lp) {
        procCellHtml = `
          <div style="display:flex;flex-direction:column;gap:3px;">
            <a class="proc-link-badge" onclick="openProcurementDetailModal(${lp.id})" title="点击查看采购立项详情及下载/预览立项资料：${escapeHtml(lp.project_name)}">
              📑 ${escapeHtml(lp.procurement_no)} (${lpFilesCount}份立项资料)
            </a>
            <small style="color:#6b7280;max-width:190px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(lp.project_name)}">${escapeHtml(lp.project_name)}</small>
          </div>
        `;
      }

      parties.forEach((p, idx) => {
        const isFirstRow = idx === 0;
        const isLastRow = idx === spanCount - 1;

        let perfBondHtml = '<span style="color:#9ca3af;">-</span>';
        if ((p.perf_bond_amount !== null && p.perf_bond_amount !== undefined && p.perf_bond_amount !== '') || p.perf_bond_return_date) {
          const amtStr = (p.perf_bond_amount !== null && p.perf_bond_amount !== undefined && p.perf_bond_amount !== '') ? `¥${fmtMoney(p.perf_bond_amount)} ` : '';
          const payStr = p.perf_bond_pay_date ? `<small style="color:#6b7280;">(缴:${escapeHtml(p.perf_bond_pay_date)})</small> ` : '';
          const badge = p.perf_bond_return_date ? renderDueAlertBadge(p.perf_bond_return_date, c.status, '应退') : '';
          perfBondHtml = `<div>${amtStr}${payStr}${badge}</div>`;
        }

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

        const relatedTitleTip = relatedList.map(r => r.file_name).join('\n');

        htmlRows.push(`
          <tr class="${groupStripeClass} ${isLastRow ? 'contract-group-end' : ''}">
            ${isFirstRow ? `
              <td class="text-center" rowspan="${spanCount}"><span class="seq-badge">${escapeHtml(c.seq_label || c.seq_no)}</span></td>
              <td rowspan="${spanCount}"><strong>${escapeHtml(c.contract_no)}</strong></td>
              <td rowspan="${spanCount}">${escapeHtml(c.contract_name)}</td>
              <td class="text-center" rowspan="${spanCount}">${escapeHtml(c.contract_type)}</td>
              <td rowspan="${spanCount}">${escapeHtml(c.our_entity)}</td>
              <td class="text-center" rowspan="${spanCount}">${escapeHtml(c.sign_date)}</td>
              <td class="text-center" rowspan="${spanCount}">${escapeHtml(c.start_date || c.sign_date)}</td>
              <td class="text-center" rowspan="${spanCount}">${renderDueAlertBadge(c.expiry_date, c.status)}</td>
              <td class="text-center" rowspan="${spanCount}"><span class="badge badge-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
            ` : ''}
            <td class="summary-cell" title="${escapeHtml(p.item_summary || '')}">${escapeHtml(p.item_summary || '-')}</td>
            <td><strong>${escapeHtml(p.company_name)}</strong></td>
            <td>${escapeHtml(p.credit_code)}</td>
            <td>${contactStr}</td>
            <td class="summary-cell" title="${escapeHtml(bankSummary)}">${escapeHtml(bankSummary)}</td>
            <td class="text-right"><strong>${fmtMoney(p.amount)}</strong></td>
            <td class="text-right">${fmtMoney(p.amount_excl_tax)}</td>
            <td class="text-center">${escapeHtml(p.tax_rate || '-')}</td>
            <td class="text-center">${escapeHtml(p.invoice_type || '-')}</td>
            <td class="text-center">${escapeHtml(p.currency || c.currency || 'CNY')}</td>
            <td>${perfBondHtml}</td>
            <td>${warrantyHtml}</td>
            <td class="summary-cell" title="${escapeHtml(p.remark || '')}">${escapeHtml(p.remark || '-')}</td>
            ${isFirstRow ? `
              <td rowspan="${spanCount}">
                ${c.attachment_path
                  ? `<a class="link-btn" onclick="openDetailModal(${c.id})" title="点击在线预览主合同扫描件">📎 ${escapeHtml(c.attachment_original_name)}</a>`
                  : `<span style="color:#9ca3af;">无扫描件</span>`}
              </td>
              <td rowspan="${spanCount}">${procCellHtml}</td>
              <td rowspan="${spanCount}">
                ${relatedList.length > 0
                  ? `<a class="related-badge-btn" onclick="openDetailModal(${c.id})" title="${escapeHtml(relatedTitleTip)}">📂 已归档 ${relatedList.length} 份附件</a>`
                  : `<a class="link-btn" style="color:#6b7280;font-size:12px;" onclick="openDetailModal(${c.id})">+ 上传其他附件</a>`}
              </td>
              <td class="text-center" rowspan="${spanCount}">
                <button type="button" class="btn btn-outline btn-sm" onclick="openDetailModal(${c.id})">详情 / 3类资料</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="openFormModal(${c.id})">编辑</button>
                <button type="button" class="btn btn-danger btn-sm" onclick="deleteContract(${c.id})">删除</button>
              </td>
            ` : ''}
          </tr>
        `);
      });
    });

    tbody.innerHTML = htmlRows.join('');
  } catch (err) {
    console.error('加载合同台账异常:', err);
  }
}

function resetFilters() {
  document.getElementById('filter_no').value = '';
  document.getElementById('filter_counterparty').value = '';
  document.getElementById('filter_year').value = '';
  document.getElementById('filter_type').value = '';
  document.getElementById('filter_status').value = '';
  document.getElementById('filter_date_field').value = 'sign_date';
  document.getElementById('filter_date_from').value = '';
  document.getElementById('filter_date_to').value = '';
  document.getElementById('sort_by').value = 'seq_no';
  document.getElementById('sort_order').value = 'ASC';
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

// ==================== 采购项目立项台账列表加载、新增、编辑与跨模块合同扫描件直连 ====================

function getProcurementFilterParams() {
  return new URLSearchParams({
    keyword: document.getElementById('proc_filter_kw').value.trim(),
    year: document.getElementById('proc_filter_year').value,
    project_type: document.getElementById('proc_filter_type').value,
    cost_department: document.getElementById('proc_filter_dept').value.trim(),
    has_contract: document.getElementById('proc_filter_has_contract').value,
    sort_order: document.getElementById('proc_sort_order').value
  });
}

async function loadProcurements() {
  try {
    const params = getProcurementFilterParams();
    const res = await apiFetch(`/api/procurements?${params.toString()}`);
    if (res.status === 401) return;
    const result = await res.json();
    if (!result.success) return alert(result.message);

    currentProcurements = result.data || [];
    populateYearSelect('proc_filter_year', result.years || [], '年立项');

    const tbody = document.getElementById('procurement_tbody');
    if (currentProcurements.length === 0) {
      tbody.innerHTML = `<tr><td colspan="19" style="text-align:center;color:#6b7280;padding:28px;">暂无匹配的采购项目立项记录（可点击右上角“+ 新增采购立项”录入）</td></tr>`;
      return;
    }

    const htmlRows = currentProcurements.map((p, idx) => {
      const stripeClass = (idx % 2 === 1) ? 'proc-group-odd' : 'contract-group-even';
      const pFiles = Array.isArray(p.procurement_files) ? p.procurement_files : [];
      const lc = p.linked_contract;

      let contractCellHtml = `<span style="color:#9ca3af;">-</span>`;
      if (lc) {
        const scanBtn = lc.attachment_path
          ? `<a class="link-btn" style="font-size:12px;" onclick="openProcurementDetailModal(${p.id}, true)" title="点击直接预览或下载关联合同扫描件：${escapeHtml(lc.attachment_original_name)}">📎 查看合同扫描件</a>`
          : `<small style="color:#9ca3af;">(合同未传扫描件)</small>`;
        contractCellHtml = `
          <div style="display:flex;flex-direction:column;gap:2px;">
            <strong>${escapeHtml(lc.contract_no)}</strong>
            ${scanBtn}
          </div>
        `;
      } else if (p.contract_no_manual) {
        contractCellHtml = `
          <div title="已预填合同号，待合同台账录入同编号合同时将自动挂钩">
            <strong>${escapeHtml(p.contract_no_manual)}</strong>
            <div><small style="color:#d97706;">(待录合同扫描件)</small></div>
          </div>
        `;
      }

      const filesTip = pFiles.map(f => f.file_name).join('\n');

      return `
        <tr class="${stripeClass}">
          <td class="text-center"><span class="seq-badge">${escapeHtml(p.seq_no || (idx + 1))}</span></td>
          <td><strong>${escapeHtml(p.procurement_no)}</strong></td>
          <td><strong>${escapeHtml(p.project_name)}</strong></td>
          <td class="text-center">${escapeHtml(p.project_type || '-')}</td>
          <td class="text-center"><strong style="color:#92400e;">${escapeHtml(p.cost_department || '-')}</strong></td>
          <td class="text-right">${fmtMoney(p.budget_amount)}</td>
          <td class="text-center">${escapeHtml(p.budget_subject || '-')}</td>
          <td class="text-center">${escapeHtml(p.procurement_type || '-')}</td>
          <td class="text-center">${escapeHtml(p.procurement_method || '-')}</td>
          <td class="text-center">${escapeHtml(p.approval_date || '-')}</td>
          <td class="text-center">${escapeHtml(p.decision_date || '-')}</td>
          <td class="text-center">${escapeHtml(p.completion_date || '-')}</td>
          <td>${escapeHtml(p.supplier_name || '-')}</td>
          <td class="text-right"><strong>${fmtMoney(p.deal_amount)}</strong></td>
          <td class="text-center"><span class="badge badge-${escapeHtml(p.has_contract || '否')}">${escapeHtml(p.has_contract || '否')}</span></td>
          <td>${contractCellHtml}</td>
          <td class="summary-cell" title="${escapeHtml(p.remark || '')}">${escapeHtml(p.remark || '-')}</td>
          <td>
            ${pFiles.length > 0
              ? `<a class="proc-link-badge" onclick="openProcurementDetailModal(${p.id})" title="${escapeHtml(filesTip)}">📑 立项资料 (${pFiles.length}份)</a>`
              : `<a class="link-btn" style="color:#6b7280;font-size:12px;" onclick="openProcurementDetailModal(${p.id})">+ 上传立项资料</a>`}
          </td>
          <td class="text-center">
            <button type="button" class="btn btn-outline btn-sm" onclick="openProcurementDetailModal(${p.id})">详情 / 资料</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="openProcurementFormModal(${p.id})">编辑</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteProcurement(${p.id})">删除</button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = htmlRows.join('');
  } catch (err) {
    console.error('加载采购台账异常:', err);
  }
}

function resetProcurementFilters() {
  document.getElementById('proc_filter_kw').value = '';
  document.getElementById('proc_filter_year').value = '';
  document.getElementById('proc_filter_type').value = '';
  document.getElementById('proc_filter_dept').value = '';
  document.getElementById('proc_filter_has_contract').value = '';
  document.getElementById('proc_sort_order').value = 'ASC';
  loadProcurements();
}

function exportProcurementExcel(scope) {
  const params = getProcurementFilterParams();
  params.set('scope', scope);
  window.location.href = `/api/procurements/export?${params.toString()}`;
}

function populateContractSelectInProcForm(selectedContractId = null) {
  const select = document.getElementById('p_contract_id');
  const optionsHtml = [`<option value="">-- 暂不绑定已有合同 (或右侧直接手填合同编号) --</option>`];
  for (const c of linkingOptions.contracts) {
    const isSelected = selectedContractId && Number(selectedContractId) === Number(c.id) ? 'selected' : '';
    const boundHint = (c.procurement_id && (!selectedContractId || Number(c.id) !== Number(selectedContractId))) ? ' [已绑其他立项]' : '';
    optionsHtml.push(
      `<option value="${c.id}" data-no="${escapeHtml(c.contract_no)}" ${isSelected}>${escapeHtml(c.contract_no)}｜${escapeHtml(c.contract_name)} (${escapeHtml(c.counterparty || '')})${boundHint}</option>`
    );
  }
  select.innerHTML = optionsHtml.join('');
}

function onSelectLinkedContractInProcForm(selectEl) {
  const cid = selectEl.value;
  if (cid) {
    const found = linkingOptions.contracts.find(c => String(c.id) === String(cid));
    if (found) {
      document.getElementById('p_contract_no_manual').value = found.contract_no;
      document.getElementById('p_has_contract').value = '是';
      if (!document.getElementById('p_supplier_name').value && found.counterparty) {
        document.getElementById('p_supplier_name').value = found.counterparty;
      }
      if (!document.getElementById('p_deal_amount').value && found.amount) {
        document.getElementById('p_deal_amount').value = found.amount;
      }
    }
  }
}

function populateProcurementSelectInContractForm(selectedProcId = null) {
  const select = document.getElementById('f_procurement_id');
  const optionsHtml = [`<option value="">-- 暂不关联采购立项 (或稍后在采购台账中反向关联) --</option>`];
  for (const p of linkingOptions.procurements) {
    const isSelected = selectedProcId && Number(selectedProcId) === Number(p.id) ? 'selected' : '';
    const boundHint = (p.contract_id && (!selectedProcId || Number(p.id) !== Number(selectedProcId))) ? ' [已绑其他合同]' : '';
    optionsHtml.push(
      `<option value="${p.id}" ${isSelected}>${escapeHtml(p.procurement_no)}｜${escapeHtml(p.project_name)} (${escapeHtml(p.supplier_name || '未填供应商')})${boundHint}</option>`
    );
  }
  select.innerHTML = optionsHtml.join('');
}

function onSelectLinkedProcurementInContractForm(selectEl) {
  const pid = selectEl.value;
  if (!pid) return;
  const found = linkingOptions.procurements.find(p => String(p.id) === String(pid));
  if (!found) return;

  if (!document.getElementById('f_contract_name').value && found.project_name) {
    document.getElementById('f_contract_name').value = found.project_name;
  }
  if (found.contract_no_manual && !document.getElementById('form_id').value) {
    setContractNoEditorMode(true);
    document.getElementById('f_contract_no').value = found.contract_no_manual;
  }
}

async function openProcurementFormModal(id = null) {
  const form = document.getElementById('procurement_form');
  form.reset();
  document.getElementById('p_form_id').value = '';
  document.getElementById('p_procurement_files').value = '';

  await fetchLinkingOptions();

  if (id) {
    document.getElementById('proc_form_modal_title').innerText = '🛒 编辑采购项目立项台账';
    setProcNoEditorMode(true);
    const res = await apiFetch(`/api/procurements/${id}`);
    const result = await res.json();
    if (!result.success) return alert(result.message);
    const p = result.data;

    document.getElementById('p_form_id').value = p.id;
    document.getElementById('p_procurement_no').value = p.procurement_no;
    document.getElementById('p_project_name').value = p.project_name;
    document.getElementById('p_project_type').value = p.project_type || '服务类项目';
    document.getElementById('p_cost_department').value = p.cost_department || '';
    document.getElementById('p_budget_amount').value = p.budget_amount ?? '';
    document.getElementById('p_budget_subject').value = p.budget_subject || '';
    document.getElementById('p_procurement_type').value = p.procurement_type || '小额零星采购';
    document.getElementById('p_procurement_method').value = p.procurement_method || '合作谈判';
    document.getElementById('p_approval_date').value = p.approval_date || '';
    document.getElementById('p_decision_date').value = p.decision_date || '';
    document.getElementById('p_completion_date').value = p.completion_date || '';
    document.getElementById('p_supplier_name').value = p.supplier_name || '';
    document.getElementById('p_deal_amount').value = p.deal_amount ?? '';
    document.getElementById('p_has_contract').value = p.has_contract || '否';
    document.getElementById('p_contract_no_manual').value = p.linked_contract ? p.linked_contract.contract_no : (p.contract_no_manual || '');
    document.getElementById('p_remark').value = p.remark || '';

    populateContractSelectInProcForm(p.contract_id);
  } else {
    document.getElementById('proc_form_modal_title').innerText = '🛒 新增采购项目立项台账';
    const today = getLocalTodayStr();
    document.getElementById('p_approval_date').value = today;
    setProcNoEditorMode(false);
    await fillAutoProcurementNo(today);
    populateContractSelectInProcForm(null);
  }

  document.getElementById('proc_form_modal').classList.remove('hidden');
}

function closeProcurementFormModal() {
  document.getElementById('proc_form_modal').classList.add('hidden');
}

async function submitProcurementForm(e) {
  e.preventDefault();
  if (isSubmittingForm) return;

  if (!isFreeProcNoMode) {
    syncSegmentedProcNo();
  }

  for (const id of ['p_approval_date', 'p_decision_date', 'p_completion_date']) {
    const el = document.getElementById(id);
    if (el && el.value.trim()) {
      const parsed = smartParseDateClient(el.value);
      if (!parsed) return alert(`日期“${el.value}”格式无法识别，请检查！`);
      el.value = parsed;
    }
  }

  const pid = document.getElementById('p_form_id').value;
  const form = document.getElementById('procurement_form');
  const formData = new FormData(form);
  const submitBtn = document.getElementById('btn_submit_procurement');

  isSubmittingForm = true;
  if (submitBtn) submitBtn.disabled = true;

  try {
    const url = pid ? `/api/procurements/${pid}` : '/api/procurements';
    const method = pid ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: formData });
    const result = await res.json();
    if (!result.success) return alert(result.message);

    closeProcurementFormModal();
    await loadProcNoRule();
    if (currentModule === 'procurement') {
      await loadProcurements();
    } else {
      await loadContracts();
    }
  } catch (err) {
    alert('保存采购立项失败: ' + err.message);
  } finally {
    isSubmittingForm = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteProcurement(id) {
  if (!confirm('确定要删除该条采购立项记录吗？（将同时清理该立项专属文件夹下的资料，已关联的合同记录本身不会删除）')) return;
  const res = await apiFetch(`/api/procurements/${id}`, { method: 'DELETE' });
  const result = await res.json();
  if (!result.success) return alert(result.message);
  await loadProcNoRule();
  await loadProcurements();
}

// ==================== 对方单位动态履约卡片组件 ====================

function addCounterpartyCard(data = {}) {
  const container = document.getElementById('counterparties_container');
  const card = document.createElement('div');
  card.className = 'party-card';

  const currencyVal = data.currency || 'CNY';

  card.innerHTML = `
    <div class="party-card-header">
      <span class="party-title">对方单位及独立履约明细</span>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeCounterpartyCard(this)">移除该方</button>
    </div>
    <div class="form-grid-4">
      <div class="form-group">
        <label>对方单位名称 *</label>
        <input type="text" class="p-name" value="${escapeHtml(data.company_name || '')}" placeholder="单位全称" required />
      </div>
      <div class="form-group">
        <label>统一社会信用代码 *</label>
        <input type="text" class="p-credit" value="${escapeHtml(data.credit_code || '')}" placeholder="18位社会信用代码" required />
      </div>
      <div class="form-group">
        <label>联系人</label>
        <input type="text" class="p-person" value="${escapeHtml(data.contact_person || '')}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>联系电话</label>
        <input type="text" class="p-phone" value="${escapeHtml(data.contact_phone || '')}" placeholder="选填" />
      </div>

      <div class="form-group">
        <label>收款账户名称</label>
        <input type="text" class="p-acc-name" value="${escapeHtml(data.bank_account_name || '')}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>收款银行账号</label>
        <input type="text" class="p-acc-no" value="${escapeHtml(data.bank_account_no || '')}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>开户银行</label>
        <input type="text" class="p-bank-name" value="${escapeHtml(data.bank_name || '')}" placeholder="如：工商银行XX支行" />
      </div>
      <div class="form-group">
        <label>开户行号 (联行号)</label>
        <input type="text" class="p-bank-code" value="${escapeHtml(data.bank_code || '')}" placeholder="12位联行号(选填)" />
      </div>

      <div class="party-sub-divider">💰 该方独立履约内容、金额、发票与保证金/质保金</div>

      <div class="form-group span-2">
        <label>本方履约核心内容摘要</label>
        <input type="text" class="p-summary" value="${escapeHtml(data.item_summary || '')}" placeholder="写明该方负责的标的、服务范围或交付节点..." />
      </div>
      <div class="form-group">
        <label>含税金额 *</label>
        <input type="number" step="0.01" class="p-amount" value="${escapeHtml(data.amount ?? 0)}" required />
      </div>
      <div class="form-group">
        <label>不含税价</label>
        <input type="number" step="0.01" class="p-amount-excl" value="${escapeHtml(data.amount_excl_tax ?? '')}" placeholder="选填" />
      </div>

      <div class="form-group">
        <label>税率 <small class="muted">(填6自动变6%)</small></label>
        <input type="text" class="p-tax-rate" value="${escapeHtml(data.tax_rate || '')}" placeholder="如 13 或 6,13" onblur="normalizeTaxInputElem(this)" />
      </div>
      <div class="form-group">
        <label>发票类型 <small class="muted">(可下拉可手填)</small></label>
        <input type="text" class="p-invoice-type" list="invoice_type_list" value="${escapeHtml(data.invoice_type || '')}" placeholder="双击选择或直接输入" />
      </div>
      <div class="form-group">
        <label>结算币种</label>
        <select class="p-currency">
          <option value="CNY" ${currencyVal === 'CNY' ? 'selected' : ''}>CNY (人民币)</option>
          <option value="USD" ${currencyVal === 'USD' ? 'selected' : ''}>USD (美元)</option>
          <option value="EUR" ${currencyVal === 'EUR' ? 'selected' : ''}>EUR (欧元)</option>
        </select>
      </div>
      <div class="form-group">
        <label>分项备注</label>
        <input type="text" class="p-remark" value="${escapeHtml(data.remark || '')}" placeholder="选填" />
      </div>

      <div class="form-group">
        <label>履约保证金金额</label>
        <input type="number" step="0.01" class="p-perf-amt" value="${escapeHtml(data.perf_bond_amount ?? '')}" placeholder="选填" />
      </div>
      <div class="form-group">
        <label>保证金缴纳日</label>
        <div class="smart-date-wrap">
          <input type="text" class="p-perf-pay" value="${escapeHtml(data.perf_bond_pay_date || '')}" placeholder="如 2026.3.5" onblur="normalizeDateInputElem(this)" />
          <input type="date" class="native-date-Helper" tabindex="-1" onchange="this.previousElementSibling.value=this.value;this.value='';" />
        </div>
      </div>
      <div class="form-group">
        <label>保证金应退日 <small class="muted">(预警)</small></label>
        <div class="smart-date-wrap">
          <input type="text" class="p-perf-ret" value="${escapeHtml(data.perf_bond_return_date || '')}" placeholder="如 2026.9.1" onblur="normalizeDateInputElem(this)" />
          <input type="date" class="native-date-Helper" tabindex="-1" onchange="this.previousElementSibling.value=this.value;this.value='';" />
        </div>
      </div>
      <div class="form-group">
        <label>质保金金额 & 到期日 <small class="muted">(预警)</small></label>
        <div style="display:flex;gap:4px;">
          <input type="number" step="0.01" class="p-warr-amt" style="width:46%;" value="${escapeHtml(data.warranty_bond_amount ?? '')}" placeholder="金额" />
          <div class="smart-date-wrap" style="width:54%;">
            <input type="text" class="p-warr-exp" value="${escapeHtml(data.warranty_bond_expiry_date || '')}" placeholder="到期日" onblur="normalizeDateInputElem(this)" />
            <input type="date" class="native-date-Helper" tabindex="-1" onchange="this.previousElementSibling.value=this.value;this.value='';" />
          </div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(card);
  refreshPartyCardTitles();
}

function removeCounterpartyCard(btn) {
  const container = document.getElementById('counterparties_container');
  if (container.children.length <= 1) {
    return alert('合同至少需要保留一个对方单位！');
  }
  btn.closest('.party-card').remove();
  refreshPartyCardTitles();
}

function refreshPartyCardTitles() {
  const cards = document.querySelectorAll('#counterparties_container .party-card');
  cards.forEach((card, idx) => {
    card.querySelector('.party-title').innerText = `对方单位及履约分项 #${idx + 1}`;
  });
}

function collectCounterpartiesData() {
  const cards = document.querySelectorAll('#counterparties_container .party-card');
  const list = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const company_name = card.querySelector('.p-name').value.trim();
    const credit_code = card.querySelector('.p-credit').value.trim();
    if (!company_name || !credit_code) {
      throw new Error(`请完整填写第 ${i + 1} 个对方单位的“单位名称”和“统一社会信用代码”`);
    }

    const rawPay = card.querySelector('.p-perf-pay').value.trim();
    const rawRet = card.querySelector('.p-perf-ret').value.trim();
    const rawWarr = card.querySelector('.p-warr-exp').value.trim();

    const cleanPay = rawPay ? smartParseDateClient(rawPay) : '';
    const cleanRet = rawRet ? smartParseDateClient(rawRet) : '';
    const cleanWarr = rawWarr ? smartParseDateClient(rawWarr) : '';

    if (rawPay && cleanPay === null) throw new Error(`第 ${i + 1} 方“保证金缴纳日”格式无法识别：${rawPay}`);
    if (rawRet && cleanRet === null) throw new Error(`第 ${i + 1} 方“保证金应退日”格式无法识别：${rawRet}`);
    if (rawWarr && cleanWarr === null) throw new Error(`第 ${i + 1} 方“质保金到期日”格式无法识别：${rawWarr}`);

    const cleanTax = smartFormatTaxRateClient(card.querySelector('.p-tax-rate').value);

    list.push({
      company_name,
      credit_code,
      contact_person: card.querySelector('.p-person').value.trim(),
      contact_phone: card.querySelector('.p-phone').value.trim(),
      bank_account_name: card.querySelector('.p-acc-name').value.trim(),
      bank_account_no: card.querySelector('.p-acc-no').value.trim(),
      bank_name: card.querySelector('.p-bank-name').value.trim(),
      bank_code: card.querySelector('.p-bank-code').value.trim(),
      item_summary: card.querySelector('.p-summary').value.trim(),
      amount: card.querySelector('.p-amount').value,
      amount_excl_tax: card.querySelector('.p-amount-excl').value,
      tax_rate: cleanTax,
      invoice_type: card.querySelector('.p-invoice-type').value.trim(),
      currency: card.querySelector('.p-currency').value,
      perf_bond_amount: card.querySelector('.p-perf-amt').value,
      perf_bond_pay_date: cleanPay,
      perf_bond_return_date: cleanRet,
      warranty_bond_amount: card.querySelector('.p-warr-amt').value,
      warranty_bond_expiry_date: cleanWarr,
      remark: card.querySelector('.p-remark').value.trim()
    });
  }
  return list;
}

// ==================== 新增与编辑合同表单控制 ====================
async function openFormModal(id = null) {
  const form = document.getElementById('contract_form');
  form.reset();
  document.getElementById('form_id').value = '';
  document.getElementById('f_attachment').value = '';
  document.getElementById('f_related_files').value = '';
  document.getElementById('counterparties_container').innerHTML = '';

  const startDateInput = document.getElementById('f_start_date');
  startDateInput.dataset.autoSync = 'true';
  startDateInput.oninput = () => { startDateInput.dataset.autoSync = 'false'; };

  await fetchLinkingOptions();

  if (id) {
    document.getElementById('form_modal_title').innerText = '编辑合同台账';
    setContractNoEditorMode(true);
    const res = await apiFetch(`/api/contracts/${id}`);
    const result = await res.json();
    if (!result.success) return alert(result.message);
    const c = result.data;

    document.getElementById('form_id').value = c.id;
    document.getElementById('f_contract_no').value = c.contract_no;
    document.getElementById('f_contract_name').value = c.contract_name;
    document.getElementById('f_contract_type').value = c.contract_type;
    document.getElementById('f_status').value = c.status;
    document.getElementById('f_our_entity').value = c.our_entity;
    document.getElementById('f_sign_date').value = c.sign_date;
    document.getElementById('f_start_date').value = c.start_date || c.sign_date;
    document.getElementById('f_start_date').dataset.autoSync = 'false';
    document.getElementById('f_expiry_date').value = c.expiry_date;

    populateProcurementSelectInContractForm(c.procurement_id);

    const parties = parseContractParties(c);
    parties.forEach(p => addCounterpartyCard(p));
  } else {
    document.getElementById('form_modal_title').innerText = '新增合同台账';
    document.getElementById('f_our_entity').value = defaultOurEntity;
    const today = getLocalTodayStr();
    document.getElementById('f_sign_date').value = today;
    document.getElementById('f_start_date').value = today;

    setContractNoEditorMode(false);
    await fillAutoContractNo(today);
    populateProcurementSelectInContractForm(null);
    addCounterpartyCard();
  }

  document.getElementById('form_modal').classList.remove('hidden');
}

function closeFormModal() {
  document.getElementById('form_modal').classList.add('hidden');
}

async function submitContractForm(e) {
  e.preventDefault();
  if (isSubmittingForm) return;

  if (!isFreeContractNoMode) {
    syncSegmentedContractNo();
  }

  const signEl = document.getElementById('f_sign_date');
  const startEl = document.getElementById('f_start_date');
  const expEl = document.getElementById('f_expiry_date');

  const cleanSign = smartParseDateClient(signEl.value);
  const cleanStart = smartParseDateClient(startEl.value);
  const cleanExp = smartParseDateClient(expEl.value);

  if (!cleanSign) return alert(`签订日期“${signEl.value}”格式无法识别，请检查！`);
  if (!cleanStart) return alert(`开始履约日“${startEl.value}”格式无法识别，请检查！`);
  if (!cleanExp) return alert(`合同到期日“${expEl.value}”格式无法识别，请检查！`);

  signEl.value = cleanSign;
  startEl.value = cleanStart;
  expEl.value = cleanExp;

  let parties;
  try {
    parties = collectCounterpartiesData();
  } catch (err) {
    return alert(err.message);
  }

  const id = document.getElementById('form_id').value;
  const form = document.getElementById('contract_form');
  const formData = new FormData(form);
  formData.set('counterparties_json', JSON.stringify(parties));

  const submitBtn = document.getElementById('btn_submit_contract');
  isSubmittingForm = true;
  if (submitBtn) submitBtn.disabled = true;

  try {
    const url = id ? `/api/contracts/${id}` : '/api/contracts';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, { method, body: formData });
    const result = await res.json();
    if (!result.success) return alert(result.message);

    closeFormModal();
    await loadContractNoRule();
    if (currentModule === 'procurement') {
      await loadProcurements();
    } else {
      await loadContracts();
    }
  } catch (err) {
    alert('保存请求异常: ' + err.message);
  } finally {
    isSubmittingForm = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteContract(id) {
  if (!confirm('确定要删除该条合同记录吗？（将同时清理该合同的主扫描件与合同其他关联资料，关联的采购立项本身保留）')) return;
  const res = await apiFetch(`/api/contracts/${id}`, { method: 'DELETE' });
  const result = await res.json();
  if (!result.success) return alert(result.message);
  await loadContractNoRule();
  await loadContracts();
}

// ==================== 全量详情弹窗：支持【合同3类资料】与【采购立项2类资料】双向跨模块直连预览 ====================

function previewFileInRightPane(filePath, fileName, downloadUrl, badgeLabel = '文件预览') {
  const preview = document.getElementById('preview_container');
  const toolbar = document.getElementById('attachment_toolbar');
  if (!filePath) {
    preview.innerHTML = `<div class="empty-preview">请从左侧选择要预览的扫描件、立项资料或关联附件</div>`;
    return;
  }

  const encodedPath = encodeFilePathForUrl(filePath);
  const url = `/${encodedPath}?t=${Date.now()}`;
  const ext = filePath.split('.').pop().toLowerCase();

  toolbar.innerHTML = `
    <div>
      <span class="badge badge-生效中" style="margin-right:6px;">${escapeHtml(badgeLabel)}</span>
      <strong>📄 当前查看：</strong>
      <span>${escapeHtml(fileName)}</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <a class="btn btn-primary btn-sm" href="${downloadUrl}">⬇️ 下载该文件</a>
    </div>
  `;

  if (ext === 'pdf') {
    preview.innerHTML = `<iframe src="${url}"></iframe>`;
  } else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    preview.innerHTML = `<img src="${url}" alt="图片预览" />`;
  } else {
    preview.innerHTML = `
      <div class="empty-preview">
        <p style="font-size:16px;margin-bottom:10px;">📦 <strong>${escapeHtml(fileName)}</strong></p>
        <p style="color:#cbd5e1;margin-bottom:16px;">该格式 (${escapeHtml(ext.toUpperCase())}) 暂不支持浏览器内嵌渲染，请点击下方按钮直接下载查看：</p>
        <a class="btn btn-primary" href="${downloadUrl}">⬇️ 立即下载 (${escapeHtml(fileName)})</a>
      </div>
    `;
  }
}

async function openDetailModal(id) {
  const res = await apiFetch(`/api/contracts/${id}`);
  if (res.status === 401) return;
  const result = await res.json();
  if (!result.success) return alert(result.message);
  const c = result.data;
  const parties = parseContractParties(c);
  const relatedList = Array.isArray(c.related_files) ? c.related_files : [];
  const lp = c.linked_procurement;
  const lpFiles = lp && Array.isArray(lp.files) ? lp.files : [];

  document.getElementById('detail_modal_title').innerText = `📄 合同详情与三大资料中心 —— ${c.contract_no} (${c.contract_name})`;

  const partiesHtml = parties.map((p, idx) => `
    <div class="detail-card">
      <h4>🏢 对方单位及履约分项 #${idx + 1}：${escapeHtml(p.company_name)}</h4>
      <div class="detail-row"><span class="label">统一社会信用代码</span><span class="val">${escapeHtml(p.credit_code)}</span></div>
      <div class="detail-row"><span class="label">联系人 / 电话</span><span class="val">${escapeHtml(p.contact_person || '-')} / ${escapeHtml(p.contact_phone || '-')}</span></div>
      <div class="detail-row"><span class="label">收款账户 / 账号</span><span class="val">${escapeHtml(p.bank_account_name || '-')} | ${escapeHtml(p.bank_account_no || '-')}</span></div>
      <div class="detail-row"><span class="label">开户银行 / 行号</span><span class="val">${escapeHtml(p.bank_name || '-')} (${escapeHtml(p.bank_code || '-')})</span></div>
      <hr style="border:none;border-top:1px dashed #e5e7eb;margin:6px 0;" />
      <div class="detail-row"><span class="label">本方履约摘要</span><span class="val">${escapeHtml(p.item_summary || '-')}</span></div>
      <div class="detail-row"><span class="label">含税金额 / 不含税价</span><span class="val"><strong>${fmtMoney(p.amount)} ${escapeHtml(p.currency || 'CNY')}</strong> (不含税: ${fmtMoney(p.amount_excl_tax)})</span></div>
      <div class="detail-row"><span class="label">税率 / 发票类型</span><span class="val">${escapeHtml(p.tax_rate || '-')} | ${escapeHtml(p.invoice_type || '-')}</span></div>
      <div class="detail-row"><span class="label">履约保证金</span><span class="val">金额: ${fmtMoney(p.perf_bond_amount)} | 缴: ${escapeHtml(p.perf_bond_pay_date || '-')} | ${renderDueAlertBadge(p.perf_bond_return_date, c.status, '应退')}</span></div>
      <div class="detail-row"><span class="label">质保金</span><span class="val">金额: ${fmtMoney(p.warranty_bond_amount)} | ${renderDueAlertBadge(p.warranty_bond_expiry_date, c.status, '到期')}</span></div>
      <div class="detail-row"><span class="label">分项备注</span><span class="val">${escapeHtml(p.remark || '-')}</span></div>
    </div>
  `).join('');

  const scanHtml = `
    <div class="detail-card" style="border-color:#93c5fd;background:#eff6ff;">
      <h4 style="color:#1e3a8a;">
        <span>① 主合同扫描件 <small style="font-weight:400;">(uploads/)</small></span>
        <label class="btn btn-primary btn-sm" style="cursor:pointer;margin:0;">
          📤 ${c.attachment_path ? '替换扫描件' : '上传扫描件'}
          <input type="file" style="display:none" accept=".pdf,.jpg,.jpeg,.png" onchange="uploadAttachmentInDetail(${c.id}, this)" />
        </label>
      </h4>
      ${c.attachment_path ? `
        <div class="related-list-item">
          <span class="fname">📎 ${escapeHtml(c.attachment_original_name)}</span>
          <div class="factions">
            <button type="button" class="btn btn-outline btn-sm" onclick="previewFileInRightPane('${escapeHtml(c.attachment_path.replace(/\\/g, '/'))}', '${escapeHtml(c.attachment_original_name)}', '/api/contracts/${c.id}/download', '① 主合同扫描件')">👁️ 预览</button>
            <a class="btn btn-primary btn-sm" href="/api/contracts/${c.id}/download">⬇️ 下载</a>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteAttachmentInDetail(${c.id})">删除</button>
          </div>
        </div>
      ` : `<div style="color:#6b7280;font-size:12px;">暂未上传主合同扫描件</div>`}
    </div>
  `;

  const procSectionHtml = `
    <div class="detail-card" style="border-color:#d8b4fe;background:#faf5ff;">
      <h4 style="color:#6b21a8;">
        <span>② 关联采购立项及立项资料 <small style="font-weight:400;">(跨模块直连采购台账)</small></span>
        ${lp ? `<button type="button" class="btn btn-outline btn-sm" onclick="openProcurementDetailModal(${lp.id})">🛒 跳转该立项管理</button>` : ''}
      </h4>
      ${lp ? `
        <div style="font-size:12px;color:#4b5563;margin-bottom:6px;">
          立项编号：<strong>${escapeHtml(lp.procurement_no)}</strong> ｜ 项目名称：<strong>${escapeHtml(lp.project_name)}</strong> ｜ 费用部门：${escapeHtml(lp.cost_department || '-')}
        </div>
        ${lpFiles.length > 0 ? lpFiles.map(pf => `
          <div class="related-list-item">
            <span class="fname" style="color:#6b21a8;">📑 ${escapeHtml(pf.file_name)}</span>
            <div class="factions">
              <button type="button" class="btn btn-outline btn-sm" onclick="previewFileInRightPane('${escapeHtml(pf.file_path.replace(/\\/g, '/'))}', '${escapeHtml(pf.file_name)}', '/api/procurements/${lp.id}/files/${pf.id}/download', '② 采购立项资料')">👁️ 预览</button>
              <a class="btn btn-primary btn-sm" href="/api/procurements/${lp.id}/files/${pf.id}/download">⬇️ 下载</a>
            </div>
          </div>
        `).join('') : `<div style="color:#6b7280;font-size:12px;">该采购立项暂未上传立项附件（可点击右上角“跳转该立项管理”上传）</div>`}
      ` : `<div style="color:#6b7280;font-size:12px;">当前合同尚未关联采购立项（可在“编辑”合同或采购台账中绑定）</div>`}
    </div>
  `;

  const relatedItemsHtml = relatedList.length > 0
    ? relatedList.map(att => `
        <div class="related-list-item">
          <span class="fname" title="${escapeHtml(att.file_path)}">📄 ${escapeHtml(att.file_name)}</span>
          <div class="factions">
            <button type="button" class="btn btn-outline btn-sm" onclick="previewFileInRightPane('${escapeHtml(att.file_path.replace(/\\/g, '/'))}', '${escapeHtml(att.file_name)}', '/api/contracts/${c.id}/related/${att.id}/download', '③ 合同其他附件')">👁️ 预览</button>
            <a class="btn btn-primary btn-sm" href="/api/contracts/${c.id}/related/${att.id}/download">⬇️ 下载</a>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteRelatedFileInDetail(${c.id}, ${att.id})">删除</button>
          </div>
        </div>
      `).join('')
    : `<div style="color:#6b7280;font-size:12px;padding:6px 0;">暂无合同其他关联资料，可点击右上角按钮批量追加上传。</div>`;

  const relatedCardHtml = `
    <div class="detail-card" style="border-color:#99f6e4;background:#f0fdf4;">
      <h4 style="color:#0f766e;">
        <span>③ 合同其他关联资料 (${relatedList.length}份)</span>
        <label class="btn btn-success btn-sm" style="cursor:pointer;margin:0;">
          ➕ 追加上传其他资料
          <input type="file" multiple style="display:none" onchange="uploadRelatedFilesInDetail(${c.id}, this)" />
        </label>
      </h4>
      ${relatedItemsHtml}
    </div>
  `;

  document.getElementById('detail_fields').innerHTML = `
    <div class="detail-card">
      <h4>📌 合同公共信息</h4>
      <div class="detail-row"><span class="label">年度序号</span><span class="val"><span class="seq-badge">${escapeHtml(c.seq_label || c.seq_no)}</span></span></div>
      <div class="detail-row"><span class="label">合同编号</span><span class="val"><strong>${escapeHtml(c.contract_no)}</strong></span></div>
      <div class="detail-row"><span class="label">合同名称</span><span class="val">${escapeHtml(c.contract_name)}</span></div>
      <div class="detail-row"><span class="label">类型 / 状态</span><span class="val">${escapeHtml(c.contract_type)} | <span class="badge badge-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></span></div>
      <div class="detail-row"><span class="label">我方签约主体</span><span class="val">${escapeHtml(c.our_entity)}</span></div>
      <div class="detail-row"><span class="label">签订 / 开始履约</span><span class="val">${escapeHtml(c.sign_date)} / ${escapeHtml(c.start_date || c.sign_date)}</span></div>
      <div class="detail-row"><span class="label">合同到期日</span><span class="val">${renderDueAlertBadge(c.expiry_date, c.status)}</span></div>
      <div class="detail-row"><span class="label">合同汇总含税总额</span><span class="val"><strong>${fmtMoney(c.amount)} ${escapeHtml(c.currency)}</strong></span></div>
    </div>
    ${scanHtml}
    ${procSectionHtml}
    ${relatedCardHtml}
    ${partiesHtml}
  `;

  if (c.attachment_path) {
    previewFileInRightPane(c.attachment_path, c.attachment_original_name, `/api/contracts/${c.id}/download`, '① 主合同扫描件');
  } else if (lpFiles.length > 0) {
    previewFileInRightPane(lpFiles[0].file_path, lpFiles[0].file_name, `/api/procurements/${lp.id}/files/${lpFiles[0].id}/download`, '② 采购立项资料');
  } else if (relatedList.length > 0) {
    previewFileInRightPane(relatedList[0].file_path, relatedList[0].file_name, `/api/contracts/${c.id}/related/${relatedList[0].id}/download`, '③ 合同其他附件');
  } else {
    document.getElementById('attachment_toolbar').innerHTML = `<div><strong>📄 在线预览窗口</strong></div>`;
    document.getElementById('preview_container').innerHTML = `<div class="empty-preview">当前合同暂未上传文件，可在左侧上传或点击预览</div>`;
  }

  document.getElementById('detail_modal').classList.remove('hidden');
}

async function openProcurementDetailModal(procId, autoPreviewContractScan = false) {
  const res = await apiFetch(`/api/procurements/${procId}`);
  if (res.status === 401) return;
  const result = await res.json();
  if (!result.success) return alert(result.message);
  const p = result.data;
  const pFiles = Array.isArray(p.procurement_files) ? p.procurement_files : [];
  const lc = p.linked_contract;

  document.getElementById('detail_modal_title').innerText = `🛒 采购立项详情与资料中心 —— ${p.procurement_no} (${p.project_name})`;

  const procFilesHtml = pFiles.length > 0
    ? pFiles.map(f => `
        <div class="related-list-item">
          <span class="fname" style="color:#6b21a8;">📑 ${escapeHtml(f.file_name)}</span>
          <div class="factions">
            <button type="button" class="btn btn-outline btn-sm" onclick="previewFileInRightPane('${escapeHtml(f.file_path.replace(/\\/g, '/'))}', '${escapeHtml(f.file_name)}', '/api/procurements/${p.id}/files/${f.id}/download', '采购立项资料')">👁️ 预览</button>
            <a class="btn btn-primary btn-sm" href="/api/procurements/${p.id}/files/${f.id}/download">⬇️ 下载</a>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteProcFileInDetail(${p.id}, ${f.id})">删除</button>
          </div>
        </div>
      `).join('')
    : `<div style="color:#6b7280;font-size:12px;padding:6px 0;">暂未上传立项相关资料，可点击右上角按钮批量上传。</div>`;

  const linkedContractScanHtml = `
    <div class="detail-card" style="border-color:#93c5fd;background:#eff6ff;">
      <h4 style="color:#1e3a8a;">
        <span>📎 关联合同扫描件直连 <small style="font-weight:400;">(仅展示合同扫描件，不展示合同杂项附件)</small></span>
        ${lc ? `<button type="button" class="btn btn-outline btn-sm" onclick="openDetailModal(${lc.id})">📄 跳转该合同详情</button>` : ''}
      </h4>
      ${lc ? `
        <div style="font-size:12px;color:#1e3a8a;margin-bottom:6px;">
          合同编号：<strong>${escapeHtml(lc.contract_no)}</strong> ｜ 合同名称：<strong>${escapeHtml(lc.contract_name)}</strong>
        </div>
        ${lc.attachment_path ? `
          <div class="related-list-item">
            <span class="fname">📎 ${escapeHtml(lc.attachment_original_name)}</span>
            <div class="factions">
              <button type="button" class="btn btn-outline btn-sm" onclick="previewFileInRightPane('${escapeHtml(lc.attachment_path.replace(/\\/g, '/'))}', '${escapeHtml(lc.attachment_original_name)}', '/api/contracts/${lc.id}/download', '关联合同扫描件')">👁️ 预览扫描件</button>
              <a class="btn btn-primary btn-sm" href="/api/contracts/${lc.id}/download">⬇️ 下载扫描件</a>
            </div>
          </div>
        ` : `<div style="color:#6b7280;font-size:12px;">该关联合同尚未上传主合同扫描件</div>`}
      ` : `<div style="color:#6b7280;font-size:12px;">当前采购立项暂未绑定合同（${p.contract_no_manual ? `已预填合同号：${escapeHtml(p.contract_no_manual)}` : '未签合同'}）</div>`}
    </div>
  `;

  document.getElementById('detail_fields').innerHTML = `
    <div class="detail-card">
      <h4 style="color:#0f766e;">📌 采购立项台账完整信息</h4>
      <div class="detail-row"><span class="label">序号 / 立项编号</span><span class="val"><span class="seq-badge">${escapeHtml(p.seq_no)}</span> <strong>${escapeHtml(p.procurement_no)}</strong></span></div>
      <div class="detail-row"><span class="label">采购项目名称</span><span class="val"><strong>${escapeHtml(p.project_name)}</strong></span></div>
      <div class="detail-row"><span class="label">立项类型 / 费用承担部门</span><span class="val">${escapeHtml(p.project_type || '-')} ｜ <strong style="color:#92400e;">${escapeHtml(p.cost_department || '-')}</strong></span></div>
      <div class="detail-row"><span class="label">采购预算 / 预算科目</span><span class="val">${fmtMoney(p.budget_amount)} 元 ｜ ${escapeHtml(p.budget_subject || '-')}</span></div>
      <div class="detail-row"><span class="label">采购类型 / 采购方式</span><span class="val">${escapeHtml(p.procurement_type || '-')} ｜ ${escapeHtml(p.procurement_method || '-')}</span></div>
      <div class="detail-row"><span class="label">立项 / 决策 / 完结时间</span><span class="val">${escapeHtml(p.approval_date || '-')} / ${escapeHtml(p.decision_date || '-')} / ${escapeHtml(p.completion_date || '-')}</span></div>
      <div class="detail-row"><span class="label">成交供应商</span><span class="val"><strong>${escapeHtml(p.supplier_name || '-')}</strong></span></div>
      <div class="detail-row"><span class="label">成交金额 / 是否签合同</span><span class="val"><strong>${fmtMoney(p.deal_amount)} 元</strong> ｜ <span class="badge badge-${escapeHtml(p.has_contract || '否')}">${escapeHtml(p.has_contract || '否')}</span></span></div>
      <div class="detail-row"><span class="label">备注</span><span class="val">${escapeHtml(p.remark || '-')}</span></div>
    </div>

    <div class="detail-card" style="border-color:#d8b4fe;background:#faf5ff;">
      <h4 style="color:#6b21a8;">
        <span>📑 立项相关资料 (${pFiles.length}份)</span>
        <label class="btn btn-primary btn-sm" style="background:#7c3aed;cursor:pointer;margin:0;">
          ➕ 追加上传立项资料
          <input type="file" multiple style="display:none" onchange="uploadProcFilesInDetail(${p.id}, this)" />
        </label>
      </h4>
      <div style="font-size:11.5px;color:#6b21a8;margin-bottom:6px;">
        📁 物理归档路径：<code>${escapeHtml(p.folder_path || `uploads/procurement/${p.procurement_no}+${p.project_name}+${p.approval_date || '无日期'}`)}</code>
      </div>
      ${procFilesHtml}
    </div>

    ${linkedContractScanHtml}
  `;

  if (autoPreviewContractScan && lc && lc.attachment_path) {
    previewFileInRightPane(lc.attachment_path, lc.attachment_original_name, `/api/contracts/${lc.id}/download`, '关联合同扫描件');
  } else if (pFiles.length > 0) {
    previewFileInRightPane(pFiles[0].file_path, pFiles[0].file_name, `/api/procurements/${p.id}/files/${pFiles[0].id}/download`, '采购立项资料');
  } else if (lc && lc.attachment_path) {
    previewFileInRightPane(lc.attachment_path, lc.attachment_original_name, `/api/contracts/${lc.id}/download`, '关联合同扫描件');
  } else {
    document.getElementById('attachment_toolbar').innerHTML = `<div><strong>📄 在线预览窗口</strong></div>`;
    document.getElementById('preview_container').innerHTML = `<div class="empty-preview">当前采购立项暂未上传立项资料，可在左侧点击“➕ 追加上传立项资料”</div>`;
  }

  document.getElementById('detail_modal').classList.remove('hidden');
}

function closeDetailModal() {
  document.getElementById('preview_container').innerHTML = '';
  document.getElementById('detail_modal').classList.add('hidden');
}

async function uploadAttachmentInDetail(id, fileInput) {
  if (!fileInput.files.length || isUploadingDetail) return;
  isUploadingDetail = true;
  fileInput.disabled = true;
  try {
    const formData = new FormData();
    formData.append('attachment', fileInput.files[0]);
    const res = await apiFetch(`/api/contracts/${id}/attachment`, { method: 'POST', body: formData });
    const result = await res.json();
    if (!result.success) return alert(result.message);
    await openDetailModal(id);
    await loadContracts();
  } finally {
    isUploadingDetail = false;
    fileInput.disabled = false;
  }
}

async function deleteAttachmentInDetail(id) {
  if (!confirm('确定要移除该合同的主扫描件吗？')) return;
  const res = await apiFetch(`/api/contracts/${id}/attachment`, { method: 'DELETE' });
  const result = await res.json();
  if (!result.success) return alert(result.message);
  await openDetailModal(id);
  await loadContracts();
}

async function uploadRelatedFilesInDetail(contractId, fileInput) {
  if (!fileInput.files || fileInput.files.length === 0 || isUploadingDetail) return;
  isUploadingDetail = true;
  fileInput.disabled = true;
  try {
    const formData = new FormData();
    for (const f of fileInput.files) formData.append('related_files', f);
    const res = await apiFetch(`/api/contracts/${contractId}/related`, { method: 'POST', body: formData });
    const result = await res.json();
    if (!result.success) return alert(result.message);
    await openDetailModal(contractId);
    await loadContracts();
  } finally {
    isUploadingDetail = false;
    fileInput.disabled = false;
  }
}

async function deleteRelatedFileInDetail(contractId, attId) {
  if (!confirm('确定要删除这份合同关联资料吗？')) return;
  const res = await apiFetch(`/api/contracts/${contractId}/related/${attId}`, { method: 'DELETE' });
  const result = await res.json();
  if (!result.success) return alert(result.message);
  await openDetailModal(contractId);
  await loadContracts();
}

async function uploadProcFilesInDetail(procId, fileInput) {
  if (!fileInput.files || fileInput.files.length === 0 || isUploadingDetail) return;
  isUploadingDetail = true;
  fileInput.disabled = true;
  try {
    const formData = new FormData();
    for (const f of fileInput.files) formData.append('procurement_files', f);
    const res = await apiFetch(`/api/procurements/${procId}/files`, { method: 'POST', body: formData });
    const result = await res.json();
    if (!result.success) return alert(result.message);
    await openProcurementDetailModal(procId);
    if (currentModule === 'procurement') await loadProcurements();
    else await loadContracts();
  } finally {
    isUploadingDetail = false;
    fileInput.disabled = false;
  }
}

async function deleteProcFileInDetail(procId, fileId) {
  if (!confirm('确定要删除这份立项相关资料吗？')) return;
  const res = await apiFetch(`/api/procurements/${procId}/files/${fileId}`, { method: 'DELETE' });
  const result = await res.json();
  if (!result.success) return alert(result.message);
  await openProcurementDetailModal(procId);
  if (currentModule === 'procurement') await loadProcurements();
  else await loadContracts();
}

window.addEventListener('DOMContentLoaded', async () => {
  await checkAuthAndInitApp();
});
