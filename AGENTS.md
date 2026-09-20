# AGENTS.md — AI 协作指引

DSH host 插件 monorepo，双分支跟随 DSH 宿主线。通用约束以全局 `~/AGENTS.md` 为准
（本项目例外：`alpha` 分支允许推送，见全局 Git 准则），本文件只做项目特有补充。
动手前先读
[RELEASING.md](RELEASING.md)（分支 / 版本号 / 发布流程的唯一权威约定）；
README 面向用户，面向开发者的内容以 RELEASING.md 为准。

## 分支模型

- `main` = dsh 稳定线适配（发正式 Release），工作树必须始终处于可直接发布
  状态（停在被搁置的最后一版，需要时能立刻放紧急热修）；`alpha` = dsh 进行
  中的 alpha 预发布线（`-alpha.N`，进入 rc 阶段换 `-rc.N`，Release 的
  prerelease 标记由版本后缀自动决定）。**alpha 是用完即弃的适配线**，每轮生命周期固定四步：**从最新
  main 分叉 → 迭代若干提交 → 压缩成单个提交合回 main → 远程与本地删除
  alpha，再从最新 main 重建待命**。起点永远是当下的 main，因此 alpha 恒为
  main 的后代（基线自动继承稳定线成果，不靠人工搬运），收敛时 `merge
  --ff-only` 必然可行。详见 RELEASING.md「双线生命周期」。
- **功能收敛原则（alpha 只进不出）**：活跃 alpha 线期间，功能开发与修复一律
  落在 alpha，**不往 main 搬**——两分支此时有功能差异是预期的，不是漂移。只有
  dsh 该线发完最新 rc（**rc 即 dsh 的正式版**，dsh 从不发无后缀纯 X.Y.Z）之后，
  才把 alpha 的改动一次性合回 main（详见 RELEASING.md「功能收敛原则」与「双线
  生命周期」）。
- **main 搁置**：只要 dsh 有进行中的 alpha 线，**一切改动都落在 alpha**——源码、
  文档、`scripts/`、workflows、根配置一律不往 main 搬，main 停在原地不开发不
  发布。唯一例外是稳定线紧急热修（需明确指示，且修完必须把改动带回 alpha）。
  收敛时随整条线一次搬过去，详见 RELEASING.md「跨分支同步」。
- 依赖 range、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 的排除清单**永不跨分支
  搬运**。

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

**任何插件更新（功能、修复、依赖调整一律适用）：必须先在本地的隔离测试
环境中全部测试通过，才能更新版本号、提交、推送——顺序不可颠倒，无例外。**
版本号是发布动作的一部分，不是开发动作——功能有问题就修功能，绝不靠
"再发一版"解决。一次功能开发的完整顺序：

1. 开发 + `pnpm run test:ci`（build + typecheck + test）全绿；
2. 启动隔离测试实例真实验证（不占用用户的 `~/.dsh`）：

   ```bash
   DSH_HOME=/tmp/dsh-verify/home node <dsh>/lib/bin.js --profile web --port 3181 --no-open
   # 浏览器打开（alpha 线宿主要用启动日志里带 token 的 URL），检查：
   # 页面渲染、插件卡片/设置行、模型列表，控制台零报错
   ```

   插件用本地路径安装（`dsh plugin --profile web add /abs/path/to/packages/<pkg>`，
   符号链接即装；`--profile` 以各包 README 的用户口径为准），**验证的是工作树
   产物，与 GitHub Release 分发的 tarball 同源**；
3. 验证通过后才：bump `package.json` 版本 + 写 CHANGELOG → 提交。验证之后
   若有任何影响包产物的改动（src / client / 依赖 / 构建），必须用最终代码
   重新 build 并重走第 2 步——**送验产物必须与待发布产物一致**（版本号
   bump 本身不算产物改动，bump 后的产物 version 可用 heartbeat/
   `doctor` 核对）；
4. **推送前逐提交复核**：`git log --oneline origin/<分支>..HEAD` 与
   `git diff origin/<分支>..HEAD` 对照——提交信息声称的每项变更都要在
   diff 里找到，diff 里每处行为变更都要有 CHANGELOG 与版本号对应；
   对不上就不要推。然后 push（CI 自动发布为 GitHub Release 资产），完成后
   核对 Release 资产 tarball 与 `dsh.host` 字段符合预期（解包
   `tar -xOf <tgz> package/package.json`）。

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
pnpm run dsh-status     # 两分支 dsh 依赖基线 vs dsh 最新 rc（正式版）对照（详见 RELEASING.md）
pnpm run adapt <dsh 新线版本>   # dsh 宿主升级适配（--dry-run 预览），详见 RELEASING.md
```

## 已知技术债

登记在 GitHub issues（label: [`tech-debt`](https://github.com/ShanWuYinShe/dsh-plugins/issues?q=label%3Atech-debt)），均为「有测试兜底前的已知债务」，不阻塞日常开发，但改动相邻代码时应优先考虑顺手消化，销项后关闭对应 issue。

## 约定

- 版本号只在本地手工改（各包 `package.json` 的 `version`），CI 绝不改写。
  升版本必须同时补该包 `CHANGELOG.md` 的 `## <版本> (YYYY-MM-DD)` 小节
  （GitHub Release 说明自动取自这里）。
- 推送 `main` / `alpha` 即触发测试 + 发布（GitHub Release tarball 分发，
  不经过 npm）；门禁规则：版本号**严格低于**已归档版本会直接红；「改了
  代码没升版本号」分两种——tag 不在 HEAD 且包内容有更新时门禁会告警
  （不红），版本与已归档 tag 相同则幂等跳过。任何情况下不满足发布条件的
  包不会出现在 Release 资产里。
- 提交信息遵循全局 Commit 格式（`<分类>(<范围>): <中文描述>`），本项目惯例用
  中文分类前缀（`新增:` / `修复:` / `重构:` / `文档:` / `测试:` / `ci:` 等）。
- 测试环境通过 vitest 配置里的 `DSH_HOME` 与真实用户目录隔离，不要在测试里
  读写真实的 `~/.dsh`。
- 测试涉及平台差异时必须显式判定平台（如
  `it.skipIf(process.platform !== "darwin")`），或改用运行时取值
  （`canonicalPath`、`dirname(fakeHome)` 等）保持用例平台无关——禁止写死
  单一平台的路径拼写，避免用例在其他平台永远跑不过。新增平台相关用例时
  建议在 Linux 容器实测一遍（`node:24` 镜像 + tar 管道传入源码跑
  `pnpm run test:ci`；macOS 打 tar 要带 `COPYFILE_DISABLE=1 --no-xattrs`，
  否则 `._*` AppleDouble 文件会被 vitest 当测试文件收集）。
