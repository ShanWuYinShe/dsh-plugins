import { describe, expect, it } from "vitest";
// 直接从纯函数模块导入（client 入口只导出 apply/inject；同包测试按 DSH
// 客户端入口纪律走 '../client/<module>.js' 相对路径，不因测试便利拓宽公开面）。
// 此前 analyzeRootsText 零覆盖,/private 与主目录祖先的口径漂移只能在保存
// 失败后才发现。
import { analyzeRootsText, appendRootLine, hasBlockingProblems, presetsForPlatform, cleanRootLine } from "../client/roots-preview.js";

function kinds(lines: string): string[] {
  return analyzeRootsText(lines).map((p) => p.kind);
}

describe("sandbox-extra-roots client preview", () => {
  it("cleanRootLine 容错去除行首尾单双引号与前后空白", () => {
    expect(cleanRootLine('  "/tmp/cache"  ')).toBe("/tmp/cache");
    expect(cleanRootLine("  '~/my-dir'  ")).toBe("~/my-dir");
    expect(cleanRootLine('"/unmatched')).toBe('"/unmatched');
  });

  it("合法路径与 ~/子路径不标问题（含外层引号输入）", () => {
    expect(kinds("~/data\n/tmp/cache\n/workspace/build")).toEqual([]);
    expect(kinds('"/tmp/cache"\n\'~/workspace\'')).toEqual([]);
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
  })

  it("darwin 平台参数：/private 系 realpath 与 /Users 祖先可判", () => {
    const darwin = { isDarwin: true, isWindows: false }
    const ks = (lines: string) => analyzeRootsText(lines, darwin).map((p) => p.kind)
    expect(ks("/private/etc")).toEqual(["system"])
    expect(ks("/Users")).toEqual(["homeAncestor"])
    expect(ks("/home")).toEqual([])
  })

  it("windows 平台参数：C:\\Users 祖先可判", () => {
    const windows = { isDarwin: false, isWindows: true }
    const ks = (lines: string) => analyzeRootsText(lines, windows).map((p) => p.kind)
    expect(ks("C:\\Users")).toEqual(["homeAncestor"])
    expect(ks("/home")).toEqual([])
  });

  it("阻塞级问题(invalid/danger/homeAncestor)可被保存按钮识别", () => {
    // 判据是产品里保存按钮真正用的那一个（hasBlockingProblems 被组件与
    // 本用例共用）。此前这里自造了一份局部谓词，产品改了禁用条件它照样绿。
    expect(hasBlockingProblems(analyzeRootsText("~\n/etc\n/tmp/ok"))).toBe(true);
    // 三个 kind 各自都要能挡住保存：只测其中一个，判据里删掉另外两个
    // （下面的变体验证就是这么发现的）用例仍会绿。
    expect(hasBlockingProblems(analyzeRootsText("relative/path"))).toBe(true);
    expect(hasBlockingProblems(analyzeRootsText("/home"))).toBe(true);
    expect(hasBlockingProblems(analyzeRootsText("/tmp/ok"))).toBe(false);
    // system/duplicate 只是提示级，不禁用保存。
    expect(hasBlockingProblems(analyzeRootsText("/etc"))).toBe(false);
    expect(hasBlockingProblems(analyzeRootsText("/tmp/a\n/tmp/a"))).toBe(false);
  });

  it("一键添加：空草稿/缺换行/已存在三种形态", () => {
    // 产品里 chip onClick 调的同一条拼接：判据漂移（比如不再补换行）用例即红。
    expect(appendRootLine("", "~/.npm")).toBe("~/.npm\n");
    expect(appendRootLine("/tmp/a", "~/.npm")).toBe("/tmp/a\n~/.npm\n");
    expect(appendRootLine("/tmp/a\n", "~/.npm")).toBe("/tmp/a\n~/.npm\n");
    // 已存在（去空格比对）原样返回，不触发 duplicate 误报。
    expect(appendRootLine("~/.npm\n", "~/.npm")).toBe("~/.npm\n");
    expect(appendRootLine("  ~/.npm  \n/tmp/a", "~/.npm")).toBe("  ~/.npm  \n/tmp/a");
    expect(appendRootLine(null, "~/.npm")).toBeNull();
  });

  it("预设按平台过滤：只出现本系统合法的默认路径", () => {
    const darwin = presetsForPlatform(true, false);
    expect(darwin).toContain("~/Library/Caches/pip");
    expect(darwin).not.toContain("~/.cache/pip");
    const linux = presetsForPlatform(false, false);
    expect(linux).toContain("~/.cache/pip");
    expect(linux).not.toContain("~/Library/Caches/pip");
    expect(darwin).toContain("~/.bun/install/cache");
    expect(linux).toContain("~/.bun/install/cache");
    // 三平台共有：cargo/go；Windows 没有 POSIX 专属缓存。
    for (const list of [darwin, linux, presetsForPlatform(false, true)]) {
      expect(list).toContain("~/.cargo");
      expect(list).toContain("~/go/pkg/mod");
    }
    expect(presetsForPlatform(false, true)).not.toContain("~/.npm");
    expect(presetsForPlatform(false, true)).not.toContain("~/.bun/install/cache");
  });

  it("所有问题类型在 zh 与 en 中均有完整本地化文案与占位符", async () => {
    const { zh, en } = await import("../client/locales.js");
    const kinds = ["danger", "homeAncestor", "invalid", "duplicate", "system"];
    for (const kind of kinds) {
      const key = "root" + kind.charAt(0).toUpperCase() + kind.slice(1);
      expect((zh as any)[key], `zh 必须包含 ${key}`).toBeDefined();
      expect((en as any)[key], `en 必须包含 ${key}`).toBeDefined();
      expect((zh as any)[key]).toContain("{n}");
      expect((zh as any)[key]).toContain("{v}");
      expect((en as any)[key]).toContain("{n}");
      expect((en as any)[key]).toContain("{v}");
    }
  });
});
