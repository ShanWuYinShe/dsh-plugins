import { describe, expect, it, vi } from "vitest";
import { filterArchived } from "../client/index.tsx";

// 模块求值期引用 React（组件内才调用），这里只测纯函数 filterArchived，
// 给一个空桩让 import 通过即可（同 client-focus.test.ts 的做法）。
vi.mock("react", () => ({
  createElement: (...args: any[]) => ({ args }),
  useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useRef: () => ({ current: null }),
  useMemo: (fn: any) => fn(),
}));

const items = [
  { sessionId: "AAA-BBB", title: "修复登录页", cwd: "/proj/web", live: false },
  { sessionId: "CCC-DDD", title: "重构数据层", cwd: "/proj/api", live: false },
  { sessionId: "EEE-FFF", title: null, cwd: "/proj/web/docs", live: true },
];

/**
 * 归档筛选回归：子串不区分大小写匹配标题/工作区路径/会话 ID。筛选是
 * 大归档量下找会话的主路径，语义改动（如改成前缀匹配、丢掉某个字段）
 * 用户立即感知，用例即红。
 */
describe("filterArchived", () => {
  it("空/纯空白查询返回全部（副本，不是同一引用）", () => {
    for (const q of ["", "   "]) {
      const out = filterArchived(items, q);
      expect(out).toEqual(items);
      expect(out).not.toBe(items);
    }
  });
  it("子串不区分大小写匹配标题", () => {
    expect(filterArchived(items, "登录").map((i) => i.sessionId)).toEqual(["AAA-BBB"]);
    expect(filterArchived(items, "登录".toUpperCase()).map((i) => i.sessionId)).toEqual(["AAA-BBB"]);
    expect(filterArchived(items, "重构").map((i) => i.sessionId)).toEqual(["CCC-DDD"]);
  });
  it("匹配工作区路径", () => {
    expect(filterArchived(items, "/proj/api").map((i) => i.sessionId)).toEqual(["CCC-DDD"]);
  });
  it("匹配会话 ID（大小写不敏感）", () => {
    expect(filterArchived(items, "ccc").map((i) => i.sessionId)).toEqual(["CCC-DDD"]);
    expect(filterArchived(items, "aaa-bbb").map((i) => i.sessionId)).toEqual(["AAA-BBB"]);
  });
  it("title 为 null 的行按 cwd/ID 匹配，不抛错", () => {
    expect(filterArchived(items, "docs").map((i) => i.sessionId)).toEqual(["EEE-FFF"]);
  });
  it("无匹配返回空数组", () => {
    expect(filterArchived(items, "不存在的关键词")).toEqual([]);
  });
  it("trim 前后空白不影响匹配", () => {
    expect(filterArchived(items, "  登录  ").map((i) => i.sessionId)).toEqual(["AAA-BBB"]);
  });
});
