# 一刻 · 宫缩记录

手机上的宫缩计时器。Streamlit Community Cloud 提供页面，Supabase Auth 管理邮箱密码，Supabase PostgreSQL 保存两位成员共享的记录。浏览器只访问 Streamlit，Supabase 请求由服务器发出。

## 已实现

- 点击开始 / 结束，按点击时间计算持续时长；切后台后按时间戳恢复。
- 每两次开始的间隔、上次结束后的休息时间、轻 / 中 / 强。
- 两个允许邮箱共同查看、修改和记录；同时只能有一次正在计时。
- 本机未确认操作先暂存，收到数据库确认后才移除；断线后重试。
- 历史修改、删除确认、跨设备版本冲突提示、分页。
- Supabase 邮箱密码登录；管理员提供一次性设置码，无需邮件服务。

## 部署

### 1. 新建 Supabase 专用项目

选择自己的组织和免费项目。在 SQL Editor 执行 `supabase/migrations/001_tracker.sql`，然后由管理员执行：

```sql
insert into private.allowed_emails(email)
values ('first@example.com'), ('second@example.com');
```

把示例替换成实际获准的两个邮箱。关闭 Auth 的公开注册和匿名登录，保留 Email + Password 登录。匿名请求和不在名单中的账号均不能读取记录；客户端不能修改名单。

### 2. 放入 GitHub

将本项目源代码提交到自己的私有仓库，主分支建议为 `main`。
**不要上传** `.streamlit/secrets.toml`、`private/`、数据备份、密码设置码或管理员密钥；它们已被 `.gitignore` 排除。

### 3. Streamlit Community Cloud

在 https://share.streamlit.io/ 选择自己的仓库、分支 `main`、入口 `streamlit_app.py`，Python 选择 **3.12**。在 Advanced settings / Secrets 填写 `.streamlit/secrets.example.toml` 的实际值：

```toml
SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"
SUPABASE_PUBLISHABLE_KEY = "sb_publishable_REPLACE_ME"
TRACKER_ALLOWED_EMAILS = ["first@example.com", "second@example.com"]
```

只使用 publishable key 或旧版 anon key。线上应用会拒绝 service_role / sb_secret_ 管理员密钥。
部署后把 Streamlit 页面设为可公开访问；应用自己的邮箱登录和数据库权限仍保护记录。这样手机不需要额外的 Streamlit 账号登录。

### 4. 创建两个账号及首次设置码

管理员在本机安装 `requirements-dev.txt` 后，运行：

```bash
python scripts/provision.py --email first@example.com --email second@example.com --create-codes --app-url https://YOUR-APP.streamlit.app
```

脚本会以隐藏输入方式询问 `SUPABASE_DB_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，也可从环境变量读取。数据库连接可用 Supabase Connect 中的 session pooler，脚本强制 TLS。脚本不会发送邮件。

`private/password-setup-时间.html` 保存两人的一次性设置码；只将对应代码私下交给对应使用者。打开网页，展开“首次使用 / 重新设置密码”，验证后自行设置密码。代码的有效期取决于 Supabase 的 Email OTP Expiration。过期或忘记密码时，管理员加上 `--reset-codes` 重新生成；旧代码会被替换。

如数据库尚未安装迁移，可加 `--apply-schema`。脚本发现已有 `contractions` 表会拒绝覆盖。

### 5. 导入旧站记录

迁移期间先停止在旧站新增或修改，导出最新记录后运行：

```bash
python scripts/provision.py --email first@example.com --email second@example.com --import-records private/legacy-records.json
```

导入保留记录 UUID、时间、强度、版本和软删除标记。旧创建人无法映射为 Supabase 用户时留空。相同记录不会重复插入；遇到同编号但内容不一致会整批回滚，不覆盖目标数据。新站开始使用后，旧站不会与它双向同步。

原站的密码哈希不能直接迁入 Supabase Auth，两位成员需要在新站各自设置一次密码。

## 本地运行

```bash
python -m pip install -r requirements.txt
streamlit run streamlit_app.py
```

先把 `.streamlit/secrets.example.toml` 复制为 `.streamlit/secrets.toml` 并填写配置。服务未配置时页面会停止在提示状态，不会使用本地假数据冒充云端记录。

登录凭据只保存在该设备当前 Streamlit 会话的服务器内存里，未写入浏览器存储。刷新或新开页面可能需要重新登录，可使用手机密码管理器。待同步记录按账号隔离，保存在此浏览器的 localStorage；清除网站数据也会清除这些未同步操作。

## 验证

```bash
python -m pip install -r requirements-dev.txt
python -m pytest tests -q
node tests/test_queue.mjs
```

数据库脚本可用独立测试目录中的 `@electric-sql/pglite@0.5.8` 执行：设置 `PG_TEST_RUNTIME` 指向该包的 `dist/index.js`，然后运行 `node tests/test_database.mjs`。测试使用内存 PostgreSQL 和模拟 Auth 身份，不接触实际项目。已覆盖匿名拒绝、授权撤回、两人共享、版本冲突、历史操作幂等、软删除及分页。PGlite 只有一个连接，不代表已完成多连接压力测试。

上线后还应使用两人的实际账号确认共享记录，并在手机的 Wi-Fi 和移动网络分别打开新地址。服务可达性取决于所在网络；免费托管服务也可能出现冷启动或服务休眠。

## 结构与权限

- `streamlit_app.py`：登录和页面入口；每个用户独立的 Supabase 客户端。
- `backend.py`：参数校验、Supabase Auth、数据库 RPC。
- `ui/`：原生 Streamlit v2 组件；无外部 CDN，JS 只负责界面和本机待同步队列。
- `supabase/migrations/001_tracker.sql`：RLS、成员权限、事务锁和幂等 RPC。
- `scripts/provision.py`：仅供管理员在本地运行，不能由线上页面调用。

本工具仅作记录，不提供诊断或就医判断。

官方参考：[Streamlit 部署](https://docs.streamlit.io/deploy/streamlit-community-cloud/deploy-your-app/deploy)、[Secrets](https://docs.streamlit.io/deploy/concepts/secrets)、[Supabase Auth](https://supabase.com/docs/guides/auth)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。
