<?php
// R2（S3 兼容）最小客户端：只做 PUT / GET / DELETE / 列表，纯 PHP，无 SDK。
// 环境变量：R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
// 只能在 CLI 下被调用（容器里的备份/恢复脚本用）。
if (php_sapi_name() !== 'cli') { http_response_code(403); exit('cli only'); }

function r2_env($k) { $v = getenv($k); return $v === false ? '' : $v; }
function r2_configured() { return r2_env('R2_ACCOUNT_ID') !== '' && r2_env('R2_ACCESS_KEY_ID') !== '' && r2_env('R2_SECRET_ACCESS_KEY') !== '' && r2_env('R2_BUCKET') !== ''; }

// 一次 S3 签名请求（SigV4，region 固定 auto）。返回 [http状态码, 响应体]。
function r2_request($method, $key, $body = null, $query = '') {
    $host = r2_env('R2_ACCOUNT_ID') . '.r2.cloudflarestorage.com';
    $bucket = r2_env('R2_BUCKET');
    $ak = r2_env('R2_ACCESS_KEY_ID');
    $sk = r2_env('R2_SECRET_ACCESS_KEY');
    $region = 'auto';
    if ($key === '') {
        $uri = '/' . $bucket;
    } else {
        $uri = '/' . $bucket . '/' . implode('/', array_map('rawurlencode', explode('/', $key)));
    }
    $url = 'https://' . $host . $uri . ($query !== '' ? '?' . $query : '');
    $now = gmdate('Ymd\THis\Z');
    $date = gmdate('Ymd');
    $payload_hash = hash('sha256', $body === null ? '' : $body);
    $canon_headers = "host:$host\nx-amz-content-sha256:$payload_hash\nx-amz-date:$now\n";
    $signed_headers = 'host;x-amz-content-sha256;x-amz-date';
    $canon_req = implode("\n", [$method, $uri, $query, $canon_headers, $signed_headers, $payload_hash]);
    $scope = "$date/$region/s3/aws4_request";
    $string_to_sign = "AWS4-HMAC-SHA256\n$now\n$scope\n" . hash('sha256', $canon_req);
    $k_date = hash_hmac('sha256', $date, 'AWS4' . $sk, true);
    $k_region = hash_hmac('sha256', $region, $k_date, true);
    $k_service = hash_hmac('sha256', 's3', $k_region, true);
    $k_signing = hash_hmac('sha256', 'aws4_request', $k_service, true);
    $sig = hash_hmac('sha256', $string_to_sign, $k_signing);
    $auth = "AWS4-HMAC-SHA256 Credential=$ak/$scope, SignedHeaders=$signed_headers, Signature=$sig";
    $opts = ['http' => [
        'method' => $method,
        'header' => "Authorization: $auth\r\nx-amz-content-sha256: $payload_hash\r\nx-amz-date: $now\r\n",
        'content' => $body === null ? '' : $body,
        'ignore_errors' => true,
        'timeout' => 30,
    ]];
    $ctx = stream_context_create($opts);
    $resp = @file_get_contents($url, false, $ctx);
    $status = 0;
    if (isset($http_response_header[0]) && preg_match('#HTTP/\S+\s+(\d+)#', $http_response_header[0], $m)) $status = (int)$m[1];
    return [$status, $resp === false ? '' : $resp];
}

function r2_put($key, $body) { return r2_request('PUT', $key, $body); }
function r2_get($key) { return r2_request('GET', $key); }
function r2_delete($key) { return r2_request('DELETE', $key); }

// 列出指定前缀下的所有 key（只取 <Key>，不翻页：文件数很少，一页够）。
function r2_list($prefix) {
    list($st, $body) = r2_request('GET', '', null, 'list-type=2&prefix=' . rawurlencode($prefix));
    if ($st !== 200) return [];
    if (!preg_match_all('#<Key>([^<]+)</Key>#', $body, $m)) return [];
    return $m[1];
}
