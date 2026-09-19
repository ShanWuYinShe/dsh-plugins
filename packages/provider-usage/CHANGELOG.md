# Changelog

## 0.1.0-alpha.0 (2026-09-19)

### Features

* 新增 `@chaoset/provider-usage`：在对话区底部状态栏（`conversation.composer.dock`）
  显示当前会话 provider 的剩余额度，与宿主自带的轮数/token pill 并列
* **通用查询器注册机制**（宿主没有 provider 额度扩展点，本包自建该 seam）：
  host 半侧导出 `ctx.providerUsage.register(provider, querier, displayName)`，任何
  插件都能为自己的 provider 路由注册额度查询；同 provider 后注册者生效（热重载
  幂等，也允许部署替换内置实现）
* 通用端点/凭据解析：从 DSH 自己的 configurable-provider 目录
  （`llm.listConfigurableProviders()` + settings section）与 `credentials` 服务解析
  `baseURL` / `apiKeyEnv`，查询器无需硬编码 profile 位置
* 内置查询器：DeepSeek（`/user/balance` 按币种）、OpenRouter（key 限额优先，
  回落账户额度）、Moonshot（可用/现金/代金券）
* 同域只读路由 `/plugins/provider-usage/usage`（回环 Origin 守卫、provider 数量上限、
  失败脱敏），60s 缓存、15s 查询超时、并发读取单飞；查询失败保留上次成功数据并标注
* browser 半侧 pill：当前 provider 取自会话模型目录（与 composer 模型选择器同源），
  点击展开各计费包进度条；无查询器显示「未提供额度查询」而非编造数字
