---
name: dsh-release
description: Publish dsh-plugins packages to GitHub Release: isolated verification, version bump, CHANGELOG, push review. Use when 发布插件/发版/publish, bumping versions, or before pushing version changes. Enforces verify-before-bump order and artifact consistency.
---

# dsh-plugins 发布流程

版本号是发布动作的一部分，不是开发动作——功能有问题就修功能，修好再发版。

一次功能开发的完整顺序：

1. 开发 + `bun run test:ci`（build + typecheck + test）全绿；
2. 启动隔离测试实例真实验证（不占用用户的 `~/.dsh`）：

   ```bash
   DSH_HOME=/tmp/dsh-verify/home node <dsh>/lib/bin.js --profile web --port 3181 --no-open
   # 浏览器打开（alpha 线宿主要用启动日志里带 token 的 URL），检查：
   # 页面渲染、插件卡片/设置行、模型列表，控制台零报错
   ```

   插件用本地路径安装（`dsh plugin --profile web add /abs/path/to/packages/<pkg>`，
   符号链接即装；`--profile` 以各包 README 的用户口径为准），验证的是工作树
   产物，与 GitHub Release 分发的 tarball 同源；
3. 验证通过后才：bump `package.json` 版本 + 写 CHANGELOG → 提交。验证之后
   若有任何影响包产物的改动（src / client / 依赖 / 构建），必须用最终代码
   重新 build 并重走第 2 步——送验产物必须与待发布产物一致（版本号
   bump 本身不算产物改动，bump 后的产物 version 可用 heartbeat/
   `doctor` 核对）；
4. 推送前逐提交复核：`git log --oneline origin/<分支>..HEAD` 与
   `git diff origin/<分支>..HEAD` 对照——提交信息声称的每项变更都要在
   diff 里找到，diff 里每处行为变更都要有 CHANGELOG 与版本号对应；
   确认对上再 push（CI 自动发布为 GitHub Release 资产），完成后
   核对 Release 资产 tarball 与 `dsh.host` 字段符合预期（解包
   `tar -xOf <tgz> package/package.json`）。

历史反例（先发布再验证连发 6+ 版本、发布产物缺字段多发一版）见
RELEASING.md「日常发布流程」——工作未完成期间代码只在本地 commit（worktree
隔离）；push 即发布。
