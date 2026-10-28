---
name: dsh-plugin-worktree
description: DSH 插件跨分支 worktree 操作纪律。触发：在 main 与 alpha 之间切换、跨分支 cherry-pick、确认 lib 构建产物归属、排查命令改错目录时加载。
---

# 跨分支工作：worktree 纪律

## 何时需要 worktree（先跑 `bun run dsh-status`）

- **待命期**（无进行中的 alpha 预发布线）：仓库单主干 `main` 运转，**不创建也不维护 `alpha` 分支与 worktree**，直接在 `main` 工作。
- **活跃期**（DSH 发布了新 alpha 线）：主检出切到从最新 `main` 建出的 `alpha`，`main` 另建 worktree 并存
  （RELEASING「跨分支同步」的工作区隔离）；**绝不在主检出目录里来回 checkout**——`lib/` 与 `node_modules` 被 gitignore，切分支后残留的是上一条分支的构建产物与依赖解析。

## 创建与使用

```bash
git checkout -b alpha main                                # 主检出停在活跃线（待命期无 alpha，见上）
git worktree add .worktrees/main main                     # 稳定线另建工作树（.worktrees/ 已 gitignore）
cd .worktrees/main && bun install && bun run build        # 每个工作树独立安装构建
```

跨分支 cherry-pick 直接在两个工作树目录之间进行，互不污染；每次进入 worktree 或主检出后先确认 `lib/` 是当前分支的产物（不确定就重新 build）。

## 命令执行目录纪律

一切会产生文件改动的操作——`node -e` 内联脚本、`sed -i`、代码生成——都必须先 `cd` 进目标 worktree 再执行，
或在命令里写绝对路径。shell 的 cwd 会在多次调用间保留，"以为在 worktree、实际改了主检出"曾让发布产物缺字段；
提交前用 `pwd` + `git status` 确认所在位置与预期一致。

分支模型与发布流程见 skill dsh-plugin-release。
