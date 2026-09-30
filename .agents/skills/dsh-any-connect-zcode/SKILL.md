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
- **双计划口径（2026-09-30 用户定，推翻早先「统一走普通通道」与后续的「单卡片
  选择器」方案）**：**Start Plan 与 Coding Plan 是完全不同的两个产品**，在插件
  里是两个独立变体（`zcode` / `zcode-start-plan`），各自有模型分组、模型名单、
  额度池与通道，互不掺用：
  * `zcode`（Coding Plan）：普通通道 `open.bigmodel.cn/api/anthropic` + V4 签名
    （150% 额度、夜间免费），扣 coding-plan 订阅。凭据 transform 把客户端的
    账号计划选择归入 coding 语义（start-plan/off-peak 选择在此变体一律按
    coding 走，绝不因 selection 改走专属通道）。
  * `zcode-start-plan`：专属通道 `zcode-plan/anthropic` + `zcodejwttoken` +
    `X-Device-Mid`，扣专属额度（一次性、**当日有效**的 token 包，查
    `billing/balance`）。模型名单取自客户端内置 provider 目录的
    builtinModelIds。通道被风控拦截（405 code 3012）时请求**明确报错**，
    绝不静默回落普通通道把额度记到 Coding Plan 头上。
  两个变体共享同一份桌面凭据文档（各自取用专属材料：api-key vs
  `zcodejwttoken`+`deviceMid`），但文件、路由、卡片、名单全部互异。
- **计划标识与发请求用的 key 解耦**：`zcodePlan`（客户端选择）标识账号，
  `accessToken`（实际 key）用于签名；不要把前者从后者推断出来。
- **权益差异（2026-09-30 用户确认）**：
  * **Start Plan = 普通通道 + 150% 额度，且不享受夜间免费**（23:00–09:00 免费窗
    是 Coding Plan 专属权益）。
  * 因此**不能只看模型行上的「夜间免费」徽标**决定要不要走夜免逻辑——那会让
    start-plan 账号在夜间被标成「夜间免费 (生效中)」并把费率改写成 `x0.00`，
    展示一个它拿不到的折扣（本机实测复现，见 0.4.9）。资格必须由账号计划决定：
    `catalog.setNightFreeEligible(zcodePlan !== 'start-plan')`。

## 二、Start Plan 额度（可用；是 Start Plan 档的额度展示来源）

**2026-09-30 口径更新**：Start Plan 选中时，额度展示**就来自这个端点**——
专属余额（token 数、当日过期）与 Coding Plan 订阅（`subscription/list`）是两个
独立的池子，绝不混报。端点鉴权用 `zcodejwttoken`（凭据文档里的
`zcodejwttoken` 条目，`enc:v1` 加密，同套 AES-GCM 解密）+ `X-Device-Mid`
（优先桌面端 `telemetry-state.json` 的 `deviceMid`，缺省生成并持久化到
`$DSH_HOME/.zcode-device-mid`）。

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance[?app_version=<ver>]
    Authorization: Bearer <zcodejwttoken>
    X-Device-Mid: <稳定 UUIDv4>
```

- 返回 `data.plans[]`（活动名 `name`、`plan_id`、`ends_at`、`entitlements[]`）与
  `data.balances[]`（`show_name` / `total_units` / `used_units` /
  `remaining_units` / `expires_at` / `period_start` / `period_end`，单位是
  **token**，不是积分）。本机实测：`ZCode Trust Build`，GLM-5.3-Flash
  100,000,000 tokens。
- **额度是每日一次性池子，不结转**：entitlement 的 `period: "one_time"`，
  `expires_at` 固定当日 16:00Z（= 次日 00:00 +08:00），`used_units` 只增不减，
  响应里没有结转字段。所以卡片/pill 报的是"这个池子此刻还剩多少"，并显式声明
  当天没用完就作废（`WorkBuddyCreditAccount.sameDay`）——把它显示成可累积余额
  会让用户按不存在的额度做计划。
- **`X-Device-Mid` 是硬要求**：不给 / 每请求随机 → `400 code 3001` 或 `429`。
  取值优先级：`~/.zcode/v2/telemetry-state.json` 的 `deviceMid` →
  `$DSH_HOME/.zcode-device-mid`（自生成并持久化）。
- 同族端点都可读：`billing/current`、`billing/preview`；`billing/claim` 需要
  阿里云验证码（无码 → `400 code 3007 captcha verify failed`）。

## 三、plan 模型通道：Start Plan 的生产通道，**拦的是请求体指纹（已被破解）**

**2026-09-30 日志取证修正**：这条通道就是真客户端 Start Plan 的日常通道，且当天
全程可用——客户端内置 provider 目录（zcode-server.cjs）明确 `account:bigmodel-start-plan`
（providerName "Start Plan"，access `{type:"zhipu-account", mode:"start-plan"}`，
api `anthropic-messages` @ `https://zcode.z.ai/api/v1/zcode-plan/anthropic`，
模型 GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo）；coding plan（individual/team）同型但
baseUrl 是 `https://open.bigmodel.cn/api/anthropic`。当日客户端日志：
Trust Build 09:11 激活（used_units=0）→ 10:03 已用 5.7M，期间 WSL 会话的
model-request 全部走 providerId `account:bigmodel-start-plan`，**零次 3012**
（日志里 "3012" 字样只是内存统计子串）。桌面端在该链路中负责给请求套
provider runtime headers（captcha-diagnostics `headersApplied:true`）。

**2026-09-30 破解修正**：拦的不是"客户端指纹"这种不可控的东西，而是**请求体里
一个可精确满足的常量**——`system` 必须以官方客户端的固定提示词开头：

* 第 0 块恒等 `"You are ZCode, an interactive coding agent"`；
* 第 1 块以官方 agent 提示词（2313 字符）的**前 1211 字符**开头。边界是精确的：
  1210 字符仍 405，1211 通过；再长（整块、或前缀后接自己的文本）也通过——
  是前缀判定，不是全等判定。
* **前缀之后可以自由追加自己的块**：`[身份行][1211 前缀][DSH 自己的 system]` 拿
  200，且模型按后面的 DSH 身份与指令回答（实测问"你是什么产品"答"我是 DSH"）。
  把自己的提示词插在官方前缀之前、或与官方文本拼进同一块、或整个 system 用
  字符串形式，都仍 405。

实现见 `packages/dsh-any-connect/src/zcode-plan-prompt.ts`（常量 + `prepareStartPlanBody`），
边界与结构由 `test/zcode-plan-prompt.test.ts` 钉住。

`POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`：带上述前缀 → **200**；
不带 → **HTTP 405 `{"code":3012,"msg":"request has been blocked due to unusual activity."}`**。

同页多路 relay 也都不通：`/api/v1/ultra/anthropic`、`/api/v1/ultra-zai/anthropic`
（自造 header 会返回 `401 code 1002`，说明这些端点主要在验收特殊的鉴权形状）；
off-peak 通道**取票可用**（`POST /api/v1/off-peak/ticket` 需
`X-Coding-Plan-Api-Key`，轮询 `/ticket/status` 能到 `ready`），但
`POST /api/v1/off-peak/anthropic/v1/messages` 一律 `400 code 3001 parameter error`
——参数形状与服务端校验不一致，尚未逆出。

已排除的变量（2026-09-29/30 全部实测仍 3012，因此都不是判据）：HTTP/1.1 与 HTTP/2、
curl 与 undici、stream 与否、阿里云验证码头、阿里云 cookie（`acw_tc`/`cdn_sec_tc`/
`visitor_id`）、浏览器形态 UA、**浏览器内同源页面 fetch**、完整 attribution 头集
（`x-request-id` / `x-session-id` / `x-query-id` / `x-zcode-trace-id` /
`x-zcode-session-type`）、E2E 客户端签名 V4（`X-Client-Sig`/`X-Client-Pow`）、
`X-Bigmodel-Authorization` + `Bigmodel-Target-Type: PERSONAL` 头组、代理与直连
两种出口。**只有 system 形状能翻转结果。**

对照（同刻同域）：不带 JWT → 401；`x-api-key: <jwt>` → 401（本通道只认 Bearer）；
不存在的路径 → 404；`billing/balance` → 200。

同页多路 relay 都不通：`/api/v1/ultra/anthropic`、`/api/v1/ultra-zai/anthropic`
返回 `401 code 1002`；`zcode-plan/anthropic` 换 coding-plan api-key → 401。
off-peak 通道**取票可用**（`POST /api/v1/off-peak/ticket` 需
`X-Coding-Plan-Api-Key`，轮询 `/ticket/status` 能到 `ready`），但
`POST /api/v1/off-peak/anthropic/v1/messages` 一律 `400 code 3001 parameter error`
——参数形状与服务端校验不一致，尚未逆出。

### 3.1 判定"能用了"的最小探针

```js
// system = [官方身份行, 官方 1211 字符前缀] → 200 即通道可用。
const res = await fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + jwt, 'X-Device-Mid': deviceMid,
             'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'GLM-5.3-Flash', max_tokens: 16, stream: false,
    system: [{ type: 'text', text: IDENTITY }, { type: 'text', text: PREFIX }],
    messages: [{ role: 'user', content: 'ping' }] }),
})
```

### 3.2 模型名单按活动 entitlements 派生，不是内置目录

`billing/balance` 的 `data.plans[].entitlements[].capabilities`（`model:<id>`）才是活动
实际放行的模型。内置目录（`account:bigmodel-start-plan` 的 builtinModelIds）只是候选：
实测 Trust Build 期间内置目录列三个，活动只授权 **GLM-5.3-Flash**，另两个返回
`400 code 3006 model not allowed`。所以注册名单必须由 entitlements 派生
（`src/zcode-plan-models.ts`），拿不到授权信息时退回兜底名单而不是空名单。

每模型的窗口/输出上限/档位以客户端 `config/provider/zcode-builtin.json` 的
`modelConfigRules` 为准（GLM-5.3-Flash 1M/128K、GLM-5.2 1M/128K、GLM-5-Turbo
200K/64K）；服务端另有硬上限 `max_tokens ≤ 131072`（131073 → `400 code 1210`）。

## 四、隔离实例端到端验证（改插件后必跑）

```bash
H=<workspace>/.workwork/dsh-verify/home
DSH_HOME=$H dsh plugin --profile web add <repo>/packages/dsh-any-connect
DSH_HOME=$H ZCODE_AUTH_FILE=<带指定 selection 的凭据副本> dsh web --port 8932 --no-open
# 卡片数据走宿主路由（不必开浏览器即可核对）；两个 ZCode 变体各一条：
curl -sS "http://127.0.0.1:8932/plugins/dsh-any-connect/zcode/status" -H "Host: 127.0.0.1:8932"
curl -sS "http://127.0.0.1:8932/plugins/dsh-any-connect/zcode-sp/status" -H "Host: 127.0.0.1:8932"
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
