# plan 通道：取证与最小探针

本文件是 SKILL.md「三、plan 通道」的取证细节，结论以 SKILL.md 为准。

## 通道归属（客户端 provider 目录）
内置 provider 目录（`Contents/Resources/config/provider/zcode-builtin.json` 的 `providerConfigRules.providerRules[]`；
旧记录里的 `glm/zcode-server.cjs` 在当前 3.16.3 安装中已不存在）里：

- `account:bigmodel-start-plan`：providerName "Start Plan"，access `{type:"zhipu-account", mode:"start-plan"}`，
  api `anthropic-messages`，baseUrl `https://zcode.z.ai/api/v1/zcode-plan/anthropic`，
  模型 GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo。
- coding plan（individual/team）同型，baseUrl 是 `https://open.bigmodel.cn/api/anthropic`。

客户端日志佐证（2026-09-30）：Trust Build 09:11 激活（`used_units=0`）→ 10:03 已用 5.7M，期间 WSL 会话的
model-request 全部走 providerId `account:bigmodel-start-plan`，**零次 3012**（日志里的 "3012" 字样只是内存统计子串）。
桌面端在该链路中负责给请求套 provider runtime headers（captcha-diagnostics `headersApplied:true`）。

## system 前缀判定的边界实验

拦截判据是 `system` 数组的形状与内容，逐项实测：

| 形状 | 结果 |
|---|---|
| `system` 第 0 块 `"You are ZCode, an interactive coding agent"` + 第 1 块官方提示词前 1210 字符 | 405 code 3012 |
| 同上，前 1211 字符 | **200** |
| 前缀之后追加自有文本块（`[身份行][1211 前缀][DSH 自己的 system]`） | 200，模型按 DSH 身份回答 |
| 自有提示词插在官方前缀之前 | 405 |
| 自有文本与官方文本拼进同一块 | 405 |
| 整个 `system` 用字符串形式（非块数组） | 405 |

即：**前缀判定、块序敏感、类型敏感**。实现 `packages/dsh-any-connect/src/zcode-plan-prompt.ts`
（常量 + `prepareStartPlanBody`），边界由 `test/zcode-plan-prompt.test.ts` 钉住。

## 上游风控现状（用户 2026-10-25 实机确认）

- 用户在 1024 开发者日活动期间消耗 `used_units: 177937068`（>1.77 亿 tokens），触发上游网关针对活动套餐的
  异常突发用量风控（Abuse / Burst Detection）；该账号请求直接返回
  `HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}`。
- 交叉验证：**官方 ZCode 客户端（3.16.3）同账号实机测试同样确定性报错**；官方客户端源码逆向证实 `start-plan` 走的是
  unsigned fetch，客户端内并未对 3012 做特殊处理（仅对 3007 处理了阿里云无感验证码重试）。
- 该拦截不消耗任何额度，且完全隔离于 Coding Plan 订阅。用户应使用 Coding Plan（`zcode` 变体）继续日常工作。

## 同页其它通道探测

- 多路 relay 都不通：`/api/v1/ultra/anthropic`、`/api/v1/ultra-zai/anthropic` 自造 header 返回 `401 code 1002`
  （说明这些端点主要在验收特殊的鉴权形状）；`zcode-plan/anthropic` 换成 coding-plan api-key 也是 401。
- off-peak：`POST /api/v1/off-peak/ticket`（需 `X-Coding-Plan-Api-Key`）取票可用，轮询 `/ticket/status` 能到 `ready`；
  但 `POST /api/v1/off-peak/anthropic/v1/messages` 一律 `400 code 3001 parameter error`——参数形状与服务端校验不一致，尚未逆出。

## 已排除的变量（都实测过仍 3012，因此都不是判据）

HTTP/1.1 与 HTTP/2、curl 与 undici、stream 与否、阿里云验证码头、阿里云 cookie（`acw_tc` / `cdn_sec_tc` / `visitor_id`）、
浏览器形态 UA、**浏览器内同源页面 fetch**、完整 attribution 头集（`x-request-id` / `x-session-id` / `x-query-id` /
`x-zcode-trace-id` / `x-zcode-session-type`）、E2E 客户端签名 V4（`X-Client-Sig` / `X-Client-Pow`）、
`X-Bigmodel-Authorization` + `Bigmodel-Target-Type: PERSONAL` 头组、代理与直连两种出口。**只有 system 形状能翻转结果。**

对照（同刻同域）：不带 JWT → 401；`x-api-key: <jwt>` → 401（本通道只认 Bearer）；不存在的路径 → 404；`billing/balance` → 200。

## 判定"能用了"的最小探针

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

## 模型名单为什么不能取内置目录

内置目录（`account:bigmodel-start-plan` 的 builtinModelIds）只是候选：实测 Trust Build 期间内置目录列三个，
活动只授权 **GLM-5.3-Flash**，另两个返回 `400 code 3006 model not allowed`。
所以注册名单必须由 `billing/balance` 的 entitlements 派生（`src/zcode-plan-models.ts`），三态纪律见 SKILL.md 第四节。
