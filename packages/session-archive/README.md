# @chaoset/session-archive — DSH 归档会话管理

补上 DSH 缺失的「归档后半程」：web 侧边栏底部新增**归档**面板。

- **查看归档**：列出全部归档会话（标题、目录、时间、体积）；点击
  会话可展开**只读浏览**其聊天内容（用户/助手文本消息）。
- **批量恢复**：勾选多个会话一键移回会话树，恢复其在原工作区的位置；无法
  恢复的会话（文件已删等）逐条给出原因。
- **彻底删除**：删除勾选会话的持久化文件与会话目录；两段式确认（第一次点击
  进入确认态，4 秒内再次点击执行）避免误删。正在生成落盘的会话（沉降观察窗
  内体积仍在增长）拒绝删除；运行中会话不在归档集合，本就不会出现在面板里。
- **筛选与排序**：工具条输入框按标题、工作区路径或会话 ID 子串即时筛选
  （前端过滤，不发请求）；排序在最近修改/体积/标题间循环切换。筛选与排序
  在页面重载后保留（sessionStorage）。
- 工具条提供全选与已选计数（全选只作用于当前筛选结果）；列表分页加载避免
  大归档量全量渲染；侧边栏徽标实时显示归档数量（订阅宿主归档集合，轻量
  轮询兜底）。

## 安装

### 方式一（推荐）：插件索引

启用 DSH 的「自定义插件索引」实验性 bundle 后，在**发现 → 添加索引源**填入：

```text
https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/index.json
```

即可在发现页一键安装本插件、查看与安装任意历史版本（索引与静态 registry 由 CI 从
GitHub Releases 生成，发布在独立的 `market` 发布产物分支根目录（CI 生成，禁止手工编辑））。

**首次使用前（一次性）**：在目标 profile 的 `.npmrc` 里声明 `@chaoset` 的 scoped registry。不配置时，重启 DSH 后
GUI/CLI 的卸载与更新会回退默认 registry（npmjs）并报 `ERR_PNPM_META_FETCH_FAIL` 404：

```bash
printf '@chaoset:registry=https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/npm/\n' >> "$DSH_HOME/profiles/web/.npmrc"
```

配置后，安装/启用/停用/卸载/更新都可在 GUI 完成（重启后同样可用，`已安装 → 插件详情 → 版本` 可直接更新）；
CLI 也不再需要 `--registry`：

```bash
dsh plugin --profile web add @chaoset/session-archive@<版本>
dsh plugin --profile web remove @chaoset/session-archive
```

### 方式二：tarball URL（手动）
> 适配的 DSH 版本见本包 `package.json` 的 `engines.dsh` 字段（官方兼容声明：无破坏性变更的适配为同线兼容范围，宿主线内的 rc 都可安装）；
> 宿主 0.2.2 起要求 **Node.js >= 24.9**（`engines.node` 同步声明）。
> 仓库的 `dsh-v*` git tag 是各次稳定版适配的归档点。

```bash
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/session-archive-v<版本>/chaoset-session-archive-<版本>.tgz
dsh plugin --profile web remove @chaoset/session-archive
```

`<版本>` 以 [Releases 页](https://github.com/ShanWuYinShe/dsh-plugins/releases)为准。
重启 web profile 后，侧边栏底部出现「归档」入口。其他安装来源见仓库根
`README.md` 的「安装」。

## 工作原理

- **列表**：宿主归档集合 ∩ 逐 id 持久化快照（官方 `stat(id)`，不枚举实例上
  的全部历史会话）；标题优先读宿主官方持久化 projection 缓存
  （`ctx.sessionProjectionCache.cachedSnapshot()`，与官方会话列表同一数据源，
  零 I/O，命中时不读日志），缓存未命中才回退 `sessionQuery` 批量标题/折叠会话
  事件流的最后一个 `session/title` 事件（事件流分块读取，峰值内存有界），并按
  文件 mtime 在进程内缓存结果；体积/修改时间来自快照 `location` 的单次文件 stat。
  归档会话很多时，首屏成本不再与「逐条读整本日志」成正比。
- **查看**：只读解析会话事件流，提取用户/助手文本消息；超过 `detailMaxMessages`
  条时截断并如实标注。
- **恢复**：仅从归档集合移除仍存在持久化文件的会话 id，会话数据不动；文件已删
  的会话拒绝恢复，并在 `failed` 里逐条给出原因。
- **删除**：活跃生成中的会话经沉降观察窗拒绝（运行中会话不在归档集合，天然
  不可删）；每个会话删除持久化文件与会话目录。删除后**保留**
  该会话在归档集合中的占位 id——否则仍挂在内存中的会话会因「不再归档」立刻
  重新出现在侧边栏（效果等同恢复）；列表按文件存在性过滤，面板与侧边栏都不再
  显示该会话。删除后面板会刷新会话列表，已不在内存的会话随即从宿主「设置 →
  已归档会话」页消失；仍在内存中的会话（宿主无让内存会话消亡的官方 API）要等
  宿主重启，面板会明确提示。宿主内部形状变化时自动降级为「仅删文件」，功能
  不受影响。

## Remote API（`ctx.remote.sessionArchive`）

> 服务面用官方 `@Remote` 标准装饰器声明（`src/remote.ts`，边界类型在
> `src/types.ts`）；客户端消费的 `./remote` 调用面与宿主侧 `./typert` 工件
> 由官方 `@deepseek-ai/dsh-typert-generator` 在构建期生成。

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `list()` | — | `{ items: ArchiveRow[] }`（非 owner 逐会话 `remoteAccess.allows` 过滤） |
| `count()` | — | `{ count }`（存在性过滤 + 逐会话授权过滤后的数量，徽标轮询轻端点） |
| `detail(sessionId)` | 会话 id | `{ sessionId, header, title, messageCount, totalMessageCount, truncated, messages, live }` |
| `delete(sessionIds[])` | id 数组 | `{ deleted, failed, removedFromArchive, needsRestart }` |
| `unarchive(sessionIds[])` | id 数组 | `{ restored, failed, removedFromArchive }` |

> `delete` 与 `unarchive` 共用 `failed[].reason` 词表：`not-archived`（非归档
> 成员）、`busy`（内存存在且沉降观察窗内体积仍在
> 增长——活跃生成流）、`unenumerable`（文件存在但持久化枚举不到，或文件已删）、
> `unlocatable`（枚举得到但无法定位路径）、`reappeared`（删除后被生成流重建，
> 二次删除仍压不掉）、`not-restorable`（仅 unarchive：confirm 复核时文件已不在）；
> 其余为底层删除错误消息。

> 五个方法都支持取消：`signal` 由 Gateway 注入（不进 wire 参数），Host 侧透传给
> 持久化 `open/read/stat`、标题索引与批量循环；调用方取消后不再继续读文件。
>
> `delete` 的 `removedFromArchive` 恒为 0（删除保留归档占位 id，见上）；
> `unarchive` 的为实际从归档集合移除的 id 数。`restored` 之外的每个请求 id
> 都会在 `failed` 里给出原因。
>
> `delete` 的 `needsRestart` 列出「文件已删、但内存会话仍在」的 id：这些条目
> 在宿主重启前仍会出现在原生「设置 → 已归档会话」页（内存会话没有官方消亡
> API）。已不在内存的会话不出现在其中——它们随面板的会话列表刷新即时消失。

`ArchiveRow`：`{ sessionId, title, cwd, createdAt, updatedAt, size, live }`。

## 配置

config 字段（`cordis.patch.yml`；配置只走官方 config-editor，旧版自建 `config.json` 迁移已删除）：

- `detailMaxMessages`（默认 200）：查看时返回的最大消息条数。
- `messagePreviewChars`（默认 2000）：单条消息预览的最大字符数。
- `titleReadConcurrency`（默认 4）：列表加载时并发读取标题的并行度。

三者均由官方 `Config` schema（Schemastery，正整数校验）声明；patch 里写
非正整数会在 apply 时经 logger 告警并回退默认值，未知字段被忽略。

失败与异常：

- 客户端按 Remote 错误 code 展示本地化文案（`session-archive/not-archived`、
  `remote-access/denied`、`gateway/cancelled`；未知 code 回退技术文本 + code）。
- 会话目录与代际文件的清理先做 `lstat`：目录被替换成符号链接、或目录内条目是
  符号链接时**不跟随**，只删除持久化定位到的真实文件并给出告警。

## 限制

- **仍在宿主内存中的会话拒绝删除**（`busy`）：判定读宿主 `ctx.sessions` 的显式状态，
  不再依赖 mtime/体积增长等墙钟启发式。宿主重启或该会话被卸载后即可删除；这正是
  `needsRestart` 字段在实践中不再产生的原因（保留仅为删除竞态兜底）。删除后立即做一次
  无等待的文件复验：文件被重建会再删一次，仍存在则记 `reappeared` 失败。
- 首行损坏的孤儿日志被宿主枚举静默跳过：面板既看不到也无法经面板删除（删除
  会因 `unenumerable` 被拒绝），只能手动清理文件。
- 宿主未挂载持久化 projection 缓存（部分 headless/SDK 部署）时，列表标题只能在
  首次展开时回退批量/逐条读日志（结果随后按 mtime 缓存）； `web` 部署默认挂载该
  缓存，不付这笔成本。
- 恢复归档走 DSH 官方的 `WorkspaceRegistry.unarchiveSession()`（宿主必填
  契约，缺失即契约漂移，typecheck 直接红灯）。
- 归档会话的列表/计数对非 owner Peer 逐会话授权过滤；详情/删除/恢复沿用官方
  `@Remote` 资源声明，非 owner 只能触达被授权的会话。
- 已删除但仍在内存中的归档会话，其条目会一直留在宿主原生「设置 → 已归档会话」
  页，直到宿主重启（宿主没有让内存会话消亡的官方 API）；插件面板自身不受影响，
  删除时会明确提示。
