import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEP_PREFIX,
  DEP_SECTIONS,
  aggregateBaseline,
  baselineOf,
  manifestPaths,
  scanManifest,
} from "../scripts/lib/dsh-deps.mjs";
import { readFileSync } from "node:fs";

/**
 * dsh 依赖基线提取的直接测试（scripts/lib/dsh-deps.mjs）。
 *
 * 2026-10-08 补：这个库被 dsh-baseline（发布 tag，严格模式）与 dsh-follow-status（状态核对，
 * 容忍模式）共用，负责判定「本仓跟的是哪个 dsh 版本」——判错了会连带发布门禁与分支纪律。
 * 模块本身不做 exit/log 决策（策略留给调用方），因此很适合直接断言。
 *
 * 注意 aggregateBaseline 的 reader 是注入的：测试不需要真实文件系统，也不会碰真实仓库。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-deps-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("类型声明与实现一致", () => {
  it("dsh-deps.d.mts 的导出面与实现一致（防止声明漂移）", async () => {
    const actual = Object.keys(await import("../scripts/lib/dsh-deps.mjs")).sort();
    const declared = [...readFileSync(join(ROOT, "scripts/lib/dsh-deps.d.mts"), "utf8")
      .matchAll(/export declare (?:const|function) (\w+)/g)].map((match) => match[1] as string).sort();
    expect(actual).toEqual(declared);
  });
});

describe("baselineOf", () => {
  it("解析 ^<版本>，保留 prerelease 后缀", () => {
    expect(baselineOf("^0.2.1-alpha.1")).toBe("0.2.1-alpha.1");
    expect(baselineOf("^0.1.2-rc.1")).toBe("0.1.2-rc.1");
    expect(baselineOf("^1.0.0")).toBe("1.0.0");
  });

  it("非 ^<版本> 形态一律返回 null", () => {
    for (const bad of ["~0.2.1", "0.2.1", ">=0.2.1", "^v0.2.1", "^ 0.2.1", "^0.2.1 || ^0.3.0", "", "^*", undefined, 42]) {
      expect(baselineOf(bad), String(bad)).toBeNull();
    }
  });
});

describe("scanManifest", () => {
  it("收集全部区块的 dsh 依赖基线（去重）", () => {
    const { baselines, invalid } = scanManifest({
      dependencies: { [DEP_PREFIX + "atomic-write"]: "^0.2.1-alpha.1" },
      optionalDependencies: { [DEP_PREFIX + "attachment"]: "^0.2.1-alpha.1" },
      devDependencies: { [DEP_PREFIX + "typert-protocol"]: "^0.2.1-alpha.1", react: "^19.0.0" },
      peerDependencies: { [DEP_PREFIX + "home-paths"]: "^0.2.1-alpha.1" },
    });
    expect(baselines).toEqual(["0.2.1-alpha.1"]);
    expect(invalid).toEqual([]);
  });

  it("非 dsh 前缀的依赖不参与判定", () => {
    const { baselines } = scanManifest({ dependencies: { react: "^19.0.0", "dsh-utils": "^1.0.0" } });
    expect(baselines).toEqual([]);
  });

  it("形态不符的 dsh 依赖进 invalid，并带上区块与原始 range", () => {
    const { baselines, invalid } = scanManifest({
      dependencies: { [DEP_PREFIX + "atomic-write"]: "~0.2.1-alpha.1" },
      devDependencies: { [DEP_PREFIX + "typert-protocol"]: "^0.2.1-alpha.1" },
    });
    expect(baselines).toEqual(["0.2.1-alpha.1"]);
    expect(invalid).toEqual([
      { section: "dependencies", name: DEP_PREFIX + "atomic-write", range: "~0.2.1-alpha.1" },
    ]);
  });

  it("dsh.host：字符串才收集，空串与非字符串忽略", () => {
    expect(scanManifest({ dsh: { host: "0.2.1-alpha.1" } }).hosts).toEqual(["0.2.1-alpha.1"]);
    expect(scanManifest({ dsh: { host: "" } }).hosts).toEqual([]);
    expect(scanManifest({ dsh: { host: 42 } }).hosts).toEqual([]);
    expect(scanManifest({}).hosts).toEqual([]);
  });

  it("区块列表覆盖四个区块名", () => {
    expect(DEP_SECTIONS).toEqual(["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]);
  });
});

describe("aggregateBaseline", () => {
  const manifest = (version: string | undefined, host?: string): Record<string, unknown> => ({
    dependencies: version === undefined ? {} : { [DEP_PREFIX + "atomic-write"]: "^" + version },
    ...(host === undefined ? {} : { dsh: { host } }),
  });

  it("全仓一致时给出共同基线", () => {
    const reader = (): Record<string, unknown> => manifest("0.2.1-alpha.1", "0.2.1-alpha.1");
    const result = aggregateBaseline(reader, ROOT, ["a/package.json", "b/package.json"]);
    expect(result).toEqual({ baseline: "0.2.1-alpha.1", host: "0.2.1-alpha.1", invalid: 0 });
  });

  it("基线不一致时给出标记字符串（调用方据此报错）", () => {
    const reader = (path: string): Record<string, unknown> =>
      manifest(path.startsWith("a/") ? "0.2.1-alpha.1" : "0.3.0-alpha.1");
    const { baseline } = aggregateBaseline(reader, ROOT, ["a/package.json", "b/package.json"]);
    expect(baseline).toMatch(/^\[不一致: /);
    expect(baseline).toContain("0.2.1-alpha.1");
    expect(baseline).toContain("0.3.0-alpha.1");
  });

  it("没有任何 dsh 依赖时给出占位文案", () => {
    const { baseline, host } = aggregateBaseline(() => manifest(undefined), ROOT, ["a/package.json"]);
    expect(baseline).toBe("(无 dsh 依赖)");
    expect(host).toBeUndefined();
  });

  it("host 不一致时给出 [不一致]，缺失时为 undefined", () => {
    const conflicting = aggregateBaseline(
      (path) => manifest("0.2.1-alpha.1", path.startsWith("a/") ? "0.2.1-alpha.1" : "0.3.0-alpha.1"),
      ROOT,
      ["a/package.json", "b/package.json"],
    );
    expect(conflicting.host).toBe("[不一致]");
    expect(aggregateBaseline(() => manifest("0.2.1-alpha.1"), ROOT, ["a/package.json"]).host).toBeUndefined();
  });

  it("非法项计数跨 manifest 累加", () => {
    const reader = (): Record<string, unknown> => ({ dependencies: { [DEP_PREFIX + "x"]: "~1.0.0" } });
    expect(aggregateBaseline(reader, ROOT, ["a/package.json", "b/package.json"]).invalid).toBe(2);
  });
});

describe("manifestPaths", () => {
  it("枚举根 + packages/*，并跳过没有 package.json 的残留目录", () => {
    const root = tempRoot();
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    writeFileSync(join(root, "packages", "a", "package.json"), "{}");
    mkdirSync(join(root, "packages", "removed-residue"), { recursive: true });
    expect(manifestPaths(root)).toEqual(["package.json", "packages/a/package.json"]);
  });
});
