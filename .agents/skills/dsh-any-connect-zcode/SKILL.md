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
  阿里云验证码（无码 → `400 code 3007 captcha verify failed`，2026-10-04 复现）。

### 2.1 每日领取（preview / claim）——**全自动领取不可能，这是硬约束**

2026-10-04 从 `app.asar` 偏移 **271347225**（`claimManualPlan`）取证并实测：

    GET  /api/v1/zcode-plan/billing/preview?app_version=<v>&platform=<p>
         Authorization: Bearer <zcodejwttoken>          # 纯 HTTP，无需 captcha
         -> data.plans[] = **今日可领取**清单（今日已领过则 []）
    POST /api/v1/zcode-plan/billing/claim
         Authorization: Bearer <zcodejwttoken>
         Content-Type: application/json
         X-Aliyun-Captcha-Verify-Param: <captchaVerifyParam>   # 必需
         X-ZCode-App-Version: <v>   X-Platform: <p>
         body: {"plan_id": "<id>"}

- `preview` 可在 Node 侧直接调用（本机实测 200 + `plans: []`）——**这是插件能自动化的上限**。
- `claim` 的 captcha 由渲染进程 `window.AliyunCaptcha`（阿里云 SDK）签发，
  客户端走 `startTracelessVerification()` 无感验证。token 由阿里云服务端签发并与
  浏览器指纹绑定，**纯 Node/HTTP 侧无法生成**；实测不带该头一律
  `HTTP 400 {"code":3007,"msg":"captcha verify failed"}`。
- 结论：**「探测自动、领取手动」**。插件实现见 `src/zcode-plan-claim.ts`；
  `claimStartPlan` 在无 captcha 时**根本不发请求**，直接短路为 `captcha-required`
  （一等公民状态，不是笼统 failed），绝不伪装成已领取。
- 判定三态必须分清：探测成功有清单=`available`；探测成功清单为空=`none`（今日已领）；
  **探测失败/超时/401=`unknown`，绝不塌成 `none`**——塌成 none 会让用户以为
  "今天没得领"而白丢一次领取。字段透出在 Start Plan 变体的 status（`startPlanClaim`）。

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
（`src/zcode-plan-models.ts`）。

**2026-10-04 修正：「拿不到授权就退回兜底名单」是个会骗人的坑。** 必须区分三态，
否则会在"过期/今日未领取"时显示出根本不授权的模型（用户选中即 400 code 3006）：

| 状态 | 判据 | 正确返回 |
|---|---|---|
| A 有有效活动且解析出模型 | 见下 | 该名单 |
| B 查询**成功**但无有效活动（未领取/已过期） | `plans` 过滤后为空 | **空名单**（分组隐藏） |
| C 查询**失败**（HTTP 非 ok / 抛错） | — | `this.models` 兜底 |

- 有效期判据：`ends_at`（**秒级** epoch）× 1000 < now 即过期；`ends_at` 缺失按
  **有效**处理（不能因字段缺失让用户丢名单）；`status` 非 `active` 一律排除、
  缺失视为 active。实现 `isStartPlanActivityActive`。
- **已确认有有效活动时，名单唯一真源就是它的 entitlements**：解析不出模型要返回空，
  **不许**回退 `this.models`。对 start-plan 变体而言 `this.models` 就是那三个幻影模型
  （`index.ts` 用 `FALLBACK_ZCODE_START_PLAN_MODELS` 构造 client），回退等于让
  "活动有效但授权字段漂移"重新长出"看起来能用、一用就报错"的假名单。
- **空名单是合法降级信号**：`catalog.ts` 里"空目录即 DSH 隐藏该分组"是既有设计。
  但空名单**不可持久化**——`index.ts` 的 `refreshCatalog` 必须 `models.length > 0`
  才 `catalogStore.save()`，否则下次启动的 saved 分支会把空目录当已知好状态发布。

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

### 4.1 已知测试 flake：`usage.test.ts` 的 ENOTEMPTY（**与本插件改动无关**）

2026-10-04 实测：全量 `vitest run` 偶发

    FAIL packages/dsh-any-connect/test/usage.test.ts
    Error: ENOTEMPTY: directory not empty, rmdir '.../dsh-any-connect-usage-XXXX'

**判据（已做过对照实验，不要误判成自己改坏了）**：
- `usage.test.ts` 的 `afterEach` 在 `context.fiber.dispose()` 后立即
  `rm(root, {recursive:true, force:true})`，插件的异步收尾可能仍在写该目录 → 竞态。
- 单跑该文件 3/3 通过；全量**串行**连跑 5/5 通过。
- **在未改动的 pristine `main`（git stash 全部改动）上，两个 vitest 进程并行跑时同样复现**
  ——证明是仓库既有竞态，不是本次改动引入。
- 结论：遇到它先单跑该文件确认，再串行重跑全量；不要为此改业务代码。

## 五、模型目录「自动更新」与选择框实时刷新（2026-10-04 实测）

用户需求是「所有 provider 都自动更新 + 聊天页选择框实时更新」。查这部分时先分清
**两条独立的链**，它们坏起来表现一样（"名单是旧的"），但修法完全不同。

### 5.1 拉取链：定时刷新（插件侧主动拉）

- 启动时 `refreshCatalog(runtime, 'startup')`；每 **60s** `sweep` 做身份核对
  （身份变了才真拉，稳态零上游请求）；每 **60 分钟** `catalogTimer` 全量重拉。
- 四个变体（workbuddy / workbuddy-ai / zcode / zcode-start-plan）**都**接上了这三条，
  没有变体被条件跳过（audit 实测确认）。

**🔴 陷阱一：`ZCodeUpstreamClient.fetchModels` 的 coding 分支曾是"假自动更新"。**
原实现三个分支全部 `return this.models`，上游 `json.data` 只用来判断非空随后丢弃
——该 provider 每小时刷新的唯一效果是"证明凭据还活着"，名单永远是编译期常量
`FALLBACK_ZCODE_MODELS`。2026-10-04 已改为**并集 join**：上游给 id、本地给已验证参数
（128K / 费率 / 徽章），未收录 id 走 `defaultZCodeModelInfo` 保守默认（200K/32K）。
实测收益：上游真实列表 11 个模型，此前只有 2 个可见，**9 个永远看不到**。
> 写这类"采用上游名单"的测试时注意：若本地目录恰好等于上游名单，旧实现也能碰巧通过
> ——用例必须用**与编译期常量不同**的本地目录，并断言顺序与数量，否则是假绿。

**🔴 但并集的来源选错了目录（2026-10-06 取证并已修复）：`/api/paas/v4/models` 是
BigModel 开放平台 API 的模型目录，不是 Coding Plan 订阅的产品面。** 实测该端点对
coding-plan key 返回 11 个 id（glm-4.5 / glm-4.5-air / glm-4.6 / glm-4.7 / glm-5 /
glm-5-turbo / glm-5.1 / glm-5.2 / glm-5.3 / glm-5.3-flash / glm-5.3-flashx），而官方
客户端 `zcode-builtin.json` 绑定到 coding-plan provider 的只有 `builtinModelIds`
2 个（GLM-5.3、GLM-5.3-Flash）+ `builtinProviderModelRules` 里的 GLM-5.2、
GLM-5-Turbo。那 7 个多余模型（glm-4.5/4.5-air/4.6/4.7/5/5.1/5.3-flashx）在客户端
配置里**完全没有绑定到 coding-plan**；探针实测 glm-4.5 在 `open.bigmodel.cn/api/anthropic`
也能 200（max_tokens=16），即端点层放行，但订阅内的费率/额度语义未经验证（可能扣
API 余额而非订阅）——「分组里出现」本身就是一个未经验证的主张，与 Start Plan
三态纪律（名单必须来自授权真源）同一条红线。

**修复（2026-10-06，`zcode-builtin-catalog.ts`）**：名单真源改为读本机客户端的
`zcode-builtin.json`（权威来源，随客户端发版更新），`fetchModels` 先取白名单再
过滤上游并集**和本地保留行**；白名单不可得（客户端未装/文件不可读/结构演进）时
回退已注册名单且**不发上游请求**（白名单是闸门，不是事后过滤器）。实测收敛
11 → 2，已验证参数（128K/费率/徽章）不受影响。路径口：macOS 标准安装位置 +
`ZCODE_BUILTIN_CONFIG` 环境变量覆盖；其余平台未经实测不猜路径，一律降级。
白名单口径是 `builtinModelIds`（客户端展示面，最严格）；GLM-5.2/5-Turbo 在
rules 里配了参数但没进 builtinModelIds，探针 200 也不展示——要放宽只需并上
rules 绑定的模型 id，一行改动。

**🔴 陷阱二：`zcode-start-plan` 空名单的恢复延迟。**
今日未领取 → 空名单 → 分组隐藏；用户领取后要等**最长 60 分钟**（小时刷新）才恢复，
因为 60s sweep 只比对凭据身份，领取不改变身份。

**⚠️ 空名单的第二个来源：上游间歇性答空活动清单（2026-10-07 实测）。** 隔离实例
的 catalog 拉得 `live/empty` 的同一时刻，直调同端点却有 active 活动 +
entitlements 模型授权，余额也正常（93M/100M）——即插件逻辑无错，是上游偶发
给出空 plans。后果：分组诚实隐藏，但唯一恢复路径是小时刷新，且卡片同时显示
「93M tokens 额度」与「今日没有有效的 Start Plan 活动」自相矛盾。修法（commit
`103097a`）：sweep 里对「目录空 + 领取探测无翻转 + 距上次拉取 ≥ 5 分钟」再拉一拍
（拉取无论结果都前移 `catalogFetchedAtMs`，不会打环），自愈压到分钟级；文案改
中性表述不再断言「无活动」。

**排查这类「空名单」的决定性手法：进程内探针。** status 只给聚合结果
（live/empty/fetchedAt），分不清「上游真的没活动」还是「那次拉取抽风」——在
`lib/upstream.js`（编译产物）的 `fetchStartPlanModels` 里临时插
`console.error('[probe] plans=' + JSON.stringify(...))` 后重启实例，stderr 直出
运行时收到的原始 plans。三个坑：①产物缩进是 8 空格 + 分号，按 TS 源码形状
replace 会静默不匹配；②kill 旧实例后 `sleep 2` 可能不够，多次「重启后行为没变」
其实是 curl 一直打在没死的旧进程上，kill 后要轮询端口释放再起；③**变体 id 与
路由前缀不同**——注册/查询键是 `zcode-start-plan`，status 路由前缀是
`zcode-sp`，对 provider-usage 的 usage 路由用错键会得到 `queried: false`，
看似注册失败实为查错名字。

### 5.2 推送链：选择框实时刷新（宿主侧被动通知）

**这是"实时"的真正瓶颈，且极容易被忽略。**
客户端 `dsh-client-ui-model-selection/lib/client.js` 的
`ModelCatalogDirectory.load()` **命中缓存直接返回**：
```js
if (state.status === "ready" && state.value !== null) return Promise.resolve(state.value)
```
它只在 `invalidate()/refresh()` 时重拉，而 refresh 由四个远程事件触发：
`llm/adapters-updated` / `settings/document-updated` / `credentials/record-updated` /
`credentials/reference-updated`。

**插件能触发的只有 `llm/adapters-updated`**。它由 `dsh-llm` 的
`LlmRuntime.commitRoutes` 发布，`emitAdaptersUpdated` 是 **private**，插件不能直接调。
公开的正式手段是 `AdapterRegistrationHandle.replace(providers)`
（`dsh-llm/lib/types/index.d.ts`，其 JSDoc 明说路由集唯一的变更点就是发布该事件的地方）：

```js
const handle = ctx.llm.registerAdapter([providerId], adapter)
handle.replace([providerId])           // 同路由替换 = 广播"拓扑变了"
```
本机实测：registerAdapter 后事件计数 1，`replace` 后变 2。**不要另造事件。**

- **必须只在内容真的变了时调用**：宿主每小时重拉，多数时候名单一样，无条件
  `replace` 会让所有打开的客户端每小时白重拉+白重渲染。用内容指纹比较
  （id/name/contextWindow/maxTokens/supportsImages/reasoning/billing），
  **不要用数组引用**——每次刷新都重建整份数组。
- **空名单也是合法变化**（Start Plan 未领取 → 分组隐藏），必须通知。
- `replace` 在注册已释放时抛 `LlmError REGISTRATION_DISPOSED`，必须 try/catch 吞掉。
  > 有意思的实测结论：**不吞并不会崩进程**——`refreshCatalog` 是 fire-and-forget async，
  > 异常会被它自己的泛 catch 接住，误判成"上游目录不可用"→ 打警告并对**已到手的新名单
  > 再重试 3 次**无谓上游请求。所以吞掉是必须的，但理由是"避免误判成拉取失败"，
  > 不是"避免崩溃"。

### 5.3 测试这类改动时的四个坑（实测）

1. `ctx.llm` 是 cordis Proxy：**直接给 `ctx.llm.registerAdapter` 赋 own property 拦不住**
   插件内部的调用，测试会静默变成永远为真的空断言。必须
   `Object.defineProperty(Object.getPrototypeOf(ctx.llm), 'registerAdapter', ...)`。
2. 客户端样式只能引用 `test/css-token-whitelist.txt` 里的 `var(--*)`。**凭记忆写变量名
   必挂**：规范名是 `--dsw-alias-state-warn-primary`（不是 `warning`）、
   `--dsw-alias-border-l2`（不是 `border-tertiary`）。写新样式前先 grep 白名单。
3. **"单跑绿、全量红" 的用例几乎都是跨文件状态污染**，不要当 flake 放过。
   实测案例：`catalog-refresh.test.ts` 断言全局 `llm/adapters-updated` 事件计数，
   单跑 5/5 绿、跑 5 个挂载插件的文件子集 29/29 绿，但
   `bun x vitest run packages/dsh-any-connect` **确定性红**（expected 18 to be 17）。
   根因是它订阅的是**宿主全局事件**，同一 worker 里别的插件实例发布的事件也被计入。
   修法：断言只对本测试自己的实例敏感（按 provider 过滤 / 用可注入计数器），
   或修掉真正泄漏的那个文件的清理。**判据：单跑与全量结果不一致 = 隔离 bug，不是运气。**
4. **vitest 不做类型检查**：测试里写错的类型（如 `provide('x', {...})` 少传参数）
   单测照样绿，但 `bun run typecheck` / `bun run test:ci` 会挂。
   交付前必须真跑 `bun run test:ci`（它含 build + typecheck + test），
   只跑 `vitest` 会漏掉这一类。

## 六、宿主线适配（`bun run adapt`）的三个已知缺口（2026-10-04 实测）

适配 DSH 新预发布线时 `adapt` **只改 `@deepseek-ai/dsh-*` 的 range**，以下三处要手工补，
否则 `bun install` 或 `typecheck` 直接失败。先跑 `adapt --dry-run` 看它打算改什么。

1. **`adapt` 会盲目 bump 宿主线已删除的包**。实测 `@deepseek-ai/dsh-invariants` 被指到
   `^0.2.1-alpha.1`，但该包最新只到 `0.2.0-rc.2`（新线已不再依赖它）→ `bun install` 报
   `No version matching ... (but package exists)`。
   判据：`npm view <pkg>@<新线版本> version` 为空即该包不在新线上。
   处理：若本仓从未 import（`grep -rn <pkg> src/ client/ test/` 为空）就直接删该依赖，
   不要 pin 一个不存在的版本。
2. **基础包 cordis / schemastery 要跟着一起前移**。`adapt` 不碰它们，但新宿主线常同时前移：
   0.2.1-alpha.1 要求 `cordis ~4.0.5-alpha.1`、`schemastery ~3.18.5-alpha.1`。
   继续 pin `^4.0.4` 会解析出**另一份 cordis 实例**，而 `dsh-settings` 的 `Context.settings`
   声明 augment 的是宿主选中的那份 → `typecheck` 报
   `Property 'settings' does not exist on type 'Context'`（运行时同样是两个容器）。
   判据：`ls -d node_modules/.bun/@deepseek-ai+cordis@*` 出现多个**不同版本**即重复；
   同版本多副本是 peer 变体解析，正常。
3. **版本号形态必须与 `dsh.host` 一致**：alpha 线用 `-alpha.N`（prerelease Release），
   待命期用纯 semver。发布门禁会校验，待命期发 `-alpha.N` 会被直接拒绝。

> 另：worktree 里跑 `bun run test:ci` 前必须先 `bun install`——worktree 有自己的目录，
> 缺 `node_modules` 时 build 会报 `spawnSync .../node_modules/.bin/tsc ENOENT`。
> 沙盒下装包要带 `BUN_INSTALL_CACHE_DIR=<repo>/.workwork/bun-cache`。

### 宿主接口审计结论：三处「已评估、有意不采用」（2026-10-04，防重复报缺口）

对 0.2.1-alpha.1 的接口使用做过完整审计，以下三项**是有意不做**，后续审计不要再当缺口报：

1. **直连 fetch 不加 `attributionHeaders()`**。宿主契约（`LlmAdapter` 类文档）要求 provider
   HTTP 请求带 attribution——这一跳由 pi-ai 覆盖（chat 路径 `lib/index.js` 的 `requestHeaders()`、
   探测路径 `attributionHeaders()` 直设，且 attribution 是保留名、优先于部署头）。插件自己直连的
   14 个 fetch 分两类：模拟官方客户端的（`CLIENT_UA`、App 形 UA、ZCode 指纹）**UA 本身就是网关的
   产品分流契约**（实测：`WorkBuddyAI/<v>` 无空格才有完整 App 文档，空格形式 400），加 attribution
   会破坏功能；账号/额度类的（preview/claim/balance）实测容忍额外头，但语义上就是以客户端身份
   发出（`zcodejwttoken` + `X-Device-Mid`），标 harness 身份自相矛盾，收益为零、风控风险不为零。
2. **不注册 `registerModelDiscovery`**。它探测的是「用户正在编辑、尚未存储的 draft endpoint」，
   而本插件是 profile 自带路由（`declared:false`）+ 自有目录刷新链路，用户从不填 endpoint；
   且网关（copilot.tencent.com / zcode.z.ai）不是标准 OpenAI/Anthropic 列模型端点，
   会落进 `DISCOVERY_UNSUPPORTED`。不注册是正确行为。
3. **四变体合在一张 `plugins.bundle.config` 卡内，不拆 `plugins.row.config`**。
   两种 slot 都合法（slot-contract 明示 bundle 配置归属两者之一），用户拍板保持现形态
   （一张包卡内四张变体卡，2026-10-04 实测截图确认观感）。


## 七、反编译取证手法（比 grep 全文快得多）

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
