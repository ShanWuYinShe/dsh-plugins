# AGENTS.md — AI 协作指引

DSH host 插件 monorepo，双分支跟随 DSH 宿主线。通用约束以全局 `~/AGENTS.md` 为准
（本项目例外：`alpha` 分支允许推送，见全局「Git 与提交」），本文件只做项目特有补充。
动手前先读
[RELEASING.md](RELEASING.md)（分支 / 版本号 / 发布流程的唯一权威约定）；
README 面向用户，面向开发者的内容以 RELEASING.md 为准。

## 常用命令

```bash
bun install             # 依赖安装（切分支后 lockfile 不同，记得重新 install）
bun run build           # tsc 编译 host + esbuild 打包 client
bun run typecheck       # host + client 两套 tsconfig --noEmit
bun run test            # vitest 回归（先跑 scripts/build.mjs 构建，含 tsc + esbuild 产物）
bun run test:ci         # build + typecheck + test（提交/发布前必跑）
bun run gate            # 发布门禁干跑：只读，看哪些包会被发布/为何被跳过
bun run dsh-status      # 两分支 dsh 依赖基线 vs dsh 最新 rc（正式版）对照（详见 RELEASING.md）
bun run adapt <dsh 新线版本>    # dsh 宿主升级适配（--dry-run 预览），详见 RELEASING.md
```

## 分支选择铁律：动手前必跑 `bun run dsh-status`

**任何开发、修复、依赖调整或发版前，必须先跑 `bun run dsh-status` 核对宿主状态，严禁凭经验或当前工作区分支盲目开工：**

1. **待命期**（`dsh-status` 报告「进行中预发布线: 无 —— alpha 分支待命」）：
   - **工作分支**：必须在 **`main`**（若主检出目录停留在 `alpha`，先 `git checkout main` 并 `bun install && bun run build` 确保产物干净）。
   - **日常功能与修复**：一律直接在 `main` 推进，版本号为**纯 semver 正式版**（如 `0.4.1`），发正式 Release。
   - **`alpha` 分支待命**：代码与 main 保持完全一致（`git branch -f alpha main`），**严禁在待命期向 alpha 提交新功能或发版**。
2. **活跃期**（`dsh-status` 报告存在高于稳定 rc 的新 `-alpha` 线）：
   - **工作分支**：主检出目录停在 **`alpha`**。
   - **功能与修复**：一律落在 `alpha`，版本号为 `-alpha.N`（进 rc 后换 `-rc.N`），发 prerelease Release。
   - **`main` 分支搁置**：停在原地不开发不发布，不 cherry-pick。

## 已知技术债

登记在 GitHub issues（label: [`tech-debt`](https://github.com/ShanWuYinShe/dsh-plugins/issues?q=label%3Atech-debt)），均为「有测试兜底前的已知债务」，不阻塞日常开发，但改动相邻代码时应优先考虑顺手消化，销项后关闭对应 issue。

## 约定

- 发布相关（分支模型、发布纪律、版本号/推送门禁）：详见 skill dsh-plugin-release；跨分支 worktree 操作：详见 skill dsh-plugin-worktree。
- 提交信息按 `git-workflow` skill 写（全局 Commit 格式 `<分类>(<范围>): <中文描述>`），本项目惯例用
  中文分类前缀（`新增:` / `修复:` / `重构:` / `文档:` / `测试:` / `ci:` 等）。
- 测试环境通过 vitest 配置里的 `DSH_HOME` 与真实用户目录隔离，不要在测试里
  读写真实的 `~/.dsh`。
- 测试涉及平台差异时必须显式判定平台（如
  `it.skipIf(process.platform !== "darwin")`），或改用运行时取值
  （`canonicalPath`、`dirname(fakeHome)` 等）保持用例平台无关；路径拼写取自运行时，在其他平台也跑得过。新增平台相关用例时
  建议在 Linux 容器实测一遍（`node:24` 镜像 + tar 管道传入源码跑
  `bun run test:ci`；macOS 打 tar 要带 `COPYFILE_DISABLE=1 --no-xattrs`，
  否则 `._*` AppleDouble 文件会被 vitest 当测试文件收集）。
