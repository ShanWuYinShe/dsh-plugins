# @chaoset/session-archive — DSH 归档会话管理

补上 DSH 缺失的「归档后半程」：web 侧边栏底部新增**归档**面板。

- **查看归档**：列出全部归档会话（标题、目录、时间、体积）；点击
  会话可展开**只读浏览**其聊天内容（用户/助手文本消息）。
- **批量恢复**：勾选多个会话一键移回会话树，恢复其在原工作区的位置；无法
  恢复的会话（文件已删等）逐条给出原因。
- **彻底删除**：删除勾选会话的持久化文件与会话目录；两段式确认（第一次点击
  进入确认态，4 秒内再次点击执行）避免误删。正在生成落盘的会话（沉降观察窗
  内体积仍在增长）拒绝删除；若宿主允许归档运行中会话，插件同样拒绝。
- 工具条提供全选与已选计数；侧边栏徽标实时显示归档数量（订阅宿主归档集合，
  轻量轮询兜底）。

## 安装

> 适配的 DSH 版本见本包 `package.json` 的 `dsh.host` 字段；仓库的 `dsh-v*`
> git tag 是各次稳定版适配的归档点。

```bash
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/session-archive-v<版本>/chaoset-session-archive-<版本>.tgz
dsh plugin --profile web remove @chaoset/session-archive
```

`<版本>` 以 [Releases 页](https://github.com/ShanWuYinShe/dsh-plugins/releases)为准。
重启 web profile 后，侧边栏底部出现「归档」入口。其他安装来源见仓库根
`README.md` 的「安装」。

## 工作原理

- **列表**：宿主归档集合 ∩ 逐 id 持久化快照（官方 `stat(id)`，不枚举实例上
  的全部历史会话）；标题优先走宿主标题索引（`sessionQuery` 批量读，索引
  可用时全程零事件流读取），索引缺席/失败时回退折叠会话事件流的最后一个
  `session/title` 事件（事件流分块读取，峰值内存有界）；体积来自文件 stat。
- **查看**：只读解析会话事件流，提取用户/助手文本消息；超过 `detailMaxMessages`
  条时截断并如实标注。
- **恢复**：仅从归档集合移除仍存在持久化文件的会话 id，会话数据不动；文件已删
  的会话拒绝恢复，并在 `failed` 里逐条给出原因。
- **删除**：live 会话拒绝；每个会话删除持久化文件与会话目录。删除后**保留**
  该会话在归档集合中的占位 id——否则仍挂在内存中的会话会因「不再归档」立刻
  重新出现在侧边栏（效果等同恢复）；列表按文件存在性过滤，面板与侧边栏都不再
  显示该会话。删除后面板会刷新会话列表，已不在内存的会话随即从宿主「设置 →
  已归档会话」页消失；仍在内存中的会话（宿主无让内存会话消亡的官方 API）要等
  宿主重启，面板会明确提示。宿主内部形状变化时自动降级为「仅删文件」，功能
  不受影响。

## Remote API（`ctx.remote.sessionArchive`）

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `list()` | — | `{ items: ArchiveRow[] }` |
| `count()` | — | `{ count }`（存在性过滤后的归档数量，徽标轮询轻端点） |
| `detail(sessionId)` | 会话 id | `{ sessionId, header, title, messageCount, totalMessageCount, truncated, messages, live }` |
| `delete(sessionIds[])` | id 数组 | `{ deleted, failed, removedFromArchive, needsRestart }` |
| `unarchive(sessionIds[])` | id 数组 | `{ restored, failed, removedFromArchive }` |

> `delete` 与 `unarchive` 共用 `failed[].reason` 词表：`not-archived`（非归档
> 成员）、`live`（内存中未归档会话）、`busy`（内存存在且沉降观察窗内体积仍在
> 增长——活跃生成流）、`unenumerable`（文件存在但持久化枚举不到，或文件已删）、
> `unlocatable`（枚举得到但无法定位路径）、`reappeared`（删除后被生成流重建，
> 二次删除仍压不掉）、`not-restorable`（仅 unarchive：confirm 复核时文件已不在）；
> 其余为底层删除错误消息。

> `delete` 的 `removedFromArchive` 恒为 0（删除保留归档占位 id，见上）；
> `unarchive` 的为实际从归档集合移除的 id 数。`restored` 之外的每个请求 id
> 都会在 `failed` 里给出原因。
>
> `delete` 的 `needsRestart` 列出「文件已删、但内存会话仍在」的 id：这些条目
> 在宿主重启前仍会出现在原生「设置 → 已归档会话」页（内存会话没有官方消亡
> API）。已不在内存的会话不出现在其中——它们随面板的会话列表刷新即时消失。

`ArchiveRow`：`{ sessionId, title, cwd, createdAt, updatedAt, size, live }`。

## 配置

config 字段（`cordis.patch.yml` 或 `~/.dsh/plugins/session-archive/config.json`）：

- `detailMaxMessages`（默认 200）：查看时返回的最大消息条数。
- `messagePreviewChars`（默认 2000）：单条消息预览的最大字符数。
- `titleReadConcurrency`（默认 4）：列表加载时并发读取标题的并行度。

## 限制

- 正在生成落盘的会话拒绝删除——归档会话不在会话列表、无流可停，请稍后重试
  （沉降观察窗内体积不再增长即可删）。
- 首行损坏的孤儿日志被宿主枚举静默跳过：面板既看不到也无法经面板删除（删除
  会因 `unenumerable` 被拒绝），只能手动清理文件。
- 恢复归档走 DSH 官方的 `WorkspaceRegistry.unarchiveSession()`；未提供该
  方法的宿主上恢复返回空（列表仍按存在性过滤幽灵 id），功能不受影响。
- 已删除但仍在内存中的归档会话，其条目会一直留在宿主原生「设置 → 已归档会话」
  页，直到宿主重启（宿主没有让内存会话消亡的官方 API）；插件面板自身不受影响，
  删除时会明确提示。
