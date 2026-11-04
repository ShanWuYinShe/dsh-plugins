import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 依赖解析基线锁：manifest 声明的宿主包必须真的解析到 `engines.dsh` 那张版本。
 *
 * 2026-11-04 审计的核心发现（infra.md §B1）：声明面早已统一 `^0.2.2-rc.1`，
 * 但 `bun.lock` / 各包 `node_modules` 里仍混着 pre-rc.1 实例
 * （dsh-agent@0.2.1-rc.3、dsh-agent-default-model@0.2.2-alpha.2、
 * dsh-typert-protocol@0.2.1-rc.3 …）——根因是 lock 长期增量维护、历次宿主
 * 适配没有从零重解 peer 图。CI 用 `--frozen-lockfile` 安装的就是这张混版图，
 * 而当时**没有任何测试能发现**。
 *
 * 判据：
 * 1. 每个 manifest（根 + packages/*）的 `engines.dsh` 是精确版本，且所有直接
 *    `@deepseek-ai/dsh-*` 依赖 range 都是 `^<engines.dsh>`（与根 test/bundle
 *    同口径，这里额外覆盖根 manifest）；
 * 2. 每个直接宿依赖从该 manifest 目录解析出的实际版本**精确等于** `engines.dsh`；
 * 3. `bun.lock` 里出现的每个 `@deepseek-ai/dsh-*@<version>` 都等于基线
 *    （混入任何旧实例即红；将来确实需要旧线的条目必须进 OLDER_ALLOWED 并写理由）。
 *
 * 基线取自根 package.json 的 `engines.dsh`（全仓唯一事实源）。
 *
 * 反向验证方式：把任一包某条 dsh 依赖改成 `^0.2.1-rc.5` 并重装，本锁必须报红。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** lock 中允许存在的非基线 dsh 实例：空表是当前正确状态，例外必须写明理由。 */
const OLDER_ALLOWED: Readonly<Record<string, string>> = {};

interface Manifest {
  /** 相对仓库根的路径（"package.json" 或 "packages/<pkg>/package.json"）。 */
  readonly path: string;
  readonly dir: string;
  readonly json: Record<string, any>;
}

function manifestPath(path: string): Manifest {
  return {
    path,
    dir: join(ROOT, path === "package.json" ? "." : path.slice(0, -"/package.json".length)),
    json: JSON.parse(readFileSync(join(ROOT, path), "utf8")),
  };
}

function manifests(): Manifest[] {
  const list = [manifestPath("package.json")];
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join("packages", entry.name, "package.json");
    if (existsSync(join(ROOT, path))) list.push(manifestPath(path));
  }
  return list;
}

/** 该 manifest 声明的全部依赖切片（name → range），dsh 前缀过滤由调用方做。 */
function declared(json: Record<string, any>): [string, string][] {
  return [
    ...Object.entries(json.dependencies ?? {}),
    ...Object.entries(json.devDependencies ?? {}),
    ...Object.entries(json.peerDependencies ?? {}),
    ...Object.entries(json.optionalDependencies ?? {}),
  ] as [string, string][];
}

const BASELINE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines?.dsh as string | undefined;
const MANIFESTS = manifests();

describe("依赖解析基线：声明、实际解析与 lock 三方一致", () => {
  it("根 package.json 声明精确 engines.dsh 基线（全仓唯一事实源）", () => {
    expect(typeof BASELINE).toBe("string");
    expect(BASELINE).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(5);
  });

  for (const manifest of MANIFESTS) {
    it(`${manifest.path}: 直接宿依赖 range 与 engines.dsh 一致`, () => {
      const enginesDsh = manifest.json.engines?.dsh;
      expect(enginesDsh, `${manifest.path}: 缺精确 engines.dsh`).toBe(BASELINE);
      const dshDeps = declared(manifest.json).filter(([dep]) => dep.startsWith("@deepseek-ai/dsh-"));
      for (const [dep, range] of dshDeps) {
        expect(range, `${manifest.path}: ${dep} 的 range 必须是 ^${BASELINE}`).toBe(`^${BASELINE}`);
      }
    });

    it(`${manifest.path}: 直接宿依赖实际解析到基线版本`, () => {
      const requireFrom = createRequire(join(manifest.dir, "package.json"));
      const dshDeps = declared(manifest.json).filter(([dep]) => dep.startsWith("@deepseek-ai/dsh-"));
      const mismatched: string[] = [];
      for (const [dep] of dshDeps) {
        let version: string;
        try {
          version = requireFrom(`${dep}/package.json`).version as string;
        } catch {
          mismatched.push(`${dep}: 未安装`);
          continue;
        }
        if (version !== BASELINE) mismatched.push(`${dep}: 解析到 ${version}`);
      }
      expect(
        mismatched,
        `${manifest.path}: 以下依赖没有解析到 ${BASELINE}——需要干净重装（rm -rf node_modules packages/*/node_modules bun.lock && bun install）`,
      ).toEqual([]);
    });
  }

  it("bun.lock 中不存在 pre-基线 dsh 实例", () => {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    const versions = new Map<string, string>();
    for (const match of lock.matchAll(/"(@deepseek-ai\/dsh-[a-z0-9-]+)@([^"]+)"/g)) {
      versions.set(match[1]!, match[2]!);
    }
    expect(versions.size, "lock 里的 dsh 实例数量应足够大（防止规则空转）").toBeGreaterThan(50);
    const stale: string[] = [];
    for (const [name, version] of [...versions].sort()) {
      if (version === BASELINE) continue;
      const allowed = OLDER_ALLOWED[name] ?? OLDER_ALLOWED[`${name}@${version}`];
      if (allowed !== undefined) continue;
      stale.push(`${name}@${version}`);
    }
    expect(
      stale,
      `lock 混入非基线实例：${stale.join(", ")}——干净重装重生成 lock（或为真实例外在 OLDER_ALLOWED 写理由）`,
    ).toEqual([]);
  });
});
