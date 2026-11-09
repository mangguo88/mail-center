# 邮箱管理中心 — GitHub + Cloudflare Containers 一步一步部署教程

> 目标：把现在这套邮箱管理中心（和 Serv00 上同一套，不用改代码）部署到 Cloudflare 上，别人 fork 仓库、填几个密钥、push 就能用。
> 全程约 30–60 分钟，大部分时间在等 Cloudflare 和 GitHub 跑。
> 架构说明见 [DEPLOY-GITHUB-CF.md](DEPLOY-GITHUB-CF.md)，这里只写“先点哪里、再敲什么”。

## 准备清单（开始前先备好）

| 东西 | 说明 |
| --- | --- |
| GitHub 账号 | 免费就行，用来放代码、跑自动部署 |
| Cloudflare 账号 | 免费注册，但这一步要开 Workers Paid（$5/月），**要绑一张卡**（只扣 $5，不绑卡用不了 Containers） |
| 一台能跑命令的电脑 | 你自己的电脑就行，要装 Git 和 Node.js 18+（去 nodejs.org 下 LTS 版）；下面 `wrangler secret put` 那几步在你电脑上跑 |
| 约 30–60 分钟 | 第一次镜像构建要几分钟，中间等一等就行 |

## 第 1 步：把代码推到 GitHub（10 分钟）

**建一个公开库**（选 **Public**；代码里你个人的默认值已经清空，别人 fork 后填自己的地址和密钥就能用）：

1. 打开 <https://github.com/new>，Repository name 填 `mail-center`（名字随便起），选 **Public**，**不要勾** Add a README、.gitignore、license（建空库，不然 push 会冲突），点 Create repository。
2. 在你电脑上打开终端，进到这份代码的目录（这份教程的仓库根目录），依次跑：
   ```bash
   cd ~/workspace/email-aggregator/manage-center   # 你电脑上代码实际放的位置
   git init
   git add -A
   git status   # 检查一遍：列表里不应该有 data/、*.bak、preview-*.webp 这些（.gitignore 已经拦了）
   git commit -m "mail center v4.29: TG direct + Cloudflare Containers deploy"
   ```
3. 把本地仓库连上 GitHub 刚建的空库并推上去（把 `你的用户名` 换成你自己的）：
   ```bash
   git branch -M main
   git remote add origin https://github.com/你的用户名/mail-center.git
   git push -u origin main
   ```
   推的时候会弹 GitHub 登录（浏览器里点确认就行）。
4. 出现 `Branch 'main' set up to track remote branch 'main'` 就是推成了。先别急着看部署——Secrets 还没填，这轮 Actions 会失败，正常，后面补上重跑就行。

## 第 2 步：Cloudflare 开 Workers Paid（5 分钟）

1. 打开 <https://dash.cloudflare.com> 登录。
2. 左边点 **Workers & Pages** → 右上角 **Upgrade**（或进任意 Worker 点 Upgrade），选 **Workers Paid $5/月**，按提示绑卡付款。
3. 记下你的 **Account ID**：在 Workers & Pages 页面右上角能看到一串 Account ID，复制下来，后面要用。

## 第 3 步：建 R2 存储桶 + API Token（5 分钟）

容器磁盘是临时的，邮箱数据要存在 R2 里（启动时恢复、每 5 分钟备份一次），不然容器一休眠数据就没了。

1. 左边点 **R2 Object Storage** → **Create bucket**，名字填 `mc-data`（如果提示已被占用就换个名字，比如 `mc-data-你的名字`，后面 Secret 里 R2_BUCKET 也改成同一个），Location 选 Automatic，点 Create bucket。
2. 点 **Manage R2 API Tokens** → **Create API Token**：
   - Token name：`mc-deploy`（随便起）
   - Permissions：选 **Object Read & Write**
   - Specify bucket(s)：选 **Apply to specific buckets**，勾上刚建的 `mc-data`
   - TTL：选 **No expiry**（或者很长，过期了要重新配）
   - 点 Create API Token。
3. 页面会一次显示三个值，**马上复制下来，Secret Access Key 只显示这一次**：
   - Account ID
   - Access Key ID
   - Secret Access Key

## 第 4 步：GitHub 仓库加 Secrets（3 分钟）

1. 打开你的仓库 → **Settings** → 左边 **Secrets and variables** → **Actions** → **New repository secret**，依次加两个：
   - `CLOUDFLARE_API_TOKEN`：去 Cloudflare Dashboard 右上角头像 → **My Profile** → **API Tokens** → **Create Token** → 用 **Edit Cloudflare Workers** 模板（有 Workers 编辑权限就行），复制 Token 填进去。
   - `CLOUDFLARE_ACCOUNT_ID`：第 2 步记下的 Account ID。
2. 加完后回到仓库首页 → **Actions** 标签页，找到失败的那轮运行（第 1 步 push 触发的），点进去 → 右上角 **Re-run jobs** → **Re-run all jobs**，重新跑部署。

## 第 5 步：看部署跑完，拿到网址（5–15 分钟）

1. Actions 那轮运行里，最后一步是 **Deploy with Wrangler**：Wrangler 会在 GitHub 的机器上用 Docker 把 PHP 镜像建好、推到 Cloudflare，第一次构建要几分钟，耐心等它变绿。
2. 跑完变绿后，打开 <https://dash.cloudflare.com> → **Workers & Pages**，能看到一个叫 `mangguo-mail` 的 Worker，点进去，上面有个 `https://mangguo-mail.<你的子域名>.workers.dev` 的地址，点开。
3. 看到“第一次使用，先设一个登录账号和站点密码”就是部署成功了。先设站点密码（以后登录和加密邮箱凭据都用它），然后随便加一个邮箱试试收信。

## 第 6 步：Worker 加 Secrets（R2 + TG，5 分钟）

容器要靠这几个密钥去 R2 存数据、去 TG 推通知。在你电脑上跑（第一次要先登录，会弹浏览器确认）：

```bash
cd ~/workspace/email-aggregator/manage-center   # 仓库根目录
npx wrangler login
npx wrangler secret put R2_ACCOUNT_ID        # 粘贴第 3 步记下的 Account ID
npx wrangler secret put R2_ACCESS_KEY_ID     # 粘贴第 3 步的 Access Key ID
npx wrangler secret put R2_SECRET_ACCESS_KEY # 粘贴第 3 步的 Secret Access Key（只显示过一次的那个）
npx wrangler secret put R2_BUCKET            # 粘贴 mc-data（桶名改过就填改过的）
```

TG 通知用的 `TG_KEY`（可选，不用 TG 通知就跳过这步）：
1. 先在网站设置页打开 TG 通知开关，设置页会显示一串定时任务地址，里面 `key=` 后面那串就是 `tg_key`，复制下来。
2. 回终端跑：`npx wrangler secret put TG_KEY`，粘贴那串。
3. 不用重新部署，Worker 下次定时触发就用新的值；容器下次启动（休眠唤醒或重新部署）时会拿到 R2 的几个值。

## 第 7 步：验证清单（逐项打勾，都通过才算部署完）

- [ ] 打开 workers.dev 地址，能设站点密码、能登录。
- [ ] 加一个邮箱（比如 QQ），收件箱能列出邮件，读信、发信正常。
- [ ] 设置页 → 消息推送：填 chat_id + Bot Token，点“发一条测试通知”，TG 能收到（直连方式）。没填就走中转 Worker，也能收到。
- [ ] 等 5 分钟后，去 Cloudflare Dashboard → **R2** → `mc-data` 桶里，能看到 `data/site.php`、`data/mailboxes.php` 几个文件，说明备份链路通了。
- [ ] 关掉页面等 15 分钟再打开：能正常打开、邮箱和设置都在（说明容器休眠后从 R2 恢复成功了）。第一次唤醒要 1–3 秒，是正常的。

## 第 8 步（可选）：绑自己的域名

1. Dashboard → **Workers & Pages** → 点进 `mangguo-mail` → **Settings** → **Custom Domains** → **Set up a custom domain**，填你的域名（比如 `mail.你的域名`），按提示去域名 DNS 那里加一条 CNAME（Cloudflare 托管的域名会自动加）。
2. 绑完后用自己的域名打开，功能一样。
3. **如果你用 Outlook 微软登录**：域名变了，微软回调地址也要变——改 `manage/ms_oauth.php` 里 `MS_REDIRECT_URI` 改成 `https://你的域名/oauth.php?step=ms_callback`，并且去 Azure 注册的应用里把重定向 URI 改成一模一样的，差一个字微软就报不匹配。改完 push 一次重新部署。
4. TG 通知里的“看全文”链接和定时任务地址不用改代码，它们跟着当前访问的域名走（v4.29 起）。

## 费用（先说明是估算，以第一张账单为准）

- Workers Paid：$5/月（Containers 必须开 Paid 才能用）。
- 容器用量：每月免费额度 25 GiB-hours 内存、375 vCPU-分钟、200 GB-hours 磁盘、北美/欧洲 1 TB 出站流量。小应用一个月合计约 **$6–8**。
- R2：免费额度 10 GB 存储 + 每月 100 万次 A 类操作；我们只在文件变了才上传，一天几十次，基本不花钱。

## 常见问题

**Actions 里 Deploy with Wrangler 失败了**
点进那一步看红字：最常见的是 Secrets 没填对（`CLOUDFLARE_API_TOKEN` 没给 Workers 权限、Account ID 抄错了），或者 Workers Paid 没开（会提示需要 Paid 计划）。改好后点 Re-run jobs 重跑。

**部署成功了，但打开 workers.dev 报错 / 一直转圈**
等 1–2 分钟再刷新，第一次容器启动要拉镜像、从 R2 恢复数据。如果还不行，去 Dashboard → Workers & Pages → `mangguo-mail` → **Logs** 看报错；或者终端跑 `npx wrangler containers list` 看容器状态。

**加邮箱后收不到信、或者 TG 不推通知**
先在网站设置页点“发一条测试通知”：收不到就看页面报的错（Token 不对、找不到聊天、机器人被拉黑都会直接写出来）。TG 直连要求服务器能连 `api.telegram.org`，容器在 Cloudflare 上一般没问题；实在不行就把 chat_id 和 Token 清空，改回中转 Worker。

**R2 桶里 5 分钟后还是空的**
先确认第 6 步的 4 个 R2 Secret 都放对了（特别是 Secret Access Key 只显示一次，抄错就得重新建 Token）；再去 Dashboard → Containers 看容器是不是一直在跑（TG 每 5 分钟轮询会把它保持醒着）。也可以进容器日志搜 `mc-r2` 看备份脚本的输出。

**打开很慢、第一次要点好几秒**
容器闲置 10 分钟会休眠，唤醒要 1–3 秒，正常。TG 每 5 分钟轮询会把它保持醒着，平时基本感觉不到。

**以后改代码怎么更新？**
改完本地文件 → `git add -A && git commit -m "说明改了什么" && git push`，Actions 自动重新部署。容器磁盘是临时的，但数据在 R2 里，重新部署后启动时会自动恢复，不用担心。

**部署坏了怎么回滚？**
两个办法：① GitHub 仓库里点进上一次成功的 Actions 运行，点 **Re-run jobs** 重新部署那个版本；② 本地 `git revert` 掉有问题的提交再 push。

## 安全提醒

- 仓库可以是 **Public**（代码里你个人的默认值已经清空：TG 中转、Henna 面板、Cloud Mail 面板默认都是空的，别人部署后自己填）。
- 永远不要把 `data/` 提交进仓库（`.gitignore` 已经拦了，`git status` 时检查一遍）。
- API Token、R2 Secret Access Key、Bot Token 只显示一次，丢了就重新建一个，旧的马上作废。
- 别人用你的仓库部署时，让他们自己建 R2 桶、建自己的 TG 机器人、填自己的 Secrets，不要共用你的。
