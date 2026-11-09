# 邮箱管理中心 — VPS 部署说明

## 先说结论

| 方式 | 行不行 | 说明 |
| --- | --- | --- |
| VPS | ✅ 完全可以 | 程序是纯 PHP，不依赖 Serv00 任何特有东西，有 PHP + 能出站就行 |
| GitHub | ✅ 可以 | 代码放 GitHub 公开库，Actions 推到 VPS/Serv00，push 即部署（workflow 见 `.github/workflows/deploy.yml`） |
| Cloudflare Pages / Workers | ❌ 跑不了 | Pages 只托管静态站，Workers 是 JS 运行时，没有 PHP 解释器；CF 能做的是域名、CDN/WAF、Tunnel（挡在前面），不是跑程序 |

想“没有 Serv00 也能用”，正确组合是 **VPS + GitHub Actions 自动部署 + Cloudflare 只管域名/Tunnel**。下面是 VPS 那份。

## 程序要什么环境

- PHP **8.0+**（代码用了 `str_starts_with`，8.0 以下跑不了；建议 8.1 / 8.2）
- 扩展：`mbstring`、`openssl`（IMAP/SMTP 的 TLS 和 HTTPS 都靠它）；`sodium` 有最好，没有也能跑（加密自动降级到 OpenSSL + PBKDF2）
- 不用数据库、不用 Composer、不用 curl、不用 imap 扩展
- 出站端口要通：`993` / `465` / `587`（收发信）、`443`（Henna / Cloud Mail / 微软 API / TG 中转）
  - 注意：很多 VPS 商封 `25` 端口发信，但本程序发信走 `465` / `587` 提交端口，不受影响
- 一个域名 + SSL 证书（Let's Encrypt 免费）

## 部署步骤（Ubuntu 24.04 + Nginx）

### 1. 装 PHP 和 Nginx

```bash
sudo apt update && sudo apt install -y nginx php8.2-fpm php8.2-mbstring php8.2-sodium certbot python3-certbot-nginx
```

### 2. 传程序文件（只要这 7 个，放到网站根目录）

```
index.php        主程序
imap.php         收发信库
oauth.php        微软 OAuth2 入口
ms_oauth.php     微软 OAuth2 共用函数
henna.php        Henna 接入
cloudmail.php    Cloud Mail 接入
adapters.php     域名邮箱适配器注册表（v4.30，index.php 靠它认 Henna / Cloud Mail）
```

不要传 `data/`（那是运行数据，下面说）、不要传 `*.bak` 和旧版 `henna-v4.27.*.php`。

```bash
sudo mkdir -p /var/www/mail
# 把上面 7 个文件传到 /var/www/mail（scp / rsync / GitHub Actions 都行）
sudo chown -R www-data:www-data /var/www/mail
```

### 3. Nginx 配置（关键：`/data/` 必须拒绝访问）

`/etc/nginx/sites-available/mail`：

```nginx
server {
    listen 80;
    server_name mail.你的域名;
    root /var/www/mail;
    index index.php;

    # 数据目录禁止从网址访问（Apache 下靠 .htaccess，Nginx 不认 .htaccess，必须在这里拦）
    location ^~ /data/ {
        deny all;
    }

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mail /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d mail.你的域名   # 办免费证书
```

### 4. 首次打开

浏览器打开 `https://mail.你的域名`，设一个站点密码（以后登录和加密邮箱凭据都用它）。`data/` 目录程序会自动建（`0700` 权限），网站根目录要能写，不行就手动建：

```bash
sudo -u www-data mkdir -p /var/www/mail/data && sudo chmod 700 /var/www/mail/data
```

### 5. TG 新邮件轮询（可选，不开 TG 通知就不用）

VPS 自带 cron，每 5 分钟调一次（`KEY` 在设置页里看）：

```bash
crontab -e
# 加一行：
*/5 * * * * curl -fsS "https://mail.你的域名/?tgcheck=1&key=你的KEY" >/dev/null 2>&1
```

没有 crontab 的环境可以用 cron-job.org 这类免费外部定时服务调同一个地址。

### 6. 从 Serv00 搬过来（可选）

`data/` 整个拷过来就行，站点密码不变、所有邮箱和凭据都在：

```bash
# 在 Serv00 上：
cd ~/domains/mangguo.lele.pp.ua/public_html && tar czf /tmp/mc-data.tgz data/
# 传到 VPS 解到 /var/www/mail/，再改回属主：
sudo chown -R www-data:www-data /var/www/mail/data && sudo chmod 700 /var/www/mail/data
```

注意：`data/` 里有加密后的邮箱凭据，传的时候走 scp/rsync，别放公开地方。

## 换域名 / 换给别人用，必须改的几处

| 地方 | 文件 | 改成什么 |
| --- | --- | --- |
| 微软登录回调地址 | `ms_oauth.php` 第 10 行 `MS_REDIRECT_URI` | 改成你自己的域名 `https://你的域名/oauth.php?step=ms_callback`，**并且去 Azure 注册的应用里把重定向 URI 也改成一模一样的**，差一个字微软就报不匹配 |
| TG 通知里的“看全文”链接 | `index.php` 约 468 行 | 把 `https://mangguo.lele.pp.ua/?tab=inbox&mb=` 改成你的域名 |
| TG 中转 Worker | 设置页可改 | 默认是 aa 的 Worker，`chat_id` 写死是 aa 的——**给别人用必须自己部署一个 TG 中转 Worker 填进去，或者在设置页关掉 TG 通知** |
| SnappyMail 链接 | `index.php` `SNAPPY_URL` / `ADMIN_URL` | 不用 SnappyMail 可以不管，只是两个链接 |
| IMAP ID 自报地址 | `imap.php` 约 415 行 `support-url` | 只是自报身份里的一个网址，可不管 |

## GitHub 自动部署怎么接

- 建一个**公开库**（代码里个人默认值已清空；`data/` 里有凭据，千万别提交——仓库根目录的 `.gitignore` 已经把 `data/`、`*.bak` 拦住了）
- 库结构：`manage/` 目录（6 个 php 文件）+ `.github/workflows/deploy.yml` + 本文件
- 在仓库 Settings → Secrets and variables → Actions 里加：
  - `SSH_HOST`（VPS 地址）、`SSH_USER`、`SSH_KEY`（部署用的私钥）、`SSH_PORT`（默认 22）、`TARGET_DIR`（如 `/var/www/mail`）
- push 到 `main` 就自动部署；也可以在 Actions 页点 Run workflow 手动推
- 同一份 workflow 改 Secrets 也能推 Serv00（`SSH_HOST` 填 `dkuwfoo.serv00.net`，`TARGET_DIR` 填 `~/domains/mangguo.lele.pp.ua/public_html`）

## Cloudflare 在这套里负责什么

- 域名解析、CDN、WAF：域名托管到 CF，A 记录指到 VPS IP，开小云朵
- Cloudflare Tunnel：不想把 VPS 端口暴露出来，就在 VPS 上跑 `cloudflared`，走 Tunnel 出去（aa 的 Tunnel 管理面板项目就是管这个的）
- Workers：只适合 TG 通知中转这种小活，已经在用了；跑不了 PHP 主程序
