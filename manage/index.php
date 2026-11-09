<?php
/**
 * Mail 管理中心（单文件版）—— Serv00 + SnappyMail 配套
 * ============================================================
 * 作用：一个登录页 + 一个页面里的栏目（收件箱 / 写信 / 邮箱管理 /
 * 添加邮箱 / 设置），收信、读信、回信、转发、写信、发信都在本站完成，
 * 不用再跳去 SnappyMail。v2 起内置完整收发信（见 imap.php）。
 * SnappyMail 只留作备用入口，见设置页最下方的说明。
 *
 * 部署：把整个 manage/ 文件夹里的文件传到
 *   ~/domains/mangguo.lele.pp.ua/public_html/（网站根目录，不用再加 manage 子目录）
 * 首次打开 https://mangguo.lele.pp.ua/ 按提示设站点密码。
 *
 * 存储：无数据库、无 Composer。邮箱和站点密码哈希都存在 manage/data/ 里，
 * 文件存成 .php、开头加 exit 保护，直接从网址打开也看不到内容，
 * 凭据本身也是加密存的（见 DATA_DIR 处的注释）。
 * 凭据加密：站点密码派生密钥（sodium 优先，否则 openssl AES-256-GCM）。
 * 注意：站点密码一旦重置/忘记，存着的邮箱凭据就解不开了，必须逐个重新填；
 * QQ 授权码在改 QQ 密码后也会失效，同样要重新填一次。
 */
declare(strict_types=1);
session_start();
// 页面上永远不直接显示 PHP 警告/报错（只记日志），免得英文报错堆在页面顶部。
ini_set('display_errors', '0');
require_once __DIR__ . '/imap.php';
require_once __DIR__ . '/ms_oauth.php'; // 微软 OAuth2（Outlook / Hotmail），见 ms_oauth.php
require_once __DIR__ . '/adapters.php'; // 域名邮箱适配器注册表（v4.30），见 adapters.php / ADAPTERS.md
// 注册表里的每个适配器文件都加载进来（Henna / Cloud Mail 现在只是注册表里的两行）
foreach (mc_api_adapters() as $mc_ad) { $mc_ad_file = __DIR__ . '/' . (string)($mc_ad['file'] ?? ''); if ($mc_ad_file !== __DIR__ . '/' && is_file($mc_ad_file)) require_once $mc_ad_file; }
unset($mc_ad, $mc_ad_file);

// ---------- 可改的配置（只改这里） ----------
// 注意：Serv00 的 PHP 有 open_basedir 限制，只允许访问网站目录
// （public_html）和 /tmp，不允许访问 ~/manage-data 这种网站外的目录，
// 所以数据目录只能放在 manage/data/ 里。为防止别人直接从网址下载，
// 数据文件一律存成 .php，开头加 exit 保护，直接访问只会退出，
// 再加 .htaccess 和 index.php 两层拦截。凭据本身也是加密存的。
define('DATA_DIR', __DIR__ . '/data'); // 就在 manage/data/，由程序自动建
define('SITE_FILE', DATA_DIR . '/site.php');         // 站点密码哈希 + 显示名
define('SALT_FILE', DATA_DIR . '/salt.php');         // 派生密钥用的盐
define('MAILBOX_FILE', DATA_DIR . '/mailboxes.php'); // 邮箱列表（凭据已加密）
define('REMEMBER_FILE', DATA_DIR . '/remember.php'); // 记住我的令牌（只存哈希 + 加密后的密钥）
define('REMEMBER_DAYS', 90);                        // 记住我默认 90 天（3 个月）；可选 90 / 180 / 365
define('REMEMBER_COOKIE', 'mc_remember');           // 记住我的 Cookie 名
// 记住我可选的三档时长（天数 => 显示）
function remember_options(): array {
    return [90 => '3 个月', 180 => '6 个月', 365 => '1 年'];
}
function remember_days_valid(int $d): int {
    return isset(remember_options()[$d]) ? $d : REMEMBER_DAYS;
}
define('SNAPPY_URL', 'https://mail.lele.pp.ua/');     // SnappyMail 主站
define('ADMIN_URL', 'https://mail.lele.pp.ua/?admin');// SnappyMail 管理后台

// ---------- 小工具 ----------
function e(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }
function csrf(): string {
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
    return $_SESSION['csrf'];
}
function check_csrf(): bool {
    return isset($_POST['csrf']) && hash_equals((string)$_SESSION['csrf'], (string)$_POST['csrf']);
}
function flash(string $msg, string $kind = 'ok'): void { $_SESSION['flash'] = [$kind, $msg]; }
function take_flash(): ?array {
    $f = $_SESSION['flash'] ?? null; unset($_SESSION['flash']); return $f;
}
// 数据文件读写：前面统一加 exit 保护（运行时拼成完整的 PHP 退出标记），
// 直接从网址打开也看不到内容。注意：源码里不能出现完整的闭合标记字面量，
// 连注释里也不能写，否则 PHP 会把它当成代码结束标记而报错，
// 所以这里用 chr(60) 和 chr(62) 拼出来，源码里一个也不留。
define('DATA_GUARD', chr(60) . "?php exit; ?" . chr(62) . "\n");
function read_data_file(string $path): ?string {
    if (!@file_exists($path)) return null;
    $c = @file_get_contents($path);
    if ($c === false) return null;
    if (str_starts_with($c, DATA_GUARD)) $c = substr($c, strlen(DATA_GUARD));
    return $c;
}
function write_data_file(string $path, string $content): bool {
    return (bool)@file_put_contents($path, DATA_GUARD . $content, LOCK_EX);
}
function ensure_data_dir(): bool {
    if (!@is_dir(DATA_DIR)) { @mkdir(DATA_DIR, 0700, true); }
    if (!@is_dir(DATA_DIR) || !@is_writable(DATA_DIR)) return false;
    $ht = DATA_DIR . '/.htaccess';
    if (!@file_exists($ht)) @file_put_contents($ht, "Require all denied\nDeny from all\n");
    $ix = DATA_DIR . '/index.php';
    if (!@file_exists($ix)) @file_put_contents($ix, "<?php http_response_code(403); exit('Forbidden');\n");
    return true;
}
function load_site(): ?array {
    $c = read_data_file(SITE_FILE);
    if ($c === null) return null;
    $d = json_decode($c, true);
    return is_array($d) ? $d : null;
}
function save_site(array $d): bool {
    return write_data_file(SITE_FILE, json_encode($d, JSON_UNESCAPED_UNICODE));
}
function load_mailboxes(): array {
    $c = read_data_file(MAILBOX_FILE);
    if ($c === null) return [];
    $d = json_decode($c, true);
    return is_array($d) ? $d : [];
}
function save_mailboxes(array $list): bool {
    return write_data_file(MAILBOX_FILE, json_encode($list, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
}

// ---------- 收件箱列表缓存 ----------
// 缓存文件：data/cache_<邮箱id>_<文件夹>.php，开头同样加 exit 保护，
// 内容只有 {"ts": 取回时间, "list": [...], "total": 文件夹总封数, "folders": {...}}，
// 不含任何凭据和令牌。读 / 写失败一律静默，绝不让缓存拖垮收件箱。
// 多存 total 和 folders 两个字段，是因为列表页除了邮件行，还要文件夹 pills
// 和“共 N 封 / 下一页”——只存 list 的话，缓存页里这些全得是错的。
function mail_cache_file(string $mbid, string $folder): string {
    $id = preg_replace('/[^a-z0-9_-]/', '', strtolower($mbid));
    $fk = preg_replace('/[^a-z0-9_-]/', '', strtolower($folder));
    if ($id === '') $id = 'mb';
    if ($fk === '') $fk = 'inbox';
    return DATA_DIR . '/cache_' . $id . '_' . $fk . '.php';
}
// 缓存有效期（秒）：设置页“收件箱列表缓存（分钟）”里改，默认 1 分钟，1–60 分钟。
function mail_cache_ttl(): int {
    static $ttl = null;
    if ($ttl !== null) return $ttl;
    $site = load_site();
    $mins = (int)($site['cache_ttl'] ?? 1);
    if ($mins < 1) $mins = 1;
    if ($mins > 60) $mins = 60;
    $ttl = $mins * 60;
    return $ttl;
}
function mail_cache_read(string $mbid, string $folder): ?array {
    $c = read_data_file(mail_cache_file($mbid, $folder));
    if ($c === null) return null;
    $d = json_decode($c, true);
    if (!is_array($d) || !isset($d['ts']) || !is_array($d['list'] ?? null)) return null;
    return $d;
}
function mail_cache_write(string $mbid, string $folder, array $list, int $total, array $folders): void {
    @write_data_file(mail_cache_file($mbid, $folder), json_encode(['ts' => time(), 'list' => $list, 'total' => $total, 'folders' => $folders], JSON_UNESCAPED_UNICODE));
}
// 清掉一个邮箱所有文件夹的列表缓存（发信 / 删信 / 移组 / 删邮箱 / 改凭据后调用）。
function mail_clear_cache(string $mbid): void {
    $files = @glob(DATA_DIR . '/cache_' . preg_replace('/[^a-z0-9_-]/', '', strtolower($mbid)) . '_*.php');
    if (!is_array($files)) return;
    foreach ($files as $f) { @unlink($f); }
}
function site_ready(): bool { return load_site() !== null; }
function logged_in(): bool { return !empty($_SESSION['mc_login']) && !empty($_SESSION['mc_key']); }

// ---------- 密钥派生与加解密 ----------
function get_salt(): string {
    $old = read_data_file(SALT_FILE);
    if ($old !== null && $old !== '') return $old;
    $salt = random_bytes(16);
    write_data_file(SALT_FILE, $salt);
    return $salt;
}
function crypto_method(): string {
    return function_exists('sodium_crypto_secretbox') ? 'sodium' : 'openssl';
}
function derive_key(string $password): string {
    $salt = get_salt();
    if (function_exists('sodium_crypto_pwhash')) {
        return sodium_crypto_pwhash(32, $password, $salt, SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE, SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE);
    }
    return hash_pbkdf2('sha256', $password, $salt, 100000, 32, true);
}
function encrypt_cred(string $plain, string $key_b64): string {
    $key = base64_decode($key_b64, true);
    if (crypto_method() === 'sodium') {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return 'sodium:' . base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, $key));
    }
    $iv = random_bytes(12);
    $tag = '';
    $ct = openssl_encrypt($plain, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    return 'openssl:' . base64_encode($iv . $tag . $ct);
}
function decrypt_cred(string $stored, string $key_b64): ?string {
    $key = base64_decode($key_b64, true);
    if ($key === false) return null;
    $pos = strpos($stored, ':');
    if ($pos === false) return null;
    $method = substr($stored, 0, $pos);
    $raw = base64_decode(substr($stored, $pos + 1), true);
    if ($raw === false) return null;
    if ($method === 'sodium' && function_exists('sodium_crypto_secretbox_open')) {
        $nonce = substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $ct = substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $out = sodium_crypto_secretbox_open($ct, $nonce, $key);
        return $out === false ? null : $out;
    }
    if ($method === 'openssl') {
        $iv = substr($raw, 0, 12); $tag = substr($raw, 12, 16); $ct = substr($raw, 28);
        $out = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        return $out === false ? null : $out;
    }
    return null;
}

// ---------- 记住我（30 天免登录） ----------
// 令牌存在 data/remember.php（JSON 数组，开头同样加 exit 保护）。
// 每条只存令牌的 SHA-256（不存原文）+ 用令牌加密后的派生密钥 + 过期时间 + 发令牌时的密码哈希。
// 令牌原文只放在浏览器 Cookie 里（HttpOnly）；丢了数据文件拿不到密钥，
// 改了站点密码令牌就对不上密码哈希，也就作废了。
function remember_load(): array {
    $c = read_data_file(REMEMBER_FILE);
    if ($c === null) return [];
    $d = json_decode($c, true);
    return is_array($d) ? $d : [];
}
function remember_save(array $list): bool {
    return write_data_file(REMEMBER_FILE, json_encode(array_values($list), JSON_UNESCAPED_UNICODE));
}
function remember_key_for(string $tokenHex): string {
    $raw = hex2bin($tokenHex);
    if ($raw === false) $raw = $tokenHex;
    return base64_encode(hash('sha256', $raw, true));
}
function remember_set_cookie(string $hex, int $days = REMEMBER_DAYS): void {
    $days = remember_days_valid($days);
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    setcookie(REMEMBER_COOKIE, $hex, [
        'expires' => time() + $days * 86400,
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}
function remember_clear_cookie(): void {
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    setcookie(REMEMBER_COOKIE, '', [
        'expires' => time() - 3600,
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}
function remember_issue(string $key_b64, string $pwHash, int $days = REMEMBER_DAYS): void {
    $days = remember_days_valid($days);
    $token = random_bytes(32);
    $hex = bin2hex($token);
    $list = remember_load();
    $now = time();
    // 清掉过期的，免得文件越长越大
    $list = array_values(array_filter($list, static fn($e) => ($e['expires'] ?? 0) > $now));
    $list[] = [
        'hash' => hash('sha256', $hex),
        'key_enc' => encrypt_cred($key_b64, remember_key_for($hex)),
        'expires' => $now + $days * 86400,
        'days' => $days,
        'pw_hash' => $pwHash,
        'created' => date('Y-m-d H:i'),
    ];
    remember_save($list);
    remember_set_cookie($hex, $days);
}
function remember_revoke(?string $hex = null): void {
    // 不传就是全部吊销（改密码 / 退出所有设备时用）；传了就只吊销这一条
    $list = remember_load();
    if ($hex === null) {
        $list = [];
    } else {
        $h = hash('sha256', $hex);
        $list = array_values(array_filter($list, static function ($e) use ($h) {
            $eh = (string)($e['hash'] ?? '');
            return $eh === '' || !hash_equals($eh, $h);
        }));
    }
    remember_save($list);
}
function remember_restore(): void {
    if (logged_in()) return;
    $hex = (string)($_COOKIE[REMEMBER_COOKIE] ?? '');
    if ($hex === '' || !ctype_xdigit($hex) || strlen($hex) !== 64) {
        if ($hex !== '') remember_clear_cookie();
        return;
    }
    $site = load_site();
    if ($site === null) return;
    $now = time();
    // 先清掉过期的，再找这一条（下标是清完之后算的，不会错位）
    $list = array_values(array_filter(remember_load(), static fn($e) => ($e['expires'] ?? 0) > $now));
    $found = null;
    $foundIdx = -1;
    $wantHash = hash('sha256', $hex);
    foreach ($list as $i => $e) {
        $eh = (string)($e['hash'] ?? '');
        // hash_equals 空串会抛错，先排除
        if ($eh !== '' && hash_equals($eh, $wantHash)) {
            $found = $e;
            $foundIdx = $i;
            break;
        }
    }
    if ($found === null) {
        remember_save($list);
        remember_clear_cookie();
        return;
    }
    // 密码换过，令牌就作废（改密码时本来也会全部吊销，这里是第二道）
    $ph = (string)($found['pw_hash'] ?? '');
    $sh = (string)($site['hash'] ?? '');
    if ($ph === '' || $sh === '' || !hash_equals($ph, $sh)) {
        unset($list[$foundIdx]);
        remember_save(array_values($list));
        remember_clear_cookie();
        return;
    }
    $key_b64 = decrypt_cred((string)($found['key_enc'] ?? ''), remember_key_for($hex));
    $rawKey = is_string($key_b64) ? base64_decode($key_b64, true) : false;
    if (!is_string($key_b64) || $key_b64 === '' || $rawKey === false || strlen($rawKey) !== 32) {
        remember_clear_cookie();
        return;
    }
    $_SESSION['mc_login'] = true;
    $_SESSION['mc_key'] = $key_b64;
    session_regenerate_id(true);
    // 恢复成功：有效期按这条令牌自己的时长顺延，Cookie 也重新设同样时长
    $days = remember_days_valid((int)($found['days'] ?? REMEMBER_DAYS));
    $list[$foundIdx]['expires'] = $now + $days * 86400;
    $list[$foundIdx]['days'] = $days;
    remember_save(array_values($list));
    remember_set_cookie($hex, $days);
}

// ---------- 厂商预设（按邮箱域名自动填） ----------
function provider_for(string $email): array {
    $domain = strtolower((string)(strrchr($email, '@') ?: ''));
    $domain = ltrim($domain, '@');
    $map = [
        'qq.com' => ['QQ邮箱', 'imap.qq.com', 993, 'ssl', 'smtp.qq.com', 587, 'tls'],
        'gmail.com' => ['Gmail', 'imap.gmail.com', 993, 'ssl', 'smtp.gmail.com', 587, 'tls'],
        'outlook.com' => ['Outlook', 'outlook.office365.com', 993, 'ssl', 'smtp.office365.com', 587, 'tls'],
        'hotmail.com' => ['Outlook', 'outlook.office365.com', 993, 'ssl', 'smtp.office365.com', 587, 'tls'],
        'live.com' => ['Outlook', 'outlook.office365.com', 993, 'ssl', 'smtp.office365.com', 587, 'tls'],
        '163.com' => ['网易 163', 'imap.163.com', 993, 'ssl', 'smtp.163.com', 465, 'ssl'],
        '126.com' => ['网易 126', 'imap.126.com', 993, 'ssl', 'smtp.126.com', 465, 'ssl'],
        'foxmail.com' => ['QQ邮箱', 'imap.qq.com', 993, 'ssl', 'smtp.qq.com', 587, 'tls'],
        'v.cd' => ['DNSHE', 'smtp.mail.v.cd', 993, 'ssl', 'smtp.mail.v.cd', 465, 'ssl'],
    ];
    if (isset($map[$domain])) return $map[$domain];
    return ['自定义', 'imap.' . $domain, 993, 'ssl', 'smtp.' . $domain, 587, 'tls'];
}
// 分组图标：取分组名第一个字，蓝底白字圆角方块；英文首字母自动大写
function group_icon(string $gname): string {
    $gname = trim($gname);
    $ch = $gname === '' ? '未' : mb_substr($gname, 0, 1, 'UTF-8');
    if (preg_match('/^[a-z]$/i', $ch)) $ch = mb_strtoupper($ch, 'UTF-8');
    return '<span class="gicon">' . e($ch) . '</span>';
}
// 分组颜色：每个分组按名字固定分一个浅底深字配色（8 色循环），左栏分组名和表格分组标签用同一套；
// 底色取同色系最淡的一档、文字取同色系的深色，比例协调不刺眼。顺序特意排过：QQ邮箱绿、outlook 蓝、DNSHE 紫、未分组灰
function group_color(string $gname): array {
    static $palette = [
        ['#f5f5f4', '#57534e'], // 灰（未分组）
        ['#fce4ec', '#c2185b'], // 淡粉
        ['#ede7f6', '#5e35b1'], // 淡紫
        ['#e6f4ea', '#2e7d32'], // 淡绿
        ['#fff3e0', '#e65100'], // 淡橙
        ['#e3f2fd', '#1565c0'], // 淡蓝
        ['#e0f2f1', '#00796b'], // 淡青
        ['#fff8e1', '#f57f17'], // 淡黄
    ];
    $i = crc32('grp:' . trim($gname)) % count($palette);
    if ($i < 0) $i += count($palette);
    return $palette[$i];
}
function group_tag_style(string $gname): string {
    [$bg, $fg] = group_color($gname);
    return 'background:' . $bg . ';color:' . $fg;
}

// ---------- TG 新邮件通知 ----------
// 中转地址默认就是你现在收 KataBump 通知的那条 Worker，token 只在 Cloudflare
// 那边，管理中心这边不存任何 TG 密钥，只 POST 文本。
// 轮询用的密钥存在 data/notify_key.php（和 salt 一个做法，guard 保护）；
// 站点密钥用这把密钥再加密一份存在 site 记录里（notify_key_blob），
// 定时任务不用登录就能解密邮箱凭据来查新邮件；改站点密码时这份也要跟着换。
define('NOTIFY_KEY_FILE', DATA_DIR . '/notify_key.php');
define('TG_WORKER_DEFAULT', ''); // 公开项目：默认不填。别人部署后在设置页填自己的 Worker 地址，或者直接用 chat_id + Bot Token 走直连
function tg_notify_secret(): string {
    $old = read_data_file(NOTIFY_KEY_FILE);
    if ($old !== null && trim($old) !== '') return trim($old);
    $s = base64_encode(random_bytes(32));
    write_data_file(NOTIFY_KEY_FILE, $s);
    return $s;
}
function tg_now_bj(): string {
    return (new DateTime('now', new DateTimeZone('Asia/Shanghai')))->format('Y-m-d H:i');
}
function tg_seen_file(string $mbid): string {
    $id = preg_replace('/[^a-z0-9_-]/', '', strtolower($mbid));
    if ($id === '') $id = 'mb';
    return DATA_DIR . '/notify_seen_' . $id . '.php';
}
function tg_send(string $worker_url, string $text): array {
    $url = trim($worker_url) !== '' ? trim($worker_url) : TG_WORKER_DEFAULT;
    if ($url === '') return [false, '没有配 TG 中转地址：设置页填 chat_id + Bot Token 用直连，或者填你自己的 Worker 地址'];
    $body = json_encode(['text' => $text], JSON_UNESCAPED_UNICODE);
    // 和微软令牌请求一个做法：file_get_contents + stream 上下文，不用 curl；
    // 必须带普通 User-Agent，urllib 默认 UA 会被 Worker 所在域直接拦 403。
    $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\nUser-Agent: curl/8.0\r\n", 'content' => $body, 'timeout' => 30, 'ignore_errors' => true]]);
    $resp = @file_get_contents($url, false, $ctx);
    if ($resp === false) return [false, '中转 Worker 没连上'];
    $d = json_decode((string)$resp, true);
    if (is_array($d) && !empty($d['ok'])) return [true, ''];
    return [false, 'TG 返回：' . mb_substr((string)$resp, 0, 120)];
}
// 直连 Telegram Bot API 发通知：不用中转 Worker，设置页填 chat_id + Bot Token 就行。
// 返回 [是否成功, 失败原因]。失败原因尽量用 Telegram 原话，方便定位。
function tg_send_direct(string $token, string $chat_id, string $text): array {
    $url = 'https://api.telegram.org/bot' . $token . '/sendMessage';
    $body = json_encode(['chat_id' => $chat_id, 'text' => $text], JSON_UNESCAPED_UNICODE);
    $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\nUser-Agent: curl/8.0\r\n", 'content' => $body, 'timeout' => 30, 'ignore_errors' => true]]);
    $resp = @file_get_contents($url, false, $ctx);
    if ($resp === false) return [false, 'api.telegram.org 没连上（服务器可能屏蔽了 Telegram，改用下面的中转地址）'];
    $d = json_decode((string)$resp, true);
    if (is_array($d) && !empty($d['ok'])) return [true, ''];
    $desc = (string)($d['description'] ?? $resp);
    if ($desc === 'Unauthorized') $desc = 'Token 不对（Unauthorized），去 @BotFather 重新复制一遍';
    if (stripos($desc, 'chat not found') !== false) $desc = '找不到这个聊天（chat not found）：先给机器人发一条消息（点 Start），再查 chat_id';
    if (stripos($desc, 'bot was blocked') !== false) $desc = '机器人被你拉黑了（bot was blocked），去 TG 里解除拉黑再试';
    return [false, 'Telegram 说：' . mb_substr($desc, 0, 120)];
}
// 发一条 TG 通知：优先直连（设置页填了 chat_id + Bot Token），没填就走原来的中转 Worker。
// 直连配错了不悄悄回落到中转，直接报 Telegram 的原话，好定位。
function tg_send_msg(array $site, string $key_b64, string $text): array {
    $chat_id = '';
    $token = '';
    if (!empty($site['tg_chat_id'])) { $d = decrypt_cred((string)$site['tg_chat_id'], $key_b64); if (is_string($d)) $chat_id = trim($d); }
    if (!empty($site['tg_bot_token'])) { $d = decrypt_cred((string)$site['tg_bot_token'], $key_b64); if (is_string($d)) $token = trim($d); }
    if ($chat_id !== '' && $token !== '') return tg_send_direct($token, $chat_id, $text);
    $worker = trim((string)($site['tg_worker'] ?? '')) !== '' ? trim((string)$site['tg_worker']) : TG_WORKER_DEFAULT;
    return tg_send($worker, $text);
}
// 本站的公开地址（从当前请求取，部署到哪都对）：TG 通知里的“看全文”链接和定时任务地址都用它。
function mc_base_url(): string {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $host = (string)($_SERVER['HTTP_HOST'] ?? '');
    if ($host === '') $host = 'mangguo.lele.pp.ua';
    return ($https ? 'https://' : 'http://') . $host;
}
// 查一轮新邮件并推 TG。$key_b64 是站点密钥（base64）。
// 返回 [查了几个邮箱, 推了几条, 备注]。只查收件箱、只查连接正常的邮箱。
// 去重：每个邮箱已通知的 UID 存在 data/notify_seen_<id>.php；
// 第一次跑只记基线、不推，避免把旧邮件一股脑全推出来。
// 注意：TG 中转这边不吃 parse_mode，剧透 ||...|| 发过去只会原样显示，
// 所以通知里只放正文前 120 字预览 + 一条“点开看全文”的链接，点链接回
// 管理中心读完整正文——折叠展开是在管理中心里，不是 TG 里。
function tg_check_all(string $key_b64, array $list, array $site): array {
    // mail_cred_plain() 是从 session 里拿站点密钥，这里先放进去，定时任务没登录也能解凭据
    $_SESSION['mc_key'] = $key_b64;
    $checked = 0; $sent = 0; $notes = [];
    foreach ($list as $mb) {
        if (($mb['status'] ?? '') !== 'ok') continue;
        // 域名邮箱走 HTTP API，不走 IMAP，TG 新邮件轮询暂不推
        // （先跳过，不记失败；Cloud Mail 的 /email/latest 已备好，下一版接）
        if (mc_api_is_api_kind((string)($mb['kind'] ?? 'imap'))) continue;
        $checked++;
        $seen = [];
        $c = read_data_file(tg_seen_file((string)$mb['id']));
        if ($c !== null) { $d = json_decode($c, true); if (is_array($d)) $seen = $d; }
        $first = empty($seen);
        $cred = mail_cred_plain((string)($mb['credential'] ?? ''));
        if ($cred === '') { $notes[] = (string)$mb['email'] . '：凭据解不开'; continue; }
        $conn = null;
        if (($mb['auth'] ?? '') === 'ms') {
            $mb2 = $mb;
            $token = ms_valid_access_token($mb2, $key_b64);
            if ($token === '') { $notes[] = (string)$mb['email'] . '：微软令牌拿不到了'; continue; }
            $conn = mail_connect_oauth($mb2, (string)$mb['email'], $token);
        } else {
            $conn = mail_imap_connect($mb, $cred);
        }
        if (empty($conn['ok'])) { $notes[] = (string)$mb['email'] . '：连不上（' . (string)($conn['err'] ?? '') . '）'; continue; }
        $fp = $conn['fp'];
        $map = mail_folder_map(mail_imap_list($fp));
        $op = mail_imap_open_folder($fp, 'inbox', $map);
        if (empty($op['ok'])) { fclose($fp); continue; }
        $uids = mail_imap_uids($fp);
        $new = [];
        foreach ($uids as $u) { if (!in_array((int)$u, array_map('intval', $seen), true)) $new[] = (int)$u; }
        $seen = array_values(array_unique(array_merge(array_map('intval', $seen), $uids)));
        if (count($seen) > 200) $seen = array_slice($seen, -200);
        write_data_file(tg_seen_file((string)$mb['id']), json_encode($seen));
        if ($first || empty($new)) { fclose($fp); continue; }
        $rows = mail_imap_fetch_list($fp, array_slice($new, -5));
        foreach ($rows as $row) {
            $subj = trim((string)($row['subject'] ?? '')) !== '' ? (string)$row['subject'] : '（无主题）';
            $from = trim((string)($row['from_name'] ?? '')) !== '' ? (string)$row['from_name'] . ' <' . (string)($row['from_addr'] ?? '') . '>' : (string)($row['from_addr'] ?? '');
            $ts = strtotime((string)($row['date'] ?? ''));
            $when = (string)($row['date'] ?? '');
            if ($ts !== false && $ts > 0) { $dt = new DateTime('@' . $ts); $dt->setTimezone(new DateTimeZone('Asia/Shanghai')); $when = $dt->format('Y-m-d H:i'); }
            $prev = trim((string)($row['snippet'] ?? ''));
            if ($prev === '') $prev = '（没有正文预览）';
            $prev = mb_substr($prev, 0, 120, 'UTF-8');
            $text = "📧 新邮件\n邮箱：" . (string)$mb['email'] . "\n时间：" . $when . "（北京时间）\n发件人：" . $from . "\n标题：" . $subj . "\n内容：" . $prev . "\n👉 点开看全文：" . mc_base_url() . "/?tab=inbox&mb=" . urlencode((string)$mb['id']);
            [$ok, $err] = tg_send_msg($site, $key_b64, $text);
            if ($ok) $sent++; else $notes[] = (string)$mb['email'] . '：TG 没发出去（' . $err . '）';
        }
        fclose($fp);
    }
    return [$checked, $sent, implode('；', $notes)];
}
// 列表时间按北京时间显示：当天的只显示时:分（如 12:40），之前的显示 年/月/日（如 2026/10/04）
function mail_display_date(string $raw): string {
    $ts = strtotime($raw);
    if ($ts === false || $ts <= 0) return $raw;
    $tz = new DateTimeZone('Asia/Shanghai');
    $d = new DateTime('@' . $ts);
    $d->setTimezone($tz);
    $today = new DateTime('now', $tz);
    if ($d->format('Y-m-d') === $today->format('Y-m-d')) return $d->format('H:i');
    return $d->format('Y/m/d');
}
function mail_shanghai_ym(int $ts): string {
    $d = new DateTime('@' . $ts);
    $d->setTimezone(new DateTimeZone('Asia/Shanghai'));
    return $d->format('Y-m');
}
function imap_escape(string $s): string { return str_replace(['\\', '"'], ['\\\\', '\\"'], $s); }

// ---------- IMAP 连接测试（只测收信，不发信；绝不回显凭据） ----------
function test_imap(string $host, int $port, string $user, string $pass): array {
    $host = trim($host);
    if ($host === '' || $port <= 0) return [false, 'IMAP 服务器或端口没填对。'];
    $fp = @fsockopen('ssl://' . $host, $port, $errno, $errstr, 10);
    if (!$fp) return [false, '连不上 ' . $host . ':' . $port . '（' . $errstr . '），先检查服务器地址/端口，或稍后再试。'];
    stream_set_timeout($fp, 10);
    $greet = fgets($fp, 1024);
    if ($greet === false) { fclose($fp); return [false, '服务器没有回应，可能是端口不对或服务暂忙，稍后再试。']; }
    fwrite($fp, 'a001 LOGIN "' . imap_escape($user) . '" "' . imap_escape($pass) . "\"\r\n");
    $line = '';
    $tries = 0;
    while ($tries < 20) {
        $l = fgets($fp, 2048);
        if ($l === false) break;
        $line = $l;
        if (strpos($l, 'a001 ') === 0) break;
        $tries++;
    }
    fwrite($fp, "a002 LOGOUT\r\n");
    fclose($fp);
    if (stripos($line, 'a001 OK') === 0) return [true, '连接成功，账号和凭据都对。'];
    $msg = trim(preg_replace('/^a001 (NO|BAD) /i', '', $line));
    if (stripos($msg, 'AUTHENTICATIONFAILED') !== false || stripos($msg, 'Invalid') !== false) {
        return [false, '服务器拒登：' . $msg . ' —— 密码/授权码不对，或服务没开。QQ 请用授权码，Gmail 请用应用专用密码；Outlook 个人账号只认微软账号登录，请用「用微软账号登录添加」。失败多次会被限频，等 10 分钟再试。'];
    }
    return [false, '登录失败：' . ($msg !== '' ? $msg : '服务器没有返回明确原因。')];
}

// ---------- 收发信小助手 ----------
// 打开当前邮箱的 IMAP 连接，顺便取文件夹映射；失败返回空连接和中文原因。
function mail_connect_current(array $mb, ?string $cred): array {
    if (empty($mb)) {
        return [null, [], '先添加一个邮箱，再回来读信。'];
    }
    // 微软登录的邮箱：用令牌走 XOAUTH2，不用密码
    if (($mb['auth'] ?? '') === 'ms') {
        $token = ms_valid_access_token($mb, (string)($_SESSION['mc_key'] ?? ''));
        if ($token === '') {
            return [null, [], '微软登录的令牌拿不到了，请到邮箱管理删掉这个邮箱，重新用微软账号登录添加。'];
        }
        $c = mail_connect_oauth($mb, (string)$mb['email'], $token);
        if (!$c['ok']) {
            return [null, [], $c['err']];
        }
        $fp = $c['fp'];
        $map = mail_folder_map(mail_imap_list($fp));
        return [$fp, $map, ''];
    }
    if ($cred === null || $cred === '') {
        return [null, [], '先添加一个邮箱，再回来读信。'];
    }
    $c = mail_imap_connect($mb, (string)$cred);
    if (!$c['ok']) {
        return [null, [], $c['err']];
    }
    $fp = $c['fp'];
    $map = mail_folder_map(mail_imap_list($fp));
    return [$fp, $map, ''];
}
function mail_close($fp): void {
    if (is_resource($fp)) {
        @fwrite($fp, "aBYE LOGOUT\r\n");
        @fclose($fp);
    }
}
// 把逗号 / 分号 / 换行分隔的收件人拆成地址列表。
function mail_split_addrs(string $s): array {
    $parts = preg_split('/[,\s;；，]+/', trim($s));
    if ($parts === false) return [];
    $out = [];
    foreach ($parts as $p) {
        $p = trim($p);
        if ($p !== '' && filter_var($p, FILTER_VALIDATE_EMAIL)) $out[] = $p;
    }
    return array_values(array_unique($out));
}

function render_add_form($draft, $edit_box, $edit_id, $return_tab = 'add', $bar = false) {
  // 已创建的分组 + 每个分组的服务器（取该分组里第一个邮箱的，供选分组时自动填）
  $form_groups = [];
  $form_group_servers = [];
  foreach (load_mailboxes() as $fmb) {
    $fg = trim((string)($fmb['group'] ?? '')) !== '' ? trim((string)$fmb['group']) : '未分组';
    if (!isset($form_groups[$fg])) $form_groups[$fg] = true;
    if (!isset($form_group_servers[$fg])) {
      $form_group_servers[$fg] = [(string)($fmb['imap_host'] ?? ''), (int)($fmb['imap_port'] ?? 993), (string)($fmb['imap_enc'] ?? 'ssl'), (string)($fmb['smtp_host'] ?? ''), (int)($fmb['smtp_port'] ?? 587), (string)($fmb['smtp_enc'] ?? 'tls')];
    }
  }
  $cur_group = (string)($draft['group'] ?? '未分组');
  // “未分组”永远可选；还没建过任何邮箱时，下拉里只有“新建分组”
  if (!isset($form_groups['未分组'])) $form_groups['未分组'] = true;
  $cur_is_new = empty($form_group_servers) || ($cur_group !== '' && $cur_group !== '未分组' && !isset($form_groups[$cur_group]));
  // 当前厂商栏的默认值：当前分组有现成的服务器，就显示这个分组；否则自动识别
  $cur_provider = isset($form_group_servers[$cur_group]) ? 'group:' . $cur_group : 'auto';
  // 正在改域名邮箱：厂商栏默认选这个 kind，对应蓝框默认显示
  $cur_kind = (string)($draft['kind'] ?? ($edit_box['kind'] ?? ''));
  if (mc_api_is_api_kind($cur_kind)) $cur_provider = $cur_kind;
?>
        <div class="card">
          <?php if ($bar): ?><details class="addbar"<?= !empty($draft) ? ' open' : '' ?>><summary><span style="color:#16a34a">＋</span> 添加邮箱 <span class="fold">▾</span></summary>
          <?php else: ?><h2><?= $edit_box ? '修改登录方式 / 凭据' : '添加邮箱' ?></h2><?php endif; ?>
          <p class="muted"><?= $edit_box ? '这个邮箱改登录方式不用删了重加：在下面二选一，填新的密码或授权码，点保存就行。' : '先选登录方式，再填凭据。两种方式都支持；哪个能登上，取决于邮箱厂商那边的规则，不是这个页面说了算。' ?></p>
          <form method="post" autocomplete="off" id="addForm">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="return_tab" value="<?=e($return_tab)?>">
            <?php if ($edit_box): ?><input type="hidden" name="edit_id" value="<?=e($edit_id)?>"><?php endif; ?>
            <label>邮箱厂商（选一个，下面的服务器自动填好）</label>
            <select name="provider" id="provider" style="width:100%;padding:10px 12px;border:1px solid #e7e5e4;border-radius:8px;font-size:15px">
              <option value="auto">自动识别（按邮箱地址）</option>
              <option value="qq">QQ 邮箱（qq.com / foxmail.com）</option>
              <option value="gmail">Gmail（gmail.com）</option>
              <option value="outlook">Outlook / Hotmail（outlook.com / hotmail.com / live.com）</option>
              <option value="163">网易 163（163.com）</option>
              <option value="126">网易 126（126.com）</option>
              <option value="custom">自定义服务器（自己填）</option>
              <?php foreach (mc_api_adapters() as $mc_k => $mc_a): ?><option value="<?=e($mc_k)?>"<?= $cur_provider === $mc_k ? ' selected' : '' ?>><?=e(mc_api_label($mc_k))?>（域名邮箱）</option>
              <?php endforeach; ?>
              <?php foreach (array_keys($form_group_servers) as $fg): ?><option value="group:<?=e($fg)?>" <?= $cur_provider === 'group:' . $fg ? 'selected' : '' ?>><?=e($fg)?>（分组）</option><?php endforeach; ?>
            </select>
            <p class="muted" id="outlookNote" style="display:none;color:#b45309">注意：Outlook 个人邮箱微软自 2024-09-16 起只认微软账号登录，密码 / 应用密码登不上；用下面「用微软账号登录添加」，不用填密码。</p>
            <?php foreach (mc_api_adapters() as $mc_k => $mc_a): $mc_cur = ($cur_provider === $mc_k); ?>
            <div id="apiFields_<?=e($mc_k)?>" style="border:1px solid #dbeafe;background:#eff6ff;border-radius:8px;padding:12px;margin:12px 0 0;<?= $mc_cur ? '' : 'display:none' ?>">
              <strong><?=e(mc_api_label($mc_k))?> 域名邮箱</strong>
              <p class="muted" style="margin:4px 0 8px"><?=e(mc_api_meta($mc_k, 'about'))?></p>
              <label><?=e(mc_api_meta($mc_k, 'panel_label', mc_api_label($mc_k) . ' 面板地址'))?></label>
              <input type="text" name="panel_url" id="panel_url_<?=e($mc_k)?>" value="<?=e($mc_cur ? (string)($draft['panel_url'] ?? '') : '')?>" placeholder="<?=e(mc_api_meta($mc_k, 'panel_placeholder'))?>"<?= $mc_cur ? '' : ' disabled' ?>>
              <label><?=e(mc_api_label($mc_k))?> 登录账号</label>
              <input type="email" name="panel_login" id="panel_login_<?=e($mc_k)?>" value="<?=e($mc_cur ? (string)($draft['panel_login'] ?? '') : '')?>" placeholder="登录 <?=e(mc_api_label($mc_k))?> 面板用的邮箱"<?= $mc_cur ? ' required' : ' disabled' ?>>
              <label><?=e(mc_api_label($mc_k))?> 登录密码</label>
              <input type="text" name="panel_password" id="panel_password_<?=e($mc_k)?>" autocomplete="new-password" value="<?=e($mc_cur ? (string)($draft['panel_password'] ?? $draft['cred'] ?? '') : '')?>" placeholder="<?=e(mc_api_label($mc_k))?> 面板登录密码"<?= $mc_cur ? ' required' : ' disabled' ?>>
              <?php if (mc_api_meta($mc_k, 'note') !== ''): ?><p class="muted" style="margin:8px 0 0"><?=e(mc_api_meta($mc_k, 'note'))?></p><?php endif; ?>
            </div>
            <?php endforeach; ?>
            <label>邮箱地址</label>
            <input type="email" name="email" id="email" value="<?=e((string)($draft['email'] ?? ''))?>" placeholder="如 xxx@qq.com" required <?= $edit_box ? 'readonly' : '' ?>>
            <label>显示名称（可选，收件人看到的名字）</label>
            <input type="text" name="display_name" value="<?=e((string)($draft['dname'] ?? ''))?>" placeholder="如 aa">
            <label>分组（选一个已创建的分组，或新建一个）</label>
            <select name="group" id="groupSel" style="width:100%;padding:10px 12px;border:1px solid #e7e5e4;border-radius:8px;font-size:15px">
              <?php foreach (array_keys($form_groups) as $fg): ?><option value="<?=e($fg)?>" <?= $cur_group === $fg ? 'selected' : '' ?>><?=e($fg)?></option><?php endforeach; ?>
              <option value="__new__" <?= $cur_is_new ? 'selected' : '' ?>>＋ 新建分组…</option>
            </select>
            <input type="text" name="group_new" id="groupNew" value="<?=e($cur_is_new && $cur_group !== '未分组' ? $cur_group : '')?>" placeholder="输入新分组名，如 工作" style="margin-top:8px;<?= $cur_is_new ? '' : 'display:none' ?>">
            <p class="muted" style="margin:4px 0 0">选一个已创建的分组，下面的 IMAP / SMTP 服务器会自动填成这个分组里邮箱用的那套（比如选 DNSHE 就填 smtp.mail.v.cd），厂商栏也会同步改成这个分组；选“新建分组”就自己起个名字，服务器按邮箱地址自动识别，不对再手动改。</p>
            <div id="methodRow"<?= mc_api_is_api_kind($cur_provider) ? ' style="display:none"' : '' ?>>
            <label>登录方式（二选一，并排显示）</label>
            <?php $dm = (string)($draft['method'] ?? 'authcode'); ?>
            <div class="methods">
            <label class="radio <?= $dm!=='password' ? 'on' : '' ?>"><input type="radio" name="method" value="authcode" <?= $dm!=='password' ? 'checked' : '' ?>> <b>授权码登入（推荐）</b>
              <small>QQ 只有这一种能用；Gmail / Outlook 开了两步验证后也要用它。去邮箱官网生成授权码 / 应用专用密码。</small></label>
            <label class="radio <?= $dm==='password' ? 'on' : '' ?>"><input type="radio" name="method" value="password" <?= $dm==='password' ? 'checked' : '' ?>> <b>密码登入</b>
              <small>平时登录邮箱的密码。QQ / Gmail / Outlook 开了两步验证后，服务器通常会拒收，报认证失败。</small></label>
            </div>
            </div>
            <div id="credRow"<?= mc_api_is_api_kind($cur_provider) ? ' style="display:none"' : '' ?>>
            <label>密码 / 授权码</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="text" name="credential" id="credential" autocomplete="new-password"<?= mc_api_is_api_kind($cur_provider) ? '' : ' required' ?> placeholder="登录密码，或 16 位授权码 / 应用专用密码" style="flex:1" value="<?=e((string)($draft['cred'] ?? ''))?>">
              <button type="button" class="btn ghost" id="credToggle" style="white-space:nowrap">🙈 隐藏</button>
            </div>
            <p class="muted">密码 / 授权码默认直接显示，方便核对；点“隐藏”就变成圆点。</p>
            </div>
            <?php $ms_cfg_f = function_exists('ms_config') ? ms_config((string)($_SESSION['mc_key'] ?? '')) : ['id' => '', 'secret' => '']; $ms_ready_f = $ms_cfg_f['id'] !== '' && $ms_cfg_f['secret'] !== ''; ?>
            <div style="border:1px solid #bbf7d0;background:#f0fdf4;border-radius:8px;padding:12px;margin:12px 0 0">
              <strong>Outlook / Hotmail 不用填密码</strong>
              <p class="muted" style="margin:4px 0 8px">用微软账号登录添加：点一下跳到微软登录页，登完自动回来，不用授权码、不用应用密码。</p>
              <?php if ($ms_ready_f): ?><a class="btn" href="oauth.php?step=ms_start">用微软账号登录添加</a>
              <?php else: ?><button type="button" class="btn" disabled style="opacity:.5;cursor:not-allowed">用微软账号登录添加</button> <span class="muted">先在设置里填 Client ID 和 Secret。</span><?php endif; ?>
            </div>
            <div class="row" id="imapRow"<?= mc_api_is_api_kind($cur_provider) ? ' style="display:none"' : '' ?>>
              <div><label>IMAP 服务器</label><input type="text" name="imap_host" id="imap_host" value="<?=e((string)($draft['ihost'] ?? ''))?>" placeholder="imap.qq.com"></div>
              <div><label>IMAP 端口</label><input type="text" name="imap_port" id="imap_port" value="<?=e((string)($draft['iport'] ?? '993'))?>"></div>
              <div><label>IMAP 加密</label><select name="imap_enc" id="imap_enc"><option value="ssl"<?= ($draft['ienc'] ?? 'ssl') === 'ssl' ? ' selected' : '' ?>>SSL</option><option value="tls"<?= ($draft['ienc'] ?? '') === 'tls' ? ' selected' : '' ?>>STARTTLS</option></select></div>
            </div>
            <div class="row" id="smtpRow"<?= mc_api_is_api_kind($cur_provider) ? ' style="display:none"' : '' ?>>
              <div><label>SMTP 服务器</label><input type="text" name="smtp_host" id="smtp_host" value="<?=e((string)($draft['shost'] ?? ''))?>" placeholder="smtp.qq.com"></div>
              <div><label>SMTP 端口</label><input type="text" name="smtp_port" id="smtp_port" value="<?=e((string)($draft['sport'] ?? '587'))?>"></div>
              <div><label>SMTP 加密</label><select name="smtp_enc" id="smtp_enc"><option value="tls"<?= ($draft['senc'] ?? 'tls') === 'tls' ? ' selected' : '' ?>>STARTTLS</option><option value="ssl"<?= ($draft['senc'] ?? '') === 'ssl' ? ' selected' : '' ?>>SSL</option></select></div>
            </div>
            <p class="muted">选厂商或填邮箱地址后，服务器自动按厂商填好；选“自定义服务器”就自己填，不对可以再改。先点「测试连接」确认能登上，再点「保存邮箱」。</p>
            <p>
              <button class="btn ghost" name="action" value="test_add">测试连接</button>
              <button class="btn" name="action" value="add">保存邮箱</button>
            </p>
          </form>
          <?php if ($bar): ?></details><?php endif; ?>
        </div>
        <script>
        // 密码 / 授权码默认直接显示，点一下在显示和隐藏之间切换
        var cred = document.getElementById('credential'), credBtn = document.getElementById('credToggle');
        credBtn.addEventListener('click', function(){
          if (cred.type === 'text') { cred.type = 'password'; credBtn.textContent = '👁 显示'; }
          else { cred.type = 'text'; credBtn.textContent = '🙈 隐藏'; }
        });
        // 厂商预设（和 PHP 里 provider_for 的表一致）：选厂商就自动填好服务器
        var P = {
          'qq.com':['imap.qq.com','993','ssl','smtp.qq.com','587','tls'],
          'foxmail.com':['imap.qq.com','993','ssl','smtp.qq.com','587','tls'],
          'gmail.com':['imap.gmail.com','993','ssl','smtp.gmail.com','587','tls'],
          'outlook.com':['outlook.office365.com','993','ssl','smtp.office365.com','587','tls'],
          'hotmail.com':['outlook.office365.com','993','ssl','smtp.office365.com','587','tls'],
          'live.com':['outlook.office365.com','993','ssl','smtp.office365.com','587','tls'],
          '163.com':['imap.163.com','993','ssl','smtp.163.com','465','ssl'],
          '126.com':['imap.126.com','993','ssl','smtp.126.com','465','ssl'],
          'v.cd':['smtp.mail.v.cd','993','ssl','smtp.mail.v.cd','465','ssl']
        };
        var PROVIDER_OF_DOMAIN = {'qq.com':'qq','foxmail.com':'qq','gmail.com':'gmail','outlook.com':'outlook','hotmail.com':'outlook','live.com':'outlook','163.com':'163','126.com':'126'};
        var DOMAIN_OF_PROVIDER = {'qq':'qq.com','gmail':'gmail.com','outlook':'outlook.com','163':'163.com','126':'126.com'};
        function fillServers(p){
          document.getElementById('imap_host').value=p[0];
          document.getElementById('imap_port').value=p[1];
          document.getElementById('imap_enc').value=p[2];
          document.getElementById('smtp_host').value=p[3];
          document.getElementById('smtp_port').value=p[4];
          document.getElementById('smtp_enc').value=p[5];
        }
        var providerSel = document.getElementById('provider'), outlookNote = document.getElementById('outlookNote');
        var API_KINDS = <?=json_encode(array_keys(mc_api_adapters()))?>; // 域名邮箱的 kind 列表，来自注册表
        // 每个分组的服务器取自这个分组里已有的邮箱；分组栏和厂商栏双向同步
        var GROUP_SERVERS = <?=json_encode($form_group_servers, JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)?>;
        var groupSel = document.getElementById('groupSel'), groupNew = document.getElementById('groupNew');
        providerSel.addEventListener('change', function(){
          var v = this.value;
          outlookNote.style.display = (v === 'outlook') ? 'block' : 'none';
          // 域名邮箱不用 IMAP / SMTP：显示对应的蓝框，藏起下面两排服务器
          var isApi = (API_KINDS.indexOf(v) >= 0);
          var ir = document.getElementById('imapRow'), sr = document.getElementById('smtpRow');
          API_KINDS.forEach(function(k){
            var box = document.getElementById('apiFields_' + k);
            if (box) box.style.display = (v === k) ? 'block' : 'none';
            ['panel_url_', 'panel_login_', 'panel_password_'].forEach(function(p){
              var el = document.getElementById(p + k);
              if (el) el.disabled = (v !== k);
            });
          });
          if (ir) ir.style.display = isApi ? 'none' : '';
          if (sr) sr.style.display = isApi ? 'none' : '';
          // 域名邮箱时密码填在蓝框里：藏起登录方式和共用的密码框，必填也跟着换过去
          var mr = document.getElementById('methodRow'), cr = document.getElementById('credRow'), cd = document.getElementById('credential');
          if (mr) mr.style.display = isApi ? 'none' : '';
          if (cr) cr.style.display = isApi ? 'none' : '';
          if (cd) cd.required = !isApi;
          API_KINDS.forEach(function(k){
            var lp = document.getElementById('panel_login_' + k), pp = document.getElementById('panel_password_' + k);
            if (lp) lp.required = (v === k);
            if (pp) pp.required = (v === k);
          });
          if (isApi) {
            // 刚切到域名邮箱：账号栏空着就拿邮箱地址自动填上
            var em2 = document.getElementById('email'), lg = document.getElementById('panel_login_' + v);
            if (lg && lg.value === '' && em2 && em2.value !== '') lg.value = em2.value;
            return;
          }
          if (v === 'custom' || v === 'auto') return; // 自定义自己填；自动识别等填邮箱地址时再填
          if (v.indexOf('group:') === 0) {
            var g = v.slice(6);
            groupSel.value = g;
            groupNew.style.display = 'none';
            var gp = GROUP_SERVERS[g]; if (gp) fillServers(gp);
            return;
          }
          var p = P[DOMAIN_OF_PROVIDER[v]]; if (p) fillServers(p);
        });
        document.getElementById('email').addEventListener('change', function(){
          if (API_KINDS.indexOf(providerSel.value) >= 0) return; // 域名邮箱不用服务器
          var d = (this.value.split('@')[1]||'').toLowerCase().trim();
          var p = P[d]; if(!p) return;
          fillServers(p);
          var pv = PROVIDER_OF_DOMAIN[d]; if (pv) { providerSel.value = pv; outlookNote.style.display = (pv === 'outlook') ? 'block' : 'none'; }
        });
        // 域名邮箱登录账号默认跟邮箱地址走，手动改过就不再自动跟
        API_KINDS.forEach(function(k){
          var apiLogin = document.getElementById('panel_login_' + k), touched = false;
          if (!apiLogin) return;
          apiLogin.addEventListener('input', function(){ touched = true; });
          var emailEl = document.getElementById('email');
          if (emailEl) {
            emailEl.addEventListener('input', function(){
              if (!touched && providerSel.value === k) apiLogin.value = this.value;
            });
            if (apiLogin.value === '' && emailEl.value !== '') apiLogin.value = emailEl.value;
          }
        });
        // 选分组就自动填服务器，同时厂商栏同步改成这个分组
        groupSel.addEventListener('change', function(){
          var v = this.value;
          groupNew.style.display = (v === '__new__') ? '' : 'none';
          if (v === '__new__') { groupNew.focus(); return; }
          if (API_KINDS.indexOf(providerSel.value) >= 0) return; // 域名邮箱不用服务器，厂商栏不动
          var p = GROUP_SERVERS[v];
          if (p) { fillServers(p); providerSel.value = 'group:' + v; }
          else { providerSel.value = 'auto'; }
          outlookNote.style.display = 'none';
        });
        document.querySelectorAll('.radio').forEach(function(r){
          r.addEventListener('click', function(){
            document.querySelectorAll('.radio').forEach(function(x){x.classList.remove('on')});
            r.classList.add('on');
          });
        });
        </script>

<?php
}

// 记住我：没登录、浏览器里有记住令牌就恢复登录（在处理任何请求之前）
remember_restore();

// ---------- 请求处理 ----------
$data_ok = ensure_data_dir();
$action = $_POST['action'] ?? '';
$tab = $_GET['tab'] ?? 'inbox';
if (!in_array($tab, ['mailboxes', 'add', 'settings', 'inbox', 'compose', 'read', 'attach'], true)) $tab = 'inbox';
// 分组筛选：点某个分组就只列出该分组的邮箱（收件箱左栏和邮箱管理共用），空就是全部
$mb_group_filter = trim((string)($_GET['mbgroup'] ?? ''));

// 首次设置站点密码
if ($action === 'setup' && check_csrf()) {
    $p1 = (string)($_POST['site_password'] ?? '');
    $p2 = (string)($_POST['site_password2'] ?? '');
    $name = trim((string)($_POST['display_name'] ?? ''));
    $uname = trim((string)($_POST['site_username'] ?? ''));
    if ($uname === '') $uname = 'admin';
    if (mb_strlen($p1) < 8) flash('站点密码至少 8 位。', 'err');
    elseif ($p1 !== $p2) flash('两次输入的站点密码不一致。', 'err');
    elseif (mb_strlen($uname) > 32) flash('登录账号最多 32 个字。', 'err');
    elseif (!$data_ok) flash('数据目录写不进去：' . DATA_DIR . '，先按 README 建好这个目录。', 'err');
    else {
        get_salt();
        save_site(['hash' => password_hash($p1, PASSWORD_DEFAULT), 'username' => $uname, 'display_name' => $name, 'created' => date('Y-m-d H:i')]);
        $_SESSION['mc_login'] = true;
        $_SESSION['mc_key'] = base64_encode(derive_key($p1));
        session_regenerate_id(true);
        flash('站点密码已设置好，以后用账号 ' . $uname . ' + 这个密码进管理中心。');
        header('Location: index.php?tab=mailboxes'); exit;
    }
    header('Location: index.php'); exit;
}
// 登录：账号 + 站点密码，账号不区分大小写
if ($action === 'login' && check_csrf()) {
    $site = load_site();
    $u = trim((string)($_POST['site_username'] ?? ''));
    $p = (string)($_POST['site_password'] ?? '');
    // 老版本没存过账号，默认就是 admin
    $wantUser = (string)($site['username'] ?? 'admin');
    $userOk = $u !== '' && $wantUser !== '' && hash_equals(strtolower($wantUser), strtolower($u));
    if ($site && $userOk && password_verify($p, (string)$site['hash'])) {
        $_SESSION['mc_login'] = true;
        $_SESSION['mc_key'] = base64_encode(derive_key($p));
        session_regenerate_id(true);
        if (!empty($_POST['remember'])) {
            $rd = remember_days_valid((int)($_POST['remember_days'] ?? REMEMBER_DAYS));
            // 记住这次选的时长，下次登录默认就用它
            $site['remember_days'] = $rd;
            save_site($site);
            remember_issue((string)$_SESSION['mc_key'], (string)$site['hash'], $rd);
        } else {
            // 这次没勾记住我：把浏览器里旧的记住令牌也吊销掉
            $oldHex = (string)($_COOKIE[REMEMBER_COOKIE] ?? '');
            if ($oldHex !== '') {
                remember_revoke($oldHex);
                remember_clear_cookie();
            }
        }
        header('Location: index.php?tab=mailboxes'); exit;
    }
    flash('登录账号或站点密码不对，请再试一次。', 'err');
    header('Location: index.php'); exit;
}
// 退出：会话和记住令牌一起清掉
if ($action === 'logout' && check_csrf()) {
    $oldHex = (string)($_COOKIE[REMEMBER_COOKIE] ?? '');
    if ($oldHex !== '') {
        remember_revoke($oldHex);
        remember_clear_cookie();
    }
    $_SESSION = [];
    session_destroy();
    header('Location: index.php'); exit;
}

$site = load_site();
$key = (string)($_SESSION['mc_key'] ?? '');

// TG 新邮件通知的轮询入口：给定时任务（Serv00 Cron 或 cron-job.org）调，
// 不用登录，凭 tg_key 鉴权；没开通知、key 不对都直接拒绝，不透露原因。
if (isset($_GET['tgcheck'])) {
    header('Content-Type: text/plain; charset=utf-8');
    $tkey = (string)($_GET['key'] ?? '');
    if (empty($site['tg_enabled']) || $tkey === '' || empty($site['tg_key']) || !hash_equals((string)$site['tg_key'], $tkey)) { http_response_code(403); echo "forbidden\n"; exit; }
    $nsec = tg_notify_secret();
    $skey = decrypt_cred((string)($site['notify_key_blob'] ?? ''), $nsec);
    if (!is_string($skey) || $skey === '') { echo "notify key unavailable\n"; exit; }
    [$checked, $sent, $notes] = tg_check_all($skey, load_mailboxes(), $site);
    $site['tg_last_run'] = tg_now_bj() . ' 查 ' . $checked . ' 个邮箱，推 ' . $sent . ' 条' . ($notes !== '' ? '，' . $notes : '');
    save_site($site);
    echo 'checked=' . $checked . ' sent=' . $sent . ($notes !== '' ? ' notes=' . $notes : '') . "\n";
    exit;
}

// 登录后操作（都要 CSRF）
if (logged_in() && $action !== '' && check_csrf()) {
    $list = load_mailboxes();
    // 添加邮箱：先测后存（测不通过也允许保存，但状态会记为连接失败）
    // 带 edit_id 时是修改已保存邮箱的登录方式 / 凭据，不是新加
    if ($action === 'add' || $action === 'test_add') {
        $edit_id = (string)($_POST['edit_id'] ?? '');
        $email = trim((string)($_POST['email'] ?? ''));
        $dname = trim((string)($_POST['display_name'] ?? ''));
        $group = trim((string)($_POST['group'] ?? ''));
        // 分组下拉选了“新建分组”时，用下面输入框里起的名字
        if ($group === '__new__') $group = trim((string)($_POST['group_new'] ?? ''));
        if ($group === '') $group = '未分组';
        $method = ($_POST['method'] ?? 'authcode') === 'password' ? 'password' : 'authcode';
        $cred = (string)($_POST['credential'] ?? '');
        $ihost = trim((string)($_POST['imap_host'] ?? ''));
        $iport = (int)($_POST['imap_port'] ?? 993);
        $ienc = in_array(($_POST['imap_enc'] ?? 'ssl'), ['ssl', 'tls'], true) ? (string)$_POST['imap_enc'] : 'ssl';
        $shost = trim((string)($_POST['smtp_host'] ?? ''));
        $sport = (int)($_POST['smtp_port'] ?? 587);
        $senc = in_array(($_POST['smtp_enc'] ?? 'tls'), ['ssl', 'tls'], true) ? (string)$_POST['smtp_enc'] : 'tls';
        // 域名邮箱字段：面板地址、面板登录账号；kind 由厂商栏决定（在注册表里的就是域名邮箱）
        $kind = mc_api_is_api_kind((string)($_POST['provider'] ?? '')) ? (string)$_POST['provider'] : 'imap';
        $panel_url = trim((string)($_POST['panel_url'] ?? ''));
        if ($panel_url === '') $panel_url = trim((string)($_POST[$kind . '_panel'] ?? '')); // 兼容旧版表单
        $panel_login = trim((string)($_POST['panel_login'] ?? ''));
        if ($panel_login === '') $panel_login = trim((string)($_POST[$kind . '_login'] ?? ''));
        $panel_password = trim((string)($_POST['panel_password'] ?? ''));
        if ($panel_password === '') $panel_password = trim((string)($_POST[$kind . '_password'] ?? ''));
        // 域名邮箱的密码填在蓝框里；没填就用上面共用的密码框（兼容旧版表单）
        if (mc_api_is_api_kind($kind) && $panel_password !== '') $cred = $panel_password;
        // 旧字段名也留一份，方便回滚到 v4.29 前的版本直接读
        $henna_panel = $kind === 'henna' ? $panel_url : trim((string)($_POST['henna_panel'] ?? ''));
        $henna_login = $kind === 'henna' ? $panel_login : trim((string)($_POST['henna_login'] ?? ''));
        $henna_password = $kind === 'henna' ? $panel_password : trim((string)($_POST['henna_password'] ?? ''));
        $cloudmail_panel = $kind === 'cloudmail' ? $panel_url : trim((string)($_POST['cloudmail_panel'] ?? ''));
        $cloudmail_login = $kind === 'cloudmail' ? $panel_login : trim((string)($_POST['cloudmail_login'] ?? ''));
        $cloudmail_password = $kind === 'cloudmail' ? $panel_password : trim((string)($_POST['cloudmail_password'] ?? ''));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            flash('邮箱地址格式不对，请填完整地址，如 xxx@qq.com。', 'err');
            $_SESSION['add_draft'] = compact('email', 'dname', 'group', 'method', 'cred', 'ihost', 'iport', 'ienc', 'shost', 'sport', 'senc', 'kind', 'panel_url', 'panel_login', 'panel_password', 'henna_panel', 'henna_login', 'henna_password', 'cloudmail_panel', 'cloudmail_login', 'cloudmail_password');
            $_SESSION['add_draft']['edit_id'] = $edit_id;
        } elseif ($cred === '') {
            flash(mc_api_is_api_kind($kind) ? mc_api_label($kind) . ' 登录密码没填。' : '密码 / 授权码没填。', 'err');
            $_SESSION['add_draft'] = compact('email', 'dname', 'group', 'method', 'cred', 'ihost', 'iport', 'ienc', 'shost', 'sport', 'senc', 'kind', 'panel_url', 'panel_login', 'panel_password', 'henna_panel', 'henna_login', 'henna_password', 'cloudmail_panel', 'cloudmail_login', 'cloudmail_password');
            $_SESSION['add_draft']['edit_id'] = $edit_id;
        } elseif (mc_api_is_api_kind($kind) && $panel_login === '') {
            flash(mc_api_label($kind) . ' 登录账号没填。', 'err');
            $_SESSION['add_draft'] = compact('email', 'dname', 'group', 'method', 'cred', 'ihost', 'iport', 'ienc', 'shost', 'sport', 'senc', 'kind', 'panel_url', 'panel_login', 'panel_password', 'henna_panel', 'henna_login', 'henna_password', 'cloudmail_panel', 'cloudmail_login', 'cloudmail_password');
            $_SESSION['add_draft']['edit_id'] = $edit_id;
        } else {
            $prov = provider_for($email);
            // 域名邮箱不测 IMAP，走适配器 API 测登录
            if (mc_api_is_api_kind($kind)) {
                [$ok, $msg] = mc_api_test($kind, $panel_url, $panel_login, $cred, $email);
            } else {
                [$ok, $msg] = test_imap($ihost, $iport, $email, $cred);
            }
            if ($action === 'test_add') {
                flash(($ok ? '测试成功：' : '测试失败：') . $msg, $ok ? 'ok' : 'err');
                // 测试不保存，把填过的值带回表单（密码 / 授权码也带回，点了测试不用重新填）
                $_SESSION['add_draft'] = compact('email', 'dname', 'group', 'method', 'cred', 'ihost', 'iport', 'ienc', 'shost', 'sport', 'senc', 'kind', 'panel_url', 'panel_login', 'panel_password', 'henna_panel', 'henna_login', 'henna_password', 'cloudmail_panel', 'cloudmail_login', 'cloudmail_password');
                $_SESSION['add_draft']['edit_id'] = $edit_id;
            } else {
                $found = false;
                if ($edit_id !== '') {
                    foreach ($list as &$m) {
                        if ($m['id'] === $edit_id) {
                            $m['display_name'] = $dname; $m['group'] = $group; $m['provider'] = (mc_api_is_api_kind($kind) ? mc_api_label($kind) : $prov[0]); $m['method'] = $method;
                            $m['kind'] = $kind; $m['panel_url'] = $panel_url; $m['panel_login'] = $panel_login; $m['henna_panel'] = $henna_panel; $m['henna_login'] = $henna_login; $m['cloudmail_panel'] = $cloudmail_panel; $m['cloudmail_login'] = $cloudmail_login;
                            $m['imap_host'] = $ihost; $m['imap_port'] = $iport; $m['imap_enc'] = $ienc;
                            $m['smtp_host'] = $shost; $m['smtp_port'] = $sport; $m['smtp_enc'] = $senc;
                            $m['credential'] = encrypt_cred($cred, $key);
                            // 改回密码 / 授权码登录：微软登录的标记和令牌一起清掉
                            $m['auth'] = ''; $m['ms_access'] = ''; $m['ms_refresh'] = ''; $m['ms_expires_at'] = 0;
                            $m['status'] = $ok ? 'ok' : 'fail'; $m['last_test'] = date('Y-m-d H:i');
                            $m['last_error'] = $ok ? '' : $msg;
                            $found = true; break;
                        }
                    }
                    unset($m);
                }
                if (!$found) {
                    $list[] = [
                        'id' => bin2hex(random_bytes(8)),
                        'email' => $email, 'display_name' => $dname, 'group' => $group,
                        'provider' => (mc_api_is_api_kind($kind) ? mc_api_label($kind) : $prov[0]), 'method' => $method, 'auth' => '',
                        'kind' => $kind, 'panel_url' => $panel_url, 'panel_login' => $panel_login, 'henna_panel' => $henna_panel, 'henna_login' => $henna_login, 'cloudmail_panel' => $cloudmail_panel, 'cloudmail_login' => $cloudmail_login,
                        'imap_host' => $ihost, 'imap_port' => $iport, 'imap_enc' => $ienc,
                        'smtp_host' => $shost, 'smtp_port' => $sport, 'smtp_enc' => $senc,
                        'credential' => encrypt_cred($cred, $key),
                        'status' => $ok ? 'ok' : 'fail', 'last_test' => date('Y-m-d H:i'),
                        'last_error' => $ok ? '' : $msg,
                    ];
                }
                save_mailboxes($list);
                // 改了登录方式 / 凭据：这个邮箱的列表缓存清掉，下次现场取
                if ($edit_id !== '') mail_clear_cache($edit_id);
                unset($_SESSION['add_draft']);
                flash($ok ? ($found ? '登录方式已改好，连接测试也通过了。' : '已保存，连接测试也通过了。') : '已保存，但连接测试没通过：' . $msg, $ok ? 'ok' : 'err');
                // 保存后留在当前添加页，不跳去邮箱管理，方便连续加下一个邮箱
                $return_tab = in_array(($_POST['return_tab'] ?? 'add'), ['add', 'mailboxes'], true) ? (string)$_POST['return_tab'] : 'add';
                header('Location: index.php?tab=' . $return_tab . ($return_tab === 'add' && $edit_id !== '' ? '&edit=' . urlencode($edit_id) : '')); exit;
            }
        }
        $return_tab = in_array(($_POST['return_tab'] ?? 'add'), ['add', 'mailboxes'], true) ? (string)$_POST['return_tab'] : 'add';
        header('Location: index.php?tab=' . $return_tab . ($return_tab === 'add' && $edit_id !== '' ? '&edit=' . urlencode($edit_id) : '')); exit;
    }
    // 测试已保存的邮箱
    if ($action === 'test_one') {
        $id = (string)($_POST['id'] ?? '');
        foreach ($list as &$m) {
            if ($m['id'] === $id) {
                // 微软登录的邮箱：不测密码，测令牌能不能拿到（过期了自动刷新）
                if (($m['auth'] ?? '') === 'ms') {
                    $token = ms_valid_access_token($m, $key);
                    if ($token === '') {
                        $m['status'] = 'fail'; $m['last_error'] = '微软登录的令牌拿不到了，请删除后重新用微软账号登录添加。';
                        flash('微软登录的令牌拿不到了，请删除后重新用微软账号登录添加。', 'err');
                    } else {
                        $m['status'] = 'ok'; $m['last_test'] = date('Y-m-d H:i'); $m['last_error'] = '';
                        flash('微软登录正常，令牌有效。');
                    }
                    break;
                }
                // 域名邮箱：不测 IMAP，走适配器 API 测登录
                if (mc_api_is_api_kind((string)($m['kind'] ?? 'imap'))) {
                    $cred = decrypt_cred((string)$m['credential'], $key);
                    if ($cred === null) {
                        $m['status'] = 'fail'; $m['last_error'] = '凭据解不开了：站点密码改过或重置过，请删除这个邮箱后重新添加。';
                        flash('凭据解不开了，请删除后重新添加这个邮箱。', 'err');
                    } else {
                        [$ok, $msg] = mc_api_test((string)($m['kind'] ?? 'imap'), mc_api_panel_of($m), mc_api_login_of($m), $cred, (string)$m['email']);
                        $m['status'] = $ok ? 'ok' : 'fail';
                        $m['last_test'] = date('Y-m-d H:i');
                        $m['last_error'] = $ok ? '' : $msg;
                        flash(($ok ? '测试成功：' : '测试失败：') . $msg, $ok ? 'ok' : 'err');
                    }
                    break;
                }
                $cred = decrypt_cred((string)$m['credential'], $key);
                if ($cred === null) {
                    $m['status'] = 'fail'; $m['last_error'] = '凭据解不开了：站点密码改过或重置过，请删除这个邮箱后重新添加。';
                    flash('凭据解不开了，请删除后重新添加这个邮箱。', 'err');
                } else {
                    [$ok, $msg] = test_imap((string)$m['imap_host'], (int)$m['imap_port'], (string)$m['email'], $cred);
                    $m['status'] = $ok ? 'ok' : 'fail';
                    $m['last_test'] = date('Y-m-d H:i');
                    $m['last_error'] = $ok ? '' : $msg;
                    flash(($ok ? '测试成功：' : '测试失败：') . $msg, $ok ? 'ok' : 'err');
                }
                break;
            }
        }
        unset($m);
        save_mailboxes($list);
        header('Location: index.php?tab=mailboxes'); exit;
    }
    // 修改已保存邮箱的登录方式 / 凭据（不用删了重加）
    // 注意：add 动作里若带 edit_id，就是改这个邮箱，不是新加。
    // 删除邮箱
    if ($action === 'delete') {
        $id = (string)($_POST['id'] ?? '');
        $list = array_values(array_filter($list, fn($m) => $m['id'] !== $id));
        save_mailboxes($list);
        mail_clear_cache($id);
        flash('已删除这个邮箱。');
        header('Location: index.php?tab=mailboxes'); exit;
    }
    // 拖动排序：按提交的 id 顺序重排邮箱列表（列表顺序就是显示顺序）
    if ($action === 'reorder') {
        $order = (string)($_POST['order'] ?? '');
        $ids = array_values(array_filter(array_map('trim', explode(',', $order))));
        if ($ids !== []) {
            $by_id = [];
            foreach ($list as $m) { $by_id[(string)$m['id']] = $m; }
            $new = [];
            foreach ($ids as $id) { if (isset($by_id[$id])) { $new[] = $by_id[$id]; unset($by_id[$id]); } }
            foreach ($list as $m) { if (isset($by_id[(string)$m['id']])) $new[] = $m; }
            save_mailboxes($new);
            flash('排序已保存。');
        }
        header('Location: index.php?tab=mailboxes'); exit;
    }
    // 改分组：只改一个邮箱的分组名，不动别的
    if ($action === 'set_group') {
        $id = (string)($_POST['id'] ?? '');
        $g = trim((string)($_POST['group'] ?? ''));
        if ($g === '') $g = '未分组';
        foreach ($list as &$m) {
            if ($m['id'] === $id) { $m['group'] = $g; break; }
        }
        unset($m);
        save_mailboxes($list);
        flash('分组已改成“' . $g . '”。');
        header('Location: index.php?tab=mailboxes'); exit;
    }
    // 改分组名：把整个分组的名字改掉，这个分组里的邮箱一起跟着改，不用一个个改
    if ($action === 'rename_group') {
        $old = trim((string)($_POST['old_group'] ?? ''));
        $new = trim((string)($_POST['new_group'] ?? ''));
        if ($old === '') $old = '未分组';
        if ($new === '') { flash('新分组名不能为空。', 'err'); header('Location: index.php?tab=mailboxes'); exit; }
        if ($old === $new) { flash('新分组名和旧的一样，不用改。', 'err'); header('Location: index.php?tab=mailboxes'); exit; }
        $n = 0;
        foreach ($list as &$m) {
            $g = trim((string)($m['group'] ?? '')) !== '' ? trim((string)$m['group']) : '未分组';
            if ($g === $old) { $m['group'] = $new; $n++; }
        }
        unset($m);
        save_mailboxes($list);
        flash('分组“' . $old . '”已改成“' . $new . '”，共 ' . $n . ' 个邮箱跟着改了。');
        header('Location: index.php?tab=mailboxes'); exit;
    }
    // 发信：在本站写好直接发，成功后尽力把副本存到已发送（存不进也不算发信失败）
    if ($action === 'send_mail') {
        $mb_id = (string)($_POST['mb'] ?? '');
        $to = mail_split_addrs((string)($_POST['to'] ?? ''));
        $cc = mail_split_addrs((string)($_POST['cc'] ?? ''));
        $subject = trim((string)($_POST['subject'] ?? ''));
        $body = (string)($_POST['body'] ?? '');
        $mbx = null;
        foreach ($list as $m) { if ($m['id'] === $mb_id) { $mbx = $m; break; } }
        if (!$mbx) { $mbx = $list[0] ?? null; }
        if (!$mbx) {
            flash('还没有邮箱，先去添加邮箱。', 'err');
        } elseif (empty($to)) {
            flash('收件人没填对，请填完整邮箱地址，多个用逗号隔开。', 'err');
            $_SESSION['compose_draft'] = ['mb' => $mbx['id'], 'to' => (string)($_POST['to'] ?? ''), 'cc' => (string)($_POST['cc'] ?? ''), 'subject' => $subject, 'body' => $body];
        } else {
            $cred = decrypt_cred((string)$mbx['credential'], $key);
            $from_name = trim((string)($mbx['display_name'] ?? '')) !== '' ? (string)$mbx['display_name'] : (string)($site['display_name'] ?? '');
            // 微软登录的邮箱：拿令牌拼 XOAUTH2 认证串发信，不用密码
            $xoauth = '';
            if (($mbx['auth'] ?? '') === 'ms') {
                $token = ms_valid_access_token($mbx, $key);
                if ($token === '') {
                    flash('微软登录的令牌拿不到了，请删除这个邮箱后重新用微软账号登录添加。', 'err');
                    $_SESSION['compose_draft'] = ['mb' => $mbx['id'], 'to' => (string)($_POST['to'] ?? ''), 'cc' => (string)($_POST['cc'] ?? ''), 'subject' => $subject, 'body' => $body];
                    header('Location: index.php?tab=compose&mb=' . urlencode($mbx['id'] ?? '')); exit;
                }
                $xoauth = ms_token_blob((string)$mbx['email'], $token);
            }
            // 域名邮箱：不走 SMTP，走适配器 API 发（纯文本；抄送并进收件人）
            if (mc_api_is_api_kind((string)($mbx['kind'] ?? 'imap'))) {
                [$s_ok, $s_msg] = mc_api_send((string)($mbx['kind'] ?? 'imap'), $mbx, (string)$cred, array_merge($to, $cc), $subject, $body);
                $r = ['ok' => $s_ok, 'err' => $s_msg];
            } else {
                $r = mail_smtp_send($mbx, (string)$cred, (string)$mbx['email'], $from_name, $to, $cc, $subject, $body, $xoauth);
            }
            if (!$r['ok']) {
                flash('发送失败：' . $r['err'], 'err');
                $_SESSION['compose_draft'] = ['mb' => $mbx['id'], 'to' => (string)($_POST['to'] ?? ''), 'cc' => (string)($_POST['cc'] ?? ''), 'subject' => $subject, 'body' => $body];
            } else {
                // 域名邮箱：已发送在各自面板里就有，不用再往 IMAP 已发送里追加一份
                if (!mc_api_is_api_kind((string)($mbx['kind'] ?? 'imap'))) {
                    [$fp, $map, $merr] = mail_connect_current($mbx, (string)$cred);
                    if ($fp) {
                        // 已发送按常用名一个一个试，找到就把副本存进去；找不到就不存，不影响发信本身
                        $op = mail_imap_open_folder($fp, 'sent', $map);
                        if ($op['ok']) {
                            mail_imap_append($fp, $op['name'], mail_build_sent_raw((string)$mbx['email'], $from_name, $to, $cc, $subject, $body));
                        }
                    }
                    mail_close($fp ?? null);
                }
                unset($_SESSION['compose_draft']);
                // 发出去了，已发送的列表缓存清掉，下次现场取
                mail_clear_cache((string)$mbx['id']);
                flash('已发送。');
            }
        }
        header('Location: index.php?tab=' . (isset($_SESSION['compose_draft']) ? 'compose' : 'inbox&folder=sent') . '&mb=' . urlencode($mbx['id'] ?? '')); exit;
    }
    // 删除 / 标记垃圾邮件：移到已删除或垃圾邮件文件夹
    if ($action === 'mail_move') {
        $mb_id = (string)($_POST['mb'] ?? '');
        $uid = (int)($_POST['uid'] ?? 0);
        $folder = (string)($_POST['folder'] ?? 'inbox');
        $dest_label = (string)($_POST['dest'] ?? 'trash');
        $mbx = null;
        foreach ($list as $m) { if ($m['id'] === $mb_id) { $mbx = $m; break; } }
        if (!$mbx) { $mbx = $list[0] ?? null; }
        if (!$mbx || $uid <= 0) {
            flash('这封邮件找不到了。', 'err');
        } else {
            $cred = decrypt_cred((string)$mbx['credential'], $key);
            // 域名邮箱：没有已删除也没有垃圾箱，删除按适配器走（Henna 是彻底删除）
            if (mc_api_is_api_kind((string)($mbx['kind'] ?? 'imap'))) {
                [$d_ok, $d_msg] = mc_api_delete((string)($mbx['kind'] ?? 'imap'), $mbx, (string)$cred, $uid);
                flash($d_msg, $d_ok ? 'ok' : 'err');
                if ($d_ok) mail_clear_cache((string)$mbx['id']);
            } else {
            [$fp, $map, $merr] = mail_connect_current($mbx, (string)$cred);
            if (!$fp) {
                flash('连不上邮箱：' . $merr, 'err');
            } else {
                $op = mail_imap_open_folder($fp, $folder, $map);
                if (!$op['ok']) {
                    flash('打不开当前文件夹。', 'err');
                } else {
                    $r = mail_imap_move_to($fp, $uid, $dest_label, $map);
                    flash($r['ok'] ? ($dest_label === 'spam' ? '已移到垃圾箱。' : '已移到已删除。') : ($dest_label === 'spam' ? '找不到垃圾箱文件夹，厂商可能没建这个文件夹。' : '找不到已删除文件夹，厂商可能没建这个文件夹。'), $r['ok'] ? 'ok' : 'err');
                    if ($r['ok']) mail_clear_cache((string)$mbx['id']);
                }
                mail_close($fp);
            }
            } // 域名邮箱删除不走上面这段 IMAP
        }
        // 从全部收件箱里删的，删完回全部收件箱，不回单个邮箱
        $back_all = (($_POST['all'] ?? '') === '1');
        header('Location: index.php?tab=inbox&folder=' . urlencode($folder) . '&mb=' . ($back_all ? 'all&all=1' : urlencode($mbx['id'] ?? ''))); exit;
    }
    // 设置：改站点密码（要把所有邮箱凭据用新密钥重新加密）
    if ($action === 'change_password') {
        $cur = (string)($_POST['current_password'] ?? '');
        $n1 = (string)($_POST['new_password'] ?? '');
        $n2 = (string)($_POST['new_password2'] ?? '');
        if (!password_verify($cur, (string)$site['hash'])) flash('当前站点密码不对。', 'err');
        elseif (mb_strlen($n1) < 8) flash('新站点密码至少 8 位。', 'err');
        elseif ($n1 !== $n2) flash('两次输入的新密码不一致。', 'err');
        else {
            $old_key = $key;
            $new_key = base64_encode(derive_key($n1));
            $bad = 0;
            foreach ($list as &$m) {
                $plain = decrypt_cred((string)$m['credential'], $old_key);
                if ($plain === null) { $bad++; continue; }
                $m['credential'] = encrypt_cred($plain, $new_key);
                // 微软登录的令牌也是同一把密钥加密的，一起换
                foreach (['ms_access', 'ms_refresh'] as $f) {
                    if (!empty($m[$f])) {
                        $tp = decrypt_cred((string)$m[$f], $old_key);
                        if ($tp !== null) $m[$f] = encrypt_cred($tp, $new_key);
                    }
                }
            }
            unset($m);
            save_mailboxes($list);
            // 微软的 Client ID / Secret 也是同一把密钥加密的，一起换
            foreach (['ms_client_id', 'ms_client_secret'] as $f) {
                if (!empty($site[$f])) {
                    $sp = decrypt_cred((string)$site[$f], $old_key);
                    if ($sp !== null) $site[$f] = encrypt_cred($sp, $new_key);
                }
            }
            // TG 轮询用的站点密钥副本也要跟着换（它是用 notify 密钥加密的）
            if (!empty($site['notify_key_blob'])) {
                $nsec = tg_notify_secret();
                $site['notify_key_blob'] = encrypt_cred($new_key, $nsec);
            }
            $site['hash'] = password_hash($n1, PASSWORD_DEFAULT);
            save_site($site);
            $_SESSION['mc_key'] = $new_key;
            session_regenerate_id(true);
            // 密码换了，派生密钥也换了：所有记住我的令牌都作废，下次要重新登录
            remember_revoke(null);
            remember_clear_cookie();
            flash($bad > 0 ? '站点密码已改，但有 ' . $bad . ' 个邮箱的凭据解不开，需要重新添加。' : '站点密码已改好，邮箱凭据已用新密钥重新加密。');
        }
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：改登录账号（要当前站点密码确认；密码本身不动，邮箱凭据也不用重加密）
    if ($action === 'change_username') {
        $cur = (string)($_POST['current_password'] ?? '');
        $nu = trim((string)($_POST['new_username'] ?? ''));
        if (!password_verify($cur, (string)$site['hash'])) flash('当前站点密码不对。', 'err');
        elseif ($nu === '' || mb_strlen($nu) > 32) flash('新登录账号不能为空，最多 32 个字。', 'err');
        else {
            $site['username'] = $nu;
            save_site($site);
            flash('登录账号已改成 ' . $nu . '，下次登录用新账号。');
        }
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：记住我默认时长（3 个月 / 6 个月 / 1 年）
    if ($action === 'remember_days_save') {
        $d = remember_days_valid((int)($_POST['remember_days'] ?? REMEMBER_DAYS));
        $site['remember_days'] = $d;
        save_site($site);
        flash('记住我默认时长已改成 ' . remember_options()[$d] . '，下次登录时默认就用这个。');
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：退出所有记住的设备（吊销全部记住令牌）
    if ($action === 'revoke_remember') {
        remember_revoke(null);
        remember_clear_cookie();
        flash('已退出所有记住的设备，下次打开要重新登录。');
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：改默认显示名
    if ($action === 'change_name') {
        $site['display_name'] = trim((string)($_POST['display_name'] ?? ''));
        save_site($site);
        flash('显示名称已保存。');
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：收件箱列表缓存时间（分钟，1–60，默认 1）
    if ($action === 'cache_save') {
        $mins = (int)($_POST['cache_ttl'] ?? 1);
        if ($mins < 1) $mins = 1;
        if ($mins > 60) $mins = 60;
        $site['cache_ttl'] = $mins;
        save_site($site);
        flash('收件箱列表缓存已设为 ' . $mins . ' 分钟。');
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：TG 新邮件通知（开关 + 直连 chat_id/Token + 中转地址；开启时生成轮询密钥并存站点密钥副本）
    if ($action === 'tg_save') {
        $site['tg_worker'] = trim((string)($_POST['tg_worker'] ?? ''));
        $tg_chat = trim((string)($_POST['tg_chat_id'] ?? ''));
        $tg_token = trim((string)($_POST['tg_bot_token'] ?? ''));
        // chat_id 明文显示：提交什么就存什么（空 = 清空）
        $site['tg_chat_id'] = $tg_chat === '' ? '' : encrypt_cred($tg_chat, $key);
        // Token 框里显示的是 **** + 后 4 位：以 **** 开头 = 没改，沿用已保存的；
        // 空 = 清空；其他 = 新 Token，存起来（真 Token 不会以 **** 开头）
        if (str_starts_with($tg_token, '****')) {
            // 没改
        } elseif ($tg_token === '') {
            $site['tg_bot_token'] = '';
        } else {
            $site['tg_bot_token'] = encrypt_cred($tg_token, $key);
        }
        $on = !empty($_POST['tg_enabled']);
        $site['tg_enabled'] = $on ? 1 : 0;
        if ($on) {
            if (empty($site['tg_key'])) $site['tg_key'] = bin2hex(random_bytes(16));
            $nsec = tg_notify_secret();
            $site['notify_key_blob'] = encrypt_cred($key, $nsec);
        }
        save_site($site);
        flash($on ? 'TG 通知已开启，定时任务按设置页里的地址每 5 分钟调一次就行。' : 'TG 通知已关掉。');
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：TG 发一条测试通知（直连和中转都走 tg_send_msg，和真通知同一条路）
    if ($action === 'tg_test') {
        [$ok, $err] = tg_send_msg($site, $key, "📧 测试通知\n邮箱管理中心的 TG 通知已接通，时间：" . tg_now_bj() . "（北京时间）。以后有新邮件就会按这个格式推给你。");
        flash($ok ? '测试通知已发出，去 TG 看一眼。' : '测试通知没发出去：' . $err, $ok ? 'ok' : 'err');
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：立即查一轮新邮件并通知（用当前登录的密钥，不用轮询密钥）
    if ($action === 'tg_check_now') {
        if (empty($site['tg_enabled'])) { flash('先把 TG 通知开关打开再查。', 'err'); header('Location: index.php?tab=settings'); exit; }
        [$checked, $sent, $notes] = tg_check_all($key, $list, $site);
        $site['tg_last_run'] = tg_now_bj() . ' 查 ' . $checked . ' 个邮箱，推 ' . $sent . ' 条' . ($notes !== '' ? '，' . $notes : '');
        save_site($site);
        flash('查了 ' . $checked . ' 个邮箱，推了 ' . $sent . ' 条 TG 通知。' . ($notes !== '' ? '备注：' . $notes : ''));
        header('Location: index.php?tab=settings'); exit;
    }
    // 设置：保存微软 OAuth 应用信息（Client ID + Client Secret，加密存）
    if ($action === 'ms_save') {
        $ms_id = trim((string)($_POST['ms_client_id'] ?? ''));
        $ms_secret = trim((string)($_POST['ms_client_secret'] ?? ''));
        $old_cfg = ms_config($key);
        if ($ms_id === '' && $ms_secret === '') {
            // 两个都空 = 清空
            ms_save_config($key, '', '');
            flash('微软登录信息已清空。');
        } else {
            // 只填了一个：留空的那个沿用已保存的值；两个都没保存过就报错
            if ($ms_id === '') $ms_id = $old_cfg['id'];
            if ($ms_secret === '') $ms_secret = $old_cfg['secret'];
            if ($ms_id === '' || $ms_secret === '') {
                flash('Client ID 和 Client Secret 要两个一起填，只填一个保存不了。', 'err');
            } else {
                ms_save_config($key, $ms_id, $ms_secret);
                flash('微软登录信息已保存，现在可以去添加邮箱，用微软账号登录添加 Outlook / Hotmail。');
            }
        }
        header('Location: index.php?tab=settings'); exit;
    }
}

$flash = take_flash();
$mailboxes = logged_in() ? load_mailboxes() : [];
$draft = $_SESSION['add_draft'] ?? [];
unset($_SESSION['add_draft']);
// 正在改哪个邮箱的登录方式（?tab=add&edit=<id>），没传就是新加
$edit_id = (string)($_GET['edit'] ?? ($draft['edit_id'] ?? ''));
$edit_box = null;
if ($edit_id !== '') {
    foreach ($mailboxes as $mb) { if ($mb['id'] === $edit_id) { $edit_box = $mb; break; } }
    if ($edit_box) {
        $draft = array_merge(['email' => $edit_box['email'], 'dname' => $edit_box['display_name'] ?? '', 'group' => $edit_box['group'] ?? '未分组', 'method' => $edit_box['method'] ?? 'authcode', 'cred' => decrypt_cred((string)($edit_box['credential'] ?? ''), $key) ?? '', 'ihost' => $edit_box['imap_host'] ?? '', 'iport' => $edit_box['imap_port'] ?? 993, 'ienc' => $edit_box['imap_enc'] ?? 'ssl', 'shost' => $edit_box['smtp_host'] ?? '', 'sport' => $edit_box['smtp_port'] ?? 587, 'senc' => $edit_box['smtp_enc'] ?? 'tls', 'kind' => $edit_box['kind'] ?? 'imap', 'panel_url' => mc_api_panel_of($edit_box), 'panel_login' => mc_api_login_of($edit_box), 'panel_password' => decrypt_cred((string)($edit_box['credential'] ?? ''), $key) ?? '', 'henna_panel' => $edit_box['henna_panel'] ?? '', 'henna_login' => $edit_box['henna_login'] ?? '', 'cloudmail_panel' => $edit_box['cloudmail_panel'] ?? '', 'cloudmail_login' => $edit_box['cloudmail_login'] ?? '', 'edit_id' => $edit_id], $draft);
    }
}

// ---------- 收发信：当前邮箱与本页要用的数据（只在登录后算） ----------
$cur_mb = null;
$cur_cred = null;
// 全部收件箱：mb=all 或 all=1 时看所有邮箱的最新邮件（列表用 $mail_all，读信仍用 $cur_mb）
$want_mb = (string)($_GET['mb'] ?? $_SESSION['mc_mb'] ?? '');
$mail_all = ($want_mb === 'all' || ($_GET['all'] ?? '') === '1');
if (logged_in() && !empty($mailboxes)) {
    if ($mail_all) {
        // 只定一个备用邮箱（读信、写信兜底用），不改会话里记住的邮箱
        $sess_mb = (string)($_SESSION['mc_mb'] ?? '');
        foreach ($mailboxes as $mb) { if ($mb['id'] === $sess_mb) { $cur_mb = $mb; break; } }
        if (!$cur_mb) $cur_mb = $mailboxes[0];
    } else {
        foreach ($mailboxes as $mb) { if ($mb['id'] === $want_mb) { $cur_mb = $mb; break; } }
        if (!$cur_mb) $cur_mb = $mailboxes[0];
        $_SESSION['mc_mb'] = $cur_mb['id'];
    }
    $cur_cred = decrypt_cred((string)$cur_mb['credential'], $key);
}
$mail_folder = (string)($_GET['folder'] ?? 'inbox');
if (!in_array($mail_folder, ['inbox', 'sent', 'drafts', 'spam', 'trash'], true)) $mail_folder = 'inbox';
$mail_folder_names = ['inbox' => '收件箱', 'spam' => '垃圾箱', 'sent' => '已发送', 'drafts' => '草稿箱', 'trash' => '已删除'];
$mail_page = max(1, (int)($_GET['page'] ?? 1));
$mail_uid = (int)($_GET['uid'] ?? 0);
$mail_err = '';
$mail_note = ''; // 域名邮箱这类没有已删除的邮箱，在这里放一句提示（不是报错）
$mail_folders = [];
$mail_list = [];
$mail_total = 0;
$mail_msg = null;
$mail_refresh = (($_GET['refresh'] ?? '') === '1');
$mail_from_cache = false;
$mail_cache_ts = 0;
$compose_prefill = ['to' => '', 'cc' => '', 'subject' => '', 'body' => ''];
if (logged_in() && $cur_mb && in_array($tab, ['inbox', 'read', 'compose', 'attach'], true)) {
    // 附件下载：先取原邮件、再按序号找附件，找到就直接输出文件并结束
    if ($tab === 'attach') {
        $att_idx = (int)($_GET['att'] ?? -1);
        // 域名邮箱附件：按链接里的 mb 找邮箱，走适配器 API 取流回传
        if (mc_api_is_api_kind((string)($att_mb['kind'] ?? 'imap'))) {
            $att_kind = (string)($att_mb['kind'] ?? 'imap');
            if ($mail_uid > 0 && $att_idx >= 0) {
                $amsg = mc_api_fetch_message($att_kind, $att_mb, (string)$att_cred, $mail_folder, $mail_uid);
                $aatts = (array)($amsg['attachments'] ?? []);
                if (!isset($amsg['error']) && isset($aatts[$att_idx])) {
                    $aatt = $aatts[$att_idx];
                    $dl = mc_api_download($att_kind, $att_mb, (string)$att_cred, $aatt);
                    if (!isset($dl['error'])) {
                        $fname = trim((string)($aatt['filename'] ?? '')) !== '' ? (string)$aatt['filename'] : 'attachment';
                        $fname = str_replace(['"', "\r", "\n"], '', $fname);
                        header('Content-Type: ' . ((string)($aatt['ctype'] ?? $dl['ctype'])));
                        header('Content-Disposition: attachment; filename="' . $fname . '"');
                        header('Content-Length: ' . (string)strlen((string)$dl['body']));
                        echo (string)$dl['body'];
                        exit;
                    }
                }
            }
            flash('附件找不到了，可能是这封邮件没有这个附件。', 'err');
            header('Location: index.php?tab=inbox&folder=' . urlencode($mail_folder) . '&mb=' . urlencode($att_mb['id'])); exit;
        }
        [$fp, $map, $merr] = mail_connect_current($cur_mb, (string)$cur_cred);
        if ($fp) {
            $op = mail_imap_open_folder($fp, $mail_folder, $map);
            if ($op['ok'] && $mail_uid > 0) {
                $fr = mail_imap_fetch_raw($fp, $mail_uid);
                if ($fr['ok'] && $fr['raw'] !== '') {
                    $parsed = mail_parse_mime($fr['raw']);
                    $atts = $parsed['attachments'] ?? [];
                    if (isset($atts[$att_idx])) {
                        $att = $atts[$att_idx];
                        $fname = trim((string)($att['filename'] ?? '')) !== '' ? (string)$att['filename'] : 'attachment';
                        $fname = str_replace(['"', "\r", "\n"], '', $fname);
                        header('Content-Type: ' . ((string)($att['ctype'] ?? 'application/octet-stream')));
                        header('Content-Disposition: attachment; filename="' . $fname . '"');
                        header('Content-Length: ' . (string)strlen((string)$att['data']));
                        echo (string)$att['data'];
                        mail_close($fp);
                        exit;
                    }
                }
            }
        }
        mail_close($fp ?? null);
        flash('附件找不到了，可能是这封邮件没有这个附件。', 'err');
        header('Location: index.php?tab=inbox&folder=' . urlencode($mail_folder) . '&mb=' . urlencode($cur_mb['id'])); exit;
    }
    // 收件箱列表：最新 30 封一页，按 UID 倒序取
    // 三栏布局下读信页也要带列表，所以 inbox 和 read 都拉列表。
    if (in_array($tab, ['inbox', 'read'], true)) {
        if ($mail_all) {
            // 全部收件箱：每个邮箱各取最新 30 封，合起来按时间倒序排，再按页切 30 封
            $merged = [];
            $all_folders = [];
            $unified_errors = [];
            $cache_hits = 0;
            $live_fetches = 0;
            foreach ($mailboxes as $mbx) {
                // 先看缓存：没点刷新、缓存没过期，就直接用，不连 IMAP
                $cached = null;
                if (!$mail_refresh) {
                    $c = mail_cache_read((string)$mbx['id'], $mail_folder);
                    if ($c !== null && (time() - (int)($c['ts'] ?? 0)) < mail_cache_ttl() && is_array($c['list'] ?? null)) {
                        $cached = $c;
                    }
                }
                if ($cached !== null) {
                    $cache_hits++;
                    $cts = (int)$cached['ts'];
                    if ($mail_cache_ts === 0 || $cts < $mail_cache_ts) $mail_cache_ts = $cts;
                    $all_folders = array_merge($all_folders, (array)($cached['folders'] ?? []));
                    foreach ((array)$cached['list'] as $rx) {
                        $rx['mb_id'] = $mbx['id'];
                        $rx['mb_email'] = $mbx['email'];
                        $merged[] = $rx;
                    }
                    continue;
                }
                // 域名邮箱：不走 IMAP，走适配器 API（列表缓存、合并、分页都和上面一样）
                if (mc_api_is_api_kind((string)($mbx['kind'] ?? 'imap'))) {
                    $api_kind = (string)($mbx['kind'] ?? 'imap');
                    $api_map = mc_api_folder_map($api_kind);
                    $all_folders = array_merge($all_folders, $api_map);
                    if (!isset($api_map[$mail_folder])) { $mail_note = mc_api_no_folder_msg($api_kind, $mail_folder); continue; }
                    $credx = decrypt_cred((string)$mbx['credential'], $key);
                    $ares = mc_api_fetch_list($api_kind, $mbx, (string)$credx, $mail_folder, 1, 30);
                    if (isset($ares['error'])) { $unified_errors[] = (string)$mbx['email'] . '：' . (string)$ares['error']; continue; }
                    $live_fetches++;
                    $rowsx = (array)($ares['rows'] ?? []);
                    foreach ($rowsx as $rx) {
                        $rx['mb_id'] = $mbx['id'];
                        $rx['mb_email'] = $mbx['email'];
                        $merged[] = $rx;
                    }
                    mail_cache_write((string)$mbx['id'], $mail_folder, $rowsx, (int)($ares['total'] ?? count($rowsx)), $api_map);
                    continue;
                }
                [$fpx, $mapx, $merrx] = mail_connect_current($mbx, (string)$credx);
                if (!$fpx) { $unified_errors[] = (string)$mbx['email'] . '：' . $merrx; continue; }
                $opx = mail_imap_open_folder($fpx, $mail_folder, $mapx);
                if (!$opx['ok']) { mail_close($fpx); continue; }
                $mapx[$mail_folder] = $opx['name'];
                $all_folders = array_merge($all_folders, $mapx);
                $all_uidsx = mail_imap_uids($fpx);
                $uidsx = array_slice(array_reverse($all_uidsx), 0, 30);
                $rowsx = mail_imap_fetch_list($fpx, $uidsx);
                $live_fetches++;
                foreach ($rowsx as $rx) {
                    $rx['mb_id'] = $mbx['id'];
                    $rx['mb_email'] = $mbx['email'];
                    $merged[] = $rx;
                }
                // 刚取的最新 30 封写进缓存，下次直接读
                mail_cache_write((string)$mbx['id'], $mail_folder, $rowsx, count($all_uidsx), $mapx);
                mail_close($fpx);
            }
            // 这一页的每个邮箱都是缓存来的，才显示“缓存于……”
            if ($cache_hits > 0 && $live_fetches === 0) $mail_from_cache = true;
            $mail_folders = $all_folders;
            if (empty($mail_folders)) $mail_folders = [$mail_folder => $mail_folder];
            usort($merged, function ($a, $b) {
                $ta = strtotime((string)($a['date'] ?? ''));
                $tb = strtotime((string)($b['date'] ?? ''));
                $ta = $ta === false ? 0 : $ta;
                $tb = $tb === false ? 0 : $tb;
                if ($ta !== $tb) return $tb <=> $ta;
                return (int)($b['uid'] ?? 0) <=> (int)($a['uid'] ?? 0);
            });
            $mail_total = count($merged);
            $pages = max(1, (int)ceil($mail_total / 30));
            if ($mail_page > $pages) $mail_page = $pages;
            $mail_list = array_slice($merged, ($mail_page - 1) * 30, 30);
            if ($mail_total === 0 && !empty($unified_errors)) {
                $mail_err = '连不上邮箱：' . $unified_errors[0] . (count($unified_errors) > 1 ? '（等 ' . count($unified_errors) . ' 个邮箱）' : '');
            }
        } else {
            // 第 1 页先看缓存：没点刷新、缓存没过期，就直接用，不连 IMAP；
            // 第 2 页起没有缓存，每次都现场取
            $cached = null;
            if (!$mail_refresh && $mail_page === 1) {
                $c = mail_cache_read((string)$cur_mb['id'], $mail_folder);
                if ($c !== null && (time() - (int)($c['ts'] ?? 0)) < mail_cache_ttl() && is_array($c['list'] ?? null)) {
                    $cached = $c;
                }
            }
            if ($cached !== null) {
                $mail_from_cache = true;
                $mail_cache_ts = (int)$cached['ts'];
                $mail_folders = (array)($cached['folders'] ?? []);
                if (empty($mail_folders)) $mail_folders = [$mail_folder => $mail_folder];
                $mail_list = (array)$cached['list'];
                $mail_total = max((int)($cached['total'] ?? 0), count($mail_list));
            } else {
                // Henna 邮箱：不走 IMAP，走 Henna API（缓存、TTL、刷新都和上面一样）
                // 域名邮箱：不走 IMAP，走适配器 API（缓存、TTL、刷新都和上面一样）
                $api_done = false;
                if (mc_api_is_api_kind((string)($cur_mb['kind'] ?? 'imap'))) {
                    $api_kind = (string)($cur_mb['kind'] ?? 'imap');
                    $api_map = mc_api_folder_map($api_kind);
                    $mail_folders = $api_map;
                    if (!isset($api_map[$mail_folder])) {
                        $mail_note = mc_api_no_folder_msg($api_kind, $mail_folder);
                        $mail_list = [];
                        $mail_total = 0;
                    } else {
                        $ares = mc_api_fetch_list($api_kind, $cur_mb, (string)$cur_cred, $mail_folder, $mail_page, 30);
                        if (isset($ares['error'])) {
                            $mail_err = (string)$ares['error'];
                        } else {
                            $mail_list = (array)($ares['rows'] ?? []);
                            $mail_total = (int)($ares['total'] ?? count($mail_list));
                            // 只有第 1 页才写缓存（缓存里就是最新 30 封）
                            if ($mail_page === 1) mail_cache_write((string)$cur_mb['id'], $mail_folder, $mail_list, $mail_total, $api_map);
                        }
                    }
                    $api_done = true;
                }
                if (!$api_done) {
                [$fp, $map, $merr] = mail_connect_current($cur_mb, (string)$cur_cred);
                if (!$fp) {
                    $mail_err = $merr;
                } else {
                    $mail_folders = $map;
                    // 先试 LIST 映射到的名字，再试这个文件夹的常用名，一个一个打开直到成功
                    $op = mail_imap_open_folder($fp, $mail_folder, $map);
                    if (!$op['ok']) {
                        // 把服务器拒绝的原话也带回来，不然只知道打不开、不知道为什么
                        $why = trim((string)($op['err'] ?? ''));
                        if ($why !== '') {
                            $why = function_exists('mb_substr') ? mb_substr($why, 0, 150) : substr($why, 0, 150);
                        }
                        $mail_err = '打不开“' . $mail_folder_names[$mail_folder] . '”文件夹（试过：' . implode('、', $op['tried']) . '，服务器上都没找到' . ($why !== '' ? '；服务器说：' . $why : '') . '）。';
                    } else {
                        // 打开成功的名字写回映射，后面写缓存、发信追加都用它
                        $map[$mail_folder] = $op['name'];
                        $mail_folders = $map;
                        $uids = mail_imap_uids($fp);
                        $mail_total = count($uids);
                        $pages = max(1, (int)ceil($mail_total / 30));
                        if ($mail_page > $pages) $mail_page = $pages;
                        $slice = array_slice(array_reverse($uids), ($mail_page - 1) * 30, 30);
                        $mail_list = mail_imap_fetch_list($fp, $slice);
                        // 只有第 1 页才写缓存（缓存里就是最新 30 封）
                        if ($mail_page === 1) {
                            mail_cache_write((string)$cur_mb['id'], $mail_folder, $mail_list, $mail_total, $map);
                        }
                    }
                    mail_close($fp);
                }
                } // 域名邮箱不走上面这段 IMAP
            }
        }
    }
    // 读一封信：取全文、标已读、解析正文和附件
    // 三栏布局下 inbox 页带 uid 时也要在右栏读信，所以两个 tab 都算。
    if (in_array($tab, ['inbox', 'read'], true) && $mail_uid > 0) {
        // 全部收件箱里读域名邮箱的信：按链接里的 mb 找到这封信真正属于哪个邮箱
        $read_mb = $cur_mb;
        $read_cred = $cur_cred;
        if ($mail_all) {
            $want_read_mb = (string)($_GET['mb'] ?? '');
            foreach ($mailboxes as $mb) { if ($mb['id'] === $want_read_mb) { $read_mb = $mb; $read_cred = decrypt_cred((string)$mb['credential'], $key); break; } }
        }
        // Henna 邮箱：不走 IMAP，走 Henna API 取全文
        // 域名邮箱：不走 IMAP，走适配器 API 取全文
        $api_read_done = false;
        if (mc_api_is_api_kind((string)($read_mb['kind'] ?? 'imap'))) {
            $api_kind = (string)($read_mb['kind'] ?? 'imap');
            $amsg = mc_api_fetch_message($api_kind, $read_mb, (string)$read_cred, $mail_folder, $mail_uid);
            if (isset($amsg['error'])) {
                $mail_err = (string)$amsg['error'];
            } else {
                // 优先纯文本，没有就用 HTML 剥标签转纯文本
                $abody = trim((string)($amsg['text'] ?? ''));
                if ($abody === '' && trim((string)($amsg['html'] ?? '')) !== '') {
                    $abody = trim(html_entity_decode(strip_tags((string)$amsg['html']), ENT_QUOTES, 'UTF-8'));
                }
                $mail_msg = [
                    'uid' => $mail_uid,
                    'from' => trim((string)($amsg['from_name'] ?? '')) !== '' ? (string)$amsg['from_name'] . ' <' . (string)$amsg['from'] . '>' : (string)$amsg['from'],
                    'to' => (string)($amsg['to'] ?? ''),
                    'cc' => '',
                    'subject' => (string)($amsg['subject'] ?? ''),
                    'date' => (string)($amsg['date'] ?? ''),
                    'body' => $abody,
                    'atts' => (array)($amsg['attachments'] ?? []),
                    'mb_id' => (string)$read_mb['id'],
                    'mb_kind' => $api_kind,
                ];
                mc_api_mark_read($api_kind, $read_mb, (string)$read_cred, $mail_uid);
            }
            $api_read_done = true;
        }
        if (!$api_read_done) {
        [$fp, $map, $merr] = mail_connect_current($cur_mb, (string)$cur_cred);
        if (!$fp) {
            $mail_err = $merr;
        } else {
            // 全部收件箱时文件夹栏用各邮箱的并集，不被单个邮箱的映射覆盖
            if (!$mail_all) $mail_folders = $map;
            $op = mail_imap_open_folder($fp, $mail_folder, $map);
            if (!$op['ok']) {
                $mail_err = '打不开这封邮件所在的文件夹。';
            } else {
                $fr = mail_imap_fetch_raw($fp, $mail_uid);
                if (!$fr['ok'] || $fr['raw'] === '') {
                    $mail_err = '这封邮件取不回来，可能是已经被删了。';
                } else {
                    mail_imap_mark_seen($fp, $mail_uid);
                    $parsed = mail_parse_mime($fr['raw']);
                    $hd = $parsed['headers'] ?? [];
                    $best = mail_mime_best_body($parsed);
                    $mail_msg = [
                        'uid' => $mail_uid,
                        'from' => mail_clean_from_header(mail_decode_header((string)($hd['from'] ?? ''))),
                        'to' => mail_decode_header((string)($hd['to'] ?? '')),
                        'cc' => mail_decode_header((string)($hd['cc'] ?? '')),
                        'subject' => mail_decode_header((string)($hd['subject'] ?? '')),
                        'date' => mail_decode_header((string)($hd['date'] ?? '')),
                        'body' => $best['text'],
                        'atts' => $parsed['attachments'] ?? [],
                    ];
                }
            }
            mail_close($fp);
        }
        } // 域名邮箱不走上面这段 IMAP
    }
    // 写信预填：回复 / 转发先取原邮件；发信失败回来的草稿优先
    if ($tab === 'compose') {
        $cd = $_SESSION['compose_draft'] ?? null;
        if (is_array($cd)) {
            unset($_SESSION['compose_draft']);
            $compose_prefill = ['to' => (string)($cd['to'] ?? ''), 'cc' => (string)($cd['cc'] ?? ''), 'subject' => (string)($cd['subject'] ?? ''), 'body' => (string)($cd['body'] ?? '')];
        } else {
            $ref_uid = (int)($_GET['reply'] ?? $_GET['forward'] ?? 0);
            $is_reply = isset($_GET['reply']);
            if ($ref_uid > 0) {
                // Henna 回复 / 转发：按链接里的 mb 找邮箱，走 Henna API 取原文拼引用
                // 域名邮箱回复 / 转发：按链接里的 mb 找邮箱，走适配器 API 取原文拼引用
                $api_pref_done = false;
                if (mc_api_is_api_kind((string)($pref_mb['kind'] ?? 'imap'))) {
                    $api_kind = (string)($pref_mb['kind'] ?? 'imap');
                    $amsg = mc_api_fetch_message($api_kind, $pref_mb, (string)$pref_cred, $mail_folder, $ref_uid);
                    if (!isset($amsg['error'])) {
                        $abody = trim((string)($amsg['text'] ?? ''));
                        if ($abody === '' && trim((string)($amsg['html'] ?? '')) !== '') {
                            $abody = trim(html_entity_decode(strip_tags((string)$amsg['html']), ENT_QUOTES, 'UTF-8'));
                        }
                        $orig_from = trim((string)($amsg['from_name'] ?? '')) !== '' ? (string)$amsg['from_name'] . ' <' . (string)$amsg['from'] . '>' : (string)$amsg['from'];
                        $orig_subj = (string)($amsg['subject'] ?? '');
                        $orig_date = (string)($amsg['date'] ?? '');
                        $quote = "\n\n--- 原邮件 ---\n发件人：" . $orig_from . "\n时间：" . $orig_date . "\n主题：" . $orig_subj . "\n\n" . $abody;
                        if ($is_reply) {
                            $compose_prefill = [
                                'to' => (string)($amsg['from'] ?? ''),
                                'cc' => '',
                                'subject' => (stripos($orig_subj, 'Re:') === 0 ? $orig_subj : 'Re: ' . $orig_subj),
                                'body' => $quote,
                            ];
                        } else {
                            $compose_prefill = [
                                'to' => '',
                                'cc' => '',
                                'subject' => (stripos($orig_subj, 'Fwd:') === 0 ? $orig_subj : 'Fwd: ' . $orig_subj),
                                'body' => $quote,
                            ];
                        }
                        $api_pref_done = true;
                    }
                }
                if (!$api_pref_done) {
                [$fp, $map, $merr] = mail_connect_current($cur_mb, (string)$cur_cred);
                if ($fp) {
                    $mail_folders = $map;
                    $op = mail_imap_open_folder($fp, $mail_folder, $map);
                    if ($op['ok']) {
                        $fr = mail_imap_fetch_raw($fp, $ref_uid);
                        if ($fr['ok'] && $fr['raw'] !== '') {
                            $parsed = mail_parse_mime($fr['raw']);
                            $hd = $parsed['headers'] ?? [];
                            $best = mail_mime_best_body($parsed);
                            $orig_from = mail_decode_header((string)($hd['from'] ?? ''));
                            $orig_subj = mail_decode_header((string)($hd['subject'] ?? ''));
                            $orig_date = mail_decode_header((string)($hd['date'] ?? ''));
                            $quote = "\n\n--- 原邮件 ---\n发件人：" . $orig_from . "\n时间：" . $orig_date . "\n主题：" . $orig_subj . "\n\n" . $best['text'];
                            if ($is_reply) {
                                $from_addr = '';
                                if (preg_match('/<([^<>]+@[^<>]+)>/', $orig_from, $mm)) $from_addr = $mm[1];
                                elseif (filter_var(trim($orig_from), FILTER_VALIDATE_EMAIL)) $from_addr = trim($orig_from);
                                $compose_prefill = [
                                    'to' => $from_addr,
                                    'cc' => '',
                                    'subject' => (stripos($orig_subj, 'Re:') === 0 ? $orig_subj : 'Re: ' . $orig_subj),
                                    'body' => $quote,
                                ];
                            } else {
                                $compose_prefill = [
                                    'to' => '',
                                    'cc' => '',
                                    'subject' => (stripos($orig_subj, 'Fwd:') === 0 ? $orig_subj : 'Fwd: ' . $orig_subj),
                                    'body' => $quote,
                                ];
                            }
                        }
                    }
                    mail_close($fp);
                }
                } // 域名邮箱不走上面这段 IMAP
            }
        }
    }
}
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mail 管理中心 — mail.lele.pp.ua</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1c1917;background:#fafaf9;font-size:15px}
  a{color:#15803d;text-decoration:none}
  .top{height:56px;background:#fff;border-bottom:1px solid #e7e5e4;display:flex;align-items:center;gap:12px;padding:0 20px}
  .logo{width:32px;height:32px;border-radius:8px;background:#16a34a;color:#fff;display:grid;place-items:center;font-weight:700}
  .top h1{font-size:17px;margin:0}
  .top .who{margin-left:auto;color:#78716c;font-size:13px}
  .btn{display:inline-block;background:#16a34a;color:#fff;border:1px solid #16a34a;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}
  .btn:hover{background:#15803d}
  .btn.ghost{background:#fff;color:#15803d;border-color:#e7e5e4}
  .btn.ghost:hover{background:#f0fdf4}
  .btn.danger{background:#fff;color:#b91c1c;border-color:#fecaca}
  .wrap{display:flex;min-height:calc(100vh - 56px)}
  .side{width:max-content;min-width:200px;max-width:520px;background:#fff;border-right:1px solid #e7e5e4;padding:16px 12px;flex:0 0 auto;position:relative;transition:width .15s ease}
  .side a{display:block;padding:10px 12px;border-radius:8px;color:#44403c;margin-bottom:4px}
  .side .ico{color:#16a34a}
  .side .ico-amber{color:#ea580c}
  .side .ico-violet{color:#7c3aed}
  .side .ico-blue{color:#2563eb}
  .side .ico svg{vertical-align:-3px}
  .side a.on{background:#f0fdf4;color:#15803d;font-weight:600}
  .side a:hover{background:#fafaf9}
  .side a.compose-btn{background:#16a34a;color:#fff;font-weight:700;text-align:center;margin:0 auto 10px;width:150px;padding:8px 0;border-radius:8px}
  .side-edge{position:absolute;top:0;bottom:0;right:0;width:12px;cursor:pointer;z-index:2;background:transparent}
  .side-edge::after{content:'';position:absolute;top:0;bottom:0;right:0;width:2px;background:transparent}
  .side-edge:hover::after{background:#4ade80}
  .side-edge .edge-btn{position:absolute;top:50%;left:calc(100% - 1px);transform:translate(-50%,-50%);width:18px;height:18px;border-radius:50%;background:#fff;border:1px solid #bbf7d0;color:#16a34a;padding:0;display:grid;place-items:center;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.06);opacity:0;transition:opacity .12s}
  .side-edge:hover .edge-btn{background:#16a34a;border-color:#16a34a;color:#fff;opacity:1}
  .wrap.side-collapsed .side{width:56px;min-width:0;max-width:56px;padding:16px 6px}
  .wrap.side-collapsed .side a{text-align:center;padding:10px 0}
  .wrap.side-collapsed .side a .lbl{display:none}
  .wrap.side-collapsed .side a.compose-btn{width:40px;padding:8px 0}
  .wrap.side-collapsed .mblist,.wrap.side-collapsed .side .muted{display:none}
  .side a.mb-ico{display:none}
  .wrap.side-collapsed .side a.mb-ico{display:block}
  .side a.compose-btn:hover{background:#15803d}
  .side a.compose-btn.on{background:#15803d;color:#fff}
  .main{flex:1;padding:12px 8px;max-width:1180px;min-width:0;display:flex;flex-direction:column}
  .card{background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:16px 12px;margin-bottom:16px}
  .card h2{margin:0 0 8px;font-size:17px}
  .muted{color:#78716c;font-size:13px;line-height:1.7}
  .flash{padding:12px 16px;border-radius:8px;margin-bottom:16px}
  .flash.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
  .flash.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
  .gicon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:#2563eb;color:#fff;font-size:13px;font-weight:700;margin-right:6px;vertical-align:middle;flex:none}
  .gtag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
  .errbox{margin-top:4px;max-width:360px}
  .errbox summary{cursor:pointer;list-style:none;color:#991b1b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
  .errbox summary::-webkit-details-marker{display:none}
  .errbox summary .errmore{color:#2563eb;text-decoration:underline;margin-left:4px}
  .errbox .errfull{margin-top:4px;white-space:pre-wrap;word-break:break-word;color:#57534e;font-size:13px;line-height:1.6}
  label{display:block;font-size:13px;color:#57534e;margin:14px 0 6px}
  input[type=text],input[type=password],input[type=email],select{width:100%;padding:10px 12px;border:1px solid #e7e5e4;border-radius:8px;font-size:15px;background:#fff}
  input:focus{outline:2px solid #bbf7d0;border-color:#16a34a}
  .row{display:flex;gap:12px}.row>div{flex:1}
  .methods{display:flex;gap:12px}
  .methods .radio{flex:1;margin-bottom:0}
  .radio{border:1px solid #e7e5e4;border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer;display:block}
  .radio.on{border-color:#16a34a;background:#f0fdf4}
  .radio b{display:block;font-size:15px;color:#1c1917}
  .radio small{color:#78716c;display:block;margin-top:4px;line-height:1.6}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #f5f5f4;vertical-align:top}
  .tablewrap{overflow-x:auto;margin:0 -4px;padding:0 4px}
  .tablewrap table{min-width:820px}
  .tablewrap th,.tablewrap td{white-space:nowrap}
  .tablewrap td.email{max-width:230px;overflow:hidden;text-overflow:ellipsis}
  .tablewrap td.err{white-space:normal;min-width:150px}
  .tablewrap td .ginput{width:96px;padding:4px 6px;font-size:13px}
  .tablewrap tr.dragging{opacity:.45}
  .panes{display:flex;gap:0;align-items:stretch;flex:1}
  .pane-mid{flex:0 0 340px;width:340px;min-width:0;margin-left:4px}
  .resizer{width:10px;flex:0 0 10px;cursor:col-resize;align-self:stretch;touch-action:none}
  .resizer::after{content:'';display:block;width:2px;height:100%;margin:0 auto;background:#e7e5e4}
  .resizer:hover::after,.resizer.drag::after{background:#16a34a}
  .pane-right{flex:1;min-width:0}
  .pane-right .card{position:sticky;top:12px}
  .mblist{margin-top:4px;padding-top:0;border-top:none}
  .mblist .mblist-h{font-size:15px;color:#44403c;font-weight:700;margin:0 0 4px;padding:10px 12px}
  .mblist>summary.mblist-h{display:flex;justify-content:space-between;align-items:center;cursor:pointer;list-style:none}
  .mblist>summary.mblist-h::-webkit-details-marker{display:none}
  .mblist details{margin-bottom:2px}
  .mblist summary{cursor:pointer;padding:6px 12px;font-size:13px;font-weight:600;color:#57534e;list-style:none}
  .mblist summary::-webkit-details-marker{display:none}
  .mblist summary.gsum{display:flex;justify-content:flex-start;align-items:center;gap:6px}
  .mblist summary.gsum .fold{margin-left:auto}
  .mblist .fold{display:inline-block;color:#a8a29e;transition:transform .15s}
  .mblist details:not([open])>summary .fold,.mblist:not([open])>summary.mblist-h .fold{transform:rotate(-90deg)}
  .mblist a.mb{position:relative;display:block;padding:7px 30px 7px 24px;font-size:13px;color:#44403c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mblist a.mb.on{background:#dcfce7;color:#166534;font-weight:700;border-left:3px solid #16a34a}
  .mblist a.mb:hover{background:#fafaf9}
  .mblist a.mb .cur{float:right;color:#16a34a;font-size:11px;font-weight:700}
  .mblist a.mb .mb-unread{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:8px;height:8px;border-radius:50%;background:#7c3aed;flex-shrink:0}
  .mblist a.mb .mb-dot{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:22px;height:22px;line-height:22px;text-align:center;border-radius:6px;color:#a8a29e;font-size:15px;cursor:pointer}
  .mblist a.mb .mb-dot:hover{background:#e7e5e4;color:#44403c}
  .mb-menu{position:fixed;z-index:999;background:#fff;border:1px solid #e7e5e4;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.14);min-width:130px;padding:4px;display:none}
  .mb-menu.open{display:block}
  .mb-menu button{display:block;width:100%;text-align:left;background:none;border:0;padding:8px 10px;font-size:13px;color:#44403c;border-radius:6px;cursor:pointer}
  .mb-menu button:hover{background:#fafaf9}
  .mb-menu button.del{color:#dc2626}
  .mb-menu button.del:hover{background:#fef2f2}
  #mbToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1000;background:#292524;color:#fff;font-size:13px;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);display:none;white-space:nowrap}
  .mblist .gfilter{font-size:12px;color:#15803d;text-decoration:underline}
  .curbadge{display:inline-block;background:#16a34a;color:#fff;border-radius:999px;font-size:11px;padding:2px 8px;margin-left:6px;vertical-align:middle}
  .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
  .tag.ok{background:#dcfce7;color:#166534}.tag.fail{background:#fee2e2;color:#991b1b}.tag.none{background:#f5f5f4;color:#78716c}
  .gpick{position:relative;display:inline-block}
  .gpick>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
  .gpick>summary::-webkit-details-marker{display:none}
  .gpick>summary .fold{font-size:11px;color:#78716c}
  .gpick:not([open])>summary .fold{transform:rotate(-90deg)}
  .gpick .gmenu{position:absolute;left:calc(100% - 11px);top:calc(100% + 4px);z-index:30;background:#fff;border:1px solid #e7e5e4;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.10);padding:4px;min-width:240px;max-width:280px}
  .gpick .gmenu form{margin:0}
  .gpick .gmenu form:not(.gnew) button[type=submit]{display:block;width:100%;text-align:left;background:none;border:0;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:#292524;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gpick .gmenu form:not(.gnew) button[type=submit]:hover{background:#f0fdf4}
  .gpick .gmenu a{display:block;padding:5px 10px;border-radius:6px;font-size:13px;color:#292524;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
  .gpick .gmenu a:hover{background:#f0fdf4}
  .addbar>summary{list-style:none;cursor:pointer;font-size:17px;font-weight:700;display:flex;align-items:center;gap:6px}
  .addbar>summary::-webkit-details-marker{display:none}
  .addbar>summary .fold{font-size:12px;color:#16a34a}
  .addbar:not([open])>summary .fold{transform:rotate(-90deg)}
  .mblist a.mb.dragging,.mblist details.gitem.dragging{opacity:.45}
  .mblist a.mb.drop-hint,.mblist details.gitem.drop-hint{outline:2px dashed #16a34a;outline-offset:-2px}
  .mblist a.mb{cursor:default}
  .mblist details.gitem>summary{cursor:default}
  .mblist a.mb:active,.mblist a.mb.grabbing{cursor:grabbing}
  .mblist details.gitem>summary:active,.mblist details.gitem.grabbing>summary{cursor:grabbing}
  .gpick .gmenu .gcur{display:block;padding:5px 10px;font-size:13px;color:#15803d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gpick .gmenu .gnew{display:flex;gap:6px;padding:4px 4px 0;border-top:1px solid #f5f5f4;margin-top:2px}
  .gpick .gmenu .gnew input{flex:1;min-width:0;padding:5px 8px;border:1px solid #e7e5e4;border-radius:6px;font-size:13px}
  textarea{width:100%;padding:10px 12px;border:1px solid #e7e5e4;border-radius:8px;font-size:15px;font-family:inherit;line-height:1.7;min-height:220px}
  .folders{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
  .folders a{padding:6px 12px;border:1px solid #e7e5e4;border-radius:999px;font-size:13px;color:#57534e;background:#fff;text-align:center}
  .folders a.on{background:#16a34a;border-color:#16a34a;color:#fff;font-weight:600}
  .folders a.off{opacity:.45}
  .msglist .mrow{display:flex;gap:10px;padding:12px 8px;border-bottom:1px solid #f5f5f4;color:#1c1917;align-items:flex-end}
  .msglist .mbtag{font-size:12px;color:#a8a29e;white-space:nowrap}
  .msglist .mrow:hover{background:#fafaf9}
  .msglist .mrow a.open{flex:1;display:flex;flex-direction:column;gap:2px;color:#1c1917;min-width:0}
  .msglist .rowtop{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
  .msglist .rowleft{display:flex;gap:6px;align-items:center;min-width:0}
  .msglist .rowright{display:flex;gap:6px;align-items:center;flex-shrink:0}
  .msglist .from{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .msglist .subj{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .msglist .snip{color:#a8a29e;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .msglist .date{color:#78716c;font-size:13px;flex-shrink:0}
  .msglist details.month{border-bottom:1px solid #f5f5f4}
  .msglist details.month>summary{cursor:pointer;padding:10px 8px;font-weight:700;color:#57534e;list-style:none;background:#fafaf9}
  .msglist details.month>summary::-webkit-details-marker{display:none}
  .msglist .mrow.unread .from,.msglist .mrow.unread .subj{font-weight:700}
  .rowdel{border:0;background:transparent;font-size:16px;line-height:1;cursor:pointer;opacity:.55;padding:2px 4px;flex-shrink:0}
  .rowdel:hover{opacity:1}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a;flex-shrink:0}
  .mailbody{white-space:pre-wrap;word-break:break-word;line-height:1.8;font-size:15px}
  .pager{display:flex;gap:10px;align-items:center;margin-top:12px;color:#78716c;font-size:14px}
  .mbswitch{margin-bottom:12px}
  .login{max-width:420px;margin:80px auto;background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .login h1{text-align:center;font-size:20px}
  .login p{text-align:center;color:#78716c;font-size:13px}
  @media(max-width:900px){.panes{flex-direction:column}.pane-mid{flex:1;width:auto;margin-left:0}.pane-right{width:100%}.pane-right .card{position:static}.resizer{display:none}}
  @media(max-width:640px){.side{width:auto;min-width:150px;max-width:82vw}.row{flex-direction:column}.methods{flex-direction:column}}
  .pushbox{border:1px solid #dce8ea;border-radius:10px;padding:16px 18px;background:#fff}
  .pushrow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 0 14px}
  .pushrow .ptitle{font-size:15px;font-weight:600;color:#1c1917}
  .tgslots{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:640px){.tgslots{grid-template-columns:1fr}}
  .switch{position:relative;display:inline-block;width:46px;height:26px;flex-shrink:0}
  .switch input{opacity:0;width:0;height:0}
  .switch .sl{position:absolute;inset:0;background:#cbd5e1;border-radius:999px;cursor:pointer;transition:.2s}
  .switch .sl:before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
  .switch input:checked + .sl{background:#16a34a}
  .switch input:checked + .sl:before{transform:translateX(20px)}
</style>
</head>
<body>
<?php if (!site_ready()): ?>
  <div class="login">
    <h1>Mail 管理中心</h1>
    <p>第一次使用，先设一个登录账号和站点密码。<br>以后进这个页面用账号 + 密码登录；邮箱的授权码 / 应用专用密码另外存。</p>
    <?php if ($flash): ?><div class="flash <?=e($flash[0])?>"><?=e($flash[1])?></div><?php endif; ?>
    <form method="post" autocomplete="off">
      <input type="hidden" name="csrf" value="<?=e(csrf())?>">
      <input type="hidden" name="action" value="setup">
      <label>显示名称（可选，如 aa）</label>
      <input type="text" name="display_name" placeholder="aa">
      <label>登录账号（以后登录用，默认 admin）</label>
      <input type="text" name="site_username" placeholder="admin" value="admin" autocomplete="username">
      <label>站点密码（至少 8 位，别用 QQ / 邮箱密码）</label>
      <input type="password" name="site_password" autocomplete="new-password" required>
      <label>再输一次站点密码</label>
      <input type="password" name="site_password2" autocomplete="new-password" required>
      <p style="margin-top:16px"><button class="btn" style="width:100%">设置并进入</button></p>
      <p class="muted">注意：站点密码忘了，存着的邮箱凭据就解不开了，要逐个重新添加。请记好。</p>
    </form>
  </div>
<?php elseif (!logged_in()): ?>
  <div class="login">
    <h1>Mail 管理中心</h1>
    <p>mail.lele.pp.ua · 一个页面管所有邮箱</p>
    <?php if ($flash): ?><div class="flash <?=e($flash[0])?>"><?=e($flash[1])?></div><?php endif; ?>
    <form method="post" autocomplete="off">
      <input type="hidden" name="csrf" value="<?=e(csrf())?>">
      <input type="hidden" name="action" value="login">
      <label>登录账号</label>
      <input type="text" name="site_username" autocomplete="username" required value="<?=e((string)($site['username'] ?? 'admin'))?>">
      <label>站点密码</label>
      <input type="password" name="site_password" autocomplete="current-password" required autofocus>
      <?php $rem_def = remember_days_valid((int)($site['remember_days'] ?? REMEMBER_DAYS)); ?>
      <label style="display:flex;align-items:center;gap:6px;font-weight:normal;flex-wrap:wrap"><input type="checkbox" name="remember" value="1" checked> 记住我
        <select name="remember_days" style="width:auto;padding:4px 6px;font-size:13px"><?php foreach (remember_options() as $d => $lbl): ?><option value="<?= $d ?>"<?= $d === $rem_def ? ' selected' : '' ?>><?=e($lbl)?></option><?php endforeach; ?></select>
      内不用再登录（只在这台设备 / 浏览器上记住）</label>
      <p style="margin-top:16px"><button class="btn" style="width:100%">进入管理中心</button></p>
      <p class="muted">这不是邮箱密码，也不是 QQ 授权码，是你第一次进这个页面时设的站点密码。账号默认是 admin，在设置里可以改。</p>
    </form>
  </div>
<?php else: ?>
  <div class="top">
    <div class="logo">✉</div>
    <h1>Mail 管理中心</h1>
    <span class="who"><?=e((string)($site['display_name'] ?? '')) !== '' ? e((string)$site['display_name']) : '已登录'?> · mail.lele.pp.ua</span>
    <form method="post" style="margin:0"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="logout"><button class="btn ghost">退出</button></form>
  </div>
  <div class="wrap">
    <script>try{if(localStorage.getItem('mc_side_collapsed')==='1')document.currentScript.parentElement.classList.add('side-collapsed');}catch(e){}</script>
    <div class="side">
      <div class="side-edge" id="sideEdge" title="收起 / 展开侧栏"><button type="button" class="edge-btn" tabindex="-1"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button></div>
      <a href="?tab=compose" class="compose-btn <?= $tab==='compose' ? 'on' : '' ?>"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg> <span class="lbl">写信</span></a>
      <?php if (!empty($mailboxes)): ?>
      <details class="mblist">
        <summary class="mblist-h"><span><span class="ico ico-blue"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M22 6l-10 7L2 6"/></svg></span> 我的邮箱</span><span class="fold">▾</span></summary>
        <?php
          // 未读圆点：不现场登每个邮箱（那样每打开一页都要登几十次、又慢又招风控），
          // 只读本地缓存的收件箱最新 30 封，数里面未读的；当前正在看的邮箱用刚取到的列表再算一次，最新。
          // 没点开过的邮箱还没有缓存，就没有圆点，点开一次、取到列表后才有。
          $mb_unread = [];
          foreach ($mailboxes as $mbx0) {
            $n0 = 0;
            if (($mbx0['status'] ?? 'ok') === 'ok') {
              $c0 = mail_cache_read((string)$mbx0['id'], 'inbox');
              if (is_array($c0) && is_array($c0['list'] ?? null)) {
                foreach ((array)$c0['list'] as $r0) { if (empty($r0['seen'])) $n0++; }
              }
            }
            $mb_unread[(string)$mbx0['id']] = $n0;
          }
          if ($cur_mb && in_array($tab, ['inbox', 'read'], true) && $mail_folder === 'inbox' && $mail_page === 1 && !$mail_all) {
            $n1 = 0;
            foreach ((array)$mail_list as $r1) { if (empty($r1['seen'])) $n1++; }
            $mb_unread[(string)$cur_mb['id']] = $n1;
          }
          $mb_groups = [];
          foreach ($mailboxes as $mb) {
            $g = trim((string)($mb['group'] ?? '')) !== '' ? trim((string)$mb['group']) : '未分组';
            $mb_groups[$g][] = $mb;
          }
          foreach ($mb_groups as $gname => $glist): ?>
        <details class="gitem" draggable="false" data-group="<?=e($gname)?>">
          <summary class="gsum"><?=group_icon($gname)?><span class="gtag" style="<?=group_tag_style($gname)?>" title="点一下展开 / 收起这个分组的邮箱"><?=e($gname)?>（<?=count($glist)?>）</span><span class="fold">▾</span></summary>
          <?php foreach ($glist as $mb): ?>
          <a class="mb <?= $cur_mb && $mb['id'] === $cur_mb['id'] ? 'on' : '' ?>" href="?tab=inbox&amp;mb=<?=e((string)$mb['id'])?>" title="<?=e((string)$mb['email'])?>" draggable="false" data-id="<?=e((string)$mb['id'])?>" data-group="<?=e($gname)?>"><?php if (!empty($mb_unread[(string)$mb['id']])): ?><span class="mb-unread" title="有 <?= (int)$mb_unread[(string)$mb['id']] ?> 封未读"></span><?php endif; ?><?=e((string)$mb['email'])?><?php if ($cur_mb && $mb['id'] === $cur_mb['id']): ?><span class="cur">● 当前</span><?php endif; ?><span class="mb-dot" data-id="<?=e((string)$mb['id'])?>" data-email="<?=e((string)$mb['email'])?>" title="更多操作">⋮</span></a>
          <?php endforeach; ?>
        </details>
        <?php endforeach; ?>
      </details>
      <a href="?tab=inbox" class="mb-ico" id="mbIco" title="我的邮箱：点一下展开侧栏选邮箱"><span class="ico ico-blue"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M22 6l-10 7L2 6"/></svg></span></a>
      <form id="sideReorderForm" method="post" style="display:none"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="reorder"><input type="hidden" name="order" id="sideReorderInput" value=""></form>
      <p class="muted" id="sideOrderMsg" style="display:none;margin:4px 12px;color:#15803d">✓ 排序已保存</p>
      <script>
      // 我的邮箱展开状态记在浏览器里：打开后点别的项目、刷新页面都还是展开的，方便切换邮箱
      (function(){
        var box = document.querySelector('details.mblist');
        if (!box) return;
        try { if (localStorage.getItem('mc_mblist_open') === '1') box.open = true; } catch (e) {}
        box.addEventListener('toggle', function(){
          try { localStorage.setItem('mc_mblist_open', box.open ? '1' : '0'); } catch (e) {}
        });
      })();
      // 分组折叠只手动开关：默认都收起，手动打开过的记在浏览器里，刷新后还是上次的样子
      (function(){
        var KEY = 'mc_gopen';
        var saved = {};
        try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
        document.querySelectorAll('details.mblist > details.gitem').forEach(function(g){
          var name = g.getAttribute('data-group') || '';
          if (saved[name] === true) g.open = true;
          g.addEventListener('toggle', function(){
            try {
              var s = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
              if (g.open) s[name] = true; else delete s[name];
              localStorage.setItem(KEY, JSON.stringify(s));
            } catch (e) {}
          });
        });
      })();
      // 左栏宽度跟打开的分组走：没打开分组就是默认 200px；打开哪个分组，就撑宽到能显示全那个分组的邮箱名；
      // 关掉就缩回默认宽（别的分组还开着，就按还开着的那个最长的算）。分组名本身一直看得见，也算在内。
      // 不现场量全部邮箱（收起的分组里邮箱是不渲染的，本来也量不到），只量看得见的行，量的是 scrollWidth（被截掉的部分也算）。
      (function(){
        var side = document.querySelector('.side');
        var wrap = document.querySelector('.wrap');
        var box = document.querySelector('details.mblist');
        if (!side || !wrap || !box) return;
        function updateSideWidth(){
          if (wrap.classList.contains('side-collapsed')) { side.style.width = ''; return; }
          var need = 200;
          function consider(el){
            if (!el) return;
            var w = el.scrollWidth + 25; // 25 = 侧栏左右内边距 12+12 再加 1px 边线
            if (w > need) need = w;
          }
          consider(box.querySelector(':scope > summary.mblist-h'));
          document.querySelectorAll('details.mblist > details.gitem').forEach(function(g){
            consider(g.querySelector(':scope > summary.gsum'));
            if (g.open && box.open) {
              g.querySelectorAll('a.mb[data-id]').forEach(consider);
            }
          });
          if (need > 520) need = 520;
          side.style.width = need + 'px';
        }
        function updateSoon(){ if (window.requestAnimationFrame) { window.requestAnimationFrame(updateSideWidth); } else { updateSideWidth(); } }
        document.querySelectorAll('details.mblist > details.gitem').forEach(function(g){
          g.addEventListener('toggle', updateSoon);
        });
        box.addEventListener('toggle', updateSoon);
        if (window.MutationObserver) {
          new MutationObserver(updateSoon).observe(wrap, {attributes: true, attributeFilter: ['class']});
        }
        window.addEventListener('load', updateSideWidth);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateSideWidth);
        updateSideWidth();
      })();
      // 左栏拖动排序：拖分组整组换位，拖邮箱在同组内换位，松手自动保存（不刷新页面）
      (function(){
        var MC_ALL_IDS = <?=json_encode(array_column($mailboxes, 'id'))?>;
        var MC_GROUP_COUNT = <?=count($mb_groups)?>;
        var form = document.getElementById('sideReorderForm');
        var input = document.getElementById('sideReorderInput');
        var msg = document.getElementById('sideOrderMsg');
        if (!form || !input) return;
        function collect(){
          var groups = [];
          document.querySelectorAll('details.mblist > details.gitem').forEach(function(g){
            var ids = [];
            g.querySelectorAll('a.mb[data-id]').forEach(function(a){ ids.push(a.getAttribute('data-id')); });
            groups.push(ids);
          });
          if (groups.length === MC_GROUP_COUNT) return groups.flat().join(',');
          // 只看一个分组时：只动看得见的分组，别的分组保持原位
          var out = [], placed = {};
          MC_ALL_IDS.forEach(function(id){
            if (placed[id]) return;
            var gi = groups.findIndex(function(ids){ return ids.indexOf(id) !== -1; });
            if (gi !== -1) { groups[gi].forEach(function(x){ out.push(x); placed[x] = true; }); }
            else { out.push(id); placed[id] = true; }
          });
          return out.join(',');
        }
        function save(){
          input.value = collect();
          fetch('index.php', {method:'POST', body:new FormData(form), credentials:'same-origin'}).then(function(){
            if (!msg) return;
            msg.style.display = '';
            setTimeout(function(){ msg.style.display = 'none'; }, 2000);
          }).catch(function(){});
        }
        var dragEl = null, dragKind = null;
        // 在行外松手时也把抓手关回去，别让它一直留在抓手状态
        document.addEventListener('mouseup', function(){
          document.querySelectorAll('details.mblist a.mb.grabbing, details.mblist details.gitem.grabbing').forEach(function(el){ el.classList.remove('grabbing'); el.draggable = false; });
        });
        document.querySelectorAll('details.mblist > details.gitem').forEach(function(g){
          // 默认箭头、不许拖：只有按住左键才开拖、才变抓手，松手就关回去
          g.addEventListener('mousedown', function(e){
            if (e.button !== 0) return;
            g.classList.add('grabbing'); g.draggable = true;
          });
          g.addEventListener('mouseup', function(){ g.classList.remove('grabbing'); g.draggable = false; });
          g.addEventListener('dragstart', function(e){
            if (!g.classList.contains('grabbing')) { e.preventDefault(); return; }
            if (e.target !== g) return; // 从邮箱链接上起拖，交给邮箱那套处理
            dragEl = g; dragKind = 'group'; g.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', 'g:' + g.getAttribute('data-group')); } catch (err) {}
          });
          g.addEventListener('dragend', function(){ g.classList.remove('dragging'); g.classList.remove('grabbing'); g.draggable = false; dragEl = null; dragKind = null; });
          g.addEventListener('dragover', function(e){
            if (dragKind !== 'group' || !dragEl || dragEl === g) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move'; g.classList.add('drop-hint');
          });
          g.addEventListener('dragleave', function(){ g.classList.remove('drop-hint'); });
          g.addEventListener('drop', function(e){
            e.preventDefault(); g.classList.remove('drop-hint');
            if (!dragEl || dragKind !== 'group' || dragEl === g) return;
            var rect = g.getBoundingClientRect();
            if ((e.clientY - rect.top) > rect.height / 2) { g.parentNode.insertBefore(dragEl, g.nextSibling); }
            else { g.parentNode.insertBefore(dragEl, g); }
            save();
          });
        });
        document.querySelectorAll('details.mblist a.mb[data-id]').forEach(function(a){
          // 默认箭头、不许拖：只有按住左键才开拖、才变抓手，松手就关回去（⋮ 上按住不算，它的 mousedown 已拦掉）
          a.addEventListener('mousedown', function(e){
            if (e.button !== 0) return;
            a.classList.add('grabbing'); a.draggable = true;
          });
          a.addEventListener('mouseup', function(){ a.classList.remove('grabbing'); a.draggable = false; });
          a.addEventListener('dragstart', function(e){
            if (!a.classList.contains('grabbing')) { e.preventDefault(); return; }
            dragEl = a; dragKind = 'mb'; a.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', a.getAttribute('data-id')); } catch (err) {}
          });
          a.addEventListener('dragend', function(){ a.classList.remove('dragging'); a.classList.remove('grabbing'); a.draggable = false; dragEl = null; dragKind = null; });
          a.addEventListener('dragover', function(e){
            if (dragKind !== 'mb' || !dragEl || dragEl === a) return;
            if (dragEl.getAttribute('data-group') !== a.getAttribute('data-group')) return; // 只在同组内拖，跨组不接
            e.preventDefault(); e.dataTransfer.dropEffect = 'move'; a.classList.add('drop-hint');
          });
          a.addEventListener('dragleave', function(){ a.classList.remove('drop-hint'); });
          a.addEventListener('drop', function(e){
            e.preventDefault(); a.classList.remove('drop-hint');
            if (!dragEl || dragKind !== 'mb' || dragEl === a) return;
            if (dragEl.getAttribute('data-group') !== a.getAttribute('data-group')) return;
            var rect = a.getBoundingClientRect();
            if ((e.clientY - rect.top) > rect.height / 2) { a.parentNode.insertBefore(dragEl, a.nextSibling); }
            else { a.parentNode.insertBefore(dragEl, a); }
            save();
          });
        });
      })();
      </script>
      <div class="mb-menu" id="mbMenu">
        <button type="button" data-act="edit">编辑</button>
        <button type="button" data-act="compose">写信</button>
        <button type="button" data-act="copy">复制</button>
        <button type="button" data-act="del" class="del">删除</button>
      </div>
      <form id="mbMenuDelForm" method="post" style="display:none"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" id="mbMenuDelId" value=""></form>
      <div id="mbToast"></div>
      <script>
      // 左栏每个邮箱后面的 ⋮ 菜单：编辑 / 写信 / 复制 / 删除
      (function(){
        var menu = document.getElementById('mbMenu');
        var toast = document.getElementById('mbToast');
        if (!menu) return;
        var curId = '', curEmail = '';
        function closeMenu(){ menu.classList.remove('open'); }
        function showToast(msg){
          if (!toast) return;
          toast.textContent = msg;
          toast.style.display = 'block';
          clearTimeout(toast._tm);
          toast._tm = setTimeout(function(){ toast.style.display = 'none'; }, 1600);
        }
        function openMenu(dot){
          curId = dot.getAttribute('data-id') || '';
          curEmail = dot.getAttribute('data-email') || '';
          menu.classList.add('open');
          var mw = menu.offsetWidth, mh = menu.offsetHeight;
          var r = dot.getBoundingClientRect();
          // 菜单左缘与 ⋮ 对齐（以前是右缘对齐）
          var left = r.left;
          var top = r.bottom + 4;
          if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
          if (top < 8) top = 8;
          if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
          if (left < 8) left = 8;
          menu.style.left = left + 'px';
          menu.style.top = top + 'px';
        }
        document.querySelectorAll('details.mblist .mb-dot').forEach(function(dot){
          // 从 ⋮ 上起拖会把整行拖走，先拦掉；点一下才弹菜单
          dot.addEventListener('mousedown', function(e){ e.preventDefault(); e.stopPropagation(); });
          dot.addEventListener('click', function(e){
            e.preventDefault(); e.stopPropagation();
            if (menu.classList.contains('open') && menu._for === dot) { closeMenu(); return; }
            menu._for = dot;
            openMenu(dot);
          });
        });
        document.addEventListener('click', function(e){
          if (!menu.classList.contains('open')) return;
          if (menu.contains(e.target)) return;
          closeMenu();
        });
        document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeMenu(); });
        menu.addEventListener('click', function(e){
          var b = e.target.closest('button[data-act]');
          if (!b) return;
          var act = b.getAttribute('data-act');
          if (act === 'edit') {
            closeMenu();
            location.href = '?tab=add&edit=' + encodeURIComponent(curId);
          } else if (act === 'compose') {
            closeMenu();
            location.href = '?tab=compose&mb=' + encodeURIComponent(curId);
          } else if (act === 'copy') {
            var done = function(){ showToast('已复制 ' + curEmail); closeMenu(); };
            var fallbackCopy = function(){
              var ta = document.createElement('textarea');
              ta.value = curEmail; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              try { document.execCommand('copy'); } catch (err) {}
              document.body.removeChild(ta);
              done();
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(curEmail).then(done, fallbackCopy);
            } else { fallbackCopy(); }
          } else if (act === 'del') {
            closeMenu();
            if (!confirm('确定删除 ' + curEmail + ' 吗？只删管理中心里的记录，不删邮箱本身。')) return;
            document.getElementById('mbMenuDelId').value = curId;
            document.getElementById('mbMenuDelForm').submit();
          }
        });
      })();
      </script>
      <?php endif; ?>
      <a href="?tab=mailboxes" class="<?= $tab==='mailboxes' ? 'on' : '' ?>"><span class="ico"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12l2 2 4-4"/></svg></span> <span class="lbl">邮箱管理</span></a>
      <a href="?tab=add" class="<?= $tab==='add' ? 'on' : '' ?>"><span class="ico ico-amber"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span> <span class="lbl">添加邮箱</span></a>
      <a href="?tab=settings" class="<?= $tab==='settings' ? 'on' : '' ?>"><span class="ico ico-violet"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span> <span class="lbl">设置</span></a>
      <div style="margin-top:24px;padding:12px;border-top:1px solid #f5f5f4" class="muted">
        收信、读信、回信、转发、写信都在本站完成，不用跳去别处。
      </div>
    </div>
    <div class="main">
      <?php if ($flash): ?><div class="flash <?=e($flash[0])?>"><?=e($flash[1])?></div><?php endif; ?>
      <?php if (!$data_ok): ?><div class="flash err">数据目录写不进去：<?=e(DATA_DIR)?>，请先按 README 建好这个目录再添加邮箱。</div><?php endif; ?>

      <?php if ($tab === 'inbox' || $tab === 'read'): ?>
      <div class="panes">
        <div class="pane-mid">
        <div class="card">
          <h2><?=e($mail_folder_names[$mail_folder])?><?php if (!empty($mailboxes)): ?> <span class="muted" style="font-size:14px;font-weight:400"><?php if ($mail_all): ?>全部邮箱（共 <?=count($mailboxes)?> 个）· 最新邮件<?php else: ?><?=e((string)$cur_mb['email'])?><?php endif; ?></span><?php endif; ?></h2>
          <?php if (empty($mailboxes)): ?>
            <p class="muted">还没有邮箱，点左栏「＋ 添加邮箱」加第一个吧。建议先加 QQ（用授权码），再加 Outlook / Gmail。</p>
          <?php else: ?>
          <?php $mb_qs = $mail_all ? 'mb=all&amp;all=1' : 'mb=' . e($cur_mb['id']); ?>
          <div class="folders" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
            <a href="?tab=compose&amp;<?= $mb_qs ?>">写信</a>
            <?php foreach ($mail_folder_names as $fk => $fn): ?>
              <?php if (isset($mail_folders[$fk])): ?><a href="?tab=inbox&amp;folder=<?=e($fk)?>&amp;<?= $mb_qs ?>" class="<?= $mail_folder === $fk ? 'on' : '' ?>"><?=e($fn)?></a>
              <?php else: ?><a class="off" title="这个邮箱没有这个文件夹"><?=e($fn)?></a><?php endif; ?>
            <?php endforeach; ?>
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin:0 0 12px">
            <a class="btn ghost" href="?tab=inbox&amp;folder=<?=e($mail_folder)?>&amp;refresh=1&amp;<?= $mb_qs ?><?= $mail_page > 1 ? '&amp;page=' . $mail_page : '' ?>">↻ 刷新</a>
            <?php if ($mail_err === ''): ?>
              <?php if ($mail_from_cache && $mail_cache_ts > 0): ?>
                <?php $cd = new DateTime('@' . $mail_cache_ts); $cd->setTimezone(new DateTimeZone('Asia/Shanghai')); ?>
                <span class="muted">缓存于 <?=e($cd->format('H:i'))?></span>
              <?php else: ?>
                <span class="muted">刚取的最新列表</span>
              <?php endif; ?>
            <?php endif; ?>
          </div>
          <?php if ($mail_note !== ''): ?><p class="muted" style="margin:0 0 12px"><?=e($mail_note)?></p>
          <?php endif; ?>
          <?php if ($mail_err !== ''): ?><div class="flash err"><?=e($mail_err)?></div>
          <?php elseif (empty($mail_list)): ?><p class="muted">这个文件夹里没有邮件。</p>
          <?php else: ?>
          <?php $mb_kind_map = []; foreach ($mailboxes as $mbk) { $mb_kind_map[(string)$mbk['id']] = (string)($mbk['kind'] ?? 'imap'); } ?>
          <div class="msglist">
            <?php
              // 按月份分组：$mail_list 已经是最新在前，分组顺序就是从新到旧
              $mail_groups = [];
              foreach ($mail_list as $mm) {
                  $ts = strtotime((string)($mm['date'] ?? ''));
                  $gkey = ($ts === false || $ts <= 0) ? 'unknown' : mail_shanghai_ym($ts);
                  $mail_groups[$gkey][] = $mm;
              }
              $now_dt = new DateTime('now', new DateTimeZone('Asia/Shanghai'));
              $now_y = (int)$now_dt->format('Y');
              $now_m = (int)$now_dt->format('m');
              foreach ($mail_groups as $gkey => $glist):
                  if ($gkey === 'unknown') {
                      $glabel = '未知时间';
                      $gopen = false;
                  } else {
                      [$gy, $gm] = array_map('intval', explode('-', $gkey));
                      $glabel = ($gy === $now_y && $gm === $now_m) ? '本月' : (($gy === $now_y) ? $gm . '月' : $gy . '年' . $gm . '月');
                      $gopen = ($gy === $now_y && $gm === $now_m);
                  } ?>
            <details class="month"<?= $gopen ? ' open' : '' ?>>
              <summary><?=e($glabel)?>（<?=count($glist)?>）</summary>
            <?php foreach ($glist as $mm):
              // 全部收件箱里每封属于哪个邮箱，就用哪个邮箱的 id 打开、删除
              $row_mb = $mail_all ? (string)($mm['mb_id'] ?? $cur_mb['id']) : (string)$cur_mb['id'];
              $row_kind = $mb_kind_map[$row_mb] ?? 'imap';
              $row_qs = $mail_all ? 'mb=' . e($row_mb) . '&amp;all=1' : 'mb=' . e($row_mb); ?>
            <div class="mrow <?= $mm['seen'] ? '' : 'unread' ?>">
              <a class="open" href="?tab=inbox&amp;folder=<?=e($mail_folder)?>&amp;uid=<?= (int)$mm['uid'] ?>&amp;<?= $row_qs ?>">
                <span class="rowtop"><span class="rowleft"><?php if (!$mm['seen']): ?><span class="dot"></span><?php endif; ?><span class="from"><?=e(mail_sender_display_name((string)($mm['from_name'] ?? ''), (string)($mm['from_addr'] ?? '')))?></span></span><span class="rowright"><?php if ($mail_all): ?><span class="mbtag"><?=e((string)($mm['mb_email'] ?? ''))?></span><?php endif; ?><span class="date"><?=e(mail_display_date((string)($mm['date'] ?? '')))?></span></span></span>
                <span class="subj"><?=e($mm['subject'] !== '' ? $mm['subject'] : '（无主题）')?></span>
                <?php if (trim((string)($mm['snippet'] ?? '')) !== ''): ?><span class="snip"><?=e((string)$mm['snippet'])?></span><?php endif; ?>
              </a>
              <?php if ($mail_folder !== 'trash'): ?>
              <form method="post" style="margin:0" onsubmit="return confirm('<?= mc_api_delete_confirm($row_kind) ?>')"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="mail_move"><input type="hidden" name="mb" value="<?=e($row_mb)?>"><?php if ($mail_all): ?><input type="hidden" name="all" value="1"><?php endif; ?><input type="hidden" name="uid" value="<?= (int)$mm['uid'] ?>"><input type="hidden" name="folder" value="<?=e($mail_folder)?>"><input type="hidden" name="dest" value="trash"><button class="rowdel" title="删除这封邮件">🗑</button></form>
              <?php endif; ?>
            </div>
            <?php endforeach; ?>
            </details>
            <?php endforeach; ?>
          </div>
          <div class="pager">
            <?php if ($mail_page > 1): ?><a class="btn ghost" href="?tab=inbox&amp;folder=<?=e($mail_folder)?>&amp;page=<?= $mail_page - 1 ?>&amp;<?= $mb_qs ?>">上一页</a><?php endif; ?>
            <span>第 <?= $mail_page ?> 页，共 <?= $mail_total ?> 封</span>
            <?php if ($mail_page * 30 < $mail_total): ?><a class="btn ghost" href="?tab=inbox&amp;folder=<?=e($mail_folder)?>&amp;page=<?= $mail_page + 1 ?>&amp;<?= $mb_qs ?>">下一页</a><?php endif; ?>
          </div>
          <?php endif; ?>
          <?php endif; ?>
        </div>
        </div>
        <div class="resizer" id="midResizer" title="拖动调整列表宽度"></div>
        <div class="pane-right">
        <div class="card">
          <?php if ($mail_err !== '' && $mail_uid > 0): ?><div class="flash err"><?=e($mail_err)?></div>
          <?php elseif (!$mail_msg): ?><h2>读信</h2><p class="muted"><?= $mail_uid > 0 ? '这封邮件打不开。' : '点一封邮件查看。' ?></p>
          <?php else: ?>
          <h2><?=e($mail_msg['subject'] !== '' ? $mail_msg['subject'] : '（无主题）')?></h2>
          <p class="muted">发件人：<?=e($mail_msg['from'])?><br>收件人：<?=e($mail_msg['to'])?><?php if ($mail_msg['cc'] !== ''): ?><br>抄送：<?=e($mail_msg['cc'])?><?php endif; ?><br>时间：<?=e($mail_msg['date'])?></p>
          <div class="mailbody"><?=e($mail_msg['body'] !== '' ? $mail_msg['body'] : '（这封邮件没有纯文本正文）')?></div>
          <?php if (!empty($mail_msg['atts'])): ?>
          <h2 style="margin-top:20px">附件</h2>
          <?php foreach ($mail_msg['atts'] as $ai => $att): ?>
          <p><a href="?tab=attach&amp;folder=<?=e($mail_folder)?>&amp;uid=<?= (int)$mail_msg['uid'] ?>&amp;att=<?= (int)$ai ?>&amp;mb=<?=e((string)($mail_msg['mb_id'] ?? $cur_mb['id']))?>">📎 <?=e(trim((string)($att['filename'] ?? '')) !== '' ? (string)$att['filename'] : 'attachment')?>（<?= (int)$att['size'] ?> 字节）</a></p>
          <?php endforeach; ?>
          <?php endif; ?>
          <p style="margin-top:20px">
            <a class="btn" href="?tab=compose&amp;reply=<?= (int)$mail_msg['uid'] ?>&amp;folder=<?=e($mail_folder)?>&amp;mb=<?=e((string)($mail_msg['mb_id'] ?? $cur_mb['id']))?>">回复</a>
            <a class="btn ghost" href="?tab=compose&amp;forward=<?= (int)$mail_msg['uid'] ?>&amp;folder=<?=e($mail_folder)?>&amp;mb=<?=e((string)($mail_msg['mb_id'] ?? $cur_mb['id']))?>">转发</a>
            <a class="btn ghost" href="?tab=inbox&amp;folder=<?=e($mail_folder)?>&amp;<?= $mail_all ? 'mb=all&amp;all=1' : 'mb=' . e($cur_mb['id']) ?>">返回列表</a>
          </p>
          <div>
            <form method="post" style="display:inline" onsubmit="return confirm('<?= mc_api_delete_confirm((string)($mail_msg['mb_kind'] ?? 'imap'), 'spam') ?>')"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="mail_move"><input type="hidden" name="mb" value="<?=e((string)($mail_msg['mb_id'] ?? $cur_mb['id']))?>"><?php if ($mail_all): ?><input type="hidden" name="all" value="1"><?php endif; ?><input type="hidden" name="uid" value="<?= (int)$mail_msg['uid'] ?>"><input type="hidden" name="folder" value="<?=e($mail_folder)?>"><input type="hidden" name="dest" value="spam"><button class="btn ghost"><?= mc_api_delete_btn((string)($mail_msg['mb_kind'] ?? 'imap')) ?></button></form>
          </div>
          <?php endif; ?>
        </div>
        </div>
      </div>

      <?php elseif ($tab === 'compose'): ?>
        <div class="card">
          <h2>写信</h2>
          <?php if (empty($mailboxes)): ?>
            <p class="muted">还没有邮箱，先去「邮箱管理」最下面添加一个。</p>
          <?php else: ?>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="send_mail">
            <label>发件邮箱（按分组选，用哪个邮箱发就选哪个）</label>
            <select name="mb" style="width:100%;padding:10px 12px;border:1px solid #e7e5e4;border-radius:8px;font-size:15px">
              <?php
                $compose_groups = [];
                foreach ($mailboxes as $mbx) { $g = trim((string)($mbx['group'] ?? '')) !== '' ? trim((string)$mbx['group']) : '未分组'; $compose_groups[$g][] = $mbx; }
                foreach ($compose_groups as $gname => $glist): ?>
              <optgroup label="<?=e($gname)?>">
                <?php foreach ($glist as $mbx): ?><option value="<?=e((string)$mbx['id'])?>"<?= $cur_mb && $mbx['id'] === $cur_mb['id'] ? ' selected' : '' ?>><?=e((string)$mbx['email'])?><?= trim((string)($mbx['display_name'] ?? '')) !== '' ? '（' . e((string)$mbx['display_name']) . '）' : '' ?></option><?php endforeach; ?>
              </optgroup>
              <?php endforeach; ?>
            </select>
            <label>收件人（多个用逗号隔开）</label>
            <input type="text" name="to" value="<?=e($compose_prefill['to'])?>" placeholder="如 xxx@qq.com" required>
            <label>抄送（可选）</label>
            <input type="text" name="cc" value="<?=e($compose_prefill['cc'])?>" placeholder="可选，多个用逗号隔开">
            <label>主题</label>
            <input type="text" name="subject" value="<?=e($compose_prefill['subject'])?>" placeholder="主题">
            <label>正文（纯文本）</label>
            <textarea name="body"><?=e($compose_prefill['body'])?></textarea>
            <p><button class="btn">发送</button> <a class="btn ghost" href="?tab=inbox&amp;<?= $mail_all ? 'mb=all&amp;all=1' : 'mb=' . e($cur_mb['id']) ?>">取消</a></p>
            <p class="muted">v1 只支持纯文本正文，不支持富文本和添加附件；发出去的信会尽力存一份到已发送。</p>
          </form>
          <?php endif; ?>
        </div>

      <?php elseif ($tab === 'mailboxes'): ?>
        <div class="card">
          <h2>邮箱管理</h2>
          <p class="muted">这里只管“有哪些邮箱、能不能连上”。要看信，点左栏「我的邮箱」里点一个邮箱直接打开；要写信，点左栏「写信」。</p>
          <?php if (empty($mailboxes)): ?>
            <p class="muted">还没有邮箱，点左栏「＋ 添加邮箱」加第一个吧。建议先加 QQ（用授权码），再加 Outlook / Gmail。</p>
          <?php else:
            $mg_groups = [];
            foreach ($mailboxes as $mb) { $g = trim((string)($mb['group'] ?? '')) !== '' ? trim((string)$mb['group']) : '未分组'; $mg_groups[$g] = ($mg_groups[$g] ?? 0) + 1; } ?>
          <div class="folders">
            <a href="?tab=mailboxes" class="<?= $mb_group_filter === '' ? 'on' : '' ?>">全部（<?=count($mailboxes)?>）</a>
            <?php foreach ($mg_groups as $gname => $cnt): ?><a href="?tab=mailboxes&amp;mbgroup=<?=urlencode($gname)?>" class="<?= $mb_group_filter === $gname ? 'on' : '' ?>"><?=e($gname)?>（<?=$cnt?>）</a><?php endforeach; ?>
          </div>
          <p class="muted"><?php if ($mb_group_filter !== ''): ?>只看“<?=e($mb_group_filter)?>”分组的邮箱，点“全部”或表格里「分组」列头的 ▾ 换分组。<?php else: ?>点上面某个分组，或点表格里「分组」列头的 ▾，就只列出该分组的邮箱。<?php endif; ?></p>
          <div style="border:1px solid #e7e5e4;border-radius:8px;padding:12px;margin:0 0 12px">
            <strong>分组管理</strong> <span class="muted">改一个分组名，这个分组里的邮箱一起跟着改，不用一个个改。</span>
            <?php foreach ($mg_groups as $gname => $cnt): ?>
            <form method="post" style="display:flex;gap:8px;align-items:center;margin:8px 0 0;flex-wrap:wrap"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="rename_group"><input type="hidden" name="old_group" value="<?=e($gname)?>"><span style="width:180px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="<?=e($gname)?>（<?=$cnt?>）"><?=e($gname)?>（<?=$cnt?>）</span><span class="muted">改成</span><input type="text" name="new_group" value="<?=e($gname)?>" style="width:130px;padding:6px 8px;border:1px solid #e7e5e4;border-radius:6px;font-size:14px"><button class="btn ghost" style="padding:6px 12px">改分组名</button></form>
            <?php endforeach; ?>
          </div>
          <div class="tablewrap">
          <table>
            <tr><th>邮箱</th><th><details class="gpick"><summary title="点一下按分组筛选">分组<?= $mb_group_filter !== '' ? '：' . e($mb_group_filter) : '' ?> <span class="fold">▾</span></summary><div class="gmenu"><?php if ($mb_group_filter === ''): ?><span class="gcur">✓ 全部（<?=count($mailboxes)?>）</span><?php else: ?><a href="?tab=mailboxes">全部（<?=count($mailboxes)?>）</a><?php endif; ?><?php foreach ($mg_groups as $gname => $cnt): ?><?php if ($gname === $mb_group_filter): ?><span class="gcur">✓ <?=e($gname)?>（<?=$cnt?>）</span><?php else: ?><a href="?tab=mailboxes&amp;mbgroup=<?=urlencode($gname)?>"><?=e($gname)?>（<?=$cnt?>）</a><?php endif; ?><?php endforeach; ?></div></details></th><th>登录方式</th><th>IMAP</th><th>状态</th></tr>
            <tbody id="mbRows">
            <?php foreach ($mailboxes as $m):
              $m_group = trim((string)($m['group'] ?? '')) !== '' ? trim((string)$m['group']) : '未分组';
              if ($mb_group_filter !== '' && $m_group !== $mb_group_filter) continue; ?>
            <tr draggable="true" data-id="<?=e((string)$m['id'])?>">
              <td class="email"><strong><?=e((string)$m['email'])?></strong><?php if (($m['auth'] ?? '') === 'ms'): ?> <span class="tag ok">微软登录</span><?php endif; ?><?php if (mc_api_is_api_kind((string)($m['kind'] ?? ''))): ?> <span class="tag ok"><?=e(mc_api_label((string)$m['kind']))?></span><?php endif; ?><br><span class="muted"><?=e((string)($m['display_name'] ?? ''))?> · <?=e((string)$m['provider'])?></span><form method="post" style="display:inline" onsubmit="return confirm('确定删除 <?=e((string)$m['email'])?> 吗？只删管理中心里的记录，不删邮箱本身。')"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="<?=e((string)$m['id'])?>"><button style="background:none;border:0;color:#dc2626;font-size:12px;cursor:pointer;padding:0;margin-left:6px">删除</button></form></td>
              <td>
                <details class="gpick">
                  <summary><span class="tag" style="<?=group_tag_style($m_group)?>"><?=e($m_group)?></span><span class="fold">▾</span></summary>
                  <div class="gmenu">
                    <?php foreach ($mg_groups as $gname => $cnt): ?>
                      <?php if ($gname === $m_group): ?><span class="gcur">✓ <?=e($gname)?>（当前）</span>
                      <?php else: ?><form method="post"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="set_group"><input type="hidden" name="id" value="<?=e((string)$m['id'])?>"><input type="hidden" name="group" value="<?=e($gname)?>"><button type="submit"><?=e($gname)?>（<?=$cnt?>）</button></form>
                      <?php endif; ?>
                    <?php endforeach; ?>
                    <form method="post" class="gnew"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="set_group"><input type="hidden" name="id" value="<?=e((string)$m['id'])?>"><input type="text" name="group" placeholder="新建分组名" required><button type="submit" class="btn ghost" style="padding:4px 8px;font-size:13px">新建并移入</button></form>
                  </div>
                </details>
              </td>
              <td><?= mc_api_is_api_kind((string)($m['kind'] ?? '')) ? mc_api_label((string)$m['kind']) . ' 登录' : ((($m['auth'] ?? '') === 'ms' ? '微软登录' : (($m['method'] ?? '') === 'password' ? '登录密码' : '授权码·应用专用密码'))) ?><br><a class="btn ghost" style="padding:4px 8px;font-size:13px;margin-top:6px" href="?tab=add&amp;edit=<?=e((string)$m['id'])?>">改登录方式</a></td>
              <td class="muted"><?= mc_api_is_api_kind((string)($m['kind'] ?? '')) ? mc_api_label((string)$m['kind']) . '：' . e(mc_api_panel_of($m)) : e((string)$m['imap_host']) . ':' . (int)$m['imap_port'] ?></td>
              <td class="err">
                <?php if (($m['status'] ?? '') === 'ok'): ?><span class="tag ok">连接成功</span>
                <?php elseif (($m['status'] ?? '') === 'fail'): ?><span class="tag fail">连接失败</span>
                <?php else: ?><span class="tag none">未测试</span><?php endif; ?>
                <?php if (!empty($m['last_error'])): $err1 = trim((string)$m['last_error']); $err_first = strtok($err1, "\n"); $err_short = mb_strlen($err_first, 'UTF-8') > 46 ? mb_substr($err_first, 0, 46, 'UTF-8') . '…' : $err_first; ?>
                <details class="errbox"><summary><?=e($err_short)?><span class="errmore">展开</span></summary><div class="errfull"><?=e($err1)?></div></details><?php endif; ?>
                <form method="post" style="margin-top:6px"><input type="hidden" name="csrf" value="<?=e(csrf())?>"><input type="hidden" name="action" value="test_one"><input type="hidden" name="id" value="<?=e((string)$m['id'])?>"><button class="btn ghost" style="padding:4px 8px;font-size:13px">测试连接</button></form>
              </td>
            </tr>
            <?php endforeach; ?>
            </tbody>
          </table>
          </div>
          <form method="post" style="margin-top:12px">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="reorder">
            <input type="hidden" name="order" id="reorderInput" value="">
            <button class="btn ghost" id="reorderBtn" disabled>💾 保存排序</button>
            <span class="muted">拖动表格行可以调换邮箱顺序，拖完点保存排序。<?php if ($mb_group_filter !== ''): ?>当前只看一个分组，排序请先点上面“全部”。<?php endif; ?></span>
          </form>
          <script>
          (function(){
            var tbody = document.getElementById('mbRows');
            if (!tbody) return;
            var dragged = null, btn = document.getElementById('reorderBtn'), input = document.getElementById('reorderInput');
            function collect(){ var ids = []; tbody.querySelectorAll('tr[data-id]').forEach(function(r){ ids.push(r.getAttribute('data-id')); }); input.value = ids.join(','); btn.disabled = false; }
            tbody.querySelectorAll('tr[data-id]').forEach(function(row){
              row.addEventListener('dragstart', function(e){ dragged = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', row.getAttribute('data-id')); } catch (err) {} });
              row.addEventListener('dragend', function(){ row.classList.remove('dragging'); dragged = null; });
              row.addEventListener('dragover', function(e){ e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
              row.addEventListener('drop', function(e){
                e.preventDefault();
                if (!dragged || dragged === row) return;
                var rect = row.getBoundingClientRect();
                if ((e.clientY - rect.top) > rect.height / 2) { row.parentNode.insertBefore(dragged, row.nextSibling); }
                else { row.parentNode.insertBefore(dragged, row); }
                collect();
              });
            });
          })();
          </script>
          <script>
          // 点空白处收起打开的分组菜单（点菜单里面不收，点箭头正常开关）
          document.addEventListener('click', function(e){
            document.querySelectorAll('details.gpick[open]').forEach(function(d){
              if (!d.contains(e.target)) d.removeAttribute('open');
            });
          });
          </script>
          <?php endif; ?>
        </div>

      <?php elseif ($tab === 'add'): ?>
        <?php render_add_form($draft, $edit_box, $edit_id, 'add'); ?>


      <?php else: ?>
        <div class="card">
          <h2>设置</h2>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="change_name">
            <label>默认显示名称</label>
            <input type="text" name="display_name" value="<?=e((string)($site['display_name'] ?? ''))?>">
            <p><button class="btn ghost">保存显示名称</button></p>
          </form>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="change_username">
            <label>登录账号（当前：<?=e((string)($site['username'] ?? 'admin'))?>）</label>
            <input type="text" name="new_username" value="<?=e((string)($site['username'] ?? 'admin'))?>" autocomplete="username" required>
            <label>当前站点密码（确认是本人操作）</label>
            <input type="password" name="current_password" autocomplete="current-password" required>
            <p><button class="btn ghost">改登录账号</button></p>
            <p class="muted">只改账号，密码和已存的邮箱凭据都不动；下次登录用新账号。</p>
          </form>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="cache_save">
            <label>收件箱列表缓存（分钟）</label>
            <input type="number" name="cache_ttl" min="1" max="60" step="1" value="<?= (int)($site['cache_ttl'] ?? 1) ?>">
            <p class="muted">1 分钟内再进收件箱直接读缓存、秒进；点刷新随时取最新、不受这个时间限制；新邮件最多晚这个时间出现。</p>
            <p><button class="btn ghost">保存缓存时间</button></p>
          </form>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="change_password">
            <label>当前站点密码</label>
            <input type="password" name="current_password" autocomplete="current-password" required>
            <label>新站点密码（至少 8 位）</label>
            <input type="password" name="new_password" autocomplete="new-password" required>
            <label>再输一次新站点密码</label>
            <input type="password" name="new_password2" autocomplete="new-password" required>
            <p><button class="btn">改站点密码</button></p>
            <p class="muted">改站点密码后，已存的邮箱凭据会用新密钥重新加密。万一有邮箱解不开，需要删除后重新添加。改完密码，所有记住的设备都要重新登录。</p>
          </form>
          <?php $rem_cur = remember_days_valid((int)($site['remember_days'] ?? REMEMBER_DAYS)); ?>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="remember_days_save">
            <label>记住我默认时长</label>
            <p style="display:flex;gap:16px;flex-wrap:wrap;margin:6px 0"><?php foreach (remember_options() as $d => $lbl): ?><label style="display:flex;align-items:center;gap:4px;font-weight:normal;margin:0"><input type="radio" name="remember_days" value="<?= $d ?>"<?= $d === $rem_cur ? ' checked' : '' ?>> <?=e($lbl)?></label><?php endforeach; ?></p>
            <p><button class="btn ghost">保存默认时长</button></p>
            <p class="muted">下次登录时，登录页的记住时长默认就用这个；登录时也可以临时改。</p>
          </form>
          <?php $rem_list = array_values(array_filter(remember_load(), static fn($e) => ($e['expires'] ?? 0) > time())); ?>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="revoke_remember">
            <label>记住的设备</label>
            <p class="muted" style="margin:4px 0 10px">当前有 <?=count($rem_list)?> 台设备记住了登录（按各自选的时长免登录，每次打开顺延）。不认识的设备、或者换了电脑不想再记住，就点下面全部退出。</p>
            <p><button class="btn ghost">退出所有记住的设备</button></p>
          </form>
        </div>
        <div class="card">
          <h2>微软账号登录（Outlook / Hotmail）</h2>
          <p class="muted">Outlook / Hotmail 个人邮箱微软只认这种登录：先去 Azure 注册一个应用，把下面的 Client ID 和 Secret 填进来保存，再去添加邮箱点「用微软账号登录添加」，跳到微软登录页登一次就行，以后不用填密码和授权码，令牌过期自动刷新。</p>
          <p class="muted">重定向 URI —— 去 Azure 注册应用时就填这个，一字不差：</p>
          <input type="text" readonly value="<?=e(MS_REDIRECT_URI)?>" onclick="this.select()" style="font-size:13px" title="点一下全选，复制去 Azure 填">
          <?php $ms_cfg = ms_config($key); ?>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="ms_save">
            <label>Client ID（应用程序（客户端）ID）<?= $ms_cfg['id'] !== '' ? ' · 已保存' : ' · 未填写' ?></label>
            <input type="text" name="ms_client_id" value="<?=e($ms_cfg['id'])?>" placeholder="如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off">
            <label>Client Secret（客户端密码）<?= $ms_cfg['secret'] !== '' ? ' · 已保存' : ' · 未填写' ?></label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="password" name="ms_client_secret" id="msSecret" autocomplete="new-password" placeholder="已保存时留空就是不改" style="flex:1">
              <button type="button" class="btn ghost" id="msSecretToggle" style="white-space:nowrap">👁 显示</button>
            </div>
            <p class="muted">Secret 只在微软那边显示一次，丢了就得重新建一个；填进来是加密存的，页面上不会明文显示。两个都留空点保存 = 清空。</p>
            <p><button class="btn">保存微软登录信息</button></p>
          </form>
          <script>
          (function () {
            var s = document.getElementById('msSecret'), b = document.getElementById('msSecretToggle');
            if (!s || !b) return;
            b.addEventListener('click', function () {
              if (s.type === 'password') { s.type = 'text'; b.textContent = '🙈 隐藏'; }
              else { s.type = 'password'; b.textContent = '👁 显示'; }
            });
          })();
          </script>
        </div>
        <div class="card">
          <h2>消息推送</h2>
          <p class="muted">全局默认通道，用户的分发规则优先于此</p>
          <p class="muted">新邮件到了就往你的 Telegram 推一条：邮箱、时间（北京时间）、发件人、标题、正文前 120 字，再加一条“点开看全文”的链接，点链接回管理中心读完整正文。TG 这边发不了真正的折叠（通知不吃剧透格式，实测过 ||...|| 会原样显示），所以折叠展开是在管理中心里。只查收件箱、只查连接正常的邮箱；第一次开只记基线、不推旧邮件。</p>
          <?php $tg_on = !empty($site['tg_enabled']); $tg_url = trim((string)($site['tg_worker'] ?? '')) !== '' ? (string)$site['tg_worker'] : TG_WORKER_DEFAULT; $tg_key_show = (string)($site['tg_key'] ?? ''); $tg_chat_show = ''; if (!empty($site['tg_chat_id'])) { $d = decrypt_cred((string)$site['tg_chat_id'], $key); if (is_string($d)) $tg_chat_show = $d; } $tg_token_show = ''; if (!empty($site['tg_bot_token'])) { $d = decrypt_cred((string)$site['tg_bot_token'], $key); if (is_string($d) && $d !== '') $tg_token_show = '****' . mb_substr($d, -4); } $tg_direct = $tg_chat_show !== '' && $tg_token_show !== ''; ?>
          <p class="muted">状态：<?= $tg_on ? '已开启' : '未开启' ?><?= $tg_direct ? ' · 方式：直连 Bot' : ' · 方式：中转 Worker' ?><?php if (!empty($site['tg_last_run'])): ?> · 上次轮询：<?=e((string)$site['tg_last_run'])?><?php endif; ?></p>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="tg_save">
            <div class="pushbox">
              <div class="pushrow">
                <span class="ptitle">Telegram 机器人</span>
                <label class="switch" title="开启新邮件 TG 通知"><input type="checkbox" name="tg_enabled" value="1" <?= $tg_on ? 'checked' : '' ?>><span class="sl"></span></label>
              </div>
              <div class="tgslots">
                <input type="text" name="tg_bot_token" value="<?=e($tg_token_show)?>" placeholder="Bot Token" autocomplete="off" title="已保存时显示 **** + 后 4 位；要换就粘贴完整的新 Token">
                <input type="text" name="tg_chat_id" value="<?=e($tg_chat_show)?>" placeholder="chat_id" autocomplete="off">
              </div>
            </div>
            <p class="muted">怎么拿这两个：① TG 里找 @BotFather，/newbot 建个机器人，复制 Token；② 找 @userinfobot 发任意消息，它回你的数字 ID 就是 chat_id；③ 先给你的机器人发一条消息（点 Start），不然它发不出去。填好保存后点下面的“发一条测试通知”，收到就是通了。chat_id 和 Token 都是加密存在本站的，别人打不开。上面两项都填了就直连 Telegram 发通知；没填就继续走下面的中转地址。</p>
            <label>TG 中转地址（上面两项没填时才用；没有自己的 Worker 就留空，直连是首选）</label>
            <input type="text" name="tg_worker" value="<?=e($tg_url)?>">
            <p><button class="btn">保存 TG 设置</button></p>
          </form>
          <?php if ($tg_key_show !== ''): ?>
          <p class="muted">定时任务地址（每 5 分钟调一次；Serv00 的 Cron 或 cron-job.org 都行）：</p>
          <input type="text" readonly value="<?=e(mc_base_url())?>/index.php?tgcheck=1&key=<?=e($tg_key_show)?>" onclick="this.select()" style="font-size:13px" title="点一下全选，复制去定时任务里填">
          <?php endif; ?>
          <form method="post" autocomplete="off" style="margin-top:12px">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="tg_test">
            <p><button class="btn ghost">发一条测试通知</button></p>
          </form>
          <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?=e(csrf())?>">
            <input type="hidden" name="action" value="tg_check_now">
            <p><button class="btn ghost">立即查一轮新邮件并通知</button> <span class="muted">第一次点只记基线、不推；之后有新邮件才推。</span></p>
          </form>
          <p class="muted">注意：开启后服务器上会多一把轮询用的密钥（data/notify_key.php），定时任务凭它解密邮箱凭据来查新邮件；和站点密码文件一样，不要把 data/ 目录公开。关掉通知不会删已记的基线，重开后不会把旧邮件再推一遍。</p>
        </div>
        <div class="card">
          <h2>备用入口（一般不用点）</h2>
          <p class="muted">收信、读信、回信、转发、写信都在本站的「收件箱 / 写信」里完成。SnappyMail 只留作备用：<a href="<?=e(SNAPPY_URL)?>" target="_blank" rel="noopener">SnappyMail 读信 →</a>、<a href="<?=e(ADMIN_URL)?>" target="_blank" rel="noopener">SnappyMail 管理后台 →</a>（域名、插件、OAuth、主题在那里配）。<br>Henna 主题文件在 <code>themes/Henna/styles.css</code>（已另行交付），在管理后台把主题选成 Henna 即可。</p>
        </div>
        <div class="card">
          <h2>安全提醒</h2>
          <p class="muted">1）SnappyMail 自带的 <code>data/</code> 现在还在 <code>public_html/data</code> 里，请按 README 把它移到 <code>~/snappymail-data</code>，并在 <code>_include.php</code> 里加 <code>APP_DATA_FOLDER_PATH</code>。<br>
          2）本站点密码忘了，存着的邮箱凭据就解不开了，只能逐个重新添加。<br>
          3）QQ 改了登录密码，授权码就失效了，要去 QQ 邮箱重新生成一个，再到这里删除旧邮箱、重新添加。</p>
        </div>
      <?php endif; ?>
    </div>
  </div>
<?php endif; ?>
<script>
// 收件箱列表栏默认 340px，两栏之间拖动调整宽度，记在浏览器里下次还用
(function(){
  var rz = document.getElementById('midResizer');
  if (!rz) return;
  var mid = rz.previousElementSibling;
  var saved = null;
  try { saved = parseInt(localStorage.getItem('mc_mid_w') || '', 10); } catch (e) {}
  if (saved && saved >= 260 && saved <= 560) { mid.style.flexBasis = saved + 'px'; mid.style.width = saved + 'px'; }
  var startX = 0, startW = 0, dragging = false;
  function onMove(ev){
    if (!dragging) return;
    var w = startW + (ev.clientX - startX);
    w = Math.max(260, Math.min(560, w));
    mid.style.flexBasis = w + 'px';
    mid.style.width = w + 'px';
  }
  function onUp(ev){
    if (!dragging) return;
    dragging = false;
    rz.classList.remove('drag');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    try { localStorage.setItem('mc_mid_w', String(parseInt(mid.style.width, 10) || 340)); } catch (e) {}
  }
  rz.addEventListener('pointerdown', function(ev){
    ev.preventDefault();
    dragging = true;
    startX = ev.clientX;
    startW = mid.getBoundingClientRect().width;
    rz.classList.add('drag');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
})();
// 侧栏折叠：点侧栏右边线上的 « 收起成只有图标的窄栏，点 » 再展开，记在浏览器里下次还用
(function(){
  var btn = document.getElementById('sideEdge');
  if (!btn) return;
  var chev = btn.querySelector('svg path');
  var wrap = btn.closest('.wrap');
  if (!wrap || !chev) return;
  function apply(collapsed){
    wrap.classList.toggle('side-collapsed', collapsed);
    chev.setAttribute('d', collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6');
    btn.title = collapsed ? '展开侧栏' : '收起侧栏';
  }
  var saved = null;
  try { saved = localStorage.getItem('mc_side_collapsed'); } catch (e) {}
  apply(saved === '1');
  btn.addEventListener('click', function(){
    var c = !wrap.classList.contains('side-collapsed');
    apply(c);
    try { localStorage.setItem('mc_side_collapsed', c ? '1' : '0'); } catch (e) {}
  });
  // 折叠时左栏只剩图标：点“我的邮箱”图标就展开侧栏，方便选邮箱（不跳转页面）
  var mbIco = document.getElementById('mbIco');
  if (mbIco) {
    mbIco.addEventListener('click', function(ev){
      ev.preventDefault();
      apply(false);
      try { localStorage.setItem('mc_side_collapsed', '0'); } catch (e) {}
    });
  }
  // 折叠钮跟着鼠标走：鼠标移到边线上哪里，钮就出现在那个高度，移开边线就藏起来
  var edgeBtn = btn.querySelector('.edge-btn');
  if (edgeBtn) {
    btn.addEventListener('mousemove', function(ev){
      var r = btn.getBoundingClientRect();
      var y = ev.clientY - r.top;
      if (y < 10) y = 10;
      if (y > r.height - 10) y = r.height - 10;
      edgeBtn.style.top = y + 'px';
    });
    btn.addEventListener('mouseleave', function(){
      edgeBtn.style.top = '50%';
    });
  }
})();
</script>
</body>
</html>
