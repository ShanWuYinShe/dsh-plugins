import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 浏览器产物许可告知锁：内联了第三方代码的 client bundle 必须有 THIRD_PARTY_NOTICES。
 *
 * `scripts/build.mjs` 的 client 打包只把 `react` / `react/jsx-runtime` / `zod` 声明为
 * external，其余依赖闭包内联进 `client/client.cjs`。Typert 官方生成器产出的客户端
 * 工件会 import `@deepseek-ai/dsh-typert-protocol/remote-info`（纯数据工厂，宿主
 * 模块表不提供），因此 typert 两包的 client 产物内联了该 MIT 代码。
 *
 * 官方 `packages/client/AGENTS.md`「Distributed browser code remains subject to
 * runtime license disclosure」要求随分发产物做运行时许可告知；2026-11-04 审计发现
 * sandbox-extra-roots / session-archive 缺失该文件（any-connect 的 bin 自包含闭包
 * 早已有 THIRD_PARTY_NOTICES.md）。
 *
 * 判据：
 * - 声明了 `./typert` 的包，`client/client.cjs`（若已构建）必须含 `jsonSchemaError`
 *   这一内联标记，且包根 `THIRD_PARTY_NOTICES.md` 存在、声明 `@deepseek-ai/dsh-typert-protocol`
 *   且进 `files`；
 * - 其它包若 client 产物出现同一内联标记，也必须提供告知文件。
 *
 * 判据（bin 闭包自动化，2026-11-04 补齐）：`scripts/build.mjs` 阶段 4 用
 * esbuild `metafile` 把每个 bin 的**实际内联第三方闭包**（包名 + 构建时解析版本）
 * 写到 `.workwork/bin-closure.json`；声明了 `bin` 的包，其
 * `THIRD_PARTY_NOTICES.md` 表格的「组件 → 版本」集合必须与该闭包**完全相等**
 * （多一行=多告知一个未内联的包，少一行=漏告知；版本不一致=升级后没同步）。
 * 注意 `.workwork/` 是 gitignore 的中间产物，测试链（`bun run test`）先 build
 * 再跑 vitest，因此闭包文件在任何受支持的执行路径上都会存在。
 *
 * 反向验证方式：删掉任一 typert 包的 THIRD_PARTY_NOTICES.md，本锁必须报红；
 * 在 notices 表格里改掉一个版本号、或删掉一行 → bin 闭包比对必须报红。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** remote-info 实现里的稳定特征串（构建产物内联后仍保留）。 */
const REMOTE_INFO_MARKER = "jsonSchemaError";

function packages(): { name: string; dir: string; manifest: Record<string, any> }[] {
  const root = join(ROOT, "packages");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((path) => existsSync(join(path, "package.json")))
    .map((path) => ({
      name: path.split("/").pop()!,
      dir: path,
      manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const PKGS = packages();

describe("浏览器产物许可告知", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(PKGS.length).toBeGreaterThanOrEqual(4);
    expect(PKGS.filter((pkg) => pkg.manifest.exports?.["./typert"] !== undefined).length).toBeGreaterThanOrEqual(2);
  });

  for (const pkg of PKGS) {
    const bundle = join(pkg.dir, "client", "client.cjs");
    // 未构建时无法判定内联面（test 链先 build，真实运行一定有产物）。
    if (!existsSync(bundle)) continue;
    const inlinesRemoteInfo = readFileSync(bundle, "utf8").includes(REMOTE_INFO_MARKER);
    if (!inlinesRemoteInfo) continue;

    it(`${pkg.name}: 内联 remote-info 的 client 产物附 THIRD_PARTY_NOTICES`, () => {
      const notices = join(pkg.dir, "THIRD_PARTY_NOTICES.md");
      expect(existsSync(notices), `${pkg.name}: client 产物内联 @deepseek-ai/dsh-typert-protocol/remote-info，缺 THIRD_PARTY_NOTICES.md`).toBe(true);
      const text = readFileSync(notices, "utf8");
      expect(text).toContain("@deepseek-ai/dsh-typert-protocol");
      expect(text.toLowerCase()).toContain("mit");
      expect(pkg.manifest.files).toContain("THIRD_PARTY_NOTICES.md");
    });
  }
});

/** 声明了 bin 的包（构建期闭包核对的对象）。 */
const BIN_PACKAGES = PKGS.filter((pkg) => pkg.manifest.bin !== undefined);

/** 构建期 bin 闭包文件（scripts/build.mjs 阶段 4 写出；test 链先 build）。 */
const CLOSURE_PATH = join(ROOT, ".workwork", "bin-closure.json");

interface ClosureEntry {
  name: string;
  version: string;
}

/** 从 THIRD_PARTY_NOTICES.md 的表格行解析「组件 → 版本」。 */
function noticeTable(text: string): ClosureEntry[] {
  const rows: ClosureEntry[] = [];
  for (const line of text.split("\n")) {
    // 形如：| `@deepseek-ai/cordis` | 4.1.0 | MIT | Copyright ... |
    const match = /^\|\s*`([^`]+)`\s*\|\s*([^|\s]+)\s*\|/.exec(line);
    if (match === null) continue;
    rows.push({ name: match[1] as string, version: match[2] as string });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

describe("bin 内联闭包与 THIRD_PARTY_NOTICES 一致", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(BIN_PACKAGES.length).toBeGreaterThanOrEqual(1);
  });

  it("build 写出的 bin 闭包存在且结构有效", () => {
    expect(
      existsSync(CLOSURE_PATH),
      "缺 .workwork/bin-closure.json：受支持的测试链是 `bun run test`（先 build）；"
        + "直接跑 vitest 前请先 bun run build",
    ).toBe(true);
    const closure = JSON.parse(readFileSync(CLOSURE_PATH, "utf8")) as { packages: Record<string, { bin: string; closure: ClosureEntry[] }> };
    expect(typeof closure.packages).toBe("object");
    for (const pkg of BIN_PACKAGES) {
      const entry = closure.packages[pkg.name];
      expect(entry, `${pkg.name}: bin-closure.json 缺少该包的闭包记录`).toBeDefined();
      expect(entry!.closure.length, `${pkg.name}: bin 闭包为空（包名解析失效？）`).toBeGreaterThanOrEqual(3);
      // 闭包只记录第三方组件；本仓包（@chaoset/*）是 bin 入口自身，不应出现。
      expect(entry!.closure.some((item) => item.name.startsWith("@chaoset/"))).toBe(false);
    }
  });

  for (const pkg of BIN_PACKAGES) {
    it(`${pkg.name}: notices 表格的组件/版本集合 == bin 构建闭包`, () => {
      const closure = JSON.parse(readFileSync(CLOSURE_PATH, "utf8")) as { packages: Record<string, { closure: ClosureEntry[] }> };
      const actual = closure.packages[pkg.name]?.closure ?? [];
      const noticesPath = join(pkg.dir, "THIRD_PARTY_NOTICES.md");
      expect(existsSync(noticesPath), `${pkg.name}: 有 bin 但没有 THIRD_PARTY_NOTICES.md`).toBe(true);
      const declared = noticeTable(readFileSync(noticesPath, "utf8"));
      expect(declared.length, `${pkg.name}: notices 表格解析为空（表格格式变化？）`).toBeGreaterThanOrEqual(3);
      expect(
        declared,
        `${pkg.name}: THIRD_PARTY_NOTICES.md 与 bin 构建闭包不一致——升级/增删被内联依赖后必须同步表格`
          + `（左=notices，右=闭包）\nnotices: ${JSON.stringify(declared)}\nclosure: ${JSON.stringify(actual)}`,
      ).toEqual([...actual].sort((a, b) => a.name.localeCompare(b.name)));
      expect(pkg.manifest.files).toContain("THIRD_PARTY_NOTICES.md");
    });
  }
});
