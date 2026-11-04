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
 * client 侧远程贡献回归（0.2.2 适配后的形态）。
 *
 * 贡献体不再手写：client 直接 import 官方 typert 生成器产出的 ./remote 工件
 * （descriptor/codec 由 src/remote.ts 的 @Remote 方法签名生成），$mount 收到
 * 的就是该工件。这里钉住「apply 确实挂载了生成工件」以及服务面集合不漂移。
 *
 * 描述符细节（参数 codec、typeSymbol）由生成器负责，包级测试不再重复断言；
 * 生成器接线由 scripts/typert.mjs 的确定性产出与根 bundle 回归覆盖。
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

describe("远程贡献来自生成工件", () => {
  it("package 正确，五个方法齐全（与 host 侧 @Remote 方法集合一致）", async () => {
    const contribution = await mountedContribution();
    expect(contribution.package).toBe("@chaoset/session-archive");
    expect(Object.keys(contribution.methods).sort()).toEqual([
      "sessionArchive/count",
      "sessionArchive/delete",
      "sessionArchive/detail",
      "sessionArchive/list",
      "sessionArchive/unarchive",
    ]);
    expect(contribution.descriptors.map((d: any) => d.method).sort()).toEqual(["count", "delete", "detail", "list", "unarchive"]);
  });

  it("每个描述符都带 generated strict codec（可 create 出 parser）", async () => {
    const contribution = await mountedContribution();
    for (const descriptor of contribution.descriptors) {
      expect(descriptor.invocation).toEqual({ kind: "direct" });
      expect(descriptor.result.mode).toBe("strict");
      expect(typeof descriptor.result.create).toBe("function");
      expect(typeof descriptor.result.create().parse).toBe("function");
      for (const parameter of descriptor.parameters) {
        expect(parameter.codec.mode).toBe("strict");
        expect(typeof parameter.codec.create().parse).toBe("function");
      }
    }
  });
});
