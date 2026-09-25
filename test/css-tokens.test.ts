import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * 客户端 CSS 变量白名单回归：插件手写的 client 样式只能引用宿主真实
 * 存在的 `var(--*)`。死拼写（如 --dsw-alias-state-warning-primary，
 * 规范名是 warn）在运行时静默回退到硬编码 fallback，页面看着正常、
 * 暗色/高对比主题下却悄悄脱离主题色板——人眼 code review 发现不了，
 * 只能靠这个测试钉住（2026-09 曾一次抓出 6 处）。
 *
 * 白名单是检入的 test/css-token-whitelist.txt（由宿主 theme 包 +
 * web-frontend dist CSS + primitives CSS 提取生成），不断言“变量值”，
 * 只断言“变量名存在”，故宿主换肤/换值不影响本测试；只有宿主改名/
 * 删变量或插件写错名时才红灯。adapt 换宿主线后按白名单头注释重生成。
 */

// 与 scripts/build.mjs 相同的目录派生策略,不硬编码包清单。
function clientSources(): string[] {
  const out: string[] = [];
  const packagesDir = join(ROOT, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const clientDir = join(packagesDir, entry.name, "client");
    let files: string[] = [];
    try {
      // 递归扫：esbuild 打包是递归的，client/ 子目录（如 components/）里的
      // var(--*) 死拼写同样会进产物，不递归就静默逃过白名单。
      files = readdirSync(clientDir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const file of files) {
      // 只扫手写源码：client.cjs 是构建产物，不扫（否则改源码不重构建
      // 也能绿，失去回归意义）。
      if ((file.endsWith(".tsx") || file.endsWith(".ts")) && !file.endsWith(".d.ts")) {
        out.push(join(clientDir, file));
      }
    }
  }
  return out.sort();
}

function referencedTokens(source: string): string[] {
  return [...source.matchAll(/var\(\s*(--[A-Za-z0-9-_]+)/g)]
    .map((m) => m[1])
    .filter((token): token is string => token !== undefined);
}

function whitelist(): Set<string> {
  const lines = readFileSync(join(ROOT, "test", "css-token-whitelist.txt"), "utf8").split("\n");
  return new Set(
    lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
  );
}

describe("client CSS 变量白名单", () => {
  it("插件引用的 var(--*) 全部在白名单内", () => {
    const allowed = whitelist();
    expect(allowed.size).toBeGreaterThan(100);
    const unknown: Record<string, string[]> = {};
    for (const file of clientSources()) {
      const rel = file.slice(ROOT.length + 1);
      for (const token of referencedTokens(readFileSync(file, "utf8"))) {
        if (!allowed.has(token)) {
          (unknown[token] ??= []).push(rel);
        }
      }
    }
    expect(
      unknown,
      "死变量名：页面看着正常但主题适配已失效。先查拼写（warn 非 warning、" +
        "success 无 subtle 档、等宽字体是 --ds-font-family-code）；若宿主真改名了，" +
        "同步改插件引用，不要加 fallback 了事；确认是宿主新增变量则重生成白名单"
    ).toEqual({});
  });
});
