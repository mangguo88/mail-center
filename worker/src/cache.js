// cache.js — 收件箱列表缓存（KV，快路径）
// KV 读是边缘缓存的，比 D1 读还快；写每天只有 1000 次，所以只放列表缓存这种读多写少的东西。
// 失效不用 KV delete（删也要占额度）：每个邮箱在 D1 有个 cache_version，
// 发信/删信/移动/标已读后版本号 +1，旧 key 就自然没人读了，靠 TTL 自己过期。
// KV 没配好（env.CACHE 不存在）时自动回落到 D1 缓存，Worker 不会崩。

export function cacheKey(mbId, folder, version) {
  return `inbox:${mbId}:${folder}:v${version || 0}`;
}

export async function kvCacheGet(env, mbId, folder, version) {
  if (!env.CACHE) return null;
  try {
    const raw = await env.CACHE.get(cacheKey(mbId, folder, version), 'text');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function kvCachePut(env, mbId, folder, version, data, ttlMinutes) {
  if (!env.CACHE) return false;
  try {
    const ttlSeconds = Math.max(60, Math.round((ttlMinutes || 1) * 60));
    await env.CACHE.put(cacheKey(mbId, folder, version), JSON.stringify(data), { expirationTtl: ttlSeconds });
    return true;
  } catch {
    return false;
  }
}
