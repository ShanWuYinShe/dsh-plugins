import { describe, expect, it } from "vitest";
import { detailToMarkdown, mergeArchivedMarkdown } from "../client/archive-entries.js";

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
