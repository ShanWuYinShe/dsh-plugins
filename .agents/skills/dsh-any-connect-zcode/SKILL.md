---
name: dsh-any-connect-zcode
description: dsh-any-connect 的 ZCode 通道事实与排障：Coding Plan 与 Start Plan 双支持的取 key 规则（回落与优先级）、账号计划专属通道的风控封锁现状、反编译取证的定位手法、以及隔离实例端到端验证流程。触发：改 dsh-any-connect 的 ZCode 相关代码；排查 ZCode 额度/套餐名显示不对；判断 zcode-plan 模型通道能否使用；需要在本机反编译 ZCode 客户端或跑插件隔离实测。
---

# dsh-any-connect × ZCode

实测日期 2026-09-29，ZCode 桌面 3.14.4 / 内置 agent `zcode.cjs` 0.16.9 / DSH 0.2.0-rc.1。
所有结论均由本机取证得出，复现脚本见 `.workwork/zcode-startplan/`（不入库）。

## 一、凭据与账号选择（最容易踩的坑）

`~/.zcode/v2/credentials.json` 是**扁平的 key→值映射**，真实安装会同时存在多把 key：

```
account-provider:coding-plan:account:bigmodel-team-coding-plan:account:<uid>:api-key
account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:<uid>:api-key
zcodejwttoken                      # 账号计划（Start Plan / off-peak）用它鉴权
oauth:bigmodel:access_token / oauth:active_provider / zcodejwttoken ...
```

- **不要按对象顺序取第一个**：历史实现取"第一个含 `coding-plan` 的条目"，本机实测会
  取到 **team** 那把（插入顺序决定），而客户端实际用的是 individual。
- 正确做法：读**同目录的 `setting.json`**（无密钥，可安全读）：
  `providerFamilyDomain` 给当前 family，`providerFamilyConnectionSelections.<family>.kind`
  给计划（`individual-coding-plan` / `team-coding-plan` / `start-plan` / `off-peak`）。
  按 family+kind 精确匹配 key。
- **计划归属以 selection 为准，不是"选中的 key"**：账号计划在凭据里**没有**对应的
  api-key 条目，accessToken 只能回落到别的账号的 key。把回落的 key 当计划会让额度
  读到别的账号上去（本机实测一开始就这样错）。
- `enc:v1:<iv>.<tag>.<ct>` = AES-256-GCM（base64url 三段），密钥 =
  SHA-256(`zcode-credential-fallback:<platform>:<homedir>:<username>`)，或 env
  `ZCODE_CREDENTIAL_SECRET`。
- **双支持口径（2026-09-30 定）**：不区分账号计划都走**普通 ZCode 通道**
  （`open.bigmodel.cn/api/anthropic` + 签名，150% 额度）。取 key 规则：
  客户端选中的计划若有对应 key 就用它；否则（start-plan / off-peak 从不写 key）
  回落同 family 的 coding-plan key，**个人版优先于团队版**——团队 key 在服务端
  需要 `bigmodel-organization` / `bigmodel-project` 身份头，个人版不需要。
- **计划标识与发请求用的 key 解耦**：`zcodePlan`（客户端选择）标识账号，
  `accessToken`（实际 key）用于签名；不要把前者从后者推断出来。

## 二、Start Plan 额度（可用）

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance[?app_version=<ver>]
    Authorization: Bearer <zcodejwttoken>
    X-Device-Mid: <稳定 UUIDv4>
```

- 返回 `data.plans[]`（活动名 `name`、`plan_id`、`ends_at`）与 `data.balances[]`
  （`show_name` / `total_units` / `used_units` / `remaining_units` / `expires_at`，
  单位是 **token**，不是积分）。本机实测：`ZCode Trust Build`，GLM-5.3-Flash
  100,000,000 tokens 额度。
- **`X-Device-Mid` 是硬要求**：不给 / 每请求随机 → `400 code 3001` 或 `429`。
  取值优先级：`~/.zcode/v2/telemetry-state.json` 的 `deviceMid` →
  `$DSH_HOME/.zcode-device-mid`（自生成并持久化）。
- 同族端点都可读：`billing/current`、`billing/preview`；`billing/claim` 需要
  阿里云验证码（无码 → `400 code 3007 captcha verify failed`）。

## 三、plan 模型通道：当前被上游风控封锁（勿盲目接入）

`POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` → **HTTP 405
`{"code":3012,"msg":"request has been blocked due to unusual activity."}`**

已排除的变量（2026-09-29 全部实测仍 3012）：HTTP/1.1 与 HTTP/2、curl 与 undici、
stream 与否、阿里云验证码头、阿里云 cookie（`acw_tc`/`cdn_sec_tc`/`visitor_id`）、
浏览器形态 UA、**浏览器内同源页面 fetch**、完整 attribution 头集（`x-request-id` /
`x-session-id` / `x-query-id` / `x-zcode-trace-id` / `x-zcode-session-type`）、
E2E 客户端签名 V4（`X-Client-Sig`/`X-Client-Pow`，握手走
`open.bigmodel.cn/api/paas/c1f3a7e2/v2/client` 成功）、三个官方模型名全试。

对照（同刻同域）：不带 JWT → 401；不存在的路径 → 404；`billing/balance` → 200。
**拦的是"这个客户端指纹 + 这个路由"，不是账号/路径/JWT/验证码。**

同页多路 relay 也都不通：`/api/v1/ultra/anthropic`、`/api/v1/ultra-zai/anthropic`
（自造 header 会返回 `401 code 1002`，说明这些端点主要在验收特殊的鉴权形状）；
off-peak 通道**取票可用**（`POST /api/v1/off-peak/ticket` 需
`X-Coding-Plan-Api-Key`，轮询 `/ticket/status` 能到 `ready`），但
`POST /api/v1/off-peak/anthropic/v1/messages` 一律 `400 code 3001 parameter error`
——参数形状与服务端校验不一致，尚未逆出。

**结论：只接入可用的额度/套餐信息，不注册必然失败的模型分组。** 判断"上游是否恢复"的
最小探针就是上面的 messages 请求（拿 200 即恢复）。

## 四、隔离实例端到端验证（改插件后必跑）

```bash
H=<workspace>/.workwork/dsh-verify/home
DSH_HOME=$H dsh plugin --profile web add <repo>/packages/dsh-any-connect
DSH_HOME=$H ZCODE_AUTH_FILE=<带指定 selection 的凭据副本> dsh web --port 8932 --no-open
# 卡片数据走宿主路由（不必开浏览器即可核对）：
curl -sS "http://127.0.0.1:8932/plugins/dsh-any-connect/zcode/status" -H "Host: 127.0.0.1:8932"
```

- 想验证"客户端选了 start-plan"的分支：把真实 `credentials.json` 复制到临时目录，旁边放一份
  `setting.json`（`providerFamilyConnectionSelections.bigmodel.kind = start-plan`），用
  `ZCODE_AUTH_FILE` 指过去。**不要改用户真实的 `~/.zcode/v2/setting.json`。**
- 浏览器侧用 `/Users/liyou/.local/bin/agent-browser`（全路径，PATH 顺序不保证）；若报
  `SingletonLock: File exists` 先删 `$TMPDIR/agent-browser-sandbox/chrome-profile/Singleton*`
  再开。**`--no-sandbox` 由包装器按环境自动注入，不要手写。**
- 真客户端的行为可用 `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --help` 观察；
  headless prompt（`-p`）需要先解决模型选择（见下），不是判断通道可用性的可靠手段。

## 五、反编译取证手法（比 grep 全文快得多）

`app.asar` 有 300+MB，`grep` 全文会跑到超时。用字节偏移定位：

```bash
# 1) 找偏移（LC_ALL=C 避免多字节拖慢）
LC_ALL=C grep -abo -E "关键字|X-Off-Peak-Ticket-ID" <bundle> | head -20
# 2) 按偏移切片（dd/readSync 取窗口），再本地读
node -e "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');const b=Buffer.alloc(4000);fs.readSync(fd,b,0,4000,Number(process.argv[2]));console.log(b.toString('utf8'))" <bundle> <offset>
```

两个 bundle 都要查：`Contents/Resources/app.asar`（Electron 主体）与
`Contents/Resources/glm/zcode.cjs`（内置 agent）。内置 provider 配置在
`Contents/Resources/config/provider/zcode-builtin.json`（含每个 provider 的
`baseUrl` / `access.mode`，是"端点属于哪条通道"的权威来源）。
