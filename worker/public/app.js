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
function parseMailDate(raw) { const t = Date.parse(raw || ''); return isNaN(t) ? 0 : t; }
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
const FOLDER_ORDER = ['inbox', 'sent', 'drafts', 'spam', 'trash'];

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
  const collapsed = lsGet('mc_side_collapsed', '0') === '1';
  const sideW = parseInt(lsGet('mc_side_w', '0'), 10) || 0;
  const sideStyle = (sideW && window.innerWidth > 640) ? ' style="width:' + sideW + 'px;min-width:200px;max-width:520px"' : '';
  document.getElementById('app').innerHTML =
    '<div class="top"><div class="logo">✉</div><h1>' + esc(S.me.display_name || 'Mail Center') + '</h1>'
    + '<span class="who"><span>' + esc(S.me.username || '') + '</span><button class="btn ghost sm" id="logoutBtn">退出</button></span></div>'
    + '<div class="wrap' + (collapsed ? ' side-collapsed' : '') + '" id="wrap">'
    + '<div class="side" id="side"' + sideStyle + '></div>'
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
  renderSidebar();
  renderMain();
  wireSideResizer();
  window.addEventListener('resize', fitSideWidthSoon);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSideWidth);
}

async function loadMailboxes() {
  const d = await apiOk('/api/mailboxes');
  S.mailboxes = d.mailboxes || [];
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
  let h = '<a class="compose-btn" id="composeBtn">＋ 写信</a>';
  h += '<details class="mblist" open><summary class="mblist-h"><span><span class="ico ico-blue"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M22 6l-10 7L2 6"/></svg></span> 我的邮箱</span><span class="fold">▾</span></summary>';
  if (!S.mailboxes.length) {
    h += '<p class="muted" style="padding:4px 12px">还没有邮箱，去「邮箱管理」里点「＋ 添加邮箱」加第一个吧。建议先加 QQ（用授权码）。</p>';
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
        + (mb.id === S.curMbId ? '<span class="cur">● 当前</span>' : '')
        + '<span class="mb-dot" data-id="' + esc(mb.id) + '" data-email="' + esc(mb.email) + '" title="更多操作">⋮</span></a>';
    }
    h += '</details>';
  }
  h += '</details>';
  h += '<a class="mb-ico" id="mbIco" title="我的邮箱：点一下展开侧栏选邮箱"><span class="ico ico-blue"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M22 6l-10 7L2 6"/></svg></span></a>';
  h += '<a href="#" data-nav="mailboxes" class="' + (S.view === 'mailboxes' ? 'on' : '') + '"><span class="ico"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12l2 2 4-4"/></svg></span> <span class="lbl">邮箱管理</span></a>';
  h += '<a href="#" data-nav="settings" class="' + (S.view === 'settings' ? 'on' : '') + '"><span class="ico ico-violet"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 0 2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span> <span class="lbl">设置</span></a>';
  h += '<div style="margin-top:24px;padding:12px;border-top:1px solid #f5f5f4" class="muted">收信、读信、回信、转发、写信都在本站完成，不用跳去别处。</div>';
  h += '<div class="side-edge" id="sideEdge" title="拖动调整侧栏宽度，点圆钮折叠 / 展开"><button class="edge-btn" id="edgeBtn" title="折叠 / 展开侧栏">‹</button></div>';
  side.innerHTML = h;

  $('#composeBtn').addEventListener('click', () => openCompose({}));
  $('#mbIco').addEventListener('click', (e) => { e.preventDefault(); setSidebarCollapsed(false); });
  $$('#side [data-nav]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const nav = a.getAttribute('data-nav');
    S.view = nav;
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
    setSidebarCollapsed(!$('#wrap').classList.contains('side-collapsed'));
  });
  wireSidebarDrag();
  fitSideWidthSoon();
}

function setSidebarCollapsed(collapsed) {
  $('#wrap').classList.toggle('side-collapsed', collapsed);
  lsSet('mc_side_collapsed', collapsed ? '1' : '0');
  fitSideWidthSoon();
}

// 左栏宽度跟 s00 一样：跟打开的分组走，没打开分组就是默认 200px；
// 打开哪个分组就撑宽到能显示全那个分组的邮箱名，关掉缩回默认宽；
// 窄屏（≤640px）不撑宽，固定 200px，邮箱名长了截断显示省略号；
// 手动拖过宽的（mc_side_w）只在桌面沿用，窄屏一律不理。
function fitSideWidth() {
  const side = $('#side');
  const wrap = $('#wrap');
  if (!side || !wrap) return;
  if (wrap.classList.contains('side-collapsed') || window.innerWidth <= 640) {
    side.style.width = ''; side.style.minWidth = ''; side.style.maxWidth = '';
    return;
  }
  const saved = parseInt(lsGet('mc_side_w', '0'), 10) || 0;
  if (saved) {
    side.style.width = Math.max(200, Math.min(520, saved)) + 'px';
    side.style.minWidth = '200px'; side.style.maxWidth = '520px';
    return;
  }
  let need = 200;
  const consider = (el) => { if (!el) return; const w = el.scrollWidth + 25; if (w > need) need = w; };
  const box = side.querySelector('details.mblist');
  if (box) {
    consider(box.querySelector(':scope > summary.mblist-h'));
    box.querySelectorAll(':scope > details.gitem').forEach((g) => {
      consider(g.querySelector(':scope > summary.gsum'));
      if (g.open && box.open) g.querySelectorAll('a.mb[data-id]').forEach(consider);
    });
  }
  if (need > 520) need = 520;
  side.style.width = need + 'px';
  side.style.minWidth = ''; side.style.maxWidth = '';
}
function fitSideWidthSoon() {
  if (window.requestAnimationFrame) window.requestAnimationFrame(fitSideWidth);
  else fitSideWidth();
}

function wireSideResizer() {
  const edge = $('#sideEdge');
  if (!edge) return;
  let startX = 0, startW = 0, dragging = false;
  edge.addEventListener('pointerdown', (e) => {
    if (window.innerWidth <= 640) return;
    if (e.target.id === 'edgeBtn') return;
    dragging = true;
    startX = e.clientX;
    startW = $('#side').getBoundingClientRect().width;
    edge.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  edge.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(200, Math.min(520, startW + (e.clientX - startX)));
    const side = $('#side');
    side.style.width = w + 'px';
    side.style.minWidth = '200px';
    side.style.maxWidth = '520px';
  });
  edge.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    lsSet('mc_side_w', String(Math.round($('#side').getBoundingClientRect().width)));
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
  menu.querySelector('[data-act="edit"]').addEventListener('click', () => { close(); S.view = 'mailboxes'; renderSidebar(); renderMain(); setTimeout(() => openMbEditor(mbId), 50); });
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
  const midW = parseInt(lsGet('mc_mid_w', '340'), 10) || 340;
  main.innerHTML =
    '<div class="panes"><div class="pane-mid" id="paneMid" style="flex-basis:' + midW + 'px;width:' + midW + 'px">'
    + '<div class="card"><h2 id="inboxTitle">收件箱</h2>'
    + '<div class="folders" id="folderPills"></div>'
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
    $('#msgList').innerHTML = '<p class="muted">还没有邮箱，去「邮箱管理」里点「＋ 添加邮箱」加第一个吧。建议先加 QQ（用授权码），再加 Outlook / Gmail。</p>';
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
    const w = Math.max(280, Math.min(560, startW + (e.clientX - startX)));
    const pane = $('#paneMid');
    pane.style.flexBasis = w + 'px';
    pane.style.width = w + 'px';
  });
  rz.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    rz.classList.remove('drag');
    lsSet('mc_mid_w', String(Math.round($('#paneMid').getBoundingClientRect().width)));
  });
}

async function loadInbox(refresh) {
  const mb = curMailbox();
  if (!mb || S.listLoading) return;
  S.listLoading = true;
  const listEl = $('#msgList');
  if (listEl && refresh) listEl.innerHTML = '<p class="muted"><span class="spin"></span> 正在取最新…</p>';
  try {
    const d = await api('/api/inbox?mb=' + encodeURIComponent(mb.id) + '&folder=' + encodeURIComponent(S.curFolder) + (refresh ? '&refresh=1' : ''));
    if (!d.ok) throw new Error(d.err || '取收件箱失败。');
    S.list = d.list || [];
    S.folderMap = d.folders || {};
    S.listMeta = { total: d.total || 0, cached_at: d.cached_at || '', cached: !!d.cached, store: d.store || '' };
    S.unread[mb.id] = S.list.filter((m) => !m.seen).length;
    renderInboxList();
    renderSidebarDots();
  } catch (err) {
    if (listEl) listEl.innerHTML = '<div class="flash err">' + esc(err.message || '取收件箱失败。') + '</div>';
  } finally {
    S.listLoading = false;
  }
}

function renderSidebarDots() {
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
    const k = monthKeyOf(m.date);
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
        + '<span class="rowright"><span class="date">' + esc(fmtListDate(m.date)) + '</span></span></span>'
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
      if (!confirm('删除这封邮件？（有已删除文件夹就移过去，没有就直接删）')) return;
      await mailAction('/api/delete', uid);
    });
  });
}

// ---------- 读信 ----------
function renderReaderEmpty() {
  const card = $('#readerCard');
  if (!card) return;
  card.innerHTML = '<h2>读信</h2>'
    + '<div class="empty-reader"><div class="big">✉</div><p>点一封邮件查看。</p>'
    + '<p class="muted">支持回复、转发、标已读、移到垃圾箱 / 已删除。</p></div>';
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
  const hasText = !!(m.text && m.text.trim());
  const hasHtml = !!(m.html && m.html.trim());
  const bodyMode = hasText ? 'text' : (hasHtml ? 'html' : 'text');
  card.innerHTML =
    '<h2>' + esc(m.subject !== '' ? m.subject : '（无主题）') + '</h2>'
    + '<p class="reader-meta">发件人：' + esc(m.from_raw || ((m.from_name || '') + ' ' + (m.from_addr || ''))) + '<br>收件人：' + esc(m.to || '') + (m.cc ? '<br>抄送：' + esc(m.cc) : '') + '<br>时间：' + esc(fmtFullDate(m.date)) + '</p>'
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
    + '<button class="btn ghost" id="btnFlag">' + (isCurSeen() ? '标为未读' : '标为已读') + '</button>'
    + '<span class="spacer"></span>'
    + (S.curFolder !== 'spam' ? '<button class="btn ghost" id="btnSpam">移到垃圾箱</button>' : '')
    + (S.curFolder !== 'trash' ? '<button class="btn ghost" id="btnTrash">移到已删除</button>' : '')
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
  $('#btnFlag').addEventListener('click', async () => {
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
  $('#btnDel').addEventListener('click', async () => { if (confirm('删除这封邮件？（有已删除文件夹就移过去，没有就直接删）')) await mailAction('/api/delete', S.curUid); });
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
    + '<label>附件（总共不超过 10MB）</label>'
    + '<input type="file" id="cmpFiles" multiple style="padding:6px 0">'
    + '<ul class="att-list" id="cmpAttList"></ul>'
    + '<div class="modal-actions"><button class="btn" id="cmpSend">发送</button><button class="btn ghost" id="cmpCancel">取消</button>'
    + '<span class="muted" id="cmpHint">发出去的信会尽力存一份到已发送。</span></div>'
    + '</div></div>';
  $('#cmpText').value = textQ;
  $('#cmpHtml').innerHTML = htmlQ;
  $('#cmpBack').addEventListener('click', (e) => { if (e.target.id === 'cmpBack') closeCompose(); });
  $('#cmpCancel').addEventListener('click', closeCompose);
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
  'qq.com': { imap_host: 'imap.qq.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.qq.com', smtp_port: 587, smtp_enc: 'tls', label: 'QQ邮箱' },
  '163.com': { imap_host: 'imap.163.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.163.com', smtp_port: 465, smtp_enc: 'ssl', label: '163邮箱' },
  '126.com': { imap_host: 'imap.126.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.126.com', smtp_port: 465, smtp_enc: 'ssl', label: '126邮箱' },
  'yeah.net': { imap_host: 'imap.yeah.net', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.yeah.net', smtp_port: 465, smtp_enc: 'ssl', label: 'Yeah邮箱' },
  'gmail.com': { imap_host: 'imap.gmail.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_enc: 'tls', label: 'Gmail' },
  'v.cd': { imap_host: 'smtp.mail.v.cd', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.mail.v.cd', smtp_port: 465, smtp_enc: 'ssl', label: 'DNSHE' },
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
  h += '<div class="card"><details class="addbar" id="addBar"><summary><span style="color:#16a34a">＋</span> 添加邮箱 <span class="fold">▾</span></summary>'
    + '<p class="muted">先选登录方式，再填凭据。QQ 用授权码，Gmail 用应用专用密码；哪个能登上，取决于邮箱厂商那边的规则。保存时先测连接，通了才存。</p>'
    + '<div id="mbFormErr"></div>'
    + '<form id="mbForm" autocomplete="off">'
    + '<label>邮箱地址</label><input type="email" id="mb_email" placeholder="如 xxx@qq.com" required>'
    + '<label>厂商 / 域名（选了自动填服务器，也可手动改）</label><select id="mb_provider">'
    + '<option value="">按邮箱地址自动识别</option>'
    + Object.entries(MB_PRESETS).map(([d, p]) => '<option value="' + d + '">' + esc(p.label) + '</option>').join('')
    + '<option value="custom">自定义服务器</option></select>'
    + '<label>分组</label><div class="row"><div><select id="mb_group">' + order.map((g) => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join('') + '<option value="__new__">新建分组…</option></select></div>'
    + '<div id="mb_newgroup_wrap" style="display:none"><input type="text" id="mb_newgroup" placeholder="新分组名"></div></div>'
    + '<label>密码 / 授权码 <span class="kv-note" id="mb_pass_hint">QQ 填授权码，Gmail 填应用专用密码</span></label>'
    + '<div style="display:flex;gap:8px;align-items:center"><input type="password" id="mb_pass" style="flex:1" required><button type="button" class="btn ghost sm" id="mb_pass_toggle" style="white-space:nowrap">👁 显示</button></div>'
    + '<div class="form-grid">'
    + '<div><label>IMAP 服务器</label><input type="text" id="mb_imap_host" placeholder="imap.qq.com"></div>'
    + '<div><label>IMAP 端口</label><input type="number" id="mb_imap_port" value="993"></div>'
    + '<div><label>IMAP 加密</label><select id="mb_imap_enc"><option value="ssl">SSL</option><option value="tls">STARTTLS</option></select></div>'
    + '<div><label>SMTP 服务器</label><input type="text" id="mb_smtp_host" placeholder="smtp.qq.com"></div>'
    + '<div><label>SMTP 端口</label><input type="number" id="mb_smtp_port" value="587"></div>'
    + '<div><label>SMTP 加密</label><select id="mb_smtp_enc"><option value="tls">STARTTLS</option><option value="ssl">SSL</option></select></div>'
    + '</div>'
    + '<label>IMAP 登录账号（默认和邮箱地址一样）</label><input type="text" id="mb_login_user" placeholder="默认和邮箱地址一样">'
    + '<p style="margin-top:16px"><button class="btn" id="mbSaveBtn">保存邮箱</button> <button type="button" class="btn ghost" id="mbCancelBtn" style="display:none">取消编辑</button></p>'
    + '</form></details></div>';
  h += '<div class="card">';
  if (!S.mailboxes.length) {
    h += '<p class="muted">还没有邮箱，点上面「＋ 添加邮箱」加第一个吧。建议先加 QQ（用授权码），再加 Outlook / Gmail。</p>';
  } else {
    h += '<div class="folders"><a class="' + (S.mbFilter === '' ? 'on' : '') + '" data-gf="">全部（' + S.mailboxes.length + '）</a>'
      + order.map((g) => '<a class="' + (S.mbFilter === g ? 'on' : '') + '" data-gf="' + esc(g) + '">' + esc(g) + '（' + counts[g] + '）</a>').join('') + '</div>'
      + '<p class="muted">' + (S.mbFilter !== '' ? '只看"' + esc(S.mbFilter) + '"分组的邮箱，点"全部"或表格里「分组」列头的 ▾ 换分组。' : '点上面某个分组，或点表格里「分组」列头的 ▾，就只列出该分组的邮箱。') + '</p>';
    h += '<div style="border:1px solid #e7e5e4;border-radius:8px;padding:12px;margin:0 0 12px"><strong>分组管理</strong> <span class="muted">改一个分组名，这个分组里的邮箱一起跟着改，不用一个个改。</span>'
      + order.map((g) => '<div style="display:flex;gap:8px;align-items:center;margin:8px 0 0;flex-wrap:wrap"><span style="width:180px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(g) + '（' + counts[g] + '）">' + esc(g) + '（' + counts[g] + '）</span><span class="muted">改成</span><input type="text" class="gname-input" data-group="' + esc(g) + '" value="' + esc(g) + '" style="width:130px;padding:6px 8px;border:1px solid #e7e5e4;border-radius:6px;font-size:14px"><button class="btn ghost sm" data-rename="' + esc(g) + '">改分组名</button>' + (counts[g] === 0 ? ' <button class="btn danger sm" data-delgroup="' + esc(g) + '">删除分组</button>' : '') + '</div>').join('')
      + '<div style="display:flex;gap:8px;align-items:center;margin:8px 0 0;flex-wrap:wrap"><span style="width:180px;flex:none" class="muted">新建分组</span><input type="text" id="newGroupInput" placeholder="新分组名" style="width:130px;padding:6px 8px;border:1px solid #e7e5e4;border-radius:6px;font-size:14px"><button class="btn ghost sm" id="newGroupBtn">新建分组</button></div>'
      + '</div>';
    h += '<div class="tablewrap"><table><tr><th>邮箱</th><th><details class="gpick"><summary title="点一下按分组筛选">分组' + (S.mbFilter !== '' ? '：' + esc(S.mbFilter) : '') + ' <span class="fold">▾</span></summary><div class="gmenu">'
      + (S.mbFilter === '' ? '<span class="gcur">✓ 全部（' + S.mailboxes.length + '）</span>' : '<a href="#" data-gf="">全部（' + S.mailboxes.length + '）</a>')
      + all.map((x) => (x.name === S.mbFilter ? '<span class="gcur">✓ ' + esc(x.name) + '（' + x.count + '）</span>' : '<a href="#" data-gf="' + esc(x.name) + '">' + esc(x.name) + '（' + x.count + '）</a>')).join('')
      + '</div></details></th><th>登录方式</th><th>IMAP</th><th>状态</th><th>操作</th></tr><tbody>';
    for (const m of S.mailboxes) {
      const g = groupOf(m);
      if (S.mbFilter !== '' && g !== S.mbFilter) continue;
      const statusTag = m.status === 'ok' ? '<span class="tag ok">连接成功</span>' : (m.status === 'error' ? '<span class="tag fail">连接失败</span>' : '<span class="tag none">未测试</span>');
      h += '<tr><td class="email"><strong>' + esc(m.email) + '</strong>' + (m.kind && m.kind !== 'imap' ? ' <span class="tag ok">' + esc(m.kind) + '</span>' : '') + (m.address && m.address !== m.email ? '<br><span class="muted">' + esc(m.address) + '</span>' : '') + '</td>'
        + '<td><span class="tag gtag-cell" data-mb="' + esc(m.id) + '" style="' + groupTagStyle(g) + ';cursor:pointer" title="点一下改分组">' + esc(g) + '</span></td>'
        + '<td>授权码 · 应用专用密码</td>'
        + '<td class="muted">' + esc(m.imap_host || '') + ':' + (m.imap_port || '') + '</td>'
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
  // 删除空分组
  $$('#main [data-delgroup]').forEach((b) => b.addEventListener('click', async () => {
    const g = b.getAttribute('data-delgroup');
    if (!confirm('删除分组"' + g + '"吗？这个分组里没有邮箱。')) return;
    try {
      await apiOk('/api/groups/' + encodeURIComponent(g), { method: 'DELETE' });
      await loadGroups();
      if (S.mbFilter === g) S.mbFilter = '';
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
  $$('#main [data-edit]').forEach((b) => b.addEventListener('click', () => openMbEditor(b.getAttribute('data-edit'))));
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
  wireMbForm();
}

function openMbEditor(mbId) {
  const mb = S.mailboxes.find((m) => m.id === mbId);
  if (!mb) return;
  const bar = $('#addBar');
  if (bar) bar.open = true;
  MB_EDIT_ID = mbId;
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
  $('#mb_imap_host').value = mb.imap_host || '';
  $('#mb_imap_port').value = mb.imap_port || 993;
  $('#mb_imap_enc').value = mb.imap_enc || 'ssl';
  $('#mb_smtp_host').value = mb.smtp_host || '';
  $('#mb_smtp_port').value = mb.smtp_port || 587;
  $('#mb_smtp_enc').value = mb.smtp_enc || 'tls';
  $('#mb_login_user').value = (mb.login_user && mb.login_user !== mb.email) ? mb.login_user : '';
  $('#mbSaveBtn').textContent = '保存修改';
  $('#mbCancelBtn').style.display = '';
  $('#mb_email').focus();
  $('#mb_email').scrollIntoView({ block: 'nearest' });
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
  $('#mb_email').addEventListener('change', () => {
    const email = $('#mb_email').value.trim();
    const domain = (email.split('@')[1] || '').toLowerCase();
    const preset = MB_PRESETS[domain];
    if (preset) {
      $('#mb_provider').value = domain;
      fillServers(preset);
    }
  });
  $('#mb_provider').addEventListener('change', () => {
    const v = $('#mb_provider').value;
    if (v && v !== 'custom') fillServers(MB_PRESETS[v]);
  });
  $('#mb_group').addEventListener('change', () => {
    const v = $('#mb_group').value;
    $('#mb_newgroup_wrap').style.display = v === '__new__' ? '' : 'none';
    if (v && v !== '__new__') {
      // 选一个已有分组，服务器按这个分组里邮箱用的那套自动填
      const first = S.mailboxes.find((m) => groupOf(m) === v);
      if (first) fillServers({ imap_host: first.imap_host, imap_port: first.imap_port, imap_enc: first.imap_enc, smtp_host: first.smtp_host, smtp_port: first.smtp_port, smtp_enc: first.smtp_enc });
    }
  });
  $('#mb_pass_toggle').addEventListener('click', () => {
    const inp = $('#mb_pass');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#mb_pass_toggle').textContent = show ? '🙈 隐藏' : '👁 显示';
  });
  $('#mbCancelBtn').addEventListener('click', () => {
    MB_EDIT_ID = '';
    renderMailboxesView($('#main'));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#mbFormErr');
    const btn = $('#mbSaveBtn');
    const email = $('#mb_email').value.trim();
    const pass = $('#mb_pass').value;
    let group = $('#mb_group').value;
    if (group === '__new__') group = $('#mb_newgroup').value.trim();
    const body = {
      email,
      group_name: group,
      imap_host: $('#mb_imap_host').value.trim(),
      imap_port: parseInt($('#mb_imap_port').value, 10) || 993,
      imap_enc: $('#mb_imap_enc').value,
      smtp_host: $('#mb_smtp_host').value.trim(),
      smtp_port: parseInt($('#mb_smtp_port').value, 10) || 587,
      smtp_enc: $('#mb_smtp_enc').value,
      login_user: $('#mb_login_user').value.trim() || email,
    };
    if (MB_EDIT_ID) {
      if (pass) body.password = pass;
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        await apiOk('/api/mailboxes/' + encodeURIComponent(MB_EDIT_ID), { method: 'PUT', body: JSON.stringify(body) });
        toast('已保存。');
        MB_EDIT_ID = '';
        await loadMailboxes();
        renderSidebar();
        renderMailboxesView($('#main'));
      } catch (err) {
        errBox.innerHTML = '<div class="flash err">' + esc(err.message || '保存失败。') + '</div>';
        btn.disabled = false;
        btn.textContent = '保存修改';
      }
      return;
    }
    if (!pass) { errBox.innerHTML = '<div class="flash err">请填写密码或授权码。</div>'; return; }
    body.password = pass;
    btn.disabled = true;
    btn.textContent = '正在测试连接…';
    try {
      // 后端添加时先测连接，通了才存；不通这里直接报原因。
      const d = await postJson('/api/mailboxes', body);
      if (!d.ok) throw new Error(d.err || '添加失败。');
      toast('已添加：' + email);
      await loadMailboxes();
      renderSidebar();
      renderMailboxesView($('#main'));
    } catch (err) {
      errBox.innerHTML = '<div class="flash err">' + esc(err.message || '添加失败。') + '</div>';
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
    + '<form id="setPassForm" autocomplete="off"><label>当前站点密码</label>'
    + '<input type="password" id="set_cur" autocomplete="current-password" required>'
    + '<label>新站点密码（至少 4 位）</label><input type="password" id="set_new" autocomplete="new-password" required>'
    + '<label>再输一次新站点密码</label><input type="password" id="set_new2" autocomplete="new-password" required>'
    + '<p><button class="btn">改站点密码</button></p>'
    + '<p class="muted">改站点密码后，已存的邮箱凭据会用新密钥重新加密。改完密码，所有记住的设备都要重新登录。</p></form>'
    + '<div><label>记住的设备</label>'
    + '<p class="muted" style="margin:4px 0 10px">不认识的设备、或者换了电脑不想再记住，就点下面全部退出（当前这个浏览器不断线）。</p>'
    + '<p><button class="btn ghost" id="revokeAllBtn">退出所有记住的设备</button></p></div>'
    + '</div>'
    + '<div class="card"><h2>消息推送</h2>'
    + '<p class="muted">新邮件到了就往你的 Telegram 推一条：邮箱、时间（北京时间）、发件人、标题、正文前 120 字，再加一条“点开看全文”的链接。只查收件箱、只查连接正常的邮箱；第一次开只记基线、不推旧邮件。</p>'
    + '<p class="muted">状态：' + (tgOn ? '已开启' : '未开启') + ' · 方式：' + (tgDirect ? '直连 Bot' : '未配置') + '</p>'
    + '<form id="tgForm" autocomplete="off"><div class="pushbox"><div class="pushrow"><span class="ptitle">Telegram 机器人</span>'
    + '<label class="switch" title="开启新邮件 TG 通知"><input type="checkbox" id="tg_enabled"' + (tgOn ? ' checked' : '') + '><span class="sl"></span></label></div>'
    + '<div class="tgslots"><input type="text" id="tg_token" value="' + esc(st.tg_token_masked || '') + '" placeholder="Bot Token" autocomplete="off" title="已保存时显示 **** + 后 4 位；要换就粘贴完整的新 Token">'
    + '<input type="text" id="tg_chat" value="' + esc(st.tg_chat_id || '') + '" placeholder="chat_id" autocomplete="off"></div></div>'
    + '<p class="muted">怎么拿这两个：① TG 里找 @BotFather，/newbot 建个机器人，复制 Token；② 找 @userinfobot 发任意消息，它回你的数字 ID 就是 chat_id；③ 先给你的机器人发一条消息（点 Start），不然它发不出去。上面两项都填了就直连 Telegram 发通知。Token 框里留着 **** 不动就是不改。</p>'
    + '<p><button class="btn">保存 TG 设置</button></p></form>'
    + '<p class="muted">TG 每 5 分钟轮询在 Phase 3 接入；这里先保存开关与凭据。</p></div>'
    + '<div class="card"><h2>邮箱管理</h2><p class="muted">添加、编辑、测试连接、删除邮箱都在邮箱管理里。</p>'
    + '<p><button class="btn ghost" id="goMbBtn">去邮箱管理</button></p></div>';
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
  $('#setPassForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = $('#set_cur').value, nw = $('#set_new').value, nw2 = $('#set_new2').value;
    if (nw.length < 4) { toast('新密码至少 4 位。'); return; }
    if (nw !== nw2) { toast('两次输入的新密码不一样。'); return; }
    try {
      const d = await postJson('/api/settings/password', { current: cur, new: nw });
      if (!d.ok) throw new Error(d.err || '改密码失败。');
      toast('密码已改，请重新登录。');
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
  $('#goMbBtn').addEventListener('click', () => { S.view = 'mailboxes'; renderSidebar(); renderMain(); });
}
