<?php
declare(strict_types=1);
// ---------- Henna 域名邮箱接入（v4.27） ----------
// Henna 面板（如 https://email.070605.xyz/）没有 IMAP/SMTP，邮件存在它自己的
// D1 数据库里，只能走它自己的 HTTP API 收发。这里是管理中心调 Henna API
// 的客户端，由 index.php 调用。只定义函数，不输出任何东西。
// 认证：POST /login 拿 JWT（Authorization: Bearer）；如果 /login 不存在或
// 登录失败，允许把填的凭据本身当 API Key 用（面板设置里有 api_key）。
// 登录每次请求都现登一次（同一请求里用 static 缓存，不重复登）。
// 注意：这个文件里不写 PHP 闭合标记（任何位置都不写，包括注释）。

define('HENNA_DEFAULT_PANEL', ''); // 公开项目：默认不填，别人部署时在添加页填自己的 Henna 面板地址
define('HENNA_HTTP_TIMEOUT', 15);

// 面板地址归一化：去尾斜杠，没写协议就补 https，空的用默认面板
function henna_panel_url(string $panel): string {
    $panel = trim($panel);
    if ($panel === '') $panel = HENNA_DEFAULT_PANEL;
    if ($panel === '') return '';
    $panel = rtrim($panel, '/');
    if (stripos($panel, 'http://') !== 0 && stripos($panel, 'https://') !== 0) $panel = 'https://' . $panel;
    return $panel;
}

// 最底层 HTTP 调用（file_get_contents + stream_context_create，不用 curl）。
// 成功返回 ['status'=>int, 'ctype'=>string, 'raw'=>string, 'json'=>array|null]；
// 连不上返回 ['error' => '人话原因']。
function henna_http(string $panel, string $token, string $method, string $path, $body = null): array {
    $base = henna_panel_url($panel);
    if ($base === '') return ['error' => 'Henna 面板地址没填对。'];
    $url = $base . '/api' . $path;
    $headers = "Accept: application/json\r\n";
    if ($token !== '') $headers .= 'Authorization: Bearer ' . $token . "\r\n";
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
            'timeout' => HENNA_HTTP_TIMEOUT,
            'ignore_errors' => true,
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false) return ['error' => '连不上 Henna 面板（' . $base . '），请检查面板地址和服务器网络，稍后再试。'];
    $status = 0;
    $ctype = '';
    if (isset($http_response_header) && is_array($http_response_header)) {
        if (preg_match('/^HTTP\/\S+\s+(\d+)/', (string)$http_response_header[0], $m)) $status = (int)$m[1];
        foreach ($http_response_header as $h) {
            if (stripos($h, 'Content-Type:') === 0) $ctype = trim(substr($h, 13));
        }
    }
    $json = null;
    if ($raw !== '') {
        $d = json_decode($raw, true);
        if (is_array($d)) $json = $d;
    }
    return ['status' => $status, 'ctype' => $ctype, 'raw' => $raw, 'json' => $json];
}

// 调 Henna API：解 {ok, data, error} 信封，返回 data；失败返回 ['error' => '人话原因']。
// 注意：返回的 data 可能是数组、字符串或 null，调用方先判 isset($r['error']) 再用。
function henna_api(string $panel, string $token, string $method, string $path, $body = null) {
    $r = henna_http($panel, $token, $method, $path, $body);
    if (isset($r['error'])) return ['error' => $r['error']];
    $d = $r['json'];
    if (!is_array($d)) {
        if ($r['status'] === 401 || $r['status'] === 403) return ['error' => 'Henna 登录失效（HTTP ' . $r['status'] . '），请检查面板登录邮箱和密码。'];
        if ($r['status'] === 404) return ['error' => 'Henna 面板没有这个接口（HTTP 404）：' . $path];
        return ['error' => 'Henna 面板返回了看不懂的内容（HTTP ' . $r['status'] . '）。'];
    }
    if (array_key_exists('ok', $d)) {
        if ($d['ok'] === false) {
            $e = trim((string)($d['error'] ?? ''));
            return ['error' => $e !== '' ? $e : 'Henna 返回了错误。'];
        }
        return $d['data'] ?? null;
    }
    return $d;
}

// POST /login 拿 JWT。成功返回 ['token' => ...]，失败返回 ['error' => ...]。
// /login 的返回形状未经实测：token 从 data.token / access_token / jwt /
// 裸字符串里依次找，找不到就报错（见 henna_token_for 的 API Key 兜底）。
function henna_login(string $panel, string $email, string $password): array {
    $email = trim($email);
    if ($email === '' || $password === '') return ['error' => 'Henna 登录邮箱或密码没填。'];
    $r = henna_api($panel, '', 'POST', '/login', ['email' => $email, 'password' => $password]);
    if (is_array($r) && isset($r['error'])) return ['error' => (string)$r['error']];
    $tok = '';
    if (is_array($r)) {
        foreach (['token', 'access_token', 'jwt'] as $k) {
            if (!empty($r[$k]) && is_string($r[$k])) { $tok = $r[$k]; break; }
        }
    } elseif (is_string($r) && $r !== '') {
        $tok = $r;
    }
    if ($tok === '') return ['error' => 'Henna 登录成功了，但没拿到令牌，请检查面板版本。'];
    return ['token' => $tok];
}

// 给一个 Henna 邮箱拿可用的 Bearer 令牌（同一请求里缓存，不重复登）。
// 先走 /login；登录失败时把填的凭据本身当 API Key 试一次（用 /mailbox 验证），
// API Key 能用就直接用它。拿不到返回 ''，调用方按这个报错。
function henna_token_for(string $panel, string $login_email, string $password, string $mb_id = ''): string {
    static $cache = [];
    $ckey = $mb_id !== '' ? $mb_id : $panel . '|' . $login_email;
    if (isset($cache[$ckey])) return $cache[$ckey];
    $tok = '';
    $lr = henna_login($panel, $login_email, $password);
    if (!empty($lr['token'])) {
        $tok = (string)$lr['token'];
    } else {
        $probe = henna_api($panel, $password, 'GET', '/mailbox?scope=mine');
        if (is_array($probe) && !isset($probe['error'])) $tok = $password;
    }
    $cache[$ckey] = $tok;
    return $tok;
}

// 连接测试：登录 + 取邮箱列表，核对要管理的地址在面板上存在。
// 返回 [true/false, '人话结果']。
function henna_test(string $panel, string $login_email, string $password, string $address): array {
    $panel = henna_panel_url($panel);
    $address = strtolower(trim($address));
    if ($panel === '') return [false, 'Henna 面板地址没填对。'];
    if ($login_email === '' || $password === '') return [false, 'Henna 登录邮箱或密码没填。'];
    $lr = henna_login($panel, $login_email, $password);
    $tok = '';
    $via = '';
    if (!empty($lr['token'])) {
        $tok = (string)$lr['token'];
        $via = 'login';
    } else {
        $probe = henna_api($panel, $password, 'GET', '/mailbox?scope=mine');
        if (is_array($probe) && !isset($probe['error'])) {
            $tok = $password;
            $via = 'apikey';
        } else {
            return [false, 'Henna 登录失败：' . (string)($lr['error'] ?? '面板没有回应')];
        }
    }
    $list = henna_api($panel, $tok, 'GET', '/mailbox?scope=mine');
    if (is_array($list) && isset($list['error'])) return [false, 'Henna 登录上了，但取邮箱列表失败：' . (string)$list['error']];
    if (!is_array($list)) return [false, 'Henna 返回的邮箱列表看不懂。'];
    foreach ($list as $a) {
        if (is_array($a) && strtolower(trim((string)($a['address'] ?? ''))) === $address) {
            if ($via === 'apikey') return [true, '连接成功（用的 API Key 直连）：已在面板上找到这个邮箱。'];
            return [true, '连接成功，登录邮箱和密码都对，已在面板上找到这个邮箱。'];
        }
    }
    return [false, '登录成功了，但面板上没有 ' . $address . ' 这个邮箱：先去 Henna 面板确认这个地址已添加、且属于这个登录账号。'];
}

// Henna 的“文件夹”其实是接口的 box 参数；没有已删除（trash 不在里面）。
function henna_folder_map(): array {
    return ['inbox' => 'in', 'sent' => 'out', 'drafts' => 'draft', 'spam' => 'spam'];
}

// Henna 的 created_at 是毫秒时间戳（秒级的也兼容），转成带 +0000 的标准日期串，
// 这样 strtotime 在任何服务器时区下都不会算错，mail_display_date 再转北京时间。
function henna_date_string($created): string {
    $ts = (int)$created;
    if ($ts <= 0) return '';
    if ($ts > 9999999999) $ts = (int)floor($ts / 1000);
    return gmdate('D, d M Y H:i:s +0000', $ts);
}

// 取一个 Henna 邮箱的邮件列表（第 $page 页，每页 $per 封）。
// 成功返回 ['rows' => [...], 'total' => int]，rows 是管理中心列表的形状
// （uid/seen/date/subject/from_name/from_addr/to/snippet/size）；
// 失败返回 ['error' => ...]。
// Henna 列表接口不给总数：total 就是这页取到的条数，不谎报还有下一页。
function henna_fetch_list(string $panel, string $token, string $address, string $folder, int $page, int $per = 30): array {
    $boxmap = henna_folder_map();
    if (!isset($boxmap[$folder])) return ['rows' => [], 'total' => 0];
    if ($page < 1) $page = 1;
    if ($per < 1) $per = 30;
    if ($per > 50) $per = 50;
    $qs = http_build_query(['box' => $boxmap[$folder], 'mailbox' => $address, 'limit' => $per, 'offset' => ($page - 1) * $per], '', '&');
    $res = henna_api($panel, $token, 'GET', '/message?' . $qs);
    if (is_array($res) && isset($res['error'])) return ['error' => (string)$res['error']];
    if (!is_array($res)) return ['error' => 'Henna 返回的邮件列表看不懂。'];
    $rows = [];
    foreach ($res as $it) {
        if (!is_array($it)) continue;
        $rows[] = [
            'uid' => (int)($it['id'] ?? 0),
            'seen' => ((int)($it['is_read'] ?? 0)) === 1,
            'date' => henna_date_string($it['created_at'] ?? 0),
            'subject' => (string)($it['subject'] ?? ''),
            'from_name' => (string)($it['from_name'] ?? ''),
            'from_addr' => (string)($it['from_addr'] ?? ''),
            'to' => (string)($it['to_addr'] ?? ''),
            'snippet' => (string)($it['snippet'] ?? ''),
            'size' => (int)($it['size'] ?? 0),
        ];
    }
    return ['rows' => $rows, 'total' => count($rows)];
}

// 取一封 Henna 邮件的全文。成功返回
// ['from','from_name','to','subject','date','text','html','attachments']，
// attachments 每项是 ['id','filename','ctype','size']；失败返回 ['error' => ...]。
// 注意：Henna 取全文时服务端自动把这封标成已读。
function henna_fetch_message(string $panel, string $token, int $id): array {
    if ($id <= 0) return ['error' => '邮件不存在。'];
    $res = henna_api($panel, $token, 'GET', '/message/' . $id);
    if (is_array($res) && isset($res['error'])) return ['error' => (string)$res['error']];
    if (!is_array($res)) return ['error' => 'Henna 返回的邮件看不懂。'];
    $atts = [];
    foreach ((array)($res['attachments'] ?? []) as $a) {
        if (!is_array($a)) continue;
        $atts[] = [
            'id' => (int)($a['id'] ?? 0),
            'filename' => (string)($a['name'] ?? 'attachment'),
            'ctype' => (string)($a['mime'] ?? 'application/octet-stream'),
            'size' => (int)($a['size'] ?? 0),
        ];
    }
    return [
        'from' => (string)($res['from_addr'] ?? ''),
        'from_name' => (string)($res['from_name'] ?? ''),
        'to' => (string)($res['to_addr'] ?? ''),
        'subject' => (string)($res['subject'] ?? ''),
        'date' => henna_date_string($res['created_at'] ?? 0),
        'text' => (string)($res['text_body'] ?? ''),
        'html' => (string)($res['html_body'] ?? ''),
        'attachments' => $atts,
    ];
}

// 标已读（尽力而为，失败不报错；取全文时服务端本来就会标已读）。
function henna_mark_read(string $panel, string $token, int $id): bool {
    if ($id <= 0) return false;
    $res = henna_api($panel, $token, 'POST', '/message/' . $id . '/read', []);
    return is_array($res) && !isset($res['error']);
}

// 彻底删除一封 Henna 邮件（Henna 没有已删除，删了找不回来）。
// 返回 [true/false, '人话原因']。
function henna_delete(string $panel, string $token, int $id): array {
    if ($id <= 0) return [false, '邮件不存在。'];
    $res = henna_api($panel, $token, 'DELETE', '/message/' . $id);
    if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
    return [true, ''];
}

// 附件下载：从 Henna 的 R2 流式取回。成功返回 ['ctype'=>..., 'body'=>...]，
// 失败返回 ['error' => ...]。
function henna_download(string $panel, string $token, int $att_id): array {
    if ($att_id <= 0) return ['error' => '附件不存在。'];
    $r = henna_http($panel, $token, 'GET', '/message/attachment/' . $att_id);
    if (isset($r['error'])) return ['error' => $r['error']];
    if ($r['status'] === 404) return ['error' => '附件不存在或已过期。'];
    if ($r['status'] !== 200) return ['error' => 'Henna 返回 HTTP ' . $r['status'] . '，附件下不下来。'];
    $ctype = (string)($r['ctype'] ?? '');
    if ($ctype === '') $ctype = 'application/octet-stream';
    return ['ctype' => $ctype, 'body' => (string)$r['raw']];
}

// 经 Henna 发信（纯文本）。$to 里是收件人，抄送请调用方先并进 $to
// （Henna 的 /send 没有抄送字段）。
// 一个收件人走 /send，多个走 /send/bulk。返回 [true/false, '人话原因/渠道']。
function henna_send(string $panel, string $token, string $from, array $to, string $subject, string $text): array {
    $to = array_values(array_unique(array_filter(array_map('trim', $to), static function ($a) { return filter_var($a, FILTER_VALIDATE_EMAIL) !== false; })));
    if ($from === '' || empty($to)) return [false, '发件人或收件人没填对。'];
    $payload = ['from' => $from, 'to' => $to, 'subject' => $subject, 'text' => $text];
    if (count($to) === 1) {
        $res = henna_api($panel, $token, 'POST', '/send', $payload);
        if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
        if (!is_array($res) || empty($res['success'])) {
            $e = is_array($res) ? trim((string)($res['error'] ?? '')) : '';
            return [false, $e !== '' ? $e : 'Henna 那边没发出去，也没说原因。'];
        }
        return [true, (string)($res['provider'] ?? '')];
    }
    $res = henna_api($panel, $token, 'POST', '/send/bulk', $payload);
    if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
    if (!is_array($res)) return [false, 'Henna 批量发送返回了看不懂的内容。'];
    $failed = (int)($res['failed'] ?? 0);
    $okn = (int)($res['success'] ?? 0);
    $total = (int)($res['total'] ?? count($to));
    if ($failed > 0) return [false, '群发只成功了 ' . $okn . '/' . $total . ' 封。'];
    return [true, '批量 ' . $okn . '/' . $total . ' 成功'];
}
