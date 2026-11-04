# 模型目录：刷新链细节与取证命令

本文件是 SKILL.md「五、模型目录刷新」的细节与取证手法。

## 拉取链的两个陷阱（留判据防回归）

1. **「假自动更新」**：`ZCodeUpstreamClient.fetchModels` 的 coding 分支若全部 `return this.models`、
   上游 `json.data` 只判断非空随后丢弃，则每小时刷新只证明凭据还活着，名单永远是编译期常量 `FALLBACK_ZCODE_MODELS`。
   规则：**并集 join**——上游给 id、本地给已验证参数（128K / 费率 / 徽章），未收录 id 走 `defaultZCodeModelInfo` 保守默认（200K/32K）。
   > 写这类「采用上游名单」的测试时注意：用例必须用**与编译期常量不同**的本地目录（否则恒等实现也能碰巧通过），并断言顺序与数量。

2. **并集来源选错目录**：`/api/paas/v4/models` 是 BigModel 开放平台 API 的模型目录，不是 Coding Plan 订阅的产品面；
   官方客户端 `zcode-builtin.json` 绑定到 coding-plan provider 的 `builtinModelIds` 才是白名单（+ `builtinProviderModelRules` 绑定的少数模型）。
   越界模型探针可能 200，但订阅内费率/额度语义未验证（可能扣 API 余额而非订阅）——「分组里出现」不是已验证可用的主张。
   规则（`zcode-builtin-catalog.ts`）：读本机 `zcode-builtin.json` 作白名单，`fetchModels` 先取白名单再过滤上游并集**和本地保留行**；
   白名单不可得时回退已注册名单且**不发上游请求**（白名单是闸门，不是事后过滤器）。
   路径口：macOS 标准安装位置 + `ZCODE_BUILTIN_CONFIG` 环境变量覆盖；其余平台不猜路径，一律降级。

## 空名单的第二来源：上游间歇性答空

**判据**：隔离实例 catalog 为 `live/empty` 而直调同端点有 active 活动 + entitlements（余额正常）⇒ 上游偶发答空 plans，不是插件逻辑错。
后果：分组诚实隐藏，但唯一恢复路径是小时刷新，且卡片会同时显示额度与「今日没有有效的 Start Plan 活动」自相矛盾。
规则：sweep 对「目录空 + 领取探测无翻转 + 距上次拉取 ≥5 分钟」再拉一拍（无论结果都前移 `catalogFetchedAtMs`，不会打环）；
文案必须中性，不断言「无活动」。

## 推送链（兼容旧宿主线口径）

**DSH 0.2.2 起**目录变化走公开事件 `ctx.emit('llm/models-updated', provider)`（见 SKILL.md 5.2；声明在 `dsh-llm` 的
`Events`，客户端 `ModelCatalogDirectory` 订阅后直接 `refresh()`，事件在 `dsh-api-remotes` 转发白名单内）。
兼容 **0.2.1 及更早**宿主线时：

- `ctx.llm.registerAdapter([providerId], adapter)` 后事件计数 1，`handle.replace([providerId])` 后变 2。
  **不要另造事件。**
- `replace` 在注册已释放时抛 `LlmError REGISTRATION_DISPOSED`，必须 try/catch 并吞掉：
  `refreshCatalog` 是 fire-and-forget async，异常会被它自己的泛 catch 接住并误判成「上游目录不可用」→
  打警告并对**已到手的新名单再重试 3 次**（不吞不会崩进程，但会产生无谓上游请求）。

## 测试这类改动的四个坑

1. `ctx.llm` 是 cordis Proxy：**直接给 `ctx.llm.registerAdapter` 赋 own property 拦不住**插件内部调用，
   测试会静默变成永远为真的空断言。必须 `Object.defineProperty(Object.getPrototypeOf(ctx.llm), 'registerAdapter', ...)`。
2. 客户端样式只能引用 `test/css-token-whitelist.txt` 里的 `var(--*)`。凭记忆写变量名必挂：
   规范名是 `--dsw-alias-state-warn-primary`（不是 `warning`）、`--dsw-alias-border-l2`（不是 `border-tertiary`）。写新样式前先 grep 白名单。
3. **「单跑绿、全量红」几乎都是跨文件状态污染**，不要当 flake 放过。判据：断言**宿主全局事件**计数时，
   同一 worker 里别的插件实例发布的事件也会计入 → 单跑与全量结果不一致。修法：断言只对本测试自己的实例敏感
   （按 provider 过滤 / 可注入计数器），或修掉真正泄漏的那个文件的清理。**判据：单跑与全量结果不一致 = 隔离 bug，不是运气。**
4. **vitest 不做类型检查**：测试里写错的类型单测照样绿，但 `bun run typecheck` / `bun run test:ci` 会挂。
   交付前必须真跑 `bun run test:ci`（含 build + typecheck + test）。

## 重载窗口的取证命令

DSH 会话是 zstd 压缩的 JSONL：

```bash
zstd -dc ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd | ...
```

看 `llm/retry`（含完整 failure 与 `policyKey`）、`turn/end`（含最终错误）、`step/start/end` 的时间轴即可还原死亡顺序。
`~/.dsh/logs` 只有 startup 日志，别指望它。

判据：会话日志中注册与 live 落盘事件的时间差即目录发布窗口（亚秒级；`primeCatalogForRegistration` 之前约 1s 内）。
可重试集合 `DEFAULT_RETRYABLE_CODES = EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`；`UNKNOWN_MODEL` 与 `NO_ADAPTER` 都不在其中。
pi-ai 层的另一形态 `adapter does not own provider`（簿记错位）本插件不会产生：profiles 静态构造 + replace 复用同一 provider id。
