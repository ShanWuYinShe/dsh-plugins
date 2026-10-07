import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 入口「模块一览」回归：每个包的入口文件都带一段模块地图，本测试核对它
 * 与磁盘上的模块**双向一致**——
 * - src/client 里新增模块却没写进地图 → 红灯（地图不会悄悄过期）；
 * - 地图里列了已删除/改名的文件 → 红灯（避免读者被指到不存在的文件）。
 *
 * 2026-10-08 加这段地图的原因：几轮架构拆分后单包已有一二十个模块，
 * 新人（和未来的自己）靠 grep 才能建立全局认知；地图放在入口，读代码
 * 第一眼就能看到「哪个模块管什么」。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
// 与 scripts/build.mjs 相同的目录派生策略，不硬编码包清单。
const PACKAGES = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(ROOT, "packages", name, "package.json")))
  .sort();

/** 模块文件（排除类型声明 d.ts，它们不是实现模块）。 */
function modulesOf(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
    .sort();
}

/** 入口里「模块一览」块中列出的文件名。 */
function listedIn(entryText: string, file: string): string[] {
  const block = entryText.match(/模块一览[\s\S]*?\*\//)?.[0];
  if (block === undefined) {
    throw new Error(`${file} 里找不到「模块一览」注释块`);
  }
  return [...block.matchAll(/([A-Za-z0-9][A-Za-z0-9.-]*\.tsx?)/g)].map((match) => match[1]!);
}

function expectMapCovers(pkg: string, dir: string, entryName: string): void {
  const entryPath = join(dir, entryName);
  const listed = new Set(listedIn(readFileSync(entryPath, "utf8"), entryPath));
  const actual = modulesOf(dir);
  expect(actual.filter((file) => !listed.has(file)), `${pkg}/${entryName} 未列出的模块`).toEqual([]);
  expect([...listed].filter((file) => !existsSync(join(dir, file))), `${pkg}/${entryName} 列了不存在的文件`).toEqual([]);
}

describe("入口模块一览与磁盘模块一致", () => {
  for (const pkg of PACKAGES) {
    const srcDir = join(ROOT, "packages", pkg, "src");
    it(`${pkg}: src/index.ts 列全 src/ 模块`, () => {
      expectMapCovers(pkg, srcDir, "index.ts");
    });

    const clientDir = join(ROOT, "packages", pkg, "client");
    if (existsSync(join(clientDir, "index.tsx")) && modulesOf(clientDir).length > 1) {
      it(`${pkg}: client/index.tsx 列全 client/ 模块`, () => {
        expectMapCovers(pkg, clientDir, "index.tsx");
      });
    }
  }
});
