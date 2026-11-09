<?php
declare(strict_types=1);
// imap.php —— 纯 PHP 收发信库（无 php-imap 扩展、无 Composer、无 HTML、无 session）
// 由 index.php 用 require_once 引入；index.php 已定义 e() 与 decrypt_cred() 等。
// 约定：凭据既可以是明文密码 / 授权码，也可以是 decrypt_cred() 存的那种
// 加密串（sodium: / openssl: 开头），后一种情况用站点登录时存的密钥解开。
// 错误信息一律用中文，绝不带凭据，也不回显 base64 后的凭据。

// ---------- 内部小工具 ----------

// IMAP 引用字符串转义：反斜杠和双引号前面加反斜杠。
function mail_imap_quote(string $s): string {
    return str_replace(['\\', '"'], ['\\\\', '\\"'], $s);
}

// IMAP 文件夹名走 modified UTF-7（RFC 3501）：ASCII 原样，& 写成 &-，
// 非 ASCII 按 UTF-16BE 做 base64（字母表里 / 换成 ,），前后加 & 和 -。
// 有的中文邮箱在 LIST 里直接返回 UTF-8 中文名，SELECT 时再原样发过去服务器不认，
// 所以收下来先统一解成 UTF-8、发的时候再编回 UTF-7；编解码失败就原样返回，宁可错也别丢字符。
function mail_imap_utf7_encode(string $s): string {
    $out = '';
    $n = strlen($s);
    $i = 0;
    while ($i < $n) {
        $o = ord($s[$i]);
        if ($o < 0x80) {
            $out .= ($s[$i] === '&') ? '&-' : $s[$i];
            $i++;
            continue;
        }
        $j = $i;
        $chars = '';
        while ($j < $n && ord($s[$j]) >= 0x80) {
            $b = ord($s[$j]);
            $l = 1;
            if (($b & 0xE0) === 0xC0) $l = 2;
            elseif (($b & 0xF0) === 0xE0) $l = 3;
            elseif (($b & 0xF8) === 0xF0) $l = 4;
            if ($j + $l > $n) $l = $n - $j;
            $chars .= substr($s, $j, $l);
            $j += $l;
        }
        $utf16 = false;
        if (function_exists('mb_convert_encoding')) {
            $utf16 = @mb_convert_encoding($chars, 'UTF-16BE', 'UTF-8');
        }
        if ($utf16 === false && function_exists('iconv')) {
            $utf16 = @iconv('UTF-8', 'UTF-16BE//IGNORE', $chars);
        }
        if (!is_string($utf16) || $utf16 === '') {
            $out .= $chars;
            $i = $j;
            continue;
        }
        $out .= '&' . strtr(rtrim(base64_encode($utf16), '='), '/', ',') . '-';
        $i = $j;
    }
    return $out;
}

function mail_imap_utf7_decode(string $s): string {
    if (strpos($s, '&') === false) {
        return $s;
    }
    $out = preg_replace_callback('/&([A-Za-z0-9+,]+)-/', static function (array $m): string {
        $b64 = strtr($m[1], ',', '/');
        $pad = strlen($b64) % 4;
        if ($pad > 0) {
            $b64 .= str_repeat('=', 4 - $pad);
        }
        $bin = base64_decode($b64, true);
        if ($bin === false || $bin === '') {
            return $m[0];
        }
        $utf8 = false;
        if (function_exists('mb_convert_encoding')) {
            $utf8 = @mb_convert_encoding($bin, 'UTF-8', 'UTF-16BE');
        }
        if ($utf8 === false && function_exists('iconv')) {
            $utf8 = @iconv('UTF-16BE', 'UTF-8//IGNORE', $bin);
        }
        if (!is_string($utf8) || $utf8 === '') {
            return $m[0];
        }
        return $utf8;
    }, $s);
    if ($out === null) {
        $out = $s;
    }
    return str_replace('&-', '&', $out);
}

// 把凭据还原成明文：加密串就尝试解密，解不开返回空串；否则原样当明文用。
function mail_cred_plain(string $cred): string {
    if ($cred === '') {
        return '';
    }
    if ((str_starts_with($cred, 'sodium:') || str_starts_with($cred, 'openssl:'))
        && function_exists('decrypt_cred')
    ) {
        $key = (string)($_SESSION['mc_key'] ?? '');
        if ($key !== '') {
            $plain = decrypt_cred($cred, $key);
            if (is_string($plain) && $plain !== '') {
                return $plain;
            }
            return '';
        }
    }
    return $cred;
}

// 带引号字符串的反转义：反斜杠加字符还原成该字符本身。
function mail_unescape_quoted(string $s): string {
    $out = '';
    $n = strlen($s);
    for ($i = 0; $i < $n; $i++) {
        if ($s[$i] === '\\' && $i + 1 < $n) {
            $i++;
            $out .= $s[$i];
        } else {
            $out .= $s[$i];
        }
    }
    return $out;
}

// 把字节串按指定字符集转成 UTF-8；转不了就原样返回，绝不抛错。
function mail_convert_utf8(string $data, string $charset): string {
    $cs = strtolower(trim($charset));
    if ($cs === '' || $cs === 'utf-8' || $cs === 'utf8' || $cs === 'us-ascii' || $cs === 'ascii') {
        return $data;
    }
    if (function_exists('mb_convert_encoding')) {
        try {
            $r = @mb_convert_encoding($data, 'UTF-8', $charset);
            if (is_string($r)) {
                return $r;
            }
        } catch (Throwable $e) {
            // 字符集名非法等，转下面的 iconv，再不行就原样返回。
        }
    }
    if (function_exists('iconv')) {
        $r = @iconv($charset, 'UTF-8//IGNORE', $data);
        if (is_string($r)) {
            return $r;
        }
    }
    return $data;
}

// 非 ASCII 文本包成一个 RFC2047 编码词；纯 ASCII 原样返回。
function mail_rfc2047_encode(string $s): string {
    if ($s === '' || preg_match('/[^\x20-\x7E]/', $s) !== 1) {
        return $s;
    }
    return '=?UTF-8?B?' . base64_encode($s) . '?=';
}

// ---------- ENVELOPE 的括号表达式解析器 ----------

function mail_env_skip(string $s, int &$i): void {
    $n = strlen($s);
    while ($i < $n && ($s[$i] === ' ' || $s[$i] === "\t" || $s[$i] === "\r" || $s[$i] === "\n")) {
        $i++;
    }
}

// 解析一个值：括号列表、带反斜杠转义的引用字符串、NIL（返回 null）、其它原子。
function mail_env_parse_value(string $s, int &$i): mixed {
    mail_env_skip($s, $i);
    $n = strlen($s);
    if ($i >= $n) {
        return null;
    }
    $c = $s[$i];
    if ($c === '(') {
        $i++;
        $list = [];
        while (true) {
            mail_env_skip($s, $i);
            if ($i >= $n) {
                break;
            }
            if ($s[$i] === ')') {
                $i++;
                break;
            }
            $list[] = mail_env_parse_value($s, $i);
        }
        return $list;
    }
    if ($c === '"') {
        $i++;
        $out = '';
        while ($i < $n) {
            $ch = $s[$i];
            if ($ch === '\\' && $i + 1 < $n) {
                $i++;
                $out .= $s[$i];
                $i++;
                continue;
            }
            if ($ch === '"') {
                $i++;
                break;
            }
            $out .= $ch;
            $i++;
        }
        return $out;
    }
    if ($c === '{') {
        // IMAP 字面量：{N} 后面一个换行，然后是 N 字节原文。中文主题、中文发件人名都走这里；
        // 不处理的话，主题就会显示成 "{69}" 这种字面量标记，后面的解析还会全错位。
        if (preg_match('/\{(\d+)\+?\}/A', $s, $m, 0, $i)) {
            $lit = (int)$m[1];
            $i += strlen($m[0]);
            if ($i < $n && $s[$i] === "\r") {
                $i++;
            }
            if ($i < $n && $s[$i] === "\n") {
                $i++;
            }
            $val = substr($s, $i, $lit);
            $i += strlen($val);
            return $val;
        }
    }
    $start = $i;
    while ($i < $n && $s[$i] !== ' ' && $s[$i] !== "\t" && $s[$i] !== "\r" && $s[$i] !== "\n" && $s[$i] !== '(' && $s[$i] !== ')') {
        $i++;
    }
    $atom = substr($s, $start, $i - $start);
    if (strcasecmp($atom, 'NIL') === 0) {
        return null;
    }
    return $atom;
}

// ---------- MIME 解析的内部小工具 ----------

// 解析 Content-Type / Content-Disposition 里分号后面的参数，键小写，值去引号并解转义。
function mail_mime_params(string $value): array {
    $out = [];
    if (preg_match_all('/;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\s]+))/', $value, $mm, PREG_SET_ORDER)) {
        foreach ($mm as $one) {
            $k = strtolower($one[1]);
            if (($one[2] ?? '') !== '') {
                $out[$k] = mail_unescape_quoted($one[2]);
            } elseif (($one[3] ?? '') !== '') {
                $out[$k] = $one[3];
            } else {
                $out[$k] = '';
            }
        }
    }
    return $out;
}

// 解析邮件头：折行（下一行以空格或 Tab 开头）拼回上一行，键小写，重复头只留第一个。
function mail_parse_headers(string $raw): array {
    $headers = [];
    $last = '';
    $lines = preg_split("/\r\n|\n|\r/", $raw);
    if ($lines === false) {
        return $headers;
    }
    foreach ($lines as $line) {
        if ($line === '') {
            continue;
        }
        if (($line[0] === ' ' || $line[0] === "\t") && $last !== '') {
            $headers[$last] .= ' ' . trim($line);
            continue;
        }
        $pos = strpos($line, ':');
        if ($pos === false) {
            continue;
        }
        $key = strtolower(trim(substr($line, 0, $pos)));
        $val = trim(substr($line, $pos + 1));
        if ($key === '') {
            continue;
        }
        if (!isset($headers[$key])) {
            $headers[$key] = $val;
            $last = $key;
        }
    }
    return $headers;
}

// 在第一个空行处切分邮件头和正文，返回 [头, 正文]。
function mail_mime_split_headers_body(string $raw): array {
    $p1 = strpos($raw, "\r\n\r\n");
    $p2 = strpos($raw, "\n\n");
    if ($p1 !== false && ($p2 === false || $p1 < $p2)) {
        return [substr($raw, 0, $p1), substr($raw, $p1 + 4)];
    }
    if ($p2 !== false) {
        return [substr($raw, 0, $p2), substr($raw, $p2 + 2)];
    }
    return [$raw, ''];
}

// ---------- SMTP 的内部小工具 ----------

// 读一条 SMTP 回复，支持多行回复（状态码后面跟 - 表示还有下一行，跟空格表示结束）。
function mail_smtp_read($fp): string {
    $out = '';
    $guard = 0;
    while ($guard++ < 20) {
        $line = @fgets($fp, 4096);
        if ($line === false) {
            break;
        }
        $out .= $line;
        if (strlen($line) >= 4 && $line[3] === ' ') {
            break;
        }
        if (strlen($line) < 4) {
            break;
        }
    }
    return $out;
}

// 发一条 SMTP 命令并读回复，返回是否在预期状态码内、原始回复、状态码。
function mail_smtp_send_cmd($fp, string $cmd, array $expect): array {
    $w = @fwrite($fp, $cmd . "\r\n");
    if ($w === false) {
        return ['ok' => false, 'reply' => '', 'code' => ''];
    }
    $reply = mail_smtp_read($fp);
    $code = substr($reply, 0, 3);
    return ['ok' => in_array($code, $expect, true), 'reply' => $reply, 'code' => $code];
}

// ---------- IMAP 连接与命令 ----------

// 连接 IMAP 并登录。ssl 直连 ssl://host:port；tls 先明文连，再 STARTTLS + 加密。
// 成功返回 ok、fp、err、caps，失败关闭连接，错误里绝无凭据。
function mail_imap_connect(array $mb, string $cred, string $oauth_token = ''): array {
    $host = trim((string)($mb['imap_host'] ?? ''));
    $port = (int)($mb['imap_port'] ?? 993);
    $enc = strtolower(trim((string)($mb['imap_enc'] ?? 'ssl')));
    $user = trim((string)($mb['email'] ?? ''));
    $is_oauth = $oauth_token !== '';
    $pass = $is_oauth ? '' : mail_cred_plain($cred);
    if ($host === '' || $port <= 0 || $user === '' || (!$is_oauth && $pass === '')) {
        return ['ok' => false, 'fp' => null, 'err' => 'IMAP 服务器、端口、邮箱或凭据没填对。', 'caps' => ''];
    }
    if ($enc !== 'ssl' && $enc !== 'tls') {
        $enc = 'ssl';
    }
    $errno = 0;
    $errstr = '';
    if ($enc === 'ssl') {
        $fp = @fsockopen('ssl://' . $host, $port, $errno, $errstr, 15);
    } else {
        $fp = @fsockopen($host, $port, $errno, $errstr, 15);
    }
    if ($fp === false || !is_resource($fp)) {
        return ['ok' => false, 'fp' => null, 'err' => '连不上 ' . $host . ':' . $port . '，先检查服务器地址和端口。', 'caps' => ''];
    }
    @stream_set_timeout($fp, 20);
    $greet = @fgets($fp, 4096);
    if ($greet === false || (stripos($greet, '* OK') !== 0 && stripos($greet, '* PREAUTH') !== 0)) {
        @fclose($fp);
        return ['ok' => false, 'fp' => null, 'err' => '服务器没有回应，可能是端口不对或服务暂忙，稍后再试。', 'caps' => ''];
    }
    if ($enc === 'tls') {
        $r = mail_imap_cmd($fp, 'a001', 'STARTTLS');
        if (!$r['ok']) {
            @fclose($fp);
            return ['ok' => false, 'fp' => null, 'err' => 'STARTTLS 失败，服务器不支持 STARTTLS，或端口不对（STARTTLS 一般用 143）。', 'caps' => ''];
        }
        $method = defined('STREAM_CRYPTO_METHOD_TLS_CLIENT') ? STREAM_CRYPTO_METHOD_TLS_CLIENT : STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT;
        $crypto = @stream_socket_enable_crypto($fp, true, $method);
        if (!$crypto) {
            @fclose($fp);
            return ['ok' => false, 'fp' => null, 'err' => 'STARTTLS 加密握手失败。', 'caps' => ''];
        }
    }
    $cap = mail_imap_cmd($fp, 'a002', 'CAPABILITY');
    $caps = '';
    foreach ($cap['lines'] as $ln) {
        if (stripos($ln, '* CAPABILITY') === 0) {
            $caps .= trim(substr($ln, strlen('* CAPABILITY'))) . ' ';
        }
    }
    $caps = trim($caps);
    if ($is_oauth) {
        // 微软登录的邮箱：用 XOAUTH2 认证，不用密码
        if (!mail_imap_auth_xoauth2($fp, $user, $oauth_token)) {
            @fwrite($fp, "a004 LOGOUT\r\n");
            @fclose($fp);
            return ['ok' => false, 'fp' => null, 'err' => '微软登录失败：令牌可能过期了，请到邮箱管理删掉这个邮箱，重新用微软账号登录添加。', 'caps' => $caps];
        }
        return ['ok' => true, 'fp' => $fp, 'err' => '', 'caps' => $caps];
    }
    $login = mail_imap_cmd($fp, 'a003', 'LOGIN "' . mail_imap_quote($user) . '" "' . mail_imap_quote($pass) . '"');
    if (!$login['ok']) {
        @fwrite($fp, "a004 LOGOUT\r\n");
        @fclose($fp);
        return ['ok' => false, 'fp' => null, 'err' => '登录失败：账号或凭据不对，或服务没开。QQ 请用授权码，Gmail 请用应用专用密码；Outlook 请用微软账号登录添加。', 'caps' => $caps];
    }
    // 网易 163/126/yeah/188（Coremail）要求客户端登录后用 IMAP ID 自报身份
    // （RFC 2971），否则 SELECT 会被拒 “Unsafe Login”。
    // 现象正好对上：不发 ID 时 LIST 能通、连接测试也显示成功，但每次 SELECT
    // 都失败。Outlook、Foxmail、网易邮箱大师都会自动发 ID，手写代码不发就中招。
    // 其他厂商不支持 ID 也无妨，失败直接忽略，不影响登录。
    mail_imap_cmd($fp, 'a005', 'ID ("name" "MangguoMail" "version" "4.27.17" "vendor" "Mangguo" "support-url" "https://mangguo.lele.pp.ua/")');
    return ['ok' => true, 'fp' => $fp, 'err' => '', 'caps' => $caps];
}

// 微软登录用的 XOAUTH2 认证：发 AUTHENTICATE XOAUTH2 + 认证串，
// 服务器回 + 号要空行时发一个空行再读，只在回 OK 时返回 true。
function mail_imap_auth_xoauth2($fp, string $email, string $access_token): bool {
    if (!is_resource($fp)) {
        return false;
    }
    if (function_exists('ms_token_blob')) {
        $blob = ms_token_blob($email, $access_token);
    } else {
        $blob = base64_encode('user=' . $email . "\x01" . 'auth=Bearer ' . $access_token . "\x01\x01");
    }
    @stream_set_timeout($fp, 20);
    $w = @fwrite($fp, 'aXOA AUTHENTICATE XOAUTH2 ' . $blob . "\r\n");
    if ($w === false) {
        return false;
    }
    $guard = 0;
    while ($guard++ < 100) {
        $line = @fgets($fp, 65536);
        if ($line === false) {
            return false;
        }
        $trimmed = rtrim($line, "\r\n");
        if (str_starts_with($trimmed, '+')) {
            // 服务器要一个空行继续
            @fwrite($fp, "\r\n");
            continue;
        }
        if (str_starts_with($trimmed, 'aXOA ')) {
            return stripos($trimmed, 'aXOA OK') === 0;
        }
    }
    return false;
}

// 微软登录的邮箱走这个连 IMAP：和 mail_imap_connect 同一条连接代码，
// 只是用 XOAUTH2 认证，不用密码 LOGIN。
function mail_connect_oauth(array $mb, string $email, string $access_token): array {
    $mb['email'] = $email;
    return mail_imap_connect($mb, '', $access_token);
}

// 发一条 IMAP 命令，读到以指定标签开头的带标签行才停。
// 能处理字面量：行尾花括号数字表示接下来恰好那么多字节是字面量数据。
function mail_imap_cmd($fp, string $tag, string $cmd): array {
    if (!is_resource($fp)) {
        return ['ok' => false, 'lines' => [], 'text' => ''];
    }
    @stream_set_timeout($fp, 20);
    $w = @fwrite($fp, $tag . ' ' . $cmd . "\r\n");
    if ($w === false) {
        return ['ok' => false, 'lines' => [], 'text' => ''];
    }
    $lines = [];
    $tagged = '';
    $guard = 0;
    while ($guard++ < 10000) {
        $line = @fgets($fp, 65536);
        if ($line === false) {
            break;
        }
        $trimmed = rtrim($line, "\r\n");
        $lines[] = $trimmed;
        if (preg_match('/\{(\d+)\+?\}$/', $trimmed, $m)) {
            $n = (int)$m[1];
            $data = '';
            $left = $n;
            while ($left > 0) {
                $chunk = @fread($fp, $left);
                if ($chunk === false || $chunk === '') {
                    break;
                }
                $data .= $chunk;
                $left -= strlen($chunk);
            }
            $lines[] = $data;
            $rest = @fgets($fp, 65536);
            if ($rest !== false) {
                $restTrim = rtrim($rest, "\r\n");
                if ($restTrim !== '') {
                    $lines[] = $restTrim;
                }
                if (str_starts_with($restTrim, $tag . ' ')) {
                    $tagged = $restTrim;
                    break;
                }
            }
        }
        if (str_starts_with($trimmed, $tag . ' ')) {
            $tagged = $trimmed;
            break;
        }
    }
    $ok = $tagged !== '' && stripos($tagged, $tag . ' OK') === 0;
    $text = $tagged !== '' ? trim(substr($tagged, strlen($tag) + 1)) : '';
    return ['ok' => $ok, 'lines' => $lines, 'text' => $text];
}

// 从一行 LIST 响应里取出文件夹名：
// * LIST (attrs) "delim" "name"  或  * LIST (attrs) "delim" name  或  * LIST (attrs) NIL "name"
// 文件夹名可能是带引号的字符串，也可能是不带引号的 atom（如 INBOX）；
// 分隔符本身也是带引号的，所以不能简单取“最后一个带引号的串”——名字没引号时那会取到分隔符。
function mail_imap_list_name(string $line): string {
    $rest = trim((string)preg_replace('/^\* LIST\s+/i', '', $line));
    // 跳过属性 (...)
    if (str_starts_with($rest, '(')) {
        $close = strpos($rest, ')');
        if ($close === false) return '';
        $rest = trim(substr($rest, $close + 1));
    }
    // 跳过分隔符：带引号的单个字符 或 NIL
    if (str_starts_with($rest, '"')) {
        $end = strpos($rest, '"', 1);
        if ($end === false) return '';
        $rest = trim(substr($rest, $end + 1));
    } elseif (strncasecmp($rest, 'NIL', 3) === 0) {
        $rest = trim(substr($rest, 3));
    }
    if ($rest === '') return '';
    // 剩下的就是文件夹名：带引号就去引号，不带引号就原样（atom，名字里不会有空白）
    if (str_starts_with($rest, '"')) {
        if (preg_match('/^"((?:[^"\\\\]|\\\\.)*)"/', $rest, $m)) {
            return mail_unescape_quoted($m[1]);
        }
        return '';
    }
    $parts = preg_split('/\s+/', $rest);
    return ($parts !== false && !empty($parts)) ? (string)$parts[0] : '';
}

// LIST：逐行解析星号 LIST，返回每行的文件夹名和属性。
function mail_imap_list($fp): array {
    $r = mail_imap_cmd($fp, 'aLIST', 'LIST "" "*"');
    if (!$r['ok']) {
        return [];
    }
    $out = [];
    $lines = $r['lines'];
    $n = count($lines);
    for ($i = 0; $i < $n; $i++) {
        $line = (string)$lines[$i];
        if (stripos($line, '* LIST') !== 0) {
            continue;
        }
        $attrs = '';
        if (preg_match('/\(([^)]*)\)/', $line, $am)) {
            $attrs = trim($am[1]);
        }
        $name = '';
        // 名字以 {N} 字面量形式发过来：名字在下一行（有的服务器中文名直接发 UTF-8 字面量）
        if (preg_match('/\{(\d+)\+?\}$/', trim($line))) {
            $name = isset($lines[$i + 1]) ? trim((string)$lines[$i + 1]) : '';
            $i++;
        } else {
            $name = mail_imap_list_name($line);
        }
        if ($name === '') {
            continue;
        }
        $out[] = ['name' => $name, 'attrs' => $attrs];
    }
    return $out;
}

// 把文件夹列表映射成 inbox / sent / drafts / spam / trash 五个标签，只返回真实存在的。
function mail_folder_map(array $folders): array {
    $labels = [
        'inbox' => '\Inbox',
        'sent' => '\Sent',
        'drafts' => '\Drafts',
        'spam' => '\Junk',
        'trash' => '\Trash',
    ];
    $result = [];
    foreach ($folders as $f) {
        // LIST 回来的名字可能是 modified UTF-7，先解成 UTF-8 再比对；\Noselect 的文件夹打不开，不参与映射
        $name = mail_imap_utf7_decode((string)($f['name'] ?? ''));
        $attrs = (string)($f['attrs'] ?? '');
        if ($name === '' || stripos($attrs, '\Noselect') !== false) {
            continue;
        }
        foreach ($labels as $label => $attr) {
            if (!isset($result[$label]) && stripos($attrs, $attr) !== false) {
                $result[$label] = $name;
            }
        }
    }
    $names = [
        'inbox' => ['inbox'],
        'sent' => ['sent', 'sent items', 'sent messages', 'sent mail', '已发送', '发件箱', '寄件备存'],
        'drafts' => ['drafts', 'draft', '草稿', '草稿箱'],
        'spam' => ['junk', 'junk e-mail', 'junk email', 'spam', '垃圾邮件'],
        'trash' => ['trash', 'deleted', 'deleted items', 'deleted messages', '已删除', '已删除邮件', '垃圾箱'],
    ];
    foreach ($folders as $f) {
        $name = mail_imap_utf7_decode((string)($f['name'] ?? ''));
        if ($name === '') {
            continue;
        }
        $parts = preg_split('/[\/\.]/', $name);
        $base = $parts === false ? $name : (string)end($parts);
        $low = function_exists('mb_strtolower') ? mb_strtolower(trim($base)) : strtolower(trim($base));
        $fullLow = function_exists('mb_strtolower') ? mb_strtolower(trim($name)) : strtolower(trim($name));
        foreach ($names as $label => $cands) {
            if (isset($result[$label])) {
                continue;
            }
            if (in_array($low, $cands, true) || in_array($fullLow, $cands, true)) {
                $result[$label] = $name;
            }
        }
    }
    $ordered = [];
    foreach (['inbox', 'sent', 'drafts', 'spam', 'trash'] as $label) {
        if (isset($result[$label])) {
            $ordered[$label] = $result[$label];
        }
    }
    return $ordered;
}

// SELECT 文件夹，返回是否成功、文件夹里邮件数和服务器的原话（失败时带回，方便定位）。
function mail_imap_select($fp, string $folder): array {
    // 文件夹名发的时候要编成 modified UTF-7；服务器要是只认原样返回的名字，再用原名重试一次
    $wire = mail_imap_utf7_encode($folder);
    $r = mail_imap_cmd($fp, 'aSEL', 'SELECT "' . mail_imap_quote($wire) . '"');
    if (!$r['ok'] && $wire !== $folder) {
        $r = mail_imap_cmd($fp, 'aSEL', 'SELECT "' . mail_imap_quote($folder) . '"');
    }
    if (!$r['ok'] && preg_match('/^[A-Za-z0-9._-]+$/', $folder)) {
        // 有的服务器只认不带引号的文件夹名（比如 INBOX），再试一次不带引号的
        $r = mail_imap_cmd($fp, 'aSEL', 'SELECT ' . $folder);
    }
    $exists = 0;
    foreach ($r['lines'] as $line) {
        if (preg_match('/^\* (\d+) EXISTS/', $line, $m)) {
            $exists = (int)$m[1];
            break;
        }
    }
    return ['ok' => $r['ok'], 'exists' => $exists, 'err' => (string)($r['text'] ?? '')];
}

// 一个文件夹标签的候选名字：先是 LIST 映射到的名字，再是这个标签的常用名，
// 按发到服务器上的形式去重（已发送和 &XfJT0ZAB- 是同一个名字，别试两遍）。
// 不同厂商的已发送 / 草稿箱 / 垃圾箱名字不一样（Sent、已发送、INBOX.Sent、INBOX/已发送……），
// 只认映射到的那一个名字，换个厂商就打不开。
function mail_folder_candidates(string $label, array $map): array {
    $cands = [];
    if (isset($map[$label]) && (string)$map[$label] !== '') {
        $cands[] = (string)$map[$label];
    }
    $std = [
        'inbox' => ['INBOX'],
        'sent' => ['Sent', '已发送', 'INBOX.Sent', 'INBOX/已发送', 'INBOX/Sent', '发件箱', '寄件备存', 'Sent Items', 'Sent Messages', 'Sent Mail'],
        'drafts' => ['Drafts', '草稿箱', '草稿', 'INBOX.Drafts', 'INBOX/草稿箱'],
        'spam' => ['Junk', '垃圾邮件', 'Spam', 'INBOX.Junk', 'INBOX/垃圾邮件'],
        'trash' => ['Trash', '已删除', '已删除邮件', '垃圾箱', 'Deleted Items', 'Deleted Messages', 'INBOX.Trash', 'INBOX/已删除'],
    ];
    foreach (($std[$label] ?? []) as $c) {
        $cands[] = $c;
    }
    $seen = [];
    $out = [];
    foreach ($cands as $c) {
        $wire = mail_imap_utf7_encode($c);
        if (isset($seen[$wire])) continue;
        $seen[$wire] = true;
        $out[] = $c;
    }
    return $out;
}

// 按标签打开文件夹：候选名字一个一个 SELECT 直到成功。
// SELECT 失败不会断开连接，换个名字再试是安全的。
// 返回 ['ok'=>bool, 'name'=>成功的名字, 'exists'=>邮件数, 'tried'=>试过的名字, 'err'=>服务器最后一次的原话]。
function mail_imap_open_folder($fp, string $label, array $map): array {
    $tried = [];
    $lastErr = '';
    foreach (mail_folder_candidates($label, $map) as $c) {
        $tried[] = $c;
        $sel = mail_imap_select($fp, $c);
        if ($sel['ok']) {
            return ['ok' => true, 'name' => $c, 'exists' => (int)($sel['exists'] ?? 0), 'tried' => $tried, 'err' => ''];
        }
        $lastErr = (string)($sel['err'] ?? '');
    }
    return ['ok' => false, 'name' => '', 'exists' => 0, 'tried' => $tried, 'err' => $lastErr];
}

// 把一封邮件移到某个标签的文件夹：目标文件夹的候选名字一个一个试，直到 MOVE 成功。
function mail_imap_move_to($fp, int $uid, string $label, array $map): array {
    $tried = [];
    foreach (mail_folder_candidates($label, $map) as $c) {
        $tried[] = $c;
        $r = mail_imap_move($fp, $uid, $c);
        if ($r['ok']) {
            return ['ok' => true, 'name' => $c, 'err' => '', 'tried' => $tried];
        }
    }
    return ['ok' => false, 'name' => '', 'err' => '移动失败：服务器拒绝了移动操作。', 'tried' => $tried];
}

// UID SEARCH ALL，返回升序的 UID 整数列表，失败返回空数组。
function mail_imap_uids($fp): array {
    $r = mail_imap_cmd($fp, 'aSRCH', 'UID SEARCH ALL');
    if (!$r['ok']) {
        return [];
    }
    $uids = [];
    foreach ($r['lines'] as $line) {
        if (stripos($line, '* SEARCH') !== 0) {
            continue;
        }
        $rest = trim(substr($line, strlen('* SEARCH')));
        if ($rest === '') {
            continue;
        }
        $toks = preg_split('/\s+/', $rest);
        if ($toks === false) {
            continue;
        }
        foreach ($toks as $tok) {
            if (ctype_digit((string)$tok)) {
                $uids[] = (int)$tok;
            }
        }
    }
    sort($uids, SORT_NUMERIC);
    return array_values(array_unique($uids));
}

// 解析一个 ENVELOPE，返回 date / subject / from / to / cc（date 和 subject 原样返回，不解码）。
function mail_parse_envelope(string $s): array {
    $empty = ['date' => '', 'subject' => '', 'from' => [], 'to' => [], 'cc' => []];
    $s = trim($s);
    if ($s === '') {
        return $empty;
    }
    $pos = stripos($s, 'ENVELOPE');
    if ($pos !== false) {
        $p = strpos($s, '(', $pos);
        if ($p !== false) {
            $s = substr($s, $p);
        }
    }
    $i = 0;
    $v = mail_env_parse_value($s, $i);
    if (!is_array($v)) {
        return $empty;
    }
    $asStr = static function ($x): string {
        return is_string($x) ? $x : '';
    };
    $asAddrs = static function ($list) use ($asStr): array {
        $out = [];
        if (!is_array($list)) {
            return $out;
        }
        foreach ($list as $a) {
            if (!is_array($a)) {
                continue;
            }
            $out[] = [
                'name' => $asStr($a[0] ?? null),
                'mailbox' => $asStr($a[2] ?? null),
                'host' => $asStr($a[3] ?? null),
            ];
        }
        return $out;
    };
    return [
        'date' => $asStr($v[0] ?? null),
        'subject' => $asStr($v[1] ?? null),
        'from' => $asAddrs($v[2] ?? null),
        'to' => $asAddrs($v[5] ?? null),
        'cc' => $asAddrs($v[6] ?? null),
    ];
}

// 批量取邮件列表：最多 40 个 UID，每个 UID 单独取 UID、已读标记和 ENVELOPE，主题和发件人名在这里解码。
function mail_imap_fetch_list($fp, array $uids): array {
    $out = [];
    $uids = array_slice($uids, 0, 40);
    foreach ($uids as $uid) {
        $uid = (int)$uid;
        if ($uid <= 0) {
            continue;
        }
        $r = mail_imap_cmd($fp, 'aFETCH', 'UID FETCH ' . $uid . ' (UID FLAGS ENVELOPE)');
        if (!$r['ok']) {
            continue;
        }
        $blob = implode("\n", $r['lines']);
        $gotUid = $uid;
        if (preg_match('/\bUID (\d+)/', $blob, $m)) {
            $gotUid = (int)$m[1];
        }
        $seen = false;
        if (preg_match('/FLAGS \(([^)]*)\)/', $blob, $fm)) {
            $seen = stripos($fm[1], '\Seen') !== false;
        }
        $env = mail_parse_envelope($blob);
        $from = $env['from'][0] ?? ['name' => '', 'mailbox' => '', 'host' => ''];
        $fromAddr = '';
        if (($from['mailbox'] ?? '') !== '' && ($from['host'] ?? '') !== '') {
            $fromAddr = $from['mailbox'] . '@' . $from['host'];
        } elseif (($from['mailbox'] ?? '') !== '') {
            $fromAddr = (string)$from['mailbox'];
        }
        $toAddrs = [];
        foreach ($env['to'] as $a) {
            if (($a['mailbox'] ?? '') !== '' && ($a['host'] ?? '') !== '') {
                $toAddrs[] = $a['mailbox'] . '@' . $a['host'];
            } elseif (($a['mailbox'] ?? '') !== '') {
                $toAddrs[] = (string)$a['mailbox'];
            }
        }
        $out[] = [
            'uid' => $gotUid,
            'seen' => $seen,
            'date' => $env['date'],
            'subject' => mail_decode_header($env['subject']),
            'from_name' => mail_sender_display_name(mail_decode_header((string)($from['name'] ?? '')), $fromAddr),
            'from_addr' => $fromAddr,
            'to' => implode(', ', $toAddrs),
            'snippet' => '',
        ];
    }
    // 摘要一批取：原来每封一个来回，现在一组合并成一条命令
    $snips = mail_imap_fetch_snippets($fp, array_column($out, 'uid'));
    foreach ($out as &$row) {
        $row['snippet'] = $snips[(int)$row['uid']] ?? '';
    }
    unset($row);
    return $out;
}

// 取一封邮件的正文摘要：只取第一部分的头 300 字节（不标已读），解码后清理成约 80 字。
// 任何一步失败都返回空字符串，绝不让整行失败。
function mail_imap_snippet($fp, int $uid): string {
    if (!is_resource($fp) || $uid <= 0) {
        return '';
    }
    $r = mail_imap_cmd($fp, 'aSNIP', 'UID FETCH ' . $uid . ' (BODY.PEEK[1]<0.300>)');
    if (!$r['ok']) {
        return '';
    }
    $data = '';
    $lines = $r['lines'];
    $count = count($lines);
    for ($i = 0; $i < $count; $i++) {
        if (preg_match('/BODY\[1\] \{(\d+)\+?\}/', $lines[$i], $m)) {
            if (isset($lines[$i + 1])) {
                $data = (string)$lines[$i + 1];
            }
            break;
        }
        // 有的服务器把纯 ASCII 的正文（比如 base64 / quoted-printable）直接放在引号里返回，不用字面量
        if (preg_match('/BODY\[1\] "((?:\\\\.|[^"\\\\])*)"/', $lines[$i], $qm)) {
            $data = mail_unescape_quoted($qm[1]);
            break;
        }
    }
    if ($data === '') {
        return '';
    }
    return mail_clean_snippet($data);
}

// 批量取摘要：一次取一批 UID 的 BODY.PEEK[1]<0.300>，每 10 个 UID 一组；
// 哪封取不到、解析不出，摘要就是空串，绝不让整批失败。
// 回应格式和单封取法一样（mail_imap_cmd 会把字面量单独放成一行）：
// 每封以 "* 序号 FETCH (UID <uid> BODY[1] {n}" 开头，字面量在下一行。
function mail_imap_fetch_snippets($fp, array $uids): array {
    $out = [];
    if (!is_resource($fp)) {
        return $out;
    }
    $uids = array_values(array_unique(array_map('intval', $uids)));
    $uids = array_values(array_filter($uids, static fn($u) => $u > 0));
    if (empty($uids)) {
        return $out;
    }
    foreach (array_chunk($uids, 10) as $chunk) {
        $r = mail_imap_cmd($fp, 'aSNIPB', 'UID FETCH ' . implode(',', $chunk) . ' (BODY.PEEK[1]<0.300>)');
        if (!$r['ok']) {
            continue;
        }
        $lines = $r['lines'];
        $count = count($lines);
        for ($i = 0; $i < $count; $i++) {
            if (!preg_match('/^\* \d+ FETCH \(UID (\d+)/', $lines[$i], $m)) {
                continue;
            }
            $uid = (int)$m[1];
            $data = '';
            for ($j = $i; $j < $count; $j++) {
                if (preg_match('/BODY\[1\] \{(\d+)\+?\}/', $lines[$j], $bm)) {
                    if (isset($lines[$j + 1])) {
                        $data = (string)$lines[$j + 1];
                    }
                    break;
                }
                // 有的服务器把纯 ASCII 的正文（比如 base64 / quoted-printable）直接放在引号里返回，不用字面量
                if (preg_match('/BODY\[1\] "((?:\\\\.|[^"\\\\])*)"/', $lines[$j], $qm)) {
                    $data = mail_unescape_quoted($qm[1]);
                    break;
                }
                // 下一封或带标签行：这封没有 BODY[1]，不用再往下找
                if ($j > $i && (str_starts_with($lines[$j], '* ') || str_starts_with($lines[$j], 'aSNIPB '))) {
                    break;
                }
            }
            $out[$uid] = $data !== '' ? mail_clean_snippet($data) : '';
        }
    }
    return $out;
}

// 把一段原始正文开头清理成摘要：解 base64 / quoted-printable，去标签和多余空白，截 80 字。
function mail_clean_snippet(string $raw): string {
    $t = trim($raw);
    if ($t === '') {
        return '';
    }
    // base64 编码的正文：整段只含 base64 字符、长度是 4 的倍数，才解码
    $flat = (string)preg_replace('/\s+/', '', $t);
    if ($flat !== '' && strlen($flat) >= 20 && strlen($flat) % 4 === 0 && preg_match('/^[A-Za-z0-9+\/]+={0,2}$/', $flat)) {
        $dec = base64_decode($flat, true);
        if ($dec !== false && $dec !== '') {
            $t = $dec;
        }
    } elseif (strpos($t, '=') !== false && preg_match('/=[0-9A-Fa-f]{2}/', $t)) {
        $t = quoted_printable_decode($t);
    }
    // 去掉多部分邮件里漏进来的边界行和头部行
    $split = preg_split("/\r\n|\n|\r/", $t);
    $kept = [];
    foreach ((array)$split as $ln) {
        if (str_starts_with($ln, '--')) {
            continue;
        }
        if (preg_match('/^Content-(Type|Transfer-Encoding|Disposition|ID)\s*:/i', $ln)) {
            continue;
        }
        $kept[] = $ln;
    }
    $t = implode("\n", $kept);
    $t = strip_tags($t);
    $t = html_entity_decode($t, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    // 非 UTF-8（常见 GBK）先转码，否则清掉非法字节
    if (function_exists('mb_check_encoding') && !mb_check_encoding($t, 'UTF-8')) {
        if (function_exists('mb_convert_encoding')) {
            $t = (string)@mb_convert_encoding($t, 'UTF-8', 'GBK');
        }
    }
    if (function_exists('mb_convert_encoding')) {
        $t = (string)@mb_convert_encoding($t, 'UTF-8', 'UTF-8');
    }
    $t = trim((string)preg_replace('/\s+/u', ' ', $t));
    // 二进制垃圾：控制字符太多就不要
    $len = strlen($t);
    if ($len > 0) {
        $ctrl = 0;
        for ($i = 0; $i < $len; $i++) {
            $o = ord($t[$i]);
            if ($o < 9 || ($o > 13 && $o < 32)) {
                $ctrl++;
            }
        }
        if ($ctrl / $len > 0.1) {
            return '';
        }
    }
    if (function_exists('mb_substr')) {
        $t = (string)mb_substr($t, 0, 80, 'UTF-8');
    } else {
        $t = substr($t, 0, 240);
    }
    return trim($t);
}

// 取一封邮件的完整原始内容：UID FETCH uid (BODY[])，raw 是字面量里的正文。
function mail_imap_fetch_raw($fp, int $uid): array {
    $r = mail_imap_cmd($fp, 'aFRaw', 'UID FETCH ' . $uid . ' (BODY[])');
    if (!$r['ok']) {
        return ['ok' => false, 'raw' => ''];
    }
    $raw = '';
    $lines = $r['lines'];
    $count = count($lines);
    for ($i = 0; $i < $count; $i++) {
        if (preg_match('/BODY\[\] \{(\d+)\+?\}/', $lines[$i], $m)) {
            if (isset($lines[$i + 1])) {
                $raw = (string)$lines[$i + 1];
            }
            break;
        }
    }
    return ['ok' => true, 'raw' => $raw];
}

// 把一封邮件标为已读。
function mail_imap_mark_seen($fp, int $uid): bool {
    $r = mail_imap_cmd($fp, 'aSEEN', 'UID STORE ' . $uid . ' +FLAGS (\\Seen)');
    return (bool)$r['ok'];
}

// 移动邮件：服务器支持 MOVE 就用 UID MOVE，否则 UID COPY + 标已删除 + EXPUNGE。
function mail_imap_move($fp, int $uid, string $dest): array {
    $cap = mail_imap_cmd($fp, 'aCAP', 'CAPABILITY');
    $caps = '';
    foreach ($cap['lines'] as $ln) {
        $caps .= $ln . ' ';
    }
    $wire = mail_imap_utf7_encode($dest);
    $quoted = '"' . mail_imap_quote($wire) . '"';
    $rawQuoted = '"' . mail_imap_quote($dest) . '"';
    if (stripos($caps, 'MOVE') !== false) {
        $r = mail_imap_cmd($fp, 'aMOVE', 'UID MOVE ' . $uid . ' ' . $quoted);
        if (!$r['ok'] && $wire !== $dest) {
            $r = mail_imap_cmd($fp, 'aMOVE', 'UID MOVE ' . $uid . ' ' . $rawQuoted);
        }
        if ($r['ok']) {
            return ['ok' => true, 'err' => ''];
        }
        return ['ok' => false, 'err' => '移动失败：服务器拒绝了移动操作。'];
    }
    $copy = mail_imap_cmd($fp, 'aCOPY', 'UID COPY ' . $uid . ' ' . $quoted);
    if (!$copy['ok'] && $wire !== $dest) {
        $copy = mail_imap_cmd($fp, 'aCOPY', 'UID COPY ' . $uid . ' ' . $rawQuoted);
    }
    if (!$copy['ok']) {
        return ['ok' => false, 'err' => '移动失败：复制到目标文件夹被拒绝。'];
    }
    $del = mail_imap_cmd($fp, 'aDEL', 'UID STORE ' . $uid . ' +FLAGS (\\Deleted)');
    if (!$del['ok']) {
        return ['ok' => false, 'err' => '移动失败：邮件已复制，但标记删除失败。'];
    }
    $exp = mail_imap_cmd($fp, 'aEXP', 'EXPUNGE');
    if (!$exp['ok']) {
        return ['ok' => false, 'err' => '移动失败：邮件已复制并标记删除，但清理失败。'];
    }
    return ['ok' => true, 'err' => ''];
}

// 往指定文件夹追加一封邮件：APPEND，等服务器回加号再发原文。尽力而为。
function mail_imap_append($fp, string $folder, string $raw): bool {
    if (!is_resource($fp)) {
        return false;
    }
    $tag = 'aAPP';
    @stream_set_timeout($fp, 20);
    $len = strlen($raw);
    // 文件夹名先编成 modified UTF-7；服务器不认就用原样返回的名字再试一次
    $names = [mail_imap_utf7_encode($folder)];
    if ($names[0] !== $folder) {
        $names[] = $folder;
    }
    $gotPlus = false;
    foreach ($names as $nm) {
        $w = @fwrite($fp, $tag . ' APPEND "' . mail_imap_quote($nm) . '" {' . $len . "}\r\n");
        if ($w === false) {
            return false;
        }
        // 等加号；先读一行，不是加号就继续读到这条命令的 tagged 应答为止
        $cont = '';
        $guard0 = 0;
        while ($guard0++ < 20) {
            $ln = @fgets($fp, 4096);
            if ($ln === false) {
                break;
            }
            $cont = trim($ln);
            if (str_starts_with($cont, '+') || str_starts_with($cont, $tag . ' ')) {
                break;
            }
        }
        if (str_starts_with($cont, '+')) {
            $gotPlus = true;
            break;
        }
    }
    if (!$gotPlus) {
        return false;
    }
    @fwrite($fp, $raw . "\r\n");
    $guard = 0;
    while ($guard++ < 100) {
        $line = @fgets($fp, 65536);
        if ($line === false) {
            return false;
        }
        $trimmed = rtrim($line, "\r\n");
        if (str_starts_with($trimmed, $tag . ' ')) {
            return stripos($trimmed, $tag . ' OK') === 0;
        }
    }
    return false;
}

// ---------- 邮件头解码与 MIME 解析 ----------

// 解码 RFC2047 编码词：B 是 base64，Q 是 quoted-printable（下划线当空格），再按字符集转 UTF-8。
function mail_decode_header(string $s): string {
    if (strpos($s, '=?') === false) {
        return $s;
    }
    $out = preg_replace_callback('/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/', static function (array $m): string {
        $charset = $m[1];
        $enc = strtoupper($m[2]);
        $text = $m[3];
        if ($enc === 'B') {
            $decoded = base64_decode($text, true);
            if ($decoded === false) {
                return $m[0];
            }
        } else {
            $decoded = quoted_printable_decode(str_replace('_', ' ', $text));
        }
        return mail_convert_utf8($decoded, $charset);
    }, $s);
    return $out === null ? $s : $out;
}

// 发件人显示名：名字是单个英文字母（Henna 发出的信常把名字写成 "e" 这类单个字母），
// 就当它没有名字，直接显示邮箱地址，免得收件箱第一行只看到一个字母。
function mail_sender_display_name(string $name, string $addr): string {
    $name = trim($name);
    if ($name === '') {
        return $addr;
    }
    if (preg_match('/^[A-Za-z]$/', $name)) {
        return $addr;
    }
    return $name;
}

// 读信页用的完整 From 头（"名字 <地址>" 这种）：名字是单个英文字母时只留地址。
function mail_clean_from_header(string $from): string {
    $from = trim($from);
    if (preg_match('/^"?([^"<>]+)"?\s*<([^<>]+@[^<>]+)>$/u', $from, $m)) {
        $name = trim($m[1], '" ');
        if ($name === '' || preg_match('/^[A-Za-z]$/', $name)) {
            return $m[2];
        }
    }
    return $from;
}

// 解析一封 MIME 邮件：multipart 按 boundary 递归拆分；每段按编码解码，文本按字符集转 UTF-8。
// 附件：处置是 attachment，或有文件名且不是纯文本 / 网页的段。文件名先解码。
function mail_parse_mime(string $raw): array {
    [$headRaw, $body] = mail_mime_split_headers_body($raw);
    $headers = mail_parse_headers($headRaw);
    $ctypeRaw = $headers['content-type'] ?? 'text/plain';
    $ctypeParts = explode(';', $ctypeRaw, 2);
    $ctype = strtolower(trim($ctypeParts[0] ?? ''));
    if ($ctype === '') {
        $ctype = 'text/plain';
    }
    $params = mail_mime_params($ctypeRaw);
    $charset = $params['charset'] ?? 'utf-8';
    $dispRaw = $headers['content-disposition'] ?? '';
    $dispParts = explode(';', $dispRaw, 2);
    $disp = strtolower(trim($dispParts[0] ?? ''));
    $dispParams = mail_mime_params($dispRaw);
    $filename = $dispParams['filename'] ?? $params['name'] ?? '';
    if ($filename !== '') {
        $filename = mail_decode_header($filename);
    }
    if (str_starts_with($ctype, 'multipart/') && !empty($params['boundary'])) {
        $boundary = $params['boundary'];
        $text = '';
        $html = '';
        $atts = [];
        $segments = explode('--' . $boundary, $body);
        foreach ($segments as $idx => $seg) {
            if ($idx === 0) {
                continue;
            }
            $seg = ltrim($seg, "\r\n");
            if (str_starts_with(ltrim($seg), '--')) {
                continue;
            }
            if (trim($seg) === '') {
                continue;
            }
            $seg = rtrim($seg, "\r\n");
            $sub = mail_parse_mime($seg);
            if ($text === '' && $sub['text'] !== '') {
                $text = $sub['text'];
            }
            if ($html === '' && $sub['html'] !== '') {
                $html = $sub['html'];
            }
            if (!empty($sub['attachments'])) {
                $atts = array_merge($atts, $sub['attachments']);
            }
        }
        return ['headers' => $headers, 'text' => $text, 'html' => $html, 'attachments' => $atts];
    }
    $cte = strtolower(trim($headers['content-transfer-encoding'] ?? ''));
    $data = $body;
    if ($cte === 'base64') {
        $clean = preg_replace('/\s+/', '', $data);
        $d = base64_decode((string)$clean, true);
        if ($d !== false) {
            $data = $d;
        }
    } elseif ($cte === 'quoted-printable') {
        $data = quoted_printable_decode($data);
    }
    if (str_starts_with($ctype, 'text/')) {
        $data = mail_convert_utf8($data, $charset);
    }
    $isAtt = ($disp === 'attachment') || ($filename !== '' && $ctype !== 'text/plain' && $ctype !== 'text/html');
    if ($isAtt) {
        return ['headers' => $headers, 'text' => '', 'html' => '', 'attachments' => [['filename' => $filename, 'size' => strlen($data), 'ctype' => $ctype, 'data' => $data]]];
    }
    if ($ctype === 'text/plain') {
        return ['headers' => $headers, 'text' => $data, 'html' => '', 'attachments' => []];
    }
    if ($ctype === 'text/html') {
        return ['headers' => $headers, 'text' => '', 'html' => $data, 'attachments' => []];
    }
    if (str_starts_with($ctype, 'text/')) {
        return ['headers' => $headers, 'text' => $data, 'html' => '', 'attachments' => []];
    }
    return ['headers' => $headers, 'text' => '', 'html' => '', 'attachments' => []];
}

// 从解析结果里取展示用的正文：有纯文本就用纯文本，否则把网页正文转纯文本（换行标记先换成换行再去标签）。
function mail_mime_best_body(array $parsed): array {
    $text = (string)($parsed['text'] ?? '');
    $html = (string)($parsed['html'] ?? '');
    if (trim($text) !== '') {
        return ['text' => $text, 'html' => $html];
    }
    if (trim($html) === '') {
        return ['text' => '', 'html' => ''];
    }
    $t = $html;
    $t = str_ireplace(['<br>', '<br/>', '<br />', '</p>', '</div>', '</tr>', '</li>', '</h1>', '</h2>', '</h3>', '</h4>'], "\n", $t);
    $t = strip_tags($t);
    $t = html_entity_decode($t, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $t = preg_replace("/[ \t]+\n/", "\n", $t) ?? $t;
    $t = preg_replace("/\n{3,}/", "\n\n", $t) ?? $t;
    $t = trim($t);
    return ['text' => $t, 'html' => $html];
}

// ---------- SMTP 发信 ----------

// 发信：ssl 直连（一般 465），tls 先明文连，EHLO 后 STARTTLS + 加密，再 EHLO；
// AUTH LOGIN 用 base64 发账号和凭据；再 MAIL FROM、RCPT TO、DATA、QUIT。
// 信头与正文编码和 mail_build_sent_raw 完全一致。失败返回中文错误，绝不带凭据。
function mail_smtp_send(array $mb, string $cred, string $from, string $from_name, array $to, array $cc, string $subject, string $body, string $xoauth_blob = ''): array {
    $host = trim((string)($mb['smtp_host'] ?? ''));
    $port = (int)($mb['smtp_port'] ?? 587);
    $enc = strtolower(trim((string)($mb['smtp_enc'] ?? 'tls')));
    $is_oauth = $xoauth_blob !== '';
    $pass = $is_oauth ? '' : mail_cred_plain($cred);
    $to = array_values(array_filter(array_map('trim', $to), static fn($x) => $x !== ''));
    $cc = array_values(array_filter(array_map('trim', $cc), static fn($x) => $x !== ''));
    if ($host === '' || $port <= 0 || $from === '' || (!$is_oauth && $pass === '') || empty($to)) {
        return ['ok' => false, 'err' => 'SMTP 服务器、端口、发件人、凭据或收件人没填对。'];
    }
    if ($enc !== 'ssl' && $enc !== 'tls') {
        $enc = 'tls';
    }
    $errno = 0;
    $errstr = '';
    if ($enc === 'ssl') {
        $fp = @fsockopen('ssl://' . $host, $port, $errno, $errstr, 15);
    } else {
        $fp = @fsockopen($host, $port, $errno, $errstr, 15);
    }
    if ($fp === false || !is_resource($fp)) {
        return ['ok' => false, 'err' => '连不上 ' . $host . ':' . $port . '，先检查 SMTP 服务器地址和端口。'];
    }
    @stream_set_timeout($fp, 20);
    $greet = mail_smtp_read($fp);
    if (substr($greet, 0, 3) !== '220') {
        @fclose($fp);
        // 连上了但没收到 220 问候：十有八九是端口和加密方式没配对（465 要配 SSL、587 要配 STARTTLS），
        // 或者 SMTP 栏误填了 IMAP 的端口 993。报错里带上实际用的配置，方便直接核对。
        return ['ok' => false, 'err' => 'SMTP 服务器没有回应（' . $host . ':' . $port . '，' . ($enc === 'ssl' ? 'SSL' : 'STARTTLS') . '），可能是端口或加密方式不对：465 一般配 SSL，587 一般配 STARTTLS。'];
    }
    $ehlo = mail_smtp_send_cmd($fp, 'EHLO localhost', ['250']);
    if (!$ehlo['ok']) {
        @fclose($fp);
        return ['ok' => false, 'err' => 'SMTP 问候（EHLO）被服务器拒绝。'];
    }
    if ($enc === 'tls') {
        $st = mail_smtp_send_cmd($fp, 'STARTTLS', ['220']);
        if (!$st['ok']) {
            @fclose($fp);
            return ['ok' => false, 'err' => 'STARTTLS 失败，服务器不支持 STARTTLS，或端口不对（STARTTLS 一般用 587）。'];
        }
        $method = defined('STREAM_CRYPTO_METHOD_TLS_CLIENT') ? STREAM_CRYPTO_METHOD_TLS_CLIENT : STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT;
        $crypto = @stream_socket_enable_crypto($fp, true, $method);
        if (!$crypto) {
            @fclose($fp);
            return ['ok' => false, 'err' => 'STARTTLS 加密握手失败。'];
        }
        $ehlo2 = mail_smtp_send_cmd($fp, 'EHLO localhost', ['250']);
        if (!$ehlo2['ok']) {
            @fclose($fp);
            return ['ok' => false, 'err' => 'STARTTLS 之后 EHLO 被服务器拒绝。'];
        }
    }
    if ($is_oauth) {
        // 微软登录的邮箱：AUTH XOAUTH2 + 认证串，期望 235；服务器回 334 要空行时补一个空行再读
        $auth = mail_smtp_send_cmd($fp, 'AUTH XOAUTH2 ' . $xoauth_blob, ['235']);
        if (!$auth['ok']) {
            if ($auth['code'] === '334') {
                $auth2 = mail_smtp_send_cmd($fp, '', ['235']);
                if (!$auth2['ok']) {
                    @fclose($fp);
                    return ['ok' => false, 'err' => '微软登录认证失败：令牌可能过期了，请到邮箱管理删掉这个邮箱，重新用微软账号登录添加。'];
                }
            } else {
                @fclose($fp);
                return ['ok' => false, 'err' => '微软登录认证失败：令牌可能过期了，请到邮箱管理删掉这个邮箱，重新用微软账号登录添加。'];
            }
        }
    } else {
        // 有的服务器（比如 DNSHE 的 SMTP）不支持 AUTH LOGIN，只认 AUTH PLAIN；先试 LOGIN，不行再试 PLAIN
        $auth = mail_smtp_send_cmd($fp, 'AUTH LOGIN', ['334']);
        if ($auth['ok']) {
            $u = mail_smtp_send_cmd($fp, base64_encode($from), ['334']);
            if (!$u['ok']) {
                @fclose($fp);
                return ['ok' => false, 'err' => '认证失败：账号或凭据不对。'];
            }
            $p = mail_smtp_send_cmd($fp, base64_encode($pass), ['235']);
            if (!$p['ok']) {
                @fclose($fp);
                return ['ok' => false, 'err' => '认证失败：账号或凭据不对。'];
            }
        } else {
            $plain = mail_smtp_send_cmd($fp, 'AUTH PLAIN ' . base64_encode("\0" . $from . "\0" . $pass), ['235']);
            if (!$plain['ok']) {
                @fclose($fp);
                return ['ok' => false, 'err' => '服务器不支持 AUTH LOGIN 和 AUTH PLAIN，或拒绝认证。'];
            }
        }
    }
    $mf = mail_smtp_send_cmd($fp, 'MAIL FROM:<' . $from . '>', ['250']);
    if (!$mf['ok']) {
        @fclose($fp);
        return ['ok' => false, 'err' => '发件人地址被服务器拒绝。'];
    }
    foreach (array_merge($to, $cc) as $rcpt) {
        $r = mail_smtp_send_cmd($fp, 'RCPT TO:<' . $rcpt . '>', ['250', '251']);
        if (!$r['ok']) {
            @fclose($fp);
            return ['ok' => false, 'err' => '收件人 ' . $rcpt . ' 被服务器拒绝。'];
        }
    }
    $data = mail_smtp_send_cmd($fp, 'DATA', ['354']);
    if (!$data['ok']) {
        @fclose($fp);
        return ['ok' => false, 'err' => '服务器拒绝进入 DATA 阶段。'];
    }
    $raw = mail_build_sent_raw($from, $from_name, $to, $cc, $subject, $body);
    $lines = explode("\r\n", $raw);
    foreach ($lines as &$ln) {
        if (str_starts_with($ln, '.')) {
            $ln = '.' . $ln;
        }
    }
    unset($ln);
    $msg = implode("\r\n", $lines);
    @fwrite($fp, $msg);
    if (substr($msg, -2) !== "\r\n") {
        @fwrite($fp, "\r\n");
    }
    @fwrite($fp, ".\r\n");
    $reply = mail_smtp_read($fp);
    if (substr($reply, 0, 3) !== '250') {
        @fclose($fp);
        return ['ok' => false, 'err' => '发送失败：服务器没有接受这封邮件。'];
    }
    @fwrite($fp, "QUIT\r\n");
    @fclose($fp);
    return ['ok' => true, 'err' => ''];
}

// 拼一封和 mail_smtp_send 发出去完全一样的邮件（供 APPEND 到已发送用）。
// 含 Date、Message-ID；发件人名和主题含非 ASCII 时用编码词，正文是纯文本 UTF-8 + base64。
function mail_build_sent_raw(string $from, string $from_name, array $to, array $cc, string $subject, string $body): string {
    $from_name = trim($from_name);
    if ($from_name !== '') {
        $encName = mail_rfc2047_encode($from_name);
        if ($encName === $from_name && preg_match('/["<>@,;:]/', $from_name) === 1) {
            $disp = '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $from_name) . '"';
        } else {
            $disp = $encName;
        }
        $fromHdr = $disp . ' <' . $from . '>';
    } else {
        $fromHdr = $from;
    }
    $toList = array_values(array_filter(array_map('trim', $to), static fn($x) => $x !== ''));
    $ccList = array_values(array_filter(array_map('trim', $cc), static fn($x) => $x !== ''));
    $headers = [];
    $headers[] = 'From: ' . $fromHdr;
    $headers[] = 'To: ' . implode(', ', $toList);
    if (!empty($ccList)) {
        $headers[] = 'Cc: ' . implode(', ', $ccList);
    }
    $headers[] = 'Subject: ' . mail_rfc2047_encode($subject);
    $headers[] = 'Date: ' . gmdate('D, d M Y H:i:s \G\M\T');
    $at = strrchr($from, '@');
    $domain = ($at !== false && $at !== '@') ? substr($at, 1) : 'localhost';
    $headers[] = 'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . $domain . '>';
    $headers[] = 'MIME-Version: 1.0';
    $headers[] = 'Content-Type: text/plain; charset=utf-8';
    $headers[] = 'Content-Transfer-Encoding: base64';
    return implode("\r\n", $headers) . "\r\n\r\n" . chunk_split(base64_encode($body), 76, "\r\n");
}
