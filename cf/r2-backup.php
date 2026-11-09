<?php
// 把 data/ 里重要的文件同步到 R2（只传变了的，删掉本地已没有的）。
// 缓存文件 cache_*.php 不同步，丢了会自动重建。
// 用法：php /opt/mc/r2-backup.php（cron 每 5 分钟跑一次，见 entrypoint.sh）
require __DIR__ . '/r2store.php';

define('MC_DATA_DIR', '/var/www/html/data');
define('MC_STATE_FILE', '/opt/mc/.r2state.json');

// 重要文件：固定几个 + TG 已推记录；缓存不管。
function mc_durable_files() {
    $fixed = ['site.php', 'salt.php', 'mailboxes.php', 'remember.php', 'notify_key.php'];
    $out = [];
    foreach ($fixed as $f) {
        $p = MC_DATA_DIR . '/' . $f;
        if (is_file($p)) $out['data/' . $f] = $p;
    }
    foreach (glob(MC_DATA_DIR . '/notify_seen_*.php') as $p) {
        $out['data/' . basename($p)] = $p;
    }
    return $out;
}

if (!r2_configured()) { echo "R2 not configured, skip\n"; exit(0); }
$state = [];
if (is_file(MC_STATE_FILE)) { $state = json_decode((string)@file_get_contents(MC_STATE_FILE), true) ?: []; }
$files = mc_durable_files();
$uploaded = 0; $skipped = 0;
foreach ($files as $key => $path) {
    $body = @file_get_contents($path);
    if ($body === false) continue;
    $hash = hash('sha256', $body);
    if (($state[$key] ?? '') === $hash) { $skipped++; continue; }
    list($st, $resp) = r2_put($key, $body);
    if ($st === 200) { $state[$key] = $hash; $uploaded++; echo "put $key\n"; }
    else echo "put $key FAILED ($st) $resp\n";
}
// 本地已删的文件，也从 R2 删掉
foreach (r2_list('data/') as $key) {
    if (!isset($files[$key])) {
        list($st) = r2_delete($key);
        if ($st === 204 || $st === 200) { unset($state[$key]); echo "del $key\n"; }
    }
}
@file_put_contents(MC_STATE_FILE, json_encode($state));
echo "backup done: uploaded=$uploaded skipped=$skipped\n";
