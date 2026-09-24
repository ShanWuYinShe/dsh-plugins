---
name: dsh-plugin-tag
description: Git tag 全生命周期操作：命名、annotated+签名、打/验/推 tag、逐个推送并逐条确认（GitHub 单次推送最多 3 个 tag，超过则全部不触发 CI）、打错处理、不可变铁律、ruleset 保护。触发：打发版 tag、一次发多个包、tag 被门禁打回、删错 tag、配签名、查 tag 归属时加载。发版流程本身见 dsh-plugin-release。
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

## 铁律一：tag 必须一个一个推（单次推送上限 3 个）

**一次推送超过 3 个 tag，GitHub 不会为其中任何一个产生 `push` 事件，CI
全程静默不触发，而且 `git push` 不报任何错。** GitHub 官方文档
（Events that trigger workflows，`push` 一节）原文：

> Events will not be created if more than 5,000 branches are pushed at once.
> **Events will not be created for tags when more than three tags are pushed
> at once.**

上限是**推送批次的粒度**，不是「前 3 个能过」——推 4 个 tag 是**全部**不触发。
本仓库 2026-09-24 实测印证：`dsh-any-connect-v0.4.2`、`provider-usage-v0.1.1`、
`sandbox-extra-roots-v0.4.14`、`session-archive-v0.3.16` 四个 tag 用一条命令同时
推送，Actions 里**零条 push 流水**（Releases 页那 4 个 Release 全是事后手工
`workflow_dispatch` 补出来的）。

这是最容易踩的坑：出错时**没有任何显式报错**，只有"发布了但 CI 没跑、Release
没出现"这种事后才发现的现象——而版本号已经推出去了，按「不可变铁律」不能
重来。`delete` 事件同样限 3 个一批，所以删 tag 也要一个一个删。

**不要用 `git push --tags`，也不要 `git push origin tag1 tag2 tag3 tag4`**：
前者会把本地所有 tag（含历史与不该发的）一次性推出，必然超限；后者就是要防
的批量推送。

## 铁律二：推一个 tag，等它跑完，再推下一个

逐个推送还不够——**推完不等就接着推，中间的 run 会被静默取消**。原因是
`publish.yml` 用了仓库级并发组：

```yaml
concurrency:
  group: publish
  cancel-in-progress: false
```

GitHub 的并发组**同一时刻只允许 1 个 running + 1 个 pending**，且默认
`queue: single`——**新排队的 run 会取消当前 pending 的那个**（官方
「Control the concurrency of workflows and jobs」原文：any existing `pending`
job or workflow in the same concurrency group will be canceled and the new
queued job or workflow will take its place）。

于是快速连推时：tag1 在跑 → tag2 变 pending → tag3 排队**把 tag2 顶掉** →
tag4 排队**把 tag3 顶掉**——tag2、tag3 的流水被取消，对应 Release 永远不会建，
而推送命令照样全部「成功」。

本仓库 2026-09-24 实测印证（手工补发那批）：

| run | 创建 | 结束 | 结果 |
|---|---|---|---|
| 36014030331 | 14:36:45 | 14:37:12 | success |
| 36014048743 | 14:36:55 | 14:37:02 | **cancelled（7 秒，被顶掉）** |
| 36014057179 | 14:36:59 | 14:37:41 | success |

等待**不额外增加总时长**：并发组本来就把这些 run 串行化了，一起推也只是排成
队列、还可能互相顶掉；逐个等反而总耗时相同且结果确定。

## 标准流程（发版 tag）

```bash
bun run gate                       # 1. 干跑，确认该版本可发布
git tag -a <目录>-v<版本> -m "<包名> v<版本>"   # 2. 打 annotated tag
git show <tag> --stat              # 3. 核对 tag 指向的提交与内容

# 4. 先推分支（只跑测试），确保 tag 落在远程已存在的提交上
git push

# 5. 再逐个推 tag：推一个 → 等它跑完 → 推下一个
git push origin <tag>
gh run list --workflow=publish.yml --branch <tag> \
  --limit 1 --json databaseId,event \
  --jq 'map(select(.event=="push")) | .[0].databaseId // empty'
```

**第 5 步的确认输出为空 = 没触发 push 流水，必须停下排查，不要继续推下一个**
（多半是批量推送超限，见铁律一）。`--branch` 接受 tag 名（实测 `gh 2.101.0`
对 `--branch session-archive-v0.3.15` 能返回该 tag 的 push 流水，真 tag 与不存在
的 tag 也能正确区分），这一条就是"该 tag 到底有没有触发 CI"的权威判据。

拿到 run id 后 `gh run watch <run-id> --exit-status` 跟随到结束（失败时以非零
码退出，便于脚本判定），**确认 success 再推下一个 tag**——既满足铁律二，也顺带
确保该包的 Release 已经建出来。

一次发多包（monorepo 常态）就是把第 5 步循环 N 遍：

```bash
for t in <目录1>-v<版本1> <目录2>-v<版本2>; do
  git push origin "$t" || break
  RUN=$(gh run list --workflow=publish.yml --branch "$t" --limit 1 \
    --json databaseId,event --jq 'map(select(.event=="push")) | .[0].databaseId // empty')
  [ -n "$RUN" ] || { echo "$t 未触发 CI，停止后续推送"; break; }
  gh run watch "$RUN" --exit-status || break
done
```

**已推过的 tag 重复执行 `git push origin <tag>` 是安全的空操作**（实测输出
`Everything up-to-date`，退出码 0）：远程已有该 ref 且内容一致时什么都不发生，
所以循环可以无脑重跑。也正因如此，重推**不会**补触发当初漏掉的 CI——漏了只能
按「打错处理」情形 B 删 tag 重来。

**分支推送永远用 plain `git push`，不用 `--follow-tags`**：该选项会把
annotated tags 顺带推出，让"显式打 tag"形同虚设，也会绕过本节的两条铁律。

## 打错处理（按情形）

- **A. 还没推**：`git tag -d <tag>` 删本地重打。
- **B. 已推，但 Release 还没建**（刚推就发现）：删本地再删远程，然后重打
  ```bash
  git tag -d <tag> && git push origin :refs/tags/<tag>
  ```
  删远程 tag 前先确认 Releases 页没有同名 Release。
  **批量推送超限、或 run 被并发组顶掉，都走这条**：tag 已推但没触发流水 /
  流水被取消，Release 必然没建，删掉重来即可——重推同一个 tag 不会补触发。
  删远程 tag 同样受"一批 3 个"限制，也要一个一个删。
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
