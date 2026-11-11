// index.js — Mail Center Worker：登录、邮箱管理、收件箱、读信、发信（JSON API）+ 静态资源（Phase 2 界面）
// TG 轮询在 Phase 3 已接（src/tg.js：Cron 每 5 分钟 + /api/tgcheck）；域名邮箱适配器、Outlook 还在 Phase 3。

import {
  b64encode, b64decode, randomBytes, sha256Hex, sha256Bytes, hexEncode,
  loginHash, credCryptoKey, importCredKey, exportCredKeyRaw,
  encryptCred, decryptCred, wrapKeyForToken, unwrapKeyForToken,
} from './crypto.js';
import {
  getSite, saveSite, getSettings, saveSettings, listMailboxes, getMailbox, saveMailbox, deleteMailbox,
  listGroups, saveGroup, deleteGroup, renameGroup, countGroupMailboxes, groupDbName,
  cacheRead, cacheReadStale, cacheWrite, cacheExpireMailbox, bumpCacheVersion,
  sessionIssue, sessionGet, sessionTouch, sessionRevoke, sessionRevokeOthers,
} from './db.js';
import { connectMailbox } from './imap.js';
import { smtpSend, buildSentRaw } from './smtp.js';
import { parseMime, bestBody, decodeHeader, parseAddressHeader, b64ToBytes } from './mime.js';
import { kvCacheGet, kvCachePut } from './cache.js';
import { getRaw, storeRaw, getAttachment, storeAttachment, deleteMessageStore } from './store.js';
import { tgSendDirect, tgCheckAll, tgSaveLastRun, tgNewKey, wrapTgKey, unwrapTgKey } from './tg.js';

const te = new TextEncoder();
const td = new TextDecoder();
const REMEMBER_DAYS = [90, 180, 365];

// 可调配置：从 CF 面板环境变量读（Workers → mail-center → Settings → Variables → Add variable），
// 没设就用下面的默认值。改面板上的值不用重新部署，刷新页面就生效（发信超时改完下次发信生效）。
// 变量名：MC_INBOX_LIMIT（每页几封，默认 30）、MC_SMTP_TIMEOUT_MS（发信超时毫秒，默认 60000）、
// MC_SIDEBAR_W（左栏宽 px，默认 240）、MC_MID_W（收件栏默认宽 px，默认 220）、
// MC_AUTO_REFRESH_MS（自动刷新间隔毫秒，默认 30000）。
// 另外两个面板变量：MC_DISPLAY_NAME（设置面板名称，如 芒果邮箱管理中心，不填用数据库里的）、
// MC_ADMIN_USER（登入账号，不填用数据库里的账号）、MC_ADMIN_PASS（登入密码，不填用数据库里的站点密码）。
// 初始默认：账号 admin、密码 123456（只在站点还没设置过时是这个；面板里改过账号密码后以面板的为准）。
// 注意：站点密码不只是登录口令，还是解密邮箱凭据的密钥，
// 改密码必须走设置页的“登入方式”（会把所有邮箱凭据用新密钥重加密），单改一个环境变量会让邮箱全登不上。
// 所以 MC_ADMIN_PASS 只是多一个能登录的口令：登录时先认数据库里的站点密码，
// 再认 CF 的 MC_ADMIN_PASS；用 CF 密码登时，邮箱凭据靠 login_wrap 解——
// login_wrap 是登录态下用当前 MC_ADMIN_PASS 把派生密钥包一份存 D1（和 TG 的 tg_wrap 一个做法），
// 面板里保存设置、改密码、用站点密码登录时都会顺手生成/更新，关掉办法是把 CF 的 MC_ADMIN_PASS 删了再保存一次设置。
function uiConfig(env, settings = {}) {
  const num = (v, d) => {
    const n = parseInt(String(v == null ? '' : v), 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const str = (v) => String(v == null ? '' : v).trim();
  // 三个值优先级：CF 面板环境变量 > 管理面板设置（D1 settings 表）> 默认值。
  // 管理面板里改了就存在 D1，立刻生效；CF 面板上设了同名变量就以 CF 的为准，管理面板里那项会显示“已锁定”。
  return {
    inboxLimit: num(env.MC_INBOX_LIMIT ?? settings.inbox_limit, 30),
    smtpTimeoutMs: num(env.MC_SMTP_TIMEOUT_MS ?? settings.smtp_timeout_ms, 60000),
    sidebarW: num(env.MC_SIDEBAR_W, 240),
    midW: num(env.MC_MID_W, 220),
    autoRefreshMs: num(env.MC_AUTO_REFRESH_MS ?? settings.auto_refresh_ms, 30000),
    displayName: str(env.MC_DISPLAY_NAME),
    adminUser: str(env.MC_ADMIN_USER).toLowerCase(),
    envLocked: {
      inboxLimit: env.MC_INBOX_LIMIT != null && String(env.MC_INBOX_LIMIT).trim() !== '',
      smtpTimeoutMs: env.MC_SMTP_TIMEOUT_MS != null && String(env.MC_SMTP_TIMEOUT_MS).trim() !== '',
      autoRefreshMs: env.MC_AUTO_REFRESH_MS != null && String(env.MC_AUTO_REFRESH_MS).trim() !== '',
    },
  };
}
async function effectiveConfig(env) {
  let settings = {};
  try { settings = await getSettings(env.DB); } catch { settings = {}; }
  return uiConfig(env, settings);
}
// 面板变量覆盖数据库里的显示名和登录账号（密码仍走数据库，不覆盖）。
function effectiveSite(env, site) {
  if (!site) return site;
  const cfg = uiConfig(env);
  return {
    ...site,
    username: cfg.adminUser || site.username,
    display_name: cfg.displayName || site.display_name,
  };
}

// CF 面板的登入密码变量 MC_ADMIN_PASS（值绝不能进 /api/status 的 config，
// 那个接口不用登录；这里单独读，只在登录那一刻用）。
function cfLoginPass(env) {
  return String(env.MC_ADMIN_PASS == null ? '' : env.MC_ADMIN_PASS).trim();
}

// login_wrap：用 MC_ADMIN_PASS 把派生密钥原文包一份存 D1（settings.login_wrap），
// 这样用 CF 密码登录时也能解邮箱凭据。不跑 PBKDF2，只用 SHA-256(MC_ADMIN_PASS) 作 AES 密钥。
async function wrapCredForLogin(rawCredKey, cfPass) {
  const wrapRaw = await sha256Bytes(te.encode(cfPass));
  const wrapKey = await crypto.subtle.importKey('raw', wrapRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, rawCredKey));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv);
  packed.set(ct, iv.length);
  return b64encode(packed);
}
async function unwrapCredForLogin(wrapB64, cfPass) {
  try {
    const wrapRaw = await sha256Bytes(te.encode(cfPass));
    const wrapKey = await crypto.subtle.importKey('raw', wrapRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const packed = b64decode(wrapB64);
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, ct));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}
// 登录态下顺手保证 login_wrap 存在（CF 设了 MC_ADMIN_PASS 才需要）：
// 刚在 CF 加了 MC_ADMIN_PASS 的话，用站点密码登一次、或保存一次设置，就会生成；
// 之后用 CF 密码登也能解邮箱凭据。CF 删了 MC_ADMIN_PASS 后，保存一次设置会清掉它。
async function ensureLoginWrap(env, credKey) {
  const cfPass = cfLoginPass(env);
  if (!cfPass) return;
  try {
    const stg = await getSettings(env.DB);
    if (stg.login_wrap) return;
    await saveSettings(env.DB, { login_wrap: await wrapCredForLogin(await exportCredKeyRaw(credKey), cfPass) });
  } catch { /* 生成失败不影响当前登录 */ }
}

const SESSION_COOKIE = 'mc_session';

const PRESETS = {
  'qq.com': { imap_host: 'imap.qq.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.qq.com', smtp_port: 587, smtp_enc: 'tls' },
  '163.com': { imap_host: 'imap.163.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.163.com', smtp_port: 465, smtp_enc: 'ssl' },
  '126.com': { imap_host: 'imap.126.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.126.com', smtp_port: 465, smtp_enc: 'ssl' },
  'yeah.net': { imap_host: 'imap.yeah.net', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.yeah.net', smtp_port: 465, smtp_enc: 'ssl' },
  'gmail.com': { imap_host: 'imap.gmail.com', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_enc: 'tls' },
  'v.cd': { imap_host: 'smtp.mail.v.cd', imap_port: 993, imap_enc: 'ssl', smtp_host: 'smtp.mail.v.cd', smtp_port: 465, smtp_enc: 'ssl' },
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function err(msg, status = 400) {
  return json({ ok: false, err: msg }, status);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookieHeader(hex, maxAgeSeconds) {
  let c = `${SESSION_COOKIE}=${hex}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  if (maxAgeSeconds) c += `; Max-Age=${maxAgeSeconds}`;
  return c;
}

function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function readJson(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function splitAddrs(s) {
  const out = [];
  for (const p of String(s || '').split(/[,;\s；，]+/)) {
    const a = p.trim();
    if (a && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

// 会话恢复：Cookie 里的令牌原文 → D1 查 SHA-256 → 密码哈希比对 → 解出派生密钥。
// 恢复成功且剩余时间不到一半时顺延（和 PHP 版一样）。
async function requireAuth(req, env) {
  const site = await getSite(env.DB);
  if (!site) return { authed: false, err: '还没有设置站点密码。', status: 401 };
  const cookies = parseCookies(req);
  const hex = cookies[SESSION_COOKIE] || '';
  if (!/^[0-9a-f]{64}$/.test(hex)) return { authed: false, err: '请先登录。', status: 401 };
  const tokenHash = await sha256Hex(hex);
  const row = await sessionGet(env.DB, tokenHash);
  if (!row) return { authed: false, err: '登录已过期，请重新登录。', status: 401 };
  if (row.pw_hash !== site.pass_hash) {
    await sessionRevoke(env.DB, tokenHash);
    return { authed: false, err: '站点密码已改，请重新登录。', status: 401 };
  }
  const rawKey = await unwrapKeyForToken(row.key_enc, hex);
  if (!rawKey || rawKey.length !== 32) return { authed: false, err: '会话损坏，请重新登录。', status: 401 };
  const credKey = await importCredKey(rawKey);
  let setCookie = null;
  if (row.expires_at - Date.now() < (row.days * 86400 * 1000) / 2) {
    const exp = await sessionTouch(env.DB, row);
    void exp;
    setCookie = sessionCookieHeader(hex, row.days >= 90 ? row.days * 86400 : undefined);
  }
  return { authed: true, site: effectiveSite(env, site), credKey, tokenHash, setCookie };
}

function withAuthCookie(resp, setCookie) {
  if (!setCookie) return resp;
  const h = new Headers(resp.headers);
  h.set('Set-Cookie', setCookie);
  return new Response(resp.body, { status: resp.status, headers: h });
}

async function issueSession(env, site, password, rememberDays) {
  const days = REMEMBER_DAYS.includes(rememberDays) ? rememberDays : 0;
  const token = randomBytes(32);
  const hex = hexEncode(token);
  const tokenHash = await sha256Hex(hex);
  const credKey = await credCryptoKey(password, site.salt);
  const rawKey = await exportCredKeyRaw(credKey);
  const keyEnc = await wrapKeyForToken(rawKey, hex);
  const expiresDays = days || 0.5; // 不记住我：12 小时过期，Cookie 随浏览器关闭失效
  await sessionIssue(env.DB, { tokenHash, keyEnc, days: expiresDays, pwHash: site.pass_hash });
  const maxAge = days ? days * 86400 : undefined;
  return { hex, maxAge, credKey };
}

// 列表缓存失效：D1 版本号 +1（KV 旧 key 自然失效）+ 清 D1 缓存。
// 发信/删信/移动后让缓存失效：KV 靠版本号失效；D1 只把 updated_at 置 0（过期），
// 不删行——删行会把每封信的接收时间 received_at 一起清掉，下次取列表就只能回落到发信时间。
async function invalidateMailboxCache(env, mbId) {
  await bumpCacheVersion(env.DB, mbId);
  await cacheExpireMailbox(env.DB, mbId);
}

// 把原始全文解析成读信页的 JSON（R2 命中和 IMAP 现取共用）。
function messagePayload(uid, rawBytes) {
  const rawStr = new TextDecoder('iso-8859-1').decode(rawBytes);
  const parsed = parseMime(rawStr);
  const body = bestBody(parsed);
  const headers = parsed.headers;
  const fromH = parseAddressHeader(decodeHeader(headers.from || ''));
  const toH = parseAddressHeader(decodeHeader(headers.to || ''));
  return {
    ok: true,
    uid,
    date: headers.date || '',
    subject: decodeHeader(headers.subject || ''),
    from_name: fromH.name,
    from_addr: fromH.addr,
    from_raw: decodeHeader(headers.from || ''),
    to: decodeHeader(headers.to || ''),
    to_addr: toH.addr,
    cc: decodeHeader(headers.cc || ''),
    text: body.text,
    html: body.html,
    attachments: parsed.attachments,
  };
}

function publicMailbox(mb) {
  if (!mb) return null;
  const { pass_enc, panel_pass_enc, ...rest } = mb;
  return { ...rest, has_password: !!pass_enc };
}

async function decryptMailboxPass(mb, credKey) {
  if (!mb.pass_enc) return '';
  return (await decryptCred(mb.pass_enc, credKey)) || '';
}

function presetFor(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  return PRESETS[domain] || null;
}

// 富文本正文转纯文本（只填了 html 没填 text 时用）：去掉标签、留换行。
function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|p|div|tr|li|h[1-6]|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // 健康检查（原来 GET / 的状态 JSON 搬到这里）。
    if (path === '/api/status' && method === 'GET') {
      return json({ ok: true, service: 'mail-center', version: 'phase2', note: 'API 见 /api/*。', config: await effectiveConfig(env) });
    }

    // TG 轮询入口（PHP 版的做法）：外部定时任务每 5 分钟调一次，不用登录，凭 tg_key 鉴权。
    // 没开通知、key 不对都直接 403，不透露原因。CF Cron Trigger 是主路，这个地址是备用。
    if (path === '/api/tgcheck' && method === 'GET') {
      const site0 = await getSite(env.DB);
      const key = url.searchParams.get('key') || '';
      if (!site0 || !site0.tg_enabled || !key || !site0.tg_key || key !== site0.tg_key) {
        return json({ ok: false, err: 'forbidden' }, 403);
      }
      const raw = await unwrapTgKey(env.DB, site0);
      if (!raw) return json({ ok: false, err: 'TG 轮询密钥不可用：重新打开一次 TG 开关再试。' }, 500);
      const ck = await importCredKey(raw);
      const res = await tgCheckAll(env, ck, site0);
      await tgSaveLastRun(env, res);
      return json({ ok: true, checked: res.checked, sent: res.sent, notes: res.notes });
    }

    // 非 API 请求走静态资源（SPA 首页、app.js、styles.css）。
    if (!path.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return json({ ok: true, service: 'mail-center', version: 'phase2' });
    }

    // ---------- 不用登录：setup / login ----------
    if (path === '/api/setup' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const existing = await getSite(env.DB);
      if (existing) return err('站点已经设置过了，请直接登录。');
      const cfg0 = uiConfig(env);
      const username = String(body.username || cfg0.adminUser || 'admin').trim().toLowerCase() || 'admin';
      const password = String(body.password || '');
      if (password.length < 4) return err('站点密码至少 4 位。');
      const salt = b64encode(randomBytes(16));
      const passHash = await loginHash(password, salt);
      const site = {
        username, pass_hash: passHash, salt,
        display_name: String(body.display_name || cfg0.displayName || '芒果邮箱管理中心'),
        cache_ttl: 1, tg_enabled: 0, tg_bot_token: '', tg_chat_id: '', tg_key: '',
      };
      await saveSite(env.DB, site);
      const s = await issueSession(env, site, password, 0);
      return json(
        { ok: true, username },
        200,
        { 'Set-Cookie': sessionCookieHeader(s.hex, s.maxAge) },
      );
    }

    if (path === '/api/login' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const site = await getSite(env.DB);
      if (!site) return err('还没有设置站点密码。', 401);
      const eff = effectiveSite(env, site);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      // 登录账号认两个：数据库里的账号，和面板变量 MC_ADMIN_USER。
      const allowed = [String(site.username).toLowerCase(), eff.username.toLowerCase()].filter(Boolean);
      if (!allowed.includes(username)) return err('账号或密码不对。', 401);
      const days = REMEMBER_DAYS.includes(body.remember_days) ? body.remember_days : 0;
      // 先认数据库里的站点密码（派生密钥直接算出来）。
      const hash = await loginHash(password, site.salt);
      if (hash === site.pass_hash) {
        const s = await issueSession(env, site, password, days);
        await ensureLoginWrap(env, s.credKey);
        return json(
          { ok: true, username: eff.username, display_name: eff.display_name },
          200,
          { 'Set-Cookie': sessionCookieHeader(s.hex, s.maxAge) },
        );
      }
      // 再认 CF 面板的 MC_ADMIN_PASS（用 login_wrap 解派生密钥；没包就登不上，
      // 先用站点密码登一次、保存一次设置生成后再用 CF 密码登）。
      const cfPass = cfLoginPass(env);
      if (cfPass && password === cfPass) {
        const stg = await getSettings(env.DB);
        const raw = stg.login_wrap ? await unwrapCredForLogin(stg.login_wrap, cfPass) : null;
        if (raw) {
          const credKey = await importCredKey(raw);
          const token = randomBytes(32);
          const hex = hexEncode(token);
          const tokenHash = await sha256Hex(hex);
          const keyEnc = await wrapKeyForToken(raw, hex);
          await sessionIssue(env.DB, { tokenHash, keyEnc, days: days || 0.5, pwHash: site.pass_hash });
          const maxAge = days ? days * 86400 : undefined;
          return json(
            { ok: true, username: eff.username, display_name: eff.display_name },
            200,
            { 'Set-Cookie': sessionCookieHeader(hex, maxAge) },
          );
        }
      }
      return err('账号或密码不对。', 401);
    }

    // ---------- 以下都要登录 ----------
    const auth = await requireAuth(req, env);
    if (!auth.authed) return err(auth.err, auth.status || 401);
    const { site, credKey } = auth;
    const done = (resp) => withAuthCookie(resp, auth.setCookie);

    if (path === '/api/logout' && method === 'POST') {
      await sessionRevoke(env.DB, auth.tokenHash);
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
    }

    if (path === '/api/me' && method === 'GET') {
      return done(json({ ok: true, username: site.username, display_name: site.display_name }));
    }

    if (path === '/api/settings' && method === 'GET') {
      const cfg = await effectiveConfig(env);
      const stg = await getSettings(env.DB);
      return done(json({
        ok: true,
        username: site.username,
        display_name: site.display_name,
        cache_ttl: site.cache_ttl,
        auto_refresh_ms: cfg.autoRefreshMs,
        inbox_limit: cfg.inboxLimit,
        smtp_timeout_ms: cfg.smtpTimeoutMs,
        env_locked: cfg.envLocked,
        tg_enabled: !!site.tg_enabled,
        tg_configured: !!(site.tg_bot_token && site.tg_chat_id),
        tg_chat_id: site.tg_chat_id || '',
        tg_token_masked: site.tg_bot_token ? '****' + String(site.tg_bot_token).slice(-4) : '',
        // 只回“设没设”，不回值（MC_ADMIN_PASS 的值绝不能出这个接口）。
        cf_login: { user_set: !!cfg.adminUser, pass_set: !!cfLoginPass(env) },
        tg_last_run: stg.tg_last_run || '',
        tg_key: site.tg_key || '',
      }));
    }

    if (path === '/api/settings' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const next = { ...site };
      if (typeof body.display_name === 'string' && body.display_name.trim()) next.display_name = body.display_name.trim();
      if (Number.isInteger(body.cache_ttl) && body.cache_ttl >= 0 && body.cache_ttl <= 60) next.cache_ttl = body.cache_ttl;
      // 收件与发信三项（管理面板里改，存 D1；CF 面板同名环境变量设了就以 CF 的为准，这里改了也不生效）。
      const tune = {};
      const tuneInt = (v, lo, hi) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
      };
      const ar = tuneInt(body.auto_refresh_ms, 5000, 300000);
      if (ar !== null) tune.auto_refresh_ms = ar;
      const il = tuneInt(body.inbox_limit, 5, 100);
      if (il !== null) tune.inbox_limit = il;
      const st = tuneInt(body.smtp_timeout_ms, 10000, 120000);
      if (st !== null) tune.smtp_timeout_ms = st;
      if (Object.keys(tune).length) await saveSettings(env.DB, tune);
      // TG 推送：开关 + chat_id + Bot Token（Token 留空或填 **** 开头 = 不改）。
      if (typeof body.tg_enabled === 'boolean') next.tg_enabled = body.tg_enabled ? 1 : 0;
      if (typeof body.tg_chat_id === 'string') next.tg_chat_id = body.tg_chat_id.trim();
      if (typeof body.tg_bot_token === 'string') {
        const tok = body.tg_bot_token.trim();
        if (tok !== '' && !tok.startsWith('****')) next.tg_bot_token = tok;
      }
      // TG 开关动过才处理轮询密钥：开 → 没 tg_key 就生成一把，再把当前派生密钥包一份存 D1
      // （Cron / tgcheck 靠这份包解邮箱凭据，不用登录）；关 → 删包，Cron 再也解不开。
      const tgChanged = ('tg_enabled' in body) || ('tg_chat_id' in body) || ('tg_bot_token' in body);
      if (tgChanged) {
        if (next.tg_enabled) {
          if (!next.tg_key) next.tg_key = tgNewKey();
          const wrap = await wrapTgKey(await exportCredKeyRaw(credKey), next.tg_key);
          await saveSettings(env.DB, { tg_wrap: wrap });
        } else {
          await saveSettings(env.DB, { tg_wrap: '' });
        }
      }
      await saveSite(env.DB, next);
      // CF 设了 MC_ADMIN_PASS 的话，顺手保证 login_wrap 存在（刚加了 CF 密码时靠这一步生成）；
      // CF 删了 MC_ADMIN_PASS 的话，清掉 login_wrap，CF 密码就登不上了。
      if (cfLoginPass(env)) await ensureLoginWrap(env, credKey);
      else {
        const stg3 = await getSettings(env.DB);
        if (stg3.login_wrap) await saveSettings(env.DB, { login_wrap: '' });
      }
      return done(json({ ok: true }));
    }

    // TG 发一条测试通知（直连 Bot，和真通知同一条路）。
    if (path === '/api/settings/tg-test' && method === 'POST') {
      if (!site.tg_enabled || !site.tg_bot_token || !site.tg_chat_id) {
        return done(err('先把 TG 开关打开、填好 Bot Token 和 chat_id 再试。'));
      }
      const now = new Date(Date.now() + 8 * 3600 * 1000);
      const p = (n) => String(n).padStart(2, '0');
      const when = now.getUTCFullYear() + '-' + p(now.getUTCMonth() + 1) + '-' + p(now.getUTCDate()) + ' ' + p(now.getUTCHours()) + ':' + p(now.getUTCMinutes());
      const r = await tgSendDirect(site.tg_bot_token, site.tg_chat_id,
        '📧 测试通知\n邮箱管理中心的 TG 通知已接通，时间：' + when + '（北京时间）。以后有新邮件就会按这个格式推给你。');
      if (!r.ok) return done(err(r.err));
      return done(json({ ok: true }));
    }

    // TG 立即查一轮新邮件并通知（用当前登录的密钥；第一次跑只记基线、不推旧邮件）。
    if (path === '/api/settings/tg-check-now' && method === 'POST') {
      if (!site.tg_enabled) return done(err('先把 TG 通知开关打开再查。'));
      const res = await tgCheckAll(env, credKey, site);
      const lastRun = await tgSaveLastRun(env, res);
      return done(json({ ok: true, checked: res.checked, sent: res.sent, notes: res.notes, last_run: lastRun }));
    }

    // 退出所有记住的设备：删掉除当前会话外的全部会话（当前浏览器不断线）。
    if (path === '/api/settings/revoke-all' && method === 'POST') {
      await sessionRevokeOthers(env.DB, auth.tokenHash);
      return done(json({ ok: true }));
    }

    if (path === '/api/settings/password' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const current = String(body.current || '');
      const nextPw = String(body.new || '');
      if (nextPw.length < 4) return err('新密码至少 4 位。');
      // 登入账号一起改（登入方式卡片里填；不填 = 只改密码，账号不动）。
      // 注意：当前密码这里填面板里设的站点密码（不是 CF 的 MC_ADMIN_PASS），因为要凭它解邮箱凭据。
      const curHash = await loginHash(current, site.salt);
      if (curHash !== site.pass_hash) return err('当前密码不对。', 401);
      let nextUsername = site.username;
      if (typeof body.new_username === 'string' && body.new_username.trim()) {
        const nu = body.new_username.trim().toLowerCase();
        if (!/^[a-z0-9_@.\-]{1,40}$/.test(nu)) return err('登入账号只能用字母、数字和 _ @ . -，40 个字以内。');
        nextUsername = nu;
      }
      // 换密码要把所有已存邮箱凭据用旧密钥解开、再用新密钥重加密，否则邮箱全登不上。
      const oldKey = credKey;
      const newSalt = b64encode(randomBytes(16));
      const newKey = await credCryptoKey(nextPw, newSalt);
      const mbs = await listMailboxes(env.DB);
      for (const mb of mbs) {
        const next = { ...mb };
        if (mb.pass_enc) {
          const plain = await decryptCred(mb.pass_enc, oldKey);
          if (plain !== null) next.pass_enc = await encryptCred(plain, newKey);
        }
        if (mb.panel_pass_enc) {
          const plain = await decryptCred(mb.panel_pass_enc, oldKey);
          if (plain !== null) next.panel_pass_enc = await encryptCred(plain, newKey);
        }
        await saveMailbox(env.DB, next);
      }
      const nextSite = { ...site, username: nextUsername, salt: newSalt, pass_hash: await loginHash(nextPw, newSalt) };
      // TG 开着的话，派生密钥变了要重包 tg_wrap，不然 Cron 解不开邮箱凭据。
      if (nextSite.tg_enabled && nextSite.tg_key) {
        const wrap = await wrapTgKey(await exportCredKeyRaw(newKey), nextSite.tg_key);
        await saveSettings(env.DB, { tg_wrap: wrap });
      }
      // CF 设了 MC_ADMIN_PASS 的话，派生密钥变了也要重包 login_wrap，不然 CF 密码登不上。
      if (cfLoginPass(env)) {
        await saveSettings(env.DB, { login_wrap: await wrapCredForLogin(await exportCredKeyRaw(newKey), cfLoginPass(env)) });
      }
      await saveSite(env.DB, nextSite);
      await sessionRevoke(env.DB, null);
      return json({ ok: true, relogin: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
    }

    // ---------- 邮箱管理 ----------
    if (path === '/api/mailboxes' && method === 'GET') {
      const mbs = await listMailboxes(env.DB);
      return done(json({ ok: true, mailboxes: mbs.map(publicMailbox) }));
    }

    if (path === '/api/mailboxes' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('邮箱地址格式不对。');
      if (!password) return err('请填写登录密码或授权码（QQ 用授权码，Gmail 用应用专用密码）。');
      const preset = presetFor(email);
      const mb = {
        id: 'mb_' + hexEncode(randomBytes(8)),
        kind: 'imap',
        group_name: String(body.group_name || '').trim(),
        email,
        address: String(body.address || email).trim(),
        imap_host: String(body.imap_host || (preset && preset.imap_host) || '').trim(),
        imap_port: parseInt(body.imap_port || (preset && preset.imap_port) || 993, 10),
        imap_enc: String(body.imap_enc || (preset && preset.imap_enc) || 'ssl'),
        smtp_host: String(body.smtp_host || (preset && preset.smtp_host) || '').trim(),
        smtp_port: parseInt(body.smtp_port || (preset && preset.smtp_port) || 587, 10),
        smtp_enc: String(body.smtp_enc || (preset && preset.smtp_enc) || 'tls'),
        login_user: String(body.login_user || email).trim(),
        pass_enc: '',
        panel_url: String(body.panel_url || '').trim(),
        panel_login: String(body.panel_login || '').trim(),
        panel_pass_enc: '',
        status: 'ok',
        sort: parseInt(body.sort || 0, 10),
        created_at: Date.now(),
      };
      if (!mb.imap_host) return err('IMAP 服务器没填，换个邮箱域名或手动填服务器地址。');
      // 先测连接，通了再存（和 PHP 添加表单一样）。
      const { client, map, err: connErr } = await connectMailbox(mb, password);
      if (!client) return err('连接测试失败：' + connErr);
      await client.close();
      void map;
      mb.pass_enc = await encryptCred(password, credKey);
      if (body.panel_password) mb.panel_pass_enc = await encryptCred(String(body.panel_password), credKey);
      await saveMailbox(env.DB, mb);
      return done(json({ ok: true, mailbox: publicMailbox(mb) }));
    }

    const mbIdMatch = path.match(/^\/api\/mailboxes\/([^/]+)(\/test)?$/);
    if (mbIdMatch) {
      const id = decodeURIComponent(mbIdMatch[1]);
      const isTest = !!mbIdMatch[2];
      const mb = await getMailbox(env.DB, id);
      if (!mb) return err('找不到这个邮箱。', 404);

      if (isTest && method === 'POST') {
        const pass = await decryptMailboxPass(mb, credKey);
        if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
        const { client, map, err: connErr } = await connectMailbox(mb, pass);
        if (!client) return done(err('连接测试失败：' + connErr));
        await client.close();
        const next = { ...mb, status: 'ok' };
        await saveMailbox(env.DB, next);
        return done(json({ ok: true, folders: Object.keys(map) }));
      }

      if (!isTest && method === 'PUT') {
        const body = await readJson(req);
        if (body === null) return err('请求体不是合法 JSON。');
        const next = { ...mb };
        for (const k of ['group_name', 'email', 'address', 'imap_host', 'imap_enc', 'smtp_host', 'smtp_enc', 'login_user', 'panel_url', 'panel_login']) {
          if (typeof body[k] === 'string') next[k] = body[k].trim();
        }
        for (const k of ['imap_port', 'smtp_port', 'sort']) {
          if (Number.isInteger(body[k])) next[k] = body[k];
        }
        if (typeof body.password === 'string' && body.password) {
          next.pass_enc = await encryptCred(body.password, credKey);
        }
        if (typeof body.panel_password === 'string' && body.panel_password) {
          next.panel_pass_enc = await encryptCred(body.panel_password, credKey);
        }
        await saveMailbox(env.DB, next);
        await invalidateMailboxCache(env, id);
        return done(json({ ok: true, mailbox: publicMailbox(next) }));
      }

      if (!isTest && method === 'DELETE') {
        await deleteMailbox(env.DB, id);
        return done(json({ ok: true }));
      }
      return err('接口不存在。', 404);
    }

    // ---------- 分组（单独建的空分组：没加邮箱也能先建好） ----------
    if (path === '/api/groups' && method === 'GET') {
      const gs = await listGroups(env.DB);
      const out = [];
      for (const g of gs) out.push({ name: g.name, count: await countGroupMailboxes(env.DB, g.name) });
      return done(json({ ok: true, groups: out }));
    }

    if (path === '/api/groups' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const name = String(body.name || '').trim();
      if (!name) return err('分组名不能为空。');
      if (name.length > 40) return err('分组名太长了，40 个字以内。');
      const mbs = await listMailboxes(env.DB);
      if (mbs.some((m) => groupOfDb(m) === name)) return err('这个分组已经有了。');
      const gs = await listGroups(env.DB);
      if (gs.some((g) => g.name === name)) return err('这个分组已经有了。');
      await saveGroup(env.DB, name);
      return done(json({ ok: true }));
    }

    if (path.startsWith('/api/groups/') && (method === 'PUT' || method === 'DELETE')) {
      const name = decodeURIComponent(path.slice('/api/groups/'.length));
      if (!name) return err('分组名不对。', 404);
      if (method === 'DELETE') {
        const gs = await listGroups(env.DB);
        if (!gs.some((g) => g.name === name)) return err('找不到这个分组。', 404);
        if ((await countGroupMailboxes(env.DB, name)) > 0) return err('这个分组里还有邮箱，先把邮箱移走再删。');
        await deleteGroup(env.DB, name);
        return done(json({ ok: true }));
      }
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const newName = String(body.new_name || '').trim();
      if (!newName) return err('新分组名不能为空。');
      if (newName.length > 40) return err('分组名太长了，40 个字以内。');
      if (newName === name) return err('分组名没变。');
      const mbs = await listMailboxes(env.DB);
      if (mbs.some((m) => groupOfDb(m) === newName)) return err('已经有同名分组了。');
      const gs = await listGroups(env.DB);
      if (gs.some((g) => g.name === newName)) return err('已经有同名分组了。');
      await renameGroup(env.DB, name, newName);
      return done(json({ ok: true }));
    }

    // ---------- 文件夹 ----------
    if (path === '/api/folders' && method === 'GET') {
      const mb = await getMailbox(env.DB, url.searchParams.get('mb') || '');
      if (!mb) return err('找不到这个邮箱。', 404);
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const { client, map, err: connErr } = await connectMailbox(mb, pass);
      if (!client) return done(err(connErr));
      const folders = await client.listFolders();
      await client.close();
      return done(json({ ok: true, folders: folders.map((f) => f.name), map }));
    }

// mailboxes 行的分组名（group_name 空串 = 未分组）
function groupOfDb(mb) { return (mb.group_name || '').trim() || '未分组'; }

// IMAP FETCH 回包按 UID 升序，列表统一按 UID 从新到旧排（新邮件在前）
function sortNewestFirst(list) {
  if (Array.isArray(list)) list.sort((a, b) => (b.uid || 0) - (a.uid || 0));
  return list;
}

// 两份收件箱列表是不是同一批信（uid + 已读状态都一样就算没变，主题正文不会变）
function sameInboxList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].uid !== b[i].uid || !!a[i].seen !== !!b[i].seen) return false;
  }
  return true;
}

    // ---------- 收件箱列表（带 1 分钟缓存） ----------
    if (path === '/api/inbox' && method === 'GET') {
      const mb = await getMailbox(env.DB, url.searchParams.get('mb') || '');
      if (!mb) return err('找不到这个邮箱。', 404);
      const folderLabel = url.searchParams.get('folder') || 'inbox';
      const refresh = url.searchParams.get('refresh') === '1';
      const check = url.searchParams.get('check') === '1';
      const ttl = site.cache_ttl ?? 1;
      const version = mb.cache_version || 0;
      if (!refresh && !check) {
        // KV 快路径（边缘读）；没配 KV 或没命中再走 D1 缓存
        const kvData = await kvCacheGet(env, mb.id, folderLabel, version);
        if (kvData) { sortNewestFirst(kvData.list); return done(json({ ok: true, ...kvData, cached: true, store: 'kv' })); }
        const cached = await cacheRead(env.DB, mb.id, folderLabel, ttl);
        if (cached) { sortNewestFirst(cached.list); return done(json({ ok: true, ...cached, cached: true, store: 'd1' })); }
      }
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const { client, map, err: connErr } = await connectMailbox(mb, pass);
      if (!client) {
        const next = { ...mb, status: 'error' };
        await saveMailbox(env.DB, next);
        return done(err(connErr));
      }
      try {
        const opened = await client.openFolder(folderLabel, map);
        if (!opened.ok) return done(err(`打不开文件夹：${opened.err || '服务器没有这个文件夹。'}`));
        const allUids = await client.uids();
        const latest = allUids.slice(-(await effectiveConfig(env)).inboxLimit).reverse();
        const list = sortNewestFirst(await client.fetchList(latest));
        // 旧底本：用来比对有没有新信，也用来沿用每封信的接收时间（只读一次，check 模式复用）。
        const stale = await cacheReadStale(env.DB, mb.id, folderLabel);
        const staleList = stale && Array.isArray(stale.list) ? sortNewestFirst(stale.list.slice()) : null;
        // 接收时间 received_at：这封信第一次被本站看到的时间（不是发信时间），列表里显示这个时间，
        // 这样一眼就能看出从发信到本站收到隔了多久。旧缓存里有就沿用；没有的（这轮新到的信）记现在；
        // 旧缓存里还没有接收时间字段（老版本存的）时回落到发信时间，显示和原来一样。
        const nowIso = new Date().toISOString();
        const prevRecv = {};
        let hasRecvData = false;
        if (staleList) {
          for (const it of staleList) {
            if (it && it.uid && it.received_at) { prevRecv[it.uid] = it.received_at; hasRecvData = true; }
          }
        }
        for (const it of list) {
          if (prevRecv[it.uid]) it.received_at = prevRecv[it.uid];
          else if (hasRecvData) it.received_at = nowIso;
          else it.received_at = it.date || nowIso;
        }
        const payload = { list, total: opened.exists, folders: map, cached_at: new Date().toISOString() };
        if (check) {
          // 自动轮询：只在列表真的变了（新信/删信/已读状态变了）时才写 KV。
          // KV 写每天只有 1000 次，每分钟写一次半天就烧完了；没变时只刷新 D1 里的时间戳，
          // 下次打开页面直接读缓存，快，也不占 KV 额度。
          const changed = !stale || stale.total !== payload.total || !sameInboxList(staleList, payload.list);
          await cacheWrite(env.DB, mb.id, folderLabel, payload);
          if (changed) await kvCachePut(env, mb.id, folderLabel, version, payload, ttl);
          const next = { ...mb, status: 'ok' };
          await saveMailbox(env.DB, next);
          return done(json({ ok: true, ...payload, cached: false, store: 'imap', changed }));
        }
        await cacheWrite(env.DB, mb.id, folderLabel, payload);
        await kvCachePut(env, mb.id, folderLabel, version, payload, ttl);
        const next = { ...mb, status: 'ok' };
        await saveMailbox(env.DB, next);
        return done(json({ ok: true, ...payload, cached: false, store: 'imap' }));
      } finally {
        await client.close();
      }
    }

    // ---------- 读一封信 ----------
    if (path === '/api/message' && method === 'GET') {
      const mb = await getMailbox(env.DB, url.searchParams.get('mb') || '');
      if (!mb) return err('找不到这个邮箱。', 404);
      const folderLabel = url.searchParams.get('folder') || 'inbox';
      const uid = parseInt(url.searchParams.get('uid') || '0', 10);
      if (!uid) return err('uid 不对。');
      // R2 快路径：这封以前读过就直接从 R2 拿，不用连 IMAP（首次读已标已读）
      const r2Raw = await getRaw(env, mb.id, folderLabel, uid);
      if (r2Raw) {
        return done(json({ ...messagePayload(uid, r2Raw), store: 'r2' }));
      }
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const { client, map, err: connErr } = await connectMailbox(mb, pass);
      if (!client) return done(err(connErr));
      try {
        const opened = await client.openFolder(folderLabel, map);
        if (!opened.ok) return done(err(`打不开文件夹：${opened.err || ''}`));
        const rawRes = await client.fetchRaw(uid);
        if (!rawRes.ok || !rawRes.raw) return done(err('取不到这封信，可能已经被删了。'));
        await storeRaw(env, mb.id, folderLabel, uid, rawRes.raw);
        await client.markSeen(uid);
        await invalidateMailboxCache(env, mb.id);
        return done(json({ ...messagePayload(uid, rawRes.raw), store: 'imap' }));
      } finally {
        await client.close();
      }
    }

    // ---------- 下载附件 ----------
    if (path === '/api/attachment' && method === 'GET') {
      const mb = await getMailbox(env.DB, url.searchParams.get('mb') || '');
      if (!mb) return err('找不到这个邮箱。', 404);
      const folderLabel = url.searchParams.get('folder') || 'inbox';
      const uid = parseInt(url.searchParams.get('uid') || '0', 10);
      const part = url.searchParams.get('part') || '';
      if (!uid || !part) return err('参数不对。');
      // R2 快路径：附件以前下过就直接从 R2 拿
      const attHit = await getAttachment(env, mb.id, folderLabel, uid, part);
      if (attHit) {
        const headers = new Headers();
        headers.set('Content-Type', attHit.ctype);
        headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attHit.filename)}`);
        headers.set('Content-Length', String(attHit.bytes.length));
        return new Response(attHit.bytes, { headers });
      }
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const { client, map, err: connErr } = await connectMailbox(mb, pass);
      if (!client) return done(err(connErr));
      try {
        const opened = await client.openFolder(folderLabel, map);
        if (!opened.ok) return done(err('打不开文件夹。'));
        // 全文优先从 R2 拿（取附件元数据用），没有再走 IMAP
        let rawBytes = await getRaw(env, mb.id, folderLabel, uid);
        if (!rawBytes) {
          const rawRes = await client.fetchRaw(uid);
          if (!rawRes.ok || !rawRes.raw) return done(err('取不到这封信。'));
          rawBytes = rawRes.raw;
          await storeRaw(env, mb.id, folderLabel, uid, rawBytes);
        }
        const rawStr = new TextDecoder('iso-8859-1').decode(rawBytes);
        const parsed = parseMime(rawStr);
        const att = parsed.attachments.find((a) => a.part === part);
        if (!att) return done(err('找不到这个附件。', 404));
        const partRes = await client.fetchPart(uid, part);
        if (!partRes.ok || !partRes.bytes) return done(err('附件下载失败。'));
        await storeAttachment(env, mb.id, folderLabel, uid, part, partRes.bytes, att.ctype, att.filename);
        const headers = new Headers();
        headers.set('Content-Type', att.ctype || 'application/octet-stream');
        headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.filename || 'attachment')}`);
        headers.set('Content-Length', String(partRes.bytes.length));
        return new Response(partRes.bytes, { headers });
      } finally {
        await client.close();
      }
    }

    // ---------- 发信 ----------
    // JSON：{ mb, to, cc, subject, text, html?, attachments?: [{ filename, ctype, content(base64) }] }
    // text 和 html 至少填一个（只填 html 时纯文本版由 html 转出来）；附件解码后总共 ≤ 10MB。
    if (path === '/api/send' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const mb = await getMailbox(env.DB, String(body.mb || ''));
      if (!mb) return err('找不到发件邮箱。', 404);
      const to = splitAddrs(body.to || '');
      const cc = splitAddrs(body.cc || '');
      const subject = String(body.subject || '');
      const html = String(body.html || '');
      let text = String(body.text || '');
      if (text === '' && html !== '') text = htmlToText(html);
      if (to.length === 0) return err('收件人没填对。');
      if (text === '' && html === '') return err('正文是空的。');
      const atts = [];
      let attTotal = 0;
      if (Array.isArray(body.attachments)) {
        for (const a of body.attachments) {
          if (!a || typeof a.filename !== 'string' || typeof a.content !== 'string') continue;
          const bytes = b64ToBytes(a.content);
          if (!bytes || bytes.length === 0) continue;
          attTotal += bytes.length;
          if (attTotal > 10 * 1024 * 1024) return err('附件总共不能超过 10MB。');
          atts.push({ filename: a.filename, ctype: String(a.ctype || 'application/octet-stream'), bytes });
        }
      }
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const fromAddr = mb.address || mb.email;
      const fromName = String(body.from_name || '').trim();
      const res = await smtpSend({
        host: mb.smtp_host, port: mb.smtp_port, enc: mb.smtp_enc || 'tls',
        from: fromAddr, fromName, pass, to, cc, subject, body: text, html, attachments: atts,
        timeoutMs: (await effectiveConfig(env)).smtpTimeoutMs,
      });
      if (!res.ok) return done(err(res.err));
      // 尽力把副本存进已发送（失败不影响“已发出”的结果）。
      try {
        const { client, map } = await connectMailbox(mb, pass);
        if (client) {
          try {
            const opened = await client.openFolder('sent', map);
            if (opened.ok) {
              const raw = buildSentRaw(fromAddr, fromName, to, cc, subject, text, { html, attachments: atts });
              await client.append(opened.name, te.encode(raw));
            }
          } finally {
            await client.close();
          }
        }
      } catch { /* append 失败不报错 */ }
      await invalidateMailboxCache(env, mb.id);
      return done(json({ ok: true }));
    }

    // ---------- 标已读 / 移动 / 删除 ----------
    if ((path === '/api/flag' || path === '/api/move' || path === '/api/delete') && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const mb = await getMailbox(env.DB, String(body.mb || ''));
      if (!mb) return err('找不到这个邮箱。', 404);
      const folderLabel = String(body.folder || 'inbox');
      const uid = parseInt(body.uid || '0', 10);
      if (!uid) return err('uid 不对。');
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const { client, map, err: connErr } = await connectMailbox(mb, pass);
      if (!client) return done(err(connErr));
      try {
        const opened = await client.openFolder(folderLabel, map);
        if (!opened.ok) return done(err('打不开文件夹。'));
        if (path === '/api/flag') {
          const seen = body.seen !== false;
          const okFlag = await client.setSeen(uid, seen);
          if (!okFlag) return done(err('标记失败。'));
        } else if (path === '/api/move') {
          const dest = String(body.dest || '');
          if (dest !== 'spam' && dest !== 'trash') return done(err('只能移到垃圾箱或已删除。'));
          const r = await client.moveTo(uid, dest, map);
          if (!r.ok) return done(err(r.err));
        } else {
          // 删除：有已删除文件夹就移过去，没有就直接标删 + 清理。
          if (map.trash) {
            const r = await client.moveTo(uid, 'trash', map);
            if (!r.ok) {
              const d = await client.delete(uid);
              if (!d.ok) return done(err(d.err));
            }
          } else {
            const d = await client.delete(uid);
            if (!d.ok) return done(err(d.err));
          }
        }
        if (path === '/api/move' || path === '/api/delete') {
          await deleteMessageStore(env, mb.id, folderLabel, uid);
        }
        await invalidateMailboxCache(env, mb.id);
        return done(json({ ok: true }));
      } finally {
        await client.close();
      }
    }

    return err('接口不存在。', 404);
  },

  // CF Cron Trigger 每 5 分钟跑一次（wrangler.jsonc 里 triggers.crons）。
  // 无人值守：从 D1 的 tg_wrap 解出派生密钥，不用登录。
  async scheduled(event, env, ctx) {
    try {
      const site = await getSite(env.DB);
      if (!site || !site.tg_enabled) return;
      const raw = await unwrapTgKey(env.DB, site);
      if (!raw) return;
      const credKey = await importCredKey(raw);
      const res = await tgCheckAll(env, credKey, site);
      await tgSaveLastRun(env, res);
    } catch {
      // Cron 里失败不抛错、不重试，避免半夜反复推。
    }
  },
};
