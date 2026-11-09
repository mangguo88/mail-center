# Mail Center — 芒果邮箱管理中心

一个 PHP 小程序（无数据库、无 Composer），**只登一个页面就能管所有邮箱**：收件箱、读信、回复、转发、写信、删除、标记垃圾邮件都在本站完成，不用再一个个登各家邮箱。

支持 QQ、163、Gmail、Outlook、DNSHE 等 IMAP/SMTP 邮箱，也能接没有 IMAP 的自建面板（Henna、Cloud Mail 走 HTTP API），新邮件还能推 Telegram 通知。

## 功能

- **多邮箱聚合**：一个页面切换多个邮箱看收件箱（不是合并收件箱，每个邮箱独立）。
- **收发信**：读信、回复、转发、写信、删除、移到垃圾箱；按月分组、每页 30 封、列表缓存 + 一键刷新。
- **分组管理**：邮箱按分组归类，分组名固定配色，左栏可拖动排序。
- **TG 新邮件通知**：每 5 分钟轮询一次，新邮件推到 Telegram（正文前 120 字 + 看全文链接）。两种发法：设置页填 chat_id + Bot Token 直接连 Telegram，或者填自己的 Cloudflare Worker 中转地址。
- **Outlook 微软登录**：Outlook 个人邮箱只认 OAuth2，设置页填 Azure 应用的 Client ID / Secret 后，点“用微软账号登录添加”就行，令牌过期自动刷新。
- **域名邮箱接入，可自己扩展**：没有 IMAP 的自建域名邮箱（Henna、Cloud Mail）走 HTTP API 接进来，一条记录管一个邮箱地址；别人有自己的域名邮箱面板，照着 `manage/adapter-template.php` 写一个适配器、在 `manage/adapters.php` 注册表里加一行就能接进来，不用改主程序（见 [ADAPTERS.md](ADAPTERS.md)）。

## 部署（三选一，代码同一套）

| 方式 | 教程 | 适合 |
| --- | --- | --- |
| **GitHub + Cloudflare Containers**（推荐） | [DEPLOY-CF-TUTORIAL.md](DEPLOY-CF-TUTORIAL.md)（一步一步） / [DEPLOY-GITHUB-CF.md](DEPLOY-GITHUB-CF.md)（架构） | 没有服务器的人；Docker 跑 PHP，数据存 R2，约 $6–8/月 |
| **VPS** | [DEPLOY-VPS.md](DEPLOY-VPS.md) | 有 VPS 的人；纯 PHP 8.0+，Nginx + PHP-FPM |
| **Serv00** | `manage/README.md` | 免费主机；传 `manage/` 里的文件到网站根目录就行 |

部署完第一次打开按提示设站点密码，再加邮箱就能用。以后改代码：改完 `git push`，GitHub Actions 自动重新部署（CF 方式）或自动推到服务器（VPS/Serv00 方式）。

## 部署前要改的三处（只改你自己的值，别的不用动）

1. **Outlook 微软登录**：`manage/ms_oauth.php` 里的 `MS_REDIRECT_URI` 改成你自己的域名（`https://你的域名/oauth.php?step=ms_callback`），并且去 Azure 注册的应用里把重定向 URI 改成一模一样的，差一个字微软就报不匹配。设置页会原样显示这个值，复制去填就行。
2. **TG 通知**：设置页 → 消息推送，填你自己的 chat_id + Bot Token（去 @BotFather 建机器人、@userinfobot 查 chat_id），或者填你自己部署的 Worker 中转地址。代码里没有写死任何人的 Worker。
3. **域名邮箱（Henna / Cloud Mail 等）**：添加邮箱时面板地址填你自己的（比如你自己的 Henna 部署地址），代码里没有写死任何人的面板。

## 安全提醒

- 永远不要把 `data/` 提交进仓库（里面有加密后的邮箱凭据；`.gitignore` 已经拦了，`git status` 时检查一遍）。
- API Token、R2 Secret Access Key、Bot Token、微软 Client Secret 只显示一次，丢了就重新建一个，旧的马上作废。
- 换域名、换服务器时，站点密码不用变，凭据存在 `data/` 里，整个目录拷走就行（走 scp/rsync，别放公开地方）。

## 目录结构

```
manage/                  ← PHP 程序本体（index.php 主程序、imap.php 收发信库、
                           henna.php、cloudmail.php、adapters.php 注册表、
                           adapter-template.php 适配器模板、oauth.php、ms_oauth.php）
ADAPTERS.md              ← 自己加一种域名邮箱的扩展文档
Dockerfile               ← CF Containers 用的镜像
wrangler.toml / src/     ← CF Worker（转发请求 + 每 5 分钟 TG 轮询）
cf/                      ← 容器里的 Nginx 配置、入口脚本、R2 同步脚本
.github/workflows/       ← 自动部署（deploy-cf.yml 推 CF，deploy.yml 推 VPS/Serv00）
DEPLOY-*.md              ← 各部署方式的教程
```

## 协议

MIT License，见 [LICENSE](LICENSE)。
