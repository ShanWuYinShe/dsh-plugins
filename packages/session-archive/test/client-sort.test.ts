import { describe, expect, it, vi } from "vitest";
import { sortArchived, ARCHIVE_SORT_KEYS } from "../client/index.tsx";

// 模块求值期引用 React（组件内才调用），这里只测纯函数 sortArchived，
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
  { sessionId: "old", title: "老会话", cwd: "/a", updatedAt: 1000, size: 10, live: false },
  { sessionId: "new", title: "新会话", cwd: "/b", updatedAt: 3000, size: 300, live: false },
  { sessionId: "mid", title: "中会话", cwd: "/c", updatedAt: 2000, size: 100, live: false },
  { sessionId: "notitle", title: null, cwd: "/d", updatedAt: 2500, size: 50, live: false },
];

describe("sortArchived", () => {
  it("time:最近修改在前", () => {
    expect(sortArchived(items, "time").map((i) => i.sessionId)).toEqual(["new", "notitle", "mid", "old"]);
  });
  it("size:体积大在前", () => {
    expect(sortArchived(items, "size").map((i) => i.sessionId)).toEqual(["new", "mid", "notitle", "old"]);
  });
  it("title:不区分大小写字典序,无标题行排最后", () => {
    // 数据全用英文:localeCompare 对非 ASCII(如中文)的排序位置依赖宿主
    // ICU,混排会引入环境相关的顺序不确定性,与本用例要钉的语义无关。
    const withCase = [
      { sessionId: "z", title: "beta", cwd: "/x", updatedAt: 1, size: 1, live: false },
      { sessionId: "a", title: "Alpha", cwd: "/x", updatedAt: 1, size: 1, live: false },
      { sessionId: "n", title: null, cwd: "/x", updatedAt: 1, size: 1, live: false },
      { sessionId: "g", title: "gamma", cwd: "/x", updatedAt: 1, size: 1, live: false },
    ];
    const out = sortArchived(withCase, "title");
    // alpha < beta < gamma(码元序 b<g),无标题行 n 最后。
    expect(out.map((i) => i.sessionId)).toEqual(["a", "z", "g", "n"]);
  });
  it("不改动入参数组(纯函数)", () => {
    const snapshot = [...items];
    sortArchived(items, "time");
    expect(items).toEqual(snapshot);
  });
  it("导出的排序键清单完整", () => {
    expect(ARCHIVE_SORT_KEYS).toEqual(["time", "size", "title"]);
  });
});
