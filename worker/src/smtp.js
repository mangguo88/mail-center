// smtp.js — SMTP 发信（对照 imap.php 的 mail_smtp_send / mail_build_sent_raw 移植）
// ssl 直连（465），tls 先明文连，EHLO 后 STARTTLS + 加密，再 EHLO；
// AUTH LOGIN 先试，不行再试 AUTH PLAIN（DNSHE 只认 PLAIN）。

import { connect } from 'cloudflare:sockets';

const te = new TextEncoder();
const td = new TextDecoder();

function b64(str) {
  return btoa(String.fromCharCode(...te.encode(str)));
}

function rfc2047Encode(s) {
  if (!s || !/[^\x20-\x7E]/.test(s)) return s;
  return '=?UTF-8?B?' + b64(s) + '?=';
}

function b64Bytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/.{76}/g, '$&\r\n');
}

function b64Text(str) {
  return b64Bytes(te.encode(str));
}

function boundaryStr(prefix) {
  const rnd = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return prefix + rnd;
}

// 附件文件名参数：纯 ASCII 直接引起来，非 ASCII 用 RFC 2231（参数名本身带星号）。
function mimeFilenameParam(paramName, fname) {
  const name = String(fname || 'attachment');
  if (/^[\x20-\x7E]+$/.test(name) && !/["\\]/.test(name)) return `${paramName}="${name}"`;
  return `${paramName}*=UTF-8''${encodeURIComponent(name)}`;
}

// opts: { html?: string, attachments?: [{ filename, ctype, bytes: Uint8Array }] }
// 无 HTML、无附件时和原来一样：单段 text/plain；有 HTML 用 multipart/alternative；
// 有附件再包一层 multipart/mixed。
export function buildSentRaw(from, fromName, to, cc, subject, body, opts = {}) {
  const fromNameTrim = (fromName || '').trim();
  let fromHdr = from;
  if (fromNameTrim !== '') {
    const encName = rfc2047Encode(fromNameTrim);
    let disp;
    if (encName === fromNameTrim && /["<>@,;:]/.test(fromNameTrim)) {
      disp = '"' + fromNameTrim.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    } else {
      disp = encName;
    }
    fromHdr = `${disp} <${from}>`;
  }
  const toList = to.filter(Boolean);
  const ccList = (cc || []).filter(Boolean);
  const headers = [];
  headers.push(`From: ${fromHdr}`);
  headers.push(`To: ${toList.join(', ')}`);
  if (ccList.length) headers.push(`Cc: ${ccList.join(', ')}`);
  headers.push(`Subject: ${rfc2047Encode(subject || '')}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  const domain = from.includes('@') ? from.split('@')[1] : 'localhost';
  const rnd = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  headers.push(`Message-ID: <${rnd}@${domain}>`);
  headers.push('MIME-Version: 1.0');
  const html = String(opts.html || '');
  const atts = (opts.attachments || []).filter((a) => a && a.bytes && a.bytes.length > 0);
  if (!html && atts.length === 0) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('Content-Transfer-Encoding: base64');
    return headers.join('\r\n') + '\r\n\r\n' + b64Text(body || '');
  }
  // 文本 + HTML 二选一（alternative）
  const altBoundary = boundaryStr('mc-alt-');
  const altParts = [];
  altParts.push('--' + altBoundary);
  altParts.push('Content-Type: text/plain; charset=utf-8');
  altParts.push('Content-Transfer-Encoding: base64');
  altParts.push('');
  altParts.push(b64Text(body || ''));
  if (html) {
    altParts.push('--' + altBoundary);
    altParts.push('Content-Type: text/html; charset=utf-8');
    altParts.push('Content-Transfer-Encoding: base64');
    altParts.push('');
    altParts.push(b64Text(html));
  }
  altParts.push('--' + altBoundary + '--');
  const altBody = altParts.join('\r\n');
  if (atts.length === 0) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    return headers.join('\r\n') + '\r\n\r\n' + altBody;
  }
  const mixBoundary = boundaryStr('mc-mix-');
  headers.push(`Content-Type: multipart/mixed; boundary="${mixBoundary}"`);
  const parts = [];
  parts.push('--' + mixBoundary);
  parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  parts.push('');
  parts.push(altBody);
  for (const a of atts) {
    parts.push('--' + mixBoundary);
    parts.push(`Content-Type: ${a.ctype || 'application/octet-stream'}; ${mimeFilenameParam('name', a.filename)}`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; ${mimeFilenameParam('filename', a.filename)}`);
    parts.push('');
    parts.push(b64Bytes(a.bytes));
  }
  parts.push('--' + mixBoundary + '--');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

class SmtpReader {
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
  async readLine() {
    while (true) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = td.decode(this.buf.slice(0, i));
          this.buf = this.buf.slice(i + 2);
          return line;
        }
      }
      if (!(await this._fill())) {
        if (this.buf.length === 0) return null;
        const line = td.decode(this.buf);
        this.buf = new Uint8Array(0);
        return line;
      }
    }
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// 发一封邮件。返回 {ok, err}，错误中文、不带凭据。
// opts 可带 html（富文本正文）与 attachments（[{ filename, ctype, bytes }]）。
export async function smtpSend({ host, port, enc = 'tls', from, fromName = '', pass, to, cc = [], subject, body, html = '', attachments = [] }) {
  const toList = [...new Set([...to, ...cc].map((x) => (x || '').trim()).filter(Boolean))];
  const toOnly = [...new Set(to.map((x) => (x || '').trim()).filter(Boolean))];
  if (!host || !port || !from || !pass || toOnly.length === 0) {
    return { ok: false, err: 'SMTP 服务器、端口、发件人、凭据或收件人没填对。' };
  }
  const secureTransport = enc === 'tls' ? 'starttls' : 'on';
  let socket;
  try {
    socket = connect({ hostname: host, port }, { secureTransport });
    await withTimeout(socket.opened, 15000, 'timeout');
  } catch {
    return { ok: false, err: `连不上 ${host}:${port}，先检查 SMTP 服务器地址和端口。` };
  }
  let reader = new SmtpReader(socket.readable);
  let writer = socket.writable.getWriter();
  const close = async () => { try { await socket.close(); } catch { /* ignore */ } };

  const readReply = async () => {
    let out = '';
    for (let guard = 0; guard < 20; guard++) {
      const line = await withTimeout(reader.readLine(), 20000, 'timeout').catch(() => null);
      if (line === null) break;
      out += line + '\n';
      if (line.length >= 4 && line[3] === ' ') break;
      if (line.length < 4) break;
    }
    return out;
  };
  const sendCmd = async (cmd, expect) => {
    await writer.write(te.encode(cmd + '\r\n'));
    const reply = await readReply();
    const code = reply.slice(0, 3);
    return { ok: expect.includes(code), reply, code };
  };

  try {
    const greet = await readReply();
    if (!greet.startsWith('220')) {
      await close();
      return { ok: false, err: `SMTP 服务器没有回应（${host}:${port}，${enc === 'ssl' ? 'SSL' : 'STARTTLS'}），可能是端口或加密方式不对：465 一般配 SSL，587 一般配 STARTTLS。` };
    }
    const ehlo = await sendCmd('EHLO localhost', ['250']);
    if (!ehlo.ok) {
      await close();
      return { ok: false, err: 'SMTP 问候（EHLO）被服务器拒绝。' };
    }
    if (enc === 'tls') {
      const st = await sendCmd('STARTTLS', ['220']);
      if (!st.ok) {
        await close();
        return { ok: false, err: 'STARTTLS 失败，服务器不支持 STARTTLS，或端口不对（STARTTLS 一般用 587）。' };
      }
      const secure = socket.startTls();
      socket = secure;
      reader = new SmtpReader(secure.readable);
      writer = secure.writable.getWriter();
      await withTimeout(secure.opened, 15000, 'timeout');
      const ehlo2 = await sendCmd('EHLO localhost', ['250']);
      if (!ehlo2.ok) {
        await close();
        return { ok: false, err: 'STARTTLS 之后 EHLO 被服务器拒绝。' };
      }
    }
    // 先试 AUTH LOGIN，不行再试 AUTH PLAIN（DNSHE 只认 PLAIN）
    const auth = await sendCmd('AUTH LOGIN', ['334']);
    if (auth.ok) {
      const u = await sendCmd(b64(from), ['334']);
      if (!u.ok) {
        await close();
        return { ok: false, err: '认证失败：账号或凭据不对。' };
      }
      const p = await sendCmd(b64(pass), ['235']);
      if (!p.ok) {
        await close();
        return { ok: false, err: '认证失败：账号或凭据不对。' };
      }
    } else {
      const plain = await sendCmd('AUTH PLAIN ' + b64(`\0${from}\0${pass}`), ['235']);
      if (!plain.ok) {
        await close();
        return { ok: false, err: '服务器不支持 AUTH LOGIN 和 AUTH PLAIN，或拒绝认证。' };
      }
    }
    const mf = await sendCmd(`MAIL FROM:<${from}>`, ['250']);
    if (!mf.ok) {
      await close();
      return { ok: false, err: '发件人地址被服务器拒绝。' };
    }
    for (const rcpt of toList) {
      const r = await sendCmd(`RCPT TO:<${rcpt}>`, ['250', '251']);
      if (!r.ok) {
        await close();
        return { ok: false, err: `收件人 ${rcpt} 被服务器拒绝。` };
      }
    }
    const data = await sendCmd('DATA', ['354']);
    if (!data.ok) {
      await close();
      return { ok: false, err: '服务器拒绝进入 DATA 阶段。' };
    }
    const raw = buildSentRaw(from, fromName, toOnly, cc, subject, body, { html, attachments });
    const lines = raw.split('\r\n').map((ln) => (ln.startsWith('.') ? '.' + ln : ln));
    let msg = lines.join('\r\n');
    if (!msg.endsWith('\r\n')) msg += '\r\n';
    await writer.write(te.encode(msg));
    await writer.write(te.encode('.\r\n'));
    const reply = await readReply();
    if (!reply.startsWith('250')) {
      await close();
      return { ok: false, err: '发送失败：服务器没有接受这封邮件。' };
    }
    try { await writer.write(te.encode('QUIT\r\n')); } catch { /* ignore */ }
    await close();
    return { ok: true, err: '' };
  } catch (e) {
    await close();
    return { ok: false, err: '发送失败：' + (e.message || '连接中断。') };
  }
}
