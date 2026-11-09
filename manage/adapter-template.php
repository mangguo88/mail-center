<?php
// ---------- 域名邮箱适配器模板（v4.30，照着抄） ----------
//
// 想加一种新的域名邮箱（比如你自己搭的面板、或者别人写的面板软件），
// 不用改 index.php：
//   1. 把这个文件复制一份，改名成 manage/<你的 kind>.php，
//      比如 kind 叫 mybox，就叫 mybox.php；
//   2. 把下面所有的 mybox_ 改成 <你的 kind>_（函数名、注释里的名字都改）；
//   3. 按每个函数上面“改这里”的注释，把 HTTP 地址、字段名改成你那个面板的；
//   4. 在 manage/adapters.php 的 $MC_API_ADAPTERS 里加一行（label、面板地址文案、
//      删信提示这几项），再在 index.php 顶部的注册表加载处确认它会被 require；
//   5. 打开添加邮箱，厂商下拉里就出现你这个 kind 了，点“测试连接”验证。
//
// 下面是一个能直接跑的完整例子：假设你的面板是这样的（照着这个形状改）：
//   登录 POST /api/auth/login {email, password} -> {ok: true, token: "..."}
//   列表 GET /api/mail?box=inbox&limit=30&offset=0
//        -> [{id, from_addr, from_name, subject, created_at, is_read, snippet}]
//   全文 GET /api/mail/<id>
//        -> {from_addr, from_name, to_addr, subject, created_at,
//            text_body, html_body, attachments: [{id, name, mime, size}]}
//   标已读 POST /api/mail/<id>/read {}
//   删除 DELETE /api/mail/<id>
//   发信 POST /api/mail/send {from, to: [], subject, text}
//   附件 GET /api/mail/attachment/<id> （直接返回文件流）
// 你的面板不是这个形状也没关系：只要这几个函数的“进出”按下面注释里的形状来，
// 函数里面怎么写都行（比如你的面板用的是 /v1/inbox 这种地址、或者信封是
// {code: 0, data: [...]}，在 xxx_http / xxx_api 里拆开就行）。
//
// 注意：
// - 所有函数失败都返回 ['error' => '人话原因']（列表/全文/附件）或者
//   [false, '人话原因']（测试/删除/发信），不要直接 die / 不要抛异常；
// - 令牌不要写文件、不要存数据库，每次现拿（mc_api_token_for 会调你的
//   <kind>_token_for；想缓存令牌也行，但别超过令牌自己的有效期）；
// - 列表行和全文的字段名必须和下面注释里写的一模一样，不然管理中心认不出来。

// 默认面板地址：公开项目，默认空着，别人部署时在添加页填自己的面板地址。
define('MYBOX_DEFAULT_PANEL', '');

// 面板地址归一化：去尾斜杠，没写协议就补 https，空的用默认面板。
// 改这里：你的面板地址有什么特殊规则（比如必须带 /v1 后缀），在这里处理。
function mybox_panel_url(string $panel): string {
    $panel = trim($panel);
    if ($panel === '') $panel = MYBOX_DEFAULT_PANEL;
    if ($panel === '') return '';
    $panel = rtrim($panel, '/');
    if (stripos($panel, 'http://') !== 0 && stripos($panel, 'https://') !== 0) $panel = 'https://' . $panel;
    return $panel;
}

// 最底层 HTTP 调用（file_get_contents + stream_context_create，不用 curl）。
// 成功返回 ['status'=>int, 'ctype'=>string, 'raw'=>string, 'json'=>array|null]；
// 连不上返回 ['error' => '人话原因']。
// 改这里：你的面板要的请求头（比如 X-Api-Key、或者 Authorization 不是 Bearer），
// 在 $headers 里改；返回的不是 JSON（比如附件就是文件流），用 $raw。
function mybox_http(string $panel, string $token, string $method, string $path, $body = null): array {
    $base = mybox_panel_url($panel);
    if ($base === '') return ['error' => '面板地址没填对。'];
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
            'timeout' => 15,
            'ignore_errors' => true,
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false) return ['error' => '连不上这个面板（' . $base . '），请检查面板地址和服务器网络，稍后再试。'];
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

// 解面板的信封：成功返回里面的数据（数组），失败返回 ['error' => '人话原因']。
// 改这里：你的面板信封不是 {ok, data}，就按它的形状改
// （比如 {code: 0, data: [...]} 就是 code !== 0 时返回 ['error' => message]）。
function mybox_api(string $panel, string $token, string $method, string $path, $body = null) {
    $r = mybox_http($panel, $token, $method, $path, $body);
    if (isset($r['error'])) return ['error' => $r['error']];
    if (($r['status'] ?? 0) === 401 || ($r['status'] ?? 0) === 403) return ['error' => '面板登录失败，请检查面板登录邮箱和密码。'];
    if (($r['status'] ?? 0) >= 400) return ['error' => '面板返回 HTTP ' . ($r['status'] ?? 0) . '。'];
    $j = $r['json'];
    if (!is_array($j)) return ['error' => '面板返回的内容看不懂。'];
    if (isset($j['error'])) return ['error' => (string)$j['error']];
    if (array_key_exists('ok', $j) && empty($j['ok'])) return ['error' => (string)($j['message'] ?? '面板那边拒绝了，也没说原因。')];
    if (array_key_exists('data', $j)) return $j['data'];
    return $j;
}

// 登录：成功返回 [true, 令牌]，失败返回 [false, '人话原因']。
// 改这里：登录地址、要传的字段名、令牌在返回里的位置。
function mybox_login(string $panel, string $email, string $password): array {
    $res = mybox_api($panel, '', 'POST', '/auth/login', ['email' => $email, 'password' => $password]);
    if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
    if (!is_array($res) || trim((string)($res['token'] ?? '')) === '') return [false, '面板登录失败，请检查面板登录邮箱和密码。'];
    return [true, (string)$res['token']];
}

// 给管理中心用的“拿令牌”：登录失败返回 ''（空字符串）。
// $mb_id 是这条邮箱记录的 id，想按邮箱缓存令牌可以用它当 key（别存文件）。
function mybox_token_for(string $panel, string $login_email, string $password, string $mb_id = ''): string {
    [$ok, $tok] = mybox_login($panel, $login_email, $password);
    return $ok ? $tok : '';
}

// 测试连接（添加邮箱时点“测试连接”调它）：[是否成功, 人话]。
// 改这里：你的面板有没有“探活”接口（比如取一下收件箱第一页）；
// 没有就调一次登录，登录成功就是通了。
function mybox_test(string $panel, string $login_email, string $password, string $address): array {
    [$ok, $tok] = mybox_login($panel, $login_email, $password);
    if (!$ok) return [false, $tok];
    $res = mybox_api($panel, $tok, 'GET', '/mail?box=inbox&limit=1&offset=0');
    if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
    return [true, '连接成功。'];
}

// 文件夹映射：管理中心的文件夹名 => 调用列表接口时要传的 box 值。
// 改这里：你的面板文件夹叫什么（比如 sent 叫 sent，还是叫 outbox）。
function mybox_folder_map(): array {
    return ['inbox' => 'inbox', 'sent' => 'sent', 'drafts' => 'draft', 'spam' => 'spam', 'trash' => 'trash'];
}

// 面板里的时间转成管理中心要的 'Y-m-d H:i'（上海时间）。
// 改这里：你的面板时间是什么格式（时间戳秒/毫秒、还是 '2026-11-09T10:00:00Z' 这种）。
function mybox_date_string($created): string {
    if (is_numeric($created)) {
        $ts = (int)$created;
        if ($ts > 1000000000000) $ts = (int)($ts / 1000); // 毫秒时间戳
        if ($ts <= 0) return '';
        return (new DateTime('@' . $ts))->setTimezone(new DateTimeZone('Asia/Shanghai'))->format('Y-m-d H:i');
    }
    $ts = strtotime((string)$created);
    if ($ts === false || $ts <= 0) return '';
    return (new DateTime('@' . $ts))->setTimezone(new DateTimeZone('Asia/Shanghai'))->format('Y-m-d H:i');
}

// 取一页邮件列表。成功返回 ['rows' => [...], 'total' => int]，失败返回 ['error' => ...]。
// rows 每一项必须是：uid/seen/date/subject/from_name/from_addr/to/snippet/size。
// 改这里：列表地址、分页参数名（limit/offset 还是 page/size、游标）、
// 每一项的字段名（发件人、主题、时间、已读标记分别叫什么）。
function mybox_fetch_list(string $panel, string $token, $account_id, string $address, string $folder, int $page, int $per = 30): array {
    $boxmap = mybox_folder_map();
    if (!isset($boxmap[$folder])) return ['rows' => [], 'total' => 0];
    if ($page < 1) $page = 1;
    if ($per < 1) $per = 30;
    if ($per > 50) $per = 50;
    $qs = http_build_query(['box' => $boxmap[$folder], 'limit' => $per, 'offset' => ($page - 1) * $per], '', '&');
    $res = mybox_api($panel, $token, 'GET', '/mail?' . $qs);
    if (is_array($res) && isset($res['error'])) return ['error' => (string)$res['error']];
    if (!is_array($res)) return ['error' => '面板返回的邮件列表看不懂。'];
    $rows = [];
    foreach ($res as $it) {
        if (!is_array($it)) continue;
        $rows[] = [
            'uid' => (int)($it['id'] ?? 0),
            'seen' => ((int)($it['is_read'] ?? 0)) === 1,
            'date' => mybox_date_string($it['created_at'] ?? 0),
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

// 取一封邮件全文。成功返回
// ['from','from_name','to','subject','date','text','html','attachments']，
// attachments 每项是 ['id','filename','ctype','size']；失败返回 ['error' => ...]。
// 改这里：全文地址、字段名（正文是 text_body 还是 body、附件列表叫什么）。
function mybox_fetch_message(string $panel, string $token, $account_id, string $folder, int $uid): array {
    if ($uid <= 0) return ['error' => '邮件不存在。'];
    $res = mybox_api($panel, $token, 'GET', '/mail/' . $uid);
    if (is_array($res) && isset($res['error'])) return ['error' => (string)$res['error']];
    if (!is_array($res)) return ['error' => '面板返回的邮件看不懂。'];
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
        'date' => mybox_date_string($res['created_at'] ?? 0),
        'text' => (string)($res['text_body'] ?? ''),
        'html' => (string)($res['html_body'] ?? ''),
        'attachments' => $atts,
    ];
}

// 标已读（尽力而为，失败不报错；有的面板取全文时服务端本来就会标已读）。
function mybox_mark_read(string $panel, string $token, $account_id, array $ids): bool {
    $id = (int)($ids[0] ?? 0);
    if ($id <= 0) return false;
    $res = mybox_api($panel, $token, 'POST', '/mail/' . $id . '/read', []);
    return is_array($res) && !isset($res['error']);
}

// 删除一封邮件。返回 [true/false, '人话原因']。
// 改这里：你的面板删信是 DELETE 还是 POST /delete；有没有垃圾箱
// （有垃圾箱就调“移到垃圾箱”的接口，没有就调彻底删除，并在注册表里
//  把 delete_ok 写成“已彻底删除。”这种提醒）。
function mybox_delete(string $panel, string $token, $account_id, array $ids): array {
    $id = (int)($ids[0] ?? 0);
    if ($id <= 0) return [false, '邮件不存在。'];
    $res = mybox_api($panel, $token, 'DELETE', '/mail/' . $id);
    if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
    return [true, ''];
}

// 附件下载。$att 是取全文时 attachments 里的那一项。
// 成功返回 ['ctype'=>..., 'body'=>...]，失败返回 ['error' => ...]。
// 改这里：附件地址（有的面板是 /mail/attachment/<id>，有的是 /oss/<key>）。
function mybox_download(string $panel, string $token, $account_id, array $att): array {
    $att_id = (int)($att['id'] ?? 0);
    if ($att_id <= 0) return ['error' => '附件不存在。'];
    $r = mybox_http($panel, $token, 'GET', '/mail/attachment/' . $att_id);
    if (isset($r['error'])) return ['error' => $r['error']];
    if ($r['status'] === 404) return ['error' => '附件不存在或已过期。'];
    if ($r['status'] !== 200) return ['error' => '面板返回 HTTP ' . $r['status'] . '，附件下不下来。'];
    $ctype = (string)($r['ctype'] ?? '');
    if ($ctype === '') $ctype = 'application/octet-stream';
    return ['ctype' => $ctype, 'body' => (string)$r['raw']];
}

// 经面板发信（纯文本）。$to 里是收件人，抄送请调用方先并进 $to
// （多数面板的发信接口没有抄送字段）。
// 返回 [true/false, '人话原因']。
// 改这里：发信地址、字段名（收件人是 to 还是 receiveEmail、是数组还是字符串）。
function mybox_send(string $panel, string $token, $account_id, string $from, array $to, string $subject, string $text): array {
    $to = array_values(array_unique(array_filter(array_map('trim', $to), static function ($a) { return filter_var($a, FILTER_VALIDATE_EMAIL) !== false; })));
    if ($from === '' || empty($to)) return [false, '发件人或收件人没填对。'];
    $res = mybox_api($panel, $token, 'POST', '/mail/send', ['from' => $from, 'to' => $to, 'subject' => $subject, 'text' => $text]);
    if (is_array($res) && isset($res['error'])) return [false, (string)$res['error']];
    return [true, ''];
}

// （可选）如果你的面板是“一个登录账号下挂多个地址”
// （比如 Cloud Mail：登录的是用户账号，地址要再拿一个数字 id），
// 再写一个 <kind>_account_id_for($panel, $token, $address)，返回 [数字 id, 错误]
// （拿不到就返回 [0, '人话原因']）。没有这个概念就不用写，分发函数会跳过。
