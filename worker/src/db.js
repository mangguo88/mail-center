// db.js — D1 数据层（对照 index.php 的 load_site / load_mailboxes / cache / remember）

export async function getSite(db) {
  const row = await db.prepare('SELECT * FROM site WHERE id = 1').first();
  return row || null;
}

// ---------- 管理面板可调设置（键值表：自动刷新 / 每页几封 / 发信超时） ----------
// CF 面板环境变量（MC_AUTO_REFRESH_MS 等）优先于这里的值；没在 CF 面板设才用这里的。
export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of results || []) out[r.key] = r.value;
  return out;
}

export async function saveSettings(db, obj) {
  for (const [k, v] of Object.entries(obj)) {
    await db.prepare(
      `INSERT INTO settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value=?2`,
    ).bind(k, String(v)).run();
  }
}

export async function saveSite(db, site) {
  await db.prepare(
    `INSERT INTO site (id, username, pass_hash, salt, display_name, cache_ttl, tg_enabled, tg_bot_token, tg_chat_id, tg_key)
     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET username=?1, pass_hash=?2, salt=?3, display_name=?4, cache_ttl=?5, tg_enabled=?6, tg_bot_token=?7, tg_chat_id=?8, tg_key=?9`,
  ).bind(
    site.username, site.pass_hash, site.salt, site.display_name ?? '芒果邮箱管理中心',
    site.cache_ttl ?? 1, site.tg_enabled ? 1 : 0, site.tg_bot_token ?? '', site.tg_chat_id ?? '', site.tg_key ?? '',
  ).run();
}

export async function listMailboxes(db) {
  const { results } = await db.prepare('SELECT * FROM mailboxes ORDER BY sort ASC, created_at ASC').all();
  return results || [];
}

export async function getMailbox(db, id) {
  return await db.prepare('SELECT * FROM mailboxes WHERE id = ?1').bind(id).first();
}

export async function saveMailbox(db, mb) {
  await db.prepare(
    `INSERT INTO mailboxes (id, kind, group_name, email, address, imap_host, imap_port, imap_enc, smtp_host, smtp_port, smtp_enc, login_user, pass_enc, panel_url, panel_login, panel_pass_enc, status, sort, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
     ON CONFLICT(id) DO UPDATE SET kind=?2, group_name=?3, email=?4, address=?5, imap_host=?6, imap_port=?7, imap_enc=?8, smtp_host=?9, smtp_port=?10, smtp_enc=?11, login_user=?12, pass_enc=?13, panel_url=?14, panel_login=?15, panel_pass_enc=?16, status=?17, sort=?18`,
  ).bind(
    mb.id, mb.kind || 'imap', mb.group_name || '', mb.email, mb.address || '', mb.imap_host || '', mb.imap_port || 993,
    mb.imap_enc || 'ssl', mb.smtp_host || '', mb.smtp_port || 587, mb.smtp_enc || 'tls',
    mb.login_user || mb.email, mb.pass_enc || '', mb.panel_url || '', mb.panel_login || '', mb.panel_pass_enc || '',
    mb.status || 'ok', mb.sort || 0, mb.created_at || Date.now(),
  ).run();
}

// 列表缓存版本号 +1（KV 失效用）：改动后旧 KV key 自然没人读，不占 KV delete 额度。
export async function bumpCacheVersion(db, id) {
  await db.prepare('UPDATE mailboxes SET cache_version = cache_version + 1 WHERE id = ?1').bind(id).run();
}

export async function deleteMailbox(db, id) {
  await db.prepare('DELETE FROM mailboxes WHERE id = ?1').bind(id).run();
  await db.prepare('DELETE FROM cache WHERE mailbox_id = ?1').bind(id).run();
}

// ---------- TG 轮询已通知 UID（每邮箱一行 JSON 数组） ----------
export async function tgSeenGet(db, mbId) {
  const row = await db.prepare('SELECT uids FROM tg_seen WHERE mailbox_id = ?1').bind(mbId).first();
  if (!row) return [];
  try {
    const arr = JSON.parse(row.uids || '[]');
    return Array.isArray(arr) ? arr.map((u) => parseInt(u, 10)).filter((u) => u > 0) : [];
  } catch {
    return [];
  }
}

export async function tgSeenSet(db, mbId, uids) {
  await db.prepare(
    `INSERT INTO tg_seen (mailbox_id, uids, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(mailbox_id) DO UPDATE SET uids=?2, updated_at=?3`,
  ).bind(mbId, JSON.stringify(uids), Date.now()).run();
}

// ---------- 分组（单独建的空分组：还没加邮箱也能先建好，放这里） ----------
// “未分组”在 mailboxes 里存的是空串，改名 / 计数时要换算。
export function groupDbName(name) { return (name || '').trim() === '未分组' ? '' : (name || '').trim(); }

export async function listGroups(db) {
  const { results } = await db.prepare('SELECT * FROM groups ORDER BY sort ASC, created_at ASC').all();
  return results || [];
}

export async function listProviders(db) {
  const { results } = await db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all();
  return results || [];
}

export async function getProvider(db, domain) {
  return db.prepare('SELECT * FROM providers WHERE domain = ?1').bind(domain).first();
}

export async function saveProvider(db, pr) {
  await db.prepare(
    `INSERT INTO providers (domain, label, imap_host, imap_port, imap_enc, smtp_host, smtp_port, smtp_enc, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(domain) DO UPDATE SET label=?2, imap_host=?3, imap_port=?4, imap_enc=?5, smtp_host=?6, smtp_port=?7, smtp_enc=?8`,
  ).bind(
    pr.domain, pr.label || pr.domain, pr.imap_host || '', pr.imap_port || 993, pr.imap_enc || 'ssl',
    pr.smtp_host || '', pr.smtp_port || 587, pr.smtp_enc || 'tls', Date.now(),
  ).run();
}

export async function deleteProvider(db, domain) {
  await db.prepare('DELETE FROM providers WHERE domain = ?1').bind(domain).run();
}

export async function saveGroup(db, name) {
  const row = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM groups').first();
  const sort = (row ? row.m : 0) + 10;
  await db.prepare(
    `INSERT INTO groups (name, sort, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(name) DO NOTHING`,
  ).bind(name, sort, Date.now()).run();
}

export async function deleteGroup(db, name) {
  await db.prepare('DELETE FROM groups WHERE name = ?1').bind(name).run();
}

export async function renameGroup(db, oldName, newName) {
  const oldDb = groupDbName(oldName);
  const newDb = groupDbName(newName);
  await db.prepare('UPDATE groups SET name = ?2 WHERE name = ?1').bind(oldName, newName).run();
  await db.prepare('UPDATE mailboxes SET group_name = ?2 WHERE group_name = ?1').bind(oldDb, newDb).run();
}

export async function countGroupMailboxes(db, name) {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM mailboxes WHERE group_name = ?1').bind(groupDbName(name)).first();
  return row ? row.c : 0;
}

// ---------- 收件箱缓存（默认 1 分钟，设置页可改） ----------
export function cacheId(mbId, folder) {
  return `${mbId}__${folder}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function cacheRead(db, mbId, folder, ttlMinutes) {
  const row = await db.prepare('SELECT * FROM cache WHERE id = ?1').bind(cacheId(mbId, folder)).first();
  if (!row) return null;
  const ageMs = Date.now() - row.updated_at;
  if (ageMs > ttlMinutes * 60 * 1000) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export async function cacheReadStale(db, mbId, folder) {
  // 不管过期与否都把旧底本读出来，只用来跟 IMAP 新取的列表比对（比对用，不直接当缓存回）
  const row = await db.prepare('SELECT * FROM cache WHERE id = ?1').bind(cacheId(mbId, folder)).first();
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export async function cacheWrite(db, mbId, folder, data) {
  await db.prepare(
    `INSERT INTO cache (id, mailbox_id, folder, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET data=?4, updated_at=?5`,
  ).bind(cacheId(mbId, folder), mbId, folder, JSON.stringify(data), Date.now()).run();
}

export async function cacheClearMailbox(db, mbId) {
  await db.prepare('DELETE FROM cache WHERE mailbox_id = ?1').bind(mbId).run();
}

// 只让缓存“过期”，不删行：下次普通打开会重新取最新，但 cacheReadStale 还能读到旧底本，
// 这样下次取列表时能沿用每封信的接收时间 received_at，不会被一次发信/删信就清掉。
export async function cacheExpireMailbox(db, mbId) {
  await db.prepare('UPDATE cache SET updated_at = 0 WHERE mailbox_id = ?1').bind(mbId).run();
}

// ---------- 会话（记住我） ----------
export async function sessionIssue(db, { tokenHash, keyEnc, days, pwHash }) {
  const now = Date.now();
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now).run();
  await db.prepare(
    'INSERT INTO sessions (token_hash, key_enc, expires_at, days, pw_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  ).bind(tokenHash, keyEnc, now + days * 86400 * 1000, days, pwHash, now).run();
}

export async function sessionGet(db, tokenHash) {
  const row = await db.prepare('SELECT * FROM sessions WHERE token_hash = ?1').bind(tokenHash).first();
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    return null;
  }
  return row;
}

export async function sessionTouch(db, row) {
  const now = Date.now();
  const expiresAt = now + row.days * 86400 * 1000;
  await db.prepare('UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2').bind(expiresAt, row.token_hash).run();
  return expiresAt;
}

export async function sessionRevoke(db, tokenHash = null) {
  if (tokenHash === null) {
    await db.prepare('DELETE FROM sessions').run();
  } else {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
  }
}

// 退出所有记住的设备：删掉除当前会话外的全部会话（当前浏览器不断线）。
export async function sessionRevokeOthers(db, tokenHash) {
  await db.prepare('DELETE FROM sessions WHERE token_hash != ?1').bind(tokenHash).run();
}
