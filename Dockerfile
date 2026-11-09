# 邮箱管理中心 — Cloudflare Containers 镜像
# PHP 8.2-FPM + Nginx，跑现成的 manage/*.php（不改代码）。
# 数据持久化不靠容器磁盘（临时的），靠 /opt/mc/r2-backup.php 每 5 分钟同步到 R2，
# 启动时 /opt/mc/r2-restore.php 从 R2 恢复。见 DEPLOY-GITHUB-CF.md。
FROM php:8.2-fpm

RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx \
        cron \
        libcurl4-openssl-dev \
        libonig-dev \
        libsodium-dev \
    && docker-php-ext-install mbstring sodium curl \
    && rm -rf /var/lib/apt/lists/*

# 程序文件：只取 7 个正式文件，不要 *.bak 和旧版 henna-v4.27.*.php（adapter-template.php 是模板，不进镜像）
COPY manage/index.php manage/imap.php manage/oauth.php manage/ms_oauth.php manage/henna.php manage/cloudmail.php manage/adapters.php /var/www/html/
# R2 同步脚本（放 web 根目录之外，容器内用）
COPY cf/r2store.php cf/r2-backup.php cf/r2-restore.php /opt/mc/
# Nginx 配置与启动脚本
COPY cf/nginx.conf /etc/nginx/sites-available/default
COPY cf/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && chown -R www-data:www-data /var/www/html \
    && mkdir -p /var/www/html/data \
    && chown www-data:www-data /var/www/html/data \
    && chmod 700 /var/www/html/data \
    && rm -f /etc/nginx/sites-enabled/default \
    && ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
