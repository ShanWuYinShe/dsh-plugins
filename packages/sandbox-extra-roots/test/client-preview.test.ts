import { describe, expect, it } from "vitest";
// 直接导入真实客户端模块（纯函数；模块顶层的 CSS 注入有 document 守卫，
// React 是唯一运行时依赖）。此前 analyzeRootsText 零覆盖,/private 与
// 主目录祖先的口径漂移只能在保存失败后才发现。
import { analyzeRootsText } from "../client/index.tsx";

function kinds(lines: string): string[] {
  return analyzeRootsText(lines).map((p) => p.kind);
}

describe("sandbox-extra-roots client preview", () => {
  it("合法路径与 ~/子路径不标问题", () => {
    expect(kinds("~/data\n/tmp/cache\n/workspace/build")).toEqual([]);
    expect(kinds("")).toEqual([]);
  });

  it("相对路径 invalid、重复行 duplicate、根目录 danger", () => {
    expect(kinds("relative/path")).toEqual(["invalid"]);
    expect(kinds("/tmp/a\n/tmp/a")).toEqual(["duplicate"]);
    expect(kinds("/")).toEqual(["danger"]);
    expect(kinds("C:\\")).toEqual(["danger"]);
  });

  it("裸 ~ 是主目录本身(reject 级):标 danger;~/x 仍合法", () => {
    // 回归:此前 ~ 与 ~/x 一律视为合法,而 host 按 homedir 判 reject,
    // 用户保存裸 ~ 只会在失败后读到一段英文 TypeError。
    expect(kinds("~")).toEqual(["danger"]);
    expect(kinds("~/data")).toEqual([]);
  });

  it("系统目录及其词法祖先标 system(含 darwin 的 /private)", () => {
    // 分析函数本身不做平台分支——darwin 的 realpath 拼写由模块内的
    // isDarwin 决定;node 环境(UA 非 Mac)下 /private 不在名单,单独
    // /private 会被 host 剔除但预览标不出,这是已知的客户端近似边界。
    expect(kinds("/etc")).toEqual(["system"]);
    expect(kinds("/usr/local")).toEqual([]); // 系统目录的后代不在词法名单
  });

  it("home 祖先(linux 形态 /home)标 homeAncestor", () => {
    // node 环境的 UA 不含 Mac/Win,按 Linux 近似;/Users 与 C:\Users
    // 分别是 darwin/Windows 分支,这里只锁定本分支行为。
    expect(kinds("/home")).toEqual(["homeAncestor"]);
    expect(kinds("/home/user/cache")).toEqual([]); // home 的后代是合法根
  });

  it("阻塞级问题(invalid/danger/homeAncestor)可被保存按钮识别", () => {
    // 保存按钮禁用条件与卡片一致:存在 blocking 级行时禁用。
    const blocking = ["invalid", "danger", "homeAncestor"] as const;
    const isBlocking = (p: { kind: string }) => (blocking as readonly string[]).includes(p.kind);
    expect(analyzeRootsText("~\n/etc\n/tmp/ok").some(isBlocking)).toBe(true);
    expect(analyzeRootsText("/tmp/ok").some(isBlocking)).toBe(false);
  });
});
