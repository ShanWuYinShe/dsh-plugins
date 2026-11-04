# 限流观测：维度、恢复时刻与展示（现行口径）

本文件是 SKILL.md「额度展示」与 `rate-limit.ts` 的取证细节：上游到底按什么维度限流、
恢复时刻从哪里读、以及界面必须怎么呈现。改动限流相关代码前先读这一份。

## WorkBuddy / WorkBuddy AI：按模型限流，不是整个 provider

- 限流错误信封 `bizCode === 6004`（官方客户端 `isConversationRateLimitCapError` 同时认
  `terminal.bizCode` 与 `code` 两种序列化）。
- cap-hit 状态**以 modelId 为键**落盘：官方客户端 `markCapHit(accountKey, modelId, resetAt)`
  写入 `{[modelId]: {resetAt, optedIn}}` 形状的 account bucket，并按模型弹不同的
  「或换其它模型」文案。因此 **A 模型被限时 B 模型仍可用**，插件台账不能按 provider 一行合并。
- 错误文案原文带恢复时刻并有「switch to the other models」提示，说明上游自己就把限流
  当成单模型事件。
- 恢复时刻的来源：官方客户端把 `terminal.details`、`terminal.message` 与 `message`
  拼成一段文本，再从**文本里**搜时刻（不是独立的结构化字段）。

### 官方客户端的解析口径（务必对齐）

在 `WorkBuddy.app/Contents/Resources/app.asar` 的渲染层 bundle 里：

```js
SNt = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*(?:UTC\+8|\(UTC\+8\)))?/
function parseResetAt(e) {
  const t = SNt.exec(e); if (!t) return;
  // 省略时区后缀时直接按 UTC+8（上海壁钟）反解：
  return Date.UTC(year, month-1, day, hour-8, minute, second)
}
```

要点：**时区后缀是可选的**；缺失即 UTC+8。插件 `parseResetMessage` 采用同一口径，
并额外容忍 `UTC+08:00`、ISO 偏移（`+08:00`）、中文文案（`将于 … 后恢复`）——
它们都只是同一时刻的不同写法。正文出现多个时刻时按「离 reset/重置/恢复 最近」消歧；
都没有关键词就取最靠前的（与官方客户端「先命中先用」一致）。

### 响应样本（中文正文）

```json
{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-11-04 09:46:40 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"<requestId>"}
```

要点：正文是中文、时刻在中文句式中间（`将在 … UTC+8 重置`），**没有**英文 `reset at`。
任何依赖英文前缀的解析都会漏掉它——`parseResetMessage` 只认时间戳本身 + 可选时区后缀，
因此中文正文、英文正文、纯时间戳三种写法都能读；本例解析结果与样例时刻一致（+08:00 时区）。
另外 `您也可以切换其他模型继续使用` 再次印证「按模型限流」。

### 取证命令（不依赖具体文件 hash）

asar 里的文件表是可解析的（`[8B pickle][4B headerSize][header JSON]`，文件内容不压缩），
用 node 遍历文件表、按字符串搜索即可；换版本后文件 hash 变了也不影响：

```bash
# 搜模板文案（i18n 文件）与解析器（渲染层 bundle）
grep -a -m2 "usage will reset at" /Applications/WorkBuddy.app/Contents/Resources/app.asar
grep -a -m2 "isConversationRateLimitCapError" /Applications/WorkBuddy.app/Contents/Resources/app.asar
```

需要看上下文时按 asar 文件表取出命中文件（`.agents/worktrees/<branch>/.workwork/` 下可写临时脚本，
不要提交）。`WorkBuddy AI.app` 是独立 bundle，口径按同一方式核对。

## 插件侧的实现边界（`rate-limit.ts`）

- 台账键 = `provider + model`；模型未知时才是 provider 级一行（`ledgerKey`）。
  卡片用 `activesFor(provider)` 逐模型展示；pill 这类 provider 级表面用 `activeFor(provider)`
  取最近一次活跃观测。
- **成功只清对应模型**：`clear(provider, model)`。上游按模型限流，B 模型成功不能拿来
  清 A 的观测（否则卡片会把仍在限流的 A 误报成已恢复）；顺带清掉「模型未知」的
  provider 级观测。
- **只观测、不拦截**：没有任何请求门禁读取台账；`shim-rate-limit.test.ts` 有
  「A 模型被限时 B 模型请求照常发往上游」的回归。界面文案也明确写「插件不拦截请求」。
- 恢复时刻来源优先级：响应头（`Retry-After` / `X-RateLimit-Reset`）优先，其次正文
  （`parseResetMessage`）。正文路径只在 429/soft_rate 上下文调用，因此「正文里的时刻
  就是恢复时刻」这个前提才成立——不要把它挪到通用错误文案解析里。
- 展示：配置页卡片一个模型一个框（`rateLimitMeta` 里带模型名）；额度 pill 折叠态
  头行带模型名（`限流中 · 20:00 恢复 · glm-5.3`），避免把单模型限流误读成整条通道不可用。

## 回归命令

```bash
cd .agents/worktrees/alpha
bunx vitest run \
  packages/dsh-any-connect/test/rate-limit.test.ts \
  packages/dsh-any-connect/test/shim-rate-limit.test.ts \
  packages/dsh-any-connect/test/rate-limit-box.test.ts \
  packages/provider-usage/test/pill-rate-limit.test.ts \
  packages/provider-usage/test/pill-rate-limit-render.test.ts
```
