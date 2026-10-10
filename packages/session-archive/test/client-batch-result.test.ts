import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  createElement: (...args: any[]) => ({ args }),
  Fragment: "fragment",
  useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useRef: () => ({ current: null }),
  useMemo: (fn: any) => fn(),
  default: undefined,
}));

import { summarizeBatchResult } from "../client/index.tsx";

/**
 * 批量动作结果摘要回归 —— ledger「runBatch 单测」那一条的落点。
 *
 * 先说清对应关系：`grep -rn runBatch packages/session-archive` 只命中一处，
 * 是 `client/useArchiveActions.ts:137` 里 hook 内的局部箭头函数
 * `const runBatch = (action, doneKey, failKey) => {...}`——**它从来不是导出符号**，
 * 由 `restoreSelected`(:216, action="unarchive") 与 `deleteSelected`(:230,
 * action="delete") 调用。任务描述里说的「client 批量删除的批处理
 * (useArchiveActions.ts / ArchiveToolbar.tsx)」指的就是它；host 侧没有同名端点。
 *
 * 为什么不直接测 hook：runBatch 闭包依赖 19 个 setter/state，本仓无
 * @testing-library / renderHook 设施（已确认 node_modules 里没有），
 * 且既有 client 测试一律走「把纯逻辑抽成导出函数再测」的惯例
 * （见 client-export.test.ts / client-focus.test.ts / client-delete-guard.test.ts）。
 * 因此本轮把 runBatch 的**决策核**抽成 summarizeBatchResult 并在这里钉死；
 * hook 只负责把摘要喂给 setter。
 *
 * 与旧内联写法的两处刻意差异（都在畸形应答方向，正常应答逐例等价；
 * 已用旧实现逐字复刻跑对拍确认，见下方「对拍」用例）：
 * 1. `{deleted: "x", restored: ["r"]}`：旧 `result.deleted || result.restored` 会因
 *    "x" 为真值而取到非数组的 "x"，后续 `doneIds.length` 得到字符串长度；
 *    新实现按「是数组才取」回退到 restored → `["r"]`。**旧行为是 bug**。
 * 2. 非字符串元素（如 `["a", 1, null]`）：旧实现原样带进 `new Set(doneIds)`，
 *    与 item.sessionId（恒为字符串）比对必然不命中；新实现直接剔除。
 *    host 侧 deleted/restored 的类型是 `string[]`（archive-host-mutations.ts:52/247），
 *    故正常运行不会出现非字符串——此过滤只是纵深防御。
 */

describe("summarizeBatchResult", () => {
  it("delete 应答取 deleted", () => {
    const outcome = summarizeBatchResult({ deleted: ["a", "b"] });
    expect(outcome.doneIds).toEqual(["a", "b"]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.hiddenFailures).toBe(0);
    expect(outcome.restartCount).toBe(0);
  });

  it("unarchive 应答取 restored（同一段代码服务两个动作）", () => {
    expect(summarizeBatchResult({ restored: ["x"] }).doneIds).toEqual(["x"]);
  });

  it("deleted 优先于 restored（两者同时存在时取前者）", () => {
    expect(summarizeBatchResult({ deleted: ["d"], restored: ["r"] }).doneIds).toEqual(["d"]);
  });

  it("缺失/非数组字段一律当空，不产出 Undefined 计数", () => {
    for (const malformed of [undefined, null, {}, { deleted: null }, { deleted: "x" }, { deleted: 5 }, { deleted: {} }]) {
      const outcome = summarizeBatchResult(malformed as any);
      expect(outcome.doneIds, JSON.stringify(malformed)).toEqual([]);
      expect(outcome.restartCount).toBe(0);
    }
  });

  it("deleted 为非数组但 restored 合法时回退 restored（修掉「真值即取」的旧 bug）", () => {
    // 旧写法 `result.deleted || result.restored || []`：deleted="x" 是真值 → 取到字符串，
    // 后续 doneIds.length 变成字符串长度（1），面板会谎报「已删除 1 个」。
    // 新实现按「是数组才取」，回退到真正合法的 restored。
    expect(summarizeBatchResult({ deleted: "x", restored: ["r"] } as any).doneIds).toEqual(["r"]);
    expect(summarizeBatchResult({ deleted: 0, restored: ["r"] } as any).doneIds).toEqual(["r"]);
  });

  it("非字符串 id 被剔除（远端畸形应答不污染后续 Set 过滤）", () => {
    expect(summarizeBatchResult({ deleted: ["a", 1, null, undefined, "b", {}] }).doneIds).toEqual(["a", "b"]);
  });

  it("失败明细至多截 3 条，其余计入 hiddenFailures", () => {
    const failed = [1, 2, 3, 4, 5].map((i) => ({ sessionId: "s" + i, reason: "busy" }));
    const outcome = summarizeBatchResult({ failed });
    expect(outcome.failures.length).toBe(3);
    expect(outcome.failures.map((f) => f.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(outcome.hiddenFailures).toBe(2);
  });

  it("失败条数边界：0/1/2/3/4 条", () => {
    const mk = (count: number) => summarizeBatchResult({ failed: Array.from({ length: count }, (_, i) => ({ sessionId: "s" + i, reason: "live" })) });
    expect(mk(0).failures.length).toBe(0);
    expect(mk(0).hiddenFailures).toBe(0);
    expect(mk(2).failures.length).toBe(2);
    expect(mk(2).hiddenFailures).toBe(0);
    expect(mk(3).failures.length).toBe(3);
    expect(mk(3).hiddenFailures).toBe(0);
    expect(mk(4).failures.length).toBe(3);
    expect(mk(4).hiddenFailures).toBe(1);
  });

  it("failure 的 reason 原样保留（本地化交给 hook，未知 reason 才走兜底）", () => {
    const outcome = summarizeBatchResult({ failed: [{ sessionId: "s1", reason: "not-restorable" }, { sessionId: "s2" }] });
    expect(outcome.failures[0]!.reason).toBe("not-restorable");
    expect(outcome.failures[1]!.reason).toBeUndefined();
  });

  it("needsRestart 只计数；非数组当 0", () => {
    expect(summarizeBatchResult({ needsRestart: ["a", "b", "c"] }).restartCount).toBe(3);
    expect(summarizeBatchResult({ needsRestart: "a" }).restartCount).toBe(0);
    expect(summarizeBatchResult({}).restartCount).toBe(0);
  });

  it("部分成功：doneIds 与 failures 同时非空（面板据此出 warn 而非 error）", () => {
    const outcome = summarizeBatchResult({ deleted: ["a"], failed: [{ sessionId: "b", reason: "live" }] });
    expect(outcome.doneIds).toEqual(["a"]);
    expect(outcome.failures.length).toBe(1);
  });
});
