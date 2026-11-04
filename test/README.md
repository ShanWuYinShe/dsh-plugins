# 防腐烂回归（`test/*.test.ts`）

这个目录里的测试不是普通单元测试，而是**架构不变式的守卫**：它们把「拆分/清理之后不许悄悄
退化」这件事变成 CI 能拦住的红灯。README 面向用户、RELEASING.md 面向发布，本文件面向
**改代码的人**：这里有什么锁、怎么加一把新的。

## 为什么有这些锁

几次真实事故催生了它们：

1. **样式注入被搬进新模块却没人导入**：编译、类型检查、绝大多数测试都不会发现，只有运行时才
   暴露——设置卡片变成无样式。现在由 `module-graph.test.ts`（无孤儿模块）拦住。
2. **模块拆分后留下无人使用的导出/常量/文案**：不会报错，只会让表面积与文案表越来越不可信。
   现在由 `export-surface` / `internal-dead-code` / `locale-keys` / `css-classes` 拦住。
3. **CSS 变量拼错**（`--dsw-alias-state-warning-primary`，规范名是 `warn`）：运行时静默回退到
   硬编码 fallback，页面看着正常、暗色/高对比主题下才悄悄脱离主题色板——人眼 code review
   发现不了，`css-tokens.test.ts` 一次抓出 6 处。

共同点：**这类退化没有任何自然信号**，必须显式断言。

## 锁一览

| 文件 | 判据（一句话） |
| --- | --- |
| `module-map.test.ts` | 每个包入口的「模块一览」与实际磁盘模块一一对应（新增模块必须登记） |
| `disposer-static-scan.test.ts` | 每处 `.register(` 都在可回收原语（`ctx.effect`/`ctx.inject`/`slots.inject`/`useEffect`）内；`setTimeout`/`setInterval` 都有赋值+配对 clear（例外白名单带理由且必须真实命中） |
| `module-graph.test.ts` | 没有孤儿模块：每个模块都要被别的模块引用（副作用模块如 styles 必须被导入） |
| `import-paths.test.ts` | 每条相对导入都能解析到真实文件，且大小写与磁盘一致（macOS 上写错大小写、Linux 才炸） |
| `source-structure.test.ts` | 源码结构卫生：`export` 不与注释粘连、文件以换行结尾、无 CRLF 与制表符缩进、shipped 代码无 console.log/debug/info |
| `comment-references.test.ts` | 注释里的「见 <文件>」「见 <符号>」都真实存在 |
| `export-surface.test.ts` | 非入口模块的值转发导出必须真的有人从这个模块导入（包外消费者登记白名单） |
| `internal-dead-code.test.ts` | 未导出的顶层声明必须在同文件里被用到 |
| `root-declared-deps.test.ts` | 根 `scripts/**` 与 `test/**` 的第三方 import 都在根 `package.json` 声明（`declared-deps` 只覆盖 packages/*，根工具链此前无锁） |
| `declared-deps.test.ts` | `devDependencies` 里的每个包都要在包内源码中出现（声明了不用 = 依赖清单不可信；客户端 inject 提供方与 Typert 工件的运行时依赖登记在 ALLOWED_UNREFERENCED 并写明理由） |
| `entry-surface.test.ts` | Host 入口只导出 `name/inject/Config/apply`、Client 入口只导出 `name/inject/apply`，禁止 default / export *——测试用内部实现走相对路径，不冻结成包 API |
| `client-inject-manifest.test.ts` | 清单里的 `dsh.client.inject` 写的是**客户端包名**（模块图依赖），不是 cordis 服务名——写错会被 `graphRows.get()` 静默跳过、悄悄失去加载顺序保证 |
| `client-hardcoded-copy.test.ts` | client TSX 的产品可见文案必须走 typed locale 字典/`t(...)`：可见属性的字符串字面量与 JSX 文本节点不得直写（等价官方 `verify-client-ui-i18n`） |
| `locale-keys.test.ts` | 文案 key 都有引用；同一包内 en 与 zh 的键集完全一致 |
| `css-classes.test.ts` | 样式表里的每个类名都在本包 client 源码里出现 |
| `css-tokens.test.ts` | 插件手写的样式只引用宿主真实存在的 CSS 变量 |
| `config-patch-schema.test.ts` | `cordis.patch.yml` 的 `config` 顶层键 ⊆ 该包 `Config` 的 Schemastery schema 键（未知键会被静默剥离 = 用户配置被吞） |
| `bundle.test.ts` | 构建产物与元数据：manifest 契约（engines.dsh / manifestVersion / client inject / exports 标准键）、**零运行期依赖**（插件索引安装链前提）、Typert 工件导出与产物齐全、client bundle 冒烟、四个包的兜底边界、files 清单有货 |
| `loopback-parity.test.ts` | 两个包各自持有的回环守卫不许静默分叉；差异须逐项登记在根 test 的真值表里——当前是 provider-usage 委托宿主后的 4 项放宽 + 空串 Origin 这一处收紧 |
| `skill-facts.test.ts` | 技能文档里引用的标识符在实现里真实存在（外部事实走 `EXTERNAL_FACTS` 白名单） |
| `wait-for-budget.test.ts` | 每个 `vi.waitFor` 都显式声明 timeout（默认 1s 而 testTimeout 是 30s） |
| `docs-links.test.ts` | 每个 Markdown 相对链接都指向真实存在的文件（改文件名后别留死链） |
| `docs-commands.test.ts` | 文档里的每条 bun run 命令与 node scripts 调用都真实存在（改脚本名后别留错文档） |
| `no-runtime-cycles.test.ts` | packages 各 src 里没有值级导入环（类型环不算，行首匹配防注释误报） |
| `no-uncollected-tests.test.ts` | 每个 *.test.* 文件都在 vitest 收集范围内（放错目录/扩展名会静默不跑） |
| `build-hygiene.test.ts` | `lib/` 里每个模块都有活的源码（或属 typert 生成物），`client/client.cjs` 只在有 client 入口时存在——陈旧构建产物进不了 tarball |
| `plugin-display-meta.test.ts` | 四包都有 `locale/en|zh.json` 的 `meta.title/description` 与 `icon.svg`，且与市场元数据（PACKAGE_DISPLAY）同源 |
| `deprecated-api.test.ts` | 源码不使用 0.2.2-rc.1 已废弃的 4 个宿主调用面（`eventAt`/`snapshotEvents`/`ownEvents`/`SessionController.page`） |
| `client-manifest-contract.test.ts` | `dsh.client` 取值域：`platform: 'web'`、导出 `./client`，feature 插件不设 `immediately`/`external` |
| `dep-resolution-baseline.test.ts` | 声明 range、实际解析版本与 bun.lock 三方都等于 `engines.dsh` 基线（混入 pre-rc 实例即红） |
| `third-party-notices.test.ts` | client 产物内联第三方代码（typert remote-info）的包必须附 THIRD_PARTY_NOTICES 并进 `files`；**bin 构建闭包（esbuild metafile → `.workwork/bin-closure.json`）与 notices 表格的组件/版本逐条相等** |
| `coverage-baseline.test.ts` | 逐文件覆盖率棘轮基线：基线文件与 `vitest.config.ts` 的 include/exclude 推导面完全一致；基线里的全局阈值与配置同源；容差/写入逻辑反向自检（回退必红、容差内放行、新文件须达全局阈值、过期记录须清理） |
| `lock-index.test.ts` | 锁文件与索引表双向一致（单测在 UNIT_TESTS 登记，防索引腐烂） |
| `no-focused-tests.test.ts` | 测试文件里没有 .only / 裸 .skip / .todo（条件跳过 skipIf 不在此限） |

目录里另有 6 个**普通脚本测试**，不是守卫锁、不在此表：`dep-collect` /
`dsh-deps` / `plugin-market` / `publish-gate` / `scripts-cli` / `version-checks`
（测的是 `scripts/` 的行为，不是架构不变式）。

> **Typert 工件不再有手写三面一致锁**（原 `typert-surface-parity.test.ts` 已删）：
> 2026-10-29 起 `./typert` / `./remote` 由官方 `@deepseek-ai/dsh-typert-generator`
> 从 `@Remote` 装饰器与服务方法签名生成，「手写工件 ↔ 装饰器」的漂移面在结构上
> 不再存在；生成失败会让 `bun run build` 直接失败。

## 逐文件覆盖率棘轮（防回退）

覆盖率门禁分两层，不要混为一谈：

1. **全局阈值**：`vitest.config.ts` 的 `coverage.thresholds`，四个聚合百分比的粗网兜底；
2. **逐文件棘轮**：`scripts/coverage-baseline.json`（版本化、随代码提交）+ `scripts/coverage-ratchet.mjs`，
   保证每个纳入 coverage 的源文件**不得低于基线**（容差 0.2pp，只吸收覆盖率采集抖动）。
   `bun run test:coverage` = `build` → `vitest run --coverage` → 棘轮校验。

棘轮规则（脚本内实现，`test/coverage-baseline.test.ts` 锁住判据本身）：

- 已记录文件：四个指标（statements/branches/functions/lines）任一低于基线-0.2pp → 红；
- 基线里没有、coverage 面里有的**新增文件**：四个指标都必须达到全局阈值才能入基线；
- 基线有、覆盖率面没有的**过期记录**：红，提示清理（防止文件消失后旧记录掩盖未来回退）；
- 基线只升不降：`--write` 默认拒绝写入低于旧基线超过容差的值（要显式 `--lower`）。

维护命令：

```bash
bun run test:coverage                  # build + 全量测试 + coverage + 棘轮校验（本地/CI 同一条命令）
bun run coverage:ratchet --write       # 覆盖率提升后上调基线（新文件自动入基线、过期记录自动清理）
bun run coverage:ratchet --write --lower  # 显式放宽：仅限确实删除已验证代码/重构导致的可接受下降，
                                          # 必须在提交信息里说明；CI 不使用
bun run coverage:ratchet               # 只校验不写（等价 test:coverage 的最后一步）
```

官方 RULE-088 的**逐文件 100%** 仍是长期目标：棘轮先保证「今天不比昨天差」，基线文件让每个文件的
缺口可见、可追踪；提升某个文件后记得 `--write` 上调，避免它再次回退。改棘轮/基线后必须反向验证：
手动把基线里某文件某指标 +1pp → 校验红；还原后绿。新增源文件后必须刷新基线（否则锁会报缺记录）。

## 写一把新锁时的约定

1. **先有真实事故或明确风险**，再写锁。锁的成本是长期维护，别为「看起来更规范」而加。
2. **判据要贴着自己的意图写**，不要用近似代理：
   - 想禁「跨包 import」就检查 `from '...'`，别用「文件里出现包名」（注释会误伤）；
   - 想禁「悬空相对导入」要匹配 `from "..."` 形式，副作用导入 `import './x'` 不在判据内；
   - 统计 `vi.waitFor` 有没有 timeout 要**括号配对**，按行 grep 会漏掉跨行回调。
3. **必须带非空转守卫**：断言「扫到了足够多的文件/条目」，否则规则可能因为收集面为空而永远绿。
4. **例外要登记 + 写理由**：每个锁里的 `ALLOWED` / `EXTERNAL_*` 之类常量就是为此。白名单本身
   也要能被审计（写清为什么例外）。
5. **锁要排除自己**：文档注释里写的示例会被自己的规则扫到（`SELF` 排除，多个锁踩过同一坑）。
6. **改锁之后必须反向验证**：故意注入一个违规，确认报红，再还原确认变绿。**没有反向验证过的
   锁等于没有锁**——历史上出现过「因为正则写错而永远绿」的锁。
7. **性能**：扫描型锁要「一次读盘 + 一次建索引」。曾有一把锁对每个候选重扫全部文件
   （O(候选 × 文件)），单文件 3.4s；改成建索引后 0.14s。
8. 新增锁后：跑 `bun run test:ci`，并在提交信息里写明「判据 + 反向验证方式」。

## 相关

- 每个包入口的模块地图（`src/index.ts` / `client/index.tsx` 顶部注释）由 `module-map` 核对。
- 发布流程与分支纪律见 [RELEASING.md](../RELEASING.md)；命令清单见 [README.md](../README.md)。
