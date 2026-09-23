// @ts-nocheck
/**
 * typert.host.js — 手写的 Typert host 工件（typert-loader 机制）。
 *
 * 本包没有 Remote 服务：host 侧通过 `webServer` 注册同域额度路由
 * （`/plugins/provider-usage/usage`），浏览器侧的 pill 用 `fetch` 读取，
 * 不走 typert 网关。这里仍导出一个空的 TYPERT 工件，原因与
 * dsh-any-connect 相同：
 *
 * 1. monorepo 的 `test/bundle.test.ts` 断言每个包的 exports 都暴露
 *    `./typert`（该测试按 packages/ 目录派生包列表，无法为单个包豁免）；
 * 2. `dsh` 的包发现机制会按 exports 探测 `./typert`，缺失时 host 侧加载器
 *    会把它当作非标准包处理。
 *
 * schemas / invocations / model 全为空是合法形态：typert-loader 注册后不含
 * 任何端点，网关不认领任何路由，副作用为零。
 */

export const TYPERT = {
  package: '@chaoset/provider-usage',
  face: 'host',
  schemas: [],
  invocations: [],
  model: { services: [], events: [], objects: [] },
};
