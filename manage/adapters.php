<?php
/**
 * ---------- 域名邮箱适配器注册表（v4.30） ----------
 *
 * Henna / Cloud Mail 这类没有 IMAP/SMTP、只给 HTTP API 的域名邮箱，
 * 是靠“适配器”接进来的：一种面板软件 = 一个适配器文件 + 下面注册表里的一行。
 *
 * 想加一种新的域名邮箱（比如你自己搭的、或者别人写的面板）：
 *   1. 复制 manage/adapter-template.php 改成 manage/<你的 kind>.php，
 *      按里面的注释把 HTTP 调用接上（函数名都叫 <kind>_xxx，签名见 ADAPTERS.md）；
 *   2. 在下面 $MC_API_ADAPTERS 里加一行（label、面板地址文案、删信提示这几项）；
 *   3. 不用改 index.php——厂商下拉、添加表单、测试连接、收信读信发信删信、
 *      附件下载、TG 跳过，全都走下面的注册表和分发函数。
 *
 * 约定：适配器函数签名统一是（见 ADAPTERS.md 的表）：
 *   <kind>_token_for($panel, $login, $cred, $mb_id = ''): string
 *   <kind>_account_id_for($panel, $token, $address): array   // 可选，没有就不用
 *   <kind>_test($panel, $login, $cred, $address): array      // [ok, 人话]
 *   <kind>_folder_map(): array                               // inbox/sent/... => 面板里的名字
 *   <kind>_fetch_list($panel, $token, $account_id, $address, $folder, $page, $per = 30): array
 *   <kind>_fetch_message($panel, $token, $account_id, $folder, $uid): array
 *   <kind>_mark_read($panel, $token, $account_id, array $ids): bool
 *   <kind>_delete($panel, $token, $account_id, array $ids): array
 *   <kind>_send($panel, $token, $account_id, $from, array $to, $subject, $text): array
 *   <kind>_download($panel, $token, $account_id, $att): array
 * 其中 $account_id 是给 Cloud Mail 这类“登录身份下挂多个地址”的面板用的：
 * 没有这个概念的适配器不用写 _account_id_for，分发函数会传 null，函数里忽略就行。
 */

$MC_API_ADAPTERS = [
    'henna' => [
        'label' => 'Henna',
        'file' => 'henna.php',
        'panel_label' => 'Henna 面板地址',
        'panel_placeholder' => 'https://你的 Henna 面板地址',
        'about' => 'Henna 面板没有 IMAP / SMTP，邮件存在它自己的数据库里；这里走 Henna 的 HTTP API 收发，不用填下面的 IMAP / SMTP 服务器。登录账号是登面板用的邮箱，一般和下面的邮箱地址一样，会自动填过去，不一样就自己改；密码也可以直接贴面板设置里的 API Key。',
        'note' => '注意：Henna 没有已删除，删信就是彻底删除，删了找不回来。',
        'delete_ok' => '已彻底删除。',
        'trash_note' => 'Henna 没有已删除：删了就是彻底删除，找不回来。',
        'no_folder_note' => '',
    ],
    'cloudmail' => [
        'label' => 'Cloud Mail',
        'file' => 'cloudmail.php',
        'panel_label' => 'Cloud Mail 面板地址',
        'panel_placeholder' => 'https://你的 Cloud Mail 面板地址',
        'about' => 'Cloud Mail 面板没有 IMAP / SMTP，邮件存在它自己的数据库里；这里走 Cloud Mail 的 HTTP API 收发，不用填下面的 IMAP / SMTP 服务器。登录账号是登面板用的那个用户账号（它名下可以有多个 @域名 地址），一般和下面的邮箱地址一样，会自动填过去，不一样就自己改；一个登录账号下的多个地址要一个一个加，每条只管一个地址。',
        'note' => '注意：Cloud Mail 只有收件箱和已发送，没有草稿、垃圾箱、已删除；删信就是从列表删掉，找不回来。发信走面板的 CF Email（要 Workers Paid）或 Resend，没配好发信会报错。',
        'delete_ok' => '已删除（Cloud Mail 没有已删除，删了就找不回来）。',
        'trash_note' => '',
        'no_folder_note' => 'Cloud Mail 只有收件箱和已发送，没有这个文件夹。',
    ],
];

function mc_api_adapters(): array {
    global $MC_API_ADAPTERS;
    return $MC_API_ADAPTERS;
}

// 是不是走 HTTP API 的域名邮箱 kind（不是就是普通 IMAP/SMTP 邮箱）。
function mc_api_is_api_kind(string $kind): bool {
    global $MC_API_ADAPTERS;
    return isset($MC_API_ADAPTERS[$kind]);
}

function mc_api_label(string $kind): string {
    global $MC_API_ADAPTERS;
    return (string)($MC_API_ADAPTERS[$kind]['label'] ?? $kind);
}

// 注册表里某 kind 的某项文案（没有就返回默认值）。
function mc_api_meta(string $kind, string $key, string $def = ''): string {
    global $MC_API_ADAPTERS;
    return (string)($MC_API_ADAPTERS[$kind][$key] ?? $def);
}

function mc_api_delete_ok(string $kind): string {
    return mc_api_meta($kind, 'delete_ok', '已删除。');
}

function mc_api_trash_note(string $kind): string {
    return mc_api_meta($kind, 'trash_note', '');
}

function mc_api_no_folder_note(string $kind): string {
    return mc_api_meta($kind, 'no_folder_note', '');
}

// 某个文件夹打不开时给用户看的一句话：trash 优先用 trash_note（Henna 那句），
// 否则用 no_folder_note（Cloud Mail 那句），都没有就拼一句通用的。
function mc_api_no_folder_msg(string $kind, string $folder): string {
    if ($folder === 'trash') {
        $t = mc_api_trash_note($kind);
        if ($t !== '') return $t;
    }
    $n = mc_api_no_folder_note($kind);
    return $n !== '' ? $n : mc_api_label($kind) . ' 没有这个文件夹。';
}

// 删信前的确认文案（列表行和读信页共用；dest 是 trash/spam）。
function mc_api_delete_confirm(string $kind, string $dest = 'trash'): string {
    if (!mc_api_is_api_kind($kind)) {
        return $dest === 'spam' ? '确定把这封邮件移到垃圾箱吗？' : '确定删除这封邮件吗？会移到已删除。';
    }
    $t = mc_api_trash_note($kind);
    if ($t !== '') return '确定删除这封邮件吗？' . $t;
    return '确定删除这封邮件吗？' . mc_api_label($kind) . ' 没有已删除，删了就找不回来。';
}

// 读信页删信按钮上的字：Henna 是“彻底删除”，其他域名邮箱是“删除”。
function mc_api_delete_btn(string $kind): string {
    if (!mc_api_is_api_kind($kind)) return '移到垃圾箱';
    return strpos(mc_api_trash_note($kind), '彻底') !== false ? '彻底删除' : '删除';
}

// 从一条邮箱记录里读面板地址：新记录存 panel_url，老记录存 <kind>_panel，都认。
function mc_api_panel_of(array $mb): string {
    $kind = (string)($mb['kind'] ?? 'imap');
    $v = trim((string)($mb['panel_url'] ?? ''));
    if ($v !== '') return $v;
    return trim((string)($mb[$kind . '_panel'] ?? ''));
}

// 从一条邮箱记录里读面板登录账号：新记录存 panel_login，老记录存 <kind>_login，都认。
function mc_api_login_of(array $mb): string {
    $kind = (string)($mb['kind'] ?? 'imap');
    $v = trim((string)($mb['panel_login'] ?? ''));
    if ($v !== '') return $v;
    return trim((string)($mb[$kind . '_login'] ?? ''));
}

// 拿适配器的登录令牌（失败返回 ''）。令牌不存数据库，每次现拿。
function mc_api_token_for(string $kind, array $mb, string $cred): string {
    $fn = $kind . '_token_for';
    if (!function_exists($fn)) return '';
    $t = $fn(mc_api_panel_of($mb), mc_api_login_of($mb), $cred, (string)($mb['id'] ?? ''));
    return is_string($t) ? $t : '';
}

// 拿“地址在登录账号下的数字 id”（Cloud Mail 这类才有；没有这个概念的适配器返回 [null, null]）。
// 返回 [id, 错误]：出错时 id 是 0、错误是人话。
function mc_api_account_id_for(string $kind, array $mb, string $token): array {
    $fn = $kind . '_account_id_for';
    if (!function_exists($fn)) return [null, null];
    $r = $fn(mc_api_panel_of($mb), $token, (string)($mb['email'] ?? ''));
    if (!is_array($r)) return [0, mc_api_label($kind) . ' 账号没找着。'];
    $id = (int)($r[0] ?? 0);
    if ($id <= 0) return [0, trim((string)($r[1] ?? '')) !== '' ? (string)$r[1] : (mc_api_label($kind) . ' 账号没找着。')];
    return [$id, null];
}

// 测试连接：[是否成功, 人话]。
function mc_api_test(string $kind, string $panel, string $login, string $cred, string $address): array {
    $fn = $kind . '_test';
    if (!function_exists($fn)) return [false, mc_api_label($kind) . ' 的适配器没装好。'];
    $r = $fn($panel, $login, $cred, $address);
    if (!is_array($r)) return [false, '测试没返回结果。'];
    return [(bool)($r[0] ?? false), (string)($r[1] ?? '')];
}

// 文件夹映射：管理中心的文件夹名（inbox/sent/drafts/spam/trash）=> 适配器要传的值。
function mc_api_folder_map(string $kind): array {
    $fn = $kind . '_folder_map';
    if (!function_exists($fn)) return ['inbox' => 'inbox', 'sent' => 'sent'];
    $m = $fn();
    return is_array($m) ? $m : [];
}

// 取一页邮件列表。成功返回 ['rows' => [...], 'total' => int]，失败返回 ['error' => 人话]。
// rows 每一项是管理中心列表的形状：uid/seen/date/subject/from_name/from_addr/to/snippet/size。
function mc_api_fetch_list(string $kind, array $mb, string $cred, string $folder, int $page, int $per = 30): array {
    $label = mc_api_label($kind);
    $token = mc_api_token_for($kind, $mb, $cred);
    if ($token === '') return ['error' => $label . ' 登录失败，请检查面板登录邮箱和密码。'];
    [$aid, $aerr] = mc_api_account_id_for($kind, $mb, $token);
    if ($aerr !== null) return ['error' => $aerr];
    $fn = $kind . '_fetch_list';
    if (!function_exists($fn)) return ['error' => $label . ' 的适配器没装好。'];
    $r = $fn(mc_api_panel_of($mb), $token, $aid, (string)($mb['email'] ?? ''), $folder, $page, $per);
    if (!is_array($r)) return ['error' => $label . ' 返回的邮件列表看不懂。'];
    return $r;
}

// 取一封邮件全文。成功返回 ['from','from_name','to','subject','date','text','html','attachments']，
// 失败返回 ['error' => 人话]。attachments 每项是 ['id','filename','ctype','size', ...]。
function mc_api_fetch_message(string $kind, array $mb, string $cred, string $folder, int $uid): array {
    $label = mc_api_label($kind);
    $token = mc_api_token_for($kind, $mb, $cred);
    if ($token === '') return ['error' => $label . ' 登录失败，请检查面板登录邮箱和密码。'];
    [$aid, $aerr] = mc_api_account_id_for($kind, $mb, $token);
    if ($aerr !== null) return ['error' => $aerr];
    $fn = $kind . '_fetch_message';
    if (!function_exists($fn)) return ['error' => $label . ' 的适配器没装好。'];
    $r = $fn(mc_api_panel_of($mb), $token, $aid, $folder, $uid);
    if (!is_array($r)) return ['error' => $label . ' 返回的邮件看不懂。'];
    return $r;
}

// 标已读（尽力而为，失败也不报错）。
function mc_api_mark_read(string $kind, array $mb, string $cred, int $uid): bool {
    $token = mc_api_token_for($kind, $mb, $cred);
    if ($token === '') return false;
    [$aid, $aerr] = mc_api_account_id_for($kind, $mb, $token);
    if ($aerr !== null) return false;
    $fn = $kind . '_mark_read';
    if (!function_exists($fn)) return false;
    return (bool)$fn(mc_api_panel_of($mb), $token, $aid, [$uid]);
}

// 删一封邮件。返回 [是否成功, 人话]：成功时人话是注册表里的 delete_ok。
function mc_api_delete(string $kind, array $mb, string $cred, int $uid): array {
    $label = mc_api_label($kind);
    $token = mc_api_token_for($kind, $mb, $cred);
    if ($token === '') return [false, $label . ' 登录失败，请检查面板登录邮箱和密码。'];
    [$aid, $aerr] = mc_api_account_id_for($kind, $mb, $token);
    if ($aerr !== null) return [false, $aerr];
    $fn = $kind . '_delete';
    if (!function_exists($fn)) return [false, $label . ' 的适配器没装好。'];
    $r = $fn(mc_api_panel_of($mb), $token, $aid, [$uid]);
    if (!is_array($r) || empty($r[0])) return [false, (string)($r[1] ?? '删不掉，也没说原因。')];
    return [true, mc_api_delete_ok($kind)];
}

// 经适配器发信（纯文本；抄送请调用方先并进 $to）。返回 [是否成功, 人话]。
function mc_api_send(string $kind, array $mb, string $cred, array $to, string $subject, string $body): array {
    $label = mc_api_label($kind);
    $token = mc_api_token_for($kind, $mb, $cred);
    if ($token === '') return [false, $label . ' 登录失败，请检查面板登录邮箱和密码。'];
    [$aid, $aerr] = mc_api_account_id_for($kind, $mb, $token);
    if ($aerr !== null) return [false, $aerr];
    $fn = $kind . '_send';
    if (!function_exists($fn)) return [false, $label . ' 的适配器没装好。'];
    $r = $fn(mc_api_panel_of($mb), $token, $aid, (string)($mb['email'] ?? ''), $to, $subject, $body);
    if (!is_array($r)) return [false, '发信没返回结果。'];
    return [(bool)($r[0] ?? false), (string)($r[1] ?? '')];
}

// 下一个附件。$att 是取全文时 attachments 里的那一项。
// 成功返回 ['ctype'=>..., 'body'=>...]，失败返回 ['error' => 人话]。
function mc_api_download(string $kind, array $mb, string $cred, array $att): array {
    $label = mc_api_label($kind);
    $token = mc_api_token_for($kind, $mb, $cred);
    if ($token === '') return ['error' => $label . ' 登录失败，请检查面板登录邮箱和密码。'];
    [$aid, $aerr] = mc_api_account_id_for($kind, $mb, $token);
    if ($aerr !== null) return ['error' => $aerr];
    $fn = $kind . '_download';
    if (!function_exists($fn)) return ['error' => $label . ' 的适配器没装好。'];
    $r = $fn(mc_api_panel_of($mb), $token, $aid, $att);
    if (!is_array($r)) return ['error' => '附件下不下来。'];
    return $r;
}
