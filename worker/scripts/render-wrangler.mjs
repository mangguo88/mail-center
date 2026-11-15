// 把 worker/wrangler.jsonc 里的占位符换成真实 ID，生成 wrangler.rendered.jsonc 再部署。
//
// 为什么要多这一步：wrangler.jsonc 在公开仓库里，不能写真实的 D1/KV ID
// （2026-11-15 之前写的是真值，别人 Fork 一眼就能看到）。
// 真实 ID 只存在 Cloudflare 面板 → Workers → mail-center → Settings → Build
// → Build variables and secrets 里的两个构建变量 D1_ID、KV_ID（类型都选 Secret）。
// 每次部署（npm run deploy / deploy:builds）都先跑这个脚本再调 wrangler，
// 所以面板里的绑定不会再被部署同步删掉；构建变量被删了，部署会直接报错停下，
// 不会静默把 Worker 清空（mango-mail 2026-11-14 就是这么修好的）。
//
// 本地跑也一样：先在 shell 里 export D1_ID / KV_ID（值去 CF 面板 D1 详情页
// 「数据库 ID」和 KV 列表里的 ID 那两栏复制），再跑 npm run deploy。
// 生成的 wrangler.rendered.jsonc 含真实 ID，已进 .gitignore，绝不要手动提交它。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const workerDir = join(dir, "..");
const src = join(workerDir, "wrangler.jsonc");
const out = join(workerDir, "wrangler.rendered.jsonc");

const missing = ["D1_ID", "KV_ID"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `[render-wrangler] 缺构建变量：${missing.join("、")}。\n` +
      `去 Cloudflare 面板 → Workers → mail-center → Settings → Build → ` +
      `Build variables and secrets 里加（类型选 Secret）：\n` +
      `  D1_ID = D1 详情页上「数据库 ID」那一栏的值\n` +
      `  KV_ID = KV 列表里那个命名空间的 ID\n` +
      `注意别加到 Settings → Variables and Secrets（运行时变量）那一栏，构建时看不到。\n` +
      `本地跑：在 shell 里 export D1_ID / KV_ID 再跑。部署已停下，没有动线上配置。`,
  );
  process.exit(1);
}

let text = readFileSync(src, "utf8");
text = text
  .replaceAll("REPLACE_D1_DATABASE_ID", process.env.D1_ID)
  .replaceAll("REPLACE_KV_NAMESPACE_ID", process.env.KV_ID);

if (text.includes("REPLACE_")) {
  console.error("[render-wrangler] 占位符没换完，停下不部署。请检查 wrangler.jsonc。");
  process.exit(1);
}

writeFileSync(out, text);
console.log("[render-wrangler] 已生成 wrangler.rendered.jsonc（值不打印，构建日志里也不会出现明文）。");
