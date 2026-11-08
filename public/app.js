/**
 * 企业合同与采购项目台账管理系统 - 前端交互核心引擎 (v2.5.1 排他绑定与一键解绑版)
 */

let currentTab = 'contract';
let contractsCache = [];
let procurementsCache = [];

let defaultOurEntity = 'ABC公司';
let contractRule = { prefix: 'HT-ABC-', default_mid: '', date_part: 'YYYYMM', seq_digits: 3, suffix: '', reset_yearly: true };
let procRule = { prefix: 'LX', default_mid: '', date_part: 'YYYYMMDD', seq_digits: 3, suffix: '', reset_yearly: true };

let dropdownPresets = {
  contract_types: ['采购', '服务', '销售', '框架', '其他'],
  contract_statuses: ['草稿', '生效中', '已到期', '已终止'],
  project_types: ['服务类项目', '货物类项目', '设备采购', '工程类项目', '其他'],
  cost_departments: ['综合管理部', '部门费用预算', '市场营销部', '运营管理部', '财务部', 'ABC分公司'],
  procurement_types: ['小额零星采购', '二级集中采购', '一级集中采购', '分散采购', '其他'],
  procurement_methods: ['合作谈判', '邀请竞争谈判', '公开竞争谈判', '邀请询比', '公开询比', '单一来源采购'],
  budget_subjects: ['办公费', '运输费', '其他固定资产采购', '日常安全费用', '其他外包项目', '租赁费', '中介费', '装修费', '其他福利费'],
  invoice_types: ['增值税专用发票', '增值税普通发票', '数电专票', '数电普票']
};

let isFreeContractNoMode = false;
let isFreeProcNoMode = false;
let isSubmitting = false;
let isSilentSyncing = false;

const LAN_TOKEN_KEY = 'cm_lan_session_token';

function getLocalTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDynamicContractStatusPair() {
  const list = dropdownPresets.contract_statuses || ['草稿', '生效中', '已到期', '已终止'];
  const activeLabel = list.find(s => /生效|履行|执行|正常|进行/.test(s)) || '生效中';
  const expiredLabel = list.find(s => /到期|过期|期满|超期|逾期/.test(s)) || '已到期';
  return { activeLabel, expiredLabel };
}

function getStatusBadgeClass(statusStr) {
  const s = String(statusStr || '').trim();
  if (/生效|履行|执行|正常|进行/.test(s)) return 'badge-active';
  if (/到期|过期|期满|超期|逾期/.test(s)) return 'badge-expired';
  if (/终止|解除|作废|违约|取消/.test(s)) return 'badge-terminated';
  return 'badge-draft';
}

// ==================== 1. 鉴权请求封装、智能税率格式化与动态色彩渐变工具 ====================
function getLanToken() {
  return localStorage.getItem(LAN_TOKEN_KEY) || '';
}

function setLanToken(token) {
  if (token) localStorage.setItem(LAN_TOKEN_KEY, token);
  else localStorage.removeItem(LAN_TOKEN_KEY);
}

function withTokenUrl(url) {
  const tk = getLanToken();
  if (!tk) return url;
  return url + (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(tk)}`;
}

async function apiFetch(url, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  const tk = getLanToken();
  if (tk) headers['x-lan-token'] = tk;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    document.getElementById('lan_auth_overlay')?.classList.remove('hidden');
    throw new Error('需要验证内网访问口令');
  }
  return res;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsStr(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\r|\n/g, ' ');
}

function formatMoney(val) {
  const n = Number(val || 0);
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 智能税率格式化引擎：
 * - 单税率：输入 "6" 或 "6%" -> 自动格式化为 "6%"
 * - 多税率：输入 "6，9"、"6, 13"、"3/6/9"、"*6,9" -> 自动把每个数字转为百分数并在最前面加星号 "*6%、9%"
 */
function formatSmartTaxRate(raw) {
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

  const formattedTokens = tokens.map(t => {
    const clean = t.replace(/^[＊*]+/, '');
    if (/^\d+(\.\d+)?$/.test(clean)) return `${clean}%`;
    if (/^\d+(\.\d+)?%$/.test(clean)) return clean;
    return clean;
  });

  if (formattedTokens.length > 1 || hasLeadingStar) {
    return '*' + formattedTokens.join('、');
  }
  return formattedTokens[0];
}

function parseSmartDateString(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  if (/^\d{5}$/.test(str)) {
    const serial = parseInt(str, 10);
    if (serial >= 20000 && serial <= 80000) {
      const d = new Date((serial - 25569) * 86400 * 1000);
      if (!isNaN(d.getTime())) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
    }
  }
  if (/^\d{8}$/.test(str)) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  }
  const full = str.match(/^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/);
  if (full) {
    return `${full[1]}-${String(parseInt(full[2], 10)).padStart(2, '0')}-${String(parseInt(full[3], 10)).padStart(2, '0')}`;
  }
  const short = str.match(/^(\d{1,2})[-./月](\d{1,2})日?$/);
  if (short) {
    const yyyy = new Date().getFullYear();
    return `${yyyy}-${String(parseInt(short[1], 10)).padStart(2, '0')}-${String(parseInt(short[2], 10)).padStart(2, '0')}`;
  }
  return str;
}

function syncContractStatusByExpiryDate(expiryDateVal) {
  const exp = String(expiryDateVal || '').trim();
  if (!exp || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return;
  const statusSel = document.getElementById('f_status');
  if (!statusSel) return;

  const today = getLocalTodayStr();
  const { activeLabel, expiredLabel } = getDynamicContractStatusPair();

  if (exp < today && (statusSel.value === activeLabel || statusSel.value === '生效中')) {
    setSelectValueWithFallback('f_status', expiredLabel);
  } else if (exp >= today && (statusSel.value === expiredLabel || statusSel.value === '已到期')) {
    setSelectValueWithFallback('f_status', activeLabel);
  }
}

function normalizeDateInputElem(el) {
  if (!el) return '';
  el.value = parseSmartDateString(el.value);
  if (el.id === 'f_expiry_date') {
    syncContractStatusByExpiryDate(el.value);
  }
  return el.value;
}

function pickDateToInput(pickerEl, targetInputId, isSignDate) {
  const target = document.getElementById(targetInputId);
  if (target && pickerEl.value) {
    target.value = pickerEl.value;
    if (isSignDate) onSignDateBlur(target);
    if (targetInputId === 'f_expiry_date') {
      syncContractStatusByExpiryDate(target.value);
    }
  }
}

/**
 * 所有到期日（合同到期日、履约保证金应退日、质保金到期日）动态色彩渐变渲染器：
 * 随着剩余时间逼近，由绿色 (Hue=135°) -> 黄色 (60°) -> 橙色 (30°) -> 红色 (0°) 平滑渐变，且时间越近颜色越深！
 */
function renderDueChip(dateStr, isReturned = false) {
  if (!dateStr) return '<span style="color:#9ca3af;">-</span>';
  if (isReturned) {
    return `<span class="due-chip" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;">${escapeHtml(dateStr)} (已退)</span>`;
  }

  const today = getLocalTodayStr();
  const diffDays = Math.ceil((new Date(dateStr) - new Date(today)) / (86400 * 1000));
  if (isNaN(diffDays)) return `<span>${escapeHtml(dateStr)}</span>`;

  if (diffDays < 0) {
    const overDays = Math.abs(diffDays);
    const bgLight = Math.max(30, 44 - Math.min(overDays, 45) * 0.3);
    return `<span class="due-chip" style="background:hsl(0, 84%, ${bgLight.toFixed(0)}%);color:#ffffff;font-weight:700;box-shadow:0 1px 3px rgba(185,28,28,0.35);">${escapeHtml(dateStr)} (超期${overDays}天)</span>`;
  }

  if (diffDays <= 90) {
    const ratio = diffDays / 90;
    const hue = Math.round(ratio * 135);
    const sat = Math.round(92 - ratio * 18);
    const bgLight = Math.round(76 + ratio * 16);
    const borderLight = Math.round(bgLight - 14);
    const textLight = Math.round(18 + ratio * 10);
    const weight = diffDays <= 30 ? 700 : 600;
    const tip = diffDays === 0 ? '今日到期!' : `${diffDays}天到期`;

    return `<span class="due-chip" style="background:hsl(${hue}, ${sat}%, ${bgLight}%);color:hsl(${hue}, 90%, ${textLight}%);border:1px solid hsl(${hue}, ${sat}%, ${borderLight}%);font-weight:${weight};">${escapeHtml(dateStr)} (${tip})</span>`;
  }

  const safeRatio = Math.min(1, (diffDays - 90) / 275);
  const safeBgLight = Math.round(90 + safeRatio * 5);
  return `<span class="due-chip" style="background:hsl(142, 72%, ${safeBgLight}%);color:hsl(142, 82%, 24%);border:1px solid hsl(142, 65%, 76%);font-weight:500;">${escapeHtml(dateStr)} (${diffDays}天)</span>`;
}

// ==================== 2. 自定义下拉选项与预设词库引擎 ====================
function populateSelectWithOptions(selectId, optionsArr, placeholderText = null, defaultSelectedVal = null) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const prevVal = el.value;
  let html = '';
  if (placeholderText !== null) {
    html += `<option value="">${escapeHtml(placeholderText)}</option>`;
  }
  for (const item of (optionsArr || [])) {
    html += `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`;
  }
  el.innerHTML = html;
  if (prevVal && (optionsArr.includes(prevVal) || prevVal === '')) {
    el.value = prevVal;
  } else if (defaultSelectedVal && optionsArr.includes(defaultSelectedVal)) {
    el.value = defaultSelectedVal;
  }
}

function populateDatalistWithOptions(datalistId, optionsArr) {
  const el = document.getElementById(datalistId);
  if (!el) return;
  el.innerHTML = (optionsArr || []).map(item => `<option value="${escapeHtml(item)}"></option>`).join('');
}

function setSelectValueWithFallback(selectId, val) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const cleanVal = String(val ?? '').trim();
  if (!cleanVal) return;
  const exists = Array.from(el.options).some(opt => opt.value === cleanVal);
  if (!exists) {
    el.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(cleanVal)}">${escapeHtml(cleanVal)} (历史值)</option>`);
  }
  el.value = cleanVal;
}

function applyDropdownPresetsToDOM() {
  const rawStatuses = dropdownPresets.contract_statuses || ['草稿', '生效中', '已到期', '已终止'];
  if (!rawStatuses.some(s => /生效|履行|执行|正常|进行/.test(s))) rawStatuses.push('生效中');
  if (!rawStatuses.some(s => /到期|过期|期满|超期|逾期/.test(s))) rawStatuses.push('已到期');
  dropdownPresets.contract_statuses = rawStatuses;

  const { activeLabel } = getDynamicContractStatusPair();

  populateSelectWithOptions('filter_type', dropdownPresets.contract_types, '全部类型');
  populateSelectWithOptions('filter_status', dropdownPresets.contract_statuses, '全部状态');
  populateSelectWithOptions('proc_filter_type', dropdownPresets.project_types, '全部立项类型');

  populateSelectWithOptions('f_contract_type', dropdownPresets.contract_types, null, dropdownPresets.contract_types[0] || '采购');
  populateSelectWithOptions('f_status', dropdownPresets.contract_statuses, null, activeLabel);
  populateSelectWithOptions('p_project_type', dropdownPresets.project_types, null, dropdownPresets.project_types[0] || '服务类项目');
  populateSelectWithOptions('p_procurement_type', dropdownPresets.procurement_types, null, dropdownPresets.procurement_types[0] || '小额零星采购');

  populateDatalistWithOptions('dept_list', dropdownPresets.cost_departments);
  populateDatalistWithOptions('budget_subject_list', dropdownPresets.budget_subjects);
  populateDatalistWithOptions('proc_method_list', dropdownPresets.procurement_methods);
  populateDatalistWithOptions('invoice_type_list', dropdownPresets.invoice_types);
}

async function loadDropdownPresets() {
  try {
    const res = await apiFetch('/api/settings/presets');
    const json = await res.json();
    if (json.success && json.presets) {
      dropdownPresets = json.presets;
    }
  } catch (e) {}
  applyDropdownPresetsToDOM();
}

function openPresetsModal() {
  document.getElementById('preset_contract_types').value = (dropdownPresets.contract_types || []).join('、');
  document.getElementById('preset_contract_statuses').value = (dropdownPresets.contract_statuses || []).join('、');
  document.getElementById('preset_project_types').value = (dropdownPresets.project_types || []).join('、');
  document.getElementById('preset_cost_departments').value = (dropdownPresets.cost_departments || []).join('、');
  document.getElementById('preset_procurement_types').value = (dropdownPresets.procurement_types || []).join('、');
  document.getElementById('preset_procurement_methods').value = (dropdownPresets.procurement_methods || []).join('、');
  document.getElementById('preset_budget_subjects').value = (dropdownPresets.budget_subjects || []).join('、');
  document.getElementById('preset_invoice_types').value = (dropdownPresets.invoice_types || []).join('、');
  document.getElementById('presets_modal').classList.remove('hidden');
}

function closePresetsModal() {
  document.getElementById('presets_modal').classList.add('hidden');
}

async function savePresetsForm(e) {
  e.preventDefault();
  const statusInput = document.getElementById('preset_contract_statuses').value;
  const statusItems = statusInput.split(/[\r\n,，、;；]+/).map(s => s.trim()).filter(Boolean);
  if (!statusItems.some(s => /生效|履行|执行|正常|进行/.test(s))) statusItems.push('生效中');
  if (!statusItems.some(s => /到期|过期|期满|超期|逾期/.test(s))) statusItems.push('已到期');

  const payload = {
    presets: {
      contract_types: document.getElementById('preset_contract_types').value,
      contract_statuses: statusItems,
      project_types: document.getElementById('preset_project_types').value,
      cost_departments: document.getElementById('preset_cost_departments').value,
      procurement_types: document.getElementById('preset_procurement_types').value,
      procurement_methods: document.getElementById('preset_procurement_methods').value,
      budget_subjects: document.getElementById('preset_budget_subjects').value,
      invoice_types: document.getElementById('preset_invoice_types').value
    }
  };
  const res = await apiFetch('/api/settings/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (json.success) {
    dropdownPresets = json.presets;
    applyDropdownPresetsToDOM();
    closePresetsModal();
    await loadContracts();
  }
}

async function restoreDefaultPresets() {
  if (!confirm('确定将所有下拉选项恢复为默认设置吗？（不会影响已录入的历史台账数据）')) return;
  const res = await apiFetch('/api/settings/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset_defaults: true })
  });
  const json = await res.json();
  if (json.success) {
    dropdownPresets = json.presets;
    applyDropdownPresetsToDOM();
    openPresetsModal();
  }
}

// ==================== 3. 顶部双模块切换与初始化 ====================
function initYearDropdowns() {
  const curYear = new Date().getFullYear();
  const cYear = document.getElementById('filter_year');
  const pYear = document.getElementById('proc_filter_year');
  for (let y = curYear + 1; y >= curYear - 8; y--) {
    if (cYear) cYear.insertAdjacentHTML('beforeend', `<option value="${y}">${y}年</option>`);
    if (pYear) pYear.insertAdjacentHTML('beforeend', `<option value="${y}">${y}年</option>`);
  }
}

async function switchModuleTab(tab) {
  currentTab = tab === 'procurement' ? 'procurement' : 'contract';
  document.getElementById('tab_btn_contract')?.classList.toggle('active', currentTab === 'contract');
  document.getElementById('tab_btn_procurement')?.classList.toggle('active', currentTab === 'procurement');
  document.getElementById('header_group_contract')?.classList.toggle('hidden', currentTab !== 'contract');
  document.getElementById('header_group_procurement')?.classList.toggle('hidden', currentTab !== 'procurement');
  document.getElementById('view_contract')?.classList.toggle('hidden', currentTab !== 'contract');
  document.getElementById('view_procurement')?.classList.toggle('hidden', currentTab !== 'procurement');

  if (currentTab === 'procurement') {
    await loadProcNoRuleSettings();
    await loadProcurements();
  } else {
    await loadContractNoRuleSettings();
    await loadContracts();
  }
}

// ==================== 4. 内网协同安全锁与默认主体设置 ====================
async function checkLanAuthStatus() {
  try {
    const res = await fetch('/api/lan-auth/status', {
      headers: getLanToken() ? { 'x-lan-token': getLanToken() } : {}
    });
    const json = await res.json();
    if (json.is_localhost) {
      document.getElementById('host_lan_bar')?.classList.remove('hidden');
      document.getElementById('display_lan_status').textContent = json.enabled
        ? (json.passcode ? '口令保护中' : '免密开启')
        : '已关闭内网';
    } else {
      if (json.locked && !json.authorized) {
        document.getElementById('lan_auth_overlay')?.classList.remove('hidden');
        return false;
      }
      if (json.locked && json.authorized) {
        document.getElementById('btn_lan_logout')?.classList.remove('hidden');
      }
    }
    return true;
  } catch (e) {
    return true;
  }
}

async function submitLanAuthForm(e) {
  e.preventDefault();
  const input = document.getElementById('lan_auth_passcode_input');
  const errBox = document.getElementById('lan_auth_error');
  try {
    const res = await fetch('/api/lan-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: input.value.trim() })
    });
    const json = await res.json();
    if (!json.success) {
      errBox.textContent = json.message || '口令错误';
      errBox.classList.remove('hidden');
      return;
    }
    setLanToken(json.token || '');
    errBox.classList.add('hidden');
    document.getElementById('lan_auth_overlay').classList.add('hidden');
    await initAppData();
  } catch (err) {
    errBox.textContent = '验证请求失败';
    errBox.classList.remove('hidden');
  }
}

function logoutLanSession() {
  setLanToken('');
  location.reload();
}

async function openLanSecurityModal() {
  const res = await apiFetch('/api/lan-auth/status');
  const json = await res.json();
  document.getElementById('lan_enabled_checkbox').checked = json.enabled !== false;
  document.getElementById('lan_passcode_input').value = json.passcode || '888888';
  const urlsBox = document.getElementById('lan_urls_box');
  urlsBox.innerHTML = (json.lan_urls && json.lan_urls.length > 0)
    ? json.lan_urls.join('<br/>')
    : `http://127.0.0.1:${json.port || 3000}`;
  document.getElementById('lan_security_modal').classList.remove('hidden');
}

function closeLanSecurityModal() {
  document.getElementById('lan_security_modal').classList.add('hidden');
}

async function saveLanSecurityForm(e) {
  e.preventDefault();
  const enabled = document.getElementById('lan_enabled_checkbox').checked;
  const passcode = document.getElementById('lan_passcode_input').value.trim();
  const res = await apiFetch('/api/lan-auth/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, passcode })
  });
  const json = await res.json();
  if (json.success) {
    setLanToken(json.token || '');
    closeLanSecurityModal();
    await checkLanAuthStatus();
    alert('内网访问口令设置已保存！');
  }
}

function copyLanInviteText() {
  const urlText = document.getElementById('lan_urls_box').innerText.split('\n')[0] || '';
  const code = document.getElementById('lan_passcode_input').value.trim();
  const invite = `【企业合同与采购项目台账系统】\n内网协同网址：${urlText}\n访问验证口令：${code}`;
  navigator.clipboard.writeText(invite);
  alert('已复制【内网网址 + 验证口令】到剪贴板！');
}

async function loadOurEntitySetting() {
  try {
    const res = await apiFetch('/api/settings/our-entity');
    const json = await res.json();
    if (json.success) {
      defaultOurEntity = json.our_entity;
      const el = document.getElementById('display_default_entity');
      if (el) el.textContent = defaultOurEntity;
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
  const val = document.getElementById('modal_our_entity_input').value.trim();
  const res = await apiFetch('/api/settings/our-entity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ our_entity: val })
  });
  const json = await res.json();
  if (json.success) {
    defaultOurEntity = json.our_entity;
    document.getElementById('display_default_entity').textContent = defaultOurEntity;
    closeOurEntityModal();
  }
}

// ==================== 5. 合同与采购夹心式编号规则设置 ====================
async function loadContractNoRuleSettings() {
  try {
    const res = await apiFetch('/api/settings/no-rule');
    const json = await res.json();
    if (json.success) {
      contractRule = json.rule;
      const el = document.getElementById('display_no_rule');
      if (el) el.textContent = json.next_no || '自定义';
    }
  } catch (e) {}
}

async function loadProcNoRuleSettings() {
  try {
    const res = await apiFetch('/api/settings/proc-no-rule');
    const json = await res.json();
    if (json.success) {
      procRule = json.rule;
      const el = document.getElementById('display_proc_no_rule');
      if (el) el.textContent = json.next_no || '自定义';
    }
  } catch (e) {}
}

function formatPreviewDatePart(fmt) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (fmt === 'YYYY') return `${yyyy}`;
  if (fmt === 'YYYY-') return `${yyyy}-`;
  if (fmt === 'YYYYMM') return `${yyyy}${mm}`;
  if (fmt === 'YYYYMM-') return `${yyyy}${mm}-`;
  if (fmt === 'YYYYMMDD') return `${yyyy}${mm}${dd}`;
  if (fmt === 'YYYYMMDD-') return `${yyyy}${mm}${dd}-`;
  return '';
}

function openNoRuleModal() {
  document.getElementById('rule_prefix').value = contractRule.prefix || '';
  document.getElementById('rule_default_mid').value = contractRule.default_mid || '';
  document.getElementById('rule_date_part').value = contractRule.date_part || 'YYYYMM';
  document.getElementById('rule_seq_digits').value = String(contractRule.seq_digits ?? 3);
  document.getElementById('rule_suffix').value = contractRule.suffix || '';
  document.getElementById('rule_reset_yearly').checked = contractRule.reset_yearly !== false;
  updateNoRulePreview();
  document.getElementById('no_rule_modal').classList.remove('hidden');
}

function closeNoRuleModal() {
  document.getElementById('no_rule_modal').classList.add('hidden');
}

function updateNoRulePreview() {
  const pfx = document.getElementById('rule_prefix').value.trim();
  const mid = document.getElementById('rule_default_mid').value.trim();
  const dt = formatPreviewDatePart(document.getElementById('rule_date_part').value);
  const digits = parseInt(document.getElementById('rule_seq_digits').value, 10) || 0;
  const seq = digits > 0 ? String(1).padStart(digits, '0') : '';
  const sfx = document.getElementById('rule_suffix').value.trim();
  document.getElementById('rule_live_preview').textContent = `${pfx}${mid}${dt}${seq}${sfx}` || '（自由手填）';
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
  const res = await apiFetch('/api/settings/no-rule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (json.success) {
    closeNoRuleModal();
    await loadContractNoRuleSettings();
    await loadContracts();
  }
}

function openProcNoRuleModal() {
  document.getElementById('prule_prefix').value = procRule.prefix || '';
  document.getElementById('prule_default_mid').value = procRule.default_mid || '';
  document.getElementById('prule_date_part').value = procRule.date_part || 'YYYYMMDD';
  document.getElementById('prule_seq_digits').value = String(procRule.seq_digits ?? 3);
  document.getElementById('prule_suffix').value = procRule.suffix || '';
  document.getElementById('prule_reset_yearly').checked = procRule.reset_yearly !== false;
  updateProcNoRulePreview();
  document.getElementById('proc_no_rule_modal').classList.remove('hidden');
}

function closeProcNoRuleModal() {
  document.getElementById('proc_no_rule_modal').classList.add('hidden');
}

function updateProcNoRulePreview() {
  const pfx = document.getElementById('prule_prefix').value.trim();
  const mid = document.getElementById('prule_default_mid').value.trim();
  const dt = formatPreviewDatePart(document.getElementById('prule_date_part').value);
  const digits = parseInt(document.getElementById('prule_seq_digits').value, 10) || 0;
  const seq = digits > 0 ? String(1).padStart(digits, '0') : '';
  const sfx = document.getElementById('prule_suffix').value.trim();
  document.getElementById('prule_live_preview').textContent = `${pfx}${mid}${dt}${seq}${sfx}` || '（自由手填）';
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
  const res = await apiFetch('/api/settings/proc-no-rule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (json.success) {
    closeProcNoRuleModal();
    await loadProcNoRuleSettings();
    await loadProcurements();
  }
}

// ==================== 6. 夹心式 4 段编号构建器实时同步逻辑 ====================
function syncSegmentedContractNo() {
  if (isFreeContractNoMode) return;
  const pfx = document.getElementById('seg_prefix').textContent || '';
  const mid = document.getElementById('seg_mid_custom_input').value.trim();
  const dt = document.getElementById('seg_date').textContent || '';
  const seq = document.getElementById('seg_middle_input').value.trim();
  const sfx = document.getElementById('seg_suffix').textContent || '';
  document.getElementById('f_contract_no').value = `${pfx}${mid}${dt}${seq}${sfx}`;
}

async function fillAutoContractNo(signDateVal) {
  const cleanDate = parseSmartDateString(signDateVal) || getLocalTodayStr();
  const midVal = document.getElementById('seg_mid_custom_input').value.trim();
  try {
    const res = await apiFetch(`/api/contracts/next-no?sign_date=${encodeURIComponent(cleanDate)}&mid_custom=${encodeURIComponent(midVal)}`);
    const json = await res.json();
    if (json.success) {
      document.getElementById('seg_prefix').textContent = json.prefix || '';
      document.getElementById('seg_date').textContent = json.date_part || '';
      document.getElementById('seg_middle_input').value = json.seq_part || '';
      document.getElementById('seg_suffix').textContent = json.suffix || '';
      syncSegmentedContractNo();
    }
  } catch (e) {}
}

function onContractMidCustomChange() {
  fillAutoContractNo(document.getElementById('f_sign_date').value);
}

function onSignDateBlur(el) {
  const norm = normalizeDateInputElem(el);
  if (!document.getElementById('form_id').value && !isFreeContractNoMode) {
    fillAutoContractNo(norm);
  }
}

function toggleFreeContractNoMode(forceFree) {
  isFreeContractNoMode = forceFree !== undefined ? forceFree : !isFreeContractNoMode;
  document.getElementById('segmented_no_box').classList.toggle('hidden', isFreeContractNoMode);
  document.getElementById('f_contract_no').classList.toggle('hidden', !isFreeContractNoMode);
  document.getElementById('toggle_no_mode_btn').textContent = isFreeContractNoMode ? '🔢 切换分段自动编号' : '✏️ 切换纯自由手填';
}

function syncSegmentedProcNo() {
  if (isFreeProcNoMode) return;
  const pfx = document.getElementById('p_seg_prefix').textContent || '';
  const mid = document.getElementById('p_seg_mid_custom_input').value.trim();
  const dt = document.getElementById('p_seg_date').textContent || '';
  const seq = document.getElementById('p_seg_middle_input').value.trim();
  const sfx = document.getElementById('p_seg_suffix').textContent || '';
  document.getElementById('p_procurement_no').value = `${pfx}${mid}${dt}${seq}${sfx}`;
}

async function fillAutoProcurementNo(approvalDateVal) {
  const cleanDate = parseSmartDateString(approvalDateVal) || getLocalTodayStr();
  const midVal = document.getElementById('p_seg_mid_custom_input').value.trim();
  try {
    const res = await apiFetch(`/api/procurements/next-no?approval_date=${encodeURIComponent(cleanDate)}&mid_custom=${encodeURIComponent(midVal)}`);
    const json = await res.json();
    if (json.success) {
      document.getElementById('p_seg_prefix').textContent = json.prefix || '';
      document.getElementById('p_seg_date').textContent = json.date_part || '';
      document.getElementById('p_seg_middle_input').value = json.seq_part || '';
      document.getElementById('p_seg_suffix').textContent = json.suffix || '';
      syncSegmentedProcNo();
    }
  } catch (e) {}
}

function onProcMidCustomChange() {
  fillAutoProcurementNo(document.getElementById('p_approval_date').value);
}

function onProcApprovalDateBlur(el) {
  const norm = normalizeDateInputElem(el);
  if (!document.getElementById('p_form_id').value && !isFreeProcNoMode) {
    fillAutoProcurementNo(norm);
  }
}

function toggleFreeProcNoMode(forceFree) {
  isFreeProcNoMode = forceFree !== undefined ? forceFree : !isFreeProcNoMode;
  document.getElementById('p_segmented_no_box').classList.toggle('hidden', isFreeProcNoMode);
  document.getElementById('p_procurement_no').classList.toggle('hidden', !isFreeProcNoMode);
  document.getElementById('toggle_p_no_mode_btn').textContent = isFreeProcNoMode ? '🔢 切换分段自动编号' : '✏️ 切换纯自由手填';
}

// ==================== 7. 合同管理台账主表渲染 ====================
function buildContractQueryParams() {
  const p = new URLSearchParams();
  const no = document.getElementById('filter_no')?.value.trim();
  const cp = document.getElementById('filter_counterparty')?.value.trim();
  const year = document.getElementById('filter_year')?.value;
  const type = document.getElementById('filter_type')?.value;
  const status = document.getElementById('filter_status')?.value;
  const dateField = document.getElementById('filter_date_field')?.value;
  const dateFrom = document.getElementById('filter_date_from')?.value.trim();
  const dateTo = document.getElementById('filter_date_to')?.value.trim();
  const sortBy = document.getElementById('sort_by')?.value;
  const sortOrder = document.getElementById('sort_order')?.value;

  if (no) p.set('no', no);
  if (cp) p.set('counterparty', cp);
  if (year) p.set('year', year);
  if (type) p.set('type', type);
  if (status) p.set('status', status);
  if (dateField) p.set('date_field', dateField);
  if (dateFrom) p.set('date_from', dateFrom);
  if (dateTo) p.set('date_to', dateTo);
  if (sortBy) p.set('sort_by', sortBy);
  if (sortOrder) p.set('sort_order', sortOrder);
  return p;
}

async function loadContracts() {
  try {
    const params = buildContractQueryParams();
    const res = await apiFetch(`/api/contracts?${params.toString()}`);
    const json = await res.json();
    if (!json.success) return;
    contractsCache = json.data || [];
    renderContractLedgerTable(contractsCache);
  } catch (e) {}
}

function resetFilters() {
  ['filter_no', 'filter_counterparty', 'filter_year', 'filter_type', 'filter_status', 'filter_date_from', 'filter_date_to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  loadContracts();
}

function renderContractLedgerTable(list) {
  const tbody = document.getElementById('contract_tbody');
  if (!tbody) return;
  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="30" class="text-center" style="padding:28px;color:#6b7280;">暂无匹配的合同台账，请点击右上角【+ 新增合同】录入</td></tr>`;
    return;
  }

  const htmlRows = [];
  list.forEach((c, groupIdx) => {
    const parties = c.counterparties && c.counterparties.length > 0 ? c.counterparties : [{}];
    const span = parties.length;
    const parityClass = groupIdx % 2 === 1 ? 'contract-group-odd' : 'contract-group-even';

    const scanHtml = c.attachment_path
      ? `<a class="link-btn" href="javascript:void(0)" onclick="openDetailModal('contract', ${c.id})">📄 预览扫描件</a>`
      : `<span style="color:#9ca3af;">未上传</span>`;

    const procHtml = c.linked_procurement
      ? `<a class="proc-link-badge" href="javascript:void(0)" onclick="openDetailModal('procurement', ${c.linked_procurement.id})">🔗 ${escapeHtml(c.linked_procurement.procurement_no)} (${(c.linked_procurement.files || []).length}份)</a>`
      : `<span style="color:#9ca3af;">未关联</span>`;

    const relCount = (c.related_files || []).length;
    const relHtml = relCount > 0
      ? `<a class="related-badge-btn" href="javascript:void(0)" onclick="openDetailModal('contract', ${c.id})">📎 资料×${relCount}</a>`
      : `<a class="link-btn" style="font-size:12px;" href="javascript:void(0)" onclick="openDetailModal('contract', ${c.id})">+ 补传</a>`;

    const statusBadgeClass = getStatusBadgeClass(c.status);
    const isContractTerminated = /终止|解除|作废|取消/.test(c.status || '');

    parties.forEach((cp, pIdx) => {
      const isLastInGroup = pIdx === span - 1;
      const trClass = `${parityClass} ${isLastInGroup ? 'contract-group-end' : ''}`;

      const mergedLeftCells = pIdx === 0 ? `
        <td rowspan="${span}" class="text-center"><span class="seq-badge">${escapeHtml(c.seq_no)}</span></td>
        <td rowspan="${span}" class="text-center"><strong>${escapeHtml(c.contract_no)}</strong></td>
        <td rowspan="${span}"><a class="link-btn" href="javascript:void(0)" onclick="openDetailModal('contract', ${c.id})">${escapeHtml(c.contract_name)}</a></td>
        <td rowspan="${span}" class="text-center">${escapeHtml(c.contract_type)}</td>
        <td rowspan="${span}" class="text-center">${escapeHtml(c.our_entity)}</td>
        <td rowspan="${span}" class="text-center">${escapeHtml(c.sign_date)}</td>
        <td rowspan="${span}" class="text-center">${escapeHtml(c.start_date)}</td>
        <td rowspan="${span}" class="text-center">${renderDueChip(c.expiry_date, isContractTerminated)}</td>
        <td rowspan="${span}" class="text-center"><span class="badge ${statusBadgeClass}">${escapeHtml(c.status)}</span></td>
      ` : '';

      const mergedRightCells = pIdx === 0 ? `
        <td rowspan="${span}" class="text-center">${scanHtml}</td>
        <td rowspan="${span}" class="text-center">${procHtml}</td>
        <td rowspan="${span}" class="text-center">${relHtml}</td>
        <td rowspan="${span}" class="text-center">
          <button class="btn btn-outline btn-sm" onclick="openDetailModal('contract', ${c.id})">详情</button>
          <button class="btn btn-outline btn-sm" onclick="openFormModal(${c.id})">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="deleteContractRecord(${c.id}, '${escapeJsStr(c.contract_no)}')">删除</button>
        </td>
      ` : '';

      const isPerfReturned = cp.perf_bond_status === '已退';
      const perfInfo = Number(cp.perf_bond_amount || 0) > 0
        ? `<div><strong>¥${Number(cp.perf_bond_amount).toLocaleString()}</strong> (${escapeHtml(cp.perf_bond_status || '未退')})</div><div>${renderDueChip(cp.perf_bond_return_date, isPerfReturned)}</div>`
        : '<span style="color:#9ca3af;">无</span>';

      const isWarrantyReturned = cp.warranty_bond_status === '已退';
      const warrantyInfo = Number(cp.warranty_bond_amount || 0) > 0
        ? `<div><strong>¥${Number(cp.warranty_bond_amount).toLocaleString()}</strong> (${escapeHtml(cp.warranty_bond_status || '未退')})</div><div>${renderDueChip(cp.warranty_bond_expiry_date, isWarrantyReturned)}</div>`
        : '<span style="color:#9ca3af;">无</span>';

      const formattedTax = formatSmartTaxRate(cp.tax_rate);
      const taxHtml = formattedTax
        ? (formattedTax.startsWith('*') ? `<span class="tax-multi-chip" title="多税率合同">${escapeHtml(formattedTax)}</span>` : escapeHtml(formattedTax))
        : '-';

      const remarkText = [cp.remark, c.remark].filter(Boolean).join('\n') || '-';

      htmlRows.push(`
        <tr class="${trClass}">
          ${mergedLeftCells}
          <td class="wrap-text-cell">${escapeHtml(cp.summary || '-')}</td>
          <td><strong>${escapeHtml(cp.company_name || '-')}</strong></td>
          <td class="text-center">${escapeHtml(cp.credit_code || '-')}</td>
          <td class="text-center">${escapeHtml(cp.contact_person || '-')}</td>
          <td class="text-center">${escapeHtml(cp.contact_phone || '-')}</td>
          <td>${escapeHtml(cp.bank_account_name || '-')}</td>
          <td class="text-center">${escapeHtml(cp.bank_account_no || '-')}</td>
          <td>${escapeHtml(cp.bank_name || '-')}</td>
          <td class="text-center">${escapeHtml(cp.bank_code || '-')}</td>
          <td class="text-right"><strong>${formatMoney(cp.amount)}</strong></td>
          <td class="text-right">${formatMoney(cp.amount_excl_tax)}</td>
          <td class="text-center">${taxHtml}</td>
          <td class="text-center">${escapeHtml(cp.invoice_type || '-')}</td>
          <td class="text-center">${escapeHtml(cp.currency || 'CNY')}</td>
          <td class="text-center">${perfInfo}</td>
          <td class="text-center">${warrantyInfo}</td>
          <td class="wrap-text-cell">${escapeHtml(remarkText)}</td>
          ${mergedRightCells}
        </tr>
      `);
    });
  });

  tbody.innerHTML = htmlRows.join('');
}

// ==================== 8. 合同新增/编辑弹窗与动态对方单位卡片（排他过滤已绑定的立项） ====================
function removeCounterpartyCard(btnEl) {
  const container = document.getElementById('counterparties_container');
  if (!container) return;
  if (container.querySelectorAll('.party-card').length <= 1) {
    alert('每份合同至少需保留 1 个对方单位履约行！');
    return;
  }
  btnEl.closest('.party-card')?.remove();
}

function addCounterpartyCard(data = {}) {
  const container = document.getElementById('counterparties_container');
  if (!container) return;
  const idx = container.children.length + 1;
  const defaultInv = (dropdownPresets.invoice_types && dropdownPresets.invoice_types[0]) || '增值税专用发票';
  const pStatus = data.perf_bond_status || '无';
  const wStatus = data.warranty_bond_status || '无';
  const initTax = formatSmartTaxRate(data.tax_rate ?? '6%');

  const card = document.createElement('div');
  card.className = 'party-card';
  card.innerHTML = `
    <div class="party-card-header">
      <span>🏢 对方单位履约明细 #${idx}</span>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeCounterpartyCard(this)">移除该行</button>
    </div>
    <div class="form-grid-4">
      <div class="form-group span-2">
        <label>对方单位名称 *</label>
        <input type="text" class="cp-company" value="${escapeHtml(data.company_name || '')}" required placeholder="如：BCD公司" />
      </div>
      <div class="form-group">
        <label>统一社会信用代码</label>
        <input type="text" class="cp-credit" value="${escapeHtml(data.credit_code || '')}" placeholder="18位统一社会信用代码" />
      </div>
      <div class="form-group">
        <label>联系人 & 联系电话</label>
        <div style="display:flex;gap:6px;">
          <input type="text" class="cp-person" style="width:42%;min-width:0;" value="${escapeHtml(data.contact_person || '')}" placeholder="联系人姓名" />
          <input type="text" class="cp-phone" style="flex:1;min-width:0;" value="${escapeHtml(data.contact_phone || '')}" placeholder="联系电话" />
        </div>
      </div>

      <div class="form-group span-4">
        <label>履约摘要（单独占一行，支持换行输入详细履约内容、核心标的或结算节点）</label>
        <textarea class="cp-summary" rows="2" placeholder="请输入本单位负责的具体履约摘要内容...">${escapeHtml(data.summary || '')}</textarea>
      </div>

      <div class="form-group">
        <label>收款账户名称</label>
        <input type="text" class="cp-bank-user" value="${escapeHtml(data.bank_account_name || '')}" placeholder="如：BCD公司" />
      </div>
      <div class="form-group">
        <label>收款银行账号</label>
        <input type="text" class="cp-bank-no" value="${escapeHtml(data.bank_account_no || '')}" placeholder="收款银行卡号/对公账号" />
      </div>
      <div class="form-group">
        <label>开户银行</label>
        <input type="text" class="cp-bank-name" value="${escapeHtml(data.bank_name || '')}" placeholder="如：DEF银行营业部" />
      </div>
      <div class="form-group">
        <label>开户行号 (12位联行号)</label>
        <input type="text" class="cp-bank-code" value="${escapeHtml(data.bank_code || '')}" placeholder="如：102100000018" />
      </div>

      <div class="form-group">
        <label>含税金额 (元)</label>
        <input type="number" step="0.01" class="cp-amount" value="${data.amount ?? ''}" placeholder="0.00" oninput="calcExclTaxForCard(this)" />
      </div>
      <div class="form-group">
        <label>税率 (多税率如 6,9 自动变 *6%、9%)</label>
        <input type="text" class="cp-tax-rate" value="${escapeHtml(initTax)}" placeholder="如 6 或 6,9" oninput="calcExclTaxForCard(this)" onblur="onTaxRateInputBlur(this)" />
      </div>
      <div class="form-group">
        <label>不含税价 (单税率自动算/多税率可手填)</label>
        <input type="number" step="0.01" class="cp-amount-excl" value="${data.amount_excl_tax ?? ''}" placeholder="0.00" />
      </div>
      <div class="form-group">
        <label>发票类型 & 币种</label>
        <div style="display:flex;gap:4px;">
          <input type="text" class="cp-invoice" style="flex:1;min-width:0;" list="invoice_type_list" value="${escapeHtml(data.invoice_type || defaultInv)}" />
          <input type="text" class="cp-currency" style="width:58px;text-align:center;" value="${escapeHtml(data.currency || 'CNY')}" placeholder="币种" />
        </div>
      </div>

      <div class="form-group span-2">
        <label>履约保证金 (元) / 状态 / 应退日期</label>
        <div style="display:flex;gap:6px;">
          <input type="number" step="0.01" class="cp-perf-amt" style="width:120px;" value="${data.perf_bond_amount || 0}" placeholder="保证金金额" />
          <select class="cp-perf-status" style="width:80px;padding:4px;">
            <option value="无" ${pStatus === '无' ? 'selected' : ''}>无</option>
            <option value="未退" ${pStatus === '未退' ? 'selected' : ''}>未退</option>
            <option value="已退" ${pStatus === '已退' ? 'selected' : ''}>已退</option>
          </select>
          <input type="text" class="cp-perf-date" style="flex:1;min-width:0;" value="${escapeHtml(data.perf_bond_return_date || '')}" placeholder="应退日期 如 2027-03-31" onblur="normalizeDateInputElem(this)" />
        </div>
      </div>
      <div class="form-group span-2">
        <label>质保金 (元) / 状态 / 到期日期</label>
        <div style="display:flex;gap:6px;">
          <input type="number" step="0.01" class="cp-warranty-amt" style="width:120px;" value="${data.warranty_bond_amount || 0}" placeholder="质保金金额" />
          <select class="cp-warranty-status" style="width:80px;padding:4px;">
            <option value="无" ${wStatus === '无' ? 'selected' : ''}>无</option>
            <option value="未退" ${wStatus === '未退' ? 'selected' : ''}>未退</option>
            <option value="已退" ${wStatus === '已退' ? 'selected' : ''}>已退</option>
          </select>
          <input type="text" class="cp-warranty-date" style="flex:1;min-width:0;" value="${escapeHtml(data.warranty_bond_expiry_date || '')}" placeholder="到期日期 如 2028-03-31" onblur="normalizeDateInputElem(this)" />
        </div>
      </div>

      <div class="form-group span-4">
        <label>备注（本单位分项备注，独占一行）</label>
        <input type="text" class="cp-remark" value="${escapeHtml(data.remark || '')}" placeholder="针对该对方单位的分项补充备注（选填）" />
      </div>
    </div>
  `;
  container.appendChild(card);
}

function onTaxRateInputBlur(inputEl) {
  if (!inputEl) return;
  inputEl.value = formatSmartTaxRate(inputEl.value);
  calcExclTaxForCard(inputEl);
}

function calcExclTaxForCard(inputEl) {
  const card = inputEl.closest('.party-card');
  if (!card) return;
  const amt = parseFloat(card.querySelector('.cp-amount')?.value || '0');
  const rawTax = String(card.querySelector('.cp-tax-rate')?.value || '').trim();
  const formattedTax = formatSmartTaxRate(rawTax);
  const exclEl = card.querySelector('.cp-amount-excl');
  if (!exclEl || amt <= 0) return;

  if (!formattedTax.startsWith('*')) {
    const rateNum = parseFloat(formattedTax.replace('%', ''));
    if (!isNaN(rateNum) && rateNum >= 0) {
      exclEl.value = (amt / (1 + rateNum / 100)).toFixed(2);
    }
  }
}

function collectCounterpartiesFromDOM() {
  const cards = document.querySelectorAll('#counterparties_container .party-card');
  const arr = [];
  cards.forEach(card => {
    const perfAmt = Number(card.querySelector('.cp-perf-amt')?.value || 0);
    let perfStatus = card.querySelector('.cp-perf-status')?.value || '无';
    if (perfAmt > 0 && perfStatus === '无') perfStatus = '未退';

    const warAmt = Number(card.querySelector('.cp-warranty-amt')?.value || 0);
    let warStatus = card.querySelector('.cp-warranty-status')?.value || '无';
    if (warAmt > 0 && warStatus === '无') warStatus = '未退';

    arr.push({
      company_name: card.querySelector('.cp-company')?.value.trim() || '',
      credit_code: card.querySelector('.cp-credit')?.value.trim() || '',
      summary: card.querySelector('.cp-summary')?.value.trim() || '',
      contact_person: card.querySelector('.cp-person')?.value.trim() || '',
      contact_phone: card.querySelector('.cp-phone')?.value.trim() || '',
      bank_account_name: card.querySelector('.cp-bank-user')?.value.trim() || '',
      bank_account_no: card.querySelector('.cp-bank-no')?.value.trim() || '',
      bank_name: card.querySelector('.cp-bank-name')?.value.trim() || '',
      bank_code: card.querySelector('.cp-bank-code')?.value.trim() || '',
      amount: Number(card.querySelector('.cp-amount')?.value || 0),
      tax_rate: formatSmartTaxRate(card.querySelector('.cp-tax-rate')?.value || ''),
      amount_excl_tax: Number(card.querySelector('.cp-amount-excl')?.value || 0),
      invoice_type: card.querySelector('.cp-invoice')?.value.trim() || '增值税专用发票',
      currency: card.querySelector('.cp-currency')?.value.trim() || 'CNY',
      perf_bond_amount: perfAmt,
      perf_bond_status: perfStatus,
      perf_bond_return_date: parseSmartDateString(card.querySelector('.cp-perf-date')?.value || ''),
      warranty_bond_amount: warAmt,
      warranty_bond_status: warStatus,
      warranty_bond_expiry_date: parseSmartDateString(card.querySelector('.cp-warranty-date')?.value || ''),
      remark: card.querySelector('.cp-remark')?.value.trim() || ''
    });
  });
  return arr;
}

/**
 * 在合同表单中加载可选的采购立项：
 * 排他过滤：已经绑定了其他合同的采购立项不再显示，除非解绑后才恢复显示！
 */
async function populateProcDropdownInContractForm(selectedId = null, currentContractId = null) {
  const sel = document.getElementById('f_procurement_id');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/procurements');
    const json = await res.json();
    const list = json.data || [];

    const availableList = list.filter(p => {
      if (selectedId && Number(p.id) === Number(selectedId)) return true;
      const boundContractId = p.contract_id || (p.linked_contract && p.linked_contract.id) || null;
      if (!boundContractId) return true;
      if (currentContractId && Number(boundContractId) === Number(currentContractId)) return true;
      return false;
    });

    sel.innerHTML = `<option value="">-- 暂不关联采购立项 (已绑定的立项已自动隐藏) --</option>` + availableList.map(p => {
      const isCurrentBound = selectedId && Number(p.id) === Number(selectedId);
      return `<option value="${p.id}"
        data-name="${escapeHtml(p.project_name)}"
        data-supplier="${escapeHtml(p.supplier_name || '')}"
        data-amount="${p.deal_amount || p.budget_amount || 0}">
        ${escapeHtml(p.procurement_no)} - ${escapeHtml(p.project_name)}${isCurrentBound ? ' (当前已绑定)' : ''}
      </option>`;
    }).join('');
    sel.value = selectedId ? String(selectedId) : '';
    updateUnbindBtnVisibilityInContractForm();
  } catch (e) {}
}

function updateUnbindBtnVisibilityInContractForm() {
  const sel = document.getElementById('f_procurement_id');
  const btn = document.getElementById('btn_unbind_proc_in_form');
  if (btn && sel) {
    btn.classList.toggle('hidden', !sel.value);
  }
}

function clearLinkedProcInContractForm() {
  const sel = document.getElementById('f_procurement_id');
  if (sel) {
    sel.value = '';
    updateUnbindBtnVisibilityInContractForm();
  }
}

function onSelectLinkedProcurementInContractForm(sel) {
  updateUnbindBtnVisibilityInContractForm();
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !sel.value) return;
  const nameInput = document.getElementById('f_contract_name');
  if (nameInput && !nameInput.value.trim() && opt.dataset.name) {
    nameInput.value = opt.dataset.name;
  }
  const firstCompany = document.querySelector('#counterparties_container .cp-company');
  if (firstCompany && !firstCompany.value.trim() && opt.dataset.supplier) {
    firstCompany.value = opt.dataset.supplier;
  }
  const firstAmount = document.querySelector('#counterparties_container .cp-amount');
  if (firstAmount && !firstAmount.value && Number(opt.dataset.amount) > 0) {
    firstAmount.value = opt.dataset.amount;
    calcExclTaxForCard(firstAmount);
  }
}

async function openFormModal(editId = null) {
  applyDropdownPresetsToDOM();
  const form = document.getElementById('contract_form');
  form.reset();
  const attEl = document.getElementById('f_attachment');
  if (attEl) attEl.value = '';
  const relEl = document.getElementById('f_related_files');
  if (relEl) relEl.value = '';
  document.getElementById('counterparties_container').innerHTML = '';

  const today = getLocalTodayStr();
  const { activeLabel } = getDynamicContractStatusPair();

  if (!editId) {
    document.getElementById('form_id').value = '';
    document.getElementById('form_modal_title').textContent = '新增合同台账';
    document.getElementById('f_our_entity').value = defaultOurEntity;
    document.getElementById('f_sign_date').value = today;
    document.getElementById('f_start_date').value = today;
    document.getElementById('f_expiry_date').value = `${new Date().getFullYear() + 1}-${today.slice(5)}`;
    const rmkEl = document.getElementById('f_remark');
    if (rmkEl) rmkEl.value = '';
    setSelectValueWithFallback('f_status', activeLabel);
    document.getElementById('seg_mid_custom_input').value = contractRule.default_mid || '';
    toggleFreeContractNoMode(false);
    addCounterpartyCard();
    await populateProcDropdownInContractForm(null, null);
    await fillAutoContractNo(today);
  } else {
    const res = await apiFetch(`/api/contracts/${editId}`);
    const json = await res.json();
    if (!json.success) return;
    const c = json.data;
    document.getElementById('form_id').value = c.id;
    document.getElementById('form_modal_title').textContent = `编辑合同：${c.contract_no}`;
    toggleFreeContractNoMode(true);
    document.getElementById('f_contract_no').value = c.contract_no;
    document.getElementById('f_contract_name').value = c.contract_name;
    setSelectValueWithFallback('f_contract_type', c.contract_type);
    setSelectValueWithFallback('f_status', c.status);
    document.getElementById('f_our_entity').value = c.our_entity;
    document.getElementById('f_sign_date').value = c.sign_date;
    document.getElementById('f_start_date').value = c.start_date;
    document.getElementById('f_expiry_date').value = c.expiry_date;
    const rmkEl = document.getElementById('f_remark');
    if (rmkEl) rmkEl.value = c.remark || '';
    syncContractStatusByExpiryDate(c.expiry_date);
    const linkedProcId = c.procurement_id || (c.linked_procurement && c.linked_procurement.id) || null;
    await populateProcDropdownInContractForm(linkedProcId, c.id);
    (c.counterparties || [{}]).forEach(cp => addCounterpartyCard(cp));
  }

  document.getElementById('form_modal').classList.remove('hidden');
}

function closeFormModal() {
  document.getElementById('form_modal').classList.add('hidden');
}

async function submitContractForm(e) {
  e.preventDefault();
  if (isSubmitting) return;
  isSubmitting = true;
  const btn = document.getElementById('btn_submit_contract');
  if (btn) btn.disabled = true;

  try {
    if (!isFreeContractNoMode) syncSegmentedContractNo();
    const cleanExpiry = parseSmartDateString(document.getElementById('f_expiry_date').value);
    syncContractStatusByExpiryDate(cleanExpiry);

    const editId = document.getElementById('form_id').value;
    const fd = new FormData();
    fd.append('contract_no', document.getElementById('f_contract_no').value.trim());
    fd.append('contract_name', document.getElementById('f_contract_name').value.trim());
    fd.append('contract_type', document.getElementById('f_contract_type').value);
    fd.append('status', document.getElementById('f_status').value);
    fd.append('our_entity', document.getElementById('f_our_entity').value.trim());
    fd.append('sign_date', parseSmartDateString(document.getElementById('f_sign_date').value));
    fd.append('start_date', parseSmartDateString(document.getElementById('f_start_date').value));
    fd.append('expiry_date', cleanExpiry);
    fd.append('procurement_id', document.getElementById('f_procurement_id').value || '');
    fd.append('remark', document.getElementById('f_remark')?.value.trim() || '');
    fd.append('counterparties_json', JSON.stringify(collectCounterpartiesFromDOM()));

    const attInput = document.getElementById('f_attachment');
    if (attInput && attInput.files[0]) fd.append('attachment', attInput.files[0]);
    const relInput = document.getElementById('f_related_files');
    if (relInput && relInput.files.length > 0) {
      for (const f of relInput.files) fd.append('related_files', f);
    }

    const url = editId ? `/api/contracts/${editId}` : '/api/contracts';
    const method = editId ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: fd });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);

    closeFormModal();
    await loadContractNoRuleSettings();
    await loadContracts();
  } catch (err) {
    alert(err.message || '保存合同失败');
  } finally {
    isSubmitting = false;
    if (btn) btn.disabled = false;
  }
}

async function deleteContractRecord(id, no) {
  if (!confirm(`确定删除合同【${no}】吗？关联扫描件及附件将一并从磁盘清除，且后续年份序号自动重排对齐！`)) return;
  const res = await apiFetch(`/api/contracts/${id}`, { method: 'DELETE' });
  const json = await res.json();
  if (json.success) {
    await loadContractNoRuleSettings();
    await loadContracts();
  }
}

// ==================== 9. 采购项目立项台账主表与表单逻辑（排他过滤已绑定的合同） ====================
function buildProcQueryParams() {
  const p = new URLSearchParams();
  const kw = document.getElementById('proc_filter_kw')?.value.trim();
  const year = document.getElementById('proc_filter_year')?.value;
  const type = document.getElementById('proc_filter_type')?.value;
  const dept = document.getElementById('proc_filter_dept')?.value.trim();
  const hasC = document.getElementById('proc_filter_has_contract')?.value;
  const sortOrder = document.getElementById('proc_sort_order')?.value;

  if (kw) p.set('kw', kw);
  if (year) p.set('year', year);
  if (type) p.set('type', type);
  if (dept) p.set('dept', dept);
  if (hasC) p.set('has_contract', hasC);
  if (sortOrder) p.set('sort_order', sortOrder);
  return p;
}

async function loadProcurements() {
  try {
    const params = buildProcQueryParams();
    const res = await apiFetch(`/api/procurements?${params.toString()}`);
    const json = await res.json();
    if (!json.success) return;
    procurementsCache = json.data || [];
    renderProcurementTable(procurementsCache);
  } catch (e) {}
}

function resetProcurementFilters() {
  ['proc_filter_kw', 'proc_filter_year', 'proc_filter_type', 'proc_filter_dept', 'proc_filter_has_contract'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  loadProcurements();
}

function renderProcurementTable(list) {
  const tbody = document.getElementById('procurement_tbody');
  if (!tbody) return;
  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="19" class="text-center" style="padding:28px;color:#6b7280;">暂无采购立项记录，请点击右上角【+ 新增采购立项】开始录入</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((p, idx) => {
    const oddClass = idx % 2 === 1 ? 'proc-group-odd' : '';
    const contractHtml = p.linked_contract
      ? `<a class="link-btn" href="javascript:void(0)" onclick="openDetailModal('contract', ${p.linked_contract.id})">📄 ${escapeHtml(p.linked_contract.contract_no)}</a>`
      : (p.contract_no_manual ? `<span title="预填合同号，录入对应合同后自动绑定">${escapeHtml(p.contract_no_manual)} (待录合同)</span>` : '<span style="color:#9ca3af;">-</span>');

    const filesCount = (p.files || []).length;
    const filesHtml = filesCount > 0
      ? `<a class="related-badge-btn" href="javascript:void(0)" onclick="openDetailModal('procurement', ${p.id})">📁 立项资料×${filesCount}</a>`
      : `<a class="link-btn" style="font-size:12px;" href="javascript:void(0)" onclick="openDetailModal('procurement', ${p.id})">+ 补传资料</a>`;

    return `
      <tr class="${oddClass}">
        <td class="text-center"><span class="seq-badge">${escapeHtml(p.seq_no)}</span></td>
        <td class="text-center"><strong>${escapeHtml(p.procurement_no)}</strong></td>
        <td><a class="link-btn" href="javascript:void(0)" onclick="openDetailModal('procurement', ${p.id})">${escapeHtml(p.project_name)}</a></td>
        <td class="text-center">${escapeHtml(p.project_type)}</td>
        <td class="text-center"><strong>${escapeHtml(p.cost_department || '-')}</strong></td>
        <td class="text-right">${formatMoney(p.budget_amount)}</td>
        <td class="text-center">${escapeHtml(p.budget_subject || '-')}</td>
        <td class="text-center">${escapeHtml(p.procurement_type || '-')}</td>
        <td class="text-center">${escapeHtml(p.procurement_method || '-')}</td>
        <td class="text-center">${escapeHtml(p.approval_date || '-')}</td>
        <td class="text-center">${escapeHtml(p.decision_date || '-')}</td>
        <td class="text-center">${escapeHtml(p.completion_date || '-')}</td>
        <td>${escapeHtml(p.supplier_name || '-')}</td>
        <td class="text-right"><strong>${formatMoney(p.deal_amount)}</strong></td>
        <td class="text-center"><span class="badge badge-${escapeHtml(p.has_contract)}">${escapeHtml(p.has_contract)}</span></td>
        <td class="text-center">${contractHtml}</td>
        <td class="wrap-text-cell">${escapeHtml(p.remark || '-')}</td>
        <td class="text-center">${filesHtml}</td>
        <td class="text-center">
          <button class="btn btn-outline btn-sm" onclick="openDetailModal('procurement', ${p.id})">详情</button>
          <button class="btn btn-outline btn-sm" onclick="openProcurementFormModal(${p.id})">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="deleteProcRecord(${p.id}, '${escapeJsStr(p.procurement_no)}')">删除</button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * 在采购立项表单中加载可选的已有合同：
 * 排他过滤：已经绑定了其他采购立项的合同自动隐藏，除非解绑后才恢复显示！
 */
async function populateContractDropdownInProcForm(selectedContractId = null, currentProcId = null) {
  const sel = document.getElementById('p_contract_id');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/contracts');
    const json = await res.json();
    const list = json.data || [];

    const availableList = list.filter(c => {
      if (selectedContractId && Number(c.id) === Number(selectedContractId)) return true;
      const boundProcId = c.procurement_id || (c.linked_procurement && c.linked_procurement.id) || null;
      if (!boundProcId) return true;
      if (currentProcId && Number(boundProcId) === Number(currentProcId)) return true;
      return false;
    });

    sel.innerHTML = `<option value="">-- 暂不绑定已有合同 (已绑定的合同已自动隐藏) --</option>` + availableList.map(c => {
      const isCurrentBound = selectedContractId && Number(c.id) === Number(selectedContractId);
      return `<option value="${c.id}" data-no="${escapeHtml(c.contract_no)}">${escapeHtml(c.contract_no)} - ${escapeHtml(c.contract_name)}${isCurrentBound ? ' (当前已绑定)' : ''}</option>`;
    }).join('');
    sel.value = selectedContractId ? String(selectedContractId) : '';
    updateUnbindBtnVisibilityInProcForm();
  } catch (e) {}
}

function updateUnbindBtnVisibilityInProcForm() {
  const sel = document.getElementById('p_contract_id');
  const manual = document.getElementById('p_contract_no_manual');
  const btn = document.getElementById('btn_unbind_contract_in_form');
  if (btn) {
    const hasLink = Boolean((sel && sel.value) || (manual && manual.value.trim()));
    btn.classList.toggle('hidden', !hasLink);
  }
}

function clearLinkedContractInProcForm() {
  const sel = document.getElementById('p_contract_id');
  const manual = document.getElementById('p_contract_no_manual');
  const hasC = document.getElementById('p_has_contract');
  if (sel) sel.value = '';
  if (manual) manual.value = '';
  if (hasC) hasC.value = '否';
  updateUnbindBtnVisibilityInProcForm();
}

function onSelectLinkedContractInProcForm(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (opt && sel.value) {
    document.getElementById('p_contract_no_manual').value = opt.dataset.no || '';
    document.getElementById('p_has_contract').value = '是';
  } else {
    document.getElementById('p_contract_no_manual').value = '';
  }
  updateUnbindBtnVisibilityInProcForm();
}

async function openProcurementFormModal(editId = null) {
  applyDropdownPresetsToDOM();
  const form = document.getElementById('procurement_form');
  form.reset();
  const pfEl = document.getElementById('p_procurement_files');
  if (pfEl) pfEl.value = '';
  const today = getLocalTodayStr();
  const defaultMethod = (dropdownPresets.procurement_methods && dropdownPresets.procurement_methods[0]) || '合作谈判';

  if (!editId) {
    document.getElementById('p_form_id').value = '';
    document.getElementById('proc_form_modal_title').textContent = '🛒 新增采购项目立项台账';
    document.getElementById('p_approval_date').value = today;
    document.getElementById('p_procurement_method').value = defaultMethod;
    document.getElementById('p_seg_mid_custom_input').value = procRule.default_mid || '';
    toggleFreeProcNoMode(false);
    await populateContractDropdownInProcForm(null, null);
    await fillAutoProcurementNo(today);
  } else {
    const res = await apiFetch(`/api/procurements/${editId}`);
    const json = await res.json();
    if (!json.success) return;
    const p = json.data;
    document.getElementById('p_form_id').value = p.id;
    document.getElementById('proc_form_modal_title').textContent = `🛒 编辑采购立项：${p.procurement_no}`;
    toggleFreeProcNoMode(true);
    document.getElementById('p_procurement_no').value = p.procurement_no;
    document.getElementById('p_project_name').value = p.project_name;
    setSelectValueWithFallback('p_project_type', p.project_type);
    document.getElementById('p_cost_department').value = p.cost_department || '';
    document.getElementById('p_budget_amount').value = p.budget_amount || '';
    document.getElementById('p_budget_subject').value = p.budget_subject || '';
    setSelectValueWithFallback('p_procurement_type', p.procurement_type);
    document.getElementById('p_procurement_method').value = p.procurement_method || defaultMethod;
    document.getElementById('p_approval_date').value = p.approval_date || '';
    document.getElementById('p_decision_date').value = p.decision_date || '';
    document.getElementById('p_completion_date').value = p.completion_date || '';
    document.getElementById('p_supplier_name').value = p.supplier_name || '';
    document.getElementById('p_deal_amount').value = p.deal_amount || '';
    document.getElementById('p_has_contract').value = p.has_contract || '否';
    document.getElementById('p_contract_no_manual').value = p.contract_no_manual || '';
    document.getElementById('p_remark').value = p.remark || '';
    const linkedContractId = p.contract_id || (p.linked_contract && p.linked_contract.id) || null;
    await populateContractDropdownInProcForm(linkedContractId, p.id);
  }

  document.getElementById('proc_form_modal').classList.remove('hidden');
}

function closeProcurementFormModal() {
  document.getElementById('proc_form_modal').classList.add('hidden');
}

async function submitProcurementForm(e) {
  e.preventDefault();
  if (isSubmitting) return;
  isSubmitting = true;
  const btn = document.getElementById('btn_submit_procurement');
  if (btn) btn.disabled = true;

  try {
    if (!isFreeProcNoMode) syncSegmentedProcNo();
    const editId = document.getElementById('p_form_id').value;
    const fd = new FormData();
    fd.append('procurement_no', document.getElementById('p_procurement_no').value.trim());
    fd.append('project_name', document.getElementById('p_project_name').value.trim());
    fd.append('project_type', document.getElementById('p_project_type').value);
    fd.append('cost_department', document.getElementById('p_cost_department').value.trim());
    fd.append('budget_amount', document.getElementById('p_budget_amount').value || '0');
    fd.append('budget_subject', document.getElementById('p_budget_subject').value.trim());
    fd.append('procurement_type', document.getElementById('p_procurement_type').value);
    fd.append('procurement_method', document.getElementById('p_procurement_method').value.trim());
    fd.append('approval_date', parseSmartDateString(document.getElementById('p_approval_date').value));
    fd.append('decision_date', parseSmartDateString(document.getElementById('p_decision_date').value));
    fd.append('completion_date', parseSmartDateString(document.getElementById('p_completion_date').value));
    fd.append('supplier_name', document.getElementById('p_supplier_name').value.trim());
    fd.append('deal_amount', document.getElementById('p_deal_amount').value || '0');
    fd.append('has_contract', document.getElementById('p_has_contract').value);
    fd.append('contract_id', document.getElementById('p_contract_id').value || '');
    fd.append('contract_no_manual', document.getElementById('p_contract_no_manual').value.trim());
    fd.append('remark', document.getElementById('p_remark').value.trim());

    const fInput = document.getElementById('p_procurement_files');
    if (fInput && fInput.files.length > 0) {
      for (const f of fInput.files) fd.append('procurement_files', f);
    }

    const url = editId ? `/api/procurements/${editId}` : '/api/procurements';
    const method = editId ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: fd });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);

    closeProcurementFormModal();
    await loadProcNoRuleSettings();
    await loadProcurements();
  } catch (err) {
    alert(err.message || '保存采购立项失败');
  } finally {
    isSubmitting = false;
    if (btn) btn.disabled = false;
  }
}

async function deleteProcRecord(id, no) {
  if (!confirm(`确定删除采购立项【${no}】吗？关联立项资料文件将同步从磁盘清除！`)) return;
  const res = await apiFetch(`/api/procurements/${id}`, { method: 'DELETE' });
  const json = await res.json();
  if (json.success) {
    await loadProcNoRuleSettings();
    await loadProcurements();
  }
}

// ==================== 10. 全能详情与三大文件在线预览 / 一键解绑中心 ====================
async function unbindInDetailModal(mode, id) {
  const tip = mode === 'contract'
    ? '确定解除该合同与采购立项的绑定吗？\n解绑后，双方将恢复为未绑定状态，可在下拉列表中重新被其他记录选择。'
    : '确定解除该采购立项与合同的绑定吗？\n解绑后，双方将恢复为未绑定状态，可在下拉列表中重新被其他记录选择。';
  if (!confirm(tip)) return;

  const url = mode === 'contract'
    ? `/api/contracts/${id}/unbind-procurement`
    : `/api/procurements/${id}/unbind-contract`;

  const res = await apiFetch(url, { method: 'POST' });
  const json = await res.json();
  if (json.success) {
    await openDetailModal(mode, id);
    await loadContracts();
    await loadProcurements();
  }
}

async function quickUploadContractMainScan(contractId, inputEl) {
  if (!inputEl.files || !inputEl.files[0]) return;
  const fd = new FormData();
  fd.append('attachment', inputEl.files[0]);
  try {
    const res = await apiFetch(`/api/contracts/${contractId}/attachment`, { method: 'POST', body: fd });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);
    inputEl.value = '';
    await openDetailModal('contract', contractId);
    await loadContracts();
  } catch (err) {
    inputEl.value = '';
    alert(err.message || '上传失败');
  }
}

async function quickUploadContractRelated(contractId, inputEl) {
  if (!inputEl.files || inputEl.files.length === 0) return;
  const fd = new FormData();
  for (const f of inputEl.files) fd.append('related_files', f);
  try {
    const res = await apiFetch(`/api/contracts/${contractId}/related-files`, { method: 'POST', body: fd });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);
    inputEl.value = '';
    await openDetailModal('contract', contractId);
    await loadContracts();
  } catch (err) {
    inputEl.value = '';
    alert(err.message || '上传失败');
  }
}

async function deleteSingleContractRelatedFile(contractId, fileId) {
  if (!confirm('确认从磁盘物理删除该份附件？')) return;
  const res = await apiFetch(`/api/contracts/${contractId}/related-files/${fileId}`, { method: 'DELETE' });
  const json = await res.json();
  if (json.success) {
    await openDetailModal('contract', contractId);
    await loadContracts();
  }
}

async function quickUploadProcFilesInDetail(procId, inputEl, refreshMode = 'procurement', refreshId = null) {
  if (!inputEl.files || inputEl.files.length === 0) return;
  const fd = new FormData();
  for (const f of inputEl.files) fd.append('procurement_files', f);
  try {
    const res = await apiFetch(`/api/procurements/${procId}/files`, { method: 'POST', body: fd });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);
    inputEl.value = '';
    await openDetailModal(refreshMode, refreshId || procId);
    if (refreshMode === 'contract') await loadContracts();
    else await loadProcurements();
  } catch (err) {
    inputEl.value = '';
    alert(err.message || '上传立项资料失败');
  }
}

async function deleteSingleProcFileInDetail(procId, fileId, refreshMode = 'procurement', refreshId = null) {
  if (!confirm('确认从磁盘物理删除该份立项资料？')) return;
  const res = await apiFetch(`/api/procurements/${procId}/files/${fileId}`, { method: 'DELETE' });
  const json = await res.json();
  if (json.success) {
    await openDetailModal(refreshMode, refreshId || procId);
    if (refreshMode === 'contract') await loadContracts();
    else await loadProcurements();
  }
}

async function openDetailModal(mode, id) {
  const fieldsBox = document.getElementById('detail_fields');
  const toolbar = document.getElementById('attachment_toolbar');
  const preview = document.getElementById('preview_container');
  preview.innerHTML = '';

  if (mode === 'contract') {
    const res = await apiFetch(`/api/contracts/${id}`);
    const json = await res.json();
    if (!json.success) return;
    const c = json.data;
    document.getElementById('detail_modal_title').textContent = `📄 合同全量详情：${c.contract_no} - ${c.contract_name}`;

    const procFiles = c.linked_procurement?.files || [];
    const relFiles = c.related_files || [];

    const partiesDetailHtml = (c.counterparties || []).map((cp, i) => `
      <div style="border-top:1px dashed #cbd5e1;padding-top:6px;margin-top:6px;">
        <div style="font-weight:600;color:#1e293b;margin-bottom:3px;">乙方 #${i + 1}：${escapeHtml(cp.company_name || '-')}</div>
        <div class="detail-row"><span class="label">履约摘要</span><span class="val">${escapeHtml(cp.summary || '-')}</span></div>
        <div class="detail-row"><span class="label">信用代码 / 联系人</span><span class="val">${escapeHtml(cp.credit_code || '-')} / ${escapeHtml(cp.contact_person || '-')} (${escapeHtml(cp.contact_phone || '-')})</span></div>
        <div class="detail-row"><span class="label">收款账户名称</span><span class="val">${escapeHtml(cp.bank_account_name || '-')}</span></div>
        <div class="detail-row"><span class="label">收款银行账号</span><span class="val">${escapeHtml(cp.bank_account_no || '-')}</span></div>
        <div class="detail-row"><span class="label">开户银行 / 开户行号</span><span class="val">${escapeHtml(cp.bank_name || '-')} / ${escapeHtml(cp.bank_code || '-')}</span></div>
        <div class="detail-row"><span class="label">含税 / 不含税 / 税率</span><span class="val">${formatMoney(cp.amount)} / ${formatMoney(cp.amount_excl_tax)} / ${escapeHtml(formatSmartTaxRate(cp.tax_rate) || '-')}</span></div>
        ${cp.remark ? `<div class="detail-row"><span class="label">备注</span><span class="val">${escapeHtml(cp.remark)}</span></div>` : ''}
      </div>
    `).join('');

    fieldsBox.innerHTML = `
      <div class="detail-card">
        <h4>📌 合同基础与对方单位信息</h4>
        <div class="detail-row"><span class="label">年份序号 / 合同编号</span><span class="val">${escapeHtml(c.seq_no)} / ${escapeHtml(c.contract_no)}</span></div>
        <div class="detail-row"><span class="label">合同名称</span><span class="val">${escapeHtml(c.contract_name)}</span></div>
        <div class="detail-row"><span class="label">合同类型 / 状态</span><span class="val">${escapeHtml(c.contract_type)} / ${escapeHtml(c.status)}</span></div>
        <div class="detail-row"><span class="label">我方签约主体</span><span class="val">${escapeHtml(c.our_entity)}</span></div>
        <div class="detail-row"><span class="label">签订 / 履约 / 到期日</span><span class="val">${escapeHtml(c.sign_date)} / ${escapeHtml(c.start_date)} / ${escapeHtml(c.expiry_date)}</span></div>
        ${c.remark ? `<div class="detail-row"><span class="label">合同公共备注</span><span class="val">${escapeHtml(c.remark)}</span></div>` : ''}
        ${partiesDetailHtml}
      </div>

      <div class="detail-card">
        <h4>
          <span>① 主合同扫描件</span>
          <label class="btn btn-outline btn-sm" style="cursor:pointer;margin:0;">
            + 上传/替换扫描件
            <input type="file" accept=".pdf,.jpg,.jpeg,.png" class="hidden" onchange="quickUploadContractMainScan(${c.id}, this)" />
          </label>
        </h4>
        ${c.attachment_path
          ? `<div class="related-list-item">
               <span class="fname">${escapeHtml(c.attachment_original_name || c.attachment_path)}</span>
               <div class="factions">
                 <button class="btn btn-primary btn-sm" onclick="previewFileInBox('${escapeJsStr(c.attachment_path)}', '${escapeJsStr(c.attachment_original_name || c.attachment_path)}')">预览</button>
                 <a class="btn btn-outline btn-sm" href="${withTokenUrl(`/uploads/${encodeURI(c.attachment_path)}?download=1`)}">下载</a>
               </div>
             </div>`
          : `<div style="color:#9ca3af;">暂未上传主合同扫描件</div>`}
      </div>

      <div class="detail-card">
        <h4>
          <span>② 关联采购立项及立项资料 (${procFiles.length}份)</span>
          ${c.linked_procurement ? `
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn btn-danger btn-sm" onclick="unbindInDetailModal('contract', ${c.id})">🔓 解除绑定</button>
              <label class="btn btn-outline btn-sm" style="cursor:pointer;margin:0;">
                + 补传立项资料
                <input type="file" multiple class="hidden" onchange="quickUploadProcFilesInDetail(${c.linked_procurement.id}, this, 'contract', ${c.id})" />
              </label>
            </div>
          ` : ''}
        </h4>
        ${c.linked_procurement
          ? `<div style="margin-bottom:6px;font-weight:600;color:#6b21a8;">立项号：${escapeHtml(c.linked_procurement.procurement_no)} (${escapeHtml(c.linked_procurement.project_name)})</div>` +
            (procFiles.map(pf => `
              <div class="related-list-item">
                <span class="fname">${escapeHtml(pf.file_original_name)}</span>
                <div class="factions">
                  <button class="btn btn-primary btn-sm" onclick="previewFileInBox('${escapeJsStr(pf.file_path)}', '${escapeJsStr(pf.file_original_name)}')">预览</button>
                  <a class="btn btn-outline btn-sm" href="${withTokenUrl(`/uploads/${encodeURI(pf.file_path)}?download=1`)}">下载</a>
                  <button class="btn btn-danger btn-sm" onclick="deleteSingleProcFileInDetail(${c.linked_procurement.id}, ${pf.id}, 'contract', ${c.id})">删除</button>
                </div>
              </div>
            `).join('') || `<div style="color:#9ca3af;">该立项暂未上传附件</div>`)
          : `<div style="color:#9ca3af;">未关联采购立项</div>`}
      </div>

      <div class="detail-card">
        <h4>
          <span>③ 合同其他关联资料 (${relFiles.length}份)</span>
          <label class="btn btn-outline btn-sm" style="cursor:pointer;margin:0;">
            + 补传资料
            <input type="file" multiple class="hidden" onchange="quickUploadContractRelated(${c.id}, this)" />
          </label>
        </h4>
        ${relFiles.map(rf => `
          <div class="related-list-item">
            <span class="fname">${escapeHtml(rf.file_original_name)}</span>
            <div class="factions">
              <button class="btn btn-primary btn-sm" onclick="previewFileInBox('${escapeJsStr(rf.file_path)}', '${escapeJsStr(rf.file_original_name)}')">预览</button>
              <a class="btn btn-outline btn-sm" href="${withTokenUrl(`/uploads/${encodeURI(rf.file_path)}?download=1`)}">下载</a>
              <button class="btn btn-danger btn-sm" onclick="deleteSingleContractRelatedFile(${c.id}, ${rf.id})">删除</button>
            </div>
          </div>
        `).join('') || `<div style="color:#9ca3af;">暂无其他关联资料</div>`}
      </div>
    `;

    toolbar.innerHTML = `<span>💡 点击左侧任意文件即可在下方直接在线预览 PDF / 图片</span>`;
    if (c.attachment_path) {
      previewFileInBox(c.attachment_path, c.attachment_original_name || c.attachment_path);
    } else if (procFiles[0]) {
      previewFileInBox(procFiles[0].file_path, procFiles[0].file_original_name);
    } else if (relFiles[0]) {
      previewFileInBox(relFiles[0].file_path, relFiles[0].file_original_name);
    } else {
      preview.innerHTML = `<div class="empty-preview">暂无可预览的附件</div>`;
    }
  } else {
    const res = await apiFetch(`/api/procurements/${id}`);
    const json = await res.json();
    if (!json.success) return;
    const p = json.data;
    document.getElementById('detail_modal_title').textContent = `🛒 采购立项详情：${p.procurement_no} - ${p.project_name}`;

    const files = p.files || [];
    const hasAnyContractBind = Boolean(p.linked_contract || p.contract_id || p.contract_no_manual);

    fieldsBox.innerHTML = `
      <div class="detail-card">
        <h4>📌 采购立项核心信息</h4>
        <div class="detail-row"><span class="label">年份序号 / 立项编号</span><span class="val">${escapeHtml(p.seq_no)} / ${escapeHtml(p.procurement_no)}</span></div>
        <div class="detail-row"><span class="label">项目名称</span><span class="val">${escapeHtml(p.project_name)}</span></div>
        <div class="detail-row"><span class="label">立项类型 / 费用承担部门</span><span class="val">${escapeHtml(p.project_type)} / ${escapeHtml(p.cost_department || '-')}</span></div>
        <div class="detail-row"><span class="label">采购类型 / 采购方式</span><span class="val">${escapeHtml(p.procurement_type || '-')} / ${escapeHtml(p.procurement_method || '-')}</span></div>
        <div class="detail-row"><span class="label">预算金额 / 成交金额</span><span class="val">${formatMoney(p.budget_amount)} / ${formatMoney(p.deal_amount)}</span></div>
        <div class="detail-row"><span class="label">成交供应商</span><span class="val">${escapeHtml(p.supplier_name || '-')}</span></div>
        ${p.remark ? `<div class="detail-row"><span class="label">备注</span><span class="val">${escapeHtml(p.remark)}</span></div>` : ''}
      </div>

      <div class="detail-card">
        <h4>
          <span>📁 立项相关资料 (${files.length}份)</span>
          <label class="btn btn-outline btn-sm" style="cursor:pointer;margin:0;">
            + 补传立项资料
            <input type="file" multiple class="hidden" onchange="quickUploadProcFilesInDetail(${p.id}, this, 'procurement', ${p.id})" />
          </label>
        </h4>
        ${files.map(f => `
          <div class="related-list-item">
            <span class="fname">${escapeHtml(f.file_original_name)}</span>
            <div class="factions">
              <button class="btn btn-primary btn-sm" onclick="previewFileInBox('${escapeJsStr(f.file_path)}', '${escapeJsStr(f.file_original_name)}')">预览</button>
              <a class="btn btn-outline btn-sm" href="${withTokenUrl(`/uploads/${encodeURI(f.file_path)}?download=1`)}">下载</a>
              <button class="btn btn-danger btn-sm" onclick="deleteSingleProcFileInDetail(${p.id}, ${f.id}, 'procurement', ${p.id})">删除</button>
            </div>
          </div>
        `).join('') || `<div style="color:#9ca3af;">暂未上传立项资料</div>`}
      </div>

      <div class="detail-card">
        <h4>
          <span>📄 关联合同及扫描件直连</span>
          ${hasAnyContractBind ? `<button type="button" class="btn btn-danger btn-sm" onclick="unbindInDetailModal('procurement', ${p.id})">🔓 解除绑定</button>` : ''}
        </h4>
        ${p.linked_contract
          ? `<div style="margin-bottom:6px;font-weight:600;color:#1e40af;">已绑定合同：${escapeHtml(p.linked_contract.contract_no)} (${escapeHtml(p.linked_contract.contract_name)})</div>` +
            (p.linked_contract.attachment_path
              ? `<div class="related-list-item">
                   <span class="fname">${escapeHtml(p.linked_contract.contract_no)} 主合同扫描件</span>
                   <div class="factions">
                     <button class="btn btn-primary btn-sm" onclick="previewFileInBox('${escapeJsStr(p.linked_contract.attachment_path)}', '${escapeJsStr(p.linked_contract.contract_no)}')">预览</button>
                     <a class="btn btn-outline btn-sm" href="${withTokenUrl(`/uploads/${encodeURI(p.linked_contract.attachment_path)}?download=1`)}">下载</a>
                   </div>
                 </div>`
              : `<div style="color:#9ca3af;">该合同暂未上传主合同扫描件</div>`)
          : (p.contract_no_manual
              ? `<div style="color:#d97706;">预填待绑定合同号：${escapeHtml(p.contract_no_manual)}</div>`
              : `<div style="color:#9ca3af;">暂未关联合同</div>`)}
      </div>
    `;

    toolbar.innerHTML = `<span>💡 点击左侧文件即可在线预览</span>`;
    if (files[0]) {
      previewFileInBox(files[0].file_path, files[0].file_original_name);
    } else if (p.linked_contract?.attachment_path) {
      previewFileInBox(p.linked_contract.attachment_path, p.linked_contract.contract_no);
    } else {
      preview.innerHTML = `<div class="empty-preview">暂无可预览的资料</div>`;
    }
  }

  document.getElementById('detail_modal').classList.remove('hidden');
}

function previewFileInBox(relPath, title) {
  const box = document.getElementById('preview_container');
  if (!box) return;
  box.innerHTML = '';
  const url = withTokenUrl(`/uploads/${encodeURI(relPath)}`);
  const dlUrl = withTokenUrl(`/uploads/${encodeURI(relPath)}?download=1&filename=${encodeURIComponent(title)}`);
  const ext = (relPath.split('.').pop() || '').toLowerCase();

  if (ext === 'pdf') {
    box.innerHTML = `<iframe src="${url}"></iframe>`;
  } else if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
    box.innerHTML = `<img src="${url}" alt="${escapeHtml(title)}" />`;
  } else {
    box.innerHTML = `
      <div class="empty-preview">
        <p>文件 <strong>${escapeHtml(title)}</strong> (${ext.toUpperCase()}) 不支持直接内嵌预览</p>
        <p style="margin-top:12px;"><a class="btn btn-primary" href="${dlUrl}">📥 点击下载到本地查看</a></p>
      </div>
    `;
  }
}

function closeDetailModal() {
  document.getElementById('detail_modal').classList.add('hidden');
  const box = document.getElementById('preview_container');
  if (box) box.innerHTML = '';
}

// ==================== 11. Excel 导出动作绑定 ====================
function exportExcel(mode) {
  const params = mode === 'all' ? new URLSearchParams({ mode: 'all' }) : buildContractQueryParams();
  window.location.href = withTokenUrl(`/api/export/excel?${params.toString()}`);
}

function exportProcurementExcel(mode) {
  const params = mode === 'all' ? new URLSearchParams({ mode: 'all' }) : buildProcQueryParams();
  window.location.href = withTokenUrl(`/api/procurements/export?${params.toString()}`);
}

function exportCombinedWorkbook() {
  window.location.href = withTokenUrl('/api/export/combined');
}

// ==================== 12. 多机局域网协同：静默同步（带弹窗防打扰锁） ====================
function hasOpenModal() {
  const ids = [
    'lan_auth_overlay', 'lan_security_modal', 'presets_modal',
    'our_entity_modal', 'no_rule_modal', 'proc_no_rule_modal',
    'form_modal', 'proc_form_modal', 'detail_modal'
  ];
  return ids.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}

async function silentSyncAll() {
  if (isSilentSyncing || isSubmitting || hasOpenModal()) return;
  isSilentSyncing = true;
  try {
    await loadDropdownPresets();
    if (currentTab === 'procurement') {
      await loadProcNoRuleSettings();
      await loadProcurements();
    } else {
      await loadContractNoRuleSettings();
      await loadContracts();
    }
  } catch (e) {
  } finally {
    isSilentSyncing = false;
  }
}

window.addEventListener('focus', () => silentSyncAll());
setInterval(() => {
  if (!document.hidden) silentSyncAll();
}, 30000);

// ==================== 13. 应用启动初始化 ====================
async function initAppData() {
  await loadDropdownPresets();
  await loadOurEntitySetting();
  await loadContractNoRuleSettings();
  await loadProcNoRuleSettings();
  await loadContracts();
}

window.addEventListener('DOMContentLoaded', async () => {
  initYearDropdowns();
  const ok = await checkLanAuthStatus();
  if (ok) {
    await initAppData();
  }
});
