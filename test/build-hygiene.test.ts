import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 构建产物卫生锁：`lib/` 里的每个模块都必须有活的源码，或属官方生成物。
 *
 * 2026-11-04 审计实测：四个包的 `lib/` 残留了一批源码已删除的死模块
 * （dsh-any-connect 的 zcode 系列死模块与 typert.host、sandbox 的 gateway/legacy-migrate/
 * typert-loader、session-archive 的 config-store/legacy-migrate/typert-loader），
 * 因为 `files` 含整个 `lib` 目录、而 `tsc` 不会删除已删源码的旧产物——本地
 * `bun pm pack` / RELEASING「手动兜底」会把它们打进 tarball。CI 从干净
 * checkout 构建，天然免疫，所以这个缺陷没有自然信号，必须显式锁住。
 *
 * 判据：
 * - `lib/*.js` 的 stem 必须 ∈ `src/*.ts` 的 stem（`src/dsh.d.ts` 只产类型）；
 * - 例外只允许官方 typert 生成器产物（`typert.host` / `typert.remote-client`），
 *   且仅限声明了 `exports['./typert']` 的包；
 * - `client/client.cjs` 只在包有 `client/index.tsx` 时允许存在。
 *
 * 构建脚本现已先清空 `lib/` 再编译（scripts/build.mjs 阶段 0），本锁保证这个
 * 清理不会被删掉：去掉清理后，删过源码的包会立刻红。
 *
 * 反向验证方式：在任一包 `src/` 临时新建 `foo.ts` → `bun run build` → 删除
 * `src/foo.ts` → 再 `bun run build`；若无清理则本锁报「lib/foo.js 没有对应源码」。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 官方 typert 生成器产物 stem（仅允许出现在声明了 ./typert 导出的包）。 */
const TYPERT_STEMS = new Set(["typert.host", "typert.remote-client"]);

interface Pkg {
  name: string;
  dir: string;
  manifest: Record<string, any>;
}

function packages(): Pkg[] {
  const dir = join(ROOT, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .filter((path) => existsSync(join(path, "package.json")))
    .map((path) => ({
      name: path.split("/").pop()!,
      dir: path,
      manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 目录下某扩展名的 stem 集合（只读一层：本仓 lib/src 均为扁平结构）。 */
function stems(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(extension))
    .map((file) => file.slice(0, -extension.length))
    .sort();
}

const PKGS = packages();

describe("构建产物卫生：lib 不得残留已删源码的死模块", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(PKGS.length).toBeGreaterThanOrEqual(4);
    const libFiles = PKGS.flatMap((pkg) => stems(join(pkg.dir, "lib"), ".js"));
    expect(libFiles.length, "lib 产物数量应足够大（test 链先 build）").toBeGreaterThan(20);
  });

  for (const pkg of PKGS) {
    it(`${pkg.name}: lib/*.js 要么有对应源码，要么是 typert 生成物`, () => {
      const sourceStems = new Set(stems(join(pkg.dir, "src"), ".ts"));
      const libStems = stems(join(pkg.dir, "lib"), ".js");
      const orphans = libStems.filter((stem) => {
        if (sourceStems.has(stem)) return false;
        if (!TYPERT_STEMS.has(stem)) return true;
        // typert 工件只允许出现在声明了 ./typert 导出的包。
        return pkg.manifest.exports?.["./typert"] === undefined;
      });
      expect(
        orphans,
        `${pkg.name}: lib 里有源码已删除的陈旧产物 ${orphans.join(", ")}` +
          "——构建前清理 lib/（scripts/build.mjs 阶段 0）后重跑 bun run build",
      ).toEqual([]);
    });

    it(`${pkg.name}: client/client.cjs 只在有 client 入口时存在`, () => {
      const clientCjs = join(pkg.dir, "client", "client.cjs");
      const clientEntry = join(pkg.dir, "client", "index.tsx");
      if (existsSync(clientEntry)) {
        expect(existsSync(clientCjs), `${pkg.name}: 有 client 入口却没有构建产物 client.cjs`).toBe(true);
        return;
      }
      expect(existsSync(clientCjs), `${pkg.name}: 没有 client 入口却残留 client.cjs`).toBe(false);
    });
  }
});
