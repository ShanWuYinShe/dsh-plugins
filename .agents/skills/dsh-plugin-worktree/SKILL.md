---
name: dsh-plugin-worktree
description: DSH 插件跨分支 worktree 操作纪律。触发：在 main 与 alpha 之间切换、跨分支 cherry-pick、确认 lib 构建产物归属、排查命令改错目录时加载。
---

# 跨分支工作：worktree 纪律

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

