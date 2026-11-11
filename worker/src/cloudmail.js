// ---------- Cloud Mail 域名邮箱 HTTP 适配器（Worker 版，照 manage/cloudmail.php v4.28 移植） ----------
// Cloud Mail 面板（如 https://cfmail.151819.xyz/，上游 maillab/cloud-mail）
// 没有 IMAP/SMTP，邮件存在它自己的 D1 数据库里，只能走它自己的 HTTP API
// 收发。
//   认证：POST /api/login {email,password} 拿 {token}，Authorization 头
//     直接放 token，不带 Bearer 前缀；信封是 {code:200, data, message}。
//   登录身份：登进面板的那个用户账号（它名下可以有多个 @域名 地址，
//     地址本身没有独立密码）。查邮件要先调 GET /api/account/list 把
//     要管理的地址换成数字 accountId，后面所有调用都要带它。
//   文件夹：只有 type=0 收件、type=1 已发，没有草稿、垃圾箱、已删除。
//   分页：游标翻页（emailId + timeSort，size 最多 50），没有 offset。
//   读信：没有单封接口，用 full=1 的列表加游标取那一封。
//   删除：DELETE /email/delete 是软删，删了就从列表消失，没有垃圾箱可看。
const TIMEOUT_MS = 15000;

// 面板地址归一化：去尾斜杠，没写协议就补 https，空的返回 ''。
export function cloudmailPanelUrl(panel) {
  let p = String(panel || '').trim();
  if (!p) return '';
  p = p.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(p)) p = 'https://' + p;
  return p;
}

// 最底层 HTTP 调用。成功返回 {status, ctype, raw, json}；连不上返回 {error}。
// wantBytes 为真时不解析 JSON，返回 {status, ctype, bytes}（附件下载用）。
async function cloudmailHttp(panel, token, method, path, body, wantBytes) {
  const base = cloudmailPanelUrl(panel);
  if (!base) return { error: 'Cloud Mail 面板地址没填对。' };
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = token;
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
    return { error: '连不上 Cloud Mail 面板（' + base + '），请检查面板地址和服务器网络，稍后再试。' };
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

// 调 Cloud Mail API：解 {code, data, message} 信封，成功返回 data；失败返回 {error}。
export async function cloudmailApi(panel, token, method, path, body) {
  const r = await cloudmailHttp(panel, token, method, path, body);
  if (r.error) return { error: r.error };
  const d = r.json;
  if (d === null || d === undefined || typeof d !== 'object') {
    if (r.status === 401 || r.status === 403) return { error: 'Cloud Mail 登录失效（HTTP ' + r.status + '），请检查面板登录邮箱和密码。' };
    if (r.status === 404) return { error: 'Cloud Mail 面板没有这个接口（HTTP 404）：' + path };
    return { error: 'Cloud Mail 面板返回了看不懂的内容（HTTP ' + r.status + '）。' };
  }
  if (!('code' in d)) return d;
  if (Number(d.code) !== 200) {
    let msg = String(d.message || '').trim();
    if (!msg) msg = 'Cloud Mail 返回了错误（code ' + String(d.code) + '）。';
    if (Number(d.code) === 401) msg = 'Cloud Mail 登录失效：' + msg;
    return { error: msg };
  }
  return d.data ?? null;
}

function pickToken(r) {
  if (typeof r === 'string' && r) return r;
  if (!r || typeof r !== 'object') return '';
  for (const k of ['token', 'access_token', 'jwt']) {
    if (typeof r[k] === 'string' && r[k]) return r[k];
  }
  return '';
}

// POST /api/login 拿 token。成功返回 {token}，失败返回 {error}。
export async function cloudmailLogin(panel, email, password) {
  email = String(email || '').trim();
  if (!email || !password) return { error: 'Cloud Mail 登录邮箱或密码没填。' };
  const r = await cloudmailApi(panel, '', 'POST', '/login', { email, password });
  if (r && r.error) return { error: String(r.error) };
  const tok = pickToken(r);
  if (!tok) return { error: 'Cloud Mail 登录成功了，但没拿到令牌，请检查面板版本。' };
  return { token: tok };
}

// 给一个 Cloud Mail 邮箱拿可用的令牌。拿不到返回 ''，调用方按这个报错。
export async function cloudmailTokenFor(panel, loginEmail, password) {
  const lr = await cloudmailLogin(panel, loginEmail, password);
  return lr.token || '';
}

// 按地址查数字 accountId。成功返回 [accountId, '']，失败返回 [0, '人话原因']。
export async function cloudmailAccountIdFor(panel, token, address) {
  address = String(address || '').trim().toLowerCase();
  const res = await cloudmailApi(panel, token, 'GET', '/account/list?size=30');
  if (res && res.error) return [0, String(res.error)];
  if (!Array.isArray(res)) return [0, 'Cloud Mail 返回的账号列表看不懂。'];
  for (const a of res) {
    if (a && typeof a === 'object' && String(a.email || '').trim().toLowerCase() === address) {
      return [Number(a.accountId) || 0, ''];
    }
  }
  return [0, '登录成功了，但这个登录账号名下没有 ' + address + ' 这个邮箱：先去 Cloud Mail 面板确认这个地址已添加、且属于这个登录账号。'];
}

// 连接测试：登录 + 取账号列表，核对要管理的地址在登录账号名下存在。返回 [true/false, '人话结果']。
export async function cloudmailTest(panel, loginEmail, password, address) {
  panel = cloudmailPanelUrl(panel);
  address = String(address || '').trim().toLowerCase();
  if (!panel) return [false, 'Cloud Mail 面板地址没填对。'];
  if (!loginEmail || !password) return [false, 'Cloud Mail 登录邮箱或密码没填。'];
  const lr = await cloudmailLogin(panel, loginEmail, password);
  if (!lr.token) return [false, 'Cloud Mail 登录失败：' + String(lr.error || '面板没有回应')];
  const [aid, err] = await cloudmailAccountIdFor(panel, lr.token, address);
  if (aid <= 0) return [false, err];
  return [true, '连接成功，登录邮箱和密码都对，已在面板上找到这个邮箱（accountId ' + aid + '）。'];
}

// Cloud Mail 的“文件夹”其实是列表接口的 type 参数；只有收件和已发送。
export function cloudmailFolderMap() {
  return { inbox: 0, sent: 1 };
}

// createTime 是 'YYYY-MM-DD HH:MM:SS'（D1 的 CURRENT_TIMESTAMP，UTC），
// 转成带 +0000 的标准日期串。
function cloudmailDateString(created) {
  const s = String(created || '').trim();
  if (!s) return '';
  let ts = NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    ts = Date.parse(s.replace(' ', 'T') + 'Z');
  } else {
    ts = Date.parse(s);
  }
  if (Number.isNaN(ts) || ts <= 0) return s;
  return new Date(ts).toUTCString().replace('GMT', '+0000');
}

// 摘要：优先纯文本 text，没有就用 HTML content 剥标签；压缩空白、截 300 字。
function cloudmailSnippet(it) {
  let t = String(it.text || '').trim();
  if (!t && String(it.content || '').trim()) {
    t = String(it.content)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }
  return t.replace(/\s+/g, ' ').slice(0, 300);
}

// 列表行转管理中心列表的形状（uid/seen/date/subject/from_name/from_addr/to/snippet/size）。
// 注意：上游的 unread 字段是反着标的——UNREAD=0、READ=1（见上游 entity-const.js），
// 所以 seen 是 unread===1，和 PHP 版一致。
function cloudmailRow(it) {
  return {
    uid: Number(it.emailId) || 0,
    seen: Number(it.unread) === 1,
    date: cloudmailDateString(it.createTime),
    subject: String(it.subject || ''),
    from_name: String(it.name || ''),
    from_addr: String(it.sendEmail || ''),
    to: String(it.toEmail || ''),
    snippet: cloudmailSnippet(it),
    size: 0,
  };
}

// 取一个 Cloud Mail 邮箱的邮件列表（第 page 页，每页 per 封）。
// 成功返回 {rows, total}；失败返回 {error}。
// 游标翻页：第 1 页 emailId=0（不带游标），第 2 页起用上一页最后一封的
// emailId 当游标（timeSort=0 时是“小于这个 id”，按 id 倒序取）。
export async function cloudmailFetchList(panel, token, accountId, address, folder, page, per) {
  const typemap = cloudmailFolderMap();
  if (!(folder in typemap)) return { rows: [], total: 0 };
  page = Math.max(1, page || 1);
  per = Math.min(50, Math.max(1, per || 30));
  let cursor = 0;
  let rows = [];
  let total = 0;
  for (let p = 1; p <= page; p++) {
    const qs = new URLSearchParams({
      accountId: String(accountId),
      type: String(typemap[folder]),
      size: String(per),
      emailId: String(cursor),
      timeSort: '0',
      full: '0',
      allReceive: '0',
    });
    const res = await cloudmailApi(panel, token, 'GET', '/email/list?' + qs.toString());
    if (res && res.error) return { error: String(res.error) };
    if (!res || typeof res !== 'object' || !Array.isArray(res.list)) return { error: 'Cloud Mail 返回的邮件列表看不懂。' };
    rows = res.list.filter((it) => it && typeof it === 'object').map(cloudmailRow);
    total = Number(res.total) || rows.length;
    if (rows.length < per) break;
    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = Number(last.uid) || 0;
    if (cursor <= 0) break;
  }
  return { rows, total };
}

// 取一封 Cloud Mail 邮件的全文。成功返回
// {from, from_name, to, subject, date, text, html, attachments}，
// attachments 每项是 {id, filename, ctype, size, key}；失败返回 {error}。
// Cloud Mail 没有单封接口：用 full=1 的列表加游标 emailId=uid+1、size=1
// 取（timeSort=0 时“小于 uid+1”倒序第一封就是这一封）。先按给定文件夹的
// type 试，找不到再试另一个 type（回复/转发时文件夹不一定准）。
export async function cloudmailFetchMessage(panel, token, accountId, folder, uid) {
  uid = Number(uid) || 0;
  if (uid <= 0) return { error: '邮件不存在。' };
  const typemap = cloudmailFolderMap();
  const types = [];
  if (folder in typemap) types.push(typemap[folder]);
  for (const t of Object.values(typemap)) { if (!types.includes(t)) types.push(t); }
  let row = null;
  for (const type of types) {
    const qs = new URLSearchParams({
      accountId: String(accountId),
      type: String(type),
      size: '1',
      emailId: String(uid + 1),
      timeSort: '0',
      full: '1',
      allReceive: '0',
    });
    const res = await cloudmailApi(panel, token, 'GET', '/email/list?' + qs.toString());
    if (res && res.error) return { error: String(res.error) };
    if (!res || typeof res !== 'object' || !Array.isArray(res.list) || !res.list.length) continue;
    const first = res.list[0];
    if (!first || typeof first !== 'object' || Number(first.emailId) !== uid) continue;
    row = first;
    break;
  }
  if (!row) return { error: '这封邮件取不回来，可能是已经被删了。' };
  const atts = [];
  const ares = await cloudmailApi(panel, token, 'GET', '/email/attList?emailId=' + uid);
  if (ares && !ares.error && Array.isArray(ares)) {
    for (const a of ares) {
      if (!a || typeof a !== 'object') continue;
      atts.push({
        id: Number(a.attId) || 0,
        filename: String(a.filename || 'attachment'),
        ctype: String(a.mimeType || 'application/octet-stream'),
        size: Number(a.size) || 0,
        key: String(a.key || ''),
      });
    }
  }
  return {
    from: String(row.sendEmail || ''),
    from_name: String(row.name || ''),
    to: String(row.toEmail || ''),
    subject: String(row.subject || ''),
    date: cloudmailDateString(row.createTime),
    text: String(row.text || ''),
    html: String(row.content || ''),
    attachments: atts,
  };
}

// 标已读（尽力而为，失败不报错）。emailIds 是数字数组。
export async function cloudmailMarkRead(panel, token, accountId, emailIds) {
  const ids = [...new Set(emailIds.map((x) => Number(x) || 0).filter((x) => x > 0))];
  if (!ids.length) return false;
  const res = await cloudmailApi(panel, token, 'PUT', '/email/read', { emailIds: ids });
  return !!(res && !res.error);
}

// 删除一封或多封 Cloud Mail 邮件（软删：从列表消失，没有垃圾箱可看）。返回 [true/false, '人话原因']。
export async function cloudmailDelete(panel, token, accountId, emailIds) {
  const ids = [...new Set(emailIds.map((x) => Number(x) || 0).filter((x) => x > 0))];
  if (ids.length === 0) return [false, '邮件不存在。'];
  const res = await cloudmailApi(panel, token, 'DELETE', '/email/delete?emailIds=' + ids.join(','));
  if (res && res.error) return [false, String(res.error)];
  return [true, ''];
}

// 经 Cloud Mail 发信（纯文本）。to 里是收件人，抄送请调用方先并进 to
// （Cloud Mail 的 /email/send 没有抄送字段；多收件人用 receiveEmail 数组）。
// 发信通道走 CF Email（要 Workers Paid）或按域名的 Resend，没配好会报错。
// 返回 [true/false, '人话原因']。
export async function cloudmailSend(panel, token, accountId, from, to, subject, text) {
  to = [...new Set(to.map((a) => String(a || '').trim()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)))];
  if (!from || !to.length) return [false, '发件人或收件人没填对。'];
  const name = String(from.split('@')[0] || '');
  const payload = { accountId, name, receiveEmail: to, subject, text, content: text, attachments: [] };
  const res = await cloudmailApi(panel, token, 'POST', '/email/send', payload);
  if (res && res.error) return [false, String(res.error)];
  return [true, ''];
}

// 附件下载：从 Cloud Mail 的 R2 取流。先按附件 id 查 attList 拿 key，再 GET /oss/{key}。
// 成功返回 {ctype, bytes}，失败返回 {error}。
export async function cloudmailDownloadByAttId(panel, token, accountId, uid, attId) {
  attId = Number(attId) || 0;
  if (attId <= 0) return { error: '附件不存在。' };
  const ares = await cloudmailApi(panel, token, 'GET', '/email/attList?emailId=' + (Number(uid) || 0));
  if (ares && ares.error) return { error: String(ares.error) };
  if (!Array.isArray(ares)) return { error: '附件列表取不回来。' };
  const hit = ares.find((a) => a && typeof a === 'object' && Number(a.attId) === attId);
  if (!hit) return { error: '附件不存在。' };
  const key = String(hit.key || '').replace(/^\/+/, '');
  if (!key) return { error: '附件不存在。' };
  const r = await cloudmailHttp(panel, token, 'GET', '/oss/' + key, null, true);
  if (r.error) return { error: r.error };
  if (r.status === 404) return { error: '附件不存在或已过期。' };
  if (r.status !== 200) return { error: 'Cloud Mail 返回 HTTP ' + r.status + '，附件下不下来。' };
  return { ctype: r.ctype || 'application/octet-stream', bytes: r.bytes };
}
