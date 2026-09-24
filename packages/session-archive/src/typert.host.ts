// @ts-nocheck
/**
 * typert.host.js — 手写的 Typert host 工件（typert-loader 机制）。
 *
 * DSH 的 typert-loader 会为「导出 ./typert 的 loader 条目」把本工件注册进
 * ctx.typert.local，于是 api-gateway 直接认领这些端点。这是官方扩展点：
 * 不依赖 remote.ts 的 Remote 装饰器 markers（markers 表是 typert-protocol
 * 模块私有的 WeakMap，当插件从 profile 安装、typert-protocol 与 harness
 * 各持一份模块实例时 markers 会丢失，SRC 认领为空，web 端报
 * "transport failure ... HTTP 404"）。
 *
 * codec.create() 返回 {_zod, parse}：typert-loader 要求 codec 提供 create()
 * 工厂，网关 decode/encode 走 codec.create().parse()。
 *
 * 参数（网关信任边界）用真校验：畸形输入在方法分发前即被拒绝；结果保持
 * 透传——结果由 host 端构造，校验它们只会增加与构造体的双重维护，不挡
 * 任何外部输入。方法层的同形手写检查（remote.ts）保留：单测直调网关方法
 * 不经过 codec，两处语义一致（改一处必须改另一处）。
 */

const passthrough = (value) => value;
/** 批量上限：面板勾选集现实中不足千级，超限直接拒绝（防网关层失控展开）。 */
const SESSION_ID_ARRAY_LIMIT = 5000;
const parseSessionId = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('sessionArchive expects a non-empty session id string');
  }
  return value;
};
const parseSessionIdArray = (value) => {
  if (!Array.isArray(value) || value.length > SESSION_ID_ARRAY_LIMIT
    || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new TypeError('sessionArchive expects an array of non-empty session id strings');
  }
  return value;
};
const codec = (typeSymbol, parse = passthrough) => ({
  mode: 'strict',
  typeSymbol,
  create: () => ({ _zod: true, parse }),
});

export const TYPERT = {
  package: '@chaoset/session-archive',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@chaoset/session-archive#sessionArchive/list',
      service: 'sessionArchive',
      namespace: 'sessionArchive',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@chaoset/session-archive/types#ArchiveListResult'),
      sourceLocation: { file: 'packages/session-archive/src/remote.ts', line: 1, column: 1 },
    },
    {
      id: '@chaoset/session-archive#sessionArchive/count',
      service: 'sessionArchive',
      namespace: 'sessionArchive',
      method: 'count',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@chaoset/session-archive/types#ArchiveCountResult'),
      sourceLocation: { file: 'packages/session-archive/src/remote.ts', line: 1, column: 1 },
    },
    {
      id: '@chaoset/session-archive#sessionArchive/detail',
      service: 'sessionArchive',
      namespace: 'sessionArchive',
      method: 'detail',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'sessionId',
          wire: 'sessionId',
          source: 'json',
          codec: codec('@chaoset/session-archive/types#SessionId', parseSessionId),
        },
      ],
      result: codec('@chaoset/session-archive/types#ArchiveDetailResult'),
      sourceLocation: { file: 'packages/session-archive/src/remote.ts', line: 1, column: 1 },
    },
    {
      id: '@chaoset/session-archive#sessionArchive/delete',
      service: 'sessionArchive',
      namespace: 'sessionArchive',
      method: 'delete',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'sessionIds',
          wire: 'sessionIds',
          source: 'json',
          codec: codec('@chaoset/session-archive/types#SessionIdArray', parseSessionIdArray),
        },
      ],
      result: codec('@chaoset/session-archive/types#DeleteResult'),
      sourceLocation: { file: 'packages/session-archive/src/remote.ts', line: 1, column: 1 },
    },
    {
      id: '@chaoset/session-archive#sessionArchive/unarchive',
      service: 'sessionArchive',
      namespace: 'sessionArchive',
      method: 'unarchive',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'sessionIds',
          wire: 'sessionIds',
          source: 'json',
          codec: codec('@chaoset/session-archive/types#SessionIdArray', parseSessionIdArray),
        },
      ],
      result: codec('@chaoset/session-archive/types#UnarchiveResult'),
      sourceLocation: { file: 'packages/session-archive/src/remote.ts', line: 1, column: 1 },
    },
  ],
  model: { services: [], events: [], objects: [] },
};
