# Mail 管理中心 — 版本记录

## v4.30（2026-11-09）— 域名邮箱可扩展：通用适配器注册表，别人能自己加新的域名邮箱

- 改了 4 个文件 + 新文件 2 个：`index.php`（3084 行 → 2840 行）、`henna.php`、`cloudmail.php`、`adapters.php`（新）、`adapter-template.php`（新，模板，不用传上服务器）；`imap.php` / `oauth.php` / `ms_oauth.php` 没动，不用传。CF Containers 部署：`Dockerfile` 的 COPY 清单加了 `adapters.php`（不加全站 500）。
- **加一种新的域名邮箱不用改主程序了**：以前 Henna、Cloud Mail 是在 `index.php` 里一处一处写死的分支（添加表单、测试连接、列表、读信、发信、删信、附件、TG 跳过……约 25 处），现在全走 `manage/adapters.php` 里的注册表 `$MC_API_ADAPTERS` + 分发函数（`mc_api_test` / `mc_api_fetch_list` / `mc_api_fetch_message` / `mc_api_send` / `mc_api_delete` / `mc_api_download`……）。想加一种新的域名邮箱：复制 `manage/adapter-template.php` 改成 `manage/<kind>.php`，按注释把 HTTP 调用接上，再在注册表里加一行（label、面板地址文案、删信提示），厂商下拉、添加表单、测试、收发删全都有了。完整步骤和函数签名表见根目录 `ADAPTERS.md`。
- **Henna / Cloud Mail 的函数签名统一了**：`_fetch_list`、`_fetch_message`、`_mark_read`、`_delete`、`_send`、`_download` 现在都按 `ADAPTERS.md` 的表来（多了 `$account_id` 参数，Henna 没有这个概念就忽略；`_fetch_list` 多了 `$address` 参数，Cloud Mail 用 `accountId`、忽略它）。两个适配器本身的行为没变：登录、文件夹、发信、删信逻辑一个字没动。
- **添加表单改成按注册表循环生成**：厂商下拉里的 Henna / Cloud Mail 两项和两个蓝框（面板地址、登录账号、登录密码）现在都是从注册表循环画出来的，新 kind 自动出现；三个输入框的名字统一叫 `panel_url` / `panel_login` / `panel_password`，切厂商时藏起来的蓝框输入框会 `disabled`（不提交，不会串到别的 kind 去）；登录账号还是默认跟邮箱地址走，手动改过就不再自动跟。记录改存 `panel_url` / `panel_login`，旧字段 `henna_panel` / `henna_login`（或 `cloudmail_panel` / `cloudmail_login`）也留一份，方便回滚。
- **旧记录不用重新加**：v4.30 之前加的 Henna / Cloud Mail 邮箱照常用，新代码先读 `panel_url` / `panel_login`，没有就回落去读旧字段；改一次登录方式后就按新字段存了。
- **两个小变化**：① Henna 的文件夹映射本来就不含已删除，v4.30 起单邮箱列表里不再显示“已删除”按钮（以前点了也是空的，还会弹一句“没有已删除”的提示）；② 删信确认文案现在按注册表拼，Henna 还是“确定删除这封邮件吗？Henna 没有已删除：删了就是彻底删除，找不回来。”，Cloud Mail 还是“……Cloud Mail 没有已删除，删了就找不回来。”，意思没变。
- **还没验证**：本地无 PHP、沙箱连不上邮箱服务器，全程没跑过真实登录。先传文件跑 `php -l`，再按顺序验证 Henna 和 Cloud Mail 全链路：①添加页选 Henna / Cloud Mail，点「测试连接」；②保存后打开收件箱和已发送看列表；③点开一封读信、点 ↻ 刷新看未读圆点消不消；④自己给自己发一封试发信；⑤删一封看确认文案和提示对不对；⑥有附件的点附件下载。TG 轮询还是跳过这两类（和 v4.29 一样），Cloud Mail 的 `/email/latest` 还是备着没接。
- **更新命令（改了 4 个文件，先备份正在跑的 v4.29，再下载；`adapters.php` 必须和 `index.php` 一起传，缺了全站 500，`php -l` 查不出来）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.30 && cp henna.php ~/mc-backup/henna.php.before-v4.30 && cp cloudmail.php ~/mc-backup/cloudmail.php.before-v4.30
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o henna.php "<新 henna.php 直链>"
  curl -L -o cloudmail.php "<新 cloudmail.php 直链>"
  curl -L -o adapters.php "<新 adapters.php 直链>"
  php -l index.php && php -l henna.php && php -l cloudmail.php && php -l adapters.php
  ```
- **回滚命令（回到 v4.29）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.30 index.php && cp ~/mc-backup/henna.php.before-v4.30 henna.php && cp ~/mc-backup/cloudmail.php.before-v4.30 cloudmail.php && rm -f adapters.php
  ```
  （回滚后旧记录照常用：v4.29 的代码读的就是旧字段。`adapter-template.php` 不用传上服务器，也不用删。）


## v4.29（2026-11-09）— TG 直连 Bot API + 消息推送卡片按图重做

- 只改 index.php（3083 行），cloudmail.php / imap.php / henna.php / oauth.php / ms_oauth.php 没动，不用传。CF Containers 部署不用另外改，Dockerfile 拷的就是这 6 个文件，下次 push 自动带上。
- **TG 通知不用中转也能推**：设置页 → 消息推送，填 chat_id + Bot Token 就直连 `api.telegram.org` 发通知；两个都没填就继续走原来的中转 Worker。测试通知和真通知走同一条路（`tg_send_msg`），点测试收到就是通了。chat_id 和 Token 都加密存在本站（和微软 Secret 一个做法）。
- **消息推送卡片按截图重做**：标题改成“消息推送”，副标题“全局默认通道，用户的分发规则优先于此”；Telegram 机器人一行，右边是绿色开关；下面两个输入框并排，左边 Bot Token、右边 chat_id；Token 已保存时显示 `****` + 后 4 位（如 `****yGxl`），要换就粘贴完整的新 Token；手机宽度下两个框上下排。
- **通知里的链接不再写死**：看全文链接和定时任务地址都从当前访问的域名取（`mc_base_url()`），部署到 CF / 新域名不用改代码。
- **怎么拿 chat_id 和 Token**：TG 里找 @BotFather，/newbot 建机器人复制 Token；找 @userinfobot 发任意消息，它回你的数字 ID 就是 chat_id；先给你的机器人发一条消息（点 Start），不然它发不出去。直连失败时页面会报 Telegram 的原话（比如 Token 不对、找不到聊天、机器人被拉黑）。
- **注意**：直连要服务器能连上 `api.telegram.org`，Serv00 在波兰一般没问题，点“发一条测试通知”验证；如果报连不上，就继续用中转 Worker。
- **更新命令（只改了一个文件，先备份正在跑的 v4.28.2 的 index.php，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.29
  curl -L -o index.php "https://muse.ai/files/1270901622783127/1984597922882691/oxhg8pdjn5e21c5jypi40q3u/index.php"
  php -l index.php
  ```
- **回滚命令（回到 v4.28.2）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.29 index.php
  ```

## v4.28.2（2026-11-08）— 点分组名只展开不筛选 + 分组左对齐 + 分组管理对齐

- 只改 index.php（3016 行），cloudmail.php / imap.php 没动，不用传。
- 点分组名不再只看该分组：左栏「我的邮箱」里，分组名从链接改成普通标签，点一下就是展开 / 收起这个分组下面的邮箱列表，其他分组都还在、不隐藏；以前的“只看‘DNSHE’”标题和底部的“← 看全部分组”一起去掉，邮箱链接和 ↻ 刷新链接也不再带 mbgroup 参数。展开状态还是记在浏览器里（mc_gopen），刷新后还是上次的样子；按住左键拖动分组排序不变。邮箱管理页（mailboxes）自己的分组筛选没动，那是管邮箱的表格筛选，不是左栏。
- 图 2 左对齐：分组行原来是 space-between，图标贴左、标签被顶到中间、▾ 贴右，看着像居中；改成 flex-start + 间距 6px，图标和标签都贴左，▾ 用 margin-left:auto 顶到最右。
- 图 3 分组管理对齐：每行的分组名一列固定 180px（超长截断、鼠标悬停看全名），后面的“改成”、输入框（130px）、按钮位置上下对齐，不再被长分组名顶歪。
- **更新命令（只改了一个文件，先备份正在跑的 v4.28.1 的 index.php，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.28.2
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（回到 v4.28.1）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.28.2 index.php
  ```

## v4.28.1（2026-11-08）— 文件夹按钮等宽 + 缓存文案简化

- 只改 index.php（3017 行），cloudmail.php / imap.php 没动，不用传。aa 部署 v4.28 后报：cfmail 邮箱的收发都正常，但绿色的“收件箱”按钮背景框看着比旁边宽、字体像不居中。
- 根因（浏览器实测线上页面量的数字）：三列等宽网格本身没坏——可点的按钮（写信、收件箱、已发送）都是约 100px，字体实测正好居中（收件箱白字中心 441.5px = 按钮中心 441.5px）。宽出来的 35px 是对比出来的：Cloud Mail 只有收件箱和已发送，垃圾箱/草稿箱/已删除是灰色不可点的，旧代码把它们包在一层 `<span class="folders">` 里，这层 span 自己是 flex 容器，里面的灰按钮只按内容宽渲染（约 65px），左对齐、列尾空出 35px；绿框 100px 对灰框 65px，看着就像绿框突然加宽、字也不居中。拿 QQ 邮箱对照过：六个全是链接时六个都是 100px，现象消失。
- 修法：灰色按钮去掉外面那层 span，直接就是网格里的一项，和可点的按钮一样撑满整列、文字居中。六个按钮现在都是约 100px 等宽。
- 缓存文案：`列表缓存于 21:12（0 分钟前）` 改成 `缓存于 21:12`。
- **更新命令（只改了一个文件，先备份正在跑的 v4.28 的 index.php，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.28.1
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（回到 v4.28）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.28.1 index.php
  ```

## v4.28（2026-11-08）— Cloud Mail（cfmail.151819.xyz）接入：新适配器 cloudmail.php + index.php 接入

- 新文件 cloudmail.php（351 行）+ index.php（3017 行），imap.php / henna.php 没动，不用传。Cloud Mail 和 Henna 同套路（没有 IMAP/SMTP、单独写 HTTP 适配器、一条记录管一个地址），但接口全是另一套，Henna 的代码一个字都复用不上。
- 适配器接口（对着 maillab/cloud-mail main d115f4c 源码写的）：登录 `POST /api/login {email,password}` 拿 token，`Authorization` 直接放 token、不带 Bearer，信封 `{code,data,message}`；登录身份是面板用户账号，登录后调 `GET /api/account/list` 把地址换成数字 accountId，后面列表/读信/发信/删除全带它；列表 `GET /email/list?accountId=&type=0收件/1已发&size≤50&emailId游标&timeSort=0&full=`，游标翻页（第 1 页 emailId=0，第 2 页起用上一页最后一封的 id）；读信没有单封接口，用 `full=1` 的列表加游标 `emailId=uid+1、size=1` 取；标已读 `PUT /email/read {emailIds:[id]}`；删除 `DELETE /email/delete?emailIds=` 是软删；发信 `POST /email/send {accountId,receiveEmail:[],subject,text,content}`；附件 `GET /email/attList` + R2 `/api/oss/{key}` 下载；`GET /email/latest` 已备好给以后 TG 轮询用，这版还没接。
- index.php 接入点（照着 Henna 的分支一处一处加的）：顶部 require cloudmail.php；厂商栏加「Cloud Mail（域名邮箱）」+ 蓝框（面板地址默认 https://cfmail.151819.xyz、登录账号、登录密码，账号自动跟邮箱地址走）；添加/改登录方式走 cloudmail_test（登录 + 核对地址在登录账号名下）；邮箱管理表加 Cloud Mail 标签、登录方式、面板地址；列表（单个 + 全部收件箱）、读信、回复/转发预填、发信、删除、附件下载全走适配器；文件夹只有收件箱和已发送，草稿/垃圾箱/已删除的按钮显示灰色点不开；删除确认文案改成“没有已删除，删了就找不回来”。
- TG 新邮件轮询这版**暂不推** Cloud Mail 和 Henna：tg_check_all 里先跳过这两类（不记失败、不当成连不上），Cloud Mail 的 /email/latest 已备好，下一版再接进轮询。
- **还没验证**：本地无 PHP、沙箱连不上邮箱服务器，全程没跑过真实登录。先传两个文件跑 php -l，再按顺序验证：①添加页选 Cloud Mail，填 cfmail@151819.xyz（或 cfmail01@ / cfmail02@）+ 面板登录账号密码，点「测试连接」；②测试通过再保存，打开收件箱和已发送看列表；③点开一封读信、点 ↻ 刷新看未读圆点消不消；④自己给自己发一封试发信。发信若报错，大概率是面板没配 CF Email（要 Workers Paid）或 Resend，报错原话会直接显示。
- **更新命令（改了两个文件，先备份正在跑的版本，再下载；index.php 头部 require cloudmail.php，两个必须一起传，缺一个全站 500，php -l 查不出来）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.28 && cp cloudmail.php ~/mc-backup/cloudmail.php.before-v4.28 2>/dev/null || true
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o cloudmail.php "<新 cloudmail.php 直链>"
  php -l index.php && php -l cloudmail.php
  ```
- **回滚命令（回到 v4.27.20）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.28 index.php && rm -f cloudmail.php
  ```

## v4.27.20（2026-11-08）— 左栏宽度跟打开的分组走：打开才撑宽，关掉就回默认 200px

- 只改 index.php（2769 行），imap.php 没动，不用传。v4.27.19 是“栏宽由最长的名字撑开”，不管分组开没开都按最长的算，栏就一直宽着；这版改成按打开的分组算。
- 做法：加了一段 JS，点开/关掉分组、开关“我的邮箱”、收起/展开侧栏、页面加载、字体加载完都会重算一次——默认 200px；打开哪个分组，就量那个分组里看得见的邮箱行（scrollWidth，被截掉的部分也算），撑宽到能显示全那个分组最长的邮箱名；关掉就缩回默认宽，别的分组还开着就按还开着的最长的算；分组名本身一直看得见，也算在内；上限还是 520px。收起的分组里邮箱是不渲染的，本来也量不到，正好符合“没打开就不算”。
- 宽度变化带 0.15 秒过渡，不会一下跳；收起侧栏时清掉内联宽度，仍是 56px，不受新逻辑影响。
- **更新命令（只改了一个文件，先备份正在跑的 v4.27.19 的 index.php，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.20
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（回到 v4.27.19）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.20 index.php
  ```

## v4.27.19（2026-11-08）— 左栏不再固定 200px，宽度随邮箱名/分组名加宽，名称显示全

- 只改 index.php（2731 行），imap.php 没动，不用传。原来 `.side{width:200px}`，邮箱地址和分组名一长就被 `...` 截掉（截图里“henna域名邮…”就是这么来的）。
- 改成 `.side{width:max-content;min-width:200px;max-width:520px}`：左栏宽度由最长的那个邮箱名/分组名撑开，名字短就还是 200px 起步，名字长就跟着加宽；分组标签加了 `flex-shrink:0`，在分组行里不再被压扁。超过 520px 的超长名字（约 65 个字符以上）才会在 520px 处截断，这是防布局撑坏的上限，不是日常情况。
- 收起侧栏不受影响：收起时仍是 56px（补了 `min-width:0;max-width:56px`，不然新加的 min-width:200px 会顶住收不回去）。手机窄屏（≤640px）上限改成 82vw，不会把正文顶出去。
- **更新命令（只改了一个文件，先备份正在跑的 v4.27.18 的 index.php，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.19
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（回到 v4.27.18）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.19 index.php
  ```

## v4.27.18（2026-11-08）— 左栏四点：未读紫点 + ⋮ 菜单加写信 + 菜单左缘对齐 ⋮ + 按住左键才可拖

- 只改 index.php（2731 行），imap.php 没动，不用传。
- ①未读紫点：邮箱地址前面加一个紫色圆点（#7c3aed，直径 8px，鼠标放上去显示“有 N 封未读”）。**圆点不是现场登每个邮箱算的**——那样每打开一页都要把几十个邮箱全登一遍，又慢又招风控；它是读本地缓存的收件箱最新 30 封、数里面未读的，当前正在看的邮箱用刚取到的列表再算一次。没点开过的邮箱还没有缓存，就没有圆点，点开一次、取到列表后才有；读完信要点一下 ↻ 刷新，圆点才会消。
- ②⋮ 菜单在「编辑」下面加了「写信」：点一下跳到写信页，发件邮箱已经预选成这个邮箱（?tab=compose&mb=<id>）。
- ③菜单左缘与 ⋮ 对齐：以前是菜单右缘对着 ⋮ 的右缘，现在左缘对着 ⋮ 的左缘；到底部还是自动往上弹，超出右边界时自动往左收。
- ④拖动排序改成按住左键才开：默认光标是箭头、draggable 关着，拖不动；按住左键那一刻才变成抓手（grabbing）、才开拖，松手（行内、行外、拖完都算）就回到箭头、关掉拖动。分组和组内邮箱都是一套做法，⋮ 上按住不算（它本来就拦掉了，不会把整行拖走）。点一下还是正常打开邮箱，拖动逻辑没动，松手自动保存排序。
- **更新命令（只改了一个文件，先备份正在跑的 v4.27.17 的 index.php，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.18
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（回到 v4.27.17）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.18 index.php
  ```

## v4.27.17（2026-11-08）— 163 根因找到：登录后补发 IMAP ID 自报身份，否则 SELECT 拒 “Unsafe Login”

- 浏览器实测拿到服务器原话：`NO SELECT Unsafe Login. Please contact kefu@188.com for help`。不是文件夹名字、不是授权码、不是 IP 的问题。查证确认：网易 163/126/yeah/188（Coremail）要求第三方客户端登录后用 IMAP ID 命令（RFC 2971）自报身份（name/version/vendor/support-url），不发就拒 SELECT、报 Unsafe Login；现象正好对上——不发 ID 时 LIST 能通、连接测试显示成功，但每次 SELECT 都失败。Outlook、Foxmail、网易邮箱大师都会自动发 ID，手写代码不发就中招。这版只改 imap.php（1442 行）：mail_imap_connect 里 LOGIN 成功后立即发 `ID ("name" "MangguoMail" "version" "4.27.17" "vendor" "Mangguo" "support-url" "https://mangguo.lele.pp.ua/")`，回 OK 或 BAD 都忽略、不影响登录；其他厂商不支持 ID 也无妨。index.php 没动，不用传。
- **更新命令（只改了一个文件，先备份正在跑的 v4.27.16 的 imap.php，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp imap.php ~/mc-backup/imap.php.before-v4.27.17
  curl -L -o imap.php "<新 imap.php 直链>"
  php -l imap.php
  ```
- **回滚命令（回到 v4.27.16）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/imap.php.before-v4.27.17 imap.php
  ```
- 待验证：传上去后点 163 的收件箱/已发送，看能不能正常打开。另：点分组“名称”跳分组筛选却显示 QQ 收件箱的小问题还没修，下版再说。

## v4.27.16（2026-11-08）— 163 还是打不开：把服务器拒绝的原话带回来 + 不带引号的 SELECT 兜底

- aa 说 163 的收件箱和已发送还是打不开，报错已经列出试过的名字：收件箱只试了 INBOX 就失败，已发送试了 10 个名字全失败。INBOX 是标准收件箱、不可能不存在，所以问题不在文件夹名字，很可能是 163 的服务器拒绝 SELECT 的方式不一样，或者连接本身有问题——但旧报错只说“打不开”，看不出服务器到底回了什么，没法定位。这版（只改 index.php 2686 行 + imap.php 1437 行）改了两处：①SELECT 失败时把服务器回的原话带回来，报错会写成“……服务器说：NO ……”，下次再打不开，截图里就有服务器拒绝的真正原因；②SELECT 再加一重兜底：纯英文数字的名字（INBOX、Sent 这类）如果带引号打不开，再试一次不带引号的 `SELECT INBOX`，有的服务器只认不带引号的写法。发信、已发送、分组收起这些 v4.27.15 的内容都没动。
- **更新命令（改了两个文件，先备份正在跑的 v4.27.15，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.16 && cp imap.php ~/mc-backup/imap.php.before-v4.27.16
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o imap.php "<新 imap.php 直链>"
  php -l index.php && php -l imap.php
  ```
- **回滚命令（回到 v4.27.15）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.16 index.php && cp ~/mc-backup/imap.php.before-v4.27.16 imap.php
  ```

## v4.27.15（2026-11-08）— 修 163/v.cd 文件夹打不开 + 分组默认收起

- aa 报三处（只改 index.php 2681 行 + imap.php 1431 行）：①v.cd 发信正常但已发送不显示；②163 发信正常但收件箱、已发送不显示；③分组不要自动打开，只能手动开关。
- 文件夹打不开的根因：LIST 解析只认“最后一个带引号的串”当文件夹名，有的服务器把 INBOX 这类名字不带引号发过来，解析就错认成分隔符 `/`，映射丢了；已发送这类中文名，映射到的名字也可能和服务器实际名字对不上。修了三处：①imap.php 的 LIST 解析改成按 `* LIST (属性) 分隔符 文件夹名` 一段一段取，带引号和不带引号的名字都认，`{N}` 字面量形式的名字也认；②新增 mail_imap_open_folder：按标签打开文件夹，先试映射到的名字，再试常用名（已发送：Sent、已发送、INBOX.Sent、INBOX/已发送、发件箱、寄件备存、Sent Items……），一个一个 SELECT 直到成功，打开成功的名字写回映射；③发信存已发送副本（APPEND）、读信、回复引用、删信移文件夹、下载附件、TG 新邮件轮询，全部改走这个多候选打开。打开失败的报错会列出试过的名字（比如“试过：Sent、已发送、INBOX.Sent……，服务器上都没找到”），方便定位。
- 分组折叠：左栏各分组默认都收起，不再自动展开；点分组名手动打开/关闭，手动打开过的记在浏览器里，刷新后还是上次的样子（和“我的邮箱”展开状态一个做法）。
- 注意：发信之后，已发送里能看到的前提是发信时副本存进去了。以前因为已发送文件夹解析不到，副本根本没存上，所以旧信不会凭空出现——这版传上去之后新发的信才会进已发送；163 的收件箱/已发送、v.cd 的已发送，传上去点刷新就能看。如果还打不开，报错里会写试过哪些名字，把那行字发我，我再对。
- **更新命令（改了两个文件，先备份正在跑的 v4.27.14，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.15 && cp imap.php ~/mc-backup/imap.php.before-v4.27.15
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o imap.php "<新 imap.php 直链>"
  php -l index.php && php -l imap.php
  ```
- **回滚命令（回到 v4.27.14）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.15 index.php && cp ~/mc-backup/imap.php.before-v4.27.15 imap.php
  ```

## v4.27.14（2026-11-08）— ⋮ 菜单里的「复制邮箱地址」改成只显示「复制」

- 只改了菜单按钮上的两个字（只改 index.php）：「复制邮箱地址」→「复制」。点的还是复制邮箱地址到剪贴板，功能没变。
- **更新命令（只改了一个文件，先备份正在跑的 v4.27.13，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.14
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（一行，回到 v4.27.13）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.14 index.php
  ```

## v4.27.13（2026-11-08）— 左栏每个邮箱后面加 ⋮ 菜单：编辑 / 复制 / 删除

- aa 要左栏「我的邮箱」里每个邮箱后面有个 ⋮，点开弹出三个操作（只改 index.php，2671 行）：①编辑——跳到这个邮箱的添加邮箱界面（?tab=add&edit=<id>），原来的信息都填好了，直接改；②复制——把这个邮箱地址复制到剪贴板，底部弹一下「已复制 xxx」；③删除——先弹确认（只删管理中心里的记录，不删邮箱本身），确认后才删。点空白处、按 Esc、或者再点一次 ⋮，菜单就收起来；菜单贴着 ⋮ 弹出来，到底部了会自动往上弹。⋮ 是灰色小点，平时就看得见，鼠标放上去会变深；从 ⋮ 上拖不动整行（拖动排序还是从邮箱地址上拖）。
- **更新命令（只改了一个文件，先备份正在跑的 v4.27.12，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.13
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（一行，回到 v4.27.12）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.13 index.php
  ```

## v4.27.12（2026-11-08）— 记住时长三档可选：3 个月 / 6 个月 / 1 年

- 记住我原来固定 30 天。改成三档可选（只改 index.php，2581 行）：登录页「记住我」后面多了个下拉框，3 个月、6 个月、1 年，默认 3 个月；登录时选哪个，这次就按哪个时长记住，并记成默认，下次登录默认就是上次选的。设置里也多了「记住我默认时长」，不用登录也能改默认。恢复登录时按这条令牌自己的时长顺延（老版本 30 天的令牌没有时长字段，按 90 天顺延）。不是三档里的数一律按 3 个月算。
- **更新命令（只改了一个文件，先备份正在跑的 v4.27.11，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.12
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（一行，回到 v4.27.11）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.12 index.php
  ```

## v4.27.11（2026-11-08）— 登录改成账号 + 密码，勾上记住我 30 天免登录

- aa 说每次打开都要输密码。改了两处（只改 index.php，2545 行）：①登录改成账号 + 站点密码（账号默认 admin，登录页账号栏已填好，只输密码就行；账号不区分大小写；老版本没存过账号的默认就是 admin；设置里可以改账号，改账号要当前密码确认，密码和邮箱凭据都不动）。②登录页多了「记住我」勾选框（默认勾上）：勾上以后 30 天内不用再登录，每次打开顺延 30 天，只在这台设备 / 浏览器上记住。记住用令牌实现：令牌原文只放浏览器 Cookie（HttpOnly），服务器 data/remember.php 里只存令牌的 SHA-256 + 用令牌加密后的派生密钥 + 过期时间，丢了数据文件也拿不到密钥；改站点密码后所有令牌作废，要重新登录；设置里有「退出所有记住的设备」，一键吊销全部令牌。点「退出」也会把这台设备的记住清掉。
- 注意：站点密码本身没变，已存的邮箱凭据不用重加密，升级后直接用原来的密码登录就行（账号填 admin）。第一次打开还是只输密码的旧版页面？那是浏览器缓存，硬刷新（Ctrl+F5）一下。
- **更新命令（只改了一个文件，先备份正在跑的 v4.27.10，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.11
  curl -L -o index.php "<新 index.php 直链>"
  php -l index.php
  ```
- **回滚命令（一行，回到 v4.27.10）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.11 index.php
  ```

## v4.27.10（2026-11-08）— 中文文件夹名改走 modified UTF-7，已发送打不开了

- aa88@v.cd 发信成功（“已发送。”），但点「已发送」报「打不开"已发送"文件夹。」——发出去的信也看不到。原因：DNSHE 这类中文邮箱的文件夹叫「已发送」「草稿箱」这种中文名，IMAP 传文件夹名必须用 modified UTF-7 编码；旧版直接把 LIST 回来的 UTF-8 中文名原样发过去，服务器不认，SELECT 和 APPEND 都失败。所以之前那封测试信的副本也没存进已发送。
- 改法（imap.php 1224→1339 行，index.php 2348 行只改了一行报错）：①新增 `mail_imap_utf7_encode` / `mail_imap_utf7_decode`（已用模拟验过往返：已发送 ↔ `&XfJT0ZAB-`、收件箱、INBOX.已发送、A&B 都对，英文名原样不动）；②`mail_folder_map` 收 LIST 名字时先解成 UTF-8 再认名字，\Noselect 的文件夹不参与映射，已发送的候选名加了「发件箱」「寄件备存」「sent mail」，草稿箱/已删除也补了几个；③`mail_imap_select`、`mail_imap_append`、`mail_imap_move` 发文件夹名时先编成 UTF-7，服务器不认再用原名重试一次；④打不开的报错现在带上服务器上的实际文件夹名，方便核对。
- 注意：之前那封测试信的副本没存上，已发送现在还是空的——更新后重新发一封，副本就能存进去、列表里也看得到。还有那封测试信是发到 `mail02@070605.xyz` 的（少了个 e），要重发记得写 `email02@070605.xyz`。
- **更新命令（先备份正在跑的 v4.27.9，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.10 && cp imap.php ~/mc-backup/imap.php.before-v4.27.10
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o imap.php "<新 imap.php 直链>"
  php -l index.php && php -l imap.php
  ```
- **回滚命令（一行，回到 v4.27.9）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.10 index.php && cp ~/mc-backup/imap.php.before-v4.27.10 imap.php
  ```

## v4.27.9（2026-11-08）— 发信认证加 AUTH PLAIN 兜底；v.cd 补进前端自动识别

- aa88@v.cd 发信又报新错：「服务器不支持 AUTH LOGIN，或拒绝认证。」——这次不是端口问题：发信已经连上服务器、过了问候，卡在认证这一步。DNSHE 的 SMTP 不认 AUTH LOGIN，只认 AUTH PLAIN。代码改了（imap.php 1224 行）：发信认证先试 AUTH LOGIN，不行自动换 AUTH PLAIN 再试；两个都不行才报错。
- 另外两个容易踩的坑：①「测试连接」只测收信（IMAP 登录），不测发信（SMTP），所以测试成功不代表发信能通——发信必须真发一封才知道；②只点「测试连接」不会保存，改完 SMTP 端口/加密要再点「保存邮箱」——aa 这次截图里 SMTP 还是 587 STARTTLS，之前改的 465 SSL 没存上。正确顺序：SMTP 改成 smtp.mail.v.cd:465 SSL → 点「保存邮箱」→ 再发测试信。
- 前端自动识别也补上了：v4.27.8 只加了 PHP 的 provider_for，JS 里那份厂商预设表（`var P`）漏了 v.cd，输 v.cd 邮箱地址不会自动填服务器。这版补上了（index.php 2348 行），以后输 v.cd 地址就自动填 smtp.mail.v.cd:993/465。
- **更新命令（先备份正在跑的 v4.27.8，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.9 && cp imap.php ~/mc-backup/imap.php.before-v4.27.9
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o imap.php "<新 imap.php 直链>"
  php -l index.php && php -l imap.php
  ```
- **回滚命令（一行，回到 v4.27.8）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.9 index.php && cp ~/mc-backup/imap.php.before-v4.27.9 imap.php
  ```

## v4.27.8（2026-11-08）— 正文必填撤掉；DNSHE 发信端口/加密错配修好

- 正文必填撤掉：v4.27.7 把“正文不填不能发”加进去了，结果 aa 做站内测试（只填主题）被拦住。aa 之前那句“不填正文也能发”不是投诉、是说这样就行——是我理解反了。这版把那条校验删了，只填主题也能发。
- aa88@v.cd 发信报「SMTP 服务器没有回应」：这个错是“连上了、但服务器没回 220 问候”，十有八九是端口和加密方式没配对（465 要配 SSL、587 要配 STARTTLS），或者 SMTP 栏误填了 IMAP 的 993。DNSHE 正确的发信配置是 **SMTP smtp.mail.v.cd、端口 465、加密 SSL**（收信 IMAP 也是 smtp.mail.v.cd、993、SSL）。aa88 这条记录存的 SMTP 配置不对，代码改不了已存的配置，**要 aa 手动改一次**：邮箱管理 → aa88@v.cd → 改登录方式/编辑 → 把 SMTP 服务器、端口、加密改成上面这三个值，密码不动（收信正常，密码是对的），保存后再发。
- 代码改了两处（index.php 2347 行，imap.php 1219 行）：①自动识别里加了 `v.cd` → DNSHE（smtp.mail.v.cd:993 SSL / smtp.mail.v.cd:465 SSL），以后新加 v.cd 邮箱自动填对，不用再手动改；②SMTP 没回 220 的报错现在带上实际用的配置（比如 `SMTP 服务器没有回应（smtp.mail.v.cd:465，STARTTLS）……`），一眼就能看出端口和加密配没配对。
- **更新命令（先备份正在跑的 v4.27.7，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.8 && cp imap.php ~/mc-backup/imap.php.before-v4.27.8
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o imap.php "<新 imap.php 直链>"
  php -l index.php && php -l imap.php
  ```
- **回滚命令（一行，回到 v4.27.7）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.8 index.php && cp ~/mc-backup/imap.php.before-v4.27.8 imap.php
  ```

## v4.27.7（2026-11-08）— 收件箱中文主题不再显示成 {69}，发件人单个字母改显示地址

- 原因：aa 用域名邮箱（email02@070605.xyz）给 aa88@v.cd 发站内测试信，收件箱里标题显示成 `{69}`、发件人只剩一个 `e`、正文摘要也不显示。查下来是三处：①中文主题在 IMAP 里是按 `{字节数}` 字面量传的，旧版 ENVELOPE 解析器（mail_env_parse_value）不认字面量，把 `{69}` 当成主题、后面的解析还全错位；②发件人名 `e` 是 Henna 发信时写进 From 头里的，改不了它，但收件箱没必要只显示一个字母；③有的服务器把纯 ASCII 正文（base64 / quoted-printable）放在引号里返回，摘要只认字面量就漏了。
- 改法（imap.php 1164→1217 行，index.php 2346→2349 行）：①解析器认 `{N}` / `{N+}` 字面量，跳过换行、按字节数取原文（已用模拟的 ENVELOPE 回应验过：`{31}`、`{69}`、`{31+}` 和纯 ASCII 主题都解析对）；②发件人名字是单个英文字母时，列表、读信页、TG 通知都直接显示邮箱地址（中文单字名不受影响）；③摘要同时认 `BODY[1] "..."` 引号形式；④写信时正文不填发不出去（原来空正文也能发）。
- 注意：列表有 1 分钟缓存，传上去后要点收件箱里的 ↻ 刷新，才会重新取、看到修好的标题和摘要；旧缓存里那封 `{69}` 不用删，刷新就没了。
- **更新命令（先备份正在跑的版本，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.before-v4.27.7 && cp imap.php ~/mc-backup/imap.php.before-v4.27.7 && cp henna.php ~/mc-backup/henna.php.before-v4.27.7
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o imap.php "<新 imap.php 直链>"
  curl -L -o henna.php "<v4.27.3 henna.php 直链>"
  php -l index.php && php -l imap.php && php -l henna.php
  ```
- **回滚命令（一行，回到更新前正在跑的版本）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.before-v4.27.7 index.php && cp ~/mc-backup/imap.php.before-v4.27.7 imap.php && cp ~/mc-backup/henna.php.before-v4.27.7 henna.php
  ```

## v4.27.6（2026-11-08）— Henna 登录账号栏加回来，自动跟邮箱地址走

- aa 强调登入要地址、账号、密码三项完备：这版把蓝框里的「Henna 登录账号」加回来，蓝框还是三样（面板地址、登录账号、登录密码），同时解决上一版说的重复填——账号栏会自动跟下面「邮箱地址」栏走：填邮箱地址时自动填过去、切到 Henna 时账号栏空着也自动补；手动改过账号栏就不再自动跟（面板账号和邮箱地址不一样时自己改）。后端还是按表单的 henna_login 存，空账号的校验也恢复了。
- 只改 index.php（2339 行）；henna.php 仍是 v4.27.3。更新时两文件一起传。
- **更新命令（先备份正在跑的版本，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.v4.27.5 && cp henna.php ~/mc-backup/henna.php.before-v4.27.6
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o henna.php "<v4.27.3 henna.php 直链>"
  php -l index.php && php -l henna.php
  ```
- **回滚命令（一行，回到更新前正在跑的版本）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.v4.27.5 index.php && cp ~/mc-backup/henna.php.before-v4.27.6 henna.php
  ```

## v4.27.5（2026-11-08）— Henna 蓝框去掉登录账号栏，登录就用邮箱地址

- aa 指出来蓝框里的登录账号和下面的邮箱地址重复填了同一项：这版把蓝框里的「Henna 登录账号」那栏整个去掉，蓝框只剩面板地址和登录密码两样；后端登录账号直接取表单的邮箱地址（$henna_login = $email），存进记录的 henna_login 还是原来的字段，读信/发信/测试连接都不用改。蓝框说明改成“登录账号就是下面填的邮箱地址，这里只填登录密码”。
- 只改 index.php（2323 行）；henna.php 仍是 v4.27.3。更新时两文件一起传。
- **更新命令（先备份正在跑的版本，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.v4.27.4 && cp henna.php ~/mc-backup/henna.php.before-v4.27.5
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o henna.php "<v4.27.3 henna.php 直链>"
  php -l index.php && php -l henna.php
  ```
- **回滚命令（一行，回到更新前正在跑的版本）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.v4.27.4 index.php && cp ~/mc-backup/henna.php.before-v4.27.5 henna.php
  ```

## v4.27.4（2026-11-08）— Henna 蓝框加上“登录账号”，顺序改成地址、账号、密码

- 之前蓝框里「Henna 登录邮箱」容易被当成邮箱地址（占位提示还写着 xxx@070605.xyz），其实现在登 Henna 面板用的账号就是这个邮箱，登录接口只认邮箱 + 密码、没有单独的用户名。这版把它改名叫「Henna 登录账号」，占位提示改成“登录 Henna 面板用的邮箱”，蓝框顺序按地址、账号、密码排：面板地址 → 登录账号 → 登录密码。后端没动（字段名还是 henna_login / henna_password），QQ 这些邮箱的表单也不受影响。
- 只改 index.php（2327 行）；henna.php 仍是 v4.27.3。更新时两文件一起传。
- **更新命令（先备份正在跑的版本，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.v4.27.2 && cp henna.php ~/mc-backup/henna.php.before-v4.27.4
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o henna.php "<v4.27.3 henna.php 直链>"
  php -l index.php && php -l henna.php
  ```
- **回滚命令（一行，回到更新前正在跑的版本）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.v4.27.2 index.php && cp ~/mc-backup/henna.php.before-v4.27.4 henna.php
  ```

## v4.27.3（2026-11-08）— Henna 登录报错不再被 405 盖住

- 原因：v4.27.1 把 /auth/login 和 /login 两条路径的报错都记下来、最后只报最后一个；/login 这条路径在 Henna 面板上根本不存在，静态服务器对 POST 回 405，于是显示出来的永远是看不懂的 405，/auth/login 的真实报错（比如账号不存在、密码错误）被盖住了。已实测：POST /api/auth/login 对不存在的账号返回 {"ok":false,"error":"用户不存在或已停用","code":401}，POST /api/login 返回 405。
- 改法（只改 henna.php，320 行）：henna_login 直接调 henna_http 看原始状态和 JSON——面板明说的 JSON 错误立刻报出来，不再试别的路径；只有 404/405（这条登录路径不存在）才回落到 /login；两条路径都不存在才报没有登录接口。
- 注意：这次修的只是“报错被盖住”，登录本身能不能过还要看填的账号密码对不对。Henna 登录邮箱必须是面板的管理员登录账号（用来登 email.070605.xyz 的那个邮箱），不是邮箱地址 email01@/email02@070605.xyz；如果一直报账号不存在，也可以把面板设置里的 API Key 贴到密码框里直连。
- **更新命令（只换 henna.php 一个文件，先备份正在跑的版本）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  cp henna.php ~/mc-backup/henna.php.v4.27.2
  curl -L -o henna.php "<新 henna.php 直链>"
  php -l henna.php
  ```
- **回滚命令（一行，回到上一版 henna.php）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/henna.php.v4.27.2 henna.php
  ```

## v4.27.2（2026-11-08）— 添加表单改直观：厂商放最上面，Henna 密码进蓝框

- 邮箱厂商下拉挪到添加表单最上面（邮箱地址栏上面），选 Henna 后蓝框直接跟在厂商栏下面，不用往下翻。
- Henna 蓝框里加了「Henna 登录密码」一栏（面板地址下面、登录邮箱上面），密码直接填在蓝框里；同时选 Henna 时藏起「登录方式」两卡和上面共用的「密码 / 授权码」框，必填也跟着换过去（切回别的厂商再恢复）。没填蓝框密码时，后端仍用共用密码框的值顶上（兼容旧版表单）；密码没填的报错对 Henna 改成「Henna 登录密码没填。」。
- 只改 index.php（2327 行）；henna.php 仍是 v4.27.1。更新时两文件一起传（henna.php 还是上一条的 v4.27.1 链接）。
- **更新命令（先备份正在跑的 v4.27，再下载）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.v4.27 && cp henna.php ~/mc-backup/henna.php.v4.27
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o henna.php "<v4.27.1 henna.php 直链>"
  php -l index.php && php -l henna.php
  ```
- **回滚命令（一行，回到 v4.27）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.v4.27 index.php && cp ~/mc-backup/henna.php.v4.27 henna.php
  ```

## v4.27（2026-11-08）— Henna 域名邮箱接入

- **Henna 邮箱能加进来了**：Henna 面板（https://email.070605.xyz/）没有 IMAP / SMTP，邮件存在它自己的数据库里，以前只能填 imap 服务器、加不进来。现在多了一个 Henna 专用接入（新文件 `henna.php`，走 Henna 的 HTTP API），添加邮箱时厂商选「Henna（域名邮箱）」，填面板地址、Henna 登录邮箱、面板登录密码（也可以直接贴面板设置里的 API Key），测试通过就能在本站收信、读信、回复、转发、写信、发信、删信，和 QQ 邮箱用起来一样。
- **文件夹对应**：收件箱 → in、已发送 → out、草稿箱 → draft、垃圾箱 → spam。**Henna 没有已删除**：点「已删除」只会看到一句提示，里面是空的；删信（列表里的 🗑、读信页的「彻底删除」）都是彻底删除，删了找不回来，确认框会写明“彻底删除”。
- **列表缓存和刷新**：和 IMAP 邮箱走同一套缓存（同一缓存文件、同一 1 分钟过期、点 ↻ 刷新立刻现场取、发信删信后自动清缓存）；统一收件箱里 Henna 邮箱也一样参与合并。
- **读信 / 回复 / 附件**：优先纯文本，没有就把网页正文剥成纯文本；回复、转发会带原文引用；附件点文件名经本站代理下载；打开读信时自动标已读。
- **发信**：纯文本，没有富文本、没有附件；Henna 的发信接口没有抄送字段，抄送的人并进收件人一起发；一个收件人走 /send，多个走 /send/bulk。发完不用往已发送追加（Henna 面板里本来就有）。
- **这次没做的**：Henna 列表接口不给总数，这一版每个文件夹只显示最新 30 封、没有下一页；Henna 邮箱暂时没有 TG 新邮件通知（轮询走 IMAP，Henna 只会记一条“连不上”备注，不报错）；登录接口是按面板源码推断的形状（`POST /login` 返回 token），没走真实登录验证——如果登录失败，测试结果会把面板返回的报错原文带出来，凭据本身当 API Key 也会再试一次。
- **只动了这些**：新文件 `henna.php`（292 行）+ `index.php`（只在邮箱 kind 是 Henna 时才走的分支；没有 Henna 邮箱时，原来的 IMAP 行为和 v4.26 一模一样）。`imap.php` / `oauth.php` / `ms_oauth.php` 没动。
- **更新命令（先备份、再下载，缺了 henna.php 会报 500）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html
  mkdir -p ~/mc-backup && cp index.php ~/mc-backup/index.php.v4.26
  curl -L -o index.php "<新 index.php 直链>"
  curl -L -o henna.php "<新 henna.php 直链>"
  php -l index.php && php -l henna.php
  ```
- **回滚命令（一行）**：
  ```
  cd ~/domains/mangguo.lele.pp.ua/public_html && cp ~/mc-backup/index.php.v4.26 index.php && rm -f henna.php
  ```
  拷回 v4.26 的 index.php、删掉 henna.php 就回到上一版；data/ 不用动，邮箱记录都在。

## v4.9（2026-11-07）— 失败原因折叠 + 分组首字母图标 + TG 新邮件通知

- **失败原因默认只显示一行**：邮箱管理表状态栏的失败原因现在默认只显示第一行的前 46 个字，后面跟一个“展开”；点一下整条展开看完整原因，再点收起。原来是全文直接摊在表格里，又长又占地方。
- **分组名前加首字母图标**：每个分组名前面默认加一个蓝底白字的圆角小方块，写分组名的第一个字（英文自动大写），QQ邮箱是 Q、outlook 是 O、DNSHE 是 D、未分组是 未。左栏“我的邮箱”、邮箱管理的分组筛选、分组改名行、表格里的分组下拉菜单都加了；写信页发件邮箱的下拉是系统原生的 optgroup，加不了图标，没动。
- **TG 新邮件通知**：设置页新增「TG 新邮件通知」卡片。开启后，每 5 分钟调一次轮询地址（设置页里会显示带 key 的地址，Serv00 的 Cron 或 cron-job.org 都行），只查收件箱、只查连接正常的邮箱，有新邮件就往 TG 推一条：邮箱、时间（北京时间）、发件人、标题、正文前 120 字，再加一条“点开看全文”的链接，点链接回管理中心读完整正文。去重靠 data/notify_seen_&lt;邮箱id&gt;.php 记已通知的 UID，第一次开只记基线、不推旧邮件；每轮每个邮箱最多推 5 封，防刷屏。设置页里还有「发一条测试通知」和「立即查一轮」两个按钮。
- **TG 折叠的实话**：通知里的正文做不成 TG 里点一下展开的折叠——已实测，往现在这条中转 Worker 发 parse_mode + ||...|| 剧透，TG 返回的文本里没有剧透实体，|| 会原样显示出来。所以通知里只放 120 字预览 + 看全文链接，折叠展开是在管理中心里。
- **轮询不用登录怎么解凭据**：开启时生成一把轮询密钥存 data/notify_key.php，站点密钥用它再加密一份存在 site 记录里（notify_key_blob），定时任务凭这个解密；改站点密码时这份跟着换。不要把 data/ 目录公开。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。
- **v4.9.1（同日补）**：TG 通知里的“点开看全文”链接和设置页轮询地址原来写了 `/manage/`，但 mangguo 站是根目录部署（2026-11-07 已从 mail 站的 manage/ 挪到 mangguo 站 public_html 根目录），已改成根目录地址；更新命令里的 `cd` 也是 `~/domains/mangguo.lele.pp.ua/public_html`，不要加 `/manage`。

## v4.26（2026-11-08）— 添加邮箱保存后留在添加页，不跳去邮箱管理

- 以前点保存后写死了跳去 `?tab=mailboxes`（邮箱管理页），现在按表单里的 `return_tab` 回跳：从添加页保存的新邮箱，留在 `?tab=add`，表单清空、顶部显示“已保存，连接测试也通过了。”，可以直接接着加下一个；改登录方式保存后也留在同一个修改页（`?tab=add&edit=<id>`）。

## v4.25（2026-11-08）— “我的邮箱”图标也改成画出来的蓝色信封

- v4.24 漏了一个：我的邮箱用的 📧 是表情符号，颜色是系统定的，在 aa 的设备上显示是灰白色、不是蓝色，所以看着没变色。现在和另外三个一样，换成画出来的蓝色信封 SVG（#2563eb），展开的标题和折叠时的图标都换了。TG 通知里的 📧 是消息文字，没动。

## v4.24（2026-11-08）— 左栏图标各换一个颜色

- 四个图标现在各一个颜色：我的邮箱 📧 本来就是蓝色，没动；邮箱管理清单板还是绿色 #16a34a；添加邮箱加号改成橙色 #ea580c；设置齿轮改成紫色 #7c3aed。展开、折叠都一样，当前那一项高亮时图标颜色不变。

## v4.23（2026-11-08）— 左栏三个图标改成和字体一样高

- 邮箱管理、添加邮箱、设置三个绿色 SVG 图标原来是写死的 16px，比 15px 的字高 1px，看着大一圈。现在改成 `1em`，图标高度就等于当前字体的高度，以后字号变了图标也跟着变。

## v4.22（2026-11-08）— 图标按 aa 选的换 + 三个图标加绿色

- **我的邮箱用 A**：📧，本来就是现在这个，没动（左栏标题和折叠时的图标都是 📧）。
- **邮箱管理用 C**：原来是 📬，换成带勾的清单板（绿色线条 SVG，颜色 #16a34a，和写信按钮、边线钮同色）。表情符号改不了颜色，所以 C 是画出来的 SVG 图标，不是 emoji。
- **添加邮箱的 ＋ 也加了绿色**：原来是灰色全角 ＋，换成绿色加号 SVG（#16a34a）。
- **设置图标也加了绿色**：原来是灰色 ⚙️，换成绿色齿轮 SVG（#16a34a）。三个图标展开、折叠都一样是绿的，当前那一项高亮时（浅绿底）也看得清。

## v4.21（2026-11-08）— 折叠时显示“我的邮箱”图标、去掉打开又关闭的闪一下

- **折叠时「我的邮箱」图标补上了**：以前侧栏收起来后，整个「我的邮箱」区块是 `display:none`，所以折叠栏里没有它的图标。现在收起后会留一个 📧 图标（写信下面、邮箱管理上面），点一下就展开侧栏、直接选邮箱，不跳转页面。
- **去掉“打开又关闭”那一下**：原来折叠状态是页面底部的脚本在跑，页面刚加载时侧栏先按展开的样子画出来、脚本跑到才收起，所以每次点链接换页都会闪一下打开再关上。现在在 `<div class="wrap">` 后面立刻加了一段小脚本，侧栏还没画出来就先把折叠状态加上，换页不再闪。
- 图标备选（v40 效果图）：「我的邮箱」📧 / ✉️ / 📮 / 📥，「邮箱管理」📬 / 🗄️ / 📋 / 🛠️，等 aa 选。

## v4.20（2026-11-08）— 左栏去掉“收件箱”、添加邮箱挪到左栏、折叠钮跟着鼠标走

- **左栏去掉「收件箱」**：原来点它打开的是全部收件箱，要把所有邮箱的最新邮件一起取回来，太慢了。现在左栏只剩写信、我的邮箱、邮箱管理、添加邮箱、设置；看信直接点「我的邮箱」里某个邮箱。进站默认还是第一个邮箱的收件箱，没变。分组筛选里的“全部”链接还会打开全部收件箱（慢），没动。
- **添加邮箱挪到左栏**：邮箱管理页顶上那条可折叠的「＋ 添加邮箱」拿掉了，左栏「邮箱管理」下面多了一项「＋ 添加邮箱」，点开就是原来的添加表单；改登录方式还是同一个表单，没动。
- **折叠钮跟着鼠标走**：边线那颗圆钮平时藏着，鼠标移到边线上哪里、它就出现在那个高度，移开就藏起来；边线的感应区加宽到 12px（平时看不见），不用再对着 2px 的细线瞄准。点它还是收起 / 展开侧栏，状态照样记在浏览器里。

## v4.19（2026-11-07）— 去掉左栏拖动排序的提示文字

- 左栏「我的邮箱」下面那行“拖动分组名可调换分组顺序，拖动邮箱可调换组内顺序，松手自动保存。”去掉了。拖动功能本身还在，松手自动保存、闪“✓ 排序已保存”也没动。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.18（2026-11-07）— 分组颜色按截图搭配

- 按你发的截图那套来：底色取同色系最淡的一档、文字取同色系的深色，淡底深字、比例协调。调色板顺序特意排过，现在 QQ邮箱是淡绿、outlook 是淡蓝、DNSHE 是淡紫、未分组是中性灰，和截图里的一样；新建分组还是按名字自动分一个淡色。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.17（2026-11-07）— 分组颜色改淡

- v4.16 的颜色还是太浓：8 个配色全部换成更淡的底色（接近白的淡绿 / 淡蓝 / 淡紫 / 淡橙 / 淡粉 / 淡青 / 淡黄 / 淡红），文字也用没那么重的深色，只够看清、刚能分辨分组就行。颜色分配没变（QQ邮箱淡橙、outlook 淡青、DNSHE 淡紫、未分组淡绿）。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.16（2026-11-07）— 分组名称加不同颜色

- 每个分组按名字固定分一个颜色（绿 / 蓝 / 紫 / 橙 / 粉 / 青 / 黄 / 红，8 色循环，改名就换色）：左栏「我的邮箱」里的分组名变成和右侧一样的彩色小标签（浅底深字），表格里分组那列的标签也从灰色改成了同款彩色，同一个分组两边颜色一致。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.15（2026-11-07）— 添加邮箱挪到邮箱管理上方成单独栏；左栏分组和组内邮箱都能拖动排序

- 添加邮箱从邮箱管理页最下面挪到了最上面，单独一栏「＋ 添加邮箱」，默认收起，点一下展开填表；测试失败留了草稿时会自动展开。改登录方式还是在单独的添加页，不受影响。
- 左栏「我的邮箱」加了拖动排序：拖分组名整组换位，拖邮箱在同组内换位（跨组不接，换分组用每行的分组菜单），松手自动保存，不用刷新页面，旁边会闪一下“✓ 排序已保存”。排序用的还是原来那套顺序，表格里的拖动排序和保存按钮没动。只看一个分组时，拖动只动这个分组，别的分组保持原位。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.14（2026-11-07）— 表格「分组」列头加折叠筛选

- 表格里「分组」列头现在是个可点的 ▾：点一下弹出分组选择菜单（全部 + 每个分组，带数量，当前选中的打 ✓），点哪个分组表格就只列那个分组的邮箱；默认展示全部分组。筛选中时列头会显示当前分组名（比如“分组：DNSHE ▾”），点空白处菜单自动收起。顶部的分组筛选按钮还在，两处是同一套筛选。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.13（2026-11-07）— 分组和厂商栏双向同步

- v4.10 里选分组只填了服务器，厂商栏却一直停在“自定义服务器”，看着像改不了：现在厂商下拉里多了已创建的分组选项（DNSHE（分组）、QQ邮箱（分组）……），两边双向同步——分组栏选 DNSHE，厂商栏就同步变成“DNSHE（分组）”，服务器也跟着填好；反过来厂商栏选“DNSHE（分组）”，分组栏也同步变成 DNSHE。选“未分组”时厂商栏回到“自动识别”。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.12（2026-11-07）— 邮箱管理状态栏不再显示测试时间

- 状态栏里“连接成功 / 连接失败”下面那行测试时间（2026-11-07 04:52 这种）去掉了，只留状态标签、失败原因（折叠）和「测试连接」按钮。时间还在数据里记着，只是页面上不显示。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.11（2026-11-07）— 分组图标只留左栏“我的邮箱”

- v4.9 里分组图标加了四处，太多：现在只留左栏“我的邮箱”里的分组名前有蓝底白字首字母图标；邮箱管理的分组筛选、分组改名行、表格里的分组下拉菜单，图标都去掉了，恢复成纯文字。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.10（2026-11-07）— 添加邮箱的分组改成下拉选，选后自动填服务器

- **分组不再是手打的输入框**：改成下拉，列出所有已创建的分组（QQ邮箱、outlook、DNSHE……）+“未分组”+“＋ 新建分组…”；选“新建分组”会再出现一个输入框让你起名字。
- **选分组就自动填服务器**：每个分组的服务器取自这个分组里已有的邮箱——选 DNSHE，下面的 IMAP / SMTP 就自动填成 `smtp.mail.v.cd:993` SSL / `smtp.mail.v.cd:465` SSL；选 QQ邮箱就填 `imap.qq.com:993` / `smtp.qq.com:587`；再加同分组的第二个邮箱（比如 aa02@v.cd）不用再手动改服务器。填完后厂商那一栏会自动变成“自定义服务器”，服务器不对还可以再手动改。
- **只换 `index.php` 一个文件**（imap.php / oauth.php / ms_oauth.php 没动）。

## v4.8（2026-11-07）— 缓存默认改成 1 分钟，刷新不受时间限制

- 缓存默认时间从 5 分钟改成 1 分钟（设置页里还能改，1–60 分钟）；刷新按钮本来就是绕过缓存直接现场取的，不受这个时间限制，点一下立刻取最新——这点之前就是这么做的，这版只在设置页提示里写明白了。

## v4.7（2026-11-07）— 收件箱列表缓存 + 摘要批量取 + 我的邮箱展开状态记住

- **列表缓存，进收件箱秒进**：每个邮箱、每个文件夹的列表（最新 30 封：发件人、主题、摘要、时间、已读标记）存在 `data/cache_<邮箱id>_<文件夹>.php`，和邮箱记录一样的 exit 保护 + .htaccess，不含任何凭据和令牌。默认缓存 1 分钟（v4.8 从 5 分钟改过来），设置页“收件箱列表缓存（分钟）”里改（1–60 分钟）；1 分钟内再进直接读缓存，不连 IMAP；过期或点刷新才现场取，刷新不受时间限制。统一收件箱里每个邮箱各自按自己的缓存来，合起来还是按时间倒序排。
- **↻ 刷新按钮**：文件夹 pills 下面加了“↻ 刷新”，点一下强制现场取最新并重写缓存；旁边一行小字说明状态——缓存来的显示“列表缓存于 HH:MM（X 分钟前）”，现场取的显示“刚取的最新列表”（时间按北京时间）。
- **缓存自动清掉的时机**：发信成功、删信 / 移到垃圾箱、删邮箱、改登录方式 / 凭据后，清掉那个邮箱所有文件夹的缓存；读 / 写缓存失败（权限、文件损坏、磁盘满）一律静默，绝不让收件箱因为缓存打不开——直接现场取。
- **摘要批量取（冷启动也快了）**：原来每封摘要一个来回（30 封就是 30 次），现在 `mail_imap_fetch_snippets()` 一次取 10 封的 `BODY.PEEK[1]<0.300>`，30 封只要 3 条命令；哪封取不到、解析不出，摘要就是空串，不影响整列。单封取法 `mail_imap_snippet()` 原样保留。
- **我的邮箱展开状态会记住**：之前理解反了做的“一次只展开一个分组”手风琴已撤掉；现在展开状态记在浏览器 localStorage（`mc_mblist_open`，和侧栏折叠、列表宽度一个做法），打开后点别的项目、刷新页面都还是展开的，方便切换邮箱；各分组默认都展开，互不影响。
- **实话 / 限制**：缓存过期后第一次进还是现场取，一样慢；缓存只管列表，读信正文和附件还是每次现场取；读完一封信，已读状态最多晚一个缓存周期才在列表里变过来（点刷新立刻变）；第 2 页起没有缓存，每次都现场取。

## v4.6（2026-11-07）— 分组菜单默认都在箭头下方展开

- 删掉了最后一行菜单往上展开的那条特殊规则，现在不管哪一行，菜单默认都在折叠箭头下方展开。

## v4.5（2026-11-07）— 点空白处收起分组菜单

- 点页面空白处，打开的分组菜单自动收起；点菜单里面（选分组、输新建分组名）不收，点箭头照常开关。

## v4.4（2026-11-07）— 分组下拉菜单加宽，新建分组输入框能看全

- v4.3 收得太窄了，新建分组的输入框只剩 60px 左右，“新建分组名”只显示“新建分”。菜单宽度改回 240–280px，输入框约 140px 宽，提示字和打字都够地方；行高和字号保持 v4.3 的紧凑版不变。

## v4.3（2026-11-07）— 分组下拉菜单改紧凑

- 菜单整体收小：宽度从 180–260px 收到 160–220px；分组每行上下留白从 8px 收到 5px、字号 14px 改 13px；新建分组那行上下留白也收紧了。行数不变，只是每行更矮、面板更窄。

## v4.2（2026-11-07）— 分组下拉菜单改挂在折叠箭头下

- 分组下拉菜单改成浮层：菜单左边缘对准折叠箭头 ▾ 的位置，从箭头下方展开，不再从分组栏最左边开始；最后一行邮箱的菜单改成往上展开，不会被表格底部裁掉。

## v4.1（2026-11-07）— 邮箱管理表改版：分组下拉、操作栏取消、改登录方式挪位

- 分组栏改成下拉：点当前分组旁边的 ▾ 箭头展开，列出已创建的分组（当前分组打 ✓），点哪个邮箱就自动移到哪个分组；下面还能直接输新分组名，点“新建并移入”就建好新分组并移过去。原来的输入框 + 改分组按钮没了。
- 操作栏整个取消：读信（去左栏收件箱看）、改登录方式（挪到登录方式栏）、测试连接（挪到状态栏下面）、删除（挪到邮箱那一栏里的小字）——功能都没丢，只是换了位置。
- 登录方式栏：上面显示当前登录方式（授权码·应用专用密码 / 登录密码 / 微软登录），下面就是“改登录方式”按钮，上下排列。
- 注意：这版 index.php 里仍含 v4.0 的微软登录代码，部署时 ms_oauth.php 必须一起在服务器上（index.php 第 26 行 require）。

## v4.0（2026-11-07）— 微软账号登录（Outlook / Hotmail）

- **Outlook 终于能加了**：微软自 2024-09-16 起个人 Outlook / Hotmail 只认微软账号登录（OAuth2），密码和应用专用密码都登不上；现在管理中心自己接了微软登录，不用再等 SnappyMail 插件。
- 新文件 `oauth.php`（部署到 public_html 根目录，和 index.php 放一起）：`?step=ms_start` 跳微软授权页（带 32 位 hex state 防串改），`?step=ms_callback` 校验 state、拿授权码换令牌、从 id_token 取邮箱和显示名（核对 aud 是本应用、exp 未过期），同邮箱已存在就改成微软登录并换上新令牌，否则新建邮箱记录（服务器写死 `outlook.office365.com:993` SSL / `smtp.office365.com:587` STARTTLS），最后跳回邮箱管理。
- 新文件 `ms_oauth.php`（index.php 和 oauth.php 共用）：Client ID / Secret 从站点设置里解密读；授权地址、令牌换取 / 刷新都走 `file_get_contents` + `stream_context_create` POST（不用 curl）；XOAUTH2 认证串 `ms_token_blob()`；`ms_valid_access_token()` 令牌快过期自动用 refresh token 换新的并写回邮箱记录，同一请求里不重复刷新。
- 设置页新卡片「微软账号登录（Outlook / Hotmail）」：Client ID（文本）+ Client Secret（密码框带显示 / 隐藏）保存动作 `ms_save`（加密存站点设置；Secret 留空就是不改，两个都空是清空），重定向 URI 只读框展示并写明“去 Azure 注册应用时，重定向 URI 就填这个，一字不差”：`https://mangguo.lele.pp.ua/oauth.php?step=ms_callback`；显示 Client ID / Secret 是“已保存”还是“未填写”。
- 添加邮箱表单：厂商行下方加绿框「用微软账号登录添加」按钮（链到 `oauth.php?step=ms_start`）；没在设置里填 Client ID / Secret 时按钮置灰并提示“先在设置里填 Client ID 和 Secret”。
- 邮箱列表：微软登录的邮箱在邮箱旁显示「微软登录」徽标，登录方式一栏也显示“微软登录”；测试连接对这类邮箱改成测令牌能不能拿到（过期自动刷新）。
- 收发信：微软登录的邮箱用 XOAUTH2 代替密码 LOGIN（IMAP 新增 `mail_imap_auth_xoauth2()` + `mail_connect_oauth()`；SMTP 发信 `mail_smtp_send()` 传认证串后用 `AUTH XOAUTH2` 并期望 235，服务器回 334 要空行时补一个空行）。密码 / 授权码邮箱的行为一律没动。
- 改站点密码时，微软的 Client ID / Secret 和各邮箱的令牌也一起用新密钥重新加密，不会因为改密码解不开。
- 从表单改回密码 / 授权码登录时，微软登录标记和令牌一起清掉。
- Azure 注册步骤（在你自己的微软账号里做）：portal.azure.com → 应用注册 → 新注册 → 名称任意 → 帐户类型选“任何组织目录中的帐户和个人 Microsoft 帐户” → 平台 Web、重定向 URI 填上面那个 → 注册后记下应用程序（客户端）ID → 证书和密码 → 新客户端密码 → 记下值，只显示一次 → API 权限 → 添加权限 → Office 365 Exchange Online → 委托的权限 → 勾选 IMAP.AccessAsUser.All 和 SMTP.Send。个人账号不需要管理员同意。
- QQ / Gmail 不受影响：QQ 还是授权码，Gmail 还是应用专用密码。
- 注意：v4.0 没在 Serv00 上实测过，也没走过真实微软登录；更新后先在 Serv00 跑 `php -l`，再按 README 第 5 节走一遍 Azure 注册和登录。

## v3.20（2026-11-07）— 收件箱栏往右挪一点

- 收件箱栏（中间那栏）整体往右挪了 4px，左边离左栏的距离和右边离读信栏的距离对齐了；其他地方没动，窄屏上下排时不受影响。

## v3.19（2026-11-07）— 左栏与收件箱栏间距收窄对齐

- 左栏边线和收件箱栏之间的留白收窄了：主栏边距从 16px/12px 改成 12px/8px，卡片内边距从 20px 改成 16px/12px；现在收件箱标题离边线的距离，和左栏文字离左边的距离差不多，左右看着协调了。

## v3.18（2026-11-07）— 边线再改细 + 图标加大 + 悬停全绿

- 边线从 5px 灰带改细到 2px（平时只剩侧栏本身 1px 的边，几乎看不见灰带）。
- 折叠图标加大：圆钮 16px 改 18px，箭头 10px 改 12px。
- 悬停改回一眼能看出来的全绿：整个圆钮实心绿、箭头变白。

## v3.17（2026-11-07）— 折叠图标改成 Henna 同款

- 对照 Henna 域名邮箱项目里列表分隔线上的折叠钮改的：边线 5px 灰色、悬停变绿；圆钮 16px 白底、浅绿边框、带一点阴影；箭头是细线单箭头（SVG，线宽 2.5），收起朝左、展开朝右；平时箭头绿色，悬停浅绿底 + 深绿箭头。

## v3.16（2026-11-07）— 折叠圆钮改小改细

- 折叠圆钮从 20px 改小到 16px，箭头从 14px 加粗改成 11px 中等粗细，看着秀气一点；悬停还是实心绿白箭头。

## v3.15（2026-11-07）— 折叠图标加粗 + 悬停全绿 + 左栏与收件箱间距收窄

- 折叠圆钮里的箭头加粗了（平时也更显眼）。
- 鼠标放上去整个圆钮变成实心绿、箭头变白，跟 Henna 那个效果一样。
- 左栏和收件箱栏之间的留白收窄了（主栏左右边距从 24px 改成 12px）。

## v3.14（2026-11-07）— 折叠圆钮悬停变绿

- 鼠标放到侧栏边线中间那个折叠圆钮上，圆钮的边框和箭头直接变绿（之前只有放整条线上才变，现在放圆钮本身上也变）。

## v3.13（2026-11-07）— 侧栏边线改细 + 折叠圆钮放中间

- 侧栏右边的边线从 12px 改细到 6px，不再是一条粗灰带。
- 折叠按键改成一个白色小圆钮，正好在线的正中间（上下居中），点它收起 / 展开。

## v3.12（2026-11-07）— 折叠按钮移到侧栏边线上

- 侧栏顶上那个单独的 « 按钮取消了，折叠改到侧栏右边的边线上：点边线中间的 « 就收起成图标窄栏，点 » 再展开；鼠标放上去会变绿。

## v3.11（2026-11-07）— 侧栏折叠 + 细铅笔图标 + 写信按钮拉长 + 分隔线到底

- 左栏加了折叠功能：点左上角的 « 就收起成只有图标的窄栏（写信只剩图标、我的邮箱和底部说明都藏起来），点 » 再展开；收起状态浏览器会记住。
- 写信图标从信封换成细线铅笔（aa 之前说画笔丑、信封版按钮又太短）。
- 写信按钮拉长到 150px 居中，不再是之前那个很短的。
- 列表栏和读信栏之间的分隔线现在一直拉到页面底部。

## v3.10（2026-11-07）— 写信按钮收窄 + 换信封图标

- 左栏写信按钮收窄居中，不再占满整栏；图标从画笔换成信封 ✉️（aa 从 6 个备选中选了 1 号）。

## v3.9（2026-11-07）— 邮箱跟在标题后面 + 垃圾邮件改名

- 收件箱标题和邮箱地址改成同一行显示（“收件箱 1641697128@qq.com”），不再分两行。
- “垃圾邮件”改名“垃圾箱”（文件夹标签、提示、确认框都一起改）。

## v3.8（2026-11-07）— 收件箱头部排版

- 写信改成和文件夹一样的白色圆角小标签（不再是绿色大按钮，画笔图标也去掉了），只有当前所在的文件夹是绿色。
- 写信 + 5 个文件夹共 6 个标签，默认两排、每排 3 个，等宽居中。
- 收件箱标题下面直接显示邮箱地址，“当前邮箱：”和绿色“● 当前”徽标都取消了。

## v3.7（2026-11-07）— 列表栏默认缩窄 + 拖动边线

- 邮件列表栏默认缩窄到 340px，读信栏占剩下的宽；窄屏（900px 以下）照旧上下排，不拖动。
- 列表栏和读信栏之间加了条拖动边线：按住左右拖，列表栏变宽、读信栏就变窄，反过来拖就读信栏变宽；拖动范围 260～560px，拖完的宽度浏览器会记住，下次打开还是一样。

## v3.6（2026-11-07）— 北京时间显示 + 左栏间距 + 收件箱写信按钮

- 列表时间按北京时间显示：当天的只显示时:分（如 12:40），之前的显示 年/月/日（如 2026/10/04）；按月分组也按北京时间算。
- 左栏“我的邮箱”上下间距改成和其他栏目一样宽。
- 收件箱中栏“当前邮箱”那行前面加了个 ✏️ 写信按钮（在收件箱文件夹前面），删掉了“（换邮箱点左侧栏「我的邮箱」）”那句说明。

## v3.5（2026-11-07）— 全部收件箱 + 我的邮箱默认收起 + Outlook 式按月分组列表

- 左栏“📥 全部收件箱”改回“📥 收件箱”，点它默认就是全部收件箱：所有邮箱的最新邮件合在一起、按时间从新到旧排，一页 30 封。点左栏「我的邮箱」里的某个邮箱，才只看它一个。
- 「📧 我的邮箱」默认是收起的，点一下才展开看到分组；每个分组的折叠箭头挪到分组行最右端，分组名点一下还是只看该分组的邮箱。
- 收件箱列表改成 Outlook 式按月分组：组头是“本月 / 10月 / 9月 …”（跨年显示“2025年10月”），每组可折叠，本月那组默认展开、其他组收起；组内按时间从新到旧排。
- 每封邮件现在是三行：第一行发件人 + 右边时间，第二行主题（未读加粗），第三行正文摘要（灰色小字，一行、超长截断）。摘要是 `imap.php` 里每封多取一次 `BODY.PEEK[1]<0.300>` 的正文开头，解码、去标签、压空白后截约 80 字；取不到就留空，不影响整行。
- 全部收件箱里每封后面都带所属邮箱的小标签；点开、删除、标记垃圾邮件都按那封所属的邮箱走，删完回全部收件箱。读信页仍没有删除按钮。

## v3.4（2026-11-07）— 左栏重排 + 写信选邮箱 + 添加邮箱并入邮箱管理

- 左栏从上到下改成：写信（顶部绿色大按钮）→ 全部收件箱 → 📧 我的邮箱（和别的栏目一样大、带图标，在邮箱管理上面）→ 邮箱管理 → 设置（最下面）；“收件箱”改名“全部收件箱”；单独的“添加邮箱”栏目取消。
- 写信页：发件邮箱改成按分组下拉选（分组做标题、邮箱列在组下面），用哪个邮箱发就选哪个；点写信直接跳写信页。
- 添加邮箱表单直接放在邮箱管理页最下面（和单独的添加页共用同一份表单，测试/保存后会回到当时所在的页）。

## v3.3（2026-11-07）— 厂商预设 + 密码可见 + 测试不清空

- 添加/修改邮箱表单新增“邮箱厂商”下拉：QQ / Gmail / Outlook / 网易 163 / 126 / 自定义，选一个就自动填好 IMAP/SMTP 服务器、端口、加密；填邮箱地址也会自动识别厂商；选 Outlook 会提示个人账号只认 OAuth2。
- 密码 / 授权码默认直接显示（可核对），旁边有“隐藏”按钮可切回圆点；改登录方式打开时也显示当前存的凭据。
- 点「测试连接」后填过的密码 / 授权码不再清空，留在框里，测试失败改完服务器直接再测，不用重填；邮箱格式不对时填过的值也都保留。
- 顺带修了加密下拉框不记住已存值的问题，并把测试失败提示里的 Outlook 应用密码说法改对（个人账号应用密码也登不上）。

## v3.2（2026-11-07）— 分组改名

- 邮箱管理新增“分组管理”：每个分组一行，填新名字点“改分组名”，这个分组里的邮箱一起跟着改，不用一个个改（新动作 `rename_group`，空名字和同名会报错提示）。

## v3.1（2026-11-07）— 分组筛选 + 当前邮箱标识

- 收件箱左栏：点分组名就只列出该分组的邮箱（带数量），再点“全部”看所有分组；当前看的邮箱整行绿底 + 左边绿边 + 右边“● 当前”字样，中栏顶部也有绿色“● 当前”徽标。
- 邮箱管理：顶部加分组筛选（全部 / 各分组带数量），点哪个分组就只列出该分组的邮箱；改分组仍在每行直接改；只看一个分组时拖动排序会提示先点“全部”。

## v3（2026-11-07）— 修警告、表格不竖排、三栏收件箱、邮箱分组 + 拖动排序

### 修的 bug

- `imap.php` 第 431 行：`preg_split('/[\/\.\]/', …)` 的字符类没闭合
  （类里的 `\]` 是字面 `]` 不是结束符），每次列文件夹都冒一堆
  `preg_split(): Compilation failed: missing terminating ]` 英文警告；
  已改成 `preg_split('/[\/\.]/', …)`（只按 `/` 或 `.` 切文件夹名），
  并逐个核对了两个文件里所有正则，别的都没有未闭合的字符类。
- `index.php` 在 `session_start()` 后加了 `ini_set('display_errors', '0')`，
  以后就算再有 PHP 警告也不会直接显示在页面顶部。

### 改了什么

- 邮箱管理表格：包了一层横向滚动容器，单元格不再换行挤成竖排字，
  表太宽就左右拖动看；邮箱列超长会截断显示；登录方式、状态、操作按钮都不换行。
- 收件箱改成三栏：左栏「我的邮箱」按分组列出所有邮箱，点一个就切到它；
  中间是文件夹（收件箱 / 垃圾邮件 / 已发送 / 草稿箱 / 已删除）+ 邮件列表
  （30 封一页，未读加粗带绿点，每封右下角有 🗑 删除图标）；
  右栏是读信（发件人、主题、时间、正文、附件，只有回复 / 转发 /
  标记垃圾邮件，没有删除按钮）；没选邮件时右栏显示“点一封邮件查看”。
  旧的 `?tab=read` 地址也一样显示三栏。
- 邮箱分组 + 拖动排序：每个邮箱多一个「分组」字段（默认“未分组”，
  添加 / 改登录方式时可填，表格里也能直接改）；左栏按分组折叠显示，
  顺序就是保存顺序；邮箱管理里拖动表格行可调换顺序，拖完点「保存排序」。
  分组和顺序都存在原来的 `manage/data/mailboxes.php` 里，不用动数据，
  旧邮箱第一次打开时分组自动是“未分组”。

### 文件清单（v3）

- `manage/index.php` — 主程序（v3，1125 行）
- `manage/imap.php` — 收发信库（只改了第 431 行一个正则）
- `manage/README.md` — 部署说明（v3 更新）
- `manage/CHANGELOG.md` — 本文件

### 部署

把 `index.php` 和 `imap.php` 一起传到 Serv00（和 v2 同一个目录），
再跑 `php -l index.php` 和 `php -l imap.php`。
旧的 `manage/data/` 不用动，邮箱记录、分组、站点密码都在里面。

### 未验证

- 没有在 Serv00 上实测，也没有在本地跑 `php -l`（本机没有 PHP）：
  只做了去字符串/注释后的括号核对（两个文件括号、花括号、方括号都平衡）
  和正则字符类逐个检查。部署后先打开收件箱确认顶部没有英文警告，
  再试分组、拖动排序、三栏读信，报错截图发回来再改。

## v2（2026-11-07）— 内置完整收发信，不用再跳 SnappyMail

用户要求：在管理中心页面里就能设置 / 添加邮箱规则、添加邮箱、查看收件箱、
回复 / 转发 / 编写 / 发送邮件，而不是跳去 SnappyMail 管理后台设置。

### 改了什么

- 新增 `imap.php`（纯 PHP 收发信库，无 php-imap 扩展、无 Composer）：
  IMAP 连接与登录（SSL 993 / STARTTLS 143）、LIST、SELECT、UID SEARCH、
  UID FETCH（ENVELOPE + BODY[]）、STORE 已读、MOVE / COPY + 删除 + EXPUNGE、
  APPEND 已发送；SMTP 发信（SSL 465 / STARTTLS 587、AUTH LOGIN、DATA）；
  MIME 解析（multipart 递归、base64 / quoted-printable、UTF-8 / GBK 转码、
  RFC2047 编码词解码、附件提取）、纯文本正文优先、网页正文转纯文本。
- `index.php` 新增栏目：左侧栏最前面加「收件箱」「写信」。
  - 收件箱：顶部切换邮箱；文件夹顺序是收件箱 / 垃圾邮件 / 已发送 /
    草稿箱 / 已删除（垃圾邮件紧跟收件箱，用 IMAP LIST 发现，不存在的灰显）；
    最新 30 封一页，未读加粗带绿点，上一页 / 下一页翻页；点开标已读。
    每封邮件右下角直接有个 🗑 删除图标，点一下（先确认）就移到已删除，
    不用点开再删。
  - 读信：发件人、收件人、抄送、时间、主题、正文、附件下载链接；
    回复（收件人自动填原发件人、主题加 Re:、正文带原文）、转发
    （收件人空着、主题加 Fwd:、正文带原文）、标记垃圾邮件
    （移到垃圾邮件）。读信页顶部没有删除按钮，删除只在列表里做。
  - 写信：收件人（多个逗号隔开）、抄送（可选）、主题、纯文本正文；
    发信成功后尽力把副本 APPEND 到已发送（失败不算发信失败）。
  - 邮箱管理：原来的「进入邮箱」（跳 SnappyMail）改成「读信」，直接打开本站收件箱。
  - 设置：SnappyMail 的两个入口只留作备用说明，移到设置页最下方。
- 保留未变的：站点密码登录、邮箱添加 / 改登录方式 / 测试连接 / 删除、
  凭据加密存储（`manage/data/` 的 .php 文件 + 退出保护）、Henna 外观。
- `README.md`：开头、上传方式（子目录 / mangguo.lele.pp.ua 子域名两种）、
  平时用法、新增第 8 节（v2 限制实话）；文件清单加 `imap.php`、`CHANGELOG.md`。

### 文件清单

- `manage/index.php` — 主程序（v2，1011 行）
- `manage/imap.php` — 收发信库（新增，953 行）
- `manage/README.md` — 部署说明（v2 更新）
- `manage/CHANGELOG.md` — 本文件

### 部署

把 `index.php` 和 `imap.php` 一起传到 Serv00（子目录或 mangguo 子域名根目录，
两个文件必须在同一个目录），再跑 `php -l index.php` 和 `php -l imap.php`。
旧的 `manage/data/` 不用动，邮箱记录和站点密码都在里面。

### 未验证

- 没有在 Serv00 上实测，也没有在本地跑 `php -l`（本机没有 PHP）：
  只做了括号 / 圆括号文本核对和逐行检查。部署后先打开收件箱、读一封信、
  发一封测试信给自己，报错截图发回来再改。
- IMAP / SMTP 的命令在代码里是按 RFC 写的，但各厂商的实际回包
  （QQ 的文件夹名、Gmail 的标签式文件夹、Outlook 的文件夹属性）
  只能在真邮箱上验证；文件夹映射、附件、中文主题都列在第 8 节的限制里。
