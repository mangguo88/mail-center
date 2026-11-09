# 邮箱管理中心 — GitHub + Cloudflare 完整部署方案

> 一步一步的教程见 [DEPLOY-CF-TUTORIAL.md](DEPLOY-CF-TUTORIAL.md)，这里是架构和结论。

> 研究时间：2026-11-08。结论先说：**PHP 程序不能直接部署到 Cloudflare Pages / Workers 上**（没有 PHP 解释器），但有一条走得通的 GitHub + CF 路：**Cloudflare Containers（Docker 容器跑 PHP）+ R2 存数据 + GitHub Actions 自动部署**。下面是完整方案，仓库里配套文件都已写好。

## 一、三条路对比（先定方向）

| 路 | 能不能走 | 成本 | 代价 |
| --- | --- | --- | --- |
| **A. GitHub + Cloudflare Containers（首选）** | ✅ 能走 | Workers Paid $5/月 + 少量用量（小应用约 $1–3/月） | 容器磁盘是临时的，数据要同步到 R2（本方案已含脚本）；首次部署有几处要验证 |
| **B. 重写成 Worker（JS + D1 + Sockets API）** | ✅ 技术上能走 | 免费额度大概率够用 | 等于重写整个程序（约 3000 行 PHP + 手写 IMAP 库），几周的工作量，不是这次能做完的 |
| **C. GitHub + Serv00（今天就能用的兜底）** | ✅ 已验证 | 免费 | 别人要先注册 Serv00 免费账号；部署 workflow 已有（`.github/workflows/deploy.yml`） |

**被否掉的路**（都查过，不用再试）：
- **Cloudflare Pages / Workers 直接跑 PHP**：Workers 只支持 JS / TS / Python / Rust，PHP 不在官方支持语言里。
- **PHP-WASM（php-wasm）**：实验品，没有文件系统、没有网络扩展、连不上 IMAP，只能算演示；Drupflare 那种 Drupal on Workers 是研究项目，用的定制工具链，不适合我们。
- **InfinityFree 等免费 PHP 空间**：出站只开 587 端口，IMAP 993 连不上；没有 cron；还有个浏览器过滤器，`curl` 和外部定时服务根本打不进站，TG 轮询走不通；免费套餐还禁 API 托管。
- **AwardSpace**：出站连接全封，`fsockopen` / `curl` 都用不了。

## 二、首选方案 A：GitHub + Cloudflare Containers

### 架构

```
GitHub 仓库（fork 即得）
   │ push 到 main
   ▼
GitHub Actions ── php -l 语法检查 ──► npx wrangler deploy
                                          │
                              ┌─────────────┴──────────────┐
                              ▼                            ▼
                    Worker（src/index.js）        容器（Dockerfile）
                    - 所有请求转发给同一个容器      PHP 8.2-FPM + Nginx
                    - 每 5 分钟 Cron 触发 TG 轮询   跑现成的 6 个 PHP 文件
                    - 自定义域名绑在这里            data/ 每 5 分钟备份到 R2
                                                    启动时从 R2 恢复 data/
```

关键点：
- **容器是同一个**：`max_instances = 1` + 按固定名字 `mail-1` 路由，所有请求都进同一个容器，数据不会散。
- **数据不放容器磁盘**：容器磁盘是临时的，休眠/重启/重新部署都会清空。`data/` 里重要的文件（站点密码、邮箱列表、记住我令牌、TG 已推记录）由 `cf/r2-backup.php` 每 5 分钟同步到 R2，容器启动时 `cf/r2-restore.php` 再从 R2 恢复回来。收件箱缓存（`cache_*.php`）不管，丢了会自动重建。
- **TG 轮询不用外部 cron**：Worker 自带的 Cron Triggers 每 5 分钟调一次容器里的 `?tgcheck=1`，Serv00 那套外部定时任务可以省了。
- **出站没问题**：容器是完整 Linux 环境，出站连 IMAP 993 / SMTP 465 / 587 和 HTTPS 都正常（Workers 本身的端口 25 限制不适用于容器；我们发信用 465/587，本来也不走 25）。

### 仓库结构（本仓库就是这个结构）

```
manage-center/                  ← GitHub 仓库根目录
  manage/                       ← 现成的 7 个 PHP 文件（不动；adapter-template.php 是给别人抄的模板，不进镜像）
    index.php  imap.php  oauth.php  ms_oauth.php  henna.php  cloudmail.php  adapters.php
  Dockerfile                    ← PHP 8.2-FPM + Nginx 镜像
  wrangler.toml                 ← Worker + 容器 + 每 5 分钟 Cron 的配置
  package.json                  ← wrangler + @cloudflare/containers
  src/index.js                  ← Worker：转发请求 + TG 轮询定时器
  cf/
    nginx.conf                  ← 容器里的 Nginx（监听 8080，/data/ 拒绝访问）
    entrypoint.sh               ← 启动：从 R2 恢复 → 起 cron 备份 → 起 PHP + Nginx
    r2store.php                 ← R2（S3 兼容）最小客户端，纯 PHP，无 SDK
    r2-backup.php               ← 每 5 分钟把 data/ 里重要的文件推到 R2
    r2-restore.php              ← 启动时把 R2 里的文件拉回 data/
  .github/workflows/deploy-cf.yml   ← push 即部署
  DEPLOY-GITHUB-CF.md           ← 本文件
```

### 部署步骤（别人照着做）

**准备（一次性的）：**
1. Fork 这个仓库（公开库，别人 fork 即用）。
2. Cloudflare 账号开 Workers Paid（$5/月，要绑卡），记下 Account ID。
3. 在 Cloudflare Dashboard 建一个 R2 存储桶，比如叫 `mc-data`；再建一个 R2 API Token（Object Read & Write，只能访问这个桶），记下 Access Key ID / Secret Access Key / Account ID。
4. 仓库 Secrets 里加：
   - `CLOUDFLARE_API_TOKEN`（有 Workers 和 R2 权限的 API Token）
   - `CLOUDFLARE_ACCOUNT_ID`
5. push 到 `main`（或 Actions 页点 Run workflow），等 Actions 跑完，拿到 `https://mangguo-mail.<你的子域名>.workers.dev`。

**配好就能用（部署完做一次）：**
6. 打开那个 workers.dev 地址，设站点密码，加邮箱——和 Serv00 上一模一样。
7. Worker 里加 Secrets（`wrangler secret put`，进 `manage-center/` 目录跑）：
   - `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET=mc-data`——容器启动和备份都靠这四个。
   - `TG_KEY`——TG 轮询用的 key，和站点设置页里显示的 `tg_key` 填同一个值（Worker 每 5 分钟拿它调 `?tgcheck=1`）。
8. 自定义域名（可选）：Dashboard → Workers & Pages → 这个 Worker → Custom Domains 绑自己的域名。TG 通知里的“看全文”链接不用改代码，跟着当前域名走（v4.29 起）。**绑了域名后，微软登录回调要改**：`manage/ms_oauth.php` 里 `MS_REDIRECT_URI` 改成新域名，并且去 Azure 注册的应用里把重定向 URI 改成一模一样的，差一个字微软就报不匹配。

### 费用估算（先说明是估算，以第一张账单为准）

- Workers Paid：$5/月（Containers 必须开 Paid 才能用）。
- 容器用量：每月免费额度 25 GiB-hours 内存、375 vCPU-分钟、200 GB-hours 磁盘、北美/欧洲 1 TB 出站流量。按 256 MiB 小容器、每 5 分钟 TG 轮询唤醒一次算，大头是内存约 $1–2/月，CPU 只按实际用掉的算。
- R2：免费额度 10 GB 存储 + 每月 100 万次 A 类操作；我们只在文件变了才上传，一天几十次，基本不花钱。
- 合计约 **$6–8/月**。比 VPS 便宜一点，关键是别人不用管服务器。

### 首次部署要验证的几件事（都没在真实容器上跑过）

1. `npx wrangler deploy` 能不能一次建成镜像（GitHub runner 自带 Docker）。
2. 容器里 `this.env` 转发 R2 凭据给容器是否生效（`src/index.js` 里的 `envVars` 就是这么写的）。
3. 从 R2 恢复 `data/`、每 5 分钟备份、退出时最后备份一次，这条链路通不通。
4. 容器休眠后第一次访问的冷启动要几秒，属正常。
5. TG 的 5 分钟 Cron 触发器是否按时跑。

## 三、长期方案 B：重写成 Worker（真·一键部署）

这是唯一能做到“fork → 连 Cloudflare → 完成、不用容器、不用每月 $5”的路，也是 cloud-mail（cfmail.151819.xyz）那种项目走的路：

- **Worker 跑 JS**：界面还是现在的三栏样子，逻辑用 JS 重写。
- **D1 存数据**：邮箱列表、凭据（加密后）、设置放 D1（SQLite）；缓存放 KV。
- **Sockets API 连邮箱**：Workers 的 `cloudflare:sockets` 的 `connect()` 能直连任意 TCP 端口，支持 TLS（993 隐式 TLS、587 STARTTLS、465 都行，只有 25 端口被禁，我们不用 25）。已经有现成的项目这么干（比如用 Workers 代理 iCloud IMAP 的 icloud-mcp）。
- **Cron Triggers**：TG 轮询原生支持，不用外部定时。
- **部署**：GitHub 连 Workers Builds，push 即部署；免费额度 10 万次请求/天，个人用够了。

**工作量**：等于重写整个程序——主程序约 3000 行 PHP + 手写 IMAP/SMTP/MIME 库约 1500 行，改成 JS + D1 + Sockets 实现，按周算。**这次先不做**，如果 aa 决定要，我单独开一个项目、按模块分步做（先跑通 IMAP 读信，再补发信、再补 Henna/Cloud Mail/微软 OAuth）。

## 四、兜底方案 C：GitHub + Serv00（今天就能给别人用）

- Serv00 免费账号注册是免费的（每天名额有限，要抢），注册完按 `DEPLOY-VPS.md` 的思路、或者直接用已有的 `.github/workflows/deploy.yml`：Secrets 填 `dkuwfoo.serv00.net` / 用户名 / SSH Key / 网站根目录，push 即部署。
- 零成本、已验证，就是别人得先有个 Serv00 号。

## 五、换域名 / 给别人用，必须改的几处（三个方案通用）

| 地方 | 文件 | 改成什么 |
| --- | --- | --- |
| 微软登录回调地址 | `manage/ms_oauth.php` 第 10 行 `MS_REDIRECT_URI` | 改成你自己的域名 `https://你的域名/oauth.php?step=ms_callback`，**并且去 Azure 注册的应用里把重定向 URI 也改成一模一样的** |
| TG 通知里的“看全文”链接 | `manage/index.php` 约 468 行 | 把 `https://mangguo.lele.pp.ua/?tab=inbox&mb=` 改成你的域名 |
| TG 中转 Worker | 设置页可改 | 默认是 aa 的 Worker，`chat_id` 写死是 aa 的——**给别人用必须自己部署一个 TG 中转 Worker 填进去，或者在设置页关掉 TG 通知** |
| SnappyMail 链接 | `manage/index.php` `SNAPPY_URL` / `ADMIN_URL` | 不用 SnappyMail 可以不管，只是两个链接 |
