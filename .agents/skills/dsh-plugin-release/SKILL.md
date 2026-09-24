---
name: dsh-plugin-release
description: DSH 插件双分支发布体系。触发：发版、升版本号、写 CHANGELOG、推送 main 或 alpha、合 alpha 回 main、查发布门禁规则时加载。分支与版本号权威约定见 RELEASING.md。
---

# 插件发布：分支、纪律与版本

动手前先读 RELEASING.md（分支 / 版本号 / 发布流程的唯一权威约定）。

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
- **待命期原则（无新 alpha 线时：开发在 main，alpha 待命）**：上一条线终结、DSH
  尚无更高基础号的新 alpha 线时（`bun run dsh-status` 报告「进行中预发布线: 无 —— alpha 分支待命」），
  alpha 与 main 同基线待命。**此时日常功能演进与 bug 修复一律在 `main` 推进，
  使用纯 semver 版本号（如 `0.4.1`），发布正式 Release**。alpha 分支仅与 main
  保持同基线待命（不发版），**严禁在待命期向 alpha 提交新功能或发版**。
- 依赖 range、`bun.lock` 只在所属分支重建，不跨分支搬运。

## 发布纪律（重要）

**任何插件更新（功能、修复、依赖调整一律适用）：必须先在本地的隔离测试
环境中全部测试通过，才能更新版本号、提交、推送——推送分支只跑测试，发版
是另一个显式动作（打 tag 推出），顺序不可颠倒，无例外。**
版本号是发布动作的一部分，不是开发动作——功能有问题就修功能，绝不靠
"再发一版"解决。一次功能开发的完整顺序：

0. **核对宿主阶段与目标分支（动手第一步）**：必须先跑 `bun run dsh-status`。
   - 若为**待命期**（进行中预发布线为“无”）：目标分支为 **`main`**（确认主检出目录已停在 main），版本号使用**纯 semver 正式版**（如 `0.4.1`），发正式 Release；
   - 若为**活跃期**（存在进行中的新 alpha 线）：目标分支为 **`alpha`**（确认主检出目录停在 alpha），版本号带 **`-alpha.N` / `-rc.N`**，发 prerelease Release；`main` 搁置。
1. 在目标分支开发 + `bun run test:ci`（build + typecheck + test）全绿；
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
   对不上就不要推。另跑一遍 `bun run gate` 干跑确认。然后 push
   （分支推送只跑测试，不发布）。
5. **明确要发版时才打 tag**：`git tag <目录>-v<版本> && git push origin
   <目录>-v<版本>`。tag 推出去即发版——CI 对该 tag 执行测试 → 门禁校验
   （tag 形态、tag 与 package.json 版本一致、版本不落后已归档）→ 建
   GitHub Release。**tag 由你明确打出，CI 绝不创建 tag**。发版后核对
   Release 资产 tarball 与 `dsh.host` 字段符合预期（解包
   `tar -xOf <tgz> package/package.json`）。

历史反例（先发布再验证连发 6+ 版本、发布产物缺字段多发一版）见
RELEASING.md「日常发布流程」——工作未完成期间代码可以本地 commit（worktree
隔离），分支推送只跑测试；**不要打 tag**——推 tag 即发版。

## 版本与推送约定

- 版本号只在本地手工改（各包 `package.json` 的 `version`），CI 绝不改写。
  升版本必须同时补该包 `CHANGELOG.md` 的 `## <版本> (YYYY-MM-DD)` 小节
  （GitHub Release 说明自动取自这里）。
- 推送 `main` / `alpha` 只跑测试（test.yml），永远不发布；发版只由 tag 推送
  触发（`git tag <目录>-v<版本> && git push origin <目录>-v<版本>`，
  GitHub Release tarball 分发，不经过 npm）。**tag 由你明确打出，CI 绝不
  创建 tag**——没推 tag 就没有任何 Release。门禁规则（打 tag 发版时强制
  执行）：版本号**严格低于**已归档版本会直接红；「改了代码没升版本号」
  不再是 CI 红灯——那种推送只跑测试，想发版就升版本打新 tag。版本与已归档
  tag 相同则幂等跳过。任何情况下不满足发布条件的包不会出现在 Release 资产里。
- **待命期版本形态约束**：待命期发版必须为纯 semver 正式版，严禁发布 `-alpha.N` 预发布版本。发布门禁会校验 `dsh.host` 与版本形态的一致性：若宿主声明未适配到新 alpha 预发布线（仍为稳定线 rc），带 `-alpha` 后缀的包会被门禁直接拒绝。

