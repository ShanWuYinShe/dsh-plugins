# 模型目录：刷新链细节与取证命令

本文件是 SKILL.md「五、模型目录刷新」的细节与取证手法。

## 拉取链的两个历史陷阱（结论已修，留判据防回归）

1. **「假自动更新」**：`ZCodeUpstreamClient.fetchModels` 的 coding 分支曾三个分支全部 `return this.models`，
   上游 `json.data` 只判断非空随后丢弃——每小时刷新的唯一效果是"证明凭据还活着"，名单永远是编译期常量 `FALLBACK_ZCODE_MODELS`。
   现改为**并集 join**：上游给 id、本地给已验证参数（128K / 费率 / 徽章），未收录 id 走 `defaultZCodeModelInfo` 保守默认（200K/32K）。
   实测收益：上游真实列表 11 个模型，此前只有 2 个可见，**9 个永远看不到**。
   > 写这类「采用上游名单」的测试时注意：若本地目录恰好等于上游名单，旧实现也能碰巧通过——用例必须用**与编译期常量不同**的本地目录，
   > 并断言顺序与数量，否则是假绿。

2. **并集来源选错目录**：`/api/paas/v4/models` 是 BigModel 开放平台 API 的模型目录，不是 Coding Plan 订阅的产品面。
   实测该端点对 coding-plan key 返回 11 个 id（glm-4.5 / 4.5-air / 4.6 / 4.7 / 5 / 5-turbo / 5.1 / 5.2 / 5.3 / 5.3-flash / 5.3-flashx），
   而官方客户端 `zcode-builtin.json` 绑定到 coding-plan provider 的只有 `builtinModelIds` 2 个（GLM-5.3、GLM-5.3-Flash）
   + `builtinProviderModelRules` 里的 GLM-5.2、GLM-5-Turbo。7 个多余模型在客户端配置里完全没有绑定；探针实测 glm-4.5 也能 200，
   但订阅内的费率/额度语义未经验证（可能扣 API 余额而非订阅）——「分组里出现」本身就是一个未经验证的主张。
   修复（`zcode-builtin-catalog.ts`）：读本机 `zcode-builtin.json` 作白名单，`fetchModels` 先取白名单再过滤上游并集**和本地保留行**；
   白名单不可得时回退已注册名单且**不发上游请求**（白名单是闸门，不是事后过滤器）。实测收敛 11 → 2，已验证参数不受影响。
   路径口：macOS 标准安装位置 + `ZCODE_BUILTIN_CONFIG` 环境变量覆盖；其余平台未经实测不猜路径，一律降级。

## 空名单的第二来源：上游间歇性答空

隔离实例的 catalog 拉得 `live/empty` 的同一时刻，直调同端点却有 active 活动 + entitlements 模型授权，余额也正常（93M/100M）——
插件逻辑无错，是上游偶发给出空 plans。后果：分组诚实隐藏，但唯一恢复路径是小时刷新，且卡片同时显示「93M tokens 额度」
与「今日没有有效的 Start Plan 活动」自相矛盾。修法：sweep 里对「目录空 + 领取探测无翻转 + 距上次拉取 ≥5 分钟」再拉一拍
（拉取无论结果都前移 `catalogFetchedAtMs`，不会打环），自愈压到分钟级；文案改中性表述，不再断言「无活动」。

## 推送链实测

**DSH 0.2.2 起**目录变化走公开事件 `ctx.emit('llm/models-updated', provider)`（见 SKILL.md 5.2；声明在 `dsh-llm` 的
`Events`，客户端 `ModelCatalogDirectory` 订阅后直接 `refresh()`，事件在 `dsh-api-remotes` 转发白名单内）。
下列实测是 **0.2.1 及更早**的旧口径：

- `ctx.llm.registerAdapter([providerId], adapter)` 后事件计数 1，`handle.replace([providerId])` 后变 2。
  **不要另造事件。**
- `replace` 在注册已释放时抛 `LlmError REGISTRATION_DISPOSED`，必须 try/catch。
  > 实测结论：**不吞并不会崩进程**——`refreshCatalog` 是 fire-and-forget async，异常会被它自己的泛 catch 接住，
  > 误判成"上游目录不可用"→ 打警告并对**已到手的新名单再重试 3 次**无谓上游请求。所以吞掉是必须的，
  > 但理由是"避免误判成拉取失败"，不是"避免崩溃"。

## 测试这类改动的四个坑

1. `ctx.llm` 是 cordis Proxy：**直接给 `ctx.llm.registerAdapter` 赋 own property 拦不住**插件内部调用，
   测试会静默变成永远为真的空断言。必须 `Object.defineProperty(Object.getPrototypeOf(ctx.llm), 'registerAdapter', ...)`。
2. 客户端样式只能引用 `test/css-token-whitelist.txt` 里的 `var(--*)`。凭记忆写变量名必挂：
   规范名是 `--dsw-alias-state-warn-primary`（不是 `warning`）、`--dsw-alias-border-l2`（不是 `border-tertiary`）。写新样式前先 grep 白名单。
3. **「单跑绿、全量红」几乎都是跨文件状态污染**，不要当 flake 放过。实测案例：`catalog-refresh.test.ts` 断言全局
   `llm/adapters-updated` 事件计数，单跑 5/5 绿、跑 5 个挂载插件的文件子集 29/29 绿，但
   `bun x vitest run packages/dsh-any-connect` **确定性红**（expected 18 to be 17）——根因是它订阅的是**宿主全局事件**，
   同一 worker 里别的插件实例发布的事件也被计入。修法：断言只对本测试自己的实例敏感（按 provider 过滤 / 可注入计数器），
   或修掉真正泄漏的那个文件的清理。**判据：单跑与全量结果不一致 = 隔离 bug，不是运气。**
4. **vitest 不做类型检查**：测试里写错的类型单测照样绿，但 `bun run typecheck` / `bun run test:ci` 会挂。
   交付前必须真跑 `bun run test:ci`（含 build + typecheck + test）。

## 重载窗口的取证命令

DSH 会话是 zstd 压缩的 JSONL：

```bash
zstd -dc ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd | ...
```

看 `llm/retry`（含完整 failure 与 `policyKey`）、`turn/end`（含最终错误）、`step/start/end` 的时间轴即可还原死亡顺序。
`~/.dsh/logs` 只有 startup 日志，别指望它。

实测时间点（`primeCatalogForRegistration` 之前）：注册 20:27:00.630 → live 落盘 20:27:01.412，即目录发布窗口 ≤0.8s。
可重试集合 `DEFAULT_RETRYABLE_CODES = EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`；`UNKNOWN_MODEL` 与 `NO_ADAPTER` 都不在其中。
pi-ai 层的另一形态 `adapter does not own provider`（簿记错位）本插件不会产生：profiles 静态构造 + replace 复用同一 provider id。
