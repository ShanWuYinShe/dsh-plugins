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
 * 反向验证方式：删掉任一 typert 包的 THIRD_PARTY_NOTICES.md，本锁必须报红。
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
