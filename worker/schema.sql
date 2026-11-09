-- Mail Center Worker — D1 schema（Phase 1）
-- 建库后跑一次：npx wrangler d1 execute mail-center-db --file=./schema.sql
-- 也可以在 Cloudflare 面板里建 D1 后，把这里的语句粘进控制台执行。

CREATE TABLE IF NOT EXISTS site (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL DEFAULT 'admin',
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '芒果邮箱管理中心',
  cache_ttl INTEGER NOT NULL DEFAULT 1,
  tg_enabled INTEGER NOT NULL DEFAULT 0,
  tg_bot_token TEXT NOT NULL DEFAULT '',
  tg_chat_id TEXT NOT NULL DEFAULT '',
  tg_key TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'imap',
  group_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  imap_host TEXT NOT NULL DEFAULT '',
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_enc TEXT NOT NULL DEFAULT 'ssl',
  smtp_host TEXT NOT NULL DEFAULT '',
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_enc TEXT NOT NULL DEFAULT 'tls',
  login_user TEXT NOT NULL DEFAULT '',
  pass_enc TEXT NOT NULL DEFAULT '',
  panel_url TEXT NOT NULL DEFAULT '',
  panel_login TEXT NOT NULL DEFAULT '',
  panel_pass_enc TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cache (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_mb ON cache(mailbox_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  key_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  days INTEGER NOT NULL DEFAULT 90,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
