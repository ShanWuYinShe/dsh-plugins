# 发布与分支管理（RELEASING）

本仓库是「一套插件 × 两条 DSH 宿主线」的 monorepo。本文是分支、版本号、
发布流程的唯一权威约定，README 只留速查；两者冲突时以本文为准。

## 分支模型

| 分支 | 适配的 DSH 线 | 跟随的宿主版本 | 版本号形态 | dist-tag |
|---|---|---|---|---|
| `main` | DSH 稳定线 | **dsh 已发布版本中最新的一版 rc**（没有正式版期间，rc 即正式版；当前值以 `pnpm run dsh-status` 为准） | 纯 semver（如 `0.10.3`） | `latest` |
| `alpha` | DSH 进行中的 alpha 线 | 基础号高于上述 rc 的最新 `-alpha`（无新线时与 `main` 同基线待命） | `-alpha.N` 后缀（进入 rc 阶段换 `-rc.N`，如 `0.10.4-alpha.0`） | `alpha` / `rc` |

**双线并行是常态，不是过渡方案**：DSH 快速迭代期间，稳定线与 alpha 预发布
线长期同时存在，两条分支各自跟随一条线持续维护。不变式只有一条：**main 的工作
树必须始终处于「可直接发布」状态**（版本号与依赖线 = 稳定线目标的下一个
候选），任何时刻都能直接热修稳定线。分支跟随的是 **DSH 宿主线**，不是「开发/
测试」阶段；用户装到哪个版本完全由版本号后缀决定（见 dist-tag 规则），与改动
发生在哪个分支无关。

### 宿主跟随规则

DSH 的发布习惯：每条版本线都是 `<基础号>-alpha.N` 迭代若干版 → 进入 rc
（即稳定候选，也就是该线的正式版）→ **该基础号就此终结**——出了正式版就不
会有同基础号的 alpha——下一条线从一个更高基础号的 `<新基础号>-alpha.0`
重新开始（如 `0.1.2` 终结后是 `0.1.3-alpha.0`）。

> **宿主侧没有「正式版」这个独立产物：最新的一版 rc 就是该线的正式版。**
> dsh **从不发布无后缀的纯 `X.Y.Z`**（截至 2026-09-15 的 21 个已发布版本全部
> 带 `-alpha.N` / `-rc.N`），例如 `0.1.5-rc.*` 之后直接进 `0.1.6-alpha.1`。
> 因此不要等「dsh 0.1.6 正式版」这种不存在的版本；判断当前线是否终结、main
> 该跟哪一版，一律看**已发布版本里最新的 rc**。

归属判据是**版本号语义，不是任何 dist-tag**：dist-tag 会滞后或错位——同一条
rc 迭代多版时只有首版可能拿到 `latest`（实测 `latest` 指 `0.1.5-rc.1`，而更新
的 `0.1.5-rc.2` 挂在 `next`），`alpha` tag 则在线进入 rc 后就不再更新。拿
dist-tag 当目标会把已经跟到最新 rc 的 main 误报成「超前」（2026-09-15 即因
此误报过 `0.1.5-rc.2`）。脚本 `dsh-follow-status.mjs` 因此只读 npm 的**版本
列表**：稳定线目标 = 非进行中预发布的最高版（rc 即正式版；将来若真发无后缀
正式版，它天然高于同基础号 rc，会自动成为目标）。

- **main 跟「最新 rc」（稳定线本身）**。
- **alpha 跟「基础号高于该 rc 的进行中 `-alpha` 线」**。这样的线存在
  时，alpha 分支依赖基线锚定它的最新版；**不存在时 alpha 与 main 同基线
  待命**——分支由最新 main 重建（见「双线生命周期」第 4 步），依赖范围、
  lockfile、exclude 清单全部等于 main，不发版，等 dsh 出更高基础号的新
  alpha 线再 `adapt` 跟进。

配套不变式：

- **待命期的暂替语义**：alpha 与 main 同基线时处于 main 形态（这是新线到
  来前的常态，不是待修正的漂移）。此状态下 alpha 不发版——它的版本号与
  main 相同，push 会被发布门禁以「已有 git tag」静默跳过；真要发版必须先
  `adapt` 到新线并把版本 bump 成 `-alpha.N`。
- **不再维护「上一条线的 alpha 锚点」**：旧流程会让 alpha 维持
  `^0.1.2-alpha.5` 这类锚点，靠同基础号的 prerelease range 向上覆盖稳定线。
  现改为分支直接由 main 重建，基线天然等于稳定线目标，无需靠 semver 技巧
  覆盖，也不会出现两分支基线不同的中间态。

核对手段：`pnpm run dsh-status`（本地随时跑，输出稳定线、进行中线与两分支
基线的对照）；CI 的 `dsh-follow.yml` 每日定时核对（push 仅在核对脚本自身
变更时触发），不一致发
warning（刻意非阻塞——提醒，不是门禁）。

### dsh 适配归档 tag（main 专属）

main 分支的每次 dsh 稳定版适配都会被发布流水自动归档为一个 git tag：

- **命名**：`dsh-v<dsh 版本>`（如 `dsh-v0.1.2-rc.1`），与包发布归档 tag
  （`<目录>-v<版本>`）同一模式、互不冲突——`dsh` 不是任何包的目录名。
- **时机**：publish.yml 的 main 流水成功（测试全绿 + 门禁走完）后自动打在
  触发提交上，幂等——dsh 基线没变的日常发布跳过；基线前进（跟进新稳定版）
  的首次成功流水落一个新 tag。alpha 分支**不打**：它永远追随 dsh 最新的
  alpha 线，没有按宿主版本回退的管理需求。
- **用途**：「该提交 = 对 dsh 此稳定版的已验证适配」。回退场景（如某次
  适配引入问题、或需要为旧版 dsh 维护热修）从对应 tag 拉：

  ```bash
  git checkout dsh-v0.1.2-rc.1          # 查看某次适配的代码状态
  git worktree add -b hotfix/dsh-0.1.2 dsh-v0.1.2-rc.1   # 以它为基线热修
  ```

  回退后重新发布需要按「版本号规则」把包版本跳到高于 npm 现有版本（tag
  归档的旧版本号不可复用，npm 版本不可撤回）。
- **历史说明**：tag 体系自 2026-09-05 起；更早的适配（`0.1.1-rc.2` 等）
  的提交点被历史回退与补丁打断，不做回填——需要时以提交信息定位。

### 功能收敛原则（alpha 只进不出）

**活跃 alpha 线期间，改动只落在 alpha，不回移 main。** alpha 是开发前沿：功能
开发、bug 修复、宿主适配、**文档与基础设施改动全部先在 alpha 落地**并发布到
`alpha` dist-tag；此时两分支**存在差异是预期状态**，不是需要立即抹平的漂移。
只要 dsh 开了 alpha 版本（有进行中的 alpha 线），**main 就整体搁置**——不 cherry-pick、
不同步、不发布，直到该线发出最新 rc（即正式版）时，才把 alpha 累积的全部改动
一次性合回 main（见「双线生命周期」第 4 步），并同步适配该正式版。

> 这条规则对**一切文件**生效，包括根文档（`AGENTS.md` / `RELEASING.md` /
> `README.md`）、`scripts/` 与 `.github/workflows/` 等通常被视为「基础设施」
> 的文件：alpha 期间它们也只在 alpha 上更新，不往 main 搬。理由是搁置期
> main 不发布、不开发，提前同步只会制造两处需要维护的副本；等收敛一次带过去
> 更省事、也不会出现「同一规则两个分支表述不同」的漂移。

允许的唯一例外：

- **稳定线紧急热修**：只在 dsh 稳定线用户遇到严重问题、且经明确指示时才动
  main——在该分支修复、发布 `latest`，随后把这处修复**带回 alpha**（避免收敛时
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

## 版本号规则

- 遵循 semver：破坏性变更 MAJOR、新功能 MINOR、修复 PATCH。版本号只在本地
  手工修改（直接编辑各包 `package.json` 的 `version`），CI 绝不改写。
- **版本号是全时间线，alpha 线永远是开发前沿**：一个包的下一个预发布版本必须
  高于 npm 上所有已发布版本（含稳定线）。不存在预发布版本低于稳定版的状态，
  发布门禁会强制这一点。
- **转正默认只去后缀，基础号不动**：alpha 线迭代时同一个基础号递增后缀
  （`0.3.14-alpha.0` → `0.3.14-alpha.1` → …；进 rc 后 `0.3.14-rc.1`），收敛
  进 main 时**保持基础号、仅去掉后缀**即成为正式版（`0.3.14-alpha.1` →
  `0.3.14`）。唯一的跳号例外见下方「稳定线热修占用基础号」——那是被迫让位，
  不是常规操作。
- **插件版本号与 dsh 版本号无关**：跟随宿主升级只改依赖 range 与 `dsh.host`，
  不改插件自身版本号的基础号；`0.3.14-alpha.1` 收敛得到的是 `0.3.14`，不是
  「dsh 的版本」。
- 预发布线发版：在 alpha 分支升 `-alpha.N` 的 N；dsh 线进入 rc 阶段后后缀换
  `-rc.N`（同一基础号内递增，`0.10.2-alpha.2` → `0.10.2-rc.1`），dist-tag
  自动变为 `rc`。
- 稳定线热修可能占用 alpha 线正在迭代的基础号（如稳定线发了 `0.3.2` 而 alpha
  在 `0.3.2-alpha.1`）——此时 alpha 线跳到下一个基础号（`0.3.3-alpha.0`）
  继续；门禁会拒绝一切低于已发布版本的发布。
- `dsh-any-connect` 历史遗留：`0.3.1-alpha.0` / `0.3.1-alpha.1` 低于稳定线的
  `0.3.1`（旧约定产物，已发布无法撤回）。alpha 线自 `0.3.2-alpha.0` 起回归
  上述不变式，不得再发布低于稳定线的版本。

## dist-tag 规则

版本后缀自动决定 dist-tag（`scripts/publish-gate.mjs` 派生）：`-alpha.N` →
`alpha`、`-rc.N` → `rc`、`-beta.N` → `beta`、无后缀 → `latest`。安装：
`npm install <pkg>` 拿正式版，`npm install <pkg>@alpha` 拿预发布线。

## 日常发布流程

**发布门槛：功能完全实现 + 本地 `pnpm run test:ci` 全绿 + dsh 测试实例真实
验证通过，三者齐备才 bump 版本并推送。** 版本一旦发到 npm 不可撤回，"发布后
再验证发现问题再发一版"会产生大量无意义的版本号（2026-09-03 单日 6+ 版本、
2026-09-05 连发 0.10.4/0.10.5 的教训——后者是改动散落两个工作树，提交信息
声称新增的字段实际不在提交里，发布产物缺字段）。

1. 在目标分支改代码，`pnpm run test:ci` 全绿。
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
5. 推送。CI（`.github/workflows/publish.yml`）自动执行：测试 → 状态式门禁 →
   发布 → 打 git tag `<目录>-v<版本>` → 创建 GitHub Release →（仅 main）按
   当前 dsh 基线更新 `dsh-v*` 归档 tag。发布完成后核对 npm 上的版本号与
   `dsh.host` 字段符合预期（`npm view <包名> version dsh.host`）。

发布门禁（`scripts/publish-gate.mjs`）的判定，按每个包依次：

| 状态 | 结果 |
|---|---|
| git tag `<目录>-v<版本>` 已存在 | 静默跳过（已发布并归档，重跑幂等的保证） |
| npm 上无该版本 | 发布 |
| npm 上已有该版本、但无 git tag | 警告跳过（tag 机制上线前的历史版本） |
| npm 上已有**更高**版本 | **CI 失败**（改了代码没升版本号从此是红灯，不再是静默跳过） |

「已有更高版本」的比较口径按目标版本类型分两种，这决定了转正能否通过：

- **目标是预发布版本**（`-alpha.N` / `-rc.N`）：必须高于 npm 上**所有**已发布
  版本，含稳定线——预发布永远在开发前沿。
- **目标是正式版**（无后缀）：只与 npm 上的**稳定版**比较（`publish-gate.mjs`
  的 `(isStable(version) ? isStable(v) : true)` 过滤）。因此 `0.3.14` 即便低于
  在途的 `0.3.14-alpha.1` 也允许发布——这正是「去后缀转正」的合法路径
  （semver 保证同基础号的正式版大于其预发布）。

发布中途失败：直接重跑整个 job。已发布的包被 git tag 跳过（tag 在发布成功
后才打），未完成的继续，不会重复发布。

## 跨分支同步

**alpha 进行期间 main 整体搁置，什么都不搬。** 只要 dsh 有进行中的 alpha 线，
所有改动（源码、文档、`scripts/`、workflows、根配置）一律只落 alpha；main
停在原地，不 cherry-pick、不发布。本节规则只服务于**收敛**这一个时机——dsh
该线发完最新 rc（即正式版）后，按「双线生命周期」第 4 步把 alpha 的累积改动
一次性搬进 main 并适配该正式版。

- **工作区隔离**：`main` 与 `alpha` 用 git worktree 并存（主检出目录停在活跃
  的 `alpha`，`.worktrees/main` 是稳定线工作树），不要在主检出目录里切分支——
  `lib/` 与 `node_modules` 不受 git 管理，切分支会残留上一条线的构建产物与
  依赖解析。进入任一工作树后先 `pnpm install`，构建产物可疑就重新 build。
- **收敛时搬源码**：只搬 `src/`、`client/`、`CHANGELOG.md` 和 `package.json`
  里与依赖无关的字段；**依赖 range 与 `pnpm-lock.yaml` 永不跨分支搬运**——
  到达 main 后按稳定线宿主版本核对依赖，`pnpm install` 重新生成 lockfile。
  两分支的 lockfile 差异巨大，跨分支 merge 它们必然冲突。收敛的具体做法
  （整理成 main 的后代提交、`adapt` 到该线最新 rc、去掉预发布后缀）见「双线
  生命周期」第 4 步。
- **搁置期不搬「基础设施」**：根文档（`AGENTS.md` / `RELEASING.md` /
  `README.md`）、`scripts/`、`.github/workflows/`、根 `package.json` 等也只在
  alpha 更新，不在搁置期 cherry-pick 到 main——搁置期 main 不开发不发布，提前
  同步只会产生两处副本与表述漂移，收敛时随整条线一次带过去即可。各包
  `packages/*/README.md` 属包内容，同样随该包走。
- `pnpm-workspace.yaml` 两分支内容不同（`minimumReleaseAgeExclude` 清单各自
  跟随本分支的宿主基线（由 adapt-dsh.mjs 整块重建），收敛时按 main 的新基线
  重建，不直接搬运该文件。

## DSH 宿主升级适配

DSH 出新高基础号的 alpha 线（如 `0.1.2` 终结后的 `0.1.3-alpha.0`）后，在
alpha 分支：

```bash
node scripts/adapt-dsh.mjs 0.1.3-alpha.0   # 改全部 @deepseek-ai/dsh-* range + exclude 清单
pnpm install                                # 重新生成 lockfile
# 对照新宿主的 diff 复核用到的契约（参照历史 CHANGELOG 的记录方式），
# 升版本号、写 CHANGELOG，然后：
pnpm run test:ci && git push
```

`adapt-dsh.mjs` 支持 `--dry-run` 预览；它按 lockfile 闭包整块重建 exclude
清单，宿主新引入的 dsh 子依赖会自动纳入。若 `pnpm install` 仍报某 dsh 包
解析不到（闭包外的新依赖），把该包手工补进清单后重试。稳定线（main）跟进
dsh 新的 rc（如 `0.1.1-rc.2` → `0.1.2-rc.1`）时同样在 main 上执行同一
流程；排除清单按本分支基线同样重建。

`adapt-dsh.mjs` 同时把每个发布包 `package.json` 的 `dsh.host` 字段改写为
目标版本——那是 npm 消费者可见的「本包适配的宿主版本」声明
（`npm view <包名> dsh.host` 可查），跟随宿主版本自动维护，无需手工改。
`dsh-follow-status.mjs` 会核对它与依赖基线的一致性，漂移即 warning。

同一命令也用于让重建后的 alpha 分支跟进新预发布线：adapt 不比较新旧、按
指定版本整块覆写，因此「待命的 alpha 分支等到 dsh 新 alpha 线后开始适配」
就是 `node scripts/adapt-dsh.mjs <新线版本>` + `pnpm install`。

## 双线生命周期（常态循环）

alpha 分支是**一条用完即弃的适配线**：dsh 每出一条新 alpha 线，就从最新的
main 重新拉一条 alpha 分支来适配它；该线发完最新 rc（即其正式版）后，适配
成果合回 main，旧 alpha 分支删除，等下一条线再从 main 重建。alpha 分支
**不需要长期存活**，因此不存在「把旧分支对齐回最新」这类历史搬运。

1. **待命**：alpha 分支由最新 main 创建（`git branch alpha main`），代码与
   依赖基线等于 main，不发版。此时 dsh 无进行中的预发布线（上一条已终结）。
2. **dsh 出新高基础号的 alpha 线**（如 `0.1.3-alpha.0`）：alpha 分支执行
   「DSH 宿主升级适配」流程（`adapt` 到该线 + `pnpm install`），把包版本
   bump 成 `-alpha.N` 发布到 `alpha` dist-tag。**main 就此整体搁置**——不再
   开发、不再发布、不接受任何 cherry-pick，直到该线发出正式版（第 4 步）。
   这期间的稳定线用户继续用 main 上已发布的最后一版 `latest`。
3. **alpha 线进入 rc**：该线开始发同基础号的 rc（如 `0.1.3-rc.1`、`0.1.3-rc.2`
   …）。rc 是稳定候选，**最新的一版 rc 就是这条线的正式版**——dsh 不会再发
   同基础号的 alpha，该线就此归 main 线，进入下面的收敛。
4. **dsh 该线发完最新 rc 后，插件收敛进稳定线**：触发条件是 dsh 已发布该线
   最新的 rc（无论是 `0.1.3-rc.1` 还是后续 rc.2/rc.3，**以版本列表里最新那版
   为准**，不看 `latest` tag 指向谁），**此前不动 main**。此时把 alpha 上累积
   的全部改动合回 main，同时让 main 跟进这个 rc。三件事一次做完：
   - 在 alpha 的工作树里把「alpha 的改动」整理成基于 main 的提交（两分支
     历史本就平行，`merge --ff-only` 直接合不了；用 `git reset --soft main`
     保留工作区内容再提交，或 `git cherry-pick` 逐个搬源码，二者皆可得一个
     main 的后代提交——**不要用会产生 merge commit 的 `git merge`**）；
   - `node scripts/adapt-dsh.mjs <该线最新 rc>` + `pnpm install`，
     让 main 的依赖基线与 `dsh.host` 对齐这条线的正式版；
   - 去掉预发布后缀（`0.3.2-alpha.0` → `0.3.2`；若稳定线热修已占用该基础
     号，先跳到下一个基础号），写 CHANGELOG，`pnpm run test:ci` 全绿 + 隔离
     实例真实验证，然后在主工作树 `git merge --ff-only <分支>` 并推送发布
     `latest`。
5. **删旧分支、从 main 重建 alpha**：发布完成后删除已合并的 alpha 分支，
   再从最新的 main 重新创建，回到第 1 步：

   ```bash
   git branch -d alpha              # 已合入 main，可安全删除
   git push origin --delete alpha   # 远程一并删除（远程只留主干 + CI 分支）
   git branch alpha main            # 由最新 main 重建，代码与基线等于 main
   git push origin alpha            # 全新分支，普通 push 即可（不需要 force）
   ```

   重建后的 alpha 与 main 同提交，因此永远不存在 diverged 需要 force push
   的状态。等 dsh 出下一条更高基础号的 alpha 线，回到第 2 步。

若某个时期同时活跃的宿主线超过两条，照同样模型再拉一条分支即可——分支数
跟随活跃宿主线数，dist-tag 始终由版本后缀决定、与分支名无关。

> 历史说明：旧流程让 alpha 分支长期存活并「休眠」（维持上一条线的 alpha
> 锚点），收敛后还要反向 `git merge main` 对齐、再 `adapt` 回锚点。这既需要
> 额外发一轮 alpha 版本（否则门禁因 npm 已有更高版本变红），又会累积两分支
> 的平行历史。现改为「删旧建新」，alpha 分支的历史长度永远等于「本轮适配的
> 提交数」，起点永远是当时的 main。

## 手动兜底

CI 失败或需要立即发布时：`cd packages/<pkg> && pnpm publish --access public
--no-git-checks --tag <dist-tag>`（本地需 npm 登录；CI 走 OIDC Trusted
Publishing）。之后手工补归档，否则门禁不认识这个版本：
`git tag <目录>-v<版本> && git push origin <目录>-v<版本>`；GitHub Release
在网页上补，说明用 `node scripts/release-notes.mjs <目录> <版本>` 生成。

## 分支保护（暂不开启）

当前只有仓库所有者一人提交，未开启分支保护。若未来开放协作或 PR，建议给
`main` 与 `alpha` 开保护并要求 "Publish to npm" / "Test" check 通过——本仓库
是 push 即发布（npm Trusted Publishing），保护能拦住误推直接进 npm。
