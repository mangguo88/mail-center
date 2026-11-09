# 给自己的域名邮箱写一个适配器（v4.30）

管理中心本来只会接 IMAP / SMTP 邮箱。Henna、Cloud Mail 这类**没有 IMAP / SMTP、邮件存在自己数据库里、只给 HTTP API 的域名邮箱面板**，是靠“适配器”接进来的。

加一种新的域名邮箱（比如你自己搭的面板，或者别人写的面板软件），**不用改 `index.php`**，三步：

## 1. 复制模板，改成你的面板

```bash
cp manage/adapter-template.php manage/<你的 kind>.php
# 比如 kind 叫 mybox，就叫 manage/mybox.php
```

`kind` 是个短英文名，只能用小写字母和数字（比如 `mybox`、`rainmail`），它就是这条邮箱记录的 `kind`，别和已有的 `henna` / `cloudmail` / `imap` 重名。

打开新文件，把所有 `mybox_` 改成 `<你的 kind>_`，再按每个函数上面“改这里”的注释，把 HTTP 地址、字段名、时间格式改成你那个面板的。模板里假设的面板长这样（你的面板不是这个形状也没关系，函数里面怎么写都行，只要进出按注释里的形状来）：

- 登录 `POST /api/auth/login {email, password}` → `{ok: true, token: "..."}`
- 列表 `GET /api/mail?box=inbox&limit=30&offset=0`
- 全文 `GET /api/mail/<id>`
- 标已读 `POST /api/mail/<id>/read`
- 删除 `DELETE /api/mail/<id>`
- 发信 `POST /api/mail/send {from, to: [], subject, text}`
- 附件 `GET /api/mail/attachment/<id>`

## 2. 在注册表里加一行

打开 `manage/adapters.php`，在 `$MC_API_ADAPTERS` 里加一行：

```php
'mybox' => [
    'label' => 'MyBox',                              // 厂商栏和邮箱管理表里显示的名字
    'file' => 'mybox.php',                           // 第 1 步那个文件
    'panel_label' => 'MyBox 面板地址',               // 添加页蓝框里“面板地址”那行的标题
    'panel_placeholder' => 'https://你的 MyBox 面板地址',
    'about' => 'MyBox 面板没有 IMAP / SMTP，邮件存在它自己的数据库里；这里走 MyBox 的 HTTP API 收发，不用填下面的 IMAP / SMTP 服务器。',
    'note' => '注意：MyBox 没有已删除，删信就是彻底删除，删了找不回来。',  // 没有就写 ''
    'delete_ok' => '已彻底删除。',                   // 删信成功后页面显示的话
    'trash_note' => 'MyBox 没有已删除：删了就是彻底删除，找不回来。',       // 没有已删除才写，有就写 ''
    'no_folder_note' => 'MyBox 只有收件箱和已发送，没有这个文件夹。',        // 文件夹不全才写，全有就写 ''
],
```

`note` / `trash_note` / `no_folder_note` 这三项是页面上的人话提示，照着你那个面板的真实情况写，别抄别人的（比如你的面板有垃圾箱，`trash_note` 就写 `''`）。

## 3. 传上服务器，测试连接

- **Serv00 / VPS**：把 `manage/mybox.php` 和改过的 `manage/adapters.php` 传到网站根目录（和 `index.php` 放一起），不用重启。
- **GitHub + Cloudflare Containers**：新适配器文件也要加进 `Dockerfile` 的 `COPY` 清单（和 `adapters.php` 放一行），不然容器里没有这个文件，`git push` 后自动重新部署。

然后打开添加邮箱，厂商下拉里就出现你这个 kind 了，点“测试连接”验证。测试通过再保存，收件箱、读信、发信、删信、附件各点一遍。

## 适配器函数签名表（必须按这个写）

`$panel` 是面板地址，`$token` 是登录令牌（每次现拿，不存数据库），`$account_id` 是“地址在登录账号下的数字 id”（Cloud Mail 这类才有；没有这个概念就不用写 `_account_id_for`，分发函数会传 `null`，函数里忽略就行）。

| 函数 | 作用 | 返回 |
| --- | --- | --- |
| `<kind>_token_for($panel, $login, $cred, $mb_id = ''): string` | 登录拿令牌，拿不到返回 `''` | 令牌字符串 |
| `<kind>_account_id_for($panel, $token, $address): array`（可选） | 地址换数字 id | `[id, '']`，拿不到返回 `[0, '人话原因']` |
| `<kind>_test($panel, $login, $cred, $address): array` | 添加页“测试连接” | `[true/false, '人话结果']` |
| `<kind>_folder_map(): array` | 管理中心文件夹名 → 面板里的值 | 比如 `['inbox' => 'in', 'sent' => 'out']`，没有的文件夹别写 |
| `<kind>_fetch_list($panel, $token, $account_id, $address, $folder, $page, $per = 30): array` | 取一页列表 | 成功 `['rows' => [...], 'total' => int]`，失败 `['error' => '人话']` |
| `<kind>_fetch_message($panel, $token, $account_id, $folder, $uid): array` | 取一封全文 | 成功 `['from','from_name','to','subject','date','text','html','attachments']`，失败 `['error' => '人话']` |
| `<kind>_mark_read($panel, $token, $account_id, array $ids): bool` | 标已读（尽力而为，失败不报错） | `true` / `false` |
| `<kind>_delete($panel, $token, $account_id, array $ids): array` | 删信 | `[true/false, '人话原因']` |
| `<kind>_send($panel, $token, $account_id, $from, array $to, $subject, $text): array` | 发信（纯文本；抄送调用方已经并进 `$to` 了） | `[true/false, '人话原因']` |
| `<kind>_download($panel, $token, $account_id, array $att): array` | 下一个附件（`$att` 是取全文时 `attachments` 里的那一项） | 成功 `['ctype' => ..., 'body' => ...]`，失败 `['error' => '人话']` |

列表行和全文的字段名必须和表里写的一模一样，不然管理中心认不出来：

- 列表行：`uid` / `seen`（是否已读）/ `date`（`'Y-m-d H:i'` 上海时间，或带时区的标准日期串）/ `subject` / `from_name` / `from_addr` / `to` / `snippet` / `size`
- 全文附件每项：`id` / `filename` / `ctype` / `size`（Cloud Mail 这类还要带 `key`，下载时用它）

注意：

- 所有函数失败都返回 `['error' => '人话原因']`（列表 / 全文 / 附件）或者 `[false, '人话原因']`（测试 / 删除 / 发信），**不要直接 `die`，不要抛异常**。
- 令牌不要写文件、不要存数据库，每次现拿；想缓存也行，但别超过令牌自己的有效期。
- 面板地址没填对时，最底层 HTTP 调用要返回 `['error' => '面板地址没填对。']`，别让它去连一个空地址。
- 时间：面板给的是时间戳（秒 / 毫秒）或 ISO 字符串都行，转成上海时间再返回；模板里的 `mybox_date_string` 照着改。
- 分页：面板是 `limit` / `offset` 就照模板写；是游标（比如 Cloud Mail 的 `emailId`）就照 `cloudmail.php` 的 `cloudmail_fetch_list` 写，第 1 页从头取、第 2 页起用上一页最后一封当游标。

## 已有的两个适配器（照着抄）

- `manage/henna.php` — Henna（`POST /api/auth/login` 拿 JWT，`Authorization: Bearer`；登录失败时凭据本身当 API Key 再试一次；没有已删除）。
- `manage/cloudmail.php` — Cloud Mail（`POST /api/login` 拿 token，`Authorization` 直接放 token、不带 Bearer；先调 `GET /api/account/list` 把地址换成数字 `accountId`；只有收件箱和已发送；读信没有单封接口，用 `full=1` 的列表加游标取）。

## 旧记录怎么办

v4.30 之前加的 Henna / Cloud Mail 邮箱不用重新加：记录里原来存的 `henna_panel` / `henna_login`（或 `cloudmail_panel` / `cloudmail_login`）还在，新代码先读 `panel_url` / `panel_login`，没有就回落去读旧字段。改一次登录方式后，记录就按新字段存了。
