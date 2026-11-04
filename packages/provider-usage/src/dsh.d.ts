/**
 * 发布产物里的 Context 增强接线。
 *
 * `ctx.providerUsage` 的 `declare module '@deepseek-ai/cordis'` 增强写在
 * registry.ts（与 Service 实现同文件，契约与实现同处）。tsc 不会把只被函数体
 * 使用的 import 写进入口 d.ts，因此默认构建出的 lib/index.d.ts 不引用
 * registry.d.ts——消费者的 `import type {} from '@chaoset/provider-usage'`
 * 看不到该增强，按 README 的扩展示例写会编译失败。
 *
 * 构建脚本 scripts/build.mjs 会把本文件的内容并入 lib/index.d.ts（机制与
 * packages/sandbox-extra-roots/src/dsh.d.ts 相同），这里只负责把增强所在的
 * 模块拉进消费者的程序。
 */
import type {} from './registry.js'
