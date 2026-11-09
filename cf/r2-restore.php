<?php
// 容器启动时从 R2 把 data/ 拉回来（只补本地没有的文件，不覆盖本地已有的）。
// 用法：php /opt/mc/r2-restore.php（entrypoint.sh 里跑一次）
require __DIR__ . '/r2store.php';

define('MC_DATA_DIR', '/var/www/html/data');

if (!r2_configured()) { echo "R2 not configured, skip\n"; exit(0); }
if (!is_dir(MC_DATA_DIR)) @mkdir(MC_DATA_DIR, 0700, true);
$restored = 0; $kept = 0;
foreach (r2_list('data/') as $key) {
    $local = MC_DATA_DIR . '/' . basename($key);
    if (is_file($local)) { $kept++; continue; }
    list($st, $body) = r2_get($key);
    if ($st === 200) { @file_put_contents($local, $body); $restored++; echo "get $key\n"; }
    else echo "get $key FAILED ($st)\n";
}
echo "restore done: restored=$restored kept=$kept\n";
