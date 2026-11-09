// index.js — Mail Center Worker Phase 1：登录、邮箱管理、收件箱、读信、发信（JSON API）
// 界面在 Phase 2（同一 Worker 上静态资源）；域名邮箱适配器、TG、Outlook 在 Phase 3。

import {
  b64encode, randomBytes, sha256Hex, hexEncode,
  loginHash, credCryptoKey, importCredKey, exportCredKeyRaw,
  encryptCred, decryptCred, wrapKeyForToken, unwrapKeyForToken,
} from './crypto.js';
import {
  getSite, saveSite, listMailboxes, getMailbox, saveMailbox, deleteMailbox,
  cacheRead, cacheWrite, cacheClearMailbox,
  sessionIssue, sessionGet, sessionTouch, sessionRevoke,
} from './db.js';
import { connectMailbox } from './imap.js';
import { smtpSend, buildSentRaw } from './smtp.js';
import { parseMime, bestBody, decodeHeader, parseAddressHeader } from './mime.js';

const te = new TextEncoder();
const td = new TextDecoder();
const REMEMBER_DAYS = [90, 180, 365];
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
  return { authed: true, site, credKey, tokenHash, setCookie };
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === '/' && method === 'GET') {
      return json({ ok: true, service: 'mail-center', version: 'phase1', note: 'API 见 /api/*，界面在 Phase 2。' });
    }

    if (!path.startsWith('/api/')) return err('接口不存在。', 404);

    // ---------- 不用登录：setup / login ----------
    if (path === '/api/setup' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const existing = await getSite(env.DB);
      if (existing) return err('站点已经设置过了，请直接登录。');
      const username = String(body.username || 'admin').trim().toLowerCase() || 'admin';
      const password = String(body.password || '');
      if (password.length < 4) return err('站点密码至少 4 位。');
      const salt = b64encode(randomBytes(16));
      const passHash = await loginHash(password, salt);
      const site = {
        username, pass_hash: passHash, salt,
        display_name: String(body.display_name || '芒果邮箱管理中心'),
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
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (username !== String(site.username).toLowerCase()) return err('账号或密码不对。', 401);
      const hash = await loginHash(password, site.salt);
      if (hash !== site.pass_hash) return err('账号或密码不对。', 401);
      const days = REMEMBER_DAYS.includes(body.remember_days) ? body.remember_days : 0;
      const s = await issueSession(env, site, password, days);
      return json(
        { ok: true, username: site.username, display_name: site.display_name },
        200,
        { 'Set-Cookie': sessionCookieHeader(s.hex, s.maxAge) },
      );
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
      return done(json({
        ok: true,
        username: site.username,
        display_name: site.display_name,
        cache_ttl: site.cache_ttl,
        tg_enabled: !!site.tg_enabled,
        tg_configured: !!(site.tg_bot_token && site.tg_chat_id),
      }));
    }

    if (path === '/api/settings' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const next = { ...site };
      if (typeof body.display_name === 'string' && body.display_name.trim()) next.display_name = body.display_name.trim();
      if (Number.isInteger(body.cache_ttl) && body.cache_ttl >= 0 && body.cache_ttl <= 60) next.cache_ttl = body.cache_ttl;
      await saveSite(env.DB, next);
      return done(json({ ok: true }));
    }

    if (path === '/api/settings/password' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const current = String(body.current || '');
      const nextPw = String(body.new || '');
      if (nextPw.length < 4) return err('新密码至少 4 位。');
      const curHash = await loginHash(current, site.salt);
      if (curHash !== site.pass_hash) return err('当前密码不对。', 401);
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
      const nextSite = { ...site, salt: newSalt, pass_hash: await loginHash(nextPw, newSalt) };
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
        await cacheClearMailbox(env.DB, id);
        return done(json({ ok: true, mailbox: publicMailbox(next) }));
      }

      if (!isTest && method === 'DELETE') {
        await deleteMailbox(env.DB, id);
        return done(json({ ok: true }));
      }
      return err('接口不存在。', 404);
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

    // ---------- 收件箱列表（带 1 分钟缓存） ----------
    if (path === '/api/inbox' && method === 'GET') {
      const mb = await getMailbox(env.DB, url.searchParams.get('mb') || '');
      if (!mb) return err('找不到这个邮箱。', 404);
      const folderLabel = url.searchParams.get('folder') || 'inbox';
      const refresh = url.searchParams.get('refresh') === '1';
      const ttl = site.cache_ttl ?? 1;
      if (!refresh) {
        const cached = await cacheRead(env.DB, mb.id, folderLabel, ttl);
        if (cached) return done(json({ ok: true, ...cached, cached: true }));
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
        const latest = allUids.slice(-30).reverse();
        const list = await client.fetchList(latest);
        const payload = { list, total: opened.exists, folders: map, cached_at: new Date().toISOString() };
        await cacheWrite(env.DB, mb.id, folderLabel, payload);
        const next = { ...mb, status: 'ok' };
        await saveMailbox(env.DB, next);
        return done(json({ ok: true, ...payload, cached: false }));
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
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const { client, map, err: connErr } = await connectMailbox(mb, pass);
      if (!client) return done(err(connErr));
      try {
        const opened = await client.openFolder(folderLabel, map);
        if (!opened.ok) return done(err(`打不开文件夹：${opened.err || ''}`));
        const rawRes = await client.fetchRaw(uid);
        if (!rawRes.ok || !rawRes.raw) return done(err('取不到这封信，可能已经被删了。'));
        const rawStr = new TextDecoder('iso-8859-1').decode(rawRes.raw);
        const parsed = parseMime(rawStr);
        const body = bestBody(parsed);
        const headers = parsed.headers;
        const fromH = parseAddressHeader(decodeHeader(headers.from || ''));
        const toH = parseAddressHeader(decodeHeader(headers.to || ''));
        await client.markSeen(uid);
        await cacheClearMailbox(env.DB, mb.id);
        return done(json({
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
        }));
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
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const { client, map, err: connErr } = await connectMailbox(mb, pass);
      if (!client) return done(err(connErr));
      try {
        const opened = await client.openFolder(folderLabel, map);
        if (!opened.ok) return done(err('打不开文件夹。'));
        const rawRes = await client.fetchRaw(uid);
        if (!rawRes.ok || !rawRes.raw) return done(err('取不到这封信。'));
        const rawStr = new TextDecoder('iso-8859-1').decode(rawRes.raw);
        const parsed = parseMime(rawStr);
        const att = parsed.attachments.find((a) => a.part === part);
        if (!att) return done(err('找不到这个附件。', 404));
        const partRes = await client.fetchPart(uid, part);
        if (!partRes.ok || !partRes.bytes) return done(err('附件下载失败。'));
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
    if (path === '/api/send' && method === 'POST') {
      const body = await readJson(req);
      if (body === null) return err('请求体不是合法 JSON。');
      const mb = await getMailbox(env.DB, String(body.mb || ''));
      if (!mb) return err('找不到发件邮箱。', 404);
      const to = splitAddrs(body.to || '');
      const cc = splitAddrs(body.cc || '');
      const subject = String(body.subject || '');
      const text = String(body.text || '');
      if (to.length === 0) return err('收件人没填对。');
      if (text === '') return err('正文是空的。');
      const pass = await decryptMailboxPass(mb, credKey);
      if (!pass) return err('这个邮箱没有存凭据，请重新添加。');
      const fromAddr = mb.address || mb.email;
      const fromName = String(body.from_name || '').trim();
      const res = await smtpSend({
        host: mb.smtp_host, port: mb.smtp_port, enc: mb.smtp_enc || 'tls',
        from: fromAddr, fromName, pass, to, cc, subject, body: text,
      });
      if (!res.ok) return done(err(res.err));
      // 尽力把副本存进已发送（失败不影响“已发出”的结果）。
      try {
        const { client, map } = await connectMailbox(mb, pass);
        if (client) {
          try {
            const opened = await client.openFolder('sent', map);
            if (opened.ok) {
              const raw = buildSentRaw(fromAddr, fromName, to, cc, subject, text);
              await client.append(opened.name, te.encode(raw));
            }
          } finally {
            await client.close();
          }
        }
      } catch { /* append 失败不报错 */ }
      await cacheClearMailbox(env.DB, mb.id);
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
        await cacheClearMailbox(env.DB, mb.id);
        return done(json({ ok: true }));
      } finally {
        await client.close();
      }
    }

    return err('接口不存在。', 404);
  },
};
