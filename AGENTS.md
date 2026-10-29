# AGENTS.md — AI 协作指引

DSH host 插件 monorepo，双分支跟随 DSH 宿主线。通用约束以全局 `~/AGENTS.md` 为准
（本项目例外：`alpha` 分支允许推送，见全局「Git 红线」），本文件只做项目特有补充。
动手前先读
[RELEASING.md](RELEASING.md)（分支 / 版本号 / 发布流程的唯一权威约定）；
README 面向用户，面向开发者的内容以 RELEASING.md 为准。

## 常用命令

```bash
bun install             # 依赖安装（切分支后 lockfile 不同，记得重新 install）
bun run build           # 三段：tsc 编译 host → typert 工件生成 → esbuild 打包 client
bun run typert          # 只生成 Typert 工件（./typert + ./remote，scripts/typert.mjs）
bun run typecheck       # host + client 两套 tsconfig --noEmit（先自动生成 Typert 工件）
bun run test            # vitest 回归（先跑 scripts/build.mjs 构建，含 typert + esbuild 产物）
bun run test:ci         # build + typecheck + test（提交/发布前必跑）
bun run gate            # 发布门禁干跑：只读，看哪些包会被发布/为何被跳过
bun run dsh-status      # 两分支 dsh 依赖基线 vs dsh 最新 rc（正式版）对照（详见 RELEASING.md）
bun run adapt <dsh 新线版本>    # dsh 宿主升级适配（--dry-run 预览），详见 RELEASING.md
```

构建顺序不可交换：client 源码用包自引用子路径 `import "@chaoset/<pkg>/remote"`，
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
- **兼容声明**：插件对 DSH 的兼容性用官方 `engines.dsh`（`^<基线版本>`，由
  `bun run adapt` 与依赖 range 同步维护）；不要使用已废弃的自造字段 `dsh.host`。
- **客户端 inject**：`dsh.client.inject` 声明的是**客户端模块包名**（服务提供方包），
  不是 cordis 服务名；`cordis` 运行时的服务依赖写在 client 入口的 `export const inject`。
- 发布相关（分支模型、发布纪律、版本号/推送门禁）：详见 skill dsh-plugin-release；跨分支 worktree 操作：详见 skill dsh-plugin-worktree。
- 提交信息按 skill `git-workflow` 写（全局 Commit 格式 `<分类>(<范围>): <中文描述>`），本项目惯例用
  中文分类前缀（`新增:` / `修复:` / `重构:` / `文档:` / `测试:` / `ci:` 等）。
- 测试环境通过 vitest 配置里的 `DSH_HOME` 与真实用户目录隔离，不要在测试里
  读写真实的 `~/.dsh`。
- 测试涉及平台差异时必须显式判定平台（如
  `it.skipIf(process.platform !== "darwin")`），或改用运行时取值
  （`canonicalPath`、`dirname(fakeHome)` 等）保持用例平台无关；路径拼写取自运行时，在其他平台也跑得过。新增平台相关用例时
  建议在 Linux 容器实测一遍（`node:24` 镜像 + tar 管道传入源码跑
  `bun run test:ci`；macOS 打 tar 要带 `COPYFILE_DISABLE=1 --no-xattrs`，
  否则 `._*` AppleDouble 文件会被 vitest 当测试文件收集）。
