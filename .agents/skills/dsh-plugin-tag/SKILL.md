---
name: dsh-plugin-tag
description: Git tag 全生命周期操作：命名、annotated+签名、打/验/推 tag、打错处理、不可变铁律、ruleset 保护。触发：打发版 tag、tag 被门禁打回、删错 tag、配签名、查 tag 归属时加载。发版流程本身见 dsh-plugin-release。
---

# Tag 操作手册：命名、签名与不可变纪律

本仓库发版与否完全由用户手里的 tag 决定（推 tag 即发版，CI 绝不建 tag），
所以 tag 本身就是发布动作——打错一个 tag 等于误发一个版。本 skill 是 tag
的唯一操作口径。

## 命名

- 包发布 tag：`<目录>-v<版本>`（如 `dsh-any-connect-v0.3.19-alpha.2`），
  版本必须与该提交的 `packages/<目录>/package.json` 完全一致。
  这就是 release-please 等主流方案的 monorepo 命名（`<包>-v<版本>`），
  刻意对齐，不自创格式。
- 宿主适配归档 tag：`dsh-v<基线>`（如 `dsh-v0.1.2-rc.1`），只打在 main 上。
- 版本号一旦推出过就不可复用（见「不可变铁律」）。

## 必须 annotated，可选签名

发布 tag 必须是 annotated（Pro Git 明确推荐 release 用 annotated；门禁
`--tag` 模式用 `git cat-file -t` 强制执行，轻量 tag 直接红灯）：

```bash
git tag -a <目录>-v<版本> -m "<包名> v<版本>"
git cat-file -t <目录>-v<版本>   # 必须是 tag（轻量会显示 commit）
```

签名是推荐配置（GitHub 显示 Verified 徽标），属本机 git 配置、仓库不存密钥：

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global tag.gpgSign true
git tag -v <tag>   # 自验签名
```

## 标准四步（发版 tag）

```bash
bun run gate                       # 1. 干跑，确认该版本可发布
git tag -a <目录>-v<版本> -m "<包名> v<版本>"   # 2. 打 annotated tag
git show <tag> --stat              # 3. 核对 tag 指向的提交与内容
git push origin <tag>               # 4. 单独推出（推 tag 即发版）
```

**分支推送永远用 plain `git push`，不用 `--follow-tags`**：该选项会把
annotated tags 顺带推出，让“显式打 tag”形同虚设。

## 打错处理（按情形）

- **A. 还没推**：`git tag -d <tag>` 删本地重打。
- **B. 已推，但 Release 还没建**（刚推就发现）：删本地再删远程，然后重打
  ```bash
  git tag -d <tag> && git push origin :refs/tags/<tag>
  ```
  删远程 tag 前先确认 Releases 页没有同名 Release。
- **C. Release 已建**：永不删、不移动该 tag。升版本号打新 tag 发一版
  覆盖叙事（CHANGELOG 写明替代关系），旧版本号就地作废。

## 不可变铁律

1. 已推的发布 tag 永不 `-f` 移动、不删除重建——tag 即归档，动了等于改历史。
2. 版本号用过即作废：即使删了 tag（情形 B），同一版本号也不得用于第二次
   发布之外的内容；重打只允许 tag 内容逐字节一致的原样重打。
3. 历史遗留的轻量 tag（2026-09 前的 88 个）只读不碰：不重写、不补签名，
   只在门禁比较版本时引用。

## 保护（仓库设置，一次配好）

GitHub ruleset 给 tag 加两道锁（RELEASING.md「分支保护」）：

1. tag 名规则保护 `<目录>-v*` 与 `dsh-v*`：禁止删除（防手滑 `push :refs/tags/`）。
2. 可选：限制这两类 tag 的推送者（单人仓库可先不设）。

## hygiene

```bash
git tag -l "<目录>-v*" | sort -V          # 看某包全部已发版
git fetch --prune --prune-tags        # 同步远程已删的 tag 到本地
```

## 与 CI 的关系（一句话）

推 `<目录>-v<版本>` 触发 publish 流水（测试 → 门禁 → 建 Release）；推
`dsh-v*` 或其他 tag 只跑测试，不发布。门禁打回（形态/annotated/版本
不一致/落后归档）时按「打错处理」办，不要在 CI 里找绕过办法。
