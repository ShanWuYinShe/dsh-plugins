# 宿主线适配细节与 asar 取证踩坑

本文件是 SKILL.md「九、宿主线适配」与「十一、反编译取证」的细节。

## adapt 三个缺口（实测）

适配 DSH 新预发布线时 `adapt` 只改 `@deepseek-ai/dsh-*` 的 range，以下三处要手工补，否则 `bun install` 或 `typecheck` 直接失败。
先跑 `adapt --dry-run` 看它打算改什么。

1. **adapt 会盲目 bump 宿主线已删除的包**：实测 `@deepseek-ai/dsh-invariants` 被指到 `^0.2.1-alpha.1`，
   但该包最新只到 `0.2.0-rc.2`（新线已不再依赖它）→ `bun install` 报 `No version matching ... (but package exists)`。
   判据：`npm view <pkg>@<新线版本> version` 为空即该包不在新线上。
   处理：若本仓从未 import（`grep -rn <pkg> src/ client/ test/` 为空）就直接删该依赖，不要 pin 一个不存在的版本。
2. **基础包 cordis / schemastery 要跟着一起前移**：`adapt` 不碰它们，但新宿主线常同时前移：
   0.2.1-alpha.1 要求 `cordis ~4.0.5-alpha.1`、`schemastery ~3.18.5-alpha.1`；当前 alpha 线（宿主 0.2.2-alpha.2）要求
   `cordis ~4.0.6-alpha.1`（四包同步）、`schemastery ~3.18.6-alpha.1` 与 `cordis-plugin-loader ~1.0.7-alpha.1`
   （`dsh-any-connect` 已同步，2026-10-28 实测）。继续 pin `^4.0.4` 会解析出**另一份 cordis 实例**，
   而 `dsh-settings` 的 `Context.settings` 声明 augment 的是宿主选中的那份 → `typecheck` 报
   `Property 'settings' does not exist on type 'Context'`（运行时同样是两个容器）。
   判据：`ls -d node_modules/.bun/@deepseek-ai+cordis@*` 出现多个**不同版本**即重复；同版本多副本是 peer 变体解析，正常。
3. **版本号形态必须与 `engines.dsh` 一致**：alpha 线用 `-alpha.N`（prerelease Release），待命期用纯 semver。
   发布门禁会校验，待命期发 `-alpha.N` 会被直接拒绝。

另：worktree 里跑 `bun run test:ci` 前必须先 `bun install`——worktree 有自己的目录，缺 `node_modules` 时 build 会报
`spawnSync .../node_modules/.bin/tsc ENOENT`。沙盒下装包要带 `BUN_INSTALL_CACHE_DIR=<repo>/.workwork/bun-cache`。

## 宿主接口审计：三处「已评估、有意不采用」

对 0.2.1-alpha.1 的接口使用做过完整审计，以下三项**是有意不做**，后续审计不要再当缺口报：

1. **直连 fetch 不加 `attributionHeaders()`**。宿主契约（`LlmAdapter` 类文档）要求 provider HTTP 请求带 attribution——
   这一跳由 pi-ai 覆盖（chat 路径 `lib/index.js` 的 `requestHeaders()`、探测路径 `attributionHeaders()` 直设，
   且 attribution 是保留名、优先于部署头）。插件自己直连的 14 个 fetch 分两类：模拟官方客户端的（`CLIENT_UA`、App 形 UA、
   ZCode 指纹）**UA 本身就是网关的产品分流契约**（实测：`WorkBuddyAI/<v>` 无空格才有完整 App 文档，空格形式 400），
   加 attribution 会破坏功能；账号/额度类的（preview/claim/balance）实测容忍额外头，但语义上就是以客户端身份发出
   （`zcodejwttoken` + `X-Device-Mid`），标 harness 身份自相矛盾，收益为零、风控风险不为零。
2. **不注册 `registerModelDiscovery`**。它探测的是「用户正在编辑、尚未存储的 draft endpoint」，
   而本插件是 profile 自带路由（`declared:false`）+ 自有目录刷新链路，用户从不填 endpoint；
   且网关（copilot.tencent.com / zcode.z.ai）不是标准 OpenAI/Anthropic 列模型端点，会落进 `DISCOVERY_UNSUPPORTED`。
3. **各变体配置卡合在一张 `plugins.bundle.config` 卡内，不拆 `plugins.row.config`**。
   两种 slot 都合法（slot-contract 明示 bundle 配置归属两者之一），用户拍板保持现形态。

## asar 反编译踩坑

- `app.asar` 头部是 `[8B pickle][4B headerSize][header JSON]`；**文件表里带 `unpacked:true` 的条目内容不在 asar 里**，
  要去 `app.asar.unpacked/` 同名路径读（本机 `cli/dist/codebuddy-headless.js` 就是 unpacked）。
- 顺序累加 offset 定位内嵌文件时，unpacked 条目的 size 会被计入导致偏移全错——先看 `meta.unpacked`，是就去 unpacked 目录按原路径读。
- macOS 上跑官方 CLI 会因沙盒写 `~/.codebuddy/local_storage` 报 EPERM；用 `HOME=$PWD/.workwork/cb-home` 重定向
  （**但重定向后它读不到真实登录态**，会报 "Authentication required"，所以它无法直接充当 chat 对照）。
- 查内置 provider 配置的权威位置：`Contents/Resources/config/provider/zcode-builtin.json`（含每个 provider 的
  `baseUrl` / `access.mode`，是"端点属于哪条通道"的权威来源）。
