import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  createElement: (...args: any[]) => ({ args }),
  Fragment: "fragment",
  useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useRef: () => ({ current: null }),
  useMemo: (fn: any) => fn(),
  useSyncExternalStore: () => null,
  default: undefined,
}));

import { apply } from "../client/index.tsx";

/**
 * client 侧远程贡献描述符回归（「client 最小类型」的守卫）。
 *
 * 背景：该描述符原先用大量 `passthroughSchema` + `any` 内联书写。本轮把
 * 「client 最小类型」的收窄落在 codec 上——`passthroughCodec(typeSymbol)` 返回
 * 显式类型的 `TypertCodec`——**而描述符本身仍逐条保持内联字面量**。
 *
 * 为什么不顺手抽成描述符工厂：仓根 `test/typert-surface-parity.test.ts` 用正则从
 * **源码文本**解析每条 descriptor 的 id/method/参数名再与宿主比对；抽工厂或模板
 * 拼 id 会让静态解析漏条目，等于悄悄废掉那条路由键回归。实测过一版工厂写法，
 * parity 只解析出 1/5 条。代价（五个方法各写一遍）换来的是这条回归仍然有效。
 *
 * 无论形态如何，**形状必须逐字不变**——描述符是 $mount 接线的输入，字段名或
 * typeSymbol 漂移会让网关静默接不上（不是编译期错误，因为类型已收敛）。所以这里
 * 把「挂载后真实拿到的描述符」整表钉死，而不是只断言函数存在。
 */

/** 走一次真实 apply()，捕获 $mount 收到的 contribution。 */
async function mountedContribution(): Promise<any> {
  let contribution: any;
  const ctx: any = {
    locale: { bind: () => (key: string) => key, register: () => {} },
    effect: () => {},
    slots: { inject: () => {}, register: () => {} },
    get: (name: string) => (name === "remote.sessionArchive" ? { list: async () => ({ ok: true, value: {} }) } : undefined),
    remote: { $mount: async (value: any) => { contribution = value; } },
  };
  await apply(ctx);
  return contribution;
}

describe("REMOTE_CONTRIBUTION 描述符", () => {
  it("package 与五个方法（与 host 侧 markRemoteMethod 对称）", async () => {
    const contribution = await mountedContribution();
    expect(contribution.package).toBe("@chaoset/session-archive");
    expect(contribution.descriptors.map((d: any) => d.method).sort()).toEqual(["count", "delete", "detail", "list", "unarchive"]);
  });

  it("每个描述符的接线字段与 typeSymbol 逐字确定", async () => {
    const contribution = await mountedContribution();
    const shaped = contribution.descriptors.map((d: any) => ({
      id: d.id,
      service: d.service,
      namespace: d.namespace,
      method: d.method,
      invocation: d.invocation,
      parameters: d.parameters.map((p: any) => ({ name: p.name, wire: p.wire, source: p.source, mode: p.codec.mode, typeSymbol: p.codec.typeSymbol })),
      result: { mode: d.result.mode, typeSymbol: d.result.typeSymbol },
    }));
    expect(shaped).toEqual([
      { id: "@chaoset/session-archive#sessionArchive/list", service: "sessionArchive", namespace: "sessionArchive", method: "list", invocation: { kind: "direct" }, parameters: [], result: { mode: "strict", typeSymbol: "sessionArchive/list:result" } },
      { id: "@chaoset/session-archive#sessionArchive/count", service: "sessionArchive", namespace: "sessionArchive", method: "count", invocation: { kind: "direct" }, parameters: [], result: { mode: "strict", typeSymbol: "sessionArchive/count:result" } },
      { id: "@chaoset/session-archive#sessionArchive/detail", service: "sessionArchive", namespace: "sessionArchive", method: "detail", invocation: { kind: "direct" }, parameters: [{ name: "sessionId", wire: "sessionId", source: "json", mode: "strict", typeSymbol: "sessionArchive/detail:sessionId" }], result: { mode: "strict", typeSymbol: "sessionArchive/detail:result" } },
      { id: "@chaoset/session-archive#sessionArchive/delete", service: "sessionArchive", namespace: "sessionArchive", method: "delete", invocation: { kind: "direct" }, parameters: [{ name: "sessionIds", wire: "sessionIds", source: "json", mode: "strict", typeSymbol: "sessionArchive/delete:sessionIds" }], result: { mode: "strict", typeSymbol: "sessionArchive/delete:result" } },
      { id: "@chaoset/session-archive#sessionArchive/unarchive", service: "sessionArchive", namespace: "sessionArchive", method: "unarchive", invocation: { kind: "direct" }, parameters: [{ name: "sessionIds", wire: "sessionIds", source: "json", mode: "strict", typeSymbol: "sessionArchive/unarchive:sessionIds" }], result: { mode: "strict", typeSymbol: "sessionArchive/unarchive:result" } },
    ]);
  });

  it("codec 恒等透传且 create() 每次可复用（同一 schema 实例）", async () => {
    const contribution = await mountedContribution();
    for (const descriptor of contribution.descriptors) {
      const schema = descriptor.result.create();
      const value = { items: [] };
      expect(schema.parse(value)).toBe(value);
      expect(descriptor.result.create()).toBe(schema);
      for (const parameter of descriptor.parameters) {
        const parameterSchema = parameter.codec.create();
        expect(parameterSchema.parse(value)).toBe(value);
      }
    }
  });
});
