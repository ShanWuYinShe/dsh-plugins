import { describe, expect, it } from "vitest";
import { resolveSessionQueryTitles, SESSION_QUERY_SERVICE } from "../src/session-query-bridge.js";

/**
 * sessionQuery 桥契约回归。
 *
 * 该模块是「可选服务探测」的唯一入口，判据有两条且都不能松：
 * 1. **只认 ctx.get**：真实 ctx 是 Proxy，未声明 inject 的服务直接读属性即抛
 *    cannot get property without inject（dsh web 启动实测）。所以探测必须经 get；
 *    本文用「读属性即抛」的 Proxy 复现该语义，断言桥仍能工作。
 * 2. **缺席/异形/抛错一律 undefined**：调用方据此逐行回退直读。可选探测
 *    永远不得连累 host 主逻辑——把抛错透出去会让 list() 整单失败。
 */

describe("resolveSessionQueryTitles", () => {
  it("服务键是字面量 'sessionQuery'（钉死，防改名后探测静默落空）", () => {
    // 这条必须用字面量断言，不能回头引用 SESSION_QUERY_SERVICE——否则常量
    // 改了名测试自己也跟着改，规则空转（反向验证时实测过这个漏洞）。
    expect(SESSION_QUERY_SERVICE).toBe("sessionQuery");
  });

  it("形状正确时返回批量读函数，且用字面量键取值", async () => {
    const seen: unknown[] = [];
    const engine = {
      readTitleSnapshots: async (ids: readonly string[]) => {
        seen.push(ids);
        return ids.map((id) => ({ sessionId: id, status: "fulfilled" as const, value: { title: { title: "T" + id } } }));
      },
    };
    const resolve = resolveSessionQueryTitles((name: string) => {
      // 硬编码键：探测若取别的服务名，这里立即失败。
      expect(name).toBe("sessionQuery");
      return engine;
    });
    expect(typeof resolve).toBe("function");
    const results = await resolve!(["a", "b"]);
    expect(seen).toEqual([["a", "b"]]);
    expect(results.length).toBe(2);
  });

  it("服务缺席（undefined/null/非对象）→ undefined", () => {
    for (const absent of [undefined, null, 0, "str", true]) {
      expect(resolveSessionQueryTitles(() => absent), String(absent)).toBeUndefined();
    }
  });

  it("形状不符（无 readTitleSnapshots 或不是函数）→ undefined", () => {
    for (const malformed of [{}, { readTitleSnapshots: 1 }, { readTitleSnapshots: null }, { readTitleSnapshots: "x" }]) {
      expect(resolveSessionQueryTitles(() => malformed), JSON.stringify(malformed)).toBeUndefined();
    }
  });

  it("get 本身抛错 → undefined（极简 ctx 不连累主逻辑）", () => {
    expect(resolveSessionQueryTitles(() => { throw new Error("cannot get property without inject"); })).toBeUndefined();
  });

  it("极简 ctx 连 get 都没有（非函数）→ undefined", () => {
    for (const noGet of [undefined, null, {}, 1, "get"]) {
      expect(resolveSessionQueryTitles(noGet), String(noGet)).toBeUndefined();
    }
  });

  it("真 Proxy 语义下仍能探测到服务（读属性经 get 而非直接访问）", () => {
    // 复现 dsh web 的代理：未声明 inject 的服务直接读属性即抛。
    const target = {
      [SESSION_QUERY_SERVICE]: { readTitleSnapshots: async (ids: readonly string[]) => ids.map((id) => ({ sessionId: id, status: "fulfilled" as const, value: undefined })) },
    } as Record<string, unknown>;
    const proxied = new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === "get") return (name: string) => (obj as Record<string, unknown>)[name];
        if (prop in obj) return Reflect.get(obj, prop, receiver);
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    });
    const resolve = resolveSessionQueryTitles((proxied as any).get.bind(proxied));
    expect(typeof resolve).toBe("function");
  });
});
