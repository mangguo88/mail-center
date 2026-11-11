'use strict';
/* Mail Center Phase 2 —— 单页应用：登录 / 三栏收件箱 / 读信 / 写信 / 邮箱管理 / 设置。
   所有接口见 worker/src/index.js；字段名与后端一一对应（列表键名是 list，不是 messages）。 */

// ---------- 小工具 ----------
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, ms) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, ms || 2600);
}
function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' 字节';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------- 北京时间 ----------
const dtfHM = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const dtfYMD = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const dtfYM = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' });

// 前端版本号：每次发版改这里，侧栏底部会显示出来，
// 方便确认浏览器跑的是不是最新版（旧标签页会显示旧版本号）。
const APP_VERSION = 'v34';
function parseMailDate(raw) { const t = Date.parse(raw || ''); return isNaN(t) ? 0 : t; }
// 列表里显示的时间：这封信被本站收到的时间（received_at，不是发信时间），
// 这样一眼就能看出从发信到本站收到隔了多久。老数据没有 received_at 时回落到发信时间。
function listTimeOf(m) { return (m && m.received_at) || (m && m.date) || ''; }
function fmtListDate(raw) {
  const t = parseMailDate(raw);
  if (!t) return raw || '';
  if (dtfYM.format(new Date(t)) === dtfYM.format(new Date()) && dtfYMD.format(new Date(t)) === dtfYMD.format(new Date())) return dtfHM.format(new Date(t));
  return dtfYMD.format(new Date(t));
}
function fmtFullDate(raw) {
  const t = parseMailDate(raw);
  if (!t) return raw || '';
  return dtfYMD.format(new Date(t)) + ' ' + dtfHM.format(new Date(t));
}
function fmtHM(iso) {
  const t = Date.parse(iso || '');
  return isNaN(t) ? '' : dtfHM.format(new Date(t));
}
function monthKeyOf(raw) {
  const t = parseMailDate(raw);
  return t ? dtfYM.format(new Date(t)) : 'unknown';
}
function monthLabel(key) {
  if (key === 'unknown') return '未知时间';
  const [y, m] = key.split('-').map((x) => parseInt(x, 10));
  const now = dtfYM.format(new Date()).split('-').map((x) => parseInt(x, 10));
  if (y === now[0] && m === now[1]) return '本月';
  if (y === now[0]) return m + '月';
  return y + '年' + m + '月';
}

// ---------- 分组颜色：照 PHP 版 group_color（8 色循环，crc32('grp:' + 分组名)） ----------
const GROUP_PALETTE = [
  ['#f5f5f4', '#57534e'], // 灰（未分组）
  ['#fce4ec', '#c2185b'], // 淡粉
  ['#ede7f6', '#5e35b1'], // 淡紫
  ['#e6f4ea', '#2e7d32'], // 淡绿
  ['#fff3e0', '#e65100'], // 淡橙
  ['#e3f2fd', '#1565c0'], // 淡蓝
  ['#e0f2f1', '#00796b'], // 淡青
  ['#fff8e1', '#f57f17'], // 淡黄
];
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(str) {
  const bytes = new TextEncoder().encode(str);
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function groupColor(gname) {
  return GROUP_PALETTE[crc32('grp:' + String(gname || '').trim()) % GROUP_PALETTE.length];
}
function groupIcon(gname) {
  let ch = String(gname || '').trim().charAt(0) || '?';
  if (/^[a-z]$/.test(ch)) ch = ch.toUpperCase();
  return '<span class="gicon">' + esc(ch) + '</span>';
}
function groupTagStyle(gname) {
  const [bg, fg] = groupColor(gname);
  return 'background:' + bg + ';color:' + fg;
}

// ---------- API ----------
async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...(opts || {}), headers: { 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) { goLogin(); throw new Error((data && data.err) || '请先登录。'); }
  if (!data) throw new Error('服务器没有返回内容。');
  return data;
}
async function apiOk(path, opts) {
  const d = await api(path, opts);
  if (!d.ok) throw new Error(d.err || '操作失败。');
  return d;
}
function postJson(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body || {}) });
}
function postJsonOk(path, body) {
  return apiOk(path, { method: 'POST', body: JSON.stringify(body || {}) });
}

// ---------- 全局状态 ----------
const S = {
  me: null,            // { username, display_name }
  settings: null,      // GET /api/settings
  mailboxes: [],       // GET /api/mailboxes
  groups: [],          // GET /api/groups：单独建的空分组（还没加邮箱也能先建好）
  providers: [],       // GET /api/providers：自定义厂商预设（自己加的厂商名 + 配置）
  unread: {},          // mbId -> 未读数（最新 30 封里数的，和 PHP 版一样）
  view: 'inbox',       // inbox | mailboxes | settings
  curMbId: null,
  curFolder: 'inbox',  // inbox | sent | drafts | spam | trash
  folderMap: {},       // label -> 真实文件夹名（取自 inbox 返回的 folders）
  list: [],
  listMeta: null,      // { total, cached_at, cached, store }
  listLoading: false,
  curUid: 0,
  curMsg: null,        // GET /api/message 返回体
  msgLoading: false,
  mbFilter: '',        // 邮箱管理页的分组筛选
};
const FOLDER_NAMES = { inbox: '收件箱', sent: '已发送', drafts: '草稿箱', spam: '垃圾箱', trash: '已删除' };

// 界面可调配置：默认值 = 现在的左栏 240 / 收件栏 220 / 自动刷新 30000ms。
// renderApp 开头会从 /api/status 读 CF 面板环境变量（MC_SIDEBAR_W / MC_MID_W / MC_AUTO_REFRESH_MS）
// 来覆盖，没设就用默认值；读失败也用默认值，不影响进页面。
const UI_CFG = { sidebarW: 240, midW: 220, autoRefreshMs: 30000 };

// ---------- 面板主题（调色）：主色存在 D1 settings.theme_accent，空 = 默认绿 ----------
// 浅色底/描边/深色字都由主色现算，换什么色都协调；localStorage 只做本机快速套用，服务器为准。
const THEME_DEFAULT = '#16a34a';
const THEME_PRESETS = [
  { name: '默认绿', hex: '#16a34a' },
  { name: '墨蓝', hex: '#2563eb' },
  { name: '紫罗兰', hex: '#7c3aed' },
  { name: '玫红', hex: '#db2777' },
  { name: '暖橙', hex: '#ea580c' },
  { name: '湖青', hex: '#0891b2' },
];
function themeMix(hex, white, t) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const o = white ? [255, 255, 255] : [0, 0, 0];
  return 'rgb(' + c.map((v, i) => Math.round(v * t + o[i] * (1 - t))).join(',') + ')';
}
function applyTheme(hex) {
  const base = /^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex.toLowerCase() : THEME_DEFAULT;
  const r = document.documentElement.style;
  r.setProperty('--accent', base);
  r.setProperty('--accent-soft', themeMix(base, true, 0.14));
  r.setProperty('--accent-border', themeMix(base, true, 0.3));
  r.setProperty('--accent-dark', themeMix(base, false, 0.6));
  r.setProperty('--accent-pale', themeMix(base, true, 0.06));
  try { localStorage.setItem('mc_theme', base); } catch (e) { /* ignore */ }
}
const FOLDER_ORDER = ['inbox', 'spam', 'drafts', 'sent', 'trash'];

function groupOf(mb) { return (mb.group_name || '').trim() || '未分组'; }
function groupsOf(mbs) {
  const order = [];
  const map = {};
  for (const mb of mbs) {
    const g = groupOf(mb);
    if (!map[g]) { map[g] = []; order.push(g); }
    map[g].push(mb);
  }
  return { order, map };
}
async function loadGroups() {
  const d = await apiOk('/api/groups');
  S.groups = d.groups || [];
}
async function loadProviders() {
  const d = await apiOk('/api/providers');
  S.providers = d.providers || [];
}

// 有效预设 = 内置 + 自定义（自定义同域名覆盖内置）
function allPresets() {
  const out = { ...MB_PRESETS };
  for (const pr of S.providers || []) {
    if (!pr.domain) continue;
    out[pr.domain] = { imap_host: pr.imap_host, imap_port: pr.imap_port, imap_enc: pr.imap_enc, smtp_host: pr.smtp_host, smtp_port: pr.smtp_port, smtp_enc: pr.smtp_enc, label: pr.label || pr.domain };
  }
  return out;
}

// 分组 = 邮箱带出来的分组 + 单独建的空分组（还没加邮箱也能先建好）
function allGroups() {
  const { order, map } = groupsOf(S.mailboxes);
  const out = order.map((g) => ({ name: g, count: map[g].length }));
  for (const cg of S.groups || []) {
    if (!out.some((x) => x.name === cg.name)) out.push({ name: cg.name, count: cg.count || 0 });
  }
  return out;
}

function curMailbox() { return S.mailboxes.find((m) => m.id === S.curMbId) || null; }
function lsGet(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : v; } catch (e) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function openGroups() {
  try { return JSON.parse(lsGet('mc_gopen', '[]')) || []; } catch (e) { return []; }
}
function setOpenGroups(arr) { lsSet('mc_gopen', JSON.stringify(arr)); }

// ---------- 启动 ----------
function goLogin() {
  S.me = null;
  renderLogin();
}
async function boot() {
  try { const t = localStorage.getItem('mc_theme'); if (t) applyTheme(t); } catch (e) { /* ignore */ }
  let res;
  try {
    res = await fetch('/api/me', { credentials: 'same-origin' });
  } catch (e) {
    renderLogin('连不上服务器，请检查网络后刷新。');
    return;
  }
  if (res.ok) {
    S.me = await res.json();
    renderApp();
    return;
  }
  let errMsg = '';
  try { errMsg = (await res.json()).err || ''; } catch (e) { /* ignore */ }
  if (errMsg.indexOf('还没有设置') !== -1) renderSetup();
  else renderLogin();
}
document.addEventListener('DOMContentLoaded', boot);

// ---------- 登录 / 首次设置 ----------
function loginViewHTML(setupMode, flash) {
  const title = setupMode ? '第一次使用，先设一个登录账号和站点密码。' : '一个页面管所有邮箱';
  return '<div class="login"><h1>Mail Center</h1><p>' + title + '</p>'
    + (flash ? '<div class="flash err">' + esc(flash) + '</div>' : '')
    + '<form id="authForm" autocomplete="off">'
    + (setupMode
      ? '<label>显示名称（可选）</label><input type="text" id="f_display" placeholder="芒果邮箱管理中心">'
      : '')
    + '<label>登录账号' + (setupMode ? '（以后登录用，默认 admin）' : '') + '</label>'
    + '<input type="text" id="f_user" value="admin" autocomplete="username" required>'
    + '<label>站点密码' + (setupMode ? '（至少 4 位）' : '') + '</label>'
    + '<input type="password" id="f_pass" autocomplete="' + (setupMode ? 'new-password' : 'current-password') + '" required autofocus>'
    + (setupMode
      ? '<label>再输一次站点密码</label><input type="password" id="f_pass2" autocomplete="new-password" required>'
      : '<div class="remember-row"><label style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" id="f_remember" checked> 记住我</label>'
        + '<select id="f_days"><option value="90" selected>3 个月</option><option value="180">6 个月</option><option value="365">1 年</option></select>'
        + '<span>内不用再登录（只在这台设备 / 浏览器上记住）</span></div>')
    + '<p style="margin-top:16px"><button class="btn" style="width:100%" id="authBtn">' + (setupMode ? '设置并进入' : '进入管理中心') + '</button></p>'
    + '<p class="muted">' + (setupMode
      ? '注意：站点密码忘了，存着的邮箱凭据就解不开了，要逐个重新添加。请记好。'
      : '这不是邮箱密码，也不是 QQ 授权码，是你第一次进这个页面时设的站点密码。账号默认是 admin，在设置里可以改。')
    + '</p></form></div>';
}
function renderLogin(flash) {
  document.getElementById('app').innerHTML = loginViewHTML(false, flash || '');
  wireAuthForm(false);
}
function renderSetup() {
  document.getElementById('app').innerHTML = loginViewHTML(true, '');
  wireAuthForm(true);
}
function wireAuthForm(setupMode) {
  const form = document.getElementById('authForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('authBtn');
    const user = document.getElementById('f_user').value.trim().toLowerCase() || 'admin';
    const pass = document.getElementById('f_pass').value;
    if (setupMode) {
      const pass2 = document.getElementById('f_pass2').value;
      if (pass.length < 4) { toast('站点密码至少 4 位。'); return; }
      if (pass !== pass2) { toast('两次输入的密码不一样。'); return; }
    }
    btn.disabled = true;
    btn.textContent = '请稍候…';
    try {
      let d;
      if (setupMode) {
        d = await postJson('/api/setup', { username: user, password: pass, display_name: document.getElementById('f_display').value.trim() });
        if (!d.ok) throw new Error(d.err || '设置失败。');
        S.me = { username: d.username, display_name: document.getElementById('f_display').value.trim() || '芒果邮箱管理中心' };
      } else {
        const remember = document.getElementById('f_remember').checked;
        const days = remember ? parseInt(document.getElementById('f_days').value, 10) : 0;
        d = await postJson('/api/login', { username: user, password: pass, remember_days: days });
        if (!d.ok) throw new Error(d.err || '账号或密码不对。');
        S.me = { username: d.username, display_name: d.display_name };
      }
      renderApp();
    } catch (err) {
      toast(err.message || '登录失败。');
      btn.disabled = false;
      btn.textContent = setupMode ? '设置并进入' : '进入管理中心';
    }
  });
}

// ---------- 主界面 ----------
async function renderApp() {
  document.title = (S.me.display_name || 'Mail Center') + ' · Mail Center';
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    if (d && d.config) {
      if (Number.isFinite(d.config.sidebarW) && d.config.sidebarW > 0) UI_CFG.sidebarW = d.config.sidebarW;
      if (Number.isFinite(d.config.midW) && d.config.midW > 0) UI_CFG.midW = d.config.midW;
      if (Number.isFinite(d.config.autoRefreshMs) && d.config.autoRefreshMs > 0) UI_CFG.autoRefreshMs = d.config.autoRefreshMs;
    }
  } catch (e) { /* 读不到就用默认值 */ }
  const collapsed = lsGet('mc_side_collapsed', '0') === '1';

  document.getElementById('app').innerHTML =
    '<div class="top"><div class="logo">✉</div><h1>' + esc(S.me.display_name || 'Mail Center') + '</h1>'
    + '<span class="who"><span>' + esc(S.me.username || '') + '</span><button class="btn ghost sm" id="logoutBtn">退出</button></span></div>'
    + '<div class="wrap' + (collapsed ? ' side-collapsed' : '') + '" id="wrap">'
    + '<div class="side" id="side"></div>'
    + '<div class="main" id="main"></div>'
    + '</div>';
  $('#logoutBtn').addEventListener('click', async () => {
    try { await postJson('/api/logout', {}); } catch (e) { /* ignore */ }
    goLogin();
  });
  try {
    await loadMailboxes();
  } catch (e) {
    return; // 401 时 api() 里已经跳回登录页
  }
  try { await loadGroups(); } catch (e) { S.groups = []; } // 分组表没建好也不影响主界面
  try { await loadProviders(); } catch (e) { S.providers = []; } // 厂商预设表没建好也不影响主界面
  try { const st = await apiOk('/api/settings'); if (st.theme_accent) applyTheme(st.theme_accent); } catch (e) { /* ignore */ } // 服务器存的主题为准
  renderSidebar();
  renderMain();
  startInboxAutoRefresh();
  window.addEventListener('resize', fitSideWidthSoon);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSideWidth);
}

async function loadMailboxes() {
  const d = await apiOk('/api/mailboxes');
  S.mailboxes = d.mailboxes || [];
  // TG 通知里“点开看全文”的链接带 ?mb=<邮箱id>，打开就直接选中那个邮箱。
  const wantMb = new URLSearchParams(location.search).get('mb') || '';
  if (wantMb && S.mailboxes.find((m) => m.id === wantMb)) {
    S.curMbId = wantMb;
    S.curFolder = 'inbox';
    S.curUid = 0;
    S.curMsg = null;
    return;
  }
  if (!S.curMbId || !S.mailboxes.find((m) => m.id === S.curMbId)) {
    S.curMbId = S.mailboxes.length ? S.mailboxes[0].id : null;
    S.curFolder = 'inbox';
    S.curUid = 0;
    S.curMsg = null;
  }
}

// ---------- 左栏 ----------
function renderSidebar() {
  const side = $('#side');
  const { order, map } = groupsOf(S.mailboxes);
  const open = openGroups();
  let h = '<a class="compose-btn" id="composeBtn" title="写信"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg> <span class="lbl">写信</span></a>';
  h += '<details class="mblist" open><summary class="mblist-h"><span><span class="ico ico-blue"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M22 6l-10 7L2 6"/></svg></span> 我的邮箱</span><span class="fold">▾</span></summary>';
  if (!S.mailboxes.length) {
    h += '<p class="muted" style="padding:4px 12px">还没有邮箱，点左栏「＋ 添加邮箱」加第一个吧。建议先加 QQ（用授权码）。</p>';
  }
  for (const g of order) {
    const isOpen = open.indexOf(g) !== -1;
    h += '<details class="gitem" data-group="' + esc(g) + '"' + (isOpen ? ' open' : '') + '>'
      + '<summary class="gsum" draggable="true" data-group="' + esc(g) + '">' + groupIcon(g)
      + '<span class="gtag" style="' + groupTagStyle(g) + '" title="点一下展开 / 收起这个分组的邮箱">' + esc(g) + '（' + map[g].length + '）</span><span class="fold">▾</span></summary>';
    for (const mb of map[g]) {
      const unread = S.unread[mb.id] || 0;
      h += '<a class="mb' + (mb.id === S.curMbId ? ' on' : '') + '" data-id="' + esc(mb.id) + '" data-group="' + esc(g) + '" draggable="true" title="' + esc(mb.email) + '">'
        + (unread ? '<span class="mb-unread" title="有 ' + unread + ' 封未读"></span>' : '')
        + esc(mb.email)
        + (mb.id === S.curMbId ? '<span class="cur">●</span>' : '')
        + '<span class="mb-dot" data-id="' + esc(mb.id) + '" data-email="' + esc(mb.email) + '" title="更多操作">⋮</span></a>';
    }
    h += '</details>';
  }
  h += '</details>';
  h += '<a class="mb-ico" id="mbIco" title="我的邮箱：点一下展开侧栏选邮箱"><span class="ico ico-blue"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M22 6l-10 7L2 6"/></svg></span></a>';
  h += '<a href="#" data-nav="mailboxes" class="' + (S.view === 'mailboxes' ? 'on' : '') + '"><span class="ico"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12l2 2 4-4"/></svg></span> <span class="lbl">邮箱管理</span></a>';
  h += '<a href="#" data-nav="add-mailbox" class="' + (S.view === 'add-mailbox' ? 'on' : '') + '" title="单独的添加邮箱页"><span class="ico" style="color:var(--accent);font-weight:bold">＋</span> <span class="lbl">添加邮箱</span></a>';
  h += '<a href="#" data-nav="settings" class="' + (S.view === 'settings' ? 'on' : '') + '"><span class="ico ico-violet"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 0 2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span> <span class="lbl">设置</span></a>';
  h += '<div style="margin-top:24px;padding:12px;border-top:1px solid #f5f5f4" class="muted">收信、读信、回信、转发、写信都在本站完成，不用跳去别处。</div><div class="muted" style="padding:0 12px 4px;font-size:11px">版本 ' + APP_VERSION + '</div>';
  h += '<div class="side-edge" id="sideEdge" title="拖动调整侧栏宽度，点圆钮折叠 / 展开"><button class="edge-btn" id="edgeBtn" title="折叠 / 展开侧栏">‹</button></div>';
  side.innerHTML = h;

  $('#composeBtn').addEventListener('click', () => openCompose({}));
  $('#mbIco').addEventListener('click', (e) => { e.preventDefault(); setSidebarCollapsed(false); });
  $$('#side [data-nav]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const nav = a.getAttribute('data-nav');
    if (nav === 'add-mailbox') { S.view = 'add-mailbox'; MB_EDIT_ID = ''; }
    else S.view = nav;
    renderSidebar();
    renderMain();
  }));
  // 分组展开 / 收起（只手动开关，记在浏览器里）
  $$('#side details.gitem').forEach((det) => {
    det.addEventListener('toggle', () => {
      const g = det.getAttribute('data-group');
      let openArr = openGroups();
      if (det.open) { if (openArr.indexOf(g) === -1) openArr.push(g); }
      else openArr = openArr.filter((x) => x !== g);
      setOpenGroups(openArr);
      fitSideWidthSoon();
    });
  });
  // 点邮箱行：打开它的收件箱
  $$('#side a.mb').forEach((a) => {
    a.addEventListener('click', (e) => {
      if (e.target.closest('.mb-dot')) return;
      e.preventDefault();
      selectMailbox(a.getAttribute('data-id'));
    });
  });
  // ⋮ 菜单
  $$('#side .mb-dot').forEach((dot) => {
    dot.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMbMenu(dot.getAttribute('data-id'), dot.getAttribute('data-email'), e.clientX, e.clientY);
    });
  });
  $('#edgeBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    // 刚才是按住拖动改宽度，不是点圆钮：别折叠（免得调宽度时误触收起）
    if (edgeDragged) return;
    setSidebarCollapsed(!$('#wrap').classList.contains('side-collapsed'));
  });
  // 折叠圆钮跟鼠标走：鼠标移到边线哪儿，圆钮就出现在哪儿
  $('#sideEdge').addEventListener('pointermove', (e) => {
    const btn = $('#edgeBtn');
    const side = $('#side');
    if (!btn || !side) return;
    const rect = side.getBoundingClientRect();
    let y = e.clientY - rect.top;
    const half = 12;
    if (y < half) y = half;
    if (y > rect.height - half) y = rect.height - half;
    btn.style.top = y + 'px';
  });
  wireSidebarDrag();
  wireSideResizer();
  fitSideWidthSoon();
}

function setSidebarCollapsed(collapsed) {
  $('#wrap').classList.toggle('side-collapsed', collapsed);
  lsSet('mc_side_collapsed', collapsed ? '1' : '0');
  fitSideWidthSoon();
}

// 左栏固定宽（默认 240px：刚好显示全邮箱名 1641697128@qq.com + 绿圆点实测约 237px），
// 不跟窗口/缩放走，最大 = 宽 + 40px（拖宽上限也是这个）。
// 宽度可改：CF 面板加环境变量 MC_SIDEBAR_W（改完刷新页面生效）。
// 之前用 scrollWidth 量内容宽，在某些浏览器/缩放下会失真、算出来偏大，
// 侧栏就被撑宽到 520，改固定宽最稳。
function fitSideWidth() {
  const side = $('#side');
  const wrap = $('#wrap');
  if (!side || !wrap) return;
  if (wrap.classList.contains('side-collapsed')) {
    side.style.width = ''; side.style.minWidth = ''; side.style.maxWidth = '';
    return;
  }
  const w = UI_CFG.sidebarW;
  const maxW = w + 40;
  sideFitW = maxW;
  side.style.width = w + 'px';
  side.style.minWidth = '';
  side.style.maxWidth = maxW + 'px';
}
function fitSideWidthSoon() {
  if (window.requestAnimationFrame) window.requestAnimationFrame(fitSideWidth);
  else fitSideWidth();
}

// 按住边线拖动改宽度时，松手后紧跟的 click 不要触发折叠（圆钮跟鼠标走，
// 拖宽度时鼠标正好按在圆钮上，不加这个判断一拖就收起，看起来像“偶发变窄”）。
// 拖宽用 window 级监听，不用 setPointerCapture——capture 会把松手后的 click
// 重定向到边线，圆钮的 click 就收不到，点圆钮没反应就是这么来的。
// 拖宽上限是内容宽 sideFitW（刚好显示全邮箱名），拖也拖不过它。
let edgeDragged = false;
let sideFitW = 280;
let _drag = null;
function _dragMove(e) {
  if (!_drag) return;
  _drag.moved = Math.max(_drag.moved, Math.abs(e.clientX - _drag.startX));
  const w = Math.max(200, Math.min(sideFitW, _drag.startW + (e.clientX - _drag.startX)));
  const side = $('#side');
  if (!side) return;
  side.style.width = w + 'px';
  side.style.minWidth = '200px';
  side.style.maxWidth = sideFitW + 'px';
}
function _dragUp() {
  if (!_drag) return;
  const wasDrag = _drag.moved > 4;
  _drag = null;
  window.removeEventListener('pointermove', _dragMove);
  window.removeEventListener('pointerup', _dragUp);
  if (wasDrag) {
    edgeDragged = true;
    setTimeout(() => { edgeDragged = false; }, 120);
  }
}
function wireSideResizer() {
  const edge = $('#sideEdge');
  if (!edge) return;
  edge.addEventListener('pointerdown', (e) => {
    if (window.innerWidth <= 640) return;
    if ($('#wrap').classList.contains('side-collapsed')) return; // 收起时不拖宽，点圆钮是展开
    _drag = { startX: e.clientX, startW: $('#side').getBoundingClientRect().width, moved: 0 };
    // 点在圆钮上时不 preventDefault，免得拦掉圆钮的 click；
    // 点在边线空白处才 preventDefault，防止拖动时选中文字。
    if (!e.target.closest || !e.target.closest('#edgeBtn')) e.preventDefault();
    window.removeEventListener('pointermove', _dragMove);
    window.removeEventListener('pointerup', _dragUp);
    window.addEventListener('pointermove', _dragMove);
    window.addEventListener('pointerup', _dragUp);
  });
}

// 邮箱 ⋮ 菜单：编辑 / 写信预选发件 / 复制 / 删除
function openMbMenu(mbId, email, x, y) {
  const menu = $('#mb-menu');
  menu.innerHTML =
    '<button type="button" data-act="edit">编辑</button>'
    + '<button type="button" data-act="compose">写信</button>'
    + '<button type="button" data-act="copy">复制</button>'
    + '<button type="button" data-act="del" class="del">删除</button>';
  menu.classList.add('open');
  menu.style.left = Math.min(x, window.innerWidth - 150) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
  const close = () => { menu.classList.remove('open'); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
  menu.querySelector('[data-act="edit"]').addEventListener('click', () => { close(); S.view = 'add-mailbox'; renderSidebar(); renderMain(); setTimeout(() => openMbEditor(mbId), 50); });
  menu.querySelector('[data-act="compose"]').addEventListener('click', () => { close(); openCompose({ mbId }); });
  menu.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    close();
    try { await navigator.clipboard.writeText(email); toast('已复制：' + email); }
    catch (e) { toast(email); }
  });
  menu.querySelector('[data-act="del"]').addEventListener('click', async () => {
    close();
    if (!confirm('确定删除 ' + email + ' 吗？只删管理中心里的记录，不删邮箱本身。')) return;
    try {
      await apiOk('/api/mailboxes/' + encodeURIComponent(mbId), { method: 'DELETE' });
      toast('已删除。');
      if (S.curMbId === mbId) { S.curMbId = null; S.curUid = 0; S.curMsg = null; }
      await loadMailboxes();
      renderSidebar();
      renderMain();
    } catch (err) { toast(err.message || '删除失败。'); }
  });
}

// 左栏拖动排序：拖邮箱行（可跨分组）、拖分组名（整组移动）；松手后算出新顺序写回 sort + group_name
function wireSidebarDrag() {
  let dragged = null; // { type: 'mb'|'group', id }
  $$('#side a.mb').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      dragged = { type: 'mb', id: row.getAttribute('data-id') };
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragged.id); } catch (err) { /* ignore */ }
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragged = null; $$('#side .drop-hint').forEach((x) => x.classList.remove('drop-hint')); });
    row.addEventListener('dragover', (e) => { if (dragged) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drop-hint'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop-hint'));
    row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drop-hint'); if (dragged) applySidebarDrop(dragged, { type: 'mb', id: row.getAttribute('data-id') }, e.clientY, row.getBoundingClientRect()); });
  });
  $$('#side details.gitem > summary.gsum').forEach((sum) => {
    sum.addEventListener('dragstart', (e) => {
      dragged = { type: 'group', id: sum.getAttribute('data-group') };
      sum.parentElement.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragged.id); } catch (err) { /* ignore */ }
    });
    sum.addEventListener('dragend', () => { sum.parentElement.classList.remove('dragging'); dragged = null; $$('#side .drop-hint').forEach((x) => x.classList.remove('drop-hint')); });
    sum.addEventListener('dragover', (e) => { if (dragged) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; sum.parentElement.classList.add('drop-hint'); } });
    sum.addEventListener('dragleave', () => sum.parentElement.classList.remove('drop-hint'));
    sum.addEventListener('drop', (e) => { e.preventDefault(); sum.parentElement.classList.remove('drop-hint'); if (dragged) applySidebarDrop(dragged, { type: 'group', id: sum.getAttribute('data-group') }, e.clientY, sum.getBoundingClientRect()); });
  });
}
async function applySidebarDrop(dragged, target, clientY, targetRect) {
  if (!dragged || !target) return;
  if (dragged.type === 'mb' && target.type === 'mb' && dragged.id === target.id) return;
  if (dragged.type === 'group' && target.type === 'group' && dragged.id === target.id) return;
  // 当前展示顺序：分组顺序 + 每组内的邮箱顺序
  const { order, map } = groupsOf(S.mailboxes);
  const arranged = order.map((g) => ({ group: g, ids: map[g].map((m) => m.id) }));
  const findMb = (id) => { for (const gr of arranged) { const i = gr.ids.indexOf(id); if (i !== -1) return { gr, i }; } return null; };
  if (dragged.type === 'mb') {
    const from = findMb(dragged.id);
    if (!from) return;
    from.gr.ids.splice(from.i, 1);
    let toGroup = null, toIndex = 0;
    if (target.type === 'mb') {
      const t = findMb(target.id);
      if (!t) return;
      toGroup = t.gr;
      const after = (clientY - targetRect.top) > targetRect.height / 2;
      toIndex = t.i + (after ? 1 : 0);
    } else {
      toGroup = arranged.find((gr) => gr.group === target.id);
      if (!toGroup) return;
      toIndex = toGroup.ids.length;
    }
    toGroup.ids.splice(toIndex, 0, dragged.id);
  } else {
    const gi = arranged.findIndex((gr) => gr.group === dragged.id);
    if (gi === -1) return;
    const [block] = arranged.splice(gi, 1);
    let ti = arranged.findIndex((gr) => gr.group === target.id);
    if (target.type === 'mb') {
      const t = findMb(target.id);
      ti = t ? arranged.indexOf(t.gr) : arranged.length;
    }
    if (ti === -1) ti = arranged.length;
    arranged.splice(ti, 0, block);
  }
  // 写回：sort 按展示顺序 10、20、30…，group 按所在分组
  const updates = [];
  let n = 0;
  for (const gr of arranged) {
    for (const id of gr.ids) {
      n += 1;
      const mb = S.mailboxes.find((m) => m.id === id);
      if (!mb) continue;
      const ns = n * 10;
      if (mb.sort !== ns || groupOf(mb) !== gr.group) {
        updates.push({ id, sort: ns, group_name: gr.group === '未分组' ? '' : gr.group });
      }
    }
  }
  if (!updates.length) { renderSidebar(); return; }
  try {
    await Promise.all(updates.map((u) => apiOk('/api/mailboxes/' + encodeURIComponent(u.id), { method: 'PUT', body: JSON.stringify({ sort: u.sort, group_name: u.group_name }) })));
    await loadMailboxes();
    renderSidebar();
    toast('✓ 排序已保存');
  } catch (err) {
    toast(err.message || '保存排序失败。');
    await loadMailboxes();
    renderSidebar();
  }
}

// ---------- 主区 ----------
function renderMain() {
  const main = $('#main');
  if (S.view === 'mailboxes') { renderMailboxesView(main); return; }
  if (S.view === 'add-mailbox') { renderAddMailboxView(main); return; }
  if (S.view === 'settings') { renderSettingsView(main); return; }
  renderInboxView(main);
}

function selectMailbox(mbId) {
  if (S.curMbId === mbId && S.view === 'inbox') return;
  S.curMbId = mbId;
  S.curFolder = 'inbox';
  S.curUid = 0;
  S.curMsg = null;
  S.view = 'inbox';
  renderSidebar();
  renderMain();
}

// ---------- 收件箱（三栏：列表 + 读信） ----------
function renderInboxView(main) {
  // 收件栏默认 220px：约 10 个字主题（主题占整行宽，220 - 卡片/行内边距/删除钮约 70px ≈ 150px ≈ 10 个汉字）；
  // 换 key mc_mid_w2，旧的 340 存值不再用，保证新默认生效。
  // 默认宽可改：CF 面板加环境变量 MC_MID_W（默认 220）；之前拖过的话以拖过的为准。
  const midW = parseInt(lsGet('mc_mid_w2', String(UI_CFG.midW)), 10) || UI_CFG.midW;
  main.innerHTML =
    '<div class="panes"><div class="pane-mid" id="paneMid" style="flex-basis:' + midW + 'px;width:' + midW + 'px">'
    + '<div class="card"><h2 id="inboxTitle">收件箱</h2>'
    + '<div class="folders folders-3" id="folderPills"></div>'
    + '<p class="muted" id="cacheLine"></p>'
    + '<div class="msglist" id="msgList"><p class="muted">正在取邮件…</p></div>'
    + '<div class="pager" id="pagerLine"></div>'
    + '</div></div>'
    + '<div class="resizer" id="midResizer" title="拖动调整列表宽度"></div>'
    + '<div class="pane-right"><div class="card" id="readerCard"></div></div></div>';
  wireMidResizer();
  renderReaderEmpty();
  const mb = curMailbox();
  if (!mb) {
    $('#inboxTitle').textContent = '收件箱';
    $('#msgList').innerHTML = '<p class="muted">还没有邮箱，点左栏「＋ 添加邮箱」加第一个吧。建议先加 QQ（用授权码），再加 Outlook / Gmail。</p>';
    return;
  }
  loadInbox(false);
}

function wireMidResizer() {
  const rz = $('#midResizer');
  if (!rz) return;
  let startX = 0, startW = 0, dragging = false;
  rz.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = $('#paneMid').getBoundingClientRect().width;
    rz.classList.add('drag');
    rz.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  rz.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // 拖动范围放宽到 160–800：能拉到很窄（约 6 个字）也能拉很宽，随意调。
    const w = Math.max(160, Math.min(800, startW + (e.clientX - startX)));
    const pane = $('#paneMid');
    pane.style.flexBasis = w + 'px';
    pane.style.width = w + 'px';
  });
  rz.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    rz.classList.remove('drag');
    lsSet('mc_mid_w2', String(Math.round($('#paneMid').getBoundingClientRect().width)));
  });
}

async function loadInbox(refresh, isAuto) {
  const mb = curMailbox();
  if (!mb || S.listLoading) return;
  S.listLoading = true;
  const listEl = $('#msgList');
  if (listEl && refresh) listEl.innerHTML = '<p class="muted"><span class="spin"></span> 正在取最新…</p>';
  try {
    const d = await api('/api/inbox?mb=' + encodeURIComponent(mb.id) + '&folder=' + encodeURIComponent(S.curFolder) + (refresh ? '&refresh=1' : (isAuto ? '&check=1' : '')));
    if (!d.ok) throw new Error(d.err || '取收件箱失败。');
    // 自动轮询：拿刚取回来的列表跟本页正在显示的比——不一样才重画，
    // 一样就什么都不动（不重画、不闪提示、不丢滚动位置）。
    // 不能只信服务端回的 changed：服务端缓存是多标签页共享的，别的标签页
    // 先更新了缓存，这边再问就会拿到 changed=false，明明本页还没显示新信
    // 却不重画，就得手动刷新才看得到——这就是老是要手动刷新的原因。
    if (isAuto) {
      const key = (arr) => (arr || []).map((m) => m.uid + ':' + (m.seen ? 1 : 0)).join(',');
      if (S.list && d.list && key(S.list) === key(d.list)) return;
    }
    const prevUids = new Set((S.list || []).map((m) => m.uid));
    const scrollTop = listEl ? listEl.scrollTop : 0;
    S.list = d.list || [];
    S.folderMap = d.folders || {};
    S.listMeta = { total: d.total || 0, cached_at: d.cached_at || '', cached: !!d.cached, store: d.store || '' };
    S.unread[mb.id] = S.list.filter((m) => !m.seen).length;
    renderInboxList();
    renderSidebarDots();
    if (listEl) listEl.scrollTop = scrollTop;
    // 自动轮询发现了新到的未读信：提示一声
    if (isAuto) {
      const fresh = S.list.filter((m) => !m.seen && !prevUids.has(m.uid));
      if (fresh.length) toast('收到 ' + fresh.length + ' 封新邮件');
    }
  } catch (err) {
    // 自动轮询失败不打扰（下一轮再试）；手动刷新才报出来
    if (!isAuto && listEl) listEl.innerHTML = '<div class="flash err">' + esc(err.message || '取收件箱失败。') + '</div>';
  } finally {
    S.listLoading = false;
  }
}

// ---------- 收件箱自动刷新：每 30 秒悄悄问一次有没有新邮件 ----------
// 只在收件箱页面、标签页可见时跑；切到邮箱管理/设置页、或标签页藏起来时不跑，省额度。
// 新邮件到了自动出现在列表里，不用再点 ↻ 刷新，也不用整页刷新。
let inboxTimer = null;
function startInboxAutoRefresh() {
  if (inboxTimer) return;
  inboxTimer = setInterval(() => {
    if (document.hidden) return;
    if (!$('#msgList')) return;
    loadInbox(false, true);
  }, UI_CFG.autoRefreshMs);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!$('#msgList')) return;
    loadInbox(false, true);
  });
}

function updateTitleUnread() {
  const n = Object.values(S.unread || {}).reduce((a, b) => a + (b || 0), 0);
  const base = (S.me && S.me.display_name) || 'Mail Center';
  document.title = (n ? '(' + n + ') ' : '') + base + ' · Mail Center';
}

function renderSidebarDots() {
  updateTitleUnread();
  // 只更新左栏未读圆点，不整个重画（避免拖动状态丢失）
  $$('#side a.mb').forEach((a) => {
    const id = a.getAttribute('data-id');
    const n = S.unread[id] || 0;
    let dot = a.querySelector('.mb-unread');
    if (n && !dot) {
      dot = document.createElement('span');
      dot.className = 'mb-unread';
      a.prepend(dot);
    }
    if (dot) {
      dot.title = '有 ' + n + ' 封未读';
      dot.style.display = n ? '' : 'none';
      if (!n) dot.remove();
    }
  });
}

function renderInboxList() {
  const mb = curMailbox();
  const title = $('#inboxTitle');
  if (title) title.innerHTML = esc(FOLDER_NAMES[S.curFolder] || '收件箱') + (mb ? ' <span class="muted" style="font-size:14px;font-weight:400">' + esc(mb.email) + '</span>' : '');
  // 文件夹胶囊：只显示这个邮箱有的文件夹
  const pills = $('#folderPills');
  if (pills) {
    let h = '';
    for (const label of FOLDER_ORDER) {
      if (!S.folderMap[label] && label !== S.curFolder) continue;
      h += '<a class="' + (label === S.curFolder ? 'on' : '') + '" data-folder="' + label + '">' + esc(FOLDER_NAMES[label]) + '</a>';
    }
    if (!h) h = '<a class="on" data-folder="inbox">收件箱</a>';
    // 刷新按钮
    h += '<a id="refreshBtn" title="绕过缓存，取最新">↻ 刷新</a>';
    pills.innerHTML = h;
    $$('#folderPills [data-folder]').forEach((a) => a.addEventListener('click', () => {
      if (S.curFolder === a.getAttribute('data-folder')) return;
      S.curFolder = a.getAttribute('data-folder');
      S.curUid = 0;
      S.curMsg = null;
      renderReaderEmpty();
      loadInbox(false);
    }));
    const rb = $('#refreshBtn');
    if (rb) rb.addEventListener('click', () => loadInbox(true));
  }
  const cacheLine = $('#cacheLine');
  if (cacheLine && S.listMeta) {
    cacheLine.textContent = S.listMeta.cached
      ? '缓存于 ' + fmtHM(S.listMeta.cached_at) + '（' + (S.listMeta.store === 'kv' ? '边缘缓存' : '数据库缓存') + '）'
      : '刚取的最新列表';
  }
  const pager = $('#pagerLine');
  if (pager && S.listMeta) pager.innerHTML = '<span>最新 ' + S.list.length + ' 封，共 ' + S.listMeta.total + ' 封</span>';
  const listEl = $('#msgList');
  if (!listEl) return;
  if (!S.list.length) {
    listEl.innerHTML = '<p class="muted">这个文件夹里没有邮件。</p>';
    return;
  }
  // 按月分组（新到旧）
  const groups = {};
  const order = [];
  for (const m of S.list) {
    const k = monthKeyOf(listTimeOf(m));
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(m);
  }
  const nowKey = dtfYM.format(new Date());
  let h = '';
  for (const k of order) {
    const glist = groups[k];
    h += '<details class="month"' + (k === nowKey ? ' open' : '') + '><summary>' + esc(monthLabel(k)) + '（' + glist.length + '）</summary>';
    for (const m of glist) {
      h += '<div class="mrow' + (m.seen ? '' : ' unread') + (m.uid === S.curUid ? ' on' : '') + '" data-uid="' + m.uid + '">'
        + '<a class="open"><span class="rowtop"><span class="rowleft">' + (m.seen ? '' : '<span class="dot"></span>')
        + '<span class="from">' + esc(m.from_name || m.from_addr || '(未知发件人)') + '</span></span>'
        + '<span class="rowright"><span class="date">' + esc(fmtListDate(listTimeOf(m))) + '</span></span></span>'
        + '<span class="subj">' + esc(m.subject !== '' ? m.subject : '（无主题）') + '</span>'
        + (m.snippet ? '<span class="snip">' + esc(m.snippet) + '</span>' : '')
        + '</a>'
        + (S.curFolder !== 'trash' ? '<button class="rowdel" data-del="' + m.uid + '" title="删除这封邮件">🗑</button>' : '')
        + '</div>';
    }
    h += '</details>';
  }
  listEl.innerHTML = h;
  $$('#msgList .mrow').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) return;
      openMessage(parseInt(row.getAttribute('data-uid'), 10));
    });
  });
  $$('#msgList [data-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.getAttribute('data-del'), 10);
      if (!confirm(delConfirmText())) return;
      await mailAction('/api/delete', uid);
    });
  });
}

// ---------- 读信 ----------
function renderReaderEmpty() {
  const card = $('#readerCard');
  if (!card) return;
  const mb = curMailbox();
  const isApi = mb && mb.kind !== 'imap';
  card.innerHTML = '<h2>读信</h2>'
    + '<div class="empty-reader"><div class="big">✉</div><p>点一封邮件查看。</p>'
    + '<p class="muted">支持回复、转发、标已读' + (isApi ? '、删除' : '、移到垃圾箱 / 已删除') + '。</p></div>';
}

async function openMessage(uid) {
  const mb = curMailbox();
  if (!mb || !uid || S.msgLoading) return;
  S.msgLoading = true;
  S.curUid = uid;
  $$('#msgList .mrow').forEach((r) => r.classList.toggle('on', parseInt(r.getAttribute('data-uid'), 10) === uid));
  const card = $('#readerCard');
  if (card) card.innerHTML = '<h2>读信</h2><p class="muted"><span class="spin"></span> 正在取信…</p>';
  try {
    const d = await api('/api/message?mb=' + encodeURIComponent(mb.id) + '&folder=' + encodeURIComponent(S.curFolder) + '&uid=' + uid);
    if (!d.ok) throw new Error(d.err || '打不开这封邮件。');
    S.curMsg = d;
    // 读过即标已读：列表里那行去掉未读样式，未读数 -1
    const row = S.list.find((m) => m.uid === uid);
    if (row && !row.seen) {
      row.seen = true;
      S.unread[mb.id] = Math.max(0, (S.unread[mb.id] || 1) - 1);
      renderSidebarDots();
      const rowEl = $('#msgList .mrow[data-uid="' + uid + '"]');
      if (rowEl) { rowEl.classList.remove('unread'); const dot = rowEl.querySelector('.dot'); if (dot) dot.remove(); }
    }
    renderReader();
  } catch (err) {
    if (card) card.innerHTML = '<h2>读信</h2><div class="flash err">' + esc(err.message || '打不开这封邮件。') + '</div>';
  } finally {
    S.msgLoading = false;
  }
}

function renderReader() {
  const card = $('#readerCard');
  const m = S.curMsg;
  if (!card || !m) return;
  // 收到时间取列表里那行的 received_at；和发信时间差 1 分钟以上时并列显示，方便看时间差
  const row = S.list.find((x) => x.uid === S.curUid);
  const recvAt = row && row.received_at ? row.received_at : null;
  const recvMs = recvAt ? parseMailDate(recvAt) : 0;
  const sendMs = parseMailDate(m.date);
  const timeLine = (recvAt && recvMs && sendMs && Math.abs(recvMs - sendMs) > 1000)
    ? '收到：' + esc(fmtFullDate(recvAt)) + '（发信：' + esc(fmtFullDate(m.date)) + '）'
    : '时间：' + esc(fmtFullDate(recvAt || m.date));
  const hasText = !!(m.text && m.text.trim());
  const hasHtml = !!(m.html && m.html.trim());
  const bodyMode = hasText ? 'text' : (hasHtml ? 'html' : 'text');
  const mbIsApi = curMailbox() && curMailbox().kind !== 'imap'; // 域名邮箱没有垃圾箱/已删除，不能移动；也不支持取消已读
  card.innerHTML =
    '<h2>' + esc(m.subject !== '' ? m.subject : '（无主题）') + '</h2>'
    + '<p class="reader-meta">发件人：' + esc(m.from_raw || ((m.from_name || '') + ' ' + (m.from_addr || ''))) + '<br>收件人：' + esc(m.to || '') + (m.cc ? '<br>抄送：' + esc(m.cc) : '') + '<br>' + timeLine + '</p>'
    + (hasText && hasHtml
      ? '<p><span class="seg" id="bodySeg"><button data-mode="text" class="' + (bodyMode === 'text' ? 'on' : '') + '">纯文本</button><button data-mode="html" class="' + (bodyMode === 'html' ? 'on' : '') + '">HTML 版</button></span></p>'
      : '')
    + '<div id="bodyBox"></div>'
    + (m.attachments && m.attachments.length
      ? '<h2 style="margin-top:20px">附件</h2>' + m.attachments.map((a) =>
        '<p><a href="/api/attachment?mb=' + encodeURIComponent(S.curMbId) + '&folder=' + encodeURIComponent(S.curFolder) + '&uid=' + m.uid + '&part=' + encodeURIComponent(a.part) + '">📎 ' + esc(a.filename || 'attachment') + '（' + fmtSize(a.size) + '）</a></p>').join('')
      : '')
    + '<div class="reader-actions">'
    + '<button class="btn" id="btnReply">回复</button>'
    + '<button class="btn ghost" id="btnFwd">转发</button>'
    + ((mbIsApi && isCurSeen()) ? '' : '<button class="btn ghost" id="btnFlag">' + (isCurSeen() ? '标为未读' : '标为已读') + '</button>')
    + '<span class="spacer"></span>'
    + (!mbIsApi && S.curFolder !== 'spam' ? '<button class="btn ghost" id="btnSpam">移到垃圾箱</button>' : '')
    + (!mbIsApi && S.curFolder !== 'trash' ? '<button class="btn ghost" id="btnTrash">移到已删除</button>' : '')
    + '<button class="btn danger" id="btnDel">删除</button>'
    + '</div>';
  const showBody = (mode) => {
    const box = $('#bodyBox');
    if (!box) return;
    $$('#bodySeg button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-mode') === mode));
    if (mode === 'html' && hasHtml) {
      box.innerHTML = '<iframe class="mailframe" id="mailFrame" sandbox=""></iframe>';
      const fr = $('#mailFrame');
      fr.srcdoc = m.html;
    } else {
      box.innerHTML = '<div class="mailbody">' + esc(hasText ? m.text : '（这封邮件没有纯文本正文）') + '</div>';
    }
  };
  showBody(bodyMode);
  const seg = $('#bodySeg');
  if (seg) seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) showBody(b.getAttribute('data-mode'));
  });
  $('#btnReply').addEventListener('click', () => openCompose({ replyTo: m }));
  $('#btnFwd').addEventListener('click', () => openCompose({ forwardOf: m }));
  const flagBtn = $('#btnFlag');
  if (flagBtn) flagBtn.addEventListener('click', async () => {
    const seen = !isCurSeen();
    try {
      await postJsonOk('/api/flag', { mb: S.curMbId, folder: S.curFolder, uid: S.curUid, seen });
      const row = S.list.find((x) => x.uid === S.curUid);
      if (row) row.seen = seen;
      S.unread[S.curMbId] = S.list.filter((x) => !x.seen).length;
      renderSidebarDots();
      renderInboxList();
      renderReader();
      toast(seen ? '已标为已读。' : '已标为未读。');
    } catch (err) { toast(err.message || '标记失败。'); }
  });
  const moveBtn = $('#btnSpam');
  if (moveBtn) moveBtn.addEventListener('click', async () => { if (confirm('移到垃圾箱？')) await mailAction('/api/move', S.curUid, { dest: 'spam' }); });
  const trashBtn = $('#btnTrash');
  if (trashBtn) trashBtn.addEventListener('click', async () => { if (confirm('移到已删除？')) await mailAction('/api/move', S.curUid, { dest: 'trash' }); });
  $('#btnDel').addEventListener('click', async () => { if (confirm(delConfirmText())) await mailAction('/api/delete', S.curUid); });
}
function isCurSeen() {
  const row = S.list.find((x) => x.uid === S.curUid);
  return row ? !!row.seen : true;
}
async function mailAction(path, uid, extra) {
  try {
    await postJsonOk(path, { mb: S.curMbId, folder: S.curFolder, uid, ...(extra || {}) });
    toast('已处理。');
    S.curUid = 0;
    S.curMsg = null;
    renderReaderEmpty();
    await loadInbox(true);
  } catch (err) {
    toast(err.message || '操作失败。');
  }
}

// ---------- 写信（弹窗） ----------
const MAX_SEND_BYTES = 10 * 1024 * 1024;
let CMP = null; // { mbId, mode, atts: [{filename, ctype, size, content}] }

function htmlToTextClient(html) {
  return String(html || '')
    .replace(/<(br|p|div|tr|li|h[1-6]|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); resolve(s.indexOf(',') !== -1 ? s.split(',')[1] : s); };
    r.onerror = () => reject(new Error('读文件失败'));
    r.readAsDataURL(file);
  });
}
function quoteHeader(m) {
  return '发件人：' + (m.from_raw || ((m.from_name || '') + ' ' + (m.from_addr || ''))) + '\n时间：' + (m.date || '') + '\n主题：' + (m.subject || '');
}
function openCompose(opts) {
  opts = opts || {};
  if (!S.mailboxes.length) { toast('还没有邮箱，先去「邮箱管理」添加一个。'); return; }
  const fromId = opts.mbId || S.curMbId || S.mailboxes[0].id;
  let to = opts.to || '', subject = opts.subject || '', textQ = '', htmlQ = '';
  if (opts.replyTo) {
    const m = opts.replyTo;
    to = m.from_addr || '';
    subject = /^re:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || '');
    textQ = '\n\n———— 原邮件 ————\n' + quoteHeader(m) + '\n\n' + (m.text || '');
    // 引用只用转义后的纯文本：原文 HTML 里可能带脚本，不能直接插进 contenteditable。
    htmlQ = '<br><br><div>———— 原邮件 ————<br>' + esc(quoteHeader(m)).replace(/\n/g, '<br>') + '</div><blockquote>'
      + esc(m.text || '').replace(/\n/g, '<br>') + '</blockquote>';
  } else if (opts.forwardOf) {
    const m = opts.forwardOf;
    subject = /^fwd:/i.test(m.subject || '') ? m.subject : 'Fwd: ' + (m.subject || '');
    textQ = '\n\n———— 转发的邮件 ————\n' + quoteHeader(m) + '\n收件人：' + (m.to || '') + '\n\n' + (m.text || '');
    htmlQ = '<br><br><div>———— 转发的邮件 ————<br>' + esc(quoteHeader(m)).replace(/\n/g, '<br>') + '<br>收件人：' + esc(m.to || '') + '</div><blockquote>'
      + esc(m.text || '').replace(/\n/g, '<br>') + '</blockquote>';
  }
  CMP = { mbId: fromId, mode: 'text', atts: [], textQ, htmlQ };
  const { order, map } = groupsOf(S.mailboxes);
  let fromOpts = '';
  for (const g of order) {
    fromOpts += '<optgroup label="' + esc(g) + '">';
    for (const mb of map[g]) fromOpts += '<option value="' + esc(mb.id) + '"' + (mb.id === fromId ? ' selected' : '') + '>' + esc(mb.email) + '</option>';
    fromOpts += '</optgroup>';
  }
  $('#modal-root').innerHTML =
    '<div class="modal-backdrop" id="cmpBack"><div class="modal" role="dialog" aria-label="写信">'
    + '<h2>写信</h2>'
    + '<div id="cmpErr"></div>'
    + '<label>发件邮箱</label><select id="cmpFrom">' + fromOpts + '</select>'
    + '<label>收件人（多个用逗号隔开）</label><input type="text" id="cmpTo" value="' + esc(to) + '" placeholder="如 xxx@qq.com">'
    + '<label>抄送（可选）</label><input type="text" id="cmpCc" placeholder="可选，多个用逗号隔开">'
    + '<label>主题</label><input type="text" id="cmpSubject" value="' + esc(subject) + '" placeholder="主题">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:8px"><label style="margin-bottom:0">正文</label>'
    + '<span class="seg" id="cmpSeg"><button data-mode="text" class="on">纯文本</button><button data-mode="html">富文本</button></span></div>'
    + '<div id="cmpTextWrap" style="margin-top:8px"><textarea id="cmpText" placeholder="正文（纯文本）"></textarea></div>'
    + '<div id="cmpHtmlWrap" style="display:none;margin-top:8px"><div class="rich-toolbar">'
    + '<button type="button" data-cmd="bold"><b>B</b></button><button type="button" data-cmd="italic"><i>I</i></button>'
    + '<button type="button" data-cmd="underline"><u>U</u></button><button type="button" data-cmd="createLink">链接</button>'
    + '</div><div class="rich-edit" id="cmpHtml" contenteditable="true"></div></div>'
    + '<div id="cmpAttWrap"><label>附件（总共不超过 10MB）</label>'
    + '<input type="file" id="cmpFiles" multiple style="padding:6px 0">'
    + '<ul class="att-list" id="cmpAttList"></ul></div>'
    + '<div class="modal-actions"><button class="btn" id="cmpSend">发送</button><button class="btn ghost" id="cmpCancel">取消</button>'
    + '<span class="muted" id="cmpHint">发出去的信会尽力存一份到已发送。</span></div>'
    + '</div></div>';
  $('#cmpText').value = textQ;
  $('#cmpHtml').innerHTML = htmlQ;
  $('#cmpBack').addEventListener('click', (e) => { if (e.target.id === 'cmpBack') closeCompose(); });
  $('#cmpCancel').addEventListener('click', closeCompose);
  // 域名邮箱发信不支持附件：发件邮箱换成 Henna / Cloud Mail 时把附件入口藏起来。
  const syncCmpFrom = () => {
    const mb = S.mailboxes.find((m) => m.id === $('#cmpFrom').value);
    const isApi = mb && mb.kind !== 'imap';
    const wrap = $('#cmpAttWrap');
    if (wrap) wrap.style.display = isApi ? 'none' : '';
    const hint = $('#cmpHint');
    if (hint) hint.textContent = isApi ? '域名邮箱发信不支持附件，抄送会并进收件人。' : '发出去的信会尽力存一份到已发送。';
  };
  $('#cmpFrom').addEventListener('change', syncCmpFrom);
  syncCmpFrom();
  $('#cmpSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    CMP.mode = b.getAttribute('data-mode');
    $$('#cmpSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#cmpTextWrap').style.display = CMP.mode === 'text' ? '' : 'none';
    $('#cmpHtmlWrap').style.display = CMP.mode === 'html' ? '' : 'none';
    // 切换模式时把另一份正文同步过去，避免丢内容
    if (CMP.mode === 'html' && !$('#cmpHtml').innerHTML.trim()) $('#cmpHtml').innerHTML = esc($('#cmpText').value).replace(/\n/g, '<br>');
    if (CMP.mode === 'text' && !$('#cmpText').value.trim()) $('#cmpText').value = htmlToTextClient($('#cmpHtml').innerHTML);
  });
  $$('#cmpHtmlWrap [data-cmd]').forEach((b) => b.addEventListener('click', () => {
    const cmd = b.getAttribute('data-cmd');
    const ed = $('#cmpHtml');
    ed.focus();
    if (cmd === 'createLink') {
      const url = prompt('链接地址：', 'https://');
      if (url) document.execCommand('createLink', false, url);
    } else {
      document.execCommand(cmd, false, null);
    }
  }));
  $('#cmpFiles').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      const cur = CMP.atts.reduce((s, a) => s + a.size, 0);
      if (cur + f.size > MAX_SEND_BYTES) { toast('附件总共不能超过 10MB，已跳过 ' + f.name + '。'); continue; }
      try {
        const content = await fileToBase64(f);
        CMP.atts.push({ filename: f.name, ctype: f.type || 'application/octet-stream', size: f.size, content });
      } catch (err) { toast('读附件失败：' + f.name); }
    }
    e.target.value = '';
    renderCmpAtts();
  });
  $('#cmpSend').addEventListener('click', sendCompose);
}
function renderCmpAtts() {
  const ul = $('#cmpAttList');
  if (!ul) return;
  ul.innerHTML = CMP.atts.map((a, i) =>
    '<li>📎 ' + esc(a.filename) + ' <span class="sz">（' + fmtSize(a.size) + '）</span> <button type="button" data-i="' + i + '">移除</button></li>').join('');
  $$('#cmpAttList [data-i]').forEach((b) => b.addEventListener('click', () => {
    CMP.atts.splice(parseInt(b.getAttribute('data-i'), 10), 1);
    renderCmpAtts();
  }));
}
function closeCompose() {
  $('#modal-root').innerHTML = '';
  CMP = null;
}
async function sendCompose() {
  if (!CMP) return;
  const errBox = $('#cmpErr');
  const btn = $('#cmpSend');
  const text = CMP.mode === 'text' ? $('#cmpText').value : htmlToTextClient($('#cmpHtml').innerHTML);
  const html = CMP.mode === 'html' ? $('#cmpHtml').innerHTML : '';
  const body = {
    mb: $('#cmpFrom').value,
    to: $('#cmpTo').value,
    cc: $('#cmpCc').value,
    subject: $('#cmpSubject').value,
    text, html,
    attachments: CMP.atts.map((a) => ({ filename: a.filename, ctype: a.ctype, content: a.content })),
    from_name: S.me.display_name || '',
  };
  if (!body.to.trim()) { errBox.innerHTML = '<div class="flash err">收件人没填。</div>'; return; }
  if (!text.trim() && !html.trim()) { errBox.innerHTML = '<div class="flash err">正文是空的。</div>'; return; }
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const d = await postJson('/api/send', body);
    if (!d.ok) throw new Error(d.err || '发送失败。');
    closeCompose();
    toast('已发送。');
    if (S.view === 'inbox') await loadInbox(true);
  } catch (err) {
    errBox.innerHTML = '<div class="flash err">' + esc(err.message || '发送失败。') + '</div>';
    btn.disabled = false;
    btn.textContent = '发送';
  }
}

// ---------- 邮箱管理 ----------
const MB_PRESETS = {
  'qq.com': { imap_host: 'imap.qq.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.qq.com', smtp_port: 465, smtp_enc: 'ssl', label: 'QQ邮箱' },
  '163.com': { imap_host: 'imap.163.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.163.com', smtp_port: 465, smtp_enc: 'ssl', label: '163邮箱' },
  '126.com': { imap_host: 'imap.126.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.126.com', smtp_port: 465, smtp_enc: 'ssl', label: '126邮箱' },
  'yeah.net': { imap_host: 'imap.yeah.net', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.yeah.net', smtp_port: 465, smtp_enc: 'ssl', label: 'Yeah邮箱' },
  'gmail.com': { imap_host: 'imap.gmail.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_enc: 'tls', label: 'Gmail' },
  'v.cd': { imap_host: 'smtp.mail.v.cd', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.mail.v.cd', smtp_port: 465, smtp_enc: 'ssl', label: 'DNSHE' },
  'mail.ru': { imap_host: 'imap.mail.ru', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.mail.ru', smtp_port: 465, smtp_enc: 'ssl', label: 'Mail.ru' },
  'bk.ru': { imap_host: 'imap.mail.ru', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.mail.ru', smtp_port: 465, smtp_enc: 'ssl', label: 'Mail.ru' },
  'inbox.ru': { imap_host: 'imap.mail.ru', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.mail.ru', smtp_port: 465, smtp_enc: 'ssl', label: 'Mail.ru' },
  'list.ru': { imap_host: 'imap.mail.ru', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.mail.ru', smtp_port: 465, smtp_enc: 'ssl', label: 'Mail.ru' },
};
let MB_EDIT_ID = '';

function renderMailboxesView(main) {
  const all = allGroups();
  const order = all.map((x) => x.name);
  const counts = {};
  all.forEach((x) => { counts[x.name] = x.count; });
  let h = '<div class="card"><h2>邮箱管理</h2>'
    + '<p class="muted">这里只管“有哪些邮箱、能不能连上”。要看信，点左栏「我的邮箱」里点一个邮箱直接打开；要写信，点左栏「写信」。</p>';
  h += '</div>';
  h += '<div class="card">';
  if (!S.mailboxes.length) {
    h += '<p class="muted">还没有邮箱，点左栏「＋ 添加邮箱」加第一个吧。建议先加 QQ（用授权码），再加 Outlook / Gmail。</p>';
  } else {
    h += '<div class="folders"><a class="' + (S.mbFilter === '' ? 'on' : '') + '" data-gf="">全部（' + S.mailboxes.length + '）</a>'
      + order.map((g) => '<a class="' + (S.mbFilter === g ? 'on' : '') + '" data-gf="' + esc(g) + '">' + esc(g) + '（' + counts[g] + '）</a>').join('') + '</div>'
      + '<p class="muted">' + (S.mbFilter !== '' ? '只看"' + esc(S.mbFilter) + '"分组的邮箱，点"全部"或表格里「分组」列头的 ▾ 换分组。' : '点上面某个分组，或点表格里「分组」列头的 ▾，就只列出该分组的邮箱。') + '</p>';
    h += '<div style="border:1px solid #e7e5e4;border-radius:8px;padding:12px;margin:0 0 12px"><strong>分组管理</strong> <span class="muted">改一个分组名，这个分组里的邮箱一起跟着改，不用一个个改。</span>'
      + order.map((g) => '<div style="display:flex;gap:8px;align-items:center;margin:8px 0 0;flex-wrap:wrap"><span style="width:180px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(g) + '（' + counts[g] + '）">' + esc(g) + '（' + counts[g] + '）</span><span class="muted">改成</span><input type="text" class="gname-input" data-group="' + esc(g) + '" value="' + esc(g) + '" style="width:130px;padding:6px 8px;border:1px solid #e7e5e4;border-radius:6px;font-size:14px"><button class="btn ghost sm" data-rename="' + esc(g) + '">改分组名</button>' + (g === '未分组' ? '' : ' <button class="btn danger sm" data-delgroup="' + esc(g) + '">删除分组</button>') + '</div>').join('')
      + '<div style="display:flex;gap:8px;align-items:center;margin:8px 0 0;flex-wrap:wrap"><span style="width:180px;flex:none" class="muted">新建分组</span><span class="muted" style="visibility:hidden">改成</span><input type="text" id="newGroupInput" placeholder="新分组名" style="width:130px;padding:6px 8px;border:1px solid #e7e5e4;border-radius:6px;font-size:14px"><button class="btn ghost sm" id="newGroupBtn">新建分组</button></div>'
      + '</div>';
    h += '<div class="tablewrap"><table><tr><th>邮箱</th><th><details class="gpick"><summary title="点一下按分组筛选">分组' + (S.mbFilter !== '' ? '：' + esc(S.mbFilter) : '') + ' <span class="fold">▾</span></summary><div class="gmenu">'
      + (S.mbFilter === '' ? '<span class="gcur">✓ 全部（' + S.mailboxes.length + '）</span>' : '<a href="#" data-gf="">全部（' + S.mailboxes.length + '）</a>')
      + all.map((x) => (x.name === S.mbFilter ? '<span class="gcur">✓ ' + esc(x.name) + '（' + x.count + '）</span>' : '<a href="#" data-gf="' + esc(x.name) + '">' + esc(x.name) + '（' + x.count + '）</a>')).join('')
      + '</div></details></th><th>登录方式</th><th>IMAP</th><th>状态</th><th>操作</th></tr><tbody>';
    for (const m of S.mailboxes) {
      const g = groupOf(m);
      if (S.mbFilter !== '' && g !== S.mbFilter) continue;
      const statusTag = m.status === 'ok' ? '<span class="tag ok">连接成功</span>' : (m.status === 'error' ? '<span class="tag fail">连接失败</span>' : '<span class="tag none">未测试</span>');
      const isApi = m.kind && m.kind !== 'imap';
      const kindLabel = m.kind === 'henna' ? 'Henna' : (m.kind === 'cloudmail' ? 'Cloud Mail' : m.kind);
      h += '<tr><td class="email"><strong>' + esc(m.email) + '</strong>' + (isApi ? ' <span class="tag ok">' + esc(kindLabel) + '</span>' : '') + (m.address && m.address !== m.email ? '<br><span class="muted">' + esc(m.address) + '</span>' : '') + '</td>'
        + '<td><span class="tag gtag-cell" data-mb="' + esc(m.id) + '" style="' + groupTagStyle(g) + ';cursor:pointer" title="点一下改分组">' + esc(g) + '</span></td>'
        + '<td>' + (isApi ? '面板账号' : '密码 / 授权码') + '</td>'
        + '<td class="muted">' + (isApi ? esc(String(m.panel_url || '').replace(/^https?:\/\//, '')) : esc(m.imap_host || '') + ':' + (m.imap_port || '')) + '</td>'
        + '<td class="err">' + statusTag + '<br><button class="btn ghost sm" data-test="' + esc(m.id) + '" style="margin-top:6px">测试连接</button></td>'
        + '<td style="white-space:nowrap"><button class="btn ghost sm" data-edit="' + esc(m.id) + '">编辑</button> <button class="btn danger sm" data-del="' + esc(m.id) + '">删除</button></td></tr>';
    }
    h += '</tbody></table></div>';
    h += '<p class="muted">拖动左栏邮箱可以调换顺序，左栏拖完自动保存。</p>';
  }
  h += '</div>';

  main.innerHTML = h;
  // 分组筛选
  $$('#main [data-gf]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); S.mbFilter = a.getAttribute('data-gf'); renderMailboxesView(main); }));
  // 改分组名
  $$('#main [data-rename]').forEach((b) => b.addEventListener('click', async () => {
    const oldG = b.getAttribute('data-rename');
    const input = $('#main .gname-input[data-group="' + CSS.escape(oldG) + '"]');
    const newG = input ? input.value.trim() : '';
    if (!newG || newG === oldG) { toast('分组名没变。'); return; }
    b.disabled = true;
    try {
      await apiOk('/api/groups/' + encodeURIComponent(oldG), { method: 'PUT', body: JSON.stringify({ new_name: newG }) });
      await loadMailboxes();
      await loadGroups();
      renderSidebar();
      renderMailboxesView(main);
      toast('分组已改名。');
    } catch (err) { toast(err.message || '改名失败。'); b.disabled = false; }
  }));
  // 新建分组
  const ngBtn = $('#newGroupBtn');
  if (ngBtn) ngBtn.addEventListener('click', async () => {
    const input = $('#newGroupInput');
    const name = input ? input.value.trim() : '';
    if (!name) { toast('先填分组名。'); return; }
    ngBtn.disabled = true;
    try {
      await apiOk('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
      await loadGroups();
      renderMailboxesView(main);
      toast('分组已加上。');
    } catch (err) { toast(err.message || '新建分组失败。'); ngBtn.disabled = false; }
  });
  // 删除分组：有邮箱的也能删，里面的邮箱移到“未分组”（后端会一起办）。
  $$('#main [data-delgroup]').forEach((b) => b.addEventListener('click', async () => {
    const g = b.getAttribute('data-delgroup');
    const n = (all.find((x) => x.name === g) || {}).count || 0;
    if (n > 0) {
      if (!confirm('分组"' + g + '"里还有 ' + n + ' 个邮箱，删除后这些邮箱会移到"未分组"，确定删除吗？')) return;
    } else if (!confirm('删除分组"' + g + '"吗？这个分组里没有邮箱。')) return;
    try {
      await apiOk('/api/groups/' + encodeURIComponent(g), { method: 'DELETE' });
      await loadMailboxes();
      await loadGroups();
      if (S.mbFilter === g) S.mbFilter = '';
      renderSidebar();
      renderMailboxesView(main);
      toast('分组已删除。');
    } catch (err) { toast(err.message || '删除失败。'); }
  }));
  // 表格内改分组（点标签变输入框）
  $$('#main .gtag-cell').forEach((tag) => tag.addEventListener('click', () => {
    const mbId = tag.getAttribute('data-mb');
    const mb = S.mailboxes.find((m) => m.id === mbId);
    if (!mb) return;
    const cell = tag.parentElement;
    cell.innerHTML = '<input type="text" value="' + esc(groupOf(mb)) + '" style="width:120px;padding:4px 8px" id="gEditInput"> <button class="btn ghost sm" id="gEditSave">保存</button>';
    const input = $('#gEditInput');
    input.focus();
    input.select();
    $('#gEditSave').addEventListener('click', async () => {
      const ng = input.value.trim();
      try {
        await apiOk('/api/mailboxes/' + encodeURIComponent(mbId), { method: 'PUT', body: JSON.stringify({ group_name: ng }) });
        await loadMailboxes();
        renderSidebar();
        renderMailboxesView(main);
        toast('分组已改。');
      } catch (err) { toast(err.message || '改分组失败。'); }
    });
  }));
  // 测试 / 编辑 / 删除
  $$('#main [data-test]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-test');
    b.disabled = true;
    b.textContent = '测试中…';
    try {
      await postJsonOk('/api/mailboxes/' + encodeURIComponent(id) + '/test', {});
      toast('连接成功。');
      await loadMailboxes();
      renderMailboxesView(main);
    } catch (err) {
      toast(err.message || '连接失败。');
      b.disabled = false;
      b.textContent = '测试连接';
    }
  }));
  $$('#main [data-edit]').forEach((b) => b.addEventListener('click', () => {
    S.view = 'add-mailbox';
    renderSidebar();
    renderMain();
    setTimeout(() => openMbEditor(b.getAttribute('data-edit')), 50);
  }));
  $$('#main [data-del]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-del');
    const mb = S.mailboxes.find((m) => m.id === id);
    if (!confirm('确定删除 ' + (mb ? mb.email : '') + ' 吗？只删管理中心里的记录，不删邮箱本身。')) return;
    try {
      await apiOk('/api/mailboxes/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('已删除。');
      if (S.curMbId === id) { S.curMbId = null; S.curUid = 0; S.curMsg = null; }
      await loadMailboxes();
      renderSidebar();
      renderMailboxesView(main);
    } catch (err) { toast(err.message || '删除失败。'); }
  }));
}


// 添加邮箱独立页（照 S00 的做法：单独一页，不嵌在管理页下面）。
// 新加和编辑共用一张表单：MB_EDIT_ID 为空是新加，不为空是改登录方式 / 凭据。
// 邮箱类型三选：普通邮箱走 IMAP/SMTP；Henna / Cloud Mail 域名邮箱没有 IMAP/SMTP，
// 走面板 HTTP 接口，只填面板地址 + 登录账号 + 面板密码。
function mbFormHtml(order, isEdit) {
  return '<div class="card"><h2 id="mbFormTitle">' + (isEdit ? '修改登录方式 / 凭据' : '添加邮箱') + '</h2>'
    + '<p class="muted">先选邮箱类型，再填凭据。保存时先测连接，通了才存。授权码粘贴时带了空格会自动去掉。</p>'
    + '<div id="mbFormErr"></div>'
    + '<form id="mbForm" autocomplete="off">'
    + '<label>邮箱类型</label><span class="seg" id="mb_kind_seg"><button type="button" data-kind="imap" class="on">普通邮箱（IMAP）</button><button type="button" data-kind="henna">Henna 域名邮箱</button><button type="button" data-kind="cloudmail">Cloud Mail 域名邮箱</button></span>'
    + '<div id="mb_email_wrap"><label>邮箱地址</label><input type="email" id="mb_email" placeholder="如 xxx@qq.com" autocomplete="off" required></div>'
    + '<div id="mb_api_sec" style="display:none">'
    + '<label>面板地址</label><input type="text" id="mb_panel_url" placeholder="https://你的域名邮箱面板地址" autocomplete="off">'
    + '<label>登录账号</label><input type="text" id="mb_panel_login" placeholder="登面板用的账号（一般是邮箱地址）" autocomplete="off">'
    + '<label>面板登录密码</label>'
    + '<div style="display:flex;gap:8px;align-items:center"><input type="password" id="mb_panel_pass" placeholder="登面板用的密码" autocomplete="new-password" style="flex:1"><button type="button" class="btn ghost sm" id="mb_panel_pass_toggle" style="white-space:nowrap">👁 显示</button></div>'
    + '<p class="muted" id="mb_api_note">域名邮箱没有 IMAP/SMTP，邮件存在面板自己的数据库里，这里走面板的 HTTP 接口收发。一条记录只管一个邮箱地址。</p>'
    + '</div>'
    + '<div id="mb_imap_sec">'
    + '<label id="mb_provider_label">厂商 / 域名（选了自动填服务器，也可手动改）</label><div id="mb_provider_wrap"><select id="mb_provider">'
    + '<option value="">按邮箱地址自动识别</option>'
    + [...new Map(Object.entries(allPresets()).map(([d, p]) => [p.label, d]))].map(([label, d]) => '<option value="' + d + '">' + esc(label) + '</option>').join('')
    + '<option value="custom">自定义服务器</option></select><input type="text" id="mb_provider_name" placeholder="厂商名称，如 我的企业邮" autocomplete="off" style="display:none;width:100%"></div>'
    + '<div id="mb_provider_back" style="display:none;margin-top:6px"><a href="#" id="mb_provider_back_link" style="font-size:13px">‹ 返回选择厂商</a></div>'
    + '<label>登录方式（二选一）</label>'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap">'
    + '<label data-method="authcode" style="flex:1;min-width:220px;border:1px solid var(--accent);background:var(--accent-pale);border-radius:8px;padding:10px 12px;cursor:pointer;display:block"><input type="radio" name="mb_method" value="authcode" checked> <b>授权码登入（推荐）</b><br><small class="muted">QQ 只有这一种能用；Gmail / Outlook 开了两步验证后也要用它。去邮箱官网生成授权码 / 应用专用密码。</small></label>'
    + '<label data-method="password" style="flex:1;min-width:220px;border:1px solid #e7e5e4;border-radius:8px;padding:10px 12px;cursor:pointer;display:block"><input type="radio" name="mb_method" value="password"> <b>密码登入</b><br><small class="muted">平时登录邮箱的密码。QQ / Gmail / Outlook 开了两步验证后，服务器通常会拒收，报认证失败。</small></label>'
    + '</div>'
    + '<label>密码 / 授权码 <span class="kv-note" id="mb_pass_hint">QQ 填授权码，Gmail 填应用专用密码</span></label>'
    + '<div style="display:flex;gap:8px;align-items:center"><input type="password" id="mb_pass" placeholder="16 位授权码 / 应用专用密码" autocomplete="new-password" style="flex:1" required><button type="button" class="btn ghost sm" id="mb_pass_toggle" style="white-space:nowrap">👁 显示</button></div>'
    + '<div class="form-grid3">'
    + '<div><label>IMAP 服务器</label><input type="text" id="mb_imap_host" placeholder="imap.qq.com"></div>'
    + '<div><label>IMAP 端口</label><input type="number" id="mb_imap_port" value="993"></div>'
    + '<div><label>IMAP 加密</label><select id="mb_imap_enc"><option value="ssl">SSL</option><option value="tls">STARTTLS</option></select></div>'
    + '<div><label>SMTP 服务器</label><input type="text" id="mb_smtp_host" placeholder="smtp.qq.com"></div>'
    + '<div><label>SMTP 端口</label><input type="number" id="mb_smtp_port" value="587"></div>'
    + '<div><label>SMTP 加密</label><select id="mb_smtp_enc"><option value="tls">STARTTLS</option><option value="ssl">SSL</option></select></div>'
    + '</div>'
    + '<details class="mb-adv"><summary>高级设置：IMAP 登录账号（一般不用展开）</summary>'
    + '<label>IMAP 登录账号 <span class="kv-note">留空就用邮箱地址。极少数邮箱的登录名和邮箱地址不一样（比如用工号 / 单独账号登录的企业邮），才需要填；要填就填完整邮箱地址，不能只填 QQ 号（QQ 会报 Please input email address）</span></label><input type="text" id="mb_login_user" placeholder="默认和邮箱地址一样" autocomplete="off">'
    + '</details>'
    + '</div>'
    + '<label>分组</label><div class="row"><div><select id="mb_group">' + order.map((g) => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join('') + '<option value="__new__">新建分组…</option></select></div>'
    + '<div id="mb_newgroup_wrap" style="display:none"><input type="text" id="mb_newgroup" placeholder="新分组名"></div></div>'
    + '<p style="margin-top:16px"><button class="btn" id="mbSaveBtn">' + (isEdit ? '保存修改' : '保存邮箱') + '</button> <button type="button" class="btn ghost" id="mbCancelBtn">' + (isEdit ? '取消编辑' : '返回邮箱管理') + '</button></p>'
    + '</form></div>';
}

function renderAddMailboxView(main) {
  const all = allGroups();
  const order = all.map((x) => x.name);
  main.innerHTML = mbFormHtml(order, !!MB_EDIT_ID);
  wireMbForm();
  const em = $('#mb_email');
  if (em && !MB_EDIT_ID) em.focus();
}

function openMbEditor(mbId) {
  const mb = S.mailboxes.find((m) => m.id === mbId);
  if (!mb) return;
  MB_EDIT_ID = mbId;
  const title = $('#mbFormTitle');
  if (title) title.textContent = '修改登录方式 / 凭据';
  $('#mb_email').value = mb.email || '';
  $('#mb_pass').value = '';
  $('#mb_pass').required = false;
  $('#mb_pass').placeholder = '留空不改';
  $('#mb_pass_hint').textContent = '留空就是不改密码 / 授权码';
  const gsel = $('#mb_group');
  const g = groupOf(mb);
  if (!Array.from(gsel.options).some((o) => o.value === g)) {
    const o = document.createElement('option');
    o.value = g; o.textContent = g;
    gsel.appendChild(o);
  }
  gsel.value = g;
  const kind = (mb.kind === 'henna' || mb.kind === 'cloudmail') ? mb.kind : 'imap';
  syncKindUI(kind);
  if (kind !== 'imap') {
    // 域名邮箱：填面板地址 + 登录账号，密码留空不改。
    $('#mb_panel_url').value = mb.panel_url || '';
    $('#mb_panel_login').value = mb.panel_login || mb.login_user || '';
    $('#mb_panel_pass').value = '';
    $('#mb_panel_pass').required = false;
    $('#mb_panel_pass').placeholder = '留空不改';
  } else {
    // 编辑时厂商下拉也按邮箱域名显示对应厂商（未知域名切自定义，原位改厂商名）
    const domain = ((mb.email || '').split('@')[1] || '').toLowerCase();
    if (allPresets()[domain]) {
      $('#mb_provider').value = domain;
      setProviderMode('select');
    } else if (domain) {
      $('#mb_provider').value = 'custom';
      const prov = (S.providers || []).find((p) => p.domain === domain);
      $('#mb_provider_name').value = prov ? prov.label : '';
      setProviderMode('custom');
    }
    // 这条记录本来就有单独的登录账号时，把高级设置展开，免得看不见。
    const adv = $('#mb_login_user').closest('details');
    if (adv) adv.open = !!(mb.login_user && mb.login_user !== mb.email);
    $('#mb_imap_host').value = mb.imap_host || '';
    $('#mb_imap_port').value = mb.imap_port || 993;
    $('#mb_imap_enc').value = mb.imap_enc || 'ssl';
    $('#mb_smtp_host').value = mb.smtp_host || '';
    $('#mb_smtp_port').value = mb.smtp_port || 587;
    $('#mb_smtp_enc').value = mb.smtp_enc || 'tls';
    $('#mb_login_user').value = (mb.login_user && mb.login_user !== mb.email) ? mb.login_user : '';
  }
  $('#mbSaveBtn').textContent = '保存修改';
  const cancelBtn = $('#mbCancelBtn');
  if (cancelBtn) { cancelBtn.style.display = ''; cancelBtn.textContent = '取消编辑'; }
  $('#mb_email').focus();
}

// 邮箱凭据归一化（和后端 normalizeMbPass 一致）：授权码粘贴带空格时自动去掉。
function normMbPass(p) {
  const t = String(p || '').trim();
  const squashed = t.replace(/\s+/g, '');
  return /^[A-Za-z0-9]{16}$/.test(squashed) ? squashed : t;
}

// 域名邮箱的默认面板地址（添加页选类型时自动填好，自己改过的地址不覆盖）。
const API_PANELS = { henna: 'https://email.070605.xyz/', cloudmail: 'https://cfmail.151819.xyz/' };

// 当前表单选的邮箱类型（imap / henna / cloudmail）。
function mbKind() {
  const b = document.querySelector('#mb_kind_seg button.on');
  return b ? b.getAttribute('data-kind') : 'imap';
}

// 邮箱类型切换：域名邮箱显示面板地址 + 登录账号 + 面板密码，藏起 IMAP 那套；
// 普通邮箱反过来。面板地址默认填好，换类型时也跟着换（自己改过的地址不覆盖）。
// 域名邮箱时“邮箱地址”栏移到面板登录密码下面；普通邮箱时放回类型选择下面。
function syncKindUI(kind) {
  $$('#mb_kind_seg button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-kind') === kind));
  const isApi = kind !== 'imap';
  const apiSec = $('#mb_api_sec');
  const imapSec = $('#mb_imap_sec');
  if (apiSec) apiSec.style.display = isApi ? '' : 'none';
  if (imapSec) imapSec.style.display = isApi ? 'none' : '';
  const emWrap = $('#mb_email_wrap');
  if (emWrap) {
    if (isApi) {
      const note = $('#mb_api_note');
      if (apiSec && note && note.parentElement === apiSec) apiSec.insertBefore(emWrap, note);
    } else if (apiSec && apiSec.parentElement) {
      apiSec.parentElement.insertBefore(emWrap, apiSec);
    }
  }
  const mp = $('#mb_pass');
  const pp = $('#mb_panel_pass');
  if (isApi) {
    const def = API_PANELS[kind] || '';
    const inp = $('#mb_panel_url');
    if (inp) {
      const otherDef = kind === 'henna' ? API_PANELS.cloudmail : API_PANELS.henna;
      if (!inp.value.trim() || inp.value.trim() === otherDef) inp.value = def;
    }
    if (pp) pp.required = !MB_EDIT_ID;
    if (mp) mp.required = false;
  } else {
    if (pp) pp.required = false;
    if (mp) mp.required = !MB_EDIT_ID;
  }
}

// 厂商下拉 / 厂商名原位切换：选“自定义服务器”后，下拉直接变成厂商名输入框，
// 名字就在原来下拉的地方填，不再下方另弹一个输入栏。
function setProviderMode(mode) {
  const sel = $('#mb_provider');
  const name = $('#mb_provider_name');
  const back = $('#mb_provider_back');
  const label = $('#mb_provider_label');
  if (!sel || !name) return;
  if (mode === 'custom') {
    sel.style.display = 'none';
    name.style.display = '';
    if (back) back.style.display = '';
    if (label) label.textContent = '厂商名称（自己起一个，保存后下次自动记住）';
    name.focus();
  } else {
    sel.style.display = '';
    name.style.display = 'none';
    if (back) back.style.display = 'none';
    if (label) label.textContent = '厂商 / 域名（选了自动填服务器，也可手动改）';
  }
}

// 列表/读信里删除的确认文案：Henna 没有已删除，删了找不回来，要说清楚。
function delConfirmText() {
  const mb = curMailbox();
  if (mb && mb.kind === 'henna') return '删除这封邮件？Henna 没有已删除，删了找不回来。';
  if (mb && mb.kind === 'cloudmail') return '删除这封邮件？';
  return '删除这封邮件？（有已删除文件夹就移过去，没有就直接删）';
}

function wireMbForm() {
  const form = $('#mbForm');
  if (!form) return;
  const fillServers = (p) => {
    if (!p) return;
    $('#mb_imap_host').value = p.imap_host;
    $('#mb_imap_port').value = p.imap_port;
    $('#mb_imap_enc').value = p.imap_enc;
    $('#mb_smtp_host').value = p.smtp_host;
    $('#mb_smtp_port').value = p.smtp_port;
    $('#mb_smtp_enc').value = p.smtp_enc;
  };
  const applyEmailPreset = (onBlur) => {
    if (mbKind() !== 'imap') return; // 域名邮箱不走厂商预设
    const email = $('#mb_email').value.trim();
    const domain = (email.split('@')[1] || '').toLowerCase();
    const preset = allPresets()[domain];
    if (preset) {
      $('#mb_provider').value = domain;
      fillServers(preset);
      setProviderMode('select');
    } else if (onBlur && domain) {
      // 离框时这个域名还没有预设：切到自定义服务器，填个厂商名就能记住，下次不用再填。
      $('#mb_provider').value = 'custom';
      setProviderMode('custom');
    }
  };
  $('#mb_email').addEventListener('input', () => applyEmailPreset(false));
  $('#mb_email').addEventListener('change', () => applyEmailPreset(true));
  $('#mb_provider').addEventListener('change', () => {
    const v = $('#mb_provider').value;
    if (v === 'custom') { setProviderMode('custom'); return; }
    setProviderMode('select');
    if (v) fillServers(allPresets()[v]);
  });
  $('#mb_provider_back_link').addEventListener('click', (e) => {
    e.preventDefault();
    $('#mb_provider').value = '';
    setProviderMode('select');
    applyEmailPreset(false);
  });
  // 邮箱类型三选：切到域名邮箱就显示面板地址 + 登录账号 + 面板密码。
  $$('#mb_kind_seg button').forEach((b) => b.addEventListener('click', () => syncKindUI(b.getAttribute('data-kind'))));
  syncKindUI('imap');
  $('#mb_group').addEventListener('change', () => {
    const v = $('#mb_group').value;
    $('#mb_newgroup_wrap').style.display = v === '__new__' ? '' : 'none';
    if (v && v !== '__new__' && mbKind() === 'imap') {
      // 选一个已有分组，服务器按这个分组里邮箱用的那套自动填
      const first = S.mailboxes.find((m) => groupOf(m) === v);
      if (first) fillServers({ imap_host: first.imap_host, imap_port: first.imap_port, imap_enc: first.imap_enc, smtp_host: first.smtp_host, smtp_port: first.smtp_port, smtp_enc: first.smtp_enc });
    }
  });
  const syncMethodUI = () => {
    const m = (document.querySelector('input[name="mb_method"]:checked') || {}).value || 'authcode';
    $$('#mbForm [data-method]').forEach((lb) => {
      const on = lb.getAttribute('data-method') === m;
      lb.style.borderColor = on ? 'var(--accent)' : '#e7e5e4';
      lb.style.background = on ? 'var(--accent-pale)' : '';
    });
    const hint = $('#mb_pass_hint');
    const passInput = $('#mb_pass');
    if (m === 'password') {
      if (hint) hint.textContent = '平时登录邮箱的密码';
      if (passInput) passInput.placeholder = '登录邮箱的密码';
    } else {
      if (hint) hint.textContent = 'QQ 填授权码，Gmail 填应用专用密码';
      if (passInput) passInput.placeholder = '16 位授权码 / 应用专用密码';
    }
  };
  $$('input[name="mb_method"]').forEach((r) => r.addEventListener('change', syncMethodUI));
  syncMethodUI();
  $('#mb_pass_toggle').addEventListener('click', () => {
    const inp = $('#mb_pass');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#mb_pass_toggle').textContent = show ? '🙈 隐藏' : '👁 显示';
  });
  $('#mb_panel_pass_toggle').addEventListener('click', () => {
    const inp = $('#mb_panel_pass');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#mb_panel_pass_toggle').textContent = show ? '🙈 隐藏' : '👁 显示';
  });
  $('#mbCancelBtn').addEventListener('click', () => {
    MB_EDIT_ID = '';
    S.view = 'mailboxes';
    renderSidebar();
    renderMain();
  });
  // 记住厂商配置：新加的自定义厂商，或改过已知预设的服务器配置。记不住不影响邮箱已保存。
  const rememberProviderIfNeeded = async (rp) => {
    if (!rp) return;
    try {
      await apiOk('/api/providers', { method: 'POST', body: JSON.stringify(rp) });
      await loadProviders();
    } catch (e) { /* ignore */ }
  };
  // 报错提示不用刷新页面就能去掉：点一下提示就消失，改表单内容也自动清掉。
  const errBox0 = $('#mbFormErr');
  if (errBox0) errBox0.addEventListener('click', () => { errBox0.innerHTML = ''; });
  form.addEventListener('input', () => {
    const eb = $('#mbFormErr');
    if (eb) eb.innerHTML = '';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#mbFormErr');
    if (errBox) errBox.innerHTML = '';
    const btn = $('#mbSaveBtn');
    const email = $('#mb_email').value.trim();
    const kind = mbKind();
    let group = $('#mb_group').value;
    if (group === '__new__') group = $('#mb_newgroup').value.trim();
    const flashErr = (msg) => { errBox.innerHTML = '<div class="flash err" title="点一下去掉这条提示">' + esc(msg) + ' <span style="float:right">✕</span></div>'; };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { flashErr('邮箱地址格式不对。'); return; }
    // ---------- 域名邮箱（Henna / Cloud Mail）：面板地址 + 登录账号 + 面板密码，不填 IMAP/SMTP ----------
    if (kind !== 'imap') {
      const panelUrl = $('#mb_panel_url').value.trim();
      const panelLogin = $('#mb_panel_login').value.trim();
      const panelPass = $('#mb_panel_pass').value.trim();
      if (!panelUrl) { flashErr('面板地址没填。'); return; }
      if (!panelLogin) { flashErr('登录账号没填。'); return; }
      const body = { email, group_name: group, kind, panel_url: panelUrl, panel_login: panelLogin };
      if (MB_EDIT_ID) {
        if (panelPass) body.password = panelPass;
        btn.disabled = true;
        btn.textContent = '保存中…';
        try {
          await apiOk('/api/mailboxes/' + encodeURIComponent(MB_EDIT_ID), { method: 'PUT', body: JSON.stringify(body) });
          toast('已保存。');
          MB_EDIT_ID = '';
          await loadMailboxes();
          S.view = 'mailboxes';
          renderSidebar();
          renderMain();
        } catch (err) {
          flashErr(err.message || '保存失败。');
          btn.disabled = false;
          btn.textContent = '保存修改';
        }
        return;
      }
      if (!panelPass) { flashErr('面板登录密码没填。'); return; }
      body.password = panelPass;
      btn.disabled = true;
      btn.textContent = '正在测试连接…';
      try {
        const d = await postJson('/api/mailboxes', body);
        if (!d.ok) throw new Error(d.err || '添加失败。');
        toast('已添加：' + email + '，可以继续加下一个。');
        await loadMailboxes();
        renderSidebar();
        renderAddMailboxView($('#main'));
      } catch (err) {
        flashErr(err.message || '添加失败。');
        btn.disabled = false;
        btn.textContent = '保存邮箱';
      }
      return;
    }
    const method = (document.querySelector('input[name="mb_method"]:checked') || {}).value || 'authcode';
    const pass = method === 'password' ? $('#mb_pass').value.trim() : normMbPass($('#mb_pass').value);
    // 登录账号必须是完整邮箱地址：只填 QQ 号的话，QQ 直接报 Please input email address。
    const loginUser = $('#mb_login_user').value.trim() || email;
    if (!loginUser.includes('@')) {
      errBox.innerHTML = '<div class="flash err" title="点一下去掉这条提示">登录账号要填完整邮箱地址，如 ' + esc(email || '53424209@qq.com') + '，不能只填 QQ 号。QQ 那边就是这么报的：Please input email address（请填邮箱地址）。 <span style="float:right">✕</span></div>';
      return;
    }
    const servers = {
      imap_host: $('#mb_imap_host').value.trim(),
      imap_port: parseInt($('#mb_imap_port').value, 10) || 993,
      imap_enc: $('#mb_imap_enc').value,
      smtp_host: $('#mb_smtp_host').value.trim(),
      smtp_port: parseInt($('#mb_smtp_port').value, 10) || 587,
      smtp_enc: $('#mb_smtp_enc').value,
    };
    // 这次填的厂商配置要不要记住：自定义厂商一定记；已知厂商改了服务器配置也记，下次自动填。
    const domain = (email.split('@')[1] || '').toLowerCase();
    const selProvider = $('#mb_provider').value;
    let rememberProvider = null;
    if (selProvider === 'custom') {
      rememberProvider = { domain, label: $('#mb_provider_name').value.trim() || domain, ...servers };
    } else {
      const known = allPresets()[domain];
      if (known && (selProvider === '' || selProvider === domain)) {
        const diff = ['imap_host', 'imap_port', 'imap_enc', 'smtp_host', 'smtp_port', 'smtp_enc'].some((k) => String(servers[k]) !== String(known[k]));
        if (diff) rememberProvider = { domain, label: known.label, ...servers };
      }
    }
    const body = {
      email,
      group_name: group,
      ...servers,
      login_user: loginUser,
    };
    if (MB_EDIT_ID) {
      if (pass) body.password = pass;
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        await apiOk('/api/mailboxes/' + encodeURIComponent(MB_EDIT_ID), { method: 'PUT', body: JSON.stringify(body) });
        toast('已保存。');
        MB_EDIT_ID = '';
        await rememberProviderIfNeeded(rememberProvider);
        await loadMailboxes();
        S.view = 'mailboxes';
        renderSidebar();
        renderMain();
      } catch (err) {
        errBox.innerHTML = '<div class="flash err" title="点一下去掉这条提示">' + esc(err.message || '保存失败。') + ' <span style="float:right">✕</span></div>';
        btn.disabled = false;
        btn.textContent = '保存修改';
      }
      return;
    }
    if (!pass) { errBox.innerHTML = '<div class="flash err" title="点一下去掉这条提示">请填写密码或授权码。 <span style="float:right">✕</span></div>'; return; }
    body.password = pass;
    btn.disabled = true;
    btn.textContent = '正在测试连接…';
    try {
      // 后端添加时先测连接，通了才存；不通这里直接报原因。
      const d = await postJson('/api/mailboxes', body);
      if (!d.ok) throw new Error(d.err || '添加失败。');
      toast('已添加：' + email + '，可以继续加下一个。');
      await rememberProviderIfNeeded(rememberProvider);
      await loadMailboxes();
      renderSidebar();
      renderAddMailboxView($('#main'));
    } catch (err) {
      errBox.innerHTML = '<div class="flash err" title="点一下去掉这条提示">' + esc(err.message || '添加失败。') + ' <span style="float:right">✕</span></div>';
      btn.disabled = false;
      btn.textContent = '保存邮箱';
    }
  });
}

// ---------- 设置 ----------
async function renderSettingsView(main) {
  main.innerHTML = '<div class="card"><h2>设置</h2><p class="muted"><span class="spin"></span> 正在取设置…</p></div>';
  let st;
  try {
    st = await apiOk('/api/settings');
    S.settings = st;
  } catch (err) {
    main.innerHTML = '<div class="card"><h2>设置</h2><div class="flash err">' + esc(err.message || '取设置失败。') + '</div></div>';
    return;
  }
  const tgOn = !!st.tg_enabled;
  const tgDirect = !!(st.tg_chat_id || st.tg_configured);
  main.innerHTML =
    '<div class="card"><h2>设置</h2>'
    + '<div id="setErr"></div>'
    + '<form id="setNameForm" autocomplete="off"><label>默认显示名称</label>'
    + '<input type="text" id="set_display" value="' + esc(st.display_name || '') + '">'
    + '<p><button class="btn ghost">保存显示名称</button></p></form>'
    + '<form id="setCacheForm" autocomplete="off"><label>收件箱列表缓存（分钟）</label>'
    + '<input type="number" id="set_ttl" min="0" max="60" step="1" value="' + (st.cache_ttl == null ? 1 : st.cache_ttl) + '">'
    + '<p class="muted">1 分钟内再进收件箱直接读缓存、秒进；点刷新随时取最新、不受这个时间限制；新邮件最多晚这个时间出现。</p>'
    + '<p><button class="btn ghost">保存缓存时间</button></p></form>'
    + '<form id="setTuneForm" autocomplete="off"><label>自动刷新间隔（毫秒）</label>'
    + '<input type="number" id="set_refresh" min="5000" max="300000" step="1000" value="' + (st.auto_refresh_ms == null ? 30000 : st.auto_refresh_ms) + '"' + ((st.env_locked && st.env_locked.autoRefreshMs) ? ' disabled' : '') + '>'
    + '<p class="muted">30000 就是 30 秒；改小了新邮件来得快，但查得更勤。</p>'
    + '<label>每页显示几封</label>'
    + '<input type="number" id="set_limit" min="5" max="100" step="1" value="' + (st.inbox_limit == null ? 30 : st.inbox_limit) + '"' + ((st.env_locked && st.env_locked.inboxLimit) ? ' disabled' : '') + '>'
    + '<label>发信超时（毫秒）</label>'
    + '<input type="number" id="set_smtp_timeout" min="10000" max="120000" step="1000" value="' + (st.smtp_timeout_ms == null ? 60000 : st.smtp_timeout_ms) + '"' + ((st.env_locked && st.env_locked.smtpTimeoutMs) ? ' disabled' : '') + '>'
    + '<p class="muted">60000 就是 60 秒。CF 面板上设了同名变量（MC_AUTO_REFRESH_MS / MC_INBOX_LIMIT / MC_SMTP_TIMEOUT_MS）的那项会灰掉，以 CF 面板的值为准，这里改了也不生效；没设的在这里改，保存后立刻生效。</p>'
    + '<p><button class="btn ghost">保存收件与发信设置</button></p></form>'
    + '<h2 style="margin-top:16px">登入方式</h2>'
    + '<p class="muted">账号设置：登入账号重新设置、新密码设置、保存新密码。改了之后用新的账号密码登录；邮箱凭据会用新密码重新加密，改完所有记住的设备都要重新登录。</p>'
    + '<form id="setPassForm" autocomplete="off"><label>登入账号</label>'
    + '<input type="text" id="set_user" value="' + esc(st.username || '') + '" autocomplete="username">'
    + '<label>当前站点密码</label>'
    + '<input type="password" id="set_cur" autocomplete="current-password" required>'
    + '<label>新站点密码（至少 4 位）</label><input type="password" id="set_new" autocomplete="new-password" required>'
    + '<label>再输一次新站点密码</label><input type="password" id="set_new2" autocomplete="new-password" required>'
    + '<p><button class="btn">保存新密码</button></p>'
    + '<p class="muted">改站点密码后，已存的邮箱凭据会用新密钥重新加密。改完密码，所有记住的设备都要重新登录。当前密码这里填面板里设的站点密码（不是 CF 的登入密码变量）。</p>'
    + '<p class="muted">CF 面板变量：MC_ADMIN_USER（登入账号）、MC_ADMIN_PASS（登入密码）。'
    + ((st.cf_login && (st.cf_login.user_set || st.cf_login.pass_set))
      ? '现在 CF 上设了' + (st.cf_login.user_set ? '登入账号' : '') + (st.cf_login.user_set && st.cf_login.pass_set ? '和' : '') + (st.cf_login.pass_set ? '登入密码' : '') + '，登录用 CF 的那套；面板里这套照样能登（备用）。CF 上删掉变量、保存一次设置后，就只认面板这套。'
      : '现在 CF 上没设这两个变量，登录就用上面这套。初始默认是 admin / 123456；面板里改过账号密码后，以面板改过的为准。')
    + 'CF 的密码值不会在这里显示，也不会出现在接口返回里。</p></form>'
    + '<div><label>记住的设备</label>'
    + '<p class="muted" style="margin:4px 0 10px">不认识的设备、或者换了电脑不想再记住，就点下面全部退出（当前这个浏览器不断线）。</p>'
    + '<p><button class="btn ghost" id="revokeAllBtn">退出所有记住的设备</button></p></div>'
    + '</div>'
    + '<div class="card"><h2>面板主题</h2>'
    + '<p class="muted">换个主色，按钮、选中态、未读圆点都会跟着变。存在服务器上，换设备也一样。</p>'
    + '<div id="themeSwatches" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0">'
    + THEME_PRESETS.map((t) => '<button type="button" class="theme-sw' + (((st.theme_accent || THEME_DEFAULT) === t.hex) ? ' on' : '') + '" data-hex="' + t.hex + '" title="' + t.name + '" style="background:' + t.hex + '"></button>').join('')
    + '<label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer;font-size:13px;color:#57534e"><input type="color" id="themeCustom" value="' + (st.theme_accent || THEME_DEFAULT) + '" style="width:36px;height:36px;padding:0;border:none;background:none;cursor:pointer">自定义颜色</label>'
    + '</div>'
    + '<p><button class="btn ghost" id="themeResetBtn" type="button">恢复默认绿色</button></p></div>'
    + '<div class="card"><h2>消息推送</h2>'
    + '<p class="muted">新邮件到了就往你的 Telegram 推一条：邮箱、时间（北京时间）、发件人、标题、正文前 120 字，再加一条“点开看全文”的链接。只查收件箱、只查连接正常的邮箱；第一次开只记基线、不推旧邮件。</p>'
    + '<p class="muted">状态：' + (tgOn ? '已开启' : '未开启') + ' · 方式：' + (tgDirect ? '直连 Bot' : '未配置') + '</p>'
    + '<form id="tgForm" autocomplete="off"><div class="pushbox"><div class="pushrow"><span class="ptitle">Telegram 机器人</span>'
    + '<label class="switch" title="开启新邮件 TG 通知"><input type="checkbox" id="tg_enabled"' + (tgOn ? ' checked' : '') + '><span class="sl"></span></label></div>'
    + '<div class="tgslots"><input type="text" id="tg_token" value="' + esc(st.tg_token_masked || '') + '" placeholder="Bot Token" autocomplete="off" title="已保存时显示 **** + 后 4 位；要换就粘贴完整的新 Token">'
    + '<input type="text" id="tg_chat" value="' + esc(st.tg_chat_id || '') + '" placeholder="chat_id" autocomplete="off"></div></div>'
    + '<p class="muted">怎么拿这两个：① TG 里找 @BotFather，/newbot 建个机器人，复制 Token；② 找 @userinfobot 发任意消息，它回你的数字 ID 就是 chat_id；③ 先给你的机器人发一条消息（点 Start），不然它发不出去。上面两项都填了就直连 Telegram 发通知。Token 框里留着 **** 不动就是不改。</p>'
    + '<p><button class="btn">保存 TG 设置</button></p></form>'
    + '<p class="muted">上次运行：' + esc(st.tg_last_run || '还没跑过') + '</p>'
    + '<p><button class="btn ghost" id="tgTestBtn" type="button">发一条测试通知</button> <button class="btn ghost" id="tgCheckBtn" type="button">立即查一轮</button></p>'
    + '<p class="muted">立即查一轮：第一次跑只记基线、不推旧邮件；之后有新邮件才推，每轮每邮箱最多 5 封。</p>'
    + '</div>';
  $('#setNameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await postJsonOk('/api/settings', { display_name: $('#set_display').value.trim() });
      S.me.display_name = $('#set_display').value.trim();
      document.title = (S.me.display_name || 'Mail Center') + ' · Mail Center';
      const h1 = $('.top h1');
      if (h1) h1.textContent = S.me.display_name;
      toast('显示名称已保存。');
    } catch (err) { toast(err.message || '保存失败。'); }
  });
  $('#setCacheForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ttl = parseInt($('#set_ttl').value, 10);
    if (isNaN(ttl) || ttl < 0 || ttl > 60) { toast('缓存分钟填 0–60。'); return; }
    try {
      await postJsonOk('/api/settings', { cache_ttl: ttl });
      toast('缓存时间已保存。');
    } catch (err) { toast(err.message || '保存失败。'); }
  });
  $('#setTuneForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ar = parseInt($('#set_refresh').value, 10);
    const il = parseInt($('#set_limit').value, 10);
    const st2 = parseInt($('#set_smtp_timeout').value, 10);
    if (isNaN(ar) || ar < 5000 || ar > 300000) { toast('自动刷新间隔填 5000–300000 毫秒。'); return; }
    if (isNaN(il) || il < 5 || il > 100) { toast('每页显示填 5–100 封。'); return; }
    if (isNaN(st2) || st2 < 10000 || st2 > 120000) { toast('发信超时填 10000–120000 毫秒。'); return; }
    try {
      await postJsonOk('/api/settings', { auto_refresh_ms: ar, inbox_limit: il, smtp_timeout_ms: st2 });
      UI_CFG.autoRefreshMs = ar;
      if (inboxTimer) { clearInterval(inboxTimer); inboxTimer = null; }
      startInboxAutoRefresh();
      toast('收件与发信设置已保存，立刻生效。');
    } catch (err) { toast(err.message || '保存失败。'); }
  });
  $('#setPassForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = $('#set_cur').value, nw = $('#set_new').value, nw2 = $('#set_new2').value;
    const nu = $('#set_user').value.trim();
    if (nw.length < 4) { toast('新密码至少 4 位。'); return; }
    if (nw !== nw2) { toast('两次输入的新密码不一样。'); return; }
    try {
      const d = await postJson('/api/settings/password', { current: cur, new: nw, new_username: nu });
      if (!d.ok) throw new Error(d.err || '改密码失败。');
      toast('账号密码已改，请重新登录。');
      goLogin();
    } catch (err) { toast(err.message || '改密码失败。'); }
  });
  $('#revokeAllBtn').addEventListener('click', async () => {
    if (!confirm('退出所有记住的设备？当前这个浏览器不断线，其他设备下次要重新登录。')) return;
    try {
      await postJsonOk('/api/settings/revoke-all', {});
      toast('已退出所有其他记住的设备。');
    } catch (err) { toast(err.message || '操作失败。'); }
  });
  $('#tgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { tg_enabled: $('#tg_enabled').checked, tg_chat_id: $('#tg_chat').value.trim() };
    const tok = $('#tg_token').value.trim();
    if (tok !== '' && !tok.startsWith('****')) body.tg_bot_token = tok;
    try {
      await postJsonOk('/api/settings', body);
      toast('TG 设置已保存。');
      renderSettingsView(main);
    } catch (err) { toast(err.message || '保存失败。'); }
  });
  const tgTestBtn = $('#tgTestBtn');
  if (tgTestBtn) tgTestBtn.addEventListener('click', async () => {
    tgTestBtn.disabled = true;
    try {
      await postJsonOk('/api/settings/tg-test', {});
      toast('测试通知已发出，去 TG 看一眼。');
    } catch (err) { toast(err.message || '测试通知没发出去。'); }
    tgTestBtn.disabled = false;
  });
  const tgCheckBtn = $('#tgCheckBtn');
  if (tgCheckBtn) tgCheckBtn.addEventListener('click', async () => {
    tgCheckBtn.disabled = true;
    tgCheckBtn.textContent = '正在查…';
    try {
      const d = await postJson('/api/settings/tg-check-now', {});
      if (!d.ok) throw new Error(d.err || '查失败。');
      toast('查了 ' + d.checked + ' 个邮箱，推了 ' + d.sent + ' 条 TG 通知。' + (d.notes && d.notes.length ? '备注：' + d.notes.join('；') : ''));
      renderSettingsView(main);
    } catch (err) { toast(err.message || '查失败。'); tgCheckBtn.disabled = false; tgCheckBtn.textContent = '立即查一轮'; }
  });
  // 面板主题：点色块立刻换色并保存；自定义颜色边调边预览，松开再保存。
  const markThemeSw = (hex) => {
    $$('#themeSwatches .theme-sw').forEach((b) => b.classList.toggle('on', b.getAttribute('data-hex') === hex));
  };
  const saveTheme = async (hex) => {
    try {
      await postJsonOk('/api/settings', { theme_accent: hex });
      toast(hex ? '主题已保存。' : '已恢复默认绿色。');
    } catch (err) { toast(err.message || '保存失败。'); }
  };
  $$('#themeSwatches .theme-sw').forEach((b) => b.addEventListener('click', async () => {
    const hex = b.getAttribute('data-hex');
    applyTheme(hex);
    markThemeSw(hex);
    const c = $('#themeCustom'); if (c) c.value = hex;
    await saveTheme(hex);
  }));
  const themeCustom = $('#themeCustom');
  if (themeCustom) {
    themeCustom.addEventListener('input', () => { applyTheme(themeCustom.value); markThemeSw(themeCustom.value); });
    themeCustom.addEventListener('change', async () => { await saveTheme(themeCustom.value); });
  }
  const themeResetBtn = $('#themeResetBtn');
  if (themeResetBtn) themeResetBtn.addEventListener('click', async () => {
    applyTheme(THEME_DEFAULT);
    markThemeSw(THEME_DEFAULT);
    const c = $('#themeCustom'); if (c) c.value = THEME_DEFAULT;
    await saveTheme('');
  });
}
