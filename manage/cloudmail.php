<?php
declare(strict_types=1);
// ---------- Cloud Mail 域名邮箱接入（v4.28） ----------
// Cloud Mail 面板（如 https://cfmail.151819.xyz/，上游 maillab/cloud-mail）
// 没有 IMAP/SMTP，邮件存在它自己的 D1 数据库里，只能走它自己的 HTTP API
// 收发。这里是管理中心调 Cloud Mail API 的客户端，由 index.php 调用。
// 只定义函数，不输出任何东西。
// 大方向和 Henna 一样（单独写一个 HTTP 适配器、一条记录管一个地址、
// 面板地址 + 登录账号 + 登录密码、每请求现登一次），但接口是另一套：
//   认证：POST /api/login {email,password} 拿 {token}，Authorization 头
//     直接放 token，不带 Bearer 前缀；信封是 {code:200, data, message}。
//   登录身份：登进面板的那个用户账号（它名下可以有多个 @域名 地址，
//     地址本身没有独立密码）。查邮件要先调 GET /api/account/list 把
//     要管理的地址换成数字 accountId，后面所有调用都要带它。
//   文件夹：只有 type=0 收件、type=1 已发，没有草稿、垃圾箱、已删除。
//   分页：游标翻页（emailId + timeSort，size 最多 50），没有 offset。
//   读信：没有单封接口，用 full=1 的列表加游标取那一封。
//   删除：DELETE /email/delete 是软删，删了就从列表消失，没有垃圾箱可看。
// 注意：这个文件里不写 PHP 闭合标记（任何位置都不写，包括注释）。

define('CLOUDMAIL_DEFAULT_PANEL', ''); // 公开项目：默认不填，别人部署时在添加页填自己的 Cloud Mail 面板地址
define('CLOUDMAIL_HTTP_TIMEOUT', 15);

// 面板地址归一化：去尾斜杠，没写协议就补 https，空的用默认面板
function cloudmail_panel_url(string $panel): string {
    $panel = trim($panel);
    if ($panel === '') $panel = CLOUDMAIL_DEFAULT_PANEL;
    if ($panel === '') return '';
    $panel = rtrim($panel, '/');
    if (stripos($panel, 'http://') !== 0 && stripos($panel, 'https://') !== 0) $panel = 'https://' . $panel;
    return $panel;
}

// 最底层 HTTP 调用（file_get_contents + stream_context_create，不用 curl）。
// 成功返回 ['status'=>int, 'ctype'=>string, 'raw'=>string, 'json'=>array|null]；
// 连不上返回 ['error' => '人话原因']。$raw 为真时不解析 JSON（附件下载用）。
function cloudmail_http(string $panel, string $token, string $method, string $path, $body = null, bool $raw = false): array {
    $base = cloudmail_panel_url($panel);
    if ($base === '') return ['error' => 'Cloud Mail 面板地址没填对。'];
    $url = $base . '/api' . $path;
    $headers = "Accept: application/json\r\n";
    if ($token !== '') $headers .= 'Authorization: ' . $token . "\r\n";
    $content = null;
    if ($body !== null) {
        $content = json_encode($body, JSON_UNESCAPED_UNICODE);
        if ($content === false) $content = '{}';
        $headers .= "Content-Type: application/json\r\nContent-Length: " . strlen($content) . "\r\n";
    }
    $ctx = stream_context_create([
        'http' => [
            'method' => $method,
            'header' => $headers,
            'content' => $content,
            'timeout' => CLOUDMAIL_HTTP_TIMEOUT,
            'ignore_errors' => true,
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $resp = @file_get_contents($url, false, $ctx);
    if ($resp === false) return ['error' => '连不上 Cloud Mail 面板（' . $base . '），请检查面板地址和服务器网络，稍后再试。'];
    $status = 0;
    $ctype = '';
    if (isset($http_response_header) && is_array($http_response_header)) {
        if (preg_match('/^HTTP\/\S+\s+(\d+)/', (string)$http_response_header[0], $m)) $status = (int)$m[1];
        foreach ($http_response_header as $h) {
            if (stripos($h, 'Content-Type:') === 0) $ctype = trim(substr($h, 13));
        }
    }
    $json = null;
    if (!$raw && $resp !== '') {
        $d = json_decode($resp, true);
        if (is_array($d)) $json = $d;
    }
    return ['status' => $status, 'ctype' => $ctype, 'raw' => $resp, 'json' => $json];
}

// 调 Cloud Mail API：解 {code, data, message} 信封，成功返回 data；
// 失败返回 ['error' => '人话原因']。
function cloudmail_api(string $panel, string $token, string $method, string $path, $body = null) {
    $r = cloudmail_http($panel, $token, $method, $path, $body);
    if (isset($r['error'])) return ['error' => $r['error']];
    $d = $r['json'];
    if (!is_array($d)) {
        if ($r['status'] === 401 || $r['status'] === 403) return ['error' => 'Cloud Mail 登录失效（HTTP ' . $r['status'] . '），请检查面板登录邮箱和密码。'];
        if ($r['status'] === 404) return ['error' => 'Cloud Mail 面板没有这个接口（HTTP 404）：' . $path];
        return ['error' => 'Cloud Mail 面板返回了看不懂的内容（HTTP ' . $r['status'] . '）。'];
    }
    if (!array_key_exists('code', $d)) return $d;
    if ((int)$d['code'] !== 200) {
        $msg = trim((string)($d['message'] ?? ''));
        if ($msg === '') $msg = 'Cloud Mail 返回了错误（code ' . (string)$d['code'] . '）。';
        if ((int)$d['code'] === 401) $msg = 'Cloud Mail 登录失效：' . $msg;
        return ['error' => $msg];
    }
    return $d['data'] ?? null;
}

// POST /api/login 拿 token。成功返回 ['token' => ...]，失败返回 ['error' => ...]。
function cloudmail_login(string $panel, string $email, string $password): array {
    $email = trim($email);
    if ($email === '' || $password === '') return ['error' => 'Cloud Mail 登录邮箱或密码没填。'];
    $r = cloudmail_api($panel, '', 'POST', '/login', ['email' => $email, 'password' => $password]);
    if (is_array($r) && isset($r['error'])) return ['error' => (string)$r['error']];
    $tok = '';
    if (is_array($r)) {
        foreach (['token', 'access_token', 'jwt'] as $k) {
            if (!empty($r[$k]) && is_string($r[$k])) { $tok = $r[$k]; break; }
        }
    } elseif (is_string($r) && $r !== '') {
        $tok = $r;
    }
    if ($tok === '') return ['error' => 'Cloud Mail 登录成功了，但没拿到令牌，请检查面板版本。'];
    return ['token' => $tok];
}

// 给一个 Cloud Mail 邮箱拿可用的令牌（同一请求里缓存，不重复登）。
// 拿不到返回 ''，调用方按这个报错。
function cloudmail_token_for(string $panel, string $login_email, string $password, string $mb_id = ''): string {
    static $cache = [];
    $ckey = $mb_id !== '' ? $mb_id : $panel . '|' . $login_email;
    if (isset($cache[$ckey])) return $cache[$ckey];
    $tok = '';
    $lr = cloudmail_login($panel, $login_email, $password);
    if (!empty($lr['token'])) $tok = (string)$lr['token'];
    $cache[$ckey] = $tok;
    return $tok;
}

// 按地址查数字 accountId（同一请求里缓存）。成功返回 [accountId, '']，
// 失败返回 [0, '人话原因']。
function cloudmail_account_id_for(string $panel, string $token, string $address): array {
    static $cache = [];
    $address = strtolower(trim($address));
    $ckey = cloudmail_panel_url($panel) . '|' . $address;
    if (isset($cache[$ckey])) return $cache[$ckey];
    $res = cloudmail_api($panel, $token, 'GET', '/account/list?size=30');
    if (is_array($res) && isset($res['error'])) { $cache[$ckey] = [0, (string)$res['error']]; return $cache[$ckey]; }
    if (!is_array($res)) { $cache[$ckey] = [0, 'Cloud Mail 返回的账号列表看不懂。']; return $cache[$ckey]; }
    foreach ($res as $a) {
        if (is_array($a) && strtolower(trim((string)($a['email'] ?? ''))) === $address) {
            $cache[$ckey] = [(int)($a['accountId'] ?? 0), ''];
            return $cache[$ckey];
        }
    }
    $cache[$ckey] = [0, '登录成功了，但这个登录账号名下没有 ' . $address . ' 这个邮箱：先去 Cloud Mail 面板确认这个地址已添加、且属于这个登录账号。'];
    return $cache[$ckey];
}

// 连接测试：登录 + 取账号列表，核对要管理的地址在登录账号名下存在。
// 返回 [true/false, '人话结果']。
function cloudmail_test(string $panel, string $login_email, string $password, string $address): array {
    $panel = cloudmail_panel_url($panel);
    $address = strtolower(trim($address));
    if ($panel === '') return [false, 'Cloud Mail 面板地址没填对。'];
    if ($login_email === '' || $password === '') return [false, 'Cloud Mail 登录邮箱或密码没填。'];
    $lr = cloudmail_login($panel, $login_email, $password);
    if (empty($lr['token'])) return [false, 'Cloud Mail 登录失败：' . (string)($lr['error'] ?? '面板没有回应')];
    [$aid, $err] = cloudmail_account_id_for($panel, (string)$lr['token'], $address);
    if ($aid <= 0) return [false, $err];
    return [true, '连接成功，登录邮箱和密码都对，已在面板上找到这个邮箱（accountId ' . $aid . '）。'];
}

// Cloud Mail 的“文件夹”其实是列表接口的 type 参数；只有收件和已发送。
function cloudmail_folder_map(): array {
    return ['inbox' => 0, 'sent' => 1];
}

// createTime 是 'YYYY-MM-DD HH:MM:SS'（D1 的 CURRENT_TIMESTAMP，UTC），
// 转成带 +0000 的标准日期串，这样 strtotime 在任何服务器时区下都不会算错。
function cloudmail_date_string($created): string {
    $s = trim((string)$created);
    if ($s === '') return '';
    if (preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $s)) {
        $ts = strtotime($s . ' UTC');
        if ($ts === false) return $s;
        return gmdate('D, d M Y H:i:s +0000', $ts);
    }
    $ts = strtotime($s);
    if ($ts === false || $ts <= 0) return $s;
    return gmdate('D, d M Y H:i:s +0000', $ts);
}

// 摘要：优先纯文本 text，没有就用 HTML content 剥标签；压缩空白、截 300 字。
function cloudmail_snippet(array $it): string {
    $t = trim((string)($it['text'] ?? ''));
    if ($t === '' && trim((string)($it['content'] ?? '')) !== '') {
        $t = trim(html_entity_decode(strip_tags((string)$it['content']), ENT_QUOTES, 'UTF-8'));
    }
    $t = preg_replace('/\s+/u', ' ', $t);
    if ($t === null) $t = '';
    return function_exists('mb_substr') ? mb_substr($t, 0, 300, 'UTF-8') : substr($t, 0, 300);
}

// 列表行转管理中心列表的形状（uid/seen/date/subject/from_name/from_addr/to/snippet/size）。
// unread：0 未读、1 已读。
function cloudmail_row(array $it): array {
    return [
        'uid' => (int)($it['emailId'] ?? 0),
        'seen' => ((int)($it['unread'] ?? 0)) === 1,
        'date' => cloudmail_date_string($it['createTime'] ?? ''),
        'subject' => (string)($it['subject'] ?? ''),
        'from_name' => (string)($it['name'] ?? ''),
        'from_addr' => (string)($it['sendEmail'] ?? ''),
        'to' => (string)($it['toEmail'] ?? ''),
        'snippet' => cloudmail_snippet($it),
        'size' => 0,
    ];
}

// 取一个 Cloud Mail 邮箱的邮件列表（第 $page 页，每页 $per 封）。
// 成功返回 ['rows' => [...], 'total' => int]；失败返回 ['error' => ...]。
// 游标翻页：第 1 页 emailId=0（不带游标），第 2 页起用上一页最后一封的
// emailId 当游标（timeSort=0 时是“小于这个 id”，按 id 倒序取）。
function cloudmail_fetch_list(string $panel, string $token, int $account_id, string $folder, int $page, int $per = 30): array {
    $typemap = cloudmail_folder_map();
    if (!isset($typemap[$folder])) return ['rows' => [], 'total' => 0];
    if ($page < 1) $page = 1;
    if ($per < 1) $per = 30;
    if ($per > 50) $per = 50;
    $cursor = 0;
    $rows = [];
    $total = 0;
    for ($p = 1; $p <= $page; $p++) {
        $qs = http_build_query(['accountId' => $account_id, 'type' => $typemap[$folder], 'size' => $per, 'emailId' => $cursor, 'timeSort' => 0, 'full' => 0, 'allReceive' => 0], '', '&');
        $res = cloudmail_api($panel, $token, 'GET', '/email/list?' . $qs);
        if (is_array($res) && isset($res['error'])) return ['error' => (string)$res['error']];
        if (!is_array($res) || !isset($res['list']) || !is_array($res['list'])) return ['error' => 'Cloud Mail 返回的邮件列表看不懂。'];
        $rows = [];
        foreach ($res['list'] as $it) {
            if (!is_array($it)) continue;
            $rows[] = cloudmail_row($it);
        }
        $total = (int)($res['total'] ?? count($rows));
        if (count($rows) < $per) break;
        $last = end($rows);
        if ($last === false) break;
        $cursor = (int)($last['uid'] ?? 0);
        if ($cursor <= 0) break;
    }
    return ['rows' => $rows, 'total' => $total];
}

// 取一封 Cloud Mail 邮件的全文。成功返回
// ['from','from_name','to','subject','date','text','html','attachments']，
// attachments 每项是 ['id','filename','ctype','size','key']；失败返回 ['error' => ...]。
// Cloud Mail 没有单封接口：用 full=1 的列表加游标 emailId=uid+1、size=1
// 取（timeSort=0 时“小于 uid+1”倒序第一封就是这一封）。先按给定文件夹的
// type 试，找不到再试另一个 type（回复/转发时文件夹不一定准）。
function cloudmail_fetch_message(string $panel, string $token, int $account_id, string $folder, int $uid): array {
    if ($uid <= 0) return ['error' => '邮件不存在。'];
    $typemap = cloudmail_folder_map();
    $types = [];
    if (isset($typemap[$folder])) $types[] = (int)$typemap[$folder];
    foreach ($typemap as $t) { if (!in_array((int)$t, $types, true)) $types[] = (int)$t; }
    $row = null;
    foreach ($types as $type) {
        $qs = http_build_query(['accountId' => $account_id, 'type' => $type, 'size' => 1, 'emailId' => $uid + 1, 'timeSort' => 0, 'full' => 1, 'allReceive' => 0], '', '&');
        $res = cloudmail_api($panel, $token, 'GET', '/email/list?' . $qs);
        if (is_array($res) && isset($res['error'])) return ['error' => (string)$res['error']];
        if (!is_array($res) || !isset($res['list']) || !is_array($res['list']) || empty($res['list'])) continue;
        $first = $res['list'][0];
        if (!is_array($first) || (int)($first['emailId'] ?? 0) !== $uid) continue;
        $row = $first;
        break;
    }
    if ($row === null) return ['error' => '这封邮件取不回来，可能是已经被删了。'];
    $atts = [];
    $ares = cloudmail_api($panel, $token, 'GET', '/email/attList?emailId=' . $uid);
    if (is_array($ares) && !isset($ares['error']) && is_array($ares)) {
        foreach ($ares as $a) {
            if (!is_array($a)) continue;
            $atts[] = [
                'id' => (int)($a['attId'] ?? 0),
                'filename' => (string)($a['filename'] ?? 'attachment'),
                'ctype' => (string)($a['mimeType'] ?? 'application/octet-stream'),
                'size' => (int)($a['size'] ?? 0),
                'key' => (string)($a['key'] ?? ''),
            ];
        }
    }
    return [
        'from' => (string)($row['sendEmail'] ?? ''),
        'from_name' => (string)($row['name'] ?? ''),
        'to' => (string)($row['toEmail'] ?? ''),
        'subject' => (string)($row['subject'] ?? ''),
        'date' => cloudmail_date_string($row['createTime'] ?? ''),
        'text' => (string)($row['text'] ?? ''),
        'html' => (string)($row['content'] ?? ''),
        'attachments' => $atts,
    ];
}

// 标已读（尽力而为，失败不报错）。emailIds 是数字数组。
function cloudmail_mark_read(string $panel, string $token, array $email_ids): bool {
    $ids = array_values(array_unique(array_map('intval', $email_ids)));
    if (empty($ids)) return false;
    $res = cloudmail_api($panel, $token, 'PUT', '/email/read', ['emailIds' => $ids]);
    return is_array($res) && !isset($res['error']);
}

// 删除一封或多封 Cloud Mail 邮件（软删：从列表消失，没有垃圾箱可看）。
// 返回 [true/false, '人话原因']。
function cloudmail_delete(string $panel, string $token, array $email_ids): array {
    $ids = array_values(array_unique(array_map('intval', $email_ids)));
    if (empty($ids)) return [false, '邮件不存在。'];
    $res = cloudmail_api($panel, $token, 'DELETE', '/email/delete?emailIds=' . implode(',', $ids));
    if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
    return [true, ''];
}

// 经 Cloud Mail 发信（纯文本）。$to 里是收件人，抄送请调用方先并进 $to
// （Cloud Mail 的 /email/send 没有抄送字段；多收件人用 receiveEmail 数组）。
// 发信通道走 CF Email（要 Workers Paid）或按域名的 Resend，没配好会报错。
// 返回 [true/false, '人话原因']。
function cloudmail_send(string $panel, string $token, int $account_id, string $from, array $to, string $subject, string $text): array {
    $to = array_values(array_unique(array_filter(array_map('trim', $to), static function ($a) { return filter_var($a, FILTER_VALIDATE_EMAIL) !== false; })));
    if ($from === '' || empty($to)) return [false, '发件人或收件人没填对。'];
    $name = (string)explode('@', $from)[0];
    $payload = ['accountId' => $account_id, 'name' => $name, 'receiveEmail' => $to, 'subject' => $subject, 'text' => $text, 'content' => $text, 'attachments' => []];
    $res = cloudmail_api($panel, $token, 'POST', '/email/send', $payload);
    if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
    return [true, ''];
}

// 取比 $since_id 新的收件（TG 新邮件轮询用，v4.28 先备着、还没接进轮询）。
// 成功返回管理中心列表形状的 rows；失败返回 ['error' => ...]。
function cloudmail_latest(string $panel, string $token, int $account_id, int $since_id): array {
    $qs = http_build_query(['accountId' => $account_id, 'emailId' => $since_id, 'allReceive' => 0], '', '&');
    $res = cloudmail_api($panel, $token, 'GET', '/email/latest?' . $qs);
    if (is_array($res) && isset($res['error'])) return ['error' => (string)$res['error']];
    if (!is_array($res)) return ['error' => 'Cloud Mail 返回的新邮件列表看不懂。'];
    $rows = [];
    foreach ($res as $it) {
        if (!is_array($it)) continue;
        $rows[] = cloudmail_row($it);
    }
    return ['rows' => $rows];
}

// 附件下载：从 Cloud Mail 的 R2 取流。$key 是 attList 返回的 key。
// 成功返回 ['ctype'=>..., 'body'=>...]，失败返回 ['error' => ...]。
function cloudmail_download(string $panel, string $token, string $key): array {
    $key = ltrim(trim($key), '/');
    if ($key === '') return ['error' => '附件不存在。'];
    $r = cloudmail_http($panel, $token, 'GET', '/oss/' . $key, null, true);
    if (isset($r['error'])) return ['error' => $r['error']];
    if ($r['status'] === 404) return ['error' => '附件不存在或已过期。'];
    if ($r['status'] !== 200) return ['error' => 'Cloud Mail 返回 HTTP ' . $r['status'] . '，附件下不下来。'];
    $ctype = (string)($r['ctype'] ?? '');
    if ($ctype === '') $ctype = 'application/octet-stream';
    return ['ctype' => $ctype, 'body' => (string)$r['raw']];
}
