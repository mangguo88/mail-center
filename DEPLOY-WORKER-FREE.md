# Mail Center 纯 Worker 免费部署教程

> **目标**：从 Fork 到能用，全程免费。**不用服务器、不用绑卡、不用 Workers Paid、不用 Containers。**
> **部署方式**：Cloudflare 面板直连 Git（Workers Builds），`git push` 后自动部署。
> **适合谁**：想自己搭一个 Mail Center 的人。照着做，不用懂代码也能部署完。
> **当前版本**：Worker 版 v51（2026-11-14）。PHP 版、Containers 版是旧路，本教程不讲。
> **顺序提醒**：按 0 → 13 的顺序做，不要跳步。最容易错的是第 4、5 节的顺序：**先连 Git 把 Worker 建出来（第 4 节），再去这个 Worker 里加构建变量（第 5 节），最后重试部署**。Worker 还没建出来之前，面板里没有地方可以填构建变量。

---

## 0. 先看懂：这东西由什么组成

```
浏览器 ──HTTPS──> Cloudflare Worker（mail-center）
                    ├── 静态资源：三栏界面（Workers Static Assets，worker/public/）
                    ├── API 路由：/api/*（收件、发信、设置、TG）
                    ├── D1（mail-center-db）：邮箱、设置、缓存、TG 记录
                    ├── KV（mail-center-cache）：收件箱列表缓存
                    ├── R2（mail-center-store）：邮件全文和附件
                    ├── Sockets API：直连 IMAP 993 / SMTP 465
                    ├── Cron：每 5 分钟 TG 新邮件轮询
                    └── fetch：Henna / Cloud Mail / Mango-Mail / Telegram
```

- **数据存在哪**：邮箱账号和凭据存在 D1（加密存）；列表缓存放 KV；邮件全文和附件放 R2。
- **要花多少钱**：$0。免费额度见第 12 节，个人用绰绰有余。
- **部署后得到什么**：一个网址（`https://mail-center.<你的子域名>.workers.dev`），打开就能登录、加邮箱、收发信。
- **这次部署要改代码吗**：**不用改任何代码文件**。你要填的东西（D1/KV 的 ID、面板密码、TG 机器人）全部填在 Cloudflare 面板里，不写进仓库。仓库里的 `worker/wrangler.jsonc` 只写占位符，不写真实 ID。

---

## 1. 准备：两个账号

| 账号 | 用来干什么 | 要不要绑卡 |
| --- | --- | --- |
| **GitHub 账号** | Fork 代码，之后改代码 `git push` 就自动部署 | 不用 |
| **Cloudflare 账号** | 建 D1 / KV / R2、连 Git 自动部署 | **不用**，免费计划就行 |

Cloudflare 注册：打开 [dash.cloudflare.com](https://dash.cloudflare.com)，用邮箱注册即可。**全程不要在任何地方点“升级 / Add payment method”。**

---

## 2. Fork 仓库

1. 打开 <https://github.com/mangguo88/mail-center>。
2. 点右上角 **Fork** → **Create a new fork** → owner 选你自己的账号 → 点 **Create fork**。
3. Fork 完成后，你的仓库地址就是 `https://github.com/<你的用户名>/mail-center`，后面都用它。

> 别人部署**不需要 GitHub 令牌（PAT）**。公开仓库 + Cloudflare 面板连 Git 走 OAuth 授权，代码里没有放令牌的地方。PAT 只是原作者自己往仓库推代码时用的，部署的人不用管。

---

## 3. 在 Cloudflare 建三个存储（D1、KV、R2）

三个存储各建一次，名字按下表填。建完把 D1 和 KV 的 ID 记下来，第 5 节要填到 Cloudflare 面板的**构建变量**里（不是写进代码文件）。

| 存储 | 名字 | 用来存什么 |
| --- | --- | --- |
| D1 数据库 | `mail-center-db` | 邮箱、设置、缓存、TG 记录（8 张表） |
| KV 命名空间 | `mail-center-cache` | 收件箱列表缓存 |
| R2 桶 | `mail-center-store` | 邮件全文和附件 |

### 3.1 建 D1 数据库

1. Cloudflare 面板左侧 → **Workers & Pages** → **D1**（有的面板在 Storage & databases → D1）。
2. 点 **Create database**。
3. Database name 填 `mail-center-db`，点 **Create**。
4. 建好后在数据库页面能看到 **Database ID**（一串 `xxxxxxxx-xxxx-...` 格式的字符），**复制下来**，第 5 节要用。

> ⚠️ 数据库名必须叫 `mail-center-db`，因为部署脚本里写的是这个名字（`worker/package.json` 里 `deploy:builds` 和 `migrate` 两条命令都写着 `wrangler d1 execute mail-center-db ...`）。改名的话，这两条命令也要跟着改。

### 3.2 建 KV 命名空间

1. 左侧 → **Workers & Pages** → **KV**（或 Storage & databases → KV）。
2. 点 **Create a namespace**。
3. Namespace name 填 `mail-center-cache`，点 **Add**。
4. 列表里找到它，**复制它的 ID**（同样是一串字符），第 5 节要用。

### 3.3 建 R2 桶

1. 左侧 → **R2** → 点 **Create bucket**。
2. Bucket name 填 `mail-center-store`，Location 选默认（Automatic），点 **Create bucket**。
3. R2 桶**没有 UUID，桶名本身就是标识**，记下桶名就行，第 5 节不用填它。

---

## 4. 连 Workers Builds（Cloudflare 面板直连 Git，先把 Worker 建出来）

这一步是把你的 Fork 连到 Cloudflare，让它以后每次 `git push` 都自动部署。**先做这一步，再做第 5 节**——Worker 建出来之前，面板里没有地方可以填构建变量。

1. Cloudflare 面板左侧 → **Workers & Pages** → 点 **Create application**（或 **Create**）。
2. 选 **Import a Git repository**（有的面板叫 Connect to Git / 从 Git 导入）。**不要走 Create → Worker 手动新建**，那样连不上 Git，不会自动部署。
3. 选 **GitHub**，按提示授权 Cloudflare 访问你的 GitHub（OAuth 授权，只读你的仓库列表；选仓库时只勾你 Fork 的那一个）。
4. 选仓库 `<你的用户名>/mail-center`，分支选 **main**，点下一步。
5. 按下面填构建设置（**一字不差**）：

| 设置项（面板上显示的名字） | 填什么 |
| --- | --- |
| Worker name | `mail-center`（名字随意，但建议和 `worker/wrangler.jsonc` 里的 `name` 一致） |
| Root directory | `worker` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:builds` |
| Watch paths | `worker/**` |
| Build variables and secrets | **如果这个导入页面上就有这一栏**，直接在这里加 `D1_ID`、`KV_ID`（都选 Secret，值是第 3 节复制的那两个 ID，填法见第 5 节），加完跳过第 5 节；**如果这个页面上没有这一栏**，先留空，点 Save and Deploy，第一次构建会失败，这是正常的，做完第 5 节再重试 |

6. 点 **Save and Deploy**（或 Deploy），等第一次构建跑完（一般 1–3 分钟）。
7. **第一次构建失败是正常的**，不用慌：只要第 5 节的两个构建变量还没加，构建就会在第一步报错停下（见第 5 节末尾）。先去做第 5 节，再回来重试。

> 不要新建 `wrangler.toml`。这个项目用的是 `wrangler.jsonc`，面板如果提示“更新 wrangler.toml”直接忽略。

**这次部署实际干了三件事**（`npm run deploy:builds` 的定义在 `worker/package.json` 里）：

```bash
node scripts/render-wrangler.mjs  # 把面板构建变量 D1_ID / KV_ID 填进配置，生成 wrangler.rendered.jsonc
wrangler d1 execute mail-center-db --config ./wrangler.rendered.jsonc --file=./schema.sql --remote  # 建 8 张表，幂等，可反复跑
wrangler deploy --config ./wrangler.rendered.jsonc  # 发布 Worker
```

---

## 5. 加构建变量 D1_ID / KV_ID（在已经建好的 Worker 上），再重试部署

### 5.1 加两个构建变量

1. Cloudflare 面板左侧 → **Workers & Pages** → 点进 `mail-center` 这个 Worker（第 4 节刚建好的那个）。
2. 点顶上的 **Settings（设置）**，左边找到 **Build（构建）**，里面有一栏 **Build variables and secrets（构建变量和机密）**。
3. 点 **Add variable（添加变量）**，填名字 `D1_ID`，值填第 3 节复制的 D1 的 **Database ID**（D1 详情页上「数据库 ID」那一栏）。关键一步：同一个框里有个 **Type（类型）**，默认是 Variable（变量），点开选 **Secret（机密）** 再保存。选成机密后，值在构建日志里会被打码，看不到明文。
4. 同样再加一个：名字 `KV_ID`，值填 KV 命名空间的 ID，类型也选 **Secret**。
5. 确认两条都点了保存。保存后机密的值会变成小黑点，看不到明文，这是正常的。

**注意别加错地方**：Settings 里还有一栏叫 **Variables and Secrets（变量和机密）**，那是运行时的变量，构建的时候看不到，放那儿部署还是会报错。构建变量（`D1_ID`、`KV_ID`）放 **Build** 下面那一栏；运行时变量（`MC_` 开头的那些，见第 7 节）才放 Variables and Secrets 那一栏。

### 5.2 重试部署，看日志尾部确认成功

1. 回到这个 Worker 的 **Deployments（部署）** 页，找到最新那次构建（一般是失败的那次），点 **Retry deployment（重试部署）**。
2. 等它跑完（一般 1–3 分钟），把构建日志拉到**尾部**看结果。

- **怎么判断成功**：日志尾部看到 `Deployed` / `Current Version ID`，并且 Worker 详情页出现一个地址 `https://mail-center.<你的子域名>.workers.dev`，打开能看到登录页，就是成功了。
- **如果构建失败**：先看构建日志的**尾部**，分清是哪一步失败：
  - 日志里有 `[render-wrangler] 缺构建变量：D1_ID、KV_ID`（或其中一个），说明第 5.1 节的变量没加对：名字拼错、加到运行时变量那一栏了、或者没点保存。回去按 5.1 节重加，再 Retry。
  - “D1 迁移成功”不代表 Worker 已发布。如果最后一步 `wrangler deploy` 被拒绝（曾出现错误码 10021），解法很简单：往仓库推一个空提交再触发一次构建（`git commit --allow-empty -m "retry deploy" && git push`），一般第二次就成功了。

### 5.3 为什么是这样，不直接改 `worker/wrangler.jsonc`

- 仓库是公开的，`wrangler.jsonc` 里只能写**占位符**（`REPLACE_D1_DATABASE_ID` / `REPLACE_KV_NAMESPACE_ID`），不能写真实 ID。以前的版本写的是真实 ID，别人 Fork 一眼就能看到你的 D1/KV ID——ID 本身不是密码，光知道 ID 进不了你的 D1/KV，但不该放公开仓库，而且别人拿你的 ID 也部署不了（那些资源不在他的账号里）。
- 每次部署，部署命令都会先跑 `worker/scripts/render-wrangler.mjs`，把你面板里这两个构建变量的值填进配置，再执行 D1 建表、再发布 Worker。所以每次部署配置里都有真实绑定，面板里的绑定不会再被删掉。
- **Fork 的人一个文件都不用改**：在他自己的 Cloudflare 账号里建自己的 D1/KV/R2，再填他自己的 `D1_ID`、`KV_ID` 就行，代码一行都不用动，也永远看不到你的 ID。
- **构建变量是存在面板上的**，跟代码推送、仓库同步都没关系，推代码动不到它们。以后更新代码不用重填。
- **还有个保险**：如果有人把构建变量删了，部署会直接报错停下，不会静默把 Worker 清空。
- R2 不用这样处理：桶名 `mail-center-store` 只是个名字，不同账号可以重名，不算敏感信息，直接写在配置里就行。
- 本地想直接跑 `wrangler deploy` 的话：先在 shell 里 `export D1_ID=… KV_ID=…`（值去面板复制），再跑 `npm run deploy`，脚本会先渲染再部署；直接跑 `wrangler deploy` 会因为配置里是占位符而失败。

---

## 6. 第一次打开：设站点密码

1. 打开你的 Worker 地址（`https://mail-center.<你的子域名>.workers.dev`）。
2. 第一次会看到登录页，用 **账号 `admin`、密码 `123456`** 登录（**只在还没设过站点密码时有效**）。
3. 登录后第一件事：去 **设置 → 账号设置**，把**登录账号和站点密码改成你自己的**。

> ⚠️ **站点密码非常重要**：它同时是解密全部邮箱凭据的密钥。**忘密码且所有设备都退出了，没有“忘记密码”入口，只能把邮箱逐个删了重加（授权码重填）。** 所以设一个你记得住的密码，并且不要把站点密码填进任何邮箱的密码/授权码框——面板密码只用来登面板。

### 顺手可以做的：加一个备用的 CF 登录密码（可选）

如果你想多一个能登录的口令（比如主密码不想告诉别人）：

1. Cloudflare 面板 → Workers → `mail-center` → **Settings → Variables and Secrets**（运行时变量那一栏，**不是** Build 下面那栏）→ **Add variable**。
2. 变量名填 `MC_ADMIN_PASS`，值填一个新密码，保存（不用重新部署，保存后稍等片刻刷新生效）。
3. 回到面板（还登录着的状态下）随便保存一次设置——这一步生成 `login_wrap`，之后这个 CF 密码就能登录了。
4. 想收回时：删掉 `MC_ADMIN_PASS` 变量，再保存一次设置即可，数据库密码和邮箱凭据不动。

> 原理：登录先认数据库里的站点密码，再认 CF 的 `MC_ADMIN_PASS`；用 CF 密码登时，邮箱凭据靠 `login_wrap` 解（登录态下自动生成）。第 7 节还有更多变量。

---

## 7. 环境变量（可选，按需设）

全部在 Cloudflare 面板 → Workers → `mail-center` → **Settings → Variables and Secrets**（运行时变量那一栏）里加。**变量名就是下表左列，值按需填**；不填就用默认值（或在面板设置页里改）。

| 变量名（面板上显示的名字） | 默认值 | 作用 |
| --- | --- | --- |
| `MC_DISPLAY_NAME` | 面板设置里的名称 | 面板顶栏显示的名字，比如“芒果邮箱管理中心” |
| `MC_ADMIN_USER` | 面板设置里的账号 | 登入账号（不填就用数据库里的账号） |
| `MC_ADMIN_PASS` | （无） | 备用的登入密码，见第 6 节 |
| `MC_INBOX_LIMIT` | 30 | 每页显示几封（5–100）；范围没开时一次就取这么多封，开着时按这个数翻页 |
| `MC_INBOX_DAYS` | 0（不限） | 取信时间范围天数：`0`=不限（只取最新 N 封）；`30`/`90`/`180`/`365`=最近 1 个月/3 个月/半年/1 年的全部邮件 |
| `MC_AUTO_REFRESH_MS` | 30000 | 收件箱自动刷新间隔（毫秒），30000 = 30 秒 |
| `MC_SMTP_TIMEOUT_MS` | 60000 | 发信超时（毫秒） |
| `MC_SIDEBAR_W` | 240 | 左栏宽（px） |
| `MC_MID_W` | 220 | 收件栏宽（px） |

**注意：**

- 面板变量**优先于**设置页，设了之后设置页里对应的那项会变灰（改不了），要改就去面板改变量。
- 变量只在面板加，**不要写进 `wrangler.jsonc`**（那是公开仓库）。`keep_vars: true` 会保证部署时不丢面板变量。
- 加/改变量**不用重新部署**，保存后稍等片刻刷新就生效。

---

## 8. 加邮箱

面板左侧 → **邮箱管理** → **添加邮箱**。分两种：

### 8.1 普通邮箱（IMAP / SMTP：QQ、163、Gmail、Mail.ru、DNSHE）

1. 类型选 **普通邮箱**，填邮箱地址，厂商会自动识别（QQ、163、Gmail 等内置了服务器地址，不用自己填）。
2. 登录方式选 **授权码登入（推荐）** 还是 **密码登入**，填对应的凭据，点保存（保存时先测连接，通了才存）。

| 邮箱 | 用什么凭据 | 去哪弄 | 备注 |
| --- | --- | --- | --- |
| **QQ**（`@qq.com`） | **授权码**，不是 QQ 密码 | QQ 邮箱网页 → 设置 → 账号 → POP3/IMAP/SMTP → 生成授权码 | 授权码 16 位，粘贴时空格会自动去掉；登录账号默认就是邮箱地址，不用另填 |
| **163**（`@163.com`） | **授权码** | 163 邮箱网页 → 设置 → POP3/SMTP/IMAP → 客户端授权密码 | 163 登录后必须发 IMAP ID，代码里已经处理了，不用你管 |
| **Gmail** | **应用专用密码** | Google 账号 → 安全性 → 两步验证 → 应用专用密码 | 16 个字符，粘贴时去掉空格连成一串 |
| **Mail.ru**（`@mail.ru` / `bk.ru` / `inbox.ru` / `list.ru`） | **外部应用密码** | Mail.ru 设置里先开 IMAP/POP/SMTP 访问开关，再生成外部应用密码 | 不开开关会登录失败 |
| **DNSHE**（`@v.cd`） | 该邮箱自己的**客户端密码** | DNSHE 邮箱管理里找/重设 | 发信只认 AUTH PLAIN，代码已处理 |

**发信端口注意**：QQ 发信走 `smtp.qq.com:465` SSL。**不要用 587/STARTTLS**——在 Worker 上 587 会卡住（根因未查清），465 是实测通的。

### 8.2 域名邮箱（Henna / Cloud Mail / Mango-Mail：没有 IMAP，走面板 HTTP API）

如果你自己搭了 Henna、Cloud Mail 或 Mango-Mail 这类域名邮箱面板：

1. 类型选对应的 **Henna / Cloud Mail / Mango-Mail 域名邮箱**。
2. 填三样：**面板地址**（你自己的面板网址）+ **登录账号**（登面板的账号，一般就是邮箱地址）+ **面板密码**。
3. 点保存，同样先测连接，通了才存。

> ⚠️ 添加页里默认填的面板地址（Henna `https://email.070605.xyz/`、Cloud Mail `https://cfmail.151819.xyz/`、Mango-Mail `https://mango-mail.53424209.workers.dev/`）**是原作者自己的面板**，Fork 部署的人必须改成**你自己的面板地址**，不要直接用别人的。

- **批量加**：域名邮箱支持一次加多个地址——地址栏多行输入，一行一个（也认逗号/分号/空格分隔），共用同一个面板地址和登录账号密码，后端逐个测连接，通的存、不通的逐个报原因、已加过的跳过。
- **记住登录**：成功加过一次后，下次打开添加页会自动填上登录账号和密码（只存在你自己的浏览器 localStorage 里，分 Henna / Cloud Mail / Mango-Mail 三类记；密码栏下面有“忘记已记住的面板账号”可以清掉）。
- **限制**：域名邮箱只有收件箱和已发送（Henna 另有草稿/垃圾箱）；发信是纯文本、不支持附件；TG 推送只推 IMAP 邮箱，不推域名邮箱；Cloud Mail 删除是软删、Henna / Mango-Mail 删除是彻底删。

### 8.3 加不了的邮箱

- **Outlook**：个人账号自 2024-09-16 起只认 OAuth2，Worker 版还没接（需要去 Azure 注册应用、配重定向 URI），目前搁置，先别加。
- **Proton Mail**：端到端加密，没有直连 IMAP/SMTP，加不了（Bridge 只在你自己电脑本地跑）。

---

## 9. Telegram 新邮件通知（可选）

1. 在 Telegram 里找 **@BotFather**，发 `/newbot` 建一个机器人，拿到 **Bot Token**（一长串字符）。
2. 找 **@userinfobot**，发任意消息，它会回你的 **chat_id**（一串数字）。
3. 回到 Mail Center 面板 → **设置 → 消息推送**，填 Bot Token 和 chat_id，打开开关，点 **发一条测试通知**，手机上收到就说明通了。
4. 不用再配别的：`wrangler.jsonc` 里已经有 `"triggers": { "crons": ["*/5 * * * *"] }`，每 5 分钟自动轮询一次。

**规则**：只查收件箱、只查连接正常的 IMAP 邮箱；每轮每邮箱最多推 5 封；通知含邮箱、北京时间、发件人、标题、正文前 120 字和一个看全文链接。**开启时只记基线不推旧信**（旧邮件不会一次性涌进来）；开关关掉再打开会清基线重记。

**备用触发**：设置页里有一行“外部定时地址”，形如 `https://你的域名/api/tgcheck?key=<一串密钥>`，如果 Cron 没跑，可以用外部定时服务（比如 cron-job.org）每 5 分钟调这个地址；key 不对会报 403。

---

## 10. 绑自己的域名（可选）

- 不绑也能用，`workers.dev` 的地址就是正式地址。
- 要绑：Cloudflare 面板 → Workers → `mail-center` → **Settings → Domains** → **Add custom domain**，填你的域名（域名 DNS 需托管在 Cloudflare，或者按提示加一条 CNAME）。
- 建议：先用 `workers.dev` 把功能都测通了，再绑域名；如果以后要接 Outlook OAuth，重定向 URI 要和最终域名保持一致（目前 Outlook 还没接，不用管）。

---

## 11. 以后怎么更新代码

- 改代码 → `git push` 到 main 分支 → Workers Builds 自动重新部署。**不用进面板点任何东西。** 构建变量（`D1_ID` / `KV_ID`）和面板变量一样存在面板上，跟代码推送没关系，推代码动不到它们，更新代码不用重填。
- 每次部署都会跑 `schema.sql`（建表语句全是 `CREATE TABLE IF NOT EXISTS`，幂等，反复跑是安全的）。自己加表字段时也照这个写法，**不要写裸 `ALTER TABLE ADD COLUMN`**（重复跑会报错）。
- **升版规矩**（改界面时容易踩的坑）：每次改版要同时改两处——`worker/public/app.js` 里的 `APP_VERSION`，和 `worker/public/index.html` 里 `app.js?v=版本号`；改了 `styles.css` 还要改 `styles.css?v=版本号`。只改一处，浏览器会缓存旧版，你看到的还是上一版。
- **部署后还是旧版**：先看面板左栏底部的版本号，确认线上是不是新版；如果不是，等构建跑完再硬刷新（Ctrl+Shift+R）。多标签页混着旧版时，先核对版本号再判断。
- **已经部署过、想按新办法改**：如果你是 2026-11-15 之前部署的，仓库里的 `wrangler.jsonc` 还写着真实 ID，拉取最新代码后，按第 5 节把 `D1_ID` / `KV_ID` 加到 Build 构建变量里再推一次，之后就不再需要改代码里的 ID 了。Git 历史里旧提交还留着旧 ID，ID 本身不是密码，不用重写历史。

---

## 12. 免费额度够不够

| 项目 | 免费额度 | 本项目用量 |
| --- | --- | --- |
| 请求数 | 10 万/天 | 个人用 + Cron 每 5 分钟 288 次/天，远低于上限 |
| CPU 时间 | 10ms/次（网络等待不计，超了报 error 1102） | 收发信主要是网络等待，实测够用 |
| D1 | 5GB 存储；每天 500 万行读 / 10 万行写 | 个人量级够 |
| KV | 每天 10 万读 / 1000 写 | 列表缓存一天写不了几次，够 |
| R2 | 10GB 存储 | 邮件全文+附件，个人量级够 |
| Cron 触发器 | 每账号 5 个 | 用 1 个（每 5 分钟） |
| 自定义域名 | 免费 | 见第 10 节 |

---

## 13. 常见问题

**Q：第一次构建失败，日志里有 `[render-wrangler] 缺构建变量`？**
A：构建变量没加对。回去按第 5 节检查：名字是不是 `D1_ID` / `KV_ID`（大小写不能错）、是不是加在 **Build** 下面那栏（不是运行时变量那栏）、是不是点了保存。加好后去 Deployments 点 **Retry deployment**，不用改代码。

**Q：打开是登录页，`admin / 123456` 登不上？**
A：这个默认账号只在**还没设过站点密码**时有效。设过之后只认你设的密码（或 CF 的 `MC_ADMIN_PASS`，见第 6 节）。如果密码忘了且所有设备都退出了，没有找回办法，只能删邮箱重加。

**Q：部署完打开还是旧版 / 版本号没变？**
A：构建还没跑完。去 Workers Builds 看构建日志，等它显示成功再刷新；也可以看左栏底部版本号确认。改版时漏改 `app.js?v=` 也会导致浏览器缓存旧版（见第 11 节）。

**Q：构建日志里 D1 迁移成功了，但 Worker 没发布？**
A：D1 迁移成功 ≠ Worker 已发布。看日志尾部是不是最后一步 `wrangler deploy` 被拒绝（曾出现错误码 10021）。解法：推一个空提交重新触发一次构建。

**Q：面板上绑了 D1/KV/R2，下次部署后绑定没了？**
A：现在不会了：每次部署，部署命令都会先跑渲染脚本，把面板构建变量里的真实 ID 填进配置再部署，配置里每次都有真实绑定（见第 5 节）。只在面板绑、配置里没有，下次部署会被按配置文件同步删掉——2026-11-14 mango-mail 就是这么丢过一次绑定，登录直接报 internal error，后来改成占位符 + 构建变量才修好。`keep_vars: true` 只保护纯文本变量，不保护绑定。

**Q：收件箱只显示一部分邮件？**
A：先看两处：① 设置 → **取信时间范围**（`MC_INBOX_DAYS`），`0`=不限（只取最新 N 封），`90`=最近 3 个月的全部邮件；② **每页显示几封**（`MC_INBOX_LIMIT`），底栏“最新 N 封”是取回的总数，每页只放这么多封，剩下的在下一页（点“下页”）。先点一下刷新（↻）再看，刷新前读的是缓存。

**Q：QQ 加不上，报登录失败？**
A：QQ 必须用**授权码**，不是 QQ 密码；授权码必须是**这个 QQ 号当前有效的那一串**（旧的可能失效，重新生成）；登录账号默认就是邮箱地址，别填 QQ 号。

**Q：Cloud Mail 加不上，报“输入的邮箱不存在”？**
A：登录账号必须写**完整邮箱地址（含 @）**，比如 `cfmail@151819.xyz`，少了 `@` 或少了域名都会报这个。

**Q：Mango-Mail 加不上，登录一直失败？**
A：如果你的 Mango-Mail 面板开了登录 Turnstile（人机验证），API 登录会被直接挡住。关掉面板的登录 Turnstile，或改用面板的 API Key（走 `X-Api-Key` 请求头）。

**Q：发信一直转圈发不出去？**
A：检查 SMTP 端口：QQ 用 465/SSL，不要用 587/STARTTLS（在 Worker 上会卡住）。

**Q：TG 测试通知收不到？**
A：先确认 Bot Token 和 chat_id 填对了（Token 是 @BotFather 给的那一串，chat_id 是 @userinfobot 回的数字）；再确认开关打开了；再点一次“发一条测试通知”。Cron 每 5 分钟跑一轮，不会立刻推。

**Q：`wrangler.toml` 的提示要不要管？**
A：不用管，不要新建。项目用 `wrangler.jsonc`。

---

## 附：目录结构

```
worker/                  ← Worker 版全部代码（部署只看这个目录）
  wrangler.jsonc         ← Worker 配置：名字、D1/KV/R2 绑定、Cron、keep_vars（D1/KV 只写占位符，真值在面板构建变量里，见第 5 节）
  scripts/render-wrangler.mjs ← 部署时把构建变量填进配置的脚本（生成 wrangler.rendered.jsonc，不提交）
  package.json           ← 脚本：build / deploy / deploy:builds / migrate / render
  schema.sql             ← D1 建表（8 张表，全是 IF NOT EXISTS，幂等）
  src/                   ← 后端：index.js（路由）、imap.js、smtp.js、mime.js、
                           crypto.js（加密）、db.js、cache.js、store.js、tg.js、
                           henna.js、cloudmail.js、mangomail.js（三个域名邮箱适配器）
  public/                ← 前端：index.html、app.js、styles.css（三栏界面）
manage/                  ← PHP 版旧代码（Serv00 上跑的 v4.28.2，不动它）
ADAPTERS.md              ← 自己加一种域名邮箱的扩展文档
```

## 安全提醒

- 永远不要把凭据写进代码或提交进仓库：站点密码、邮箱授权码、Bot Token、API Key、CF 的 API Token 只填在面板或自己的环境里。D1/KV 的 ID 也一样，只填面板构建变量（类型选机密），不写进 `wrangler.jsonc`。
- API Token、Bot Token 这类值只显示一次，丢了就重新建一个，旧的马上作废；**已经贴到聊天记录或截图里的令牌要去后台删掉重建**。
- 换域名、换服务器时，站点密码不用变；但站点密码是解密邮箱凭据的密钥，忘密码且全设备退出只能删邮箱重加。

## 协议

MIT License，见 [LICENSE](LICENSE)。
