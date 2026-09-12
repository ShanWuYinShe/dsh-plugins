# Changelog

## 0.3.12 (2026-09-12)

### Fixes

* 修复删除谎报成功的又一同源变体：`fileInfo` 外层兜底把 locate 抛错（后端
  异常/契约漂移）误判为「文件不存在」（absent），删除路径随后把它记成幂等
  删除成功——文件实际可能还在。现按语义表返回 `unknown`，对应删除路径的
  `unlocatable` 拒绝；恢复路径同样谨慎拒绝
* 收窄删除与恢复的并发竞态：`deleteArchived` 与 `unarchive` 的「检查 → 生效」
  窗口经插件闭包内的 promise 链互斥。registry 写锁只串行化归档集合写入而
  挡不住删除，此前并发时可能出现「文件被删、归档标记也被移出」——内存会话
  重回侧边栏，等同误恢复；反向则可能删掉刚恢复的会话文件。删除临界区内
  同时复验归档成员资格
* `detail` 对畸形 assistant 事件（缺 `data.message`）容错：一条损坏/异构
  日志不再让整个详情请求 TypeError
* 标题缓存加 500 条 FIFO 上限（已删会话的条目不再被 mtime 命中更新，长驻
  宿主进程下无界累积）；并发限制器宽度下限 1，直调传入 0/负数不再静默
  返回全 undefined 的列表
* 测试夹具的 `archivedSessionIds` 改为 getter（官方契约形态）：静态属性会在
  `setState` 后与内部 state 脱钩，host 侧集合快照永远读到旧值
* 新增 3 用例（locate 抛错拒绝删除、删除↔恢复互斥两变体、畸形事件容错）；
  build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.3.11 (2026-09-12)

### Fixes

* 修复已停止的归档会话删除报「运行中的会话不能删除，请先停止」（busy 误报）：
  归档会话因 web 客户端重连恢复 tab 而长期挂在宿主内存，而宿主的批量落盘
  timer、write-open 格式迁移、flush 检查点都会在没有生成的情况下刷新日志
  mtime——旧判定「内存存在且 60s 内有写入」因此把早已停止的会话永远判成
  busy。现改为沉降观察：仅当内存存在且 mtime 在窗口内时，等待一个沉降窗口
  （300ms）后对比文件体积，仍在增长（活跃生成流持续 append）才拒绝；
  体积静止照删，不在内存的冷文件不做观察直接删
* 修复 ghost 会话删除谎报成功：枚举不到的 ghost id 没有 header、拿不到
  cwd，jsonl 后端按 cwd 分目录，探测只能落缺省目录（`_no-cwd` 一类），
  既探不到真实文件也确认不了缺失——旧代码在探测落空时计入 deleted，
  文件实际可能仍在磁盘上（0.3.9「删除谎报成功」的同源变体）。现 ghost id
  一律按 `unenumerable` 拒绝，由列表存在性过滤隐藏；顺带移除探测路径上
  恒为 `undefined` 的死参数与相应死代码
* 客户端补 `ctx.locale.register` 重复注册防护（HMR/热切换下重复 apply 时
  异常会穿透 effect 阻断插件激活并触发宿主红条），与 sandbox-extra-roots
  对齐
* build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.3.10 (2026-09-11)

### Changes

* 跟进 DSH 稳定版 0.1.5-rc.2：全部 `@deepseek-ai/dsh-*` 依赖由 `^0.1.5-rc.1`
  升至 `^0.1.5-rc.2`，`dsh.host` 更新为 `0.1.5-rc.2`（rc.2 与 rc.1 逐包
  对比源码零差异，纯依赖 range 重发，无适配代码改动）
* build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.3.9 (2026-09-10)

### Fixes

* 修复归档面板恒空：DSH 0.1.3 起 `sessionPersistence.list()` 返回
  `SessionPersistenceSnapshot[]`（header 在 `.header` 上），旧代码直接读
  `item.id` 全为 undefined，归档 id 一个也匹配不上，列表永远为空。现按
  快照形状取 header
* 修复详情/标题读取：持久化契约已移除 `readFrom`，改为 `open(id,'read')`
  句柄读事件流（用完 close）
* 修复恢复/删除对历史会话失效：`locate()` 只按当前格式版本拼日志文件名，
  历史代际文件（`session.jsonl[.zstd]`、`session.v1.jsonl` 等）stat 落空，
  恢复被判「文件不存在」全部拒绝（「已恢复 0 个」）、删除谎报成功但文件
  还在。现按会话目录扫描实际代际文件（一会话一目录，目录路径不随代际
  变化）；同目录的 `session*` 同名族文件视为本会话历史代际而非他者日志
* 新增失败语义 `unlocatable`：文件存在但宿主后端无 `locate` 定位钩子时，
  删除不谎报成功也不误删，按失败上报并保留文件

### Changes

* 全面接入官方契约类型：`dsh.d.ts` 不再手写任何宿主方法形状，改为映射
  `@deepseek-ai/dsh-workspace` / `dsh-session` / `dsh-session-persistence` /
  `dsh-session-title` 官方 d.ts（新增 devDependencies，自带 cordis Context
  增强）——宿主契约漂移从此在 typecheck 期暴露，而非运行时
* host 逻辑仅走官方契约路径：标题折叠改用官方 `foldSessionTitle`
  （`dsh-session-title` 纯函数，行为与宿主逐字一致，含 `ignorable`/来源
  语义），替代手写折叠；assistant 消息文本按官方 `SessionEventMap` 从
  `data.message.content` 提取
* 归档集合移除通道（官方无 unarchive API）显式标注为宿主内部形状依赖
  （官方 d.ts 上 `enqueueOperation`/`requireState`/`setState` 为 private），
  运行时探测可用性，形状变化自动降级
* 跟进 DSH 稳定版 0.1.5-rc.1（合并 alpha 线 0.3.9-alpha.0 ~ alpha.2 的适配
  内容）：`@deepseek-ai/dsh-typert-protocol` 依赖由 `^0.1.2-rc.1` 升至
  `^0.1.5-rc.1`，`dsh.host` 更新为 `0.1.5-rc.1`
* 测试夹具重写为官方契约形状（快照 + 句柄 + 官方事件 data），新增快照形状、
  旧代际文件名、无 locate 降级三组回归用例；build + typecheck + 全量测试
  在 0.1.5-rc.1 依赖闭包上通过，并在隔离测试实例真实验证

## 0.3.8 (2026-09-05)

### Refactoring

* 可维护性清理，无功能变更：`BUSY_WRITE_WINDOW_MS`（忙碌写入窗口）
  与 `REAPPEAR_SETTLE_MS`（复验沉降等待）提为命名常量。

## 0.3.7 (2026-09-05)

### Fixes

* 上一版本（0.3.6）的 `dsh.host` 字段因改动散落两个工作树未随发布提交进入发布产物——本版本重新包含该字段。此外无任何变更。

## 0.3.6 (2026-09-05)

### Metadata

* package.json 新增 `dsh.host` 字段：声明本包适配的 DSH 版本，随每次
  宿主适配由 `adapt-dsh.mjs` 自动维护；`npm view <包名> dsh.host` 可查，
  README 安装节与仓库 `dsh-v*` 归档 tag 同步标注。无功能变更。

## 0.3.5 (2026-09-05)

### Fixes

* 删除归档会话时对会话目录做两道归属校验（目录名包含 sessionId 字面、
  目录内不含其他会话的 .jsonl 日志），任一不过则只删文件、保留目录并
  告警——官方布局是"一会话一目录"，但布局契约一旦变化（哈希目录名、
  多会话共目录），此前的递归删除会不可逆地连带其他会话数据

## 0.3.4 (2026-09-03)

### Changes

* alpha 线合并 + 稳定线跟进 DSH 0.1.2-rc.1：`@deepseek-ai/dsh-typert-protocol`
  由 `^0.1.1-rc.2` 升到 `^0.1.2-rc.1`（合入 alpha 线 0.3.4-alpha.0 /
  0.3.4-alpha.1 的适配内容，功能与 0.3.3 一致）
* 已对照 0.1.2-rc.1 全量 diff 官方包（36 个：逐包与 0.1.2-alpha.5 字节对比，
  除版本号外零差异——rc.1 是纯转正 bump）：面板远程服务的
  workspaceRegistry（`archivedSessionIds` / `enqueueOperation` /
  `requireState` / `setState`）与 sessionPersistence（`list` / `locate` /
  `readFrom`）契约、`session/title` / `user/message` / `assistant/message`
  事件形状与 alpha.5 适配时一致；全仓 build + typecheck + 162 项测试在
  rc.1 依赖闭包上通过

## 0.3.3 (2026-08-29)

### Features

* 加载反馈：列表与详情加载中显示 spinner +「加载中…」（respect
  `prefers-reduced-motion`），替代原先孤零零的 "…"；手动刷新列表时同样可见
  （静默刷新不打扰）

## 0.3.2 (2026-08-28)

### Bug Fixes

* 支持从源码运行的 DSH：typert-protocol 解析链首插安装闭包共享 fallback
  `$DSH_HOME/profiles/node_modules/<pkg>`，以 realpath 导入保证与 harness 同一
  模块实例；失败回落原有解析链。已对照 dsh 源码 0.1.2-alpha.1 复核
  workspaceRegistry / sessionPersistence 契约与事件形状无变化

## 0.3.1 (2026-08-28)

### Bug Fixes

* 适配 DSH 0.1.1-rc.2：`@deepseek-ai/dsh-typert-protocol` 依赖 range 从
  `^0.1.0-rc.8` 升到 `^0.1.1-rc.2`（npm semver 的 prerelease 规则下旧 range
  无法匹配 `0.1.1-rc.2`，新版宿主下面板远程服务会因官方包解析到旧版本而不可用）
* 已对照 0.1.1-rc.2 复核 workspaceRegistry / sessionPersistence / sessions
  契约与 `session/title`、`user/message`、`assistant/message` 事件形状：无变化

## 0.3.0 (2026-08-25)

### Features

* **实时徽标与列表**：订阅宿主 workspaces 服务的归档集合 store——会话菜单点
  「归档」、其它标签页变更、宿主推送 `host/archived-sessions-changed` 都即时
  反映到侧边栏徽标与打开中的面板，不再等 5s 轮询；集合含 ghost id 与 `count()`
  口径不同，故仅作触发信号、数目仍以 `count()` 为准；store 不可用时降级为纯轮询
* `count()` 调用失败自动退回一次 `list()` 取数并同步徽标：任何 host 版本组合下
  徽标都能自我纠正，不再卡在过期值
* **徽标 hover 与「设置」入口对齐**：几何与官方侧边栏设置触发按钮逐字一致
  （收起态 36×36 圆形、图标 18px）；根因修复：`.sa_root` 作为 flex 项会收缩到
  内容宽，显式撑满后 hover 命中面积与设置入口完全一致

### Bug Fixes

* `deleteArchived` 冷文件快速路径：不在内存且 60s 内无写入的归档删除跳过固定
  2×300ms settle 复验，批量清理陈旧归档从 ~12s/20 个降到 <1s；可能活跃的会话
  维持原两段复验与 `reappeared` 语义
* 徽标关闭态轮询在标签页隐藏时暂停、恢复可见立即刷一次并重启；面板打开期间
  新增 30s 静默刷新（数据不变不重渲染、不打断勾选）
* 批量删除成功后清理 `details`/`expanded` 缓存：内存不再随操作缓慢增长，
  展开态不再指向已删除的行

### Accessibility / UI

* 面板焦点管理：打开时焦点移入面板、关闭时归还徽标按钮
* 徽标按钮补回 `aria-label`（icon-only 场景 accessible name 自带语义与数量）
* warn 级通知独立 warn 色，不再与错误同红
* 面板 150ms 入场动画（淡入 + 轻微上移，respect `prefers-reduced-motion`）

## 0.2.4 (2026-08-23)

### Bug Fixes

* `SessionArchiveGateway` 缺少 0.2.3 引入的 `count()` 方法认领——徽标轮询端点
  实际返回 404（客户端静默吞错，表现为计数不更新）；补齐方法与 marker
* `detail()` 达到 `detailMaxMessages` 后只递增计数、不再做文本提取；响应新增
  `totalMessageCount` 与 `truncated`，客户端如实显示「共 N 条消息（已截断）」
* `deleteArchived` 对 ghost id 先经 `locate()` 探测孤儿文件：首行损坏、被
  `persistence.list()` 静默跳过的日志计入 `failed('unenumerable')`，不再谎报
  成功并把文件留在磁盘上
* rm 后约 300ms 复验：文件被进行中的生成流重建则再删一次，仍压不掉计入
  `failed('reappeared')`
* 客户端：列表浅比较未变化跳过重渲染；选择集自动剔除已消失项；批量异常提示带
  请求数量；零体积显示 "—"；`detail.messages` 渲染前加形状防御

### Accessibility

* 行标题由 span 改为真 button（键盘可达）；面板补 `role="dialog"` 与
  aria-label；Escape 关闭面板

## 0.2.3 (2026-08-22)

### Features

* `count()` 轻端点 + 按 mtime 的标题缓存：面板关闭态的徽标轮询不再每 5 秒
  全量解析归档事件流
* 删除失败原因端到端透出（`not-archived` / `busy` 等）
* 客户端：成功通知独立样式；删除确认锁定选择集并显示数量；批量失败原因逐条
  展示；detail 加载失败可重试；复选框 aria-label

### Bug Fixes

* `deleteArchived`/`detail` 前置校验归档成员资格：未归档的持久化会话不再可能
  经远程端点被不可逆删除/读取
* busy 判定 TOCTOU：rm 前重取 mtime 复核；unarchive 的存在性确认移入 registry
  写锁临界区，并发删除不再能把已删会话「复活」回侧边栏

## 0.2.2 (2026-08-22)

### Dependencies

* `@deepseek-ai/*` 更新到 0.1.0-rc.8

## 0.2.1 (2026-08-22)

### Refactor

* 重新发布 TypeScript 重构后的构建产物（tsc + esbuild 流水线）

## 0.2.0 (2026-08-21)

### Bug Fixes

* 展开态徽标的文字/图标状态跟随侧边栏 wide 属性

## 0.1.3 (2026-08-18)

### Bug Fixes

* 确认删除按钮 hover 红字红底不可读，改为红底白字

## 0.1.2 (2026-08-18)

### Bug Fixes

* 删除归档会话后保留归档集合占位 id，内存中的会话不再重新出现在侧边栏

## 0.1.1 (2026-08-17)

### Bug Fixes

* 归档会话不再被误标为运行中；恢复可勾选删除

## 0.1.0 (2026-08-17)

### Features

* 首个归档会话插件：归档列表、只读详情、批量恢复与彻底删除
