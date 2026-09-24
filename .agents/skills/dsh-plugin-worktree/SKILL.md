---
name: dsh-plugin-worktree
description: DSH 插件跨分支 worktree 操作纪律。触发：在 main 与 alpha 之间切换、跨分支 cherry-pick、确认 lib 构建产物归属、排查命令改错目录时加载。
---

# 跨分支工作：worktree 纪律

## 开发工作流：worktree，不要切分支

待命期（DSH 无进行中的 alpha 预发布线）时，仓库保持单主干 `main` 运转，**无需创建或维护 `alpha` 分支，也无需创建 worktree**。
活跃预发布线开发期（DSH 发布了新 alpha 线），从最新 `main` 创建 `alpha` 分支，主检出目录切换至 `alpha` 或使用 git worktree 隔离。
**每次开始工作前，必须先跑 `bun run dsh-status` 核对宿主状态**：
若为待命期，直接在 `main` 工作；若为活跃期且需同时维护稳定线热修，使用 git worktree（**绝不在主检出目录里来回 checkout**：`lib/` 与
`node_modules` 被 gitignore，切分支后残留的是上一条分支的构建产物和依赖解析）。

```bash
git worktree add .worktrees/main main      # 首次创建（.worktrees/ 已 gitignore）
cd .worktrees/main && bun install && bun run build   # 每个工作树独立安装构建
```

跨分支 cherry-pick 在两个工作树目录之间直接进行，互不污染；每次进入工作树
或主检出目录后，先确认 `lib/` 是当前分支的产物（不确定就重新 build）。

**命令执行目录纪律**：一切会产生文件改动的操作——包括 `node -e` 内联脚本、
`sed -i`、代码生成——都必须先 `cd` 进目标 worktree 再执行，或在命令里写
绝对路径。shell 的 cwd 会在多次调用间保留，"以为在 worktree、实际改了主
检出"曾让发布产物缺字段。提交前用 `pwd` + `git status` 确认所在位置与预期
一致。

