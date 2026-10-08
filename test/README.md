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
| `module-graph.test.ts` | 没有孤儿模块：每个模块都要被别的模块引用（副作用模块如 styles 必须被导入） |
| `import-paths.test.ts` | 每条相对导入都能解析到真实文件，且大小写与磁盘一致（macOS 上写错大小写、Linux 才炸） |
| `source-structure.test.ts` | 源码结构卫生：`export` 不与注释粘连、文件以换行结尾、无 CRLF 与制表符缩进 |
| `comment-references.test.ts` | 注释里的「见 <文件>」「见 <符号>」都真实存在 |
| `export-surface.test.ts` | 非入口模块的值转发导出必须真的有人从这个模块导入（包外消费者登记白名单） |
| `internal-dead-code.test.ts` | 未导出的顶层声明必须在同文件里被用到 |
| `declared-deps.test.ts` | `devDependencies` 里的每个包都要在包内源码中出现（声明了不用 = 依赖清单不可信） |
| `locale-keys.test.ts` | 文案 key 都有引用；同一包内 en 与 zh 的键集完全一致 |
| `css-classes.test.ts` | 样式表里的每个类名都在本包 client 源码里出现 |
| `css-tokens.test.ts` | 插件手写的样式只引用宿主真实存在的 CSS 变量 |
| `typert-surface-parity.test.ts` | 宿主 `remote.ts` ↔ `typert.host.ts` ↔ 浏览器 `REMOTE_CONTRIBUTION` 三面一致 |
| `bundle.test.ts` | 构建产物与元数据：字节一致文件、client bundle 冒烟、四个包的兜底边界 |
| `loopback-parity.test.ts` | 两个包各自持有的回环守卫不许静默分叉（差异只允许已登记的那一处收紧） |
| `skill-facts.test.ts` | 技能文档里引用的标识符在实现里真实存在（外部事实走 `EXTERNAL_FACTS` 白名单） |
| `wait-for-budget.test.ts` | 每个 `vi.waitFor` 都显式声明 timeout（默认 1s 而 testTimeout 是 30s） |
| `docs-links.test.ts` | 每个 Markdown 相对链接都指向真实存在的文件（改文件名后别留死链） |

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
