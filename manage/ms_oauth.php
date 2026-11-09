<?php
declare(strict_types=1);
// ---------- 微软 OAuth2（Outlook / Hotmail） ----------
// 由 index.php 与 oauth.php 共用。只定义函数，不输出任何东西。
// 令牌刷新时写回 mailboxes.php，用的是 index.php / oauth.php 里同一套
// load_mailboxes() / save_mailboxes()，不在这里另写存储。
// 注意：这个文件里不写 PHP 闭合标记（任何位置都不写，包括注释）。

// 锁定值：重定向 URI 必须和 Azure 应用注册里填的一字不差
define('MS_REDIRECT_URI', 'https://mangguo.lele.pp.ua/oauth.php?step=ms_callback');
define('MS_AUTH_URL', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
define('MS_TOKEN_URL', 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
define('MS_SCOPES', 'https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send offline_access openid email profile');

// base64url 解码（id_token 载荷用）
function ms_base64url_decode(string $s): string {
    $s = strtr($s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad > 0) {
        $s .= str_repeat('=', 4 - $pad);
    }
    $d = base64_decode($s, true);
    return $d === false ? '' : $d;
}

// 从站点设置里读解密后的 Client ID + Client Secret
function ms_config(string $key): array {
    $site = load_site();
    if (!is_array($site)) {
        return ['id' => '', 'secret' => ''];
    }
    $id = '';
    $sec = '';
    if (!empty($site['ms_client_id'])) {
        $d = decrypt_cred((string)$site['ms_client_id'], $key);
        if (is_string($d)) {
            $id = $d;
        }
    }
    if (!empty($site['ms_client_secret'])) {
        $d = decrypt_cred((string)$site['ms_client_secret'], $key);
        if (is_string($d)) {
            $sec = $d;
        }
    }
    return ['id' => $id, 'secret' => $sec];
}

// 把 Client ID + Secret 加密存进站点设置（设置页 ms_save 动作调用）
function ms_save_config(string $key, string $id, string $secret): void {
    $site = load_site();
    if (!is_array($site)) {
        $site = [];
    }
    $site['ms_client_id'] = $id === '' ? '' : encrypt_cred($id, $key);
    $site['ms_client_secret'] = $secret === '' ? '' : encrypt_cred($secret, $key);
    save_site($site);
}

// 拼微软授权页地址
function ms_authorize_url(string $key, string $state): string {
    $cfg = ms_config($key);
    $q = http_build_query([
        'client_id' => $cfg['id'],
        'response_type' => 'code',
        'redirect_uri' => MS_REDIRECT_URI,
        'response_mode' => 'query',
        'scope' => MS_SCOPES,
        'state' => $state,
    ], '', '&');
    return MS_AUTH_URL . '?' . $q;
}

// POST 到令牌端点（file_get_contents + stream_context_create，不用 curl）。
// 成功返回微软的 JSON 解码数组；失败返回 ['error' => '人话原因']。
function ms_http_post_token(array $params): array {
    $body = http_build_query($params, '', '&');
    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/x-www-form-urlencoded\r\n"
                . 'Content-Length: ' . strlen($body) . "\r\n",
            'content' => $body,
            'timeout' => 20,
            'ignore_errors' => true,
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $raw = @file_get_contents(MS_TOKEN_URL, false, $ctx);
    if ($raw === false || $raw === '') {
        return ['error' => '连不上微软的令牌服务，请检查服务器网络，稍后再试'];
    }
    $d = json_decode($raw, true);
    if (!is_array($d)) {
        return ['error' => '微软返回的结果看不懂，请稍后再试'];
    }
    if (isset($d['error'])) {
        $desc = trim((string)preg_replace('/\s+/', ' ', (string)($d['error_description'] ?? '')));
        if (mb_strlen($desc) > 200) {
            $desc = mb_substr($desc, 0, 200) . '…';
        }
        return ['error' => (string)$d['error'] . ($desc !== '' ? '：' . $desc : '')];
    }
    return $d;
}

// 授权码换令牌
function ms_exchange_code(string $key, string $code): array {
    $cfg = ms_config($key);
    return ms_http_post_token([
        'client_id' => $cfg['id'],
        'client_secret' => $cfg['secret'],
        'grant_type' => 'authorization_code',
        'code' => $code,
        'redirect_uri' => MS_REDIRECT_URI,
    ]);
}

// refresh_token 换新令牌
function ms_refresh_token(string $key, string $refresh_token): array {
    $cfg = ms_config($key);
    return ms_http_post_token([
        'client_id' => $cfg['id'],
        'client_secret' => $cfg['secret'],
        'grant_type' => 'refresh_token',
        'refresh_token' => $refresh_token,
    ]);
}

// XOAUTH2 用的认证串：base64("user=邮箱\x01auth=Bearer 令牌\x01\x01")
function ms_token_blob(string $email, string $access_token): string {
    return base64_encode('user=' . $email . "\x01" . 'auth=Bearer ' . $access_token . "\x01\x01");
}

// 给一个 auth 为 'ms' 的邮箱拿可用的 access token。
// 没过期直接用；过期了用 refresh token 换新的，换到的写回邮箱记录
// （同一请求里再调直接走缓存，不会重复刷新把 refresh token 刷废）。
// 拿不到返回 ''，调用方按这个报错。
function ms_valid_access_token(array &$mb, string $key): string {
    static $cache = [];
    $id = (string)($mb['id'] ?? '');
    if ($id !== '' && isset($cache[$id]) && $cache[$id]['exp'] > time() + 60) {
        return $cache[$id]['token'];
    }
    $acc = decrypt_cred((string)($mb['ms_access'] ?? ''), $key);
    $exp = (int)($mb['ms_expires_at'] ?? 0);
    if (is_string($acc) && $acc !== '' && $exp > time() + 60) {
        if ($id !== '') {
            $cache[$id] = ['token' => $acc, 'exp' => $exp];
        }
        return $acc;
    }
    $ref = decrypt_cred((string)($mb['ms_refresh'] ?? ''), $key);
    if (!is_string($ref) || $ref === '') {
        return '';
    }
    $r = ms_refresh_token($key, $ref);
    if (empty($r['access_token'])) {
        return '';
    }
    $new_acc = (string)$r['access_token'];
    $new_ref = (string)($r['refresh_token'] ?? $ref);
    $new_exp = time() + (int)($r['expires_in'] ?? 3600) - 60;
    $mb['ms_access'] = encrypt_cred($new_acc, $key);
    $mb['ms_refresh'] = encrypt_cred($new_ref, $key);
    $mb['ms_expires_at'] = $new_exp;
    // 写回文件（走同一条邮箱写入路径）
    $list = load_mailboxes();
    foreach ($list as &$m) {
        if ((string)($m['id'] ?? '') === $id) {
            $m['ms_access'] = $mb['ms_access'];
            $m['ms_refresh'] = $mb['ms_refresh'];
            $m['ms_expires_at'] = $new_exp;
            break;
        }
    }
    unset($m);
    save_mailboxes($list);
    if ($id !== '') {
        $cache[$id] = ['token' => $new_acc, 'exp' => $new_exp];
    }
    return $new_acc;
}
