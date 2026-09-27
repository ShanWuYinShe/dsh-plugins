import { describe, expect, it, vi } from "vitest";
import { detailToMarkdown, exportFilename, mergeArchivedMarkdown } from "../client/index.tsx";

vi.mock("react", () => ({
  createElement: (...args: any[]) => ({ args }),
  useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useRef: () => ({ current: null }),
  useMemo: (fn: any) => fn(),
}));

const item = { sessionId: "AAA-BBB", title: "修复登录页", cwd: "/proj/web" };
const detail = {
  sessionId: "AAA-BBB",
  messages: [
    { role: "user", text: "你好", time: 1000 },
    { role: "assistant", text: "你好！有什么可以帮你？", time: 2000 },
  ],
};

describe("detailToMarkdown", () => {
  it("标题/元信息/消息按 Markdown 分节", () => {
    const md = detailToMarkdown(item, detail);
    expect(md.startsWith("# 修复登录页")).toBe(true);
    expect(md).toContain("- session: `AAA-BBB`");
    expect(md).toContain("- workspace: `/proj/web`");
    expect(md).toContain("- messages: 2");
    expect(md).toContain("## user");
    expect(md).toContain("你好");
    expect(md).toContain("## assistant");
    expect(md).toContain("有什么可以帮你");
  });
  it("无标题时回退会话 ID 作为文档标题", () => {
    const md = detailToMarkdown({ sessionId: "XYZ", title: null, cwd: null }, { sessionId: "XYZ", messages: [] });
    expect(md.startsWith("# XYZ")).toBe(true);
  });
  it("空消息列表输出空正文", () => {
    const md = detailToMarkdown(item, { sessionId: "AAA-BBB", messages: [] });
    expect(md).toContain("- messages: 0");
  });
});

describe("exportFilename", () => {
  it("有标题用标题并安全化非法字符", () => {
    expect(exportFilename({ title: "a/b:c*d?", sessionId: "ID" })).toBe("archive-a-b-c-d.md");
  });
  it("无标题回退会话 ID", () => {
    expect(exportFilename({ title: null, sessionId: "XYZ-123" })).toBe("archive-XYZ-123.md");
  });
  it("长标题截断到 40 字符", () => {
    const name = exportFilename({ title: "x".repeat(100), sessionId: "ID" });
    expect(name.length).toBeLessThanOrEqual("archive-".length + 40 + ".md".length);
  });
});

describe("mergeArchivedMarkdown", () => {
  it("多个分节以 --- 分页线合并", () => {
    const merged = mergeArchivedMarkdown(["# A\n\n正文 A", "# B\n\n正文 B"]);
    expect(merged).toBe("# A\n\n正文 A\n\n---\n\n# B\n\n正文 B");
  });
  it("过滤空分节", () => {
    expect(mergeArchivedMarkdown(["", "# B", ""])).toBe("# B");
  });
  it("全部为空返回空串", () => {
    expect(mergeArchivedMarkdown([])).toBe("");
    expect(mergeArchivedMarkdown([""])).toBe("");
  });
});
