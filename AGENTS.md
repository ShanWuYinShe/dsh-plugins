# AGENTS.md — AI 协作指引

DSH host 插件 monorepo，双分支跟随 DSH 宿主线。通用约束以全局 `~/AGENTS.md` 为准
（本项目例外：`alpha` 分支允许推送，见全局「Git 红线」），本文件只做项目特有补充。
动手前先读
[RELEASING.md](RELEASING.md)（分支 / 版本号 / 发布流程的唯一权威约定）；
README 面向用户，面向开发者的内容以 RELEASING.md 为准。

## 常用命令

```bash
bun install             # 依赖安装（切分支后 lockfile 不同，记得重新 install）
bun run build           # 四段：tsc 编译 host → typert 工件生成 → esbuild 打包 client → bin 自包含打包
bun run typert          # 只生成 Typert 工件（./typert + ./remote，scripts/typert.mjs）
bun run typecheck       # host + client 两套 tsconfig --noEmit（先自动生成 Typert 工件）
bun run test            # vitest 回归（先跑 scripts/build.mjs 构建，含 typert + esbuild 产物）
bun run test:ci         # build + typecheck + test（提交/发布前必跑）
bun run test:stability  # 测试确定性压测：多轮全量 + 多并发档位（见「约定」的确定性要求）
bun run test:coverage   # build + vitest --coverage + 逐文件覆盖率棘轮（基线 scripts/coverage-baseline.json）
bun run coverage:ratchet --write  # 覆盖率提升后刷新逐文件基线（只升不降；确需放宽用 --write --lower 并在提交信息说明）
bun run gate            # 发布门禁干跑：只读，看哪些包会被发布/为何被跳过
bun run dsh-status      # 两分支 dsh 依赖基线 vs dsh 最新 rc（正式版）对照（详见 RELEASING.md）
bun run dsh-status --strict  # 严格模式：main 基线 ≠ npm 最新正式版时 exit 1（发布流水门禁用）
bun run adapt <dsh 新线版本>    # dsh 宿主升级适配（--dry-run 预览），详见 RELEASING.md
```

构建顺序不可交换：阶段 0 先整目录清空每包 `lib/` 与 `client/client.cjs`（陈旧产物清理，
`test/build-hygiene.test.ts` 锁住），阶段 1 tsc，阶段 2 Typert 生成，阶段 3 client 打包，
阶段 4 bin 自包含。client 源码用包自引用子路径 `import "@chaoset/<pkg>/remote"`，
esbuild 解析的是 **生成产物** `lib/typert.remote-client.js`，因此 Typert 生成必须
在 client 打包之前。`lib/` 与 `client/client.cjs` 都是 gitignore 的构建产物。

## 分支选择铁律：动手前必跑 `bun run dsh-status`

**任何开发、修复、依赖调整或发版前，必须先跑 `bun run dsh-status` 核对宿主状态，严禁凭经验盲目开工：**

1. **待命期**（`dsh-status` 报告「进行中预发布线: 无」）：
   - **无需创建 `alpha` 分支，也不用更新 `alpha` 分支**；仓库保持单主干 **`main`** 运行。
   - **日常功能与修复**：一律直接在 **`main`** 推进，版本号为**纯 semver 正式版**（如 `0.4.1`），发正式 Release。
2. **活跃期**（`dsh-status` 报告存在高于稳定 rc 的新 `-alpha` 线）：
   - **创建/进入分支**：若 `alpha` 分支未创建，从最新 **`main`** 创建 `alpha` 分支（`git checkout -b alpha main` 或用 worktree）；执行 `bun run adapt <新线版本>` 开始跟进。
   - **功能与修复**：一律落在 **`alpha`**，版本号为 `-alpha.N`（进 rc 后换 `-rc.N`），发 prerelease Release。
   - **`main` 分支搁置**：停在原地不开发不发布，不 cherry-pick。
3. **收敛期**（DSH 该线发完最新 rc 即正式版）：
   - 在 `alpha` 适配最新 rc 并去后缀转正为正式版，压缩成单个基于 main 的提交合入 `main`，发正式 Release。
   - **合回后彻底删除 `alpha` 分支（本地与远程）**，回到待命期（无 alpha 分支状态），等待 DSH 下一次发布新 alpha 线。

## 已知技术债

登记在 GitHub issues（label: [`tech-debt`](https://github.com/ShanWuYinShe/dsh-plugins/issues?q=label%3Atech-debt)），均为「有测试兜底前的已知债务」，不阻塞日常开发，但改动相邻代码时应优先考虑顺手消化，销项后关闭对应 issue。

## 约定

- **Typert / @Remote**：暴露给 Web client 的服务面用官方 `@Remote` 标准装饰器标在
  `TypertRemoteService` 子类的**具体业务方法**上，参数/返回类型定义在包的
  `src/types.ts`（对应 `package.json` 的 `./types` 子路径导出）。`./typert`（Host 工件）
  与 `./remote`（Client 调用面）由 `@deepseek-ai/dsh-typert-generator` 在构建期生成，
  **不要手写**；新增/修改 `@Remote` 方法后必须重新 `bun run build`。没有 Remote 服务
  的包不要声明 `./typert` / `./remote` 导出。
- **插件索引 / `market` 分支**：站点由长期存在的发布产物分支 `market` 承载，该分支根目录
  即站点根（`index.json`、`README.md`、`icons/`、`npm/`）——DSH「自定义插件索引」的索引
  + 静态 npm registry，布局与 URL 见 RELEASING.md「插件索引与静态 registry」。**禁止手工编辑**；
  只由 `scripts/plugin-market.mjs` 产出，publish workflow 在任一发版 tag 发布后自动更新到
  `market` 分支（workflow_dispatch 可回填/修复）；它与 `alpha`/`main` 的双分支发布体系正交。
  新增发布包必须在 `scripts/lib/plugin-market-core.mjs` 的 `PACKAGE_DISPLAY` 补展示元数据，
  否则 `bun run market:build` 直接报错。
- **展示元数据**：每个发布包必须提供顶层 `icon: "./icon.svg"` 与 `locale/en.json` /
  `locale/zh.json`（`meta.title` / `meta.description`，纯字符串），`exports` 暴露
  `./locale/*.json`，`files` 含 `icon.svg` 与 `locale/*.json`——宿主 Plugin Manager
  通过 `readPluginMeta` 读这两处（官方 skill「Display metadata and icon」），缺失时
  卡片标题回退裸包名、图标回退通用图形。文案/图标须与 `PACKAGE_DISPLAY` 同源，
  由 `test/plugin-display-meta.test.ts` 锁住。
- **兼容声明**：插件对 DSH 的兼容性用官方 `engines.dsh`，且必须写**精确宿主版本**
  （如 `0.2.2-rc.2`，不写 `^` / `~` / `>=`）；依赖 range 仍是 `^X`，由
  `bun run adapt` 同步维护，`dsh-baseline` 严格核对「range 的 `^X` ↔ `engines.dsh`
  的精确 `X`」。DSH 升级很可能不兼容旧版本，因此每次升级都要重发对应插件版本；
  不要使用自造字段 `dsh.host`（宿主不认识该字段）。
- **客户端 inject**：`dsh.client.inject` 声明的是**客户端模块包名**（服务提供方包），
  不是 cordis 服务名；`cordis` 运行时的服务依赖写在 client 入口的 `export const inject`。
- **入口面**：Host 入口（`src/index.ts`）只导出 `name` / `inject` / `Config` / `apply`，
  Client 入口（`client/index.tsx`）只导出 `name` / `inject` / `apply`；禁止
  `export default` 与 `export *`。测试需要的内部实现从 `../src/<module>.js` /
  `../client/<module>.js` 相对导入——**不要为了测试方便从入口转发**；入口只允许
  `name`/`inject`/`Config`/`apply`。根 `test/entry-surface.test.ts` 是这条规则的锁。
- **独立 CLI**：`dsh-any-connect` 的 `lib/bin.js` 是构建期用 esbuild 打出的**自包含**
  bundle（内联 MIT 依赖，见包内 THIRD_PARTY_NOTICES.md）：插件源码静态 import 宿主包，
  而 bin 是独立 node 进程、不经宿主 runtime resolution，所以必须自包含。改 bin 依赖后
  重新 `bun run build`，回归由包内 `test/bin-self-contained.test.ts` 守住。bin 的第三方内联闭包
  由构建期 esbuild metafile 写出 `.workwork/bin-closure.json`，`test/third-party-notices.test.ts`
  核对 `THIRD_PARTY_NOTICES.md` 表格与闭包完全一致——改 bin 依赖后重跑 build 并按测试提示同步表格。
- 发布相关（分支模型、发布纪律、版本号/推送门禁）：详见 skill dsh-plugin-release；跨分支 worktree 操作：详见 skill dsh-plugin-worktree。
- 提交信息按 skill `git-workflow` 写（全局 Commit 格式 `<分类>(<范围>): <中文描述>`），本项目惯例用
  中文分类前缀（`新增:` / `修复:` / `重构:` / `文档:` / `测试:` / `ci:` 等）。
- 测试环境通过 vitest 配置里的 `DSH_HOME` 与真实用户目录隔离，不要在测试里
  读写真实的 `~/.dsh`。
- **测试必须确定性**（同一份代码，任何负载、并发度、执行顺序、上一次跑的残留，
  结果都必须一致）：
  - 每个测试文件由 `test/setup-test-home.ts` 分配**全新的空 `DSH_HOME`**，
    测试不得假设其它测试写下的凭据/缓存/状态存在；需要自定义目录的用例自己
    `mkdtemp` 并在 `afterEach` 清理。
  - 禁止用「睡固定时长 + 断言没发生」这种墙钟窗口写负向断言；用事件/可等待的
    完成信号（必要时加最小测试缝），或 fake timers 断言「没有新增未决定时器」。
  - 异步资源（定时器、在途 I/O、服务）必须显式 dispose/await 完成后再清理临时
    目录，避免 `ENOTEMPTY` 这类清理竞态。
  - 禁止靠 `retry`/`skip`/放大 timeout 掩盖不稳定；偶发假红必须查明根因。
  - 改测试相关代码后跑 `bun run test:stability`（多轮 + 多并发档位）证明稳定；
    alpha 分支推送（`test.yml`）与发布流水（`publish.yml`）会自动跑同一脚本。
- **依赖解析基线**：`engines.dsh` 与全部 `@deepseek-ai/dsh-*` range 必须统一到宿主最新正式版；
  宿主升级后**必须从零重解 lock**（`rm -rf node_modules packages/*/node_modules bun.lock && bun install`），
  增量 `bun install` 不会重解 peer 图、会永久保留旧实例。`test/dep-resolution-baseline.test.ts`
  对「声明 range ↔ 实际解析版本 ↔ bun.lock」三方锁定。
- **废弃 API**：0.2.2-rc.1 起 `Session.eventAt/snapshotEvents/ownEvents` 与
  `SessionController.page()` 已标 `@deprecated`（禁止新调用）；`test/deprecated-api.test.ts` 拦截。
- **覆盖率门禁两层**（RULE-088 的官方口径是 `packages/*/*/src` 逐文件 100%，本仓长期目标）：
  ① 全局阈值（`vitest.config.ts` 的 coverage.thresholds，只升不降）；
  ② **逐文件棘轮**（`scripts/coverage-baseline.json` + `scripts/coverage-ratchet.mjs`）：每个纳入
  coverage 的源文件不得低于版本化基线（容差 0.2pp），新增文件必须达到全局阈值，删除文件由
  `bun run coverage:ratchet --write` 清理。改完测试/源码后跑 `bun run test:coverage`，并做一次反向
  验证（把基线某文件数字调高 1pp → 必须红；恢复后绿）。纯类型文件（如 `client/pill-types.ts`）
  在 v8 里 0 条可执行语句，棘轮按 N/A 处理。
- **REAL-composition 测试依赖构建产物**：按包名经 Loader 装载真实入口（`lib/index.js`）的用例
  必须先 `node scripts/build.mjs`（或 `bunx tsc -p packages/<pkg>/tsconfig.json`）；`bun run test`
  与 `bun run test:ci` 自带构建，直接 `bunx vitest run packages/<pkg>` 时先手动构建一次。
- 测试涉及平台差异时必须显式判定平台（如
  `it.skipIf(process.platform !== "darwin")`），或改用运行时取值
  （`canonicalPath`、`dirname(fakeHome)` 等）保持用例平台无关；路径拼写取自运行时，在其他平台也跑得过。新增平台相关用例时
  建议在 Linux 容器实测一遍（`node:24` 镜像 + tar 管道传入源码跑
  `bun run test:ci`；macOS 打 tar 要带 `COPYFILE_DISABLE=1 --no-xattrs`，
  否则 `._*` AppleDouble 文件会被 vitest 当测试文件收集）。
  **容器实测两个必做前提**（否则会出现一批环境假阳性）：
  ① 源码里没有 `.git` 时，`publish-gate`/`scripts-cli` 的 `git tag -l` 会抛
  `fatal: not a git repository`，需在容器内 `git init && git add -A && git commit`
  （或挂载真实 `.git`）；② 以 **非 root 用户**运行——`electron-discovery` 用
  `chmod 000` 构造 EACCES，root 会无视权限位导致假红。

## 按需加载的 skill（`.agents/skills/`）

| skill | 何时加载 |
|---|---|
| `dsh-plugin-release` | 分支模型、发布纪律、版本号与推送门禁 |
| `dsh-plugin-worktree` | 跨分支 worktree 操作 |
| `dsh-plugin-tag` | 打发版 tag 的具体步骤（详见 RELEASING.md） |
| `dsh-any-connect-channels` | 改 dsh-any-connect 任一渠道 / 排查额度、限流、模型目录时 |
