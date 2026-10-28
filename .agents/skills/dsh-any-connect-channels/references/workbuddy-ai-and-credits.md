# workbuddy-ai 证据链与 WorkBuddy 积分台账

本文件是 SKILL.md「七、workbuddy-ai」与「八、积分台账」的取证细节与实现要点。

## 逐项验证结果（本机，两个 app 都装了）

| 检查 | 命令 | 结果 |
|---|---|---|
| doctor | `node packages/dsh-any-connect/lib/bin.js doctor --provider workbuddy-ai --json` | `present:true, format:"encrypted", signIn:"signed-in"` |
| status（金额） | `... status --provider workbuddy-ai` | `signed in`，Remaining credit **100** |
| 凭据解析 | `new WorkBuddyCredentialStore({variant}).current()` | `domain=www.workbuddy.ai`，accessToken 1374 字符 |
| 模型目录 | `WorkBuddyUpstreamClient.fetchModels(cred)` | **200**，25 个模型（`/v3/config`） |
| 账单 | `client.fetchCredits(cred)` | **200**，total 100 |
| **chat** | `client.chatStream(cred, body)` | **403 `{"code":11140,"msg":"request illegal"}`** |
| 探测 | `client.probeEffort(...)` | 同样 **403/11140** |

对照组：**同 body 走国内变体返回 200**（`copilot.tencent.com/v2/chat/completions`）。所以不是代码构造错误，
是区域/账号侧对 chat 的授权判定。

## 11140 的权威依据（“内容未通过安全审核”是误导性兜底）

提示文案 `displayMsg: "内容未通过安全审核，请调整后重试"` **是误导性兜底**——别照着它去改 prompt。
官方客户端自己的错误码表（反编译取证）：

```js
// app.asar.unpacked/cli/dist/codebuddy-headless.js
new Map([[10105,{category:"quota",subcategory:"quota_active_session"}], ...
         [11140,{category:"auth",subcategory:"auth_forbidden"}],
         [11141,{category:"model_service",subcategory:"model_behavior_error"}],
         [11142,{category:"auth",subcategory:"auth_forbidden"}]])

let t9 = new Set([11140,11141,11142,17271,17272,17273,17274,17275,17276]);
function isAuthRequiredLikeError(L,ei,ea,es){
  return !(...) && (... || 401===ea || 403===ea)   // 403 + t9 命中 → authRequired
}
```

## 已穷尽的排除项（结论：都与 11140 无关）

请求体（只带 user → `400 / 11128 "first message is not system prompt"`，证明海外网关确实要求首条 system，插件注入
`INTERNATIONAL_SYSTEM_PROMPT` 的处理是对的；带 system → 403/11140）、非流式（`stream:false` → `400 / 11101`，
说明流式请求正是被前面的授权关卡拦下）、路径（只有 `/v2/chat/completions` 存在；`/v3/chat/completions`、`/v1/...`、
`/v2/messages`、`/v2/plugin/chat/completions` 全 404）、请求头（逐个/组合试过 `X-Product`、`X-Product-Version`、
`X-IDE-Type/Name/Version`、`X-Agent-Type/Intent/Purpose`、`X-Conversation-ID`、`X-Session-ID`、`X-Request-ID`、`X-Trace-ID`、
`X-Model-ID`、有无 CLI `User-Agent`、有无 `X-Requested-With`）、模型名（官方静态清单里 `agents[cli].models` 是
`fast-model/balanced-model/primary-model/deep-model`，不含 `default-model`；换模型名同样 403）。
**以上全部仍 403/11140，明细不再逐条留档（见 git 历史），结论是"不是缺某个头/某个字段"。**

对照实验（同一端点、同一 body，只换凭据）：不带 Authorization → **401**（网关拒绝，HTML）；`Bearer not-a-real-token` → **401**；
真实凭据（甚至 body 只有一个 `system: "s"`）→ **403 / code 11140**。用“完全无害内容”（只有 system、空 user content）复测仍全部 403/11140
⇒ 与消息内容无关，上游那句“内容未通过安全审核”是泛化兜底文案。

## product.json 权威字段（海外版）

`app.asar.unpacked/cli/product.json`：

- `isOversea: true`，`endpoint: "https://www.workbuddy.ai"`
- `authentication.id: "workbuddy-desktop-ai"`（与插件 variant 的 desktopFilename 同源）、`tokenHeader: "Authorization"`、
  `tokenType: "bearerToken"`、`usernameHeader: "X-User-Id"`
- `attributes.prefixPath: "/plugin"`（官方部分端点形如 `/v2/plugin/auth/state`）
- `externalDomain` 含 `www.workbuddy.ai` / `www.codebuddy.ai` / `staging.workbuddy.ai`
- 会话相关头常量：`X-Trace-ID` / `X-Request-ID` / `X-Conversation-ID` / `X-Session-ID` / `X-Agent-Type` / `X-Agent-Intent` /
  `X-IDE-*` / `X-Api-Key` / `X-Product-Version`

## 未证实的线索（别再当结论）

- `scope` 结构差异：CN 凭据没有 `scope` 字段，AI 凭据是 `scope: "openid profile offline_access email"`（纯 OIDC scope，无 API 权限声明）。
- 海外版可能要求**先激活免费试用/绑定支付方式**才开通 chat。官方前端 bundle 里确实有这套状态机：

```js
// pricing-*.js
Kr = { currentPlan: "free", paidActive: false, trialActive: false, trialEligible: true }
POST /billing/meter/apply-free-trial   // 申请免费试用
POST /billing/meter/get-user-resource  // 返回 accounts 与 proTrialStatus
```

`trialEligible: true` + `trialActive: false` = 有资格但未激活。这两个接口在 `www.workbuddy.ai` 上试过均 404
（应在官方 usercenter 域下，客户端侧无法代调）。

**反模式**：从 `packageName`（如 "Free Plan Subscription"）这类间接字段推断权限结论——曾据此误判「账号是 Free Plan 所以没有 chat 权益」，
但服务端 `/v3/config` 里该模型明写 `credits: "x0.00"`、官方 UI 也标着 "Free now"。权限结论要看权威字段（模型 `credits` 费率、
官方 UI 标识），不要越过证据。

## 插件侧错误文案的回归锁

- 宿主 `dsh-llm-pi-ai` 的 `classifyPiAiError` 用**文本正则**分类：`/(?:401|403)/` 命中即判 `AUTH`，
  `dsh-client-ui-chat` 随后**丢弃我们的 message** 换成固定文案「API 密钥无效」。
- `upstream-shared.httpStatusLabel()`：状态码渲染为 `HTTP_403`。**`HTTP-403` 无效**（`-` 是非词字符，403 两侧仍是 ``，实测照样命中）。
- `shim-http.upstreamFailureMessage()`：失败文案单一构造点，403 前置如实说明（`auth_forbidden`、非密钥失效、非内容审核）再附原文。
- `test/shim-failure-copy.test.ts`：断言任何状态下文案都不触发宿主全部 7 条分类正则，并含反例证明非空转。

## WorkBuddy 积分台账（裂变包机制）

- 实测 `get-user-resource` 返回 33 个包：主体系 `CodeBuddy个人版国内运营裂变包`，上游**每天发一个新包**（每个 100 积分、
  `CycleEndTime` = 发放时刻 +30 天，发放时刻每天不同：00:xx / 09:xx / 12:xx / 20:02 都出现过），旧包到期**整包消失**。
  因此「剩余总额」每天双向跳动（新包 +100、消耗 −N、到期 −整包），单看任何时刻的数字读不出「今天花了多少」。
- 采样差分口径：每次成功拉到积分记 `{时刻, 剩余}`，负差分计消耗、正差分计发放、当日最大剩余即「今日峰值」
  （今日已用 ≈ 峰值 − 当前剩余）。实现在 `src/credit-ledger.ts`。
- 诚实标注三则：①估算（只有 DSH 运行且轮询到查询才有样本，两次采样间「发放+消耗」抵消会被低估，samples 随数据透出）；
  ②跨天首观测不计差分（跨夜窗口的消耗无法归属到哪一天，宁少不虚记）；③只统计积分制变体（kind `workbuddy`），
  ZCode 的 token 池/订阅有效性不是这个语义，绝不混进台账。
- 持久化：`dsh_any_connect` 域新增 `ledger` 表（per-record 布局版本检查按记录进行，加表不用 bump version、不用迁移）；
  域不可用时台账整体缺席，status/pill 降级为「无今日统计」，绝不拖垮读路径（`CreditLedger.record` 契约上从不 reject）。
- 台账 seed/验证技巧：隔离实例的台账可用公开 API 预置样本——`new JsonStorageBackend(<H>/storages)` →
  `kv.open(descriptorOf(anyConnectDomain))` → `unit.putRecord('ledger', 'workbuddy', doc)`，起实例前写入即可验证差分展示。
- 实测消耗粒度：两次相隔 4 分钟的查询 698→693（消耗 5 积分），pill 60s 轮询足以捕捉日常消耗。

## 额度数据归属口径（用户确认）

- provider-usage 是「注册 seam + 通用显示层」，不持有任何 provider 的凭据与计费端点；它自带的 8 个 querier 全是开放 API
  （deepseek/openai/moonshot/bigmodel/minimax/openrouter/siliconflow/opencode，凭据全局可见）。
- **provider 由 dsh-any-connect 提供的（workbuddy / workbuddy-ai / zcode / zcode-start-plan），额度与消耗统计的数据权威就在 dsh-any-connect**：
  桌面加密凭据只有它读得到，`fetchCredits` / billing 端点只有它调得动；provider-usage 只收到 querier 返回的窗口 payload
  按通用 `UsageWindow` 契约渲染，**不得出现 provider 专用代码**（registry 注释原文即点名「dsh-any-connect registers its own querier」是预期路径）。
- 消耗台账因此落在 dsh-any-connect 而不是 provider-usage：采样源（pill querier + 卡片 status 两路）也在它这里。
  把台账放进 provider-usage 的「通用采样差分」是**有意不做**的方向（采样只覆盖当前会话 provider 且依赖 pill 挂载可见；
  不装 provider-usage 时卡片/CLI 统计会失效；裂变包正负差分语义是 WorkBuddy 特有口径）——等出现真实需求再议，不要提前抽象。
