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
  enginesProblems,
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

  it("engines.dsh：精确宿主版本或同线兼容范围都收集；缺失时为空", () => {
    expect(scanManifest({ engines: { dsh: "0.2.1-alpha.1" } }).enginesDsh).toEqual(["0.2.1-alpha.1"]);
    // 兼容范围原样（去首尾空白）收录，不取下界——形态/语义判定交给 enginesProblems。
    expect(scanManifest({ engines: { dsh: ">=0.2.2-rc.2 <0.2.3-0" } }).enginesDsh).toEqual([">=0.2.2-rc.2 <0.2.3-0"]);
    expect(scanManifest({ engines: { dsh: "  >=0.2.2-rc.2 <0.2.3-0  " } }).enginesDsh).toEqual([">=0.2.2-rc.2 <0.2.3-0"]);
    // 形态合法但语义可疑（上界不是下一线）不归 scanManifest 管，由 enginesProblems 报。
    expect(scanManifest({ engines: { dsh: ">=0.2.1-rc.5 <0.2.4-0" } }).enginesDsh).toEqual([">=0.2.1-rc.5 <0.2.4-0"]);
    expect(scanManifest({ engines: { node: ">=24.9.0" } }).enginesDsh).toEqual([]);
    expect(scanManifest({}).enginesDsh).toEqual([]);
  });

  it("engines.dsh 写宽松范围（^X/~X/单界 >=X/*/||）一律进 invalid；旧字段 dsh.host 出现即 invalid", () => {
    // 宽松范围会过度声明兼容性，且会与历史 tarball 的「范围取下界」口径混淆，
    // 兼容范围只接受严格形态 `>=<下界> <下一线>-0`（见 engines-compat.mjs）。
    for (const range of [
      "^0.2.1-alpha.1",
      "~0.2.1-alpha.1",
      ">=0.2.1-alpha.1",
      ">=0.2.2-rc.2 <0.2.3", // 上界缺 "-0"，会被宿主 includePrerelease 放过下一线预发布
      "*",
      "latest",
      "0.2.1-alpha.1 || 0.3.0-alpha.1",
    ]) {
      const bad = scanManifest({ engines: { dsh: range } });
      expect(bad.enginesDsh, range).toEqual([]);
      expect(bad.invalid, range).toEqual([{ section: "engines", name: "dsh", range }]);
    }
    const nonString = scanManifest({ engines: { dsh: 42 } });
    expect(nonString.invalid).toEqual([{ section: "engines", name: "dsh", range: 42 }]);
    const legacy = scanManifest({ dsh: { host: "0.2.1-alpha.1" } });
    expect(legacy.enginesDsh).toEqual([]);
    expect(legacy.invalid).toEqual([{ section: "dsh", name: "host", range: "0.2.1-alpha.1" }]);
  });

  it("区块列表覆盖四个区块名", () => {
    expect(DEP_SECTIONS).toEqual(["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]);
  });
});

describe("enginesProblems", () => {
  // 构建基线 0.2.2-rc.3；同线兼容范围覆盖 rc.2 与 rc.3。
  const BASELINE = "0.2.2-rc.3";
  const COMPAT = ">=0.2.2-rc.2 <0.2.3-0";
  const published = (enginesDsh?: unknown): Record<string, unknown> =>
    enginesDsh === undefined ? {} : { engines: { dsh: enginesDsh } };
  const root = (enginesDsh?: unknown): Record<string, unknown> => ({ private: true, ...published(enginesDsh) });

  it("发布包：精确等于基线 / 覆盖基线的同线兼容范围 → 通过", () => {
    expect(enginesProblems(published(BASELINE), BASELINE)).toEqual([]);
    expect(enginesProblems(published(COMPAT), BASELINE)).toEqual([]);
    // 基线前进到 rc.4 后，同一条兼容范围仍然覆盖基线。
    expect(enginesProblems(published(COMPAT), "0.2.2-rc.4")).toEqual([]);
  });

  it("发布包：缺失 / 形态非法 / 精确值不符 → 报问题", () => {
    expect(enginesProblems(published(), BASELINE).join("\n")).toContain("缺少 engines.dsh");
    expect(enginesProblems(published("^0.2.2-rc.2"), BASELINE).join("\n")).toContain("形态非法");
    expect(enginesProblems(published("0.2.2-rc.2"), BASELINE).join("\n")).toContain("不一致");
  });

  it("发布包：兼容范围不覆盖基线（上界/下界问题）→ 报问题", () => {
    expect(enginesProblems(published(">=0.2.2-rc.2 <0.2.4-0"), BASELINE).join("\n")).toContain("上界必须切在构建基线的下一线");
    expect(enginesProblems(published(">=0.2.1-rc.5 <0.2.3-0"), BASELINE).join("\n")).toContain("不在同一宿主基础号");
    expect(enginesProblems(published(">=0.2.2-rc.4 <0.2.3-0"), BASELINE).join("\n")).toContain("高于构建基线");
  });

  it("private 根：必须精确等于基线，兼容范围也算问题", () => {
    expect(enginesProblems(root(BASELINE), BASELINE)).toEqual([]);
    expect(enginesProblems(root(), BASELINE).join("\n")).toContain("缺少 engines.dsh");
    expect(enginesProblems(root("^0.2.2-rc.2"), BASELINE).join("\n")).toContain("形态非法");
    expect(enginesProblems(root(COMPAT), BASELINE).join("\n")).toContain("不能写兼容范围");
    expect(enginesProblems(root("0.2.2-rc.4"), BASELINE).join("\n")).toContain("不一致");
  });
});

describe("aggregateBaseline", () => {
  const manifest = (version: string | undefined, enginesDsh?: string): Record<string, unknown> => ({
    dependencies: version === undefined ? {} : { [DEP_PREFIX + "atomic-write"]: "^" + version },
    // 兼容声明可以是精确宿主版本或同线兼容范围（依赖 range 仍是 ^X）。
    ...(enginesDsh === undefined ? {} : { engines: { dsh: enginesDsh } }),
  });

  it("全仓一致时给出共同基线", () => {
    const reader = (): Record<string, unknown> => manifest("0.2.1-alpha.1", "0.2.1-alpha.1");
    const result = aggregateBaseline(reader, ROOT, ["a/package.json", "b/package.json"]);
    expect(result).toEqual({ baseline: "0.2.1-alpha.1", enginesDsh: "0.2.1-alpha.1", invalid: 0 });
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
    const { baseline, enginesDsh } = aggregateBaseline(() => manifest(undefined), ROOT, ["a/package.json"]);
    expect(baseline).toBe("(无 dsh 依赖)");
    expect(enginesDsh).toBeUndefined();
  });

  it("engines.dsh 不一致时给出 [不一致]，缺失时为 undefined", () => {
    const conflicting = aggregateBaseline(
      (path) => manifest("0.2.1-alpha.1", path.startsWith("a/") ? "0.2.1-alpha.1" : "0.3.0-alpha.1"),
      ROOT,
      ["a/package.json", "b/package.json"],
    );
    expect(conflicting.enginesDsh).toBe("[不一致]");
    expect(aggregateBaseline(() => manifest("0.2.1-alpha.1"), ROOT, ["a/package.json"]).enginesDsh).toBeUndefined();
  });

  it("engines.dsh 聚合只统计发布包：根 private 的精确基线不参与", () => {
    // 根写精确构建基线、发布包写同线兼容范围是本轮策略下的正常形态，
    // 若把根也算进聚合会永远得到 [不一致]。
    const compat = ">=0.2.2-rc.2 <0.2.3-0";
    const reader = (path: string): Record<string, unknown> => path === "package.json"
      ? { private: true, engines: { dsh: "0.2.2-rc.3" } }
      : {
        dependencies: { [DEP_PREFIX + "atomic-write"]: "^0.2.2-rc.3" },
        engines: { dsh: compat },
      };
    const result = aggregateBaseline(reader, ROOT, ["package.json", "packages/a/package.json"]);
    expect(result).toEqual({ baseline: "0.2.2-rc.3", enginesDsh: compat, invalid: 0 });
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
