#!/bin/bash
# 容器启动脚本：先从 R2 恢复 data/，再起 cron 定时备份，最后起 PHP + Nginx。
set -e

# 1. 从 R2 恢复数据（容器磁盘是临时的，重启/休眠会清空；没配 R2 就跳过）
if [ -n "$R2_BUCKET" ]; then
  php /opt/mc/r2-restore.php || echo "r2-restore failed (first run is normal if the bucket is empty)"
fi

# 2. 每 5 分钟把 data/ 里重要的文件备份到 R2
echo '*/5 * * * * root php /opt/mc/r2-backup.php >> /var/log/mc-r2.log 2>&1' > /etc/cron.d/mc-r2
chmod 644 /etc/cron.d/mc-r2
service cron start || cron || true

# 3. 起 PHP-FPM 和 Nginx；收到停止信号时先最后备份一次再退出
php-fpm -D
nginx -g 'daemon off;' &
NGINX_PID=$!
trap 'kill -TERM $NGINX_PID; wait $NGINX_PID; php /opt/mc/r2-backup.php || true' TERM INT
wait $NGINX_PID
