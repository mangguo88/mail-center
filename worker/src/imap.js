// imap.js — IMAP 客户端（对照 imap.php 移植）
// 关键行为：LOGIN 后发 ID（163/Coremail 必需）、modified UTF-7 文件夹名、
// open_folder 候选名逐个试、MOVE 否则 COPY+删+EXPUNGE、摘要批量取。
// from_addr 修复：列表同时取 BODY.PEEK[HEADER.FIELDS (FROM)]，原始 From 头为准，
// ENVELOPE 只作备份（QQ 的 ENVELOPE 地址里 mailbox 常是 NIL）。

import { connect } from 'cloudflare:sockets';
import { decodeHeader, parseHeaders, cleanSnippet, parseAddressHeader, displayName } from './mime.js';

const te = new TextEncoder();
const td = new TextDecoder();

function indexOfCRLF(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

export function imapQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------- modified UTF-7（RFC 3501） ----------
export function utf7Encode(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code < 0x80) {
      out += s[i] === '&' ? '&-' : s[i];
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && s.charCodeAt(j) >= 0x80) j++;
    const chunk = s.slice(i, j);
    const utf16 = new Uint8Array(chunk.length * 2);
    for (let k = 0; k < chunk.length; k++) {
      const c = chunk.charCodeAt(k);
      utf16[k * 2] = (c >> 8) & 0xff;
      utf16[k * 2 + 1] = c & 0xff;
    }
    let b64 = '';
    for (let k = 0; k < utf16.length; k++) b64 += String.fromCharCode(utf16[k]);
    out += '&' + btoa(b64).replace(/=/g, '').replace(/\//g, ',') + '-';
    i = j;
  }
  return out;
}

export function utf7Decode(s) {
  if (!s.includes('&')) return s;
  let out = s.replace(/&([A-Za-z0-9+,]+)-/g, (_, b64) => {
    try {
      const fixed = b64.replace(/,/g, '/');
      const bin = atob(fixed + '='.repeat((4 - (fixed.length % 4)) % 4));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-16be').decode(bytes);
    } catch {
      return _;
    }
  });
  return out.replace(/&-/g, '&');
}

// ---------- ENVELOPE 括号表达式解析 ----------
export function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(' || c === ')') { toks.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1, out = '';
      while (j < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2; continue; }
        if (s[j] === '"') break;
        out += s[j]; j++;
      }
      toks.push({ q: out });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !' \t()'.includes(s[j])) j++;
    toks.push(s.slice(i, j));
    i = j;
  }
  return toks;
}

export function parseSeq(toks) {
  let pos = 0;
  function parseOne() {
    const t = toks[pos++];
    if (t === '(') {
      const arr = [];
      while (toks[pos] !== ')') {
        if (pos >= toks.length) break;
        arr.push(parseOne());
      }
      pos++;
      return arr;
    }
    if (t && typeof t === 'object') return t.q;
    if (t === 'NIL') return null;
    return t;
  }
  const out = [];
  while (pos < toks.length) out.push(parseOne());
  return out;
}

// 从字符串里截出第 startIdx 处 '(' 开始的完整括号表达式（含括号本身）。
function extractParen(s, startIdx) {
  let depth = 0;
  let inQuote = false;
  for (let i = startIdx; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) return s.slice(startIdx, i + 1);
    }
  }
  return null;
}

function parseEnvelopeFromLine(line) {
  const empty = { date: '', subject: '', from: [], to: [], cc: [] };
  const pos = line.indexOf('ENVELOPE');
  if (pos === -1) return empty;
  const p = line.indexOf('(', pos);
  if (p === -1) return empty;
  const sub = extractParen(line, p);
  if (!sub) return empty;
  const v = parseSeq(tokenize(sub));
  if (!Array.isArray(v) || v.length === 0) return empty;
  const env = Array.isArray(v[0]) ? v[0] : v;
  const asStr = (x) => (typeof x === 'string' ? x : '');
  const asAddrs = (list) => {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const a of list) {
      if (!Array.isArray(a)) continue;
      out.push({ name: asStr(a[0]), mailbox: asStr(a[1]), host: asStr(a[2]) });
    }
    return out;
  };
  return {
    date: asStr(env[0]),
    subject: asStr(env[1]),
    from: asAddrs(env[2]),
    to: asAddrs(env[5]),
    cc: asAddrs(env[6]),
  };
}

function addrListToAddrs(list) {
  const out = [];
  for (const a of list || []) {
    if (a.mailbox && a.host) out.push(`${a.mailbox}@${a.host}`);
    else if (a.mailbox) out.push(a.mailbox);
  }
  return out;
}

// ---------- socket 读取 ----------
class ImapReader {
  constructor(readable) {
    this.reader = readable.getReader();
    this.buf = new Uint8Array(0);
    this.eof = false;
  }
  async _fill() {
    if (this.eof) return false;
    const { value, done } = await this.reader.read();
    if (done) { this.eof = true; return this.buf.length > 0; }
    const nb = new Uint8Array(this.buf.length + value.length);
    nb.set(this.buf);
    nb.set(value, this.buf.length);
    this.buf = nb;
    return true;
  }
  async readPhysicalLine() {
    while (true) {
      const idx = indexOfCRLF(this.buf);
      if (idx >= 0) {
        const line = td.decode(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + 2);
        return line;
      }
      if (!(await this._fill())) {
        if (this.buf.length === 0) return null;
        const line = td.decode(this.buf);
        this.buf = new Uint8Array(0);
        return line;
      }
    }
  }
  async readExact(n) {
    while (this.buf.length < n) {
      if (!(await this._fill())) break;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  // 一条逻辑行：行尾 {n} 字面量读出后接上后续内容（字面量按 UTF-8 解码，协议文本用）。
  async readLogicalLine() {
    let line = await this.readPhysicalLine();
    if (line === null) return null;
    let m;
    while ((m = line.match(/\{(\d+)\+?\}$/))) {
      const n = parseInt(m[1], 10);
      const lit = await this.readExact(n);
      line = line.slice(0, line.length - m[0].length) + td.decode(lit);
      const rest = await this.readPhysicalLine();
      if (rest === null) break;
      line += rest;
    }
    return line;
  }
}

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg || 'timeout')), ms)),
  ]);
}

export class ImapClient {
  constructor() {
    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.tagCounter = 0;
  }

  nextTag() {
    this.tagCounter++;
    return 'a' + String(this.tagCounter).padStart(3, '0');
  }

  async connect({ host, port, enc = 'ssl', user, pass, oauthToken = '' }) {
    if (!host || !port || !user || (!oauthToken && !pass)) {
      return { ok: false, err: 'IMAP 服务器、端口、邮箱或凭据没填对。' };
    }
    const secureTransport = enc === 'tls' ? 'starttls' : 'on';
    let socket;
    try {
      socket = connect({ hostname: host, port }, { secureTransport });
      this.socket = socket;
      this.reader = new ImapReader(socket.readable);
      this.writer = socket.writable.getWriter();
      await withTimeout(socket.opened, 15000, '连接超时');
    } catch (e) {
      return { ok: false, err: `连不上 ${host}:${port}，先检查服务器地址和端口。(${e.message || e})` };
    }
    const greeting = await withTimeout(this.reader.readLogicalLine(), 15000, '服务器没有回应').catch(() => null);
    if (!greeting || (!greeting.startsWith('* OK') && !greeting.startsWith('* PREAUTH'))) {
      await this.close();
      return { ok: false, err: '服务器没有回应，可能是端口不对或服务暂忙，稍后再试。' };
    }
    if (enc === 'tls') {
      const r = await this.cmd('STARTTLS');
      if (!r.ok) {
        await this.close();
        return { ok: false, err: 'STARTTLS 失败，服务器不支持 STARTTLS，或端口不对（STARTTLS 一般用 143）。' };
      }
      try {
        const secure = socket.startTls();
        this.socket = secure;
        this.reader = new ImapReader(secure.readable);
        this.writer = secure.writable.getWriter();
        await withTimeout(secure.opened, 15000, 'STARTTLS 加密握手失败');
      } catch (e) {
        await this.close();
        return { ok: false, err: 'STARTTLS 加密握手失败。' };
      }
    }
    const cap = await this.cmd('CAPABILITY');
    let caps = '';
    for (const ln of cap.lines) {
      if (ln.toUpperCase().startsWith('* CAPABILITY')) caps += ln.slice('* CAPABILITY'.length).trim() + ' ';
    }
    this.caps = caps.trim();
    if (oauthToken) {
      const okAuth = await this.authXoauth2(user, oauthToken);
      if (!okAuth) {
        await this.close();
        return { ok: false, err: '微软登录失败：令牌可能过期了，请到邮箱管理删掉这个邮箱，重新用微软账号登录添加。' };
      }
      return { ok: true, caps: this.caps };
    }
    const login = await this.cmd(`LOGIN "${imapQuote(user)}" "${imapQuote(pass)}"`);
    if (!login.ok) {
      await this.close();
      // 把服务器的原话带回来（比如 QQ 的 [AUTHENTICATIONFAILED] 原因）：只凭“登录失败”四个字，
      // 分不清是码错了、号错了还是服务没开。
      const detail = (login.text || '').replace(/^NO\s*/i, '').trim().slice(0, 120);
      const why = detail ? '服务器说：' + detail + '。' : '';
      return { ok: false, err: '登录失败：' + why + '账号或凭据不对，或服务没开。QQ 请用授权码，Gmail 请用应用专用密码；Outlook 请用微软账号登录添加。' };
    }
    // 网易 163/126/yeah/188（Coremail）要求登录后发 IMAP ID 自报身份（RFC 2971），否则 SELECT 拒登。
    await this.cmd('ID ("name" "MangguoMail" "version" "4.30" "vendor" "Mangguo" "support-url" "https://mangguo.lele.pp.ua/")');
    return { ok: true, caps: this.caps };
  }

  async authXoauth2(email, accessToken) {
    const blob = btoa(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`);
    const tag = this.nextTag();
    await this.writer.write(te.encode(`${tag} AUTHENTICATE XOAUTH2 ${blob}\r\n`));
    let guard = 0;
    while (guard++ < 100) {
      const line = await withTimeout(this.reader.readLogicalLine(), 20000, '认证超时').catch(() => null);
      if (line === null) return false;
      if (line.startsWith('+')) {
        await this.writer.write(te.encode('\r\n'));
        continue;
      }
      if (line.startsWith(tag + ' ')) return line.toUpperCase().includes(tag.toUpperCase() + ' OK');
    }
    return false;
  }

  // 发一条命令，读到带标签行才停。字面量已由 readLogicalLine 内联成文本。
  async cmd(command) {
    const tag = this.nextTag();
    await this.writer.write(te.encode(`${tag} ${command}\r\n`));
    const lines = [];
    let tagged = '';
    let guard = 0;
    while (guard++ < 10000) {
      const line = await withTimeout(this.reader.readLogicalLine(), 20000, '服务器没有回应').catch(() => null);
      if (line === null) break;
      lines.push(line);
      if (line.startsWith(tag + ' ')) {
        tagged = line;
        break;
      }
    }
    const ok = tagged !== '' && tagged.toUpperCase().startsWith(tag.toUpperCase() + ' OK');
    const text = tagged ? tagged.slice(tag.length + 1).trim() : '';
    return { ok, lines, text, tagged };
  }

  // 取字面量字节（BODY[] / BODY[part] 用）：读到 marker 行后精确读 n 字节。
  async cmdLiteral(command, markerRe) {
    const tag = this.nextTag();
    await this.writer.write(te.encode(`${tag} ${command}\r\n`));
    let bytes = null;
    let tagged = '';
    let guard = 0;
    while (guard++ < 10000) {
      const line = await withTimeout(this.reader.readPhysicalLine(), 20000, '服务器没有回应').catch(() => null);
      if (line === null) break;
      const m = line.match(markerRe);
      if (m && bytes === null) {
        bytes = await this.reader.readExact(parseInt(m[1], 10));
        continue;
      }
      if (line.startsWith(tag + ' ')) {
        tagged = line;
        break;
      }
    }
    const ok = tagged !== '' && tagged.toUpperCase().startsWith(tag.toUpperCase() + ' OK');
    return { ok, bytes, tagged };
  }

  async close() {
    try {
      if (this.writer) {
        try { await this.writer.write(te.encode(`${this.nextTag()} LOGOUT\r\n`)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    try { if (this.socket) await this.socket.close(); } catch { /* ignore */ }
    this.socket = null;
    this.reader = null;
    this.writer = null;
  }

  // ---------- 文件夹 ----------
  async listFolders() {
    const r = await this.cmd('LIST "" "*"');
    if (!r.ok) return [];
    const out = [];
    const lines = r.lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.toUpperCase().startsWith('* LIST')) continue;
      let attrs = '';
      const am = line.match(/\(([^)]*)\)/);
      if (am) attrs = am[1].trim();
      let name = '';
      if (/\{(\d+)\+?\}$/.test(line.trim())) {
        name = (lines[i + 1] || '').trim();
        i++;
      } else {
        name = listName(line);
      }
      if (name) out.push({ name, attrs });
    }
    return out;
  }

  folderMap(folders) {
    const labels = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Drafts', spam: '\\Junk', trash: '\\Trash' };
    const result = {};
    for (const f of folders) {
      const name = utf7Decode(f.name || '');
      const attrs = f.attrs || '';
      if (!name || attrs.toLowerCase().includes('\\noselect')) continue;
      for (const [label, attr] of Object.entries(labels)) {
        if (!result[label] && attrs.toLowerCase().includes(attr.toLowerCase())) result[label] = name;
      }
    }
    const names = {
      inbox: ['inbox'],
      sent: ['sent', 'sent items', 'sent messages', 'sent mail', '已发送', '发件箱', '寄件备存'],
      drafts: ['drafts', 'draft', '草稿', '草稿箱'],
      spam: ['junk', 'junk e-mail', 'junk email', 'spam', '垃圾邮件'],
      trash: ['trash', 'deleted', 'deleted items', 'deleted messages', '已删除', '已删除邮件', '垃圾箱'],
    };
    for (const f of folders) {
      const name = utf7Decode(f.name || '');
      if (!name) continue;
      const parts = name.split(/[/.]/);
      const base = parts[parts.length - 1];
      const low = base.trim().toLowerCase();
      const fullLow = name.trim().toLowerCase();
      for (const [label, cands] of Object.entries(names)) {
        if (result[label]) continue;
        if (cands.includes(low) || cands.includes(fullLow)) result[label] = name;
      }
    }
    const ordered = {};
    for (const label of ['inbox', 'sent', 'drafts', 'spam', 'trash']) {
      if (result[label]) ordered[label] = result[label];
    }
    return ordered;
  }

  async selectFolder(folder) {
    const wire = utf7Encode(folder);
    let r = await this.cmd(`SELECT "${imapQuote(wire)}"`);
    if (!r.ok && wire !== folder) r = await this.cmd(`SELECT "${imapQuote(folder)}"`);
    if (!r.ok && /^[A-Za-z0-9._-]+$/.test(folder)) r = await this.cmd(`SELECT ${folder}`);
    let exists = 0;
    for (const line of r.lines) {
      const m = line.match(/^\* (\d+) EXISTS/);
      if (m) { exists = parseInt(m[1], 10); break; }
    }
    return { ok: r.ok, exists, err: r.text || '' };
  }

  folderCandidates(label, map) {
    const cands = [];
    if (map[label]) cands.push(map[label]);
    const std = {
      inbox: ['INBOX'],
      sent: ['Sent', '已发送', 'INBOX.Sent', 'INBOX/已发送', 'INBOX/Sent', '发件箱', '寄件备存', 'Sent Items', 'Sent Messages', 'Sent Mail'],
      drafts: ['Drafts', '草稿箱', '草稿', 'INBOX.Drafts', 'INBOX/草稿箱'],
      spam: ['Junk', '垃圾邮件', 'Spam', 'INBOX.Junk', 'INBOX/垃圾邮件'],
      trash: ['Trash', '已删除', '已删除邮件', '垃圾箱', 'Deleted Items', 'Deleted Messages', 'INBOX.Trash', 'INBOX/已删除'],
    };
    for (const c of std[label] || []) cands.push(c);
    const seen = new Set();
    const out = [];
    for (const c of cands) {
      const wire = utf7Encode(c);
      if (seen.has(wire)) continue;
      seen.add(wire);
      out.push(c);
    }
    return out;
  }

  async openFolder(label, map) {
    const tried = [];
    let lastErr = '';
    for (const c of this.folderCandidates(label, map)) {
      tried.push(c);
      const sel = await this.selectFolder(c);
      if (sel.ok) return { ok: true, name: c, exists: sel.exists, tried, err: '' };
      lastErr = sel.err;
    }
    return { ok: false, name: '', exists: 0, tried, err: lastErr };
  }

  // ---------- 取信 ----------
  async uids() {
    const r = await this.cmd('UID SEARCH ALL');
    if (!r.ok) return [];
    const out = [];
    for (const line of r.lines) {
      if (!line.toUpperCase().startsWith('* SEARCH')) continue;
      for (const tok of line.slice('* SEARCH'.length).trim().split(/\s+/)) {
        if (/^\d+$/.test(tok)) out.push(parseInt(tok, 10));
      }
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  // 批量取列表：一批 UID 一条 FETCH，同时取 ENVELOPE 和原始 From 头。
  async fetchList(uids) {
    const out = [];
    const batch = uids.slice(0, 40);
    for (let start = 0; start < batch.length; start += 10) {
      const chunk = batch.slice(start, start + 10);
      const r = await this.cmd(`UID FETCH ${chunk.join(',')} (UID FLAGS ENVELOPE BODY.PEEK[HEADER.FIELDS (FROM)])`);
      if (!r.ok) continue;
      for (const line of r.lines) {
        const m = line.match(/^\* \d+ FETCH \(UID (\d+)/);
        if (!m) continue;
        const uid = parseInt(m[1], 10);
        const seen = /FLAGS \(([^)]*)\)/.test(line) && /\\Seen/i.test(line.match(/FLAGS \(([^)]*)\)/)[1]);
        const env = parseEnvelopeFromLine(line);
        // From 头优先（QQ 的 ENVELOPE 地址常缺 mailbox），ENVELOPE 备份
        let fromName = '';
        let fromAddr = '';
        const hm = line.match(/BODY\[HEADER\.FIELDS \(FROM\)\] (?:\{\d+\}\s*)?([\s\S]*?)(?:\)\s*)$/);
        if (hm) {
          let fromRaw = hm[1].trim();
          const fq = fromRaw.match(/^"((?:\\.|[^"\\])*)"$/);
          if (fq) fromRaw = fq[1].replace(/\\(.)/g, '$1');
          const headers = parseHeaders(fromRaw);
          if (headers.from) {
            const p = parseAddressHeader(decodeHeader(headers.from));
            fromName = p.name;
            fromAddr = p.addr;
          }
        }
        if (!fromAddr) {
          const f = env.from[0] || { name: '', mailbox: '', host: '' };
          fromName = decodeHeader(f.name || '');
          fromAddr = f.mailbox && f.host ? `${f.mailbox}@${f.host}` : (f.mailbox || '');
        }
        if (!fromName) fromName = decodeHeader((env.from[0] || {}).name || '');
        out.push({
          uid,
          seen,
          date: env.date,
          subject: decodeHeader(env.subject),
          from_name: displayName(fromName, fromAddr),
          from_addr: fromAddr,
          to: addrListToAddrs(env.to).join(', '),
          snippet: '',
        });
      }
    }
    const snips = await this.fetchSnippets(out.map((r) => r.uid));
    for (const row of out) row.snippet = snips[row.uid] || '';
    return out;
  }

  async fetchSnippets(uids) {
    const out = {};
    const clean = [...new Set(uids.map((u) => parseInt(u, 10)).filter((u) => u > 0))];
    for (let start = 0; start < clean.length; start += 10) {
      const chunk = clean.slice(start, start + 10);
      const r = await this.cmd(`UID FETCH ${chunk.join(',')} (BODY.PEEK[1]<0.300>)`);
      if (!r.ok) continue;
      for (const line of r.lines) {
        const m = line.match(/^\* \d+ FETCH \(UID (\d+)/);
        if (!m) continue;
        const uid = parseInt(m[1], 10);
        let data = '';
        const bm = line.match(/BODY\[1\] (?:\{\d+\}\s*)?([\s\S]*?)(?:\)\s*)$/);
        if (bm) {
          data = bm[1];
          const qm = data.match(/^"((?:\\.|[^"\\])*)"$/);
          if (qm) data = qm[1].replace(/\\(.)/g, '$1');
        }
        out[uid] = data ? cleanSnippet(data) : '';
      }
    }
    return out;
  }

  async fetchRaw(uid) {
    const r = await this.cmdLiteral(`UID FETCH ${uid} (BODY[])`, /BODY\[\] \{(\d+)\+?\}/);
    if (!r.ok || !r.bytes) return { ok: false, raw: null };
    return { ok: true, raw: r.bytes };
  }

  async fetchPart(uid, part) {
    const r = await this.cmdLiteral(`UID FETCH ${uid} (BODY.PEEK[${part}])`, new RegExp(`BODY\\[${part.replace('.', '\\.')} \\{([0-9]+)\\+?\\}`));
    if (!r.ok || !r.bytes) return { ok: false, bytes: null };
    return { ok: true, bytes: r.bytes };
  }

  async markSeen(uid) {
    return this.setSeen(uid, true);
  }

  async setSeen(uid, seen) {
    const r = await this.cmd(`UID STORE ${uid} ${seen ? '+' : '-'}FLAGS (\\Seen)`);
    return r.ok;
  }

  async move(uid, destFolder) {
    const wire = utf7Encode(destFolder);
    const quoted = `"${imapQuote(wire)}"`;
    const rawQuoted = `"${imapQuote(destFolder)}"`;
    if (this.caps && this.caps.toUpperCase().includes('MOVE')) {
      let r = await this.cmd(`UID MOVE ${uid} ${quoted}`);
      if (!r.ok && wire !== destFolder) r = await this.cmd(`UID MOVE ${uid} ${rawQuoted}`);
      if (r.ok) return { ok: true, err: '' };
      return { ok: false, err: '移动失败：服务器拒绝了移动操作。' };
    }
    let copy = await this.cmd(`UID COPY ${uid} ${quoted}`);
    if (!copy.ok && wire !== destFolder) copy = await this.cmd(`UID COPY ${uid} ${rawQuoted}`);
    if (!copy.ok) return { ok: false, err: '移动失败：复制到目标文件夹被拒绝。' };
    const del = await this.cmd(`UID STORE ${uid} +FLAGS (\\Deleted)`);
    if (!del.ok) return { ok: false, err: '移动失败：邮件已复制，但标记删除失败。' };
    const exp = await this.cmd('EXPUNGE');
    if (!exp.ok) return { ok: false, err: '移动失败：邮件已复制并标记删除，但清理失败。' };
    return { ok: true, err: '' };
  }

  async moveTo(uid, label, map) {
    const tried = [];
    for (const c of this.folderCandidates(label, map)) {
      tried.push(c);
      const r = await this.move(uid, c);
      if (r.ok) return { ok: true, name: c, err: '', tried };
    }
    return { ok: false, name: '', err: '移动失败：服务器拒绝了移动操作。', tried };
  }

  async delete(uid) {
    const del = await this.cmd(`UID STORE ${uid} +FLAGS (\\Deleted)`);
    if (!del.ok) return { ok: false, err: '删除失败。' };
    const exp = await this.cmd('EXPUNGE');
    if (!exp.ok) return { ok: false, err: '删除失败：标记成功，但清理失败。' };
    return { ok: true, err: '' };
  }

  // APPEND：发 APPEND {len}，等 + 号再发原文。
  async append(folder, rawBytes) {
    const tag = this.nextTag();
    const names = [utf7Encode(folder)];
    if (names[0] !== folder) names.push(folder);
    let gotPlus = false;
    for (const nm of names) {
      await this.writer.write(te.encode(`${tag} APPEND "${imapQuote(nm)}" {${rawBytes.length}}\r\n`));
      let guard = 0;
      let cont = '';
      while (guard++ < 20) {
        const ln = await withTimeout(this.reader.readPhysicalLine(), 20000, 'APPEND 超时').catch(() => null);
        if (ln === null) break;
        cont = ln.trim();
        if (cont.startsWith('+') || cont.startsWith(tag + ' ')) break;
      }
      if (cont.startsWith('+')) { gotPlus = true; break; }
    }
    if (!gotPlus) return false;
    await this.writer.write(rawBytes);
    await this.writer.write(te.encode('\r\n'));
    let guard = 0;
    while (guard++ < 100) {
      const line = await withTimeout(this.reader.readLogicalLine(), 20000, 'APPEND 超时').catch(() => null);
      if (line === null) return false;
      if (line.startsWith(tag + ' ')) return line.toUpperCase().includes(tag.toUpperCase() + ' OK');
    }
    return false;
  }
}

function listName(line) {
  let rest = line.replace(/^\* LIST\s+/i, '').trim();
  if (rest.startsWith('(')) {
    const close = rest.indexOf(')');
    if (close === -1) return '';
    rest = rest.slice(close + 1).trim();
  }
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end === -1) return '';
    rest = rest.slice(end + 1).trim();
  } else if (/^NIL/i.test(rest)) {
    rest = rest.slice(3).trim();
  }
  if (!rest) return '';
  if (rest.startsWith('"')) {
    const m = rest.match(/^"((?:[^"\\]|\\.)*)"/);
    if (!m) return '';
    return m[1].replace(/\\(.)/g, '$1');
  }
  return rest.split(/\s+/)[0] || '';
}

// 打开一个邮箱的 IMAP 连接并取文件夹映射；失败返回中文原因。
export async function connectMailbox(mb, credPlain, oauthToken = '') {
  const client = new ImapClient();
  const c = await client.connect({
    host: mb.imap_host,
    port: mb.imap_port,
    enc: mb.imap_enc || 'ssl',
    user: mb.login_user || mb.email,
    pass: credPlain,
    oauthToken,
  });
  if (!c.ok) return { client: null, map: {}, err: c.err };
  const folders = await client.listFolders();
  const map = client.folderMap(folders);
  return { client, map, err: '' };
}
