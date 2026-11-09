# Mail Center 纯 Worker 免费部署方案

> 方向：把 PHP 版管理中心重写成纯 Cloudflare Worker，只用免费额度。
> 不开 Workers Paid、不绑卡、不用 Containers、不用 R2。
> Serv00 上的 v4.28.2 继续跑，验证通过再切换。

## 一、架构（一句话）

```
浏览器 ──HTTPS──> Worker（mail-center）
                    ├── 静态资源：三栏界面（Workers Static Assets）
                    ├── API 路由：/api/*（收件、发信、设置、TG）
                    ├── D1（mail-center-db）：邮箱、设置、缓存、TG 记录
                    ├── Sockets API：直连 IMAP 993 / SMTP 587
                    ├── Cron：每 5 分钟 TG 新邮件轮询（免费额度内 5 个触发器，用 1 个）
                    └── fetch：Henna / Cloud Mail / Telegram / 微软 OAuth
```

## 二、存什么、放哪里

| 原来（PHP + 文件） | 改成（Worker） | 说明 |
|---|---|---|
| `data/site.php`（站点密码 hash、TG 配置） | D1 `site` 表 | TG 的 token/chat_id 照旧加密存 |
| `data/mailboxes.php`（邮箱记录 + 加密凭据） | D1 `mailboxes` 表 | 字段照旧，`panel_url/panel_login` 统一字段保留 |
| `data/cache_*.php`（收件箱 1 分钟缓存） | D1 `cache` 表 | 一行 = 一个邮箱一个文件夹的列表，过期即失效 |
| `data/notify_seen_*.php`（TG 已推 UID） | D1 `tg_seen` 表 | 轮询时比对 |
| `data/remember.php`（记住我令牌） | D1 `remember_tokens` 表 | 只存令牌 SHA-256 + 加密派生密钥 + 过期时间 |
| `data/salt.php`（派生盐） | D1 `site` 表里一字段 | 盐不是秘密，可以存库里 |

加密：Web Crypto 替代 sodium。站点密码 + 盐走 PBKDF2（10 万次 SHA-256）派生密钥，
凭据走 AES-GCM 加密。**站点密码本身不能变派生规则，否则已存凭据解不开**（和 PHP 版同一条规矩）。

不用 KV：KV 免费每天只给 1000 次写，缓存写多了不够；D1 每天 10 万行写，够用。
不用 R2：附件不存服务器，读信时现取现传。

## 三、免费额度够不够

| 项目 | 免费额度 | 本项目用量 |
|---|---|---|
| 请求数 | 10 万/天 | 个人用 + Cron 每 5 分钟 288 次/天，远低于上限 |
| CPU 时间 | 10ms/次（网络等待不计，超了报 error 1102） | **唯一风险点**（见第五节） |
| D1 | 5GB 存储；每天 500 万行读 / 10 万行写 | 个人量级够 |
| Cron 触发器 | 每账号 5 个 | 用 1 个（每 5 分钟） |
| 静态资源 | 每版本 2 万文件 | 界面几个文件，够 |
| 自定义域名 | 免费 | Phase 4 再绑 |

## 四、首次部署步骤

```bash
# 0. 拉代码
git pull
cd worker            # Phase 1 建的新目录（重写版代码放这里，PHP 的 manage/ 不动）

# 1. 登录（只授权，不建任何东西）
npx wrangler login

# 2. 建 D1 数据库（只跑一次，记下返回的 database_id 写进 wrangler.jsonc）
npx wrangler d1 create mail-center-db

# 3. 建表（Phase 1 会给 schema.sql）
npx wrangler d1 execute mail-center-db --file=./schema.sql

# 4. 部署（建 Worker + 传代码 + 挂 Cron，一步完成）
npx wrangler deploy
```

部署成功给一个地址：`https://mail-center.<你的子域名>.workers.dev`。
打开设站点密码、加邮箱验证。

```bash
# 5. 以后每次改代码，重新部署就是这一条
npx wrangler deploy
```

## 五、风险：10ms CPU 上限（唯一没验证过的）

PoC 已按 aa 要求跳过，**10ms CPU 没实测**，Phase 1 第一轮联调先测，其他功能先不往上堆：

- 先测 `/api/imap-test`：登录 + 拉 30 封信封。通了 = 列表这条路免费额度装得下。
- 再测读一封正文（含 base64/quoted-printable 解码、HTML）。超了就拆：
  列表只取信封、正文按需单封取、附件流式传、结果进 D1 缓存，不让一次请求干重活。
- 如果拆完还是超：如实回报，再定是接受 Workers Paid 还是换方案，不硬上。

## 六、数据迁移（Phase 4）

1. Serv00 上跑导出脚本，把 `data/mailboxes.php`、`data/site.php` 里的邮箱记录和设置导成 JSON。
2. 本地 `npx wrangler d1 execute mail-center-db --file=./import.sql` 导入。
3. **不迁的**：收件箱缓存（到新站重建）、TG 已推记录（重建基线，第一轮只记不推）、记住我令牌（改版后重新登录）。

## 七、自定义域名与切换（Phase 4）

1. 先用 `workers.dev` 测全功能。
2. 再绑域名：Cloudflare Dashboard → Workers → mail-center → 设置 → 域名 → 添加。
   建议先用新子域名测（如 `mc.lele.pp.ua`），稳定了再把 `mangguo.lele.pp.ua` 从 Serv00 的 A 记录切过来。
3. Outlook OAuth 注意：重定向 URI 现在写死 `https://mangguo.lele.pp.ua/oauth.php?step=ms_callback`，
   换域名后代码里的值和 Azure 应用注册里的值要同步改（Phase 3 做）。
4. **回退**：Serv00 的 v4.28.2 不动、不删。DNS 不切之前线上一直是它；
   切过去出问题，把 DNS 指回 Serv00 的 IP（212.91.26.79）即回退，数据还在 Serv00 的 `data/` 里。

## 八、建设阶段

- **Phase 1 核心**：D1 schema、Web Crypto 加密、IMAP 客户端完整版
  （LOGIN、163 的 IMAP ID、中文文件夹 modified UTF-7、ENVELOPE、MIME 正文解析、
  SMTP 587 STARTTLS 发信）、登录/记住我、收件箱列表 + 缓存。
  先联调 `/api/imap-test`，CPU 风险在这里见分晓。
- **Phase 2 界面**：三栏、分组（按名固定淡色、默认收起只手动开关）、拖拽排序、
  写信、读信、删除/移垃圾箱、设置页。操作习惯照 PHP 版原样搬。
- **Phase 3 适配器 + TG + Outlook**：Henna / Cloud Mail 走 fetch 接入
  （注册表 `adapters` 机制照 v4.30 原样搬）；TG 直连 + Cron 每 5 分钟轮询；
  Outlook OAuth（微软登录按钮、令牌刷新）。
- **Phase 4 迁移 + 切换**：按第六、七节做，切完验证清单逐项过。

## 九、对照表（PHP 经验平移，全部保留）

- QQ 只认授权码；163 登录后必须发 IMAP ID（RFC 2971）否则拒 SELECT；
  DNSHE 发信只认 AUTH PLAIN；Outlook 个人账号自 2024-09-16 起只认 OAuth2。
- 分组按名固定淡色、左栏默认全收起；收件箱列表缓存默认 1 分钟、↻ 刷新绕过；
  TG 每轮每邮箱最多 5 封、正文前 120 字 + 看全文链接。
- Cloud Mail 登录 Authorization 直接放 token（不带 Bearer），先调 `/api/account/list` 拿 accountId；
  Henna 登录走 `POST /api/auth/login`，没有垃圾箱、删除是彻底删。

## 十、不做的事

- 不开 Workers Paid、不绑卡；不用 Containers、不用 R2、不建付费服务。
- 不动 Serv00 线上站、不动 `070605.xyz` 的 Henna、不改任何 DNS，直到 Phase 4 切换那一刻。
- 不把任何凭据、授权码、Token 写进代码或聊天。
