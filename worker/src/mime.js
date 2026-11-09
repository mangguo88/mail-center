// mime.js — 邮件头 / MIME 解析（对照 imap.php 的 mail_parse_mime / mail_decode_header /
// mail_clean_snippet / mail_clean_from_header 移植）

const te = new TextEncoder();
const td = new TextDecoder();

export function decodeUtf8Bytes(bytes, charset) {
  const cs = (charset || 'utf-8').trim().toLowerCase();
  if (cs === '' || cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    return td.decode(bytes);
  }
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return td.decode(bytes);
  }
}

// RFC2047 编码词：=?charset?B?...?= / =?charset?Q?...?=
export function decodeHeader(s) {
  if (!s || !s.includes('=?')) return s || '';
  return s.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = b64ToBytes(text);
      } else {
        bytes = qpToBytes(text.replace(/_/g, ' '));
      }
      return decodeUtf8Bytes(bytes, charset);
    } catch {
      return text;
    }
  });
}

// latin1 串转字节：字符码点即字节值（配合 TextDecoder('iso-8859-1') 的解码）。
export function latin1Bytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

export function b64ToBytes(str) {
  const clean = str.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function qpToBytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '=' && i + 2 < str.length + 1) {
      const h = str.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(h)) {
        bytes.push(parseInt(h, 16));
        i += 2;
        continue;
      }
      if (str[i + 1] === '\r' && str[i + 2] === '\n') { i += 2; continue; }
      if (str[i + 1] === '\n') { i += 1; continue; }
    }
    bytes.push(str.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(bytes);
}

export function qpDecodeText(str, charset) {
  return decodeUtf8Bytes(qpToBytes(str), charset);
}

// 解析邮件头：折行拼回上一行，键小写，重复头只留第一个。
export function parseHeaders(raw) {
  const headers = {};
  let last = '';
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line === '') continue;
    if ((line[0] === ' ' || line[0] === '\t') && last !== '') {
      headers[last] += ' ' + line.trim();
      continue;
    }
    const pos = line.indexOf(':');
    if (pos === -1) continue;
    const key = line.slice(0, pos).trim().toLowerCase();
    const val = line.slice(pos + 1).trim();
    if (!key) continue;
    if (!(key in headers)) {
      headers[key] = val;
      last = key;
    }
  }
  return headers;
}

export function splitHeadersBody(raw) {
  const p1 = raw.indexOf('\r\n\r\n');
  const p2 = raw.indexOf('\n\n');
  if (p1 !== -1 && (p2 === -1 || p1 < p2)) return [raw.slice(0, p1), raw.slice(p1 + 4)];
  if (p2 !== -1) return [raw.slice(0, p2), raw.slice(p2 + 2)];
  return [raw, ''];
}

// Content-Type / Content-Disposition 里分号后面的参数，键小写。
export function mimeParams(value) {
  const out = {};
  const re = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g;
  let m;
  while ((m = re.exec(value || '')) !== null) {
    const k = m[1].toLowerCase();
    out[k] = m[2] !== undefined && m[2] !== '' ? m[2].replace(/\\(.)/g, '$1') : (m[3] || '');
  }
  return out;
}

// 解析 "名字 <地址>" / 地址 形式的头。名字是单个英文字母时只留地址（Henna 常发这种）。
// 这是 from_addr 的主来源：QQ 的 ENVELOPE 地址里 mailbox 常是 NIL，原始 From 头才准。
export function parseAddressHeader(raw) {
  const s = (raw || '').trim();
  if (!s) return { name: '', addr: '' };
  const m = s.match(/^"?([^"<>]+)"?\s*<([^<>]+@[^<>]+)>\s*$/);
  if (m) {
    const name = decodeHeader(m[1].trim().replace(/^"|"$/g, ''));
    const addr = m[2].trim();
    if (name === '' || /^[A-Za-z]$/.test(name)) return { name: '', addr };
    return { name, addr };
  }
  const m2 = s.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (m2) {
    const addr = m2[1];
    const name = decodeHeader(s.replace(m2[0], '').replace(/["<>]/g, '').trim());
    if (name === '' || /^[A-Za-z]$/.test(name)) return { name: '', addr };
    return { name, addr };
  }
  return { name: decodeHeader(s), addr: '' };
}

export function displayName(name, addr) {
  const n = (name || '').trim();
  if (n === '') return addr;
  if (/^[A-Za-z]$/.test(n)) return addr;
  return n;
}

// 解析一封 MIME 邮件。返回 {headers, text, html, attachments:[{part, filename, size, ctype}]}。
// 附件只给元数据不给内容，下载走 /api/attachment 按 part 现取。
// part 编号按 MIME 结构编：1、1.1、1.2、2……
export function parseMime(raw, partPrefix = '') {
  const [headRaw, body] = splitHeadersBody(raw);
  const headers = parseHeaders(headRaw);
  const ctypeRaw = headers['content-type'] || 'text/plain';
  const ctype = (ctypeRaw.split(';', 1)[0] || '').trim().toLowerCase() || 'text/plain';
  const params = mimeParams(ctypeRaw);
  const charset = params.charset || 'utf-8';
  const dispRaw = headers['content-disposition'] || '';
  const disp = (dispRaw.split(';', 1)[0] || '').trim().toLowerCase();
  const dispParams = mimeParams(dispRaw);
  let filename = dispParams.filename || params.name || '';
  if (filename) filename = decodeHeader(filename);

  if (ctype.startsWith('multipart/') && params.boundary) {
    const boundary = params.boundary;
    let text = '';
    let html = '';
    const atts = [];
    const segments = body.split('--' + boundary);
    let idx = 0;
    for (let si = 1; si < segments.length; si++) {
      let seg = segments[si].replace(/^\r\n/, '');
      if (seg.trim().startsWith('--')) continue;
      if (seg.trim() === '') continue;
      seg = seg.replace(/\r\n$/, '');
      idx++;
      const partNo = partPrefix ? `${partPrefix}.${idx}` : String(idx);
      const sub = parseMime(seg, partNo);
      if (!text && sub.text) text = sub.text;
      if (!html && sub.html) html = sub.html;
      atts.push(...sub.attachments);
    }
    return { headers, text, html, attachments: atts };
  }

  const cte = (headers['content-transfer-encoding'] || '').trim().toLowerCase();
  // 原始邮件按 latin1 解码成串（一个字符 = 一个字节），这里按字节还原，
  // 否则 8bit 字符（GBK 正文）会被当成 UTF-8 编错，字符集转换就全错。
  let data = latin1Bytes(body);
  if (cte === 'base64') {
    try { data = b64ToBytes(body); } catch { data = te.encode(body); }
  } else if (cte === 'quoted-printable') {
    data = qpToBytes(body);
  }
  if (ctype.startsWith('text/')) data = te.encode(decodeUtf8Bytes(data, charset));

  const isAtt = disp === 'attachment' || (filename !== '' && ctype !== 'text/plain' && ctype !== 'text/html');
  if (isAtt) {
    return {
      headers, text: '', html: '',
      attachments: [{ part: partPrefix || '1', filename, size: data.length, ctype }],
    };
  }
  const textOut = ctype === 'text/plain' || ctype.startsWith('text/') ? td.decode(data) : '';
  const htmlOut = ctype === 'text/html' ? td.decode(data) : '';
  return { headers, text: textOut, html: htmlOut, attachments: [] };
}

export function bestBody(parsed) {
  const text = parsed.text || '';
  const html = parsed.html || '';
  if (text.trim() !== '') return { text, html };
  if (html.trim() === '') return { text: '', html: '' };
  let t = html;
  t = t.replace(/<(br\s*\/?|p|div|tr|li|h[1-4])[^>]*>/gi, '\n');
  t = t.replace(/<\/(p|div|tr|li|h[1-4])>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: t, html };
}

// 把一段原始正文开头清理成摘要（约 80 字），对照 mail_clean_snippet。
export function cleanSnippet(raw) {
  let t = (raw || '').trim();
  if (!t) return '';
  const flat = t.replace(/\s+/g, '');
  if (flat.length >= 20 && flat.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(flat)) {
    try {
      const dec = td.decode(b64ToBytes(flat));
      if (dec) t = dec;
    } catch { /* keep */ }
  } else if (t.includes('=') && /=[0-9A-Fa-f]{2}/.test(t)) {
    t = qpDecodeText(t, 'utf-8');
  }
  const kept = [];
  for (const ln of t.split(/\r\n|\n|\r/)) {
    if (ln.startsWith('--')) continue;
    if (/^Content-(Type|Transfer-Encoding|Disposition|ID)\s*:/i.test(ln)) continue;
    kept.push(ln);
  }
  t = kept.join('\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  t = t.replace(/\s+/g, ' ').trim();
  const ctrl = [...t].filter((c) => { const o = c.charCodeAt(0); return o < 9 || (o > 13 && o < 32); }).length;
  if (t.length > 0 && ctrl / t.length > 0.1) return '';
  return t.slice(0, 80).trim();
}
