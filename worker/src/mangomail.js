// ---------- Mango-Mail 域名邮箱 HTTP 适配器（Worker 版，照 Henna 适配器移植） ----------
// Mango-Mail 面板（如 https://mango-mail.53424209.workers.dev/）没有 IMAP/SMTP，
// 邮件存在它自己的 D1 数据库里，只能走它自己的 HTTP API 收发。它是 Henna 的
// 同源复刻，API 形状与 Henna 一致：{ok, data, error} 信封，POST /api/auth/login
// 拿 JWT（Authorization: Bearer），列表 /message?box=&mailbox=&limit=&offset=，
// 全文 /message/{id}（取时服务端自动标已读），发信 /send 与 /send/bulk。
// 两点与 Henna 不同：面板设置里的 api_key 不走 Bearer，走 X-Api-Key 请求头；
// 面板开了登录人机验证（Turnstile）时，/api/auth/login 会直接挡掉 API 登录。
// 认证：POST /api/auth/login 拿 JWT；登录失败时允许把填的 api_key 当密码用
// （探 /mailbox，通了就按 X-Api-Key 方式用）。
const TIMEOUT_MS = 15000;

// 面板地址归一化：去尾斜杠，没写协议就补 https，空的返回 ''。
export function mangoPanelUrl(panel) {
  let p = String(panel || '').trim();
  if (!p) return '';
  p = p.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(p)) p = 'https://' + p;
  return p;
}

// 最底层 HTTP 调用。成功返回 {status, ctype, raw, json}；连不上返回 {error}。
// wantBytes 为真时不解析 JSON，返回 {status, ctype, bytes}（附件下载用，二进制不能过 text()）。
async function mangoHttp(panel, token, method, path, body, wantBytes) {
  const base = mangoPanelUrl(panel);
  if (!base) return { error: 'Mango-Mail 面板地址没填对。' };
  const headers = { Accept: 'application/json' };
  // token 以 'apikey:' 开头时是面板的 api_key，走 X-Api-Key 请求头（不走 Bearer）。
  if (token) {
    if (token.startsWith('apikey:')) headers['X-Api-Key'] = token.slice(7);
    else headers.Authorization = 'Bearer ' + token;
  }
  let rawBody;
  if (body !== undefined && body !== null) {
    rawBody = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(base + '/api' + path, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { error: '连不上 Mango-Mail 面板（' + base + '），请检查面板地址和服务器网络，稍后再试。' };
  }
  const ctype = res.headers.get('Content-Type') || '';
  if (wantBytes) {
    const buf = await res.arrayBuffer();
    return { status: res.status, ctype, bytes: new Uint8Array(buf) };
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 不是 JSON 就留空 */ }
  return { status: res.status, ctype, raw: text, json: data };
}

// 调 Mango-Mail API：解 {ok, data, error} 信封，返回 data；失败返回 {error}。
// apiKey 填了时走 X-Api-Key 认证（token 参数忽略）。
export async function mangoApi(panel, token, method, path, body, apiKey) {
  const r = await mangoHttp(panel, apiKey ? 'apikey:' + apiKey : token, method, path, body);
  if (r.error) return { error: r.error };
  const d = r.json;
  if (d === null || d === undefined || typeof d !== 'object') {
    if (r.status === 401 || r.status === 403) return { error: 'Mango-Mail 登录失效（HTTP ' + r.status + '），请检查面板登录邮箱和密码。' };
    if (r.status === 404) return { error: 'Mango-Mail 面板没有这个接口（HTTP 404）：' + path };
    return { error: 'Mango-Mail 面板返回了看不懂的内容（HTTP ' + r.status + '）。' };
  }
  if ('ok' in d) {
    if (d.ok === false) {
      const e = String(d.error || '').trim();
      return { error: e || 'Mango-Mail 返回了错误。' };
    }
    return d.data ?? null;
  }
  return d;
}

function pickToken(r) {
  if (typeof r === 'string' && r) return r;
  if (!r || typeof r !== 'object') return '';
  for (const k of ['token', 'access_token', 'jwt']) {
    if (typeof r[k] === 'string' && r[k]) return r[k];
  }
  if (r.data && typeof r.data === 'object') {
    for (const k of ['token', 'access_token', 'jwt']) {
      if (typeof r.data[k] === 'string' && r.data[k]) return r.data[k];
    }
  }
  return '';
}

// POST /api/auth/login 拿 JWT。成功返回 {token}，失败返回 {error}。
export async function mangoLogin(panel, email, password) {
  email = String(email || '').trim();
  if (!email || !password) return { error: 'Mango-Mail 登录邮箱或密码没填。' };
  const r = await mangoApi(panel, '', 'POST', '/auth/login', { email, password });
  if (r && r.error) return { error: String(r.error) };
  const tok = pickToken(r);
  if (!tok) return { error: 'Mango-Mail 登录成功了，但没拿到令牌，请检查面板版本。' };
  return { token: tok };
}

// 给一个 Mango-Mail 邮箱拿可用的令牌。先走 /auth/login；登录失败时把填的
// 凭据当 api_key 用 X-Api-Key 探一次（用 /mailbox 验证），能用就按 api_key
// 方式用（返回 'apikey:' + 密钥，调用方不用区分）。拿不到返回 ''。
export async function mangoTokenFor(panel, loginEmail, password) {
  const lr = await mangoLogin(panel, loginEmail, password);
  if (lr.token) return lr.token;
  const probe = await mangoApi(panel, '', 'GET', '/mailbox?scope=mine', undefined, password);
  if (probe && !probe.error) return 'apikey:' + password;
  return '';
}

// 连接测试：登录 + 取邮箱列表，核对要管理的地址在面板上存在。返回 [true/false, '人话结果']。
export async function mangoTest(panel, loginEmail, password, address) {
  panel = mangoPanelUrl(panel);
  address = String(address || '').trim().toLowerCase();
  if (!panel) return [false, 'Mango-Mail 面板地址没填对。'];
  if (!loginEmail || !password) return [false, 'Mango-Mail 登录邮箱或密码没填。'];
  const tok = await mangoTokenFor(panel, loginEmail, password);
  if (!tok) return [false, 'Mango-Mail 登录失败：请检查面板地址、登录账号和密码。'];
  const list = await mangoApi(panel, tok, 'GET', '/mailbox?scope=mine');
  if (list && list.error) return [false, 'Mango-Mail 登录上了，但取邮箱列表失败：' + String(list.error)];
  if (!Array.isArray(list)) return [false, 'Mango-Mail 返回的邮箱列表看不懂。'];
  for (const a of list) {
    if (a && typeof a === 'object' && String(a.address || '').trim().toLowerCase() === address) {
      return [true, '连接成功，登录邮箱和密码都对，已在面板上找到这个邮箱。'];
    }
  }
  return [false, '登录成功了，但面板上没有 ' + address + ' 这个邮箱：先去 Mango-Mail 面板确认这个地址已添加、且属于这个登录账号。'];
}

// Mango-Mail 的“文件夹”其实是接口的 box 参数；没有已删除（trash 不在里面）。
export function mangoFolderMap() {
  return { inbox: 'in', sent: 'out', drafts: 'draft', spam: 'spam' };
}

// Mango-Mail 的 created_at 是毫秒时间戳（秒级的也兼容），转成带 +0000 的标准日期串。
function mangoDateString(created) {
  let ts = Number(created) || 0;
  if (ts <= 0) return '';
  if (ts > 9999999999) ts = Math.floor(ts / 1000);
  return new Date(ts * 1000).toUTCString().replace('GMT', '+0000');
}

// 取一个 Mango-Mail 邮箱的邮件列表（第 page 页，每页 per 封）。
// 成功返回 {rows, total}，rows 是管理中心列表的形状（uid/seen/date/subject/from_name/from_addr/to/snippet/size）；
// 失败返回 {error}。Mango-Mail 列表接口不给总数：total 就是这页取到的条数，不谎报还有下一页。
export async function mangoFetchList(panel, token, address, folder, page, per) {
  const boxmap = mangoFolderMap();
  if (!boxmap[folder]) return { rows: [], total: 0 };
  page = Math.max(1, page || 1);
  per = Math.min(50, Math.max(1, per || 30));
  const qs = new URLSearchParams({
    box: boxmap[folder],
    mailbox: address,
    limit: String(per),
    offset: String((page - 1) * per),
  });
  const res = await mangoApi(panel, token, 'GET', '/message?' + qs.toString());
  if (res && res.error) return { error: String(res.error) };
  if (!Array.isArray(res)) return { error: 'Mango-Mail 返回的邮件列表看不懂。' };
  const rows = res
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({
      uid: Number(it.id) || 0,
      seen: Number(it.is_read) === 1,
      date: mangoDateString(it.created_at),
      subject: String(it.subject || ''),
      from_name: String(it.from_name || ''),
      from_addr: String(it.from_addr || ''),
      to: String(it.to_addr || ''),
      snippet: String(it.snippet || ''),
      size: Number(it.size) || 0,
    }));
  return { rows, total: rows.length };
}

// 取一封 Mango-Mail 邮件的全文。成功返回 {from, from_name, to, subject, date, text, html, attachments}，
// attachments 每项是 {id, filename, ctype, size}；失败返回 {error}。
// 注意：Mango-Mail 取全文时服务端自动把这封标成已读。
export async function mangoFetchMessage(panel, token, id) {
  id = Number(id) || 0;
  if (id <= 0) return { error: '邮件不存在。' };
  const res = await mangoApi(panel, token, 'GET', '/message/' + id);
  if (res && res.error) return { error: String(res.error) };
  if (!res || typeof res !== 'object') return { error: 'Mango-Mail 返回的邮件看不懂。' };
  return {
    from: String(res.from_addr || ''),
    from_name: String(res.from_name || ''),
    to: String(res.to_addr || ''),
    subject: String(res.subject || ''),
    date: mangoDateString(res.created_at),
    text: String(res.text_body || ''),
    html: String(res.html_body || ''),
    attachments: (Array.isArray(res.attachments) ? res.attachments : [])
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        id: Number(a.id) || 0,
        filename: String(a.name || 'attachment'),
        ctype: String(a.mime || 'application/octet-stream'),
        size: Number(a.size) || 0,
      })),
  };
}

// 标已读（尽力而为，失败不报错；取全文时服务端本来就会标已读）。
export async function mangoMarkRead(panel, token, id) {
  id = Number(id) || 0;
  if (id <= 0) return false;
  const res = await mangoApi(panel, token, 'POST', '/message/' + id + '/read', {});
  return !!(res && !res.error);
}

// 彻底删除一封 Mango-Mail 邮件（Mango-Mail 没有已删除，删了找不回来）。返回 [true/false, '人话原因']。
export async function mangoDelete(panel, token, id) {
  id = Number(id) || 0;
  if (id <= 0) return [false, '邮件不存在。'];
  const res = await mangoApi(panel, token, 'DELETE', '/message/' + id);
  if (res && res.error) return [false, String(res.error)];
  return [true, ''];
}

// 附件下载：从 Mango-Mail 的 R2 流式取回。成功返回 {ctype, bytes}，失败返回 {error}。
export async function mangoDownload(panel, token, attId) {
  attId = Number(attId) || 0;
  if (attId <= 0) return { error: '附件不存在。' };
  const r = await mangoHttp(panel, token, 'GET', '/message/attachment/' + attId, null, true);
  if (r.error) return { error: r.error };
  if (r.status === 404) return { error: '附件不存在或已过期。' };
  if (r.status !== 200) return { error: 'Mango-Mail 返回 HTTP ' + r.status + '，附件下不下来。' };
  return { ctype: r.ctype || 'application/octet-stream', bytes: r.bytes };
}

// 经 Mango-Mail 发信（纯文本）。to 里是收件人，抄送请调用方先并进 to
// （Mango-Mail 的 /send 没有抄送字段）。
// 一个收件人走 /send，多个走 /send/bulk。返回 [true/false, '人话原因/渠道']。
export async function mangoSend(panel, token, from, to, subject, text) {
  to = [...new Set(to.map((a) => String(a || '').trim()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)))];
  if (!from || !to.length) return [false, '发件人或收件人没填对。'];
  const payload = { from, to, subject, text };
  if (to.length === 1) {
    const res = await mangoApi(panel, token, 'POST', '/send', payload);
    if (res && res.error) return [false, String(res.error)];
    if (!res || typeof res !== 'object' || !res.success) {
      const e = res && typeof res === 'object' ? String(res.error || '').trim() : '';
      return [false, e || 'Mango-Mail 那边没发出去，也没说原因。'];
    }
    return [true, String(res.provider || '')];
  }
  const res = await mangoApi(panel, token, 'POST', '/send/bulk', payload);
  if (res && res.error) return [false, String(res.error)];
  if (!res || typeof res !== 'object') return [false, 'Mango-Mail 批量发送返回了看不懂的内容。'];
  const failed = Number(res.failed) || 0;
  const okn = Number(res.success) || 0;
  const total = Number(res.total) || to.length;
  if (failed > 0) return [false, '群发只成功了 ' + okn + '/' + total + ' 封。'];
  return [true, '批量 ' + okn + '/' + total + ' 成功'];
}
