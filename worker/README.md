# Mail Center Worker — Phase 1 核心重写

纯 Cloudflare Worker + D1，全免费。Phase 1 是后端 API（登录、邮箱管理、收件箱、读信、发信），
界面在 Phase 2（同一 Worker 上静态资源），域名邮箱适配器、TG 通知、Outlook OAuth 在 Phase 3。

## 目录

- `wrangler.jsonc` — Worker 配置（D1 绑定 DB）
- `schema.sql` — D1 建表（site / mailboxes / cache / sessions）
- `src/crypto.js` — Web Crypto 密钥派生与加解密
- `src/mime.js` — 邮件头 / MIME 解析、摘要、地址解析
- `src/imap.js` — IMAP 客户端（LOGIN、163 的 ID、UTF-7 文件夹、MOVE、APPEND）
- `src/smtp.js` — SMTP 发信（LOGIN/PLAIN、STARTTLS）
- `src/db.js` — D1 数据层
- `src/index.js` — 路由与 API

## 首次部署（电脑上操作一次）

```bash
git pull
cd worker
npm install
npx wrangler login          # 浏览器点 Allow
npx wrangler d1 create mail-center-db
# 把输出里的 database_id 填进 wrangler.jsonc（替换 00000000-...）
npx wrangler d1 execute mail-center-db --file=./schema.sql
npx wrangler deploy
```

之后每次改代码只要 `npx wrangler deploy`。

也可以不用终端：GitHub Actions 已配好 `.github/workflows/deploy-worker.yml`，
push 到 main 就自动部署。第一次需要两样东西：
1. 在 Cloudflare 面板建好 D1（Workers & Pages → D1 → Create），database_id 填进 wrangler.jsonc；
2. GitHub 仓库 Settings → Secrets 加 `CLOUDFLARE_API_TOKEN`（Workers Edit 权限）与
   `CLOUDFLARE_ACCOUNT_ID`。

## API（都要登录，除 setup/login 外）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/setup | 首次设站点账号 + 密码（只在没设过时能用） |
| POST | /api/login | {username, password, remember_days: 90/180/365} |
| POST | /api/logout | 吊销当前会话 |
| GET | /api/me | 当前登录信息 |
| GET/POST | /api/settings | 显示名、缓存分钟数 |
| POST | /api/settings/password | 改站点密码（所有邮箱凭据自动重加密，全部会话作废） |
| GET/POST | /api/mailboxes | 邮箱列表 / 添加（先测连接，通了再存） |
| PUT/DELETE | /api/mailboxes/:id | 编辑 / 删除（只删管理中心记录） |
| POST | /api/mailboxes/:id/test | 连接测试 |
| GET | /api/folders?mb= | 文件夹列表 + 映射 |
| GET | /api/inbox?mb=&folder=inbox&refresh=1 | 收件箱（最新 30 封，默认 1 分钟缓存） |
| GET | /api/message?mb=&folder=&uid= | 读一封（自动标已读） |
| GET | /api/attachment?mb=&folder=&uid=&part= | 下载附件 |
| POST | /api/send | 发信（自动存已发送） |
| POST | /api/flag | {uid, seen} 标已读/未读 |
| POST | /api/move | {uid, dest: spam\|trash} |
| POST | /api/delete | 删信（有已删除就移过去，没有就直接删） |

测试示例（把地址换成你自己的 workers.dev）：

```bash
curl -X POST https://mail-center.<子域名>.workers.dev/api/setup \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"站点密码","display_name":"芒果邮箱管理中心"}' -c cookies.txt
curl https://mail-center.<子域名>.workers.dev/api/mailboxes -b cookies.txt
```

## 从 PHP 版继承的行为

- IMAP 登录后发 ID（163/Coremail 不发就拒 SELECT）；文件夹名走 modified UTF-7；
  open_folder 按映射名 + 常用名逐个试；MOVE 不支持时 COPY + 标删 + EXPUNGE。
- 发信 AUTH LOGIN 先试、PLAIN 兜底（DNSHE 只认 PLAIN）；发完 APPEND 到已发送。
- 收件箱每页最新 30 封、缓存 1 分钟（设置可改）、↻ 刷新绕过缓存；发信/删信/移动后清缓存。
- 记住我 90/180/365 天：Cookie 只放令牌原文（HttpOnly），D1 只存令牌 SHA-256 +
  用令牌加密的派生密钥 + 过期时间；改站点密码后全部会话作废。

## 和 PHP 版不一样的地方

- **加密换了算法**：PHP 用 sodium pwhash + secretbox，Worker 用 PBKDF2-SHA256
  （10000 次）+ AES-GCM。Worker 算不出 PHP 的密钥，所以 **PHP 存量邮箱密码搬不过来**，
  Phase 4 迁移时邮箱配置照搬、密码重新填一次。
- **KDF 次数**：`src/crypto.js` 里的 `KDF_ITERATIONS = 10000`。登录时只跑一次，
  记住我恢复不跑 KDF。如果登录报 error 1102，把它往低调（比如 1000）。
- **from_addr 已修**：列表同时取原始 From 头，地址以 From 头为准、ENVELOPE 作备份
  （PoC 里 QQ 的 ENVELOPE 地址 mailbox 是空的，只靠 ENVELOPE 拿不到地址）。
- **没有的**：界面（Phase 2）、Henna/Cloud Mail 适配器、TG 轮询、Outlook OAuth（Phase 3）。

## 已知限制（Phase 1）

- 摘要（snippet）取正文前 300 字节内联解析：base64 正文正常；原始 8bit（GBK）正文
  的摘要可能乱码，正文页是按字节取的，不受影响。
- 列表一次最多 30 封，没有翻页；读信按 UID 取，不支持按序号。
- 发信只支持纯文本正文（HTML 正文、附件随信发在 Phase 2 写信界面一起做）。
