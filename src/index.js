import { Container, getContainer } from "@cloudflare/containers";

// 容器：PHP 8.2-FPM + Nginx，监听 8080。
// 单实例：所有请求都进同一个容器（名字固定为 mail-1），数据不会散。
// R2 凭据存在 Worker Secrets 里，这里转发给容器（entrypoint 和备份脚本用）。
export class MailCenter extends Container {
  defaultPort = 8080;
  // 闲置 10 分钟后休眠；TG 轮询每 5 分钟来一次，平时基本保持醒着。
  // 注意：容器磁盘是临时的，休眠/重启会清空，数据靠 R2 同步（见 cf/r2-backup.php）。
  sleepAfter = "10m";

  envVars = {
    R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: this.env.R2_BUCKET,
  };
}

export default {
  // 所有网页请求都转发给同一个容器。
  async fetch(request, env) {
    const container = getContainer(env.MAIL_CENTER, "mail-1");
    return container.fetch(request);
  },

  // 每 5 分钟一次：调容器里的 TG 轮询入口。
  // TG_KEY 是 Worker Secret，值要和站点设置页里的 tg_key 填成同一个。
  async scheduled(event, env, ctx) {
    const container = getContainer(env.MAIL_CENTER, "mail-1");
    const key = encodeURIComponent(env.TG_KEY || "");
    ctx.waitUntil(
      container.fetch(new Request(`http://container/?tgcheck=1&key=${key}`)),
    );
  },
};
