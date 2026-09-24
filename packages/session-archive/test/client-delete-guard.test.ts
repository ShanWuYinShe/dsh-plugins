import { describe, expect, it, vi } from "vitest";
import { ARCHIVE_PAGE_SIZE, DELETE_ACK_THRESHOLD, needsDeleteAck } from "../client/index.tsx";

// 同 client-focus.test.ts：模块求值期引用 React，给空桩通过即可。
vi.mock("react", () => ({
  createElement: (...args: any[]) => ({ args }),
  useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useRef: () => ({ current: null }),
}));

/**
 * 大批量删除确认闸回归：阈值以下的删除走原两段式（同按钮二次点击），
 * 阈值及以上的删除必须先勾选确认框——防“全选→双击节奏穿透”。
 * 阈值与判据任一漂移用例即红。
 */
describe("needsDeleteAck", () => {
  it("阈值钉为 5", () => {
    expect(DELETE_ACK_THRESHOLD).toBe(5);
  });
  it("未进入确认态不设闸", () => {
    expect(needsDeleteAck(0, false)).toBe(false);
    expect(needsDeleteAck(100, false)).toBe(false);
  });
  it("阈值以下不设闸（走原两段式）", () => {
    expect(needsDeleteAck(1, true)).toBe(false);
    expect(needsDeleteAck(4, true)).toBe(false);
  });
  it("阈值及以上设闸", () => {
    expect(needsDeleteAck(5, true)).toBe(true);
    expect(needsDeleteAck(100, true)).toBe(true);
  });
});

describe("ARCHIVE_PAGE_SIZE", () => {
  it("分页步长钉为 50（首屏只渲第一页）", () => {
    expect(ARCHIVE_PAGE_SIZE).toBe(50);
  });
});
