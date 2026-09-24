// @ts-nocheck
/**
 * typert.host.js — 手写的 Typert host 工件（typert-loader 机制）。
 *
 * 通过 typert-loader 把端点注册
 * 进 ctx.typert.local，避免依赖 Remote 装饰器 markers（typert-protocol
 * 双实例时 markers 丢失导致 SRC 认领为空、web 设置页 404）。
 */

// set(partial) 的网关层校验：与 remote.ts 的同形检查语义一致（plain
// object），畸形输入在方法分发前即被拒绝。结果保持透传（见 session-archive
// 同名文件的注释：结果由 host 构造，不是不信任边界）。
const passthrough = (value) => value;
const parsePartial = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('set expects a plain config object');
  }
  return value;
};
const codec = (typeSymbol, parse = passthrough) => ({
  mode: 'strict',
  typeSymbol,
  // TypertCodec 使用惰性 create 工厂（typert-loader 校验 create() 存在，
  // 网关 decode/encode 调
  // codec.create().parse()），透传对象无状态，每次返回同一实例即可。
  create: () => ({ _zod: true, parse }),
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
          codec: codec('@chaoset/sandbox-extra-roots/types#PartialSandboxExtraRootsConfig', parsePartial),
        },
      ],
      result: codec('@chaoset/sandbox-extra-roots/types#SetResult'),
      sourceLocation: { file: 'packages/sandbox-extra-roots/src/remote.ts', line: 1, column: 1 },
    },
  ],
  model: { services: [], events: [], objects: [] },
};