// tg.js — Telegram 新邮件推送（Phase 3，直连 Bot API，不走中转）
//
// 两条触发路（都调同一个 tgCheckAll）：
//  ① CF Cron Trigger：wrangler.jsonc 里 triggers.crons = ["*/5 * * * *"]，
//     每 5 分钟跑 scheduled()；② 外部定时任务（PHP 版的做法）：
//     GET /api/tgcheck?key=<site.tg_key>，不用登录，凭 tg_key 鉴权。
//
// 无人值守要能解邮箱凭据：开启 TG 时（登录状态下，credKey 在手），把派生密钥
// 原文用 tg_key 包一份存 D1 settings.tg_wrap（SHA-256(tg_key) 作 AES 密钥，
// 不跑 PBKDF2，免得 Cron 里超 CPU）。tg_key 本身也存在 site 表。
// 这和 PHP 版的 notify_key_blob 一个做法：开 TG 就等于在服务器上留了一份
// 无人值守可用的解密密钥；关掉 TG 就删 tg_wrap，Cron 再也解不开。
// 改站点密码时要重包 tg_wrap（密码改了旧包就解不开邮箱了）。

import { listMailboxes, tgSeenGet, tgSeenSet, getSettings, saveSettings } from './db.js';
import { connectMailbox } from './imap.js';
import { decryptCred, sha256Bytes, b64encode, b64decode, hexEncode, randomBytes } from './crypto.js';

const te = new TextEncoder();
const td = new TextDecoder();

// 管理中心公开地址（通知里“点开看全文”的链接用它；?mb= 会直接打开那个邮箱）。
export const SITE_URL = 'https://mail-center.mangguo88.workers.dev/';

// ---------- tg_key / tg_wrap ----------
// 把派生密钥原文包起来存 D1（开启 TG 时调一次）。
export async function wrapTgKey(rawCredKey, tgKey) {
  const wrapRaw = await sha256Bytes(te.encode(tgKey));
  const wrapKey = await crypto.subtle.importKey('raw', wrapRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, rawCredKey));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv);
  packed.set(ct, iv.length);
  return b64encode(packed);
}

// 从 D1 的 tg_wrap 解出派生密钥原文（Cron / tgcheck 时调）。
export async function unwrapTgKey(db, site) {
  const settings = await getSettings(db);
  const wrap = settings.tg_wrap || '';
  const tgKey = (site.tg_key || '').trim();
  if (!wrap || !tgKey) return null;
  try {
    const wrapRaw = await sha256Bytes(te.encode(tgKey));
    const wrapKey = await crypto.subtle.importKey('raw', wrapRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const packed = b64decode(wrap);
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, ct));
    if (raw.length !== 32) return null;
    return raw;
  } catch {
    return null;
  }
}

// ---------- 发一条 TG 消息（直连 api.telegram.org） ----------
export async function tgSendDirect(token, chatId, text) {
  try {
    const resp = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'MailCenter/1.0' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const d = await resp.json().catch(() => null);
    if (d && d.ok) return { ok: true };
    let desc = String((d && d.description) || ('HTTP ' + resp.status));
    if (desc === 'Unauthorized') desc = 'Token 不对（Unauthorized），去 @BotFather 重新复制一遍';
    else if (/chat not found/i.test(desc)) desc = '找不到这个聊天（chat not found）：先给机器人发一条消息（点 Start），再查 chat_id';
    else if (/bot was blocked/i.test(desc)) desc = '机器人被你拉黑了（bot was blocked），去 TG 里解除拉黑再试';
    return { ok: false, err: 'Telegram 说：' + desc.slice(0, 120) };
  } catch (e) {
    return { ok: false, err: 'api.telegram.org 没连上：' + (e && e.message ? e.message : '网络错误') };
  }
}

// 发信时间转北京时间 Y-m-d H:i（解析不出就原样回）。
export function fmtBj(dateStr) {
  const ms = Date.parse(String(dateStr || ''));
  if (!Number.isFinite(ms)) return String(dateStr || '');
  const bj = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return bj.getUTCFullYear() + '-' + p(bj.getUTCMonth() + 1) + '-' + p(bj.getUTCDate()) + ' ' + p(bj.getUTCHours()) + ':' + p(bj.getUTCMinutes());
}

function preview120(s) {
  const t = String(s || '').trim();
  if (!t) return '（没有正文预览）';
  return [...t].slice(0, 120).join('');
}

function tgText(mb, row) {
  const subj = String(row.subject || '').trim() || '（无主题）';
  const from = String(row.from_name || '').trim()
    ? String(row.from_name) + ' <' + String(row.from_addr || '') + '>'
    : String(row.from_addr || '');
  return '📧 新邮件\n邮箱：' + mb.email
    + '\n时间：' + fmtBj(row.date) + '（北京时间）'
    + '\n发件人：' + from
    + '\n标题：' + subj
    + '\n内容：' + preview120(row.snippet)
    + '\n👉 点开看全文：' + SITE_URL + '?mb=' + encodeURIComponent(mb.id);
}

// ---------- 查一轮新邮件并推 TG（Cron / tgcheck / 立即查一轮共用） ----------
// 只查收件箱、只查 kind=imap 且 status=ok 的邮箱；第一次跑只记基线、不推；
// 每轮每邮箱最多推 5 封。返回 { checked, sent, notes[] }。
//
// 只推“基线之后新到的邮件”：基线是见过的最大 UID（高水位线），只有 UID 大于
// 它才算新邮件——不管已读未读，旧邮件永远不推。开启 TG 开关时会清掉全部基线，
// 下一轮只记新基线、不推开通前的旧邮件；新加的邮箱第一次跑也只记基线。
// UID 最大值变小（邮箱重建、UIDVALIDITY 变了）时也只重记基线、不推。
export async function tgCheckAll(env, credKey, site) {
  const checked = { n: 0 };
  let sent = 0;
  const notes = [];
  if (!site || !site.tg_enabled || !site.tg_bot_token || !site.tg_chat_id) {
    return { checked: 0, sent: 0, notes: ['TG 没开或没填 Token / chat_id'] };
  }
  const mbs = await listMailboxes(env.DB);
  for (const mb of mbs) {
    if (mb.kind && mb.kind !== 'imap') continue; // 域名邮箱走 HTTP API，暂不推
    if (mb.status !== 'ok') continue;
    checked.n++;
    let pass = '';
    try {
      pass = mb.pass_enc ? (await decryptCred(mb.pass_enc, credKey)) || '' : '';
    } catch { pass = ''; }
    if (!pass) { notes.push(mb.email + '：凭据解不开'); continue; }
    const { client, map, err: connErr } = await connectMailbox(mb, pass);
    if (!client) { notes.push(mb.email + '：连不上（' + connErr + '）'); continue; }
    try {
      const opened = await client.openFolder('inbox', map);
      if (!opened.ok) continue;
      const uids = await client.uids();
      const seen = await tgSeenGet(env.DB, mb.id); // {max, uids}，旧格式数组也照读
      const first = seen.max === 0 && seen.uids.length === 0;
      const maxUid = uids.length ? Math.max.apply(null, uids) : 0;
      // 正常情况下 UID 只增不减；最大值变小说明邮箱重建了，旧 UID 作废，重记基线。
      const reset = !first && maxUid > 0 && maxUid < seen.max;
      const fresh = (!first && !reset) ? uids.filter((u) => u > seen.max) : [];
      // 基线先存（高水位线 + 最新 200 个 UID），第一次跑到这里就停，不推旧邮件。
      const merged = [...new Set([...seen.uids, ...uids])].sort((a, b) => a - b).slice(-200);
      await tgSeenSet(env.DB, mb.id, { max: Math.max(seen.max, maxUid), uids: merged });
      if (first || reset || fresh.length === 0) continue;
      const todo = fresh.slice(-5); // 最新 5 封，UID 从旧到新推
      const rows = await client.fetchList(todo);
      for (const row of rows) {
        const r = await tgSendDirect(site.tg_bot_token, site.tg_chat_id, tgText(mb, row));
        if (r.ok) sent++;
        else notes.push(mb.email + '：TG 没发出去（' + r.err + '）');
      }
    } catch (e) {
      notes.push(mb.email + '：查信失败（' + (e && e.message ? e.message : '未知错误') + '）');
    } finally {
      await client.close();
    }
  }
  return { checked: checked.n, sent, notes };
}

// 记一轮运行结果（设置页“上次运行”显示用，存 D1 settings.tg_last_run）。
export async function tgSaveLastRun(env, result) {
  const now = fmtBj(new Date().toISOString());
  const text = now + ' 查 ' + result.checked + ' 个邮箱，推 ' + result.sent + ' 条'
    + (result.notes && result.notes.length ? '，' + result.notes.join('；') : '');
  await saveSettings(env.DB, { tg_last_run: text });
  return text;
}

export function tgNewKey() {
  return hexEncode(randomBytes(16)); // 32 位十六进制，和 PHP 的 bin2hex(random_bytes(16)) 一样
}
