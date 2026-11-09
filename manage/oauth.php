<?php
// 微软 OAuth2 登录入口（v4.0）：Outlook / Hotmail 用微软账号登录添加。
// 部署：传到 public_html 根目录，和 index.php 同一目录（不要放进 manage/ 子目录）。
// 共享 index.php 的引导（session、DATA_DIR、站点加载、$key、加解密），
// 令牌换取 / 刷新 / XOAUTH2 认证串见 ms_oauth.php。

declare(strict_types=1);
session_start();
// 页面上永远不直接显示 PHP 警告/报错（只记日志），免得英文报错堆在页面顶部。
ini_set('display_errors', '0');
require_once __DIR__ . '/ms_oauth.php';

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

// ---------- 微软 OAuth2 入口 ----------
// 部署后放在 public_html 根目录，和 index.php 同一目录。
// ?step=ms_start：跳微软授权页；?step=ms_callback：微软跳回来换令牌、建邮箱。
// 只接受已登录管理中心的人，令牌和 Secret 永远不往页面上输出。

$step = (string)($_GET['step'] ?? '');
if (!logged_in()) {
    header('Location: index.php');
    exit;
}
$key = (string)($_SESSION['mc_key'] ?? '');

if ($step === 'ms_start') {
    $cfg = ms_config($key);
    if ($cfg['id'] === '' || $cfg['secret'] === '') {
        flash('先在设置里填好微软的 Client ID 和 Client Secret，再点微软账号登录。', 'err');
        header('Location: index.php?tab=settings');
        exit;
    }
    $state = bin2hex(random_bytes(16));
    $_SESSION['ms_oauth_state'] = $state;
    header('Location: ' . ms_authorize_url($key, $state));
    exit;
}

if ($step === 'ms_callback') {
    $state = (string)($_SESSION['ms_oauth_state'] ?? '');
    unset($_SESSION['ms_oauth_state']); // 无论对不对都清掉，只用一次
    $err = (string)($_GET['error'] ?? '');
    if ($err !== '') {
        $desc = trim((string)($_GET['error_description'] ?? ''));
        flash('微软那边没通过：' . ($desc !== '' ? $desc : $err) . '。', 'err');
        header('Location: index.php?tab=mailboxes');
        exit;
    }
    $got_state = (string)($_GET['state'] ?? '');
    if ($state === '' || !hash_equals($state, $got_state)) {
        flash('微软返回的状态对不上（可能是页面过期或重复打开了），请重新点一次微软账号登录。', 'err');
        header('Location: index.php?tab=mailboxes');
        exit;
    }
    $code = (string)($_GET['code'] ?? '');
    if ($code === '') {
        flash('微软没有返回授权码，请重新点一次微软账号登录。', 'err');
        header('Location: index.php?tab=mailboxes');
        exit;
    }
    $tok = ms_exchange_code($key, $code);
    if (empty($tok['access_token'])) {
        flash('微软没给令牌：' . (string)($tok['error'] ?? '未知原因') . '。检查重定向 URI 是否和 Azure 里填的一模一样。', 'err');
        header('Location: index.php?tab=mailboxes');
        exit;
    }
    // 从 id_token 里取邮箱和显示名（只解载荷，不验签名，个人用够用；
    // 但要核对 aud 是不是本应用、exp 有没有过期）
    $email = '';
    $dname = '';
    $idtok = (string)($tok['id_token'] ?? '');
    if ($idtok !== '') {
        $parts = explode('.', $idtok);
        if (count($parts) === 3) {
            $payload = json_decode(ms_base64url_decode($parts[1]), true);
            if (is_array($payload)) {
                $aud = (string)($payload['aud'] ?? '');
                $exp = (int)($payload['exp'] ?? 0);
                $cfg = ms_config($key);
                if ($aud !== '' && $aud !== $cfg['id']) {
                    flash('微软返回的身份信息对不上这个应用，请检查设置里的 Client ID 是否填对。', 'err');
                    header('Location: index.php?tab=mailboxes');
                    exit;
                }
                if ($exp > 0 && $exp <= time()) {
                    flash('微软返回的身份信息已过期，请重新点一次微软账号登录。', 'err');
                    header('Location: index.php?tab=mailboxes');
                    exit;
                }
                $email = (string)($payload['preferred_username'] ?? $payload['email'] ?? '');
                $dname = (string)($payload['name'] ?? '');
            }
        }
    }
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('微软没有返回邮箱地址，请重新点一次微软账号登录。', 'err');
        header('Location: index.php?tab=mailboxes');
        exit;
    }
    // 令牌加密存，过期时间留 60 秒余量
    $access = (string)$tok['access_token'];
    $refresh = (string)($tok['refresh_token'] ?? '');
    $expires = time() + (int)($tok['expires_in'] ?? 3600) - 60;
    $list = load_mailboxes();
    $found = false;
    foreach ($list as &$m) {
        if (strcasecmp((string)($m['email'] ?? ''), $email) === 0) {
            // 这个邮箱已经加过：改成微软登录，换上新令牌，服务器写死微软的
            $m['auth'] = 'ms';
            $m['method'] = 'ms';
            $m['provider'] = 'Outlook';
            $m['imap_host'] = 'outlook.office365.com';
            $m['imap_port'] = 993;
            $m['imap_enc'] = 'ssl';
            $m['smtp_host'] = 'smtp.office365.com';
            $m['smtp_port'] = 587;
            $m['smtp_enc'] = 'tls';
            if ($dname !== '') {
                $m['display_name'] = $dname;
            }
            $m['credential'] = encrypt_cred('', $key);
            $m['ms_access'] = encrypt_cred($access, $key);
            $m['ms_refresh'] = encrypt_cred($refresh, $key);
            $m['ms_expires_at'] = $expires;
            $m['status'] = 'ok';
            $m['last_test'] = date('Y-m-d H:i');
            $m['last_error'] = '';
            $found = true;
            break;
        }
    }
    unset($m);
    if (!$found) {
        $list[] = [
            'id' => bin2hex(random_bytes(8)),
            'email' => $email,
            'display_name' => $dname !== '' ? $dname : (string)(strtok($email, '@') ?: $email),
            'group' => '未分组',
            'provider' => 'Outlook',
            'method' => 'ms',
            'auth' => 'ms',
            'imap_host' => 'outlook.office365.com',
            'imap_port' => 993,
            'imap_enc' => 'ssl',
            'smtp_host' => 'smtp.office365.com',
            'smtp_port' => 587,
            'smtp_enc' => 'tls',
            'credential' => encrypt_cred('', $key),
            'ms_access' => encrypt_cred($access, $key),
            'ms_refresh' => encrypt_cred($refresh, $key),
            'ms_expires_at' => $expires,
            'status' => 'ok',
            'last_test' => date('Y-m-d H:i'),
            'last_error' => '',
        ];
    }
    save_mailboxes($list);
    flash('微软账号 ' . $email . ' 已加上，以后不用填密码和授权码，直接用微软登录收发信。');
    header('Location: index.php?tab=mailboxes');
    exit;
}

// 其他步骤直接回邮箱管理
header('Location: index.php?tab=mailboxes');
exit;
