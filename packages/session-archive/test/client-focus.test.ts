import { describe, expect, it } from "vitest";
import { trapTarget } from "../client/archive-entries.js";

/**
 * 焦点陷阱判定回归：面板声明了 aria-modal，Tab 在首末元素处必须环绕，
 * 中间位置不干预。trapTarget 是接入处理器里的纯判定，删掉任一分支
 * 用例即红。
 */
describe("trapTarget", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };

  it("空列表返回 undefined（面板无可聚焦元素时不拦截）", () => {
    expect(trapTarget([], a, false)).toBeUndefined();
    expect(trapTarget([], a, true)).toBeUndefined();
  });
  it("Shift+Tab 在首元素回绕到末元素", () => {
    expect(trapTarget([a, b, c], a, true)).toBe(c);
  });
  it("Tab 在末元素回绕到首元素", () => {
    expect(trapTarget([a, b, c], c, false)).toBe(a);
  });
  it("中间位置不干预", () => {
    expect(trapTarget([a, b, c], b, false)).toBeUndefined();
    expect(trapTarget([a, b, c], b, true)).toBeUndefined();
    expect(trapTarget([a, b, c], a, false)).toBeUndefined();
    expect(trapTarget([a, b, c], c, true)).toBeUndefined();
  });
  it("单个元素时双向都回到自身", () => {
    expect(trapTarget([a], a, false)).toBe(a);
    expect(trapTarget([a], a, true)).toBe(a);
  });
});
