// @ts-nocheck
/**
 * typert.host.js — 手写的 Typert host 工件（typert-loader 机制）。
 *
 * 通过 typert-loader 把端点注册
 * 进 ctx.typert.local，避免依赖 Remote 装饰器 markers（typert-protocol
 * 双实例时 markers 丢失导致 SRC 认领为空、web 设置页 404）。
 */

const passthrough = (value) => value;
const codec = (typeSymbol) => ({
  mode: 'strict',
  typeSymbol,
  // 0.1.6-alpha.2 起 TypertCodec 的 schema 字段改为惰性 create 工厂
  // （typert-loader 校验 create() 存在，网关 decode/encode 调
  // codec.create().parse()），透传对象无状态，每次返回同一实例即可。
  create: () => ({ _zod: true, parse: passthrough }),
});

export const TYPERT = {
  package: '@chaoset/sandbox-extra-roots',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@chaoset/sandbox-extra-roots#sandboxExtraRootsConfig/get',
      service: 'sandboxExtraRootsConfig',
      namespace: 'sandboxExtraRootsConfig',
      method: 'get',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@chaoset/sandbox-extra-roots/types#SandboxExtraRootsConfig'),
      sourceLocation: { file: 'packages/sandbox-extra-roots/src/remote.ts', line: 1, column: 1 },
    },
    {
      id: '@chaoset/sandbox-extra-roots#sandboxExtraRootsConfig/set',
      service: 'sandboxExtraRootsConfig',
      namespace: 'sandboxExtraRootsConfig',
      method: 'set',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'partial',
          wire: 'partial',
          source: 'json',
          codec: codec('@chaoset/sandbox-extra-roots/types#PartialSandboxExtraRootsConfig'),
        },
      ],
      result: codec('@chaoset/sandbox-extra-roots/types#SetResult'),
      sourceLocation: { file: 'packages/sandbox-extra-roots/src/remote.ts', line: 1, column: 1 },
    },
  ],
  model: { services: [], events: [], objects: [] },
};