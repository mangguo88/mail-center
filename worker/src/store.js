// store.js — 邮件全文与附件（R2，大文件）
// 读信时从 IMAP 拿到原始全文就存一份进 R2，下次重读直接从 R2 拿，不用再连邮箱服务器；
// 附件同理，第一次下载时存，之后直接从 R2 下。
// 删信/移信时把对应的 R2 对象删掉（尽力而为，删失败不影响主流程）。
// R2 没配好（env.STORE 不存在）时全部回落到 IMAP，Worker 不会崩。
// 超过 10MB 的信不存 R2（Worker 内存 128MB，大信光解析就够呛，跳过存储只走 IMAP）。

export const MAX_STORE_BYTES = 10 * 1024 * 1024;

export function msgKey(mbId, folder, uid) {
  return `msg/${mbId}/${folder}/${uid}`;
}

export function attKey(mbId, folder, uid, part) {
  return `att/${mbId}/${folder}/${uid}/${part}`;
}

export async function storeRaw(env, mbId, folder, uid, bytes) {
  if (!env.STORE || !bytes || bytes.length > MAX_STORE_BYTES) return false;
  try {
    await env.STORE.put(msgKey(mbId, folder, uid), bytes);
    return true;
  } catch {
    return false;
  }
}

export async function getRaw(env, mbId, folder, uid) {
  if (!env.STORE) return null;
  try {
    const obj = await env.STORE.get(msgKey(mbId, folder, uid));
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  } catch {
    return null;
  }
}

export async function storeAttachment(env, mbId, folder, uid, part, bytes, ctype, filename) {
  if (!env.STORE || !bytes || bytes.length > MAX_STORE_BYTES) return false;
  try {
    await env.STORE.put(attKey(mbId, folder, uid, part), bytes, {
      httpMetadata: { contentType: ctype || 'application/octet-stream' },
      customMetadata: { filename: filename || 'attachment' },
    });
    return true;
  } catch {
    return false;
  }
}

// 返回 {bytes, ctype, filename}，没有返回 null。
export async function getAttachment(env, mbId, folder, uid, part) {
  if (!env.STORE) return null;
  try {
    const obj = await env.STORE.get(attKey(mbId, folder, uid, part));
    if (!obj) return null;
    return {
      bytes: new Uint8Array(await obj.arrayBuffer()),
      ctype: obj.httpMetadata?.contentType || 'application/octet-stream',
      filename: obj.customMetadata?.filename || 'attachment',
    };
  } catch {
    return null;
  }
}

// 删掉一封信在 R2 里的全文和全部附件（移信/删信后调）。
export async function deleteMessageStore(env, mbId, folder, uid) {
  if (!env.STORE) return;
  try {
    await env.STORE.delete(msgKey(mbId, folder, uid));
    const prefix = `att/${mbId}/${folder}/${uid}/`;
    let cursor;
    do {
      const listed = await env.STORE.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        await env.STORE.delete(listed.objects.map((o) => o.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch {
    // 尽力而为，删失败不影响主流程；残留对象靠以后手动清或 R2 生命周期规则。
  }
}
