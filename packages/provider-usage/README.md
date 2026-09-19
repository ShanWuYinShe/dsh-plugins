# @chaoset/provider-usage — DSH provider 额度显示插件

在对话区底部的状态栏（composer dock）显示**当前会话 provider 的剩余额度**：
余额、周期包余量/进度、重置时间等。与 DSH 自带的「轮数 / 步数 / token 用量」
并列显示，不替代它们。

核心不是"支持某几个 provider"，而是**一套注册机制**：宿主没有"provider 额度"
这个扩展点，所以本包把它做成插件可注册的公开 seam —— 任何 provider 插件都能为
自己的路由注册一个查询器。

## 效果

在 composer 底部状态栏出现一个形如 `workbuddy · 23 credits left` 的 pill，
点击展开每个计费包的进度条：

```
workbuddy
  CodeBuddy个人版国内运营裂变包    23 credits
  ▓▓▓▓▓░░░░░░░░░░░░░░░░░  23 / 100
  CodeBuddy个人版国内运营裂变包   100 credits
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 100 / 100
```

- **当前 provider 来源**：会话的模型目录（`ctx.modelDirectories`），与 composer
  的模型选择器同源——切换模型时 pill 跟随变化，无需额外协调。
- **无查询器**：显示「该 provider 未提供额度查询」，而不是编造数字或静默消失。
- **查询失败**：保留上次成功的数据并标注错误，不把用户正在看的数字抹掉。
- **不消耗额度**：只调用各 provider 的**只读**余额接口，60s 缓存 + 并发单飞
  （多个读取共用一次请求）。

## 安装

```bash
dsh plugin --profile web add @chaoset/provider-usage
```

前置：DSH 宿主版本见本包 `package.json` 的 `dsh.host` 字段。

## 内置查询器

| provider | 接口 | 说明 |
|---|---|---|
| `deepseek` | `GET {base}/user/balance` | 按币种各一行 |
| `openrouter` | `/api/v1/key` + `/api/v1/credits` | 优先 key 自身限额，回落到账户额度 |
| `moonshot` | `GET {base}/v1/users/me/balance` | 可用/现金/代金券 |

**WorkBuddy（`workbuddy` / `workbuddy-ai`）不在本包内置**：只有
[`@chaoset/dsh-any-connect`](../dsh-any-connect/) 知道如何读取该桌面 App 的登录态
与计费接口，因此由**那个包**注册自己的查询器。这正是设计意图——provider 的拥有者
才是最清楚它计费接口的人。两者都装即可看到 WorkBuddy 额度。

## 为其他 provider 注册查询器

任何插件的 host 半侧都可以注册（`provider` 即 DSH 的 provider 路由 id）：

```ts
ctx.inject(['providerUsage'], usageCtx => {
  usageCtx.effect(() => usageCtx.providerUsage.register(
    'my-provider',
    async ({ apiKey, baseURL, signal }) => ({
      provider: 'my-provider',
      windows: [
        { id: 'monthly', label: 'Monthly plan', remain: 42, unit: 'credits', limit: 100,
          resetsAt: '2026-10-01T00:00:00Z' },
      ],
      fetchedAt: Date.now(),
    }),
    'My Provider',
  ), 'my-plugin: usage querier')
})
```

要点：

- **端点是可选的**。查询器收到的 `baseURL` / `apiKey` 由本包从 DSH 自己的
  configurable-provider 目录（`llm.listConfigurableProviders()` + settings）与
  credentials 服务解析而来，查询器**不必知道 profile 存在哪**。需要额外信息时
  自行从 `ctx` 读取即可。
- **注册是覆盖语义**。同一 provider 后注册者生效，因此热重载幂等，部署也可以用
  自己的实现替换内置查询器。
- **不依赖本包也能装**。用 `ctx.inject(['providerUsage'])` 等待服务出现：未安装
  本包时回调不触发，属正常状态（参考 `dsh-any-connect` 的做法）。
- **失败不要自己吞**。抛出即可，registry 会保留上次成功数据、标注错误并脱敏。
  查询器找不到可展示的数据时返回**空 `windows`**（表示「该 provider 不上报额度」），
  这与「查询失败」是两种不同陈述。

### 数据结构

```ts
interface UsageWindow {
  id: string            // 同一快照内唯一，React key / 稳定渲染用
  label: string         // provider 自报的包名，原样显示不翻译
  remain?: number       // 剩余量
  unit: string          // 单位：credits / usd / cny / requests…
  limit?: number        // 窗口上限；缺省表示「只有剩余量」（余额），不是「上限为 0」
  resetsAt?: string     // ISO-8601 重置时刻；有它表示会回填的限额
}
```

## 工作原理

- host 半侧把 `ProviderUsageRegistry` 注册为 `ctx.providerUsage`，并在
  `/plugins/provider-usage/usage` 暴露同域只读路由（仅回环 Origin，与
  dsh-any-connect 的状态路由同一姿态）。
- browser 半侧把 pill 注册进 `conversation.composer.dock`（list slot，
  `order: 10`，排在宿主自带 `stats` 之后），按当前 provider 轮询路由。
- 缓存 60s、查询超时 15s、并发读取单飞；失败保留上次数据并脱敏（JWT / `sk-`
  / 查询参数里的 token）。

## 已知边界

- 额度口径完全取决于 provider 是否提供只读余额接口。**没有该接口的 provider
  （如部分网关/自建服务）就是没有**——本包显示「未提供额度查询」或「不上报额度」，
  不会伪造数据。用户提到的「5 小时额度 / 周额度」在 WorkBuddy 上游并不存在：
  实测其 45 个计费包全部是月/半年粒度周期，也没有任何 rate-limit 端点。
- provider 改字段名时，内置查询器按「取不到就报无数据」处理，不会把猜错的值当成
  余额显示。

## 发布线

随 monorepo 分支发布，详见 [RELEASING.md](../../RELEASING.md)。

## 免责声明

额度查询依赖各 provider 的公开接口，对方变更后可能需要随之调整。
