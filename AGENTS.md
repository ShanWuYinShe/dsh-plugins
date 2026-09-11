# AGENTS.md — AI 协作指引

DSH host 插件 monorepo，双分支跟随 DSH 宿主线。动手前先读
[RELEASING.md](RELEASING.md)（分支 / 版本号 / 发布流程的唯一权威约定）；
README 面向用户，面向开发者的内容以 RELEASING.md 为准。

## 分支模型

- `main` = dsh 稳定线适配（发 `latest`），工作树必须始终处于可直接发布状态，
  随时可热修；`alpha` = dsh 进行中的 alpha 预发布线（`-alpha.N`，进入 rc 阶段
  换 `-rc.N`，dist-tag 由版本后缀自动决定）。**alpha 是用完即弃的适配线**：
  dsh 一条线终结后，它的改动合回 main，旧 alpha 分支删除，再从最新 main 重
  建待命——等 dsh 出下一条 alpha 线再 `adapt` 跟进。因此 alpha 与 main 同基线
  （待命）是常态，不存在需要长期维护的分叉，详见 RELEASING.md「双线生命周期」。
- **功能一致性原则**：功能集两分支一致，唯一允许的代码差异是 dsh 预发布线
  破坏性 API 迫使的适配（详见 RELEASING.md 同名小节）。
- 依赖 range、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 的排除清单**永不跨分支
  搬运**；基础设施文件（workflows / scripts / 根配置 / 文档）两分支保持一致，
  直接 cherry-pick。

## 开发工作流：worktree，不要切分支

活跃预发布线开发期，主检出目录固定停在 `alpha`；待命期（两分支代码一致时）
停在 `main` 即可。需要另一条分支时用 git worktree，**绝不在主检出目录里来回
checkout**：`lib/` 与 `node_modules` 被 gitignore，切分支后残留的是上一条
分支的构建产物和依赖解析（曾导致旧宿主线的 `installSettingsSection` lib 在
新源码下直接崩溃）。

```bash
git worktree add .worktrees/main main      # 首次创建（.worktrees/ 已 gitignore）
cd .worktrees/main && pnpm install && pnpm run build   # 每个工作树独立安装构建
```

跨分支 cherry-pick 在两个工作树目录之间直接进行，互不污染；每次进入工作树
或主检出目录后，先确认 `lib/` 是当前分支的产物（不确定就重新 build）。

**命令执行目录纪律**：一切会产生文件改动的操作——包括 `node -e` 内联脚本、
`sed -i`、代码生成——都必须先 `cd` 进目标 worktree 再执行，或在命令里写
绝对路径。shell 的 cwd 会在多次调用间保留，"以为在 worktree、实际改了主
检出"曾让发布产物缺字段。提交前用 `pwd` + `git status` 确认所在位置与预期
一致。

## 发布纪律（重要）

**在功能完全实现、本地测试通过、并在 dsh 测试实例中真实验证可用之前，不
bump 版本、不提交推送。** 版本号是发布动作的一部分，不是开发动作——功能
有问题就修功能，绝不靠"再发一版"解决。一次功能开发的完整顺序：

1. 开发 + `pnpm run test:ci`（build + typecheck + test）全绿；
2. 启动隔离测试实例真实验证（不占用用户的 `~/.dsh`）：

   ```bash
   DSH_HOME=/tmp/dsh-verify/home node <dsh>/lib/bin.js --profile web --port 3181 --no-open
   # 浏览器打开（alpha 线宿主要用启动日志里带 token 的 URL），检查：
   # 页面渲染、插件卡片/设置行、模型列表，控制台零报错
   ```

   插件用本地路径安装（`dsh plugin add /abs/path/to/packages/<pkg>`，符号
   链接即装），**验证的是工作树产物，与 npm 发布产物同源**；
3. 验证通过后才：bump `package.json` 版本 + 写 CHANGELOG → 提交。
4. **推送前逐提交复核**：`git log --oneline origin/<分支>..HEAD` 与
   `git diff origin/<分支>..HEAD` 对照——提交信息声称的每项变更都要在
   diff 里找到，diff 里每处行为变更都要有 CHANGELOG 与版本号对应；
   对不上就不要推。然后 push（CI 自动发布），完成后核对 npm 的版本号与
   `dsh.host` 字段符合预期。

历史反例（先发布再验证连发 6+ 版本、发布产物缺字段多发一版）见
RELEASING.md「日常发布流程」——工作未完成期间代码可以本地 commit（worktree
隔离），但**不要 push**——push 即发布。

## 常用命令

```bash
pnpm install            # 依赖安装（切分支后 lockfile 不同，记得重新 install）
pnpm run build          # tsc 编译 host + esbuild 打包 client
pnpm run typecheck      # host + client 两套 tsconfig --noEmit
pnpm run test           # vitest 回归
pnpm run test:ci        # build + typecheck + test（提交/发布前必跑）
pnpm run gate           # 发布门禁干跑：只读，看哪些包会被发布/为何被跳过
pnpm run dsh-status     # 两分支 dsh 依赖基线 vs npm dist-tags 对照（详见 RELEASING.md）
pnpm run adapt 0.1.2-alpha.5   # dsh 宿主升级适配（--dry-run 预览），详见 RELEASING.md
```

## 已知技术债（重构候选，动手前先规划）

按 2026-09-05 可维护性审查登记，均为「有测试兜底前的已知债务」，不阻塞
日常开发，但改动相邻代码时应优先考虑顺手消化：

- scripts 的 semver 比较、CHANGELOG 小节判定、包目录枚举仍各有两份实现
  （`scripts/lib/dsh-deps.mjs` 已建立并承载 dsh 基线提取；剩余重复在
  publish-gate / release-notes / dsh-follow-status 之间）；脚本无自动化
  测试，发布时才暴露回归。
- 客户端 `ctx.locale.register` 重复注册防护仅 sandbox-extra-roots 有，
  session-archive / dsh-any-connect 待对齐（HMR 场景防御，
  需实例手验）。

（2026-09-11 adaptive-perf 废弃移除后，原登记的两条 adaptive-perf 相关
债务——index.ts 巨型闭包拆分、REMOTE_CONTRIBUTION 样板双包重复——随之消失。）

## 约定

- 版本号只在本地手工改（各包 `package.json` 的 `version`），CI 绝不改写。
  升版本必须同时补该包 `CHANGELOG.md` 的 `## <版本> (YYYY-MM-DD)` 小节
  （GitHub Release 说明自动取自这里）。
- 推送 `main` / `alpha` 即触发测试 + 发布（npm Trusted Publishing）；改动
  代码不升版本号会直接红（版本落后于 npm 的包会被门禁拒绝）。
- 提交信息用中文 + 类型前缀，与仓库现有用法一致（`新增:` / `修复:` /
  `重构:` / `文档:` / `测试:` / `ci:` 等，范围可选，如 `修复(认证): …`）。
- 测试环境通过 vitest 配置里的 `DSH_HOME` 与真实用户目录隔离，不要在测试里
  读写真实的 `~/.dsh`。
