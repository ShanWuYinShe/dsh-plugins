import { describe, expect, it } from "vitest";
import type { SessionHeader } from "@deepseek-ai/dsh-session";
import { resolveCachedArchiveTitle, SESSION_PROJECTION_CACHE_SERVICE } from "../src/session-projection-bridge.js";

/**
 * sessionProjectionCache 桥契约回归。
 *
 * 该模块是归档列表「标题零 I/O 读取」的唯一探测入口，判据：
 * 1. **只认 ctx.get**（真实 ctx 是 Proxy，未声明 inject 的服务直接读属性即抛）；
 * 2. **缺席/异形/抛错一律 undefined**：调用方据此回落 sessionQuery/直读，
 *    可选探测不得连累 list() 整单失败；
 * 3. **读取顺序与官方会话列表一致**：cachedSnapshot 优先、跨格式代际的
 *    cachedPredecessorTitle 兜底；null 是「缓存明确无标题」的有效事实。
 */

const header = { id: "s1", cwd: "/proj", createdAt: 1 } as unknown as SessionHeader;

describe("resolveCachedArchiveTitle", () => {
  it("服务键是字面量 'sessionProjectionCache'（钉死，防改名后探测静默落空）", () => {
    expect(SESSION_PROJECTION_CACHE_SERVICE).toBe("sessionProjectionCache");
  });

  it("形状正确时返回零 I/O 标题读取函数，且请求 title 键", () => {
    const seen: Array<{ header: unknown; keys: unknown }> = [];
    const service = {
      cachedSnapshot: (meta: SessionHeader, keys?: readonly string[]) => {
        seen.push({ header: meta, keys });
        return { values: { title: "缓存标题" }, asOfSeq: 3 };
      },
      cachedPredecessorTitle: () => void 0,
    };
    const read = resolveCachedArchiveTitle((name: string) => {
      expect(name).toBe("sessionProjectionCache");
      return service;
    });
    expect(typeof read).toBe("function");
    expect(read!(header)).toBe("缓存标题");
    expect(seen.length).toBe(1);
    expect(seen[0]!.header).toBe(header);
    expect(seen[0]!.keys).toEqual(["title"]);
  });

  it("缓存明确无标题（null）原样返回，不触发回退", () => {
    const read = resolveCachedArchiveTitle(() => ({
      cachedSnapshot: () => ({ values: { title: null } }),
      cachedPredecessorTitle: () => { throw new Error("predecessor must not be consulted when current row answers null"); },
    }));
    expect(read!(header)).toBeNull();
  });

  it("当前记录不可用时用 cachedPredecessorTitle 兜底", () => {
    const read = resolveCachedArchiveTitle(() => ({
      cachedSnapshot: () => void 0,
      cachedPredecessorTitle: () => ({ values: { title: "旧代际标题" } }),
    }));
    expect(read!(header)).toBe("旧代际标题");
  });

  it("缓存无行/标题值异形 → undefined（调用方回退批量/直读）", () => {
    const noRow = resolveCachedArchiveTitle(() => ({ cachedSnapshot: () => void 0, cachedPredecessorTitle: () => void 0 }));
    expect(noRow!(header)).toBeUndefined();
    for (const odd of [1, {}, [], true]) {
      const read = resolveCachedArchiveTitle(() => ({ cachedSnapshot: () => ({ values: { title: odd } }), cachedPredecessorTitle: () => void 0 }));
      expect(read!(header), String(odd)).toBeUndefined();
    }
  });

  it("读取抛错（坏缓存行）→ undefined，不把异常透给 list()", () => {
    const snapshotThrow = resolveCachedArchiveTitle(() => ({
      cachedSnapshot: () => { throw new Error("corrupt row"); },
      cachedPredecessorTitle: () => void 0,
    }));
    expect(snapshotThrow!(header)).toBeUndefined();
    const predecessorThrow = resolveCachedArchiveTitle(() => ({
      cachedSnapshot: () => ({ values: {} }),
      cachedPredecessorTitle: () => { throw new Error("corrupt predecessor"); },
    }));
    expect(predecessorThrow!(header)).toBeUndefined();
  });

  it("服务缺席（undefined/null/非对象）→ undefined", () => {
    for (const absent of [undefined, null, 0, "str", true]) {
      expect(resolveCachedArchiveTitle(() => absent), String(absent)).toBeUndefined();
    }
  });

  it("形状不符（两个读面缺一或不是函数）→ undefined", () => {
    for (const malformed of [
      {},
      { cachedSnapshot: 1 },
      { cachedPredecessorTitle: 1 },
      { cachedSnapshot: () => void 0 },
      { cachedPredecessorTitle: () => void 0 },
    ]) {
      expect(resolveCachedArchiveTitle(() => malformed), JSON.stringify(malformed)).toBeUndefined();
    }
  });

  it("get 本身抛错 / 极简 ctx 连 get 都没有 → undefined", () => {
    expect(resolveCachedArchiveTitle(() => { throw new Error("cannot get property without inject"); })).toBeUndefined();
    for (const noGet of [undefined, null, {}, 1, "get"]) {
      expect(resolveCachedArchiveTitle(noGet), String(noGet)).toBeUndefined();
    }
  });
});
