# 发布与分支管理（RELEASING）

本仓库是「一套插件 × 两条 DSH 宿主线」的 monorepo。本文是分支、版本号、
发布流程的唯一权威约定，README 只留速查；两者冲突时以本文为准。

## 分支模型

| 分支 | 适配的 DSH 线 | 跟随的宿主版本 | 版本号形态 | Release 形态 |
|---|---|---|---|---|
| `main` | DSH 稳定线 | **dsh 已发布版本中最新的一版 rc**（没有正式版期间，rc 即正式版；当前值以 `bun run dsh-status` 为准） | 纯 semver（如 `0.10.3`） | 正式 Release |
| `alpha` | DSH 进行中的 alpha 线 | 基础号高于上述 rc 的最新 `-alpha`（无新线时与 `main` 同基线待命） | `-alpha.N` 后缀（进入 rc 阶段换 `-rc.N`，如 `0.10.4-alpha.0`） | prerelease Release |

**双线并行是常态，不是过渡方案**：DSH 快速迭代期间，稳定线与 alpha 预发布
线长期同时存在，两条分支各自跟随一条线持续维护。不变式只有一条：**main 的工作
树必须始终处于「可直接发布」状态**（版本号与依赖线 = 稳定线目标的下一个
候选），任何时刻都能直接热修稳定线。分支跟随的是 **DSH 宿主线**，不是「开发/
测试」阶段；用户装到哪个版本完全由版本号后缀决定（见 Release 形态规则），与改动
发生在哪个分支无关。

### 宿主跟随规则

DSH 的发布习惯：每条版本线都是 `<基础号>-alpha.N` 迭代若干版 → 进入 rc
（即稳定候选，也就是该线的正式版）→ **该基础号就此终结**——出了正式版就不
会有同基础号的 alpha——下一条线从一个更高基础号的 `<新基础号>-alpha.0`
重新开始（如 `0.1.2` 终结后是 `0.1.3-alpha.0`）。

> **宿主侧没有「正式版」这个独立产物：最新的一版 rc 就是该线的正式版。**
> dsh **从不发布无后缀的纯 `X.Y.Z`**（历数 npm 上的已发布版本，全部带
> `-alpha.N` / `-rc.N`，无一例纯 `X.Y.Z`；`npm view @deepseek-ai/dsh versions`
> 可随时复核），例如 `0.1.5-rc.*` 之后直接进 `0.1.6-alpha.1`。
> 因此不要等「dsh 0.1.6 正式版」这种不存在的版本；判断当前线是否终结、main
> 该跟哪一版，一律看**已发布版本里最新的 rc**。

归属判据是**版本号语义，不是任何 dist-tag**：dist-tag 会滞后或错位——同一条
rc 迭代多版时可能只有首版拿到 `latest`（2026-09-15 曾实测 `latest` 指
`0.1.5-rc.1`，而更新的 `0.1.5-rc.2` 挂在 `next`），`alpha` tag 则在线进入 rc
后就不再更新。拿 dist-tag 当目标会把已经跟到最新 rc 的 main 误报成「超前」
（2026-09-15 即因此误报过 `0.1.5-rc.2`）。脚本 `dsh-follow-status.mjs` 因此只读
npm 的**版本列表**：稳定线目标 = 非进行中预发布的最高版（rc 即正式版；将来若
真发无后缀正式版，它天然高于同基础号 rc，会自动成为目标）。

- **main 跟「最新 rc」（稳定线本身）**。
- **alpha 跟「基础号高于该 rc 的进行中 `-alpha` 线」**。这样的线存在
  时，alpha 分支依赖基线锚定它的最新版；**不存在时 alpha 与 main 同基线
  待命**——分支由最新 main 重建（见「双线生命周期」第 4 步），依赖范围、
  lockfile、exclude 清单全部等于 main，不发版，等 dsh 出更高基础号的新
  alpha 线再 `adapt` 跟进。

配套不变式：

- **待命期的暂替语义**：alpha 与 main 同基线时处于 main 形态（这是新线到
  来前的常态，不是待修正的漂移）。此状态下 alpha 不发版——它的版本号与
  main 相同，推送分支只跑测试；真要发版必须先 `adapt` 到新线并把版本
  bump 成 `-alpha.N`，再打 tag 推出。
- **不再维护「上一条线的 alpha 锚点」**：旧流程会让 alpha 维持
  `^0.1.2-alpha.5` 这类锚点，靠同基础号的 prerelease range 向上覆盖稳定线。
  现改为分支直接由 main 重建，基线天然等于稳定线目标，无需靠 semver 技巧
  覆盖，也不会出现两分支基线不同的中间态。

核对手段：`bun run dsh-status`（本地随时跑，输出稳定线、进行中线与两分支
基线的对照）；CI 的 `dsh-follow.yml` 每日定时核对（push 仅在核对脚本自身
变更时触发），不一致发
warning（刻意非阻塞——提醒，不是门禁）。

### dsh 适配归档 tag（main 专属）

main 分支的每次 dsh 稳定版适配都归档为一个 git tag，**由用户手工打，CI
绝不自动创建**（推送这类 tag 只跑测试，不触发任何发布）：

- **命名**：`dsh-v<dsh 版本>`（如 `dsh-v0.1.2-rc.1`），与包发布归档 tag
  （`<目录>-v<版本>`）同一模式、互不冲突——`dsh` 不是任何包的目录名。
- **时机**：跟进新稳定版、验证通过后手工打在对应提交上：
  `git tag dsh-v<基线> && git push origin dsh-v<基线>`（基线值取
  `bun run dsh-status` 的输出）。dsh 基线没变的日常开发不打；alpha 分支
  **不打**：它永远追随 dsh 最新的 alpha 线，没有按宿主版本回退的管理需求。
- **用途**：「该提交 = 对 dsh 此稳定版的已验证适配」。回退场景（如某次
  适配引入问题、或需要为旧版 dsh 维护热修）从对应 tag 拉：

  ```bash
  git checkout dsh-v0.1.2-rc.1          # 查看某次适配的代码状态
  git worktree add -b hotfix/dsh-0.1.2 dsh-v0.1.2-rc.1   # 以它为基线热修
  ```

  回退后重新发布需要按「版本号规则」把包版本跳到高于已归档版本（tag
  归档的旧版本号不可复用）。
- **历史说明**：tag 体系自 2026-09-05 起；更早的适配（`0.1.1-rc.2` 等）
  的提交点被历史回退与补丁打断，不做回填——需要时以提交信息定位。

### 功能收敛原则（alpha 只进不出）

**活跃 alpha 线期间，改动只落在 alpha，不回移 main。** alpha 是开发前沿：功能
开发、bug 修复、宿主适配、**文档与基础设施改动全部先在 alpha 落地**并发布为
prerelease Release；此时两分支**存在差异是预期状态**，不是需要立即抹平的漂移。
只要 dsh 开了 alpha 版本（有进行中的 alpha 线），**main 就整体搁置**——不
cherry-pick、不同步、不发布，直到该线发出最新 rc（即正式版）时，才把 alpha
累积的全部改动一次性合回 main（见「双线生命周期」第 4 步），并同步适配该正式版。

> 这条规则对**一切文件**生效，包括根文档（`AGENTS.md` / `RELEASING.md` /
> `README.md`）、`scripts/` 与 `.github/workflows/` 等通常被视为「基础设施」
> 的文件：alpha 期间它们也只在 alpha 上更新，不往 main 搬。理由是搁置期
> main 不发布、不开发，提前同步只会制造两处需要维护的副本；等收敛一次带过去
> 更省事、也不会出现「同一规则两个分支表述不同」的漂移。

允许的唯一例外：

- **稳定线紧急热修**：只在 dsh 稳定线用户遇到严重问题、且经明确指示时才动
  main——在该分支修复、打 tag 发 `latest`，随后把这处修复**带回 alpha**（避免收敛时
  被 alpha 的旧代码覆盖）。非紧急问题一律等 alpha 收敛，不在搁置期开热修。

这样规定的理由是**回移往往根本无处生效**：alpha 上的功能常依赖宿主新增能力，
在稳定线宿主上不成立。2026-09-15 的 session-archive 修复即为此例——它修的是
DSH 0.1.6-alpha 新增的原生「设置 → 已归档会话」页（0.1.5 稳定线既无该页面、
也无 `unarchive` 相关代码），强行回移 main 只会凭空多出一个用户拿不到的版本，
并让 main 的「可直接发布」状态掺入无法在稳定线验证的改动。

由此推论：

- **不写「两分支功能集一致」这类实时要求**：一致性是**收敛时点的结果**，不是
  活跃期的约束。活跃期只有一件事要做：所有改动都落在 alpha。
- **CHANGELOG 不做双记录**：alpha 线期间改动只记在 alpha 分支的
  `CHANGELOG.md`（`-alpha.N` / `-rc.N` 小节）；收敛进 main 时去掉预发布后缀，
  在 main 补写对应的正式版小节。
- **周期性体检**（每次宿主适配后跑一次）——目的是确认「没有不该出现的改动」，
  而不是要求零差异。因为搁置期**一切文件**都不搬 main，查的是全仓而非只有
  `packages/`：

  ```bash
  git diff main alpha          # 全仓；搁置期预期只有 alpha 单方面领先
  ```

  活跃期：差异 = alpha 线累积的全部改动（源码/文档/脚本/配置），属预期；要
  确认的是 **main 上没有本应只属于 alpha 的改动**（main 落后 alpha 是对的，
  反向超前才是出问题）。收敛后（alpha 已由 main 重建）：两分支预期**零差异**，
  此时若仍有差异即为漏合，需排查。

  另一项必查：`git merge-base --is-ancestor main alpha` 必须成立——**alpha 必须
  是 main 的后代**。若失败说明本轮 alpha 不是从最新 main 分叉的（历史上出过：
  从旧 main 分叉、缺一次稳定线修复），此时 baseline 只能靠人工同步补内容，
  属流程违规，应尽快按「双线生命周期」第 1 步重建。

## 版本号规则

- 遵循 semver：破坏性变更 MAJOR、新功能 MINOR、修复 PATCH。版本号只在本地
  手工修改（直接编辑各包 `package.json` 的 `version`），CI 绝不改写。
- **版本号是全时间线，alpha 线永远是开发前沿**：一个包的下一个预发布版本必须
  高于所有已归档版本（git tag `<目录>-v<版本>`，含稳定线）。不存在预发布版本
  低于稳定版的状态，发布门禁会强制这一点。
- **转正默认只去后缀，基础号不动**：alpha 线迭代时同一个基础号递增后缀
  （`0.3.14-alpha.0` → `0.3.14-alpha.1` → …；进 rc 后 `0.3.14-rc.1`），收敛
  进 main 时**保持基础号、仅去掉后缀**即成为正式版（`0.3.14-alpha.1` →
  `0.3.14`）。唯一的跳号例外见下方「稳定线热修占用基础号」——那是被迫让位，
  不是常规操作。
- **插件版本号与 dsh 版本号无关**：跟随宿主升级只改依赖 range 与 `dsh.host`，
  不改插件自身版本号的基础号；`0.3.14-alpha.1` 收敛得到的是 `0.3.14`，不是
  「dsh 的版本」。
- 预发布线发版：在 alpha 分支升 `-alpha.N` 的 N；dsh 线进入 rc 阶段后后缀换
  `-rc.N`（同一基础号内递增，`0.10.2-alpha.2` → `0.10.2-rc.1`），Release 自动
  带 prerelease 标记。
- 稳定线热修可能占用 alpha 线正在迭代的基础号（如稳定线发了 `0.3.2` 而 alpha
  在 `0.3.2-alpha.1`）——此时 alpha 线跳到下一个基础号（`0.3.3-alpha.0`）
  继续；门禁会拒绝一切低于已归档版本的发布。
- `dsh-any-connect` 历史遗留（npm 时代）：`0.3.1-alpha.0` / `0.3.1-alpha.1`
  低于稳定线的 `0.3.1`（旧约定产物，npm 上已发布无法撤回）。alpha 线自
  `0.3.2-alpha.0` 起回归上述不变式，不得再发布低于稳定线的版本。

## Release 形态规则

版本后缀自动决定 GitHub Release 的形态（`scripts/publish-gate.mjs` 派生）：
`-alpha.N` / `-rc.N` / `-beta.N` → 带 prerelease 标记的 Release；无后缀 →
正式 Release（按创建时间自然成为 Releases 页的 Latest）。安装命令：从
Releases 页取对应版本 tarball 资产的 URL，`dsh plugin add <tarball URL>`
（命令模板见各包 README；正式版/预发布版都按版本号装，不做隐式跟随）。

## 日常发布流程

**发布门槛：功能完全实现 + 本地 `bun run test:ci` 全绿 + dsh 测试实例真实
验证通过，三者齐备才 bump 版本并推送。** 版本一旦归档（git tag + Release）不可
撤回，"发布后
再验证发现问题再发一版"会产生大量无意义的版本号（2026-09-03 单日 6+ 版本、
2026-09-05 连发 0.10.4/0.10.5 的教训——后者是改动散落两个工作树，提交信息
声称新增的字段实际不在提交里，发布产物缺字段）。

1. 在目标分支改代码，`bun run test:ci` 全绿。
2. 启动隔离测试实例（独立 `DSH_HOME` + 本地路径安装插件），在真实浏览器
   里验证功能与控制台（详见 AGENTS.md「发布纪律」）。未通过就回到 1，
   **不要 push**。
3. 验证通过后，为每个受影响的包：
   - 在 `CHANGELOG.md` 顶部新增 `## <版本> (YYYY-MM-DD)` 小节——GitHub
     Release 说明自动取自这里（`scripts/release-notes.mjs`），不写就没有说明；
   - 升 `package.json` 的 `version`（bump 是最后一步）。
4. **推送前逐提交复核**（`git log --oneline origin/<分支>..HEAD` +
   `git diff origin/<分支>..HEAD`）：版本号、CHANGELOG 小节、实际 diff 三者
   必须互相印证——提交信息声称的每一项变更都要能在 diff 里找到，diff 里的
   每一处行为变更都要有 CHANGELOG 与版本号对应。**任何一项对不上就不要推**。
   另跑一遍 `bun run gate` 干跑，确认门禁视角下该版本可发布。
5. 推送分支。CI（`.github/workflows/test.yml`）只跑测试，永远不发布。
6. **明确要发版时才打 tag**：`git tag <目录>-v<版本> && git push origin <目录>-v<版本>`。
   tag 推出去即发版——CI（`.github/workflows/publish.yml`）对该 tag 执行：测试 →
   门禁校验（tag 形态、tag 与 package.json 版本一致、版本不落后已归档）→
   `bun pm pack` 出 tarball 并创建 GitHub Release 挂为资产（prerelease 版本带
   prerelease 标记）。**tag 由你明确打出，CI 绝不创建 tag**：没推 tag 就没有任何
   Release，不存在「顺手多发一版」。发版后核对 Release 的资产 tarball 与 `dsh.host`
   字段符合预期（解包资产读 `package/package.json` 的 `dsh.host`：
   `tar -xOf <tgz> package/package.json`）。

发布门禁（`scripts/publish-gate.mjs --tag <tag>`，只在 tag 流水里强制执行；
本地可用 `bun run gate` 干跑全仓计划）的判定，对该 tag 的包：

| 状态 | 结果 |
|---|---|
| tag 形态非法 / 目录未知 / 与 package.json 版本不一致 | **CI 失败**（tag 打错了，删 tag 重打） |
| 已归档版本中存在**更高**版本 | **CI 失败**（不许给落后版本发版；请升版本打新 tag） |
| 其余（版本高于已归档） | 发布（pack → Release 资产） |
| `dsh-v*` 归档 tag / 非发布形态 tag | 跳过（只跑测试，不发布） |

「更高版本」的比较口径按目标版本类型分两种，这决定了转正能否通过：

- **目标是预发布版本**（`-alpha.N` / `-rc.N`）：必须高于**所有**已归档版本，
  含稳定线——预发布永远在开发前沿。
- **目标是正式版**（无后缀）：只与已归档的**稳定版**比较（`publish-gate.mjs`
  的 `(isStable(version) ? isStable(v) : true)` 过滤）。因此 `0.3.14` 即便低于
  在途的 `0.3.14-alpha.1` 也允许发布——这正是「去后缀转正」的合法路径
  （semver 保证同基础号的正式版大于其预发布）。

发布中途失败：重跑该 tag 的流水（Actions 页面 Re-run jobs，或
`gh workflow run publish.yml -f tag=<tag>`）。tag 与已建的 Release 都已存在，
重跑只会补传缺失的资产，不会重复发布。

## 跨分支同步

**alpha 进行期间 main 整体搁置，什么都不搬。** 只要 dsh 有进行中的 alpha 线，
所有改动（源码、文档、`scripts/`、workflows、根配置）一律只落 alpha；main
停在原地，不 cherry-pick、不发布。本节规则只服务于**收敛**这一个时机——dsh
该线发完最新 rc（即正式版）后，按「双线生命周期」第 4 步把 alpha 的累积改动
压缩成单个提交搬进 main 并适配该正式版。

- **工作区隔离**：`main` 与 `alpha` 用 git worktree 并存（主检出目录停在活跃
  的 `alpha`，`.worktrees/main` 是稳定线工作树），不要在主检出目录里切分支——
  `lib/` 与 `node_modules` 不受 git 管理，切分支会残留上一条线的构建产物与
  依赖解析。进入任一工作树后先 `bun install`，构建产物可疑就重新 build。
- **收敛时搬源码**：只搬 `src/`、`client/`、`CHANGELOG.md` 和 `package.json`
  里与依赖无关的字段；**依赖 range 与 `bun.lock` 永不跨分支搬运**——
  到达 main 后按稳定线宿主版本核对依赖，`bun install` 重新生成 lockfile。
  两分支的 lockfile 差异巨大，跨分支直接 merge 它们必然冲突。收敛的完整做法
  （`adapt` 到该线最新 rc、去预发布后缀、`reset --soft origin/main` 压缩成单个
  提交、ff 合入 main）见「双线生命周期」第 4 步。
- **搁置期不搬「基础设施」**：根文档（`AGENTS.md` / `RELEASING.md` /
  `README.md`）、`scripts/`、`.github/workflows/`、根 `package.json` 等也只在
  alpha 更新，不在搁置期 cherry-pick 到 main——搁置期 main 不开发不发布，提前
  同步只会产生两处副本与表述漂移，收敛时随整条线一次带过去即可。各包
  `packages/*/README.md` 属包内容，同样随该包走。
- 根 `package.json` 的 `workspaces` 与 `trustedDependencies` 两分支保持一致
  （声明是静态的，不跟随宿主基线）；各分支的依赖差异只体现在 `bun.lock`
  里，收敛时按 main 的新基线重建，不直接搬运 lockfile。

## DSH 宿主升级适配

DSH 出新高基础号的 alpha 线（如 `0.1.2` 终结后的 `0.1.3-alpha.0`）后，在
alpha 分支：

```bash
node scripts/adapt-dsh.mjs 0.1.3-alpha.0   # 改全部 @deepseek-ai/dsh-* range
bun install                                 # 重新生成 lockfile
# 对照新宿主的 diff 复核用到的契约（参照历史 CHANGELOG 的记录方式），
# 升版本号、写 CHANGELOG，然后：
bun run test:ci && git push
```

`adapt-dsh.mjs` 支持 `--dry-run` 预览，它只改各 package.json 的依赖 range。若 `bun install` 报某 dsh 包解析不到，先检查 adapt 是否已把 range 改写。稳定线（main）跟进 dsh 新的 rc（如 `0.1.1-rc.2` → `0.1.2-rc.1`）时同样在 main 上执行同一流程。

`adapt-dsh.mjs` 同时把每个发布包 `package.json` 的 `dsh.host` 字段改写为
目标版本——那是 npm 消费者可见的「本包适配的宿主版本」声明
（`npm view <包名> dsh.host` 可查），跟随宿主版本自动维护，无需手工改。
`dsh-follow-status.mjs` 会核对它与依赖基线的一致性，漂移即 warning。

同一命令也用于让重建后的 alpha 分支跟进新预发布线：adapt 不比较新旧、按
指定版本整块覆写，因此「待命的 alpha 分支等到 dsh 新 alpha 线后开始适配」
就是 `node scripts/adapt-dsh.mjs <新线版本>` + `bun install`。

## 双线生命周期（常态循环）

alpha 分支是**一条用完即弃的适配线**：dsh 每出一条新 alpha 线，就从**最新的
main** 重新拉一条 alpha 分支来适配它；该线发完最新 rc（即其正式版）后，适配
成果压缩成单个提交合回 main，alpha 分支的**远程与本地一并删除**，等下一条线
再从最新 main 重建。alpha 分支**不需要长期存活**，因此不存在「把旧分支对齐回
最新」这类历史搬运。

> **起点必须是「当下的最新 main」**，不能复用上一轮的旧分支、也不能从旧
> main 分叉。这样 alpha 永远是 main 的后代：收敛时 `merge --ff-only` 必然
> 可行，且**基线天然继承稳定线的全部成果**，不依赖人工搬运。反例（2026-09-15
> 实际发生）：某轮 alpha 从 09-13 的旧 main 分叉，而 main 在 09-14 又落了
> 一次稳定线修复，导致 alpha 祖先链上**缺那次修复**，只能靠提交信息里的人工
> 「同步稳定线修复」补内容——一旦漏搬，收敛时就会把稳定线的修复覆盖掉。

1. **待命**：alpha 分支由最新 main 创建（`git branch alpha main`），代码与
   依赖基线等于 main，不发版。此时 dsh 无进行中的预发布线（上一条已终结）。
2. **dsh 出新高基础号的 alpha 线**（如 `0.1.3-alpha.0`）：alpha 分支执行
   「DSH 宿主升级适配」流程（`adapt` 到该线 + `bun install`），把包版本
   bump 成 `-alpha.N`，打 tag 发 prerelease Release。**main 就此整体搁置**——不再
   开发、不再发布、不接受任何 cherry-pick，直到该线发出正式版（第 4 步）；
   这期间的稳定线用户继续用 main 上已发布的最后一版 `latest`。
3. **alpha 线进入 rc**：该线开始发同基础号的 rc（如 `0.1.3-rc.1`、`0.1.3-rc.2`
   …）。rc 是稳定候选，**最新的一版 rc 就是这条线的正式版**——dsh 不会再发
   同基础号的 alpha，该线就此归 main 线，进入下面的收敛。
4. **dsh 该线发完最新 rc 后，插件收敛进稳定线**：触发条件是 dsh 已发布该线
   最新的 rc（无论是 `0.1.3-rc.1` 还是后续 rc.2/rc.3，**以版本列表里最新那版
   为准**，不看 `latest` tag 指向谁），**此前不动 main**。收敛必须在 alpha 的
   工作树里完成（不在主检出目录操作），分三件事：

   a. **`adapt` 到新正式版并去掉预发布后缀**：`node scripts/adapt-dsh.mjs
      <该线最新 rc>` + `bun install`，让依赖基线与 `dsh.host` 对齐这条线的
      正式版；把包版本去掉后缀（`0.3.2-alpha.0` → `0.3.2`；若稳定线热修已
      占用该基础号，先跳到下一个基础号），写 CHANGELOG。

   b. **压缩成单个提交**：整条 alpha 线的累积改动只留**一个**基于 main 的
      提交——历史干净、main 上不出现 alpha 的迭代过程：

      ```bash
      git fetch origin
      git reset --soft origin/main     # 内容全部保留在暂存区，历史回到 main
      git commit -m "…本轮适配与功能的完整说明…"
      ```

      `reset --soft` 只移动 HEAD、**不动工作区与暂存区**，因此 alpha 的全部
      成果原样保留，随后一次提交即得「一个 main 的后代提交」。**禁止
      `git merge`（会产生 merge commit）；禁止 `git merge --squash`（会绕过
      alpha 历史，且本条流程要求压缩在 alpha 侧完成）。**

   c. **验证后合入 main 并发布**：`bun run test:ci` 全绿 + 隔离实例真实
      验证，然后 `git merge --ff-only <alpha 分支>`（此刻它已是 main 的
      后代，必然可 ff）→ 推送 `main`（只跑测试），再给各包打 tag 发版
      （无后缀正式版即 `latest`）。

   > 若收敛期间 main 因**紧急热修**又前进了，`origin/main` 已不是刚才那位，
   > 需先把这条已压缩的提交 rebase 到最新 `origin/main` 之上（`git rebase
   > origin/main`）再 ff 合并——`reset --soft` 的目标必须始终是当下的
   > `origin/main`。

5. **删除 alpha：远程与本地都删**：发布完成后该 alpha 分支即完成使命
   （它的全部内容已进 main），**远程和本地都必须删除**，不留残留：

   ```bash
   git push origin --delete alpha   # 先删远程（远程只留主干 + CI 自动分支）
   git branch -D alpha              # 再删本地（-D 而非 -d：alpha 已被压缩成
                                    # 单个提交，不再是原分支的祖先，-d 会拒绝）
   ```

   随后从**最新的 main** 重建下一条待命 alpha（回到第 1 步）：

   ```bash
   git branch alpha main            # 由最新 main 创建，代码与基线等于 main
   git push origin alpha            # 全新分支，普通 push 即可（不需要 force）
   ```

   如此 alpha 的每次生命周期都是：**从最新 main 分叉 → 迭代若干提交 →
   压缩成 1 个提交合回 main → 远程与本地删除 → 再从最新 main 重建**。因为
   起点永远是当下的 main，alpha 永远是 main 的后代，既不会 diverged 需要
   force push，也不会出现「alpha 缺了 main 某次修复」的祖先链断裂——那正是
   靠人工同步才补上、极易漏搬的隐患。等 dsh 出下一条更高基础号的 alpha 线，
   回到第 2 步。

若某个时期同时活跃的宿主线超过两条，照同样模型再拉一条分支即可——分支数
跟随活跃宿主线数，Release 形态（prerelease 与否）始终由版本后缀决定、与分支
名无关。

> 历史说明：旧流程让 alpha 分支长期存活并「休眠」（维持上一条线的 alpha
> 锚点），收敛后还要反向 `git merge main` 对齐、再 `adapt` 回锚点。这既需要
> 额外发一轮 alpha 版本（否则门禁因 npm 已有更高版本变红），又会累积两分支
> 的平行历史。现改为「压缩 + 删旧建新」：alpha 迭代期间可以有很多提交（便于
> 逐步 review 与回退），但**合回 main 时压缩成一个**；alpha 分支本身随即
> 删除（远程与本地）再重建，因此它的起点永远是当下的 main，main 的历史里
> 也看不到 alpha 的迭代过程。

## 手动兜底

> **搁置期 main 流水不可用**：main 分支的 `publish.yml` 仍是 npm 时代流水
> （`pnpm publish --registry=registry.npmjs.org`），npm 渠道随 Trusted
> Publishing 收紧已死（alpha 线 926cbb8 迁移时的结论）。搁置期若需稳定线
> 紧急热修，推 main 不会产出 Release 资产，直接用下述 `pnpm pack` +
> `gh release create` 兜底；main 的 publish 流水留待双线收敛时随整线搬运。

CI tag 流水失败、或需要完全手工发版时，按顺序兜底：

1. **先在仓库根执行 `bun run build`**——`lib/` 与 `client/client.cjs` 都是
   gitignore 的构建产物，跳过构建直接 pack 会打出缺文件的 tarball（装上即坏）。
2. 自己打 tag 并推出，让 CI 走完发布：`git tag <目录>-v<版本> && git push
   origin <目录>-v<版本>`（tag 流水会自动测试 → 门禁 → 建 Release）。
3. CI 实在不可用时才完全手工：构建完成后 `cd packages/<pkg> && bun pm pack`
   （产物 `chaoset-<目录>-<版本>.tgz`），然后 `gh release create <目录>-v<版本>
   <tgz> --title "<npm 包名> v<版本>" --notes "<说明>"`（prerelease 版本加
   `--prerelease`；tag 须事先自己打好推出，`gh release create` 只建 Release；
   说明可用 `node scripts/release-notes.mjs <目录> <版本>` 生成）。

## 分支保护（暂不开启）

当前只有仓库所有者一人提交，未开启分支保护。若未来开放协作或 PR，建议给
`main` 与 `alpha` 开保护并要求 "Test" check 通过；发版 tag（`<目录>-v*`）
建议另用 ruleset 限制推送者——推 tag 即发版，tag 推送本身没有二次确认。
