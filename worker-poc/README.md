# Mail Center PoC — 免费 Worker 直连 IMAP 验证

只验证一件事：**免费 Workers 能不能直连 IMAP 993（TLS），登录并拉取收件箱信封，且不触 10ms CPU 上限。**

通过 = 重写路线可行；失败 = 先看失败原因再定（超 CPU 报 error 1102、连不上是网络/端口问题）。

## 它做什么

- `GET /imap-test?n=10`：连 `IMAP_HOST:993`（TLS 直连，不走任何中转），LOGIN → SELECT INBOX → FETCH 前 n 封的 UID + ENVELOPE（日期、主题、发件人），LOGOUT，返回 JSON。
- 只读，不发信、不删信、不标已读。

## 部署（aa 在自己电脑上跑）

```bash
cd worker-poc
npm install
npx wrangler login
npx wrangler secret put IMAP_HOST   # 填 imap.qq.com
npx wrangler secret put IMAP_USER   # 填邮箱地址，如 1641697128@qq.com
npx wrangler secret put IMAP_PASS   # 填 QQ 授权码（不是 QQ 密码）
npx wrangler deploy
```

部署成功会给一个地址，形如 `https://mail-center-poc.<你的子域名>.workers.dev`，
浏览器打开 `https://mail-center-poc.<你的子域名>.workers.dev/imap-test?n=10`。

## 怎么看结果

- `{"ok":true,"count":10,"messages":[...]}`：通了，主题和发件人能正常解码，路线可行。
- `{"ok":false,"error":"login_failed"}`：IMAP 没连上或账号不对，检查授权码（QQ 授权码可重复用，重新生成、改 QQ 密码会失效）。
- 打开页面报 Cloudflare **error 1102**：一次请求的 CPU 超了 10ms，免费额度装不下这个做法，重写要换策略（比如拆请求、降解析量），先把报错截图发过来。
- `{"ok":false,"error":"timeout 20s"}`：服务器响应太慢或连接被挂起，截图发过来。

## 凭据

IMAP_HOST/USER/PASS 只存在 Cloudflare 的 secret 里，不要贴进聊天、不要写进代码。
测试建议用 QQ 邮箱（1641697128@qq.com 已确认收发正常，走授权码）。

## 通过之后

- Phase 0b：再加一个 SMTP 587 STARTTLS 发信测试（`secureTransport: "starttls"` + `startTls()`）。
- Phase 1：核心重写——D1 存邮箱/设置/缓存、Web Crypto 加密凭据、IMAP 客户端完整版（163 的 IMAP ID、中文文件夹 modified UTF-7、MIME 正文解析）。
- Phase 2：三栏界面 + API 路由（静态资源走 Worker Static Assets）。
- Phase 3：Henna / Cloud Mail 适配器（走 fetch）、TG 直连 + Cron 每 5 分钟轮询、Outlook OAuth。
- Phase 4：Serv00 的 data/ 迁移进 D1，验证通过再切换，Serv00 的 v4.28.2 留作回退。

注意：仓库根目录的 `.github/workflows/deploy-cf.yml` 是容器部署（要 Workers Paid），
纯 Worker 路线部署改走 `wrangler deploy`，那个 workflow 在 Phase 4 再换掉，之前不用管它。
