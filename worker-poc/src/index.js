// Mail Center PoC — Phase 0
// 目标：验证免费 Workers 能否直连 IMAP 993（TLS），登录并拉取收件箱信封，
// 且一次请求不触 10ms CPU 上限（超了会报 error 1102）。
// 只读，不发信、不删信。凭据走 wrangler secret，绝不写进代码。
import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const dec = new TextDecoder();

function indexOfCRLF(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

// ---- socket 上的行/字面量读取 ----
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
  async _readPhysicalLine() {
    while (true) {
      const idx = indexOfCRLF(this.buf);
      if (idx >= 0) {
        const line = dec.decode(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + 2);
        return line;
      }
      if (!(await this._fill())) {
        if (this.buf.length === 0) return null;
        const line = dec.decode(this.buf);
        this.buf = new Uint8Array(0);
        return line;
      }
    }
  }
  async _readExact(n) {
    while (this.buf.length < n) {
      if (!(await this._fill())) break;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  // 一条逻辑行：物理行尾若有 {n} 字面量标记，读出字面量字节再接后续内容
  async readLogicalLine() {
    let line = await this._readPhysicalLine();
    if (line === null) return null;
    let m;
    while ((m = line.match(/\{(\d+)\}$/))) {
      const n = parseInt(m[1], 10);
      const lit = await this._readExact(n);
      line = line.slice(0, line.length - m[0].length) + dec.decode(lit);
      const rest = await this._readPhysicalLine();
      if (rest === null) break;
      line += rest;
    }
    return line;
  }
}

// ---- 极简 IMAP 令牌解析（括号、引号、NIL、原子） ----
function tokenize(s) {
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

function parseTokens(toks) {
  let pos = 0;
  function parseOne() {
    const t = toks[pos++];
    if (t === '(') {
      const arr = [];
      while (toks[pos] !== ')') {
        if (pos >= toks.length) break;
        arr.push(parseOne());
      }
      pos++; // eat ')'
      return arr;
    }
    if (t && typeof t === 'object') return t.q;
    if (t === 'NIL') return null;
    return t;
  }
  return parseOne();
}

// ---- RFC 2047 encoded-word 解码（=?UTF-8?B?...?= / =?UTF-8?Q?...?=） ----
function decodeWord(s) {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, encType, data) => {
    try {
      if (encType.toUpperCase() === 'B') {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder(charset).decode(bytes);
      }
      const qp = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const bytes = new Uint8Array(qp.length);
      for (let i = 0; i < qp.length; i++) bytes[i] = qp.charCodeAt(i);
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return data;
    }
  });
}

function addrToString(addrList) {
  if (!Array.isArray(addrList) || addrList.length === 0) return { name: '', addr: '' };
  const a = addrList[0];
  if (!Array.isArray(a)) return { name: '', addr: '' };
  const [name, mailbox, host] = a;
  return {
    name: name ? decodeWord(String(name)) : '',
    addr: mailbox && host ? `${mailbox}@${host}` : (mailbox || ''),
  };
}

async function imapTest(env, count) {
  const host = env.IMAP_HOST;
  const port = parseInt(env.IMAP_PORT || '993', 10);
  const user = env.IMAP_USER;
  const pass = env.IMAP_PASS;
  if (!host || !user || !pass) {
    return { ok: false, error: 'missing_secret', hint: '先跑 wrangler secret put IMAP_HOST / IMAP_USER / IMAP_PASS' };
  }
  const t0 = Date.now();
  const socket = connect({ hostname: host, port }, { secureTransport: 'on' });
  const reader = new ImapReader(socket.readable);
  const writer = socket.writable.getWriter();
  try {
    await socket.opened;
    const greeting = await reader.readLogicalLine();
    if (!greeting || !greeting.startsWith('* OK')) {
      return { ok: false, error: 'bad_greeting', greeting };
    }
    const send = async (line) => {
      await writer.write(enc.encode(line + '\r\n'));
    };
    // 读到指定 tag 的 OK/NO/BAD 为止，收集中间所有 * 行
    const command = async (tag, line) => {
      await send(`${tag} ${line}`);
      const untagged = [];
      while (true) {
        const l = await reader.readLogicalLine();
        if (l === null) throw new Error('connection closed while waiting for ' + tag);
        if (l.startsWith(tag + ' ')) return { status: l, untagged };
        untagged.push(l);
      }
    };
    const login = await command('a001', `LOGIN "${user}" "${pass.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    if (!login.status.includes('OK')) {
      return { ok: false, error: 'login_failed', status: login.status };
    }
    const select = await command('a002', 'SELECT INBOX');
    if (!select.status.includes('OK')) {
      return { ok: false, error: 'select_failed', status: select.status };
    }
    const exists = parseInt((select.status.match(/\[?EXISTS\]?/) && '') || '0', 10) || null;
    const fetch = await command('a003', `FETCH 1:${count} (UID ENVELOPE)`);
    if (!fetch.status.includes('OK')) {
      return { ok: false, error: 'fetch_failed', status: fetch.status };
    }
    const messages = [];
    for (const line of fetch.untagged) {
      const m = line.match(/^\* (\d+) FETCH \((.*)\)$/);
      if (!m) continue;
      const toks = tokenize(m[2]);
      const parsed = parseTokens(toks);
      let uid = null, envArr = null;
      for (let i = 0; i + 1 < parsed.length; i += 2) {
        if (parsed[i] === 'UID') uid = parsed[i + 1];
        if (parsed[i] === 'ENVELOPE') envArr = parsed[i + 1];
      }
      if (!envArr) continue;
      const [date, subject, from] = envArr;
      const f = addrToString(from);
      messages.push({
        seq: parseInt(m[1], 10),
        uid: uid ? parseInt(uid, 10) : null,
        date: date || '',
        subject: subject ? decodeWord(String(subject)) : '',
        from_name: f.name,
        from_addr: f.addr,
      });
    }
    await command('a004', 'LOGOUT');
    return { ok: true, host, port, exists, count: messages.length, ms: Date.now() - t0, messages };
  } finally {
    try { await socket.close(); } catch { /* ignore */ }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/') {
      return new Response('Mail Center PoC — GET /imap-test?n=10 直连 IMAP 993 拉收件箱信封\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    if (url.pathname === '/imap-test') {
      const n = Math.min(Math.max(parseInt(url.searchParams.get('n') || '10', 10) || 10, 1), 30);
      try {
        const result = await Promise.race([
          imapTest(env, n),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 20s')), 20000)),
        ]);
        return Response.json(result, { status: result.ok ? 200 : 500 });
      } catch (e) {
        return Response.json({ ok: false, error: 'exception', message: String(e && e.message || e) }, { status: 500 });
      }
    }
    return new Response('not found', { status: 404 });
  },
};
