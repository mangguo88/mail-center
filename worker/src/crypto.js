// crypto.js — Web Crypto 版密钥派生与加解密（替代 PHP 的 sodium/pwhash）
// 注意：PHP 版用 sodium pwhash 派生，Worker 没有 libsodium，算不出同一个密钥。
// 所以 PHP 存量凭据搬不过来，Phase 4 迁移时邮箱密码要重新填一次（配置照搬）。
// 新版统一用 PBKDF2-SHA256。KDF_ITERATIONS 是可调常量：登录时只跑一次，
// 记住我会话恢复不跑 KDF（见 sessions 表的 key_enc）；如果登录报 1102 就往低调。

export const KDF_ITERATIONS = 10000;
export const CRED_PREFIX = 'w1:';

const te = new TextEncoder();
const td = new TextDecoder();

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function b64encode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? te.encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Bytes(data) {
  const buf = typeof data === 'string' ? te.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

function saltBytes(saltB64, context) {
  const salt = b64decode(saltB64);
  const ctx = te.encode(':' + context);
  const out = new Uint8Array(salt.length + ctx.length);
  out.set(salt);
  out.set(ctx, salt.length);
  return out;
}

// PBKDF2-SHA256 派生 32 字节原始密钥。context 隔离用途：'login' / 'cred'。
export async function deriveRawKey(password, saltB64, context) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes(saltB64, context), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base, 256,
  );
  return new Uint8Array(bits);
}

// 站点登录哈希：sha256(派生密钥)，存在 site.pass_hash。登录时重算比对。
export async function loginHash(password, saltB64) {
  const raw = await deriveRawKey(password, saltB64, 'login');
  return sha256Hex(raw);
}

// 凭据加密密钥（CryptoKey），从同一口令、另一用途派生。
export async function credCryptoKey(password, saltB64) {
  const raw = await deriveRawKey(password, saltB64, 'cred');
  // extractable 必须为 true：发会话时要导出密钥原文包进 sessions.key_enc
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

export async function importCredKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

export async function exportCredKeyRaw(key) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

// 加密凭据：w1:<base64(iv 12B || ct+tag)>，和 PHP 的 sodium:/openssl: 前缀同理。
export async function encryptCred(plain, key) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plain)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv);
  packed.set(ct, iv.length);
  return CRED_PREFIX + b64encode(packed);
}

export async function decryptCred(stored, key) {
  if (!stored || !stored.startsWith(CRED_PREFIX)) return null;
  try {
    const packed = b64decode(stored.slice(CRED_PREFIX.length));
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return td.decode(pt);
  } catch {
    return null;
  }
}

// 会话令牌的密钥包装：PHP remember_key_for 的对应实现，
// 包装密钥 = SHA-256(令牌原文)，用来加密派生密钥原文，存在 sessions.key_enc。
// 令牌原文只在 Cookie 里，D1 里只有 token SHA-256 + 加密后的密钥。
export async function wrapKeyForToken(credKeyRaw, tokenHex) {
  const tokenRaw = new Uint8Array(tokenHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const wrapRaw = await sha256Bytes(tokenRaw);
  const wrapKey = await crypto.subtle.importKey('raw', wrapRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, credKeyRaw));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv);
  packed.set(ct, iv.length);
  return b64encode(packed);
}

export async function unwrapKeyForToken(keyEncB64, tokenHex) {
  try {
    const tokenRaw = new Uint8Array(tokenHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const wrapRaw = await sha256Bytes(tokenRaw);
    const wrapKey = await crypto.subtle.importKey('raw', wrapRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const packed = b64decode(keyEncB64);
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, ct));
  } catch {
    return null;
  }
}

export function hexEncode(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
