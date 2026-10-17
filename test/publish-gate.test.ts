import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 发布门禁的集成测试（scripts/publish-gate.mjs）。
 *
 * 2026-10-08 补：门禁决定「哪个包会被发布」，此前只有人跑 bun run gate 时才被执行——
 * 改错了要到发布当天才发现。这里按**命令行契约**钉住它：tag 形态、未知目录、非法版本、
 * 缺参数各自的退出码与 stdout（stdout 只放 JSON 计划，人读信息走 stderr）。
 *
 * 断言尽量与仓库当前状态无关：默认模式只校验计划**形状**，tag 模式用合成 tag
 * （不依赖当前基线版本，也不会碰到真实 tag）。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "publish-gate.mjs");
const KNOWN_DIRS = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

describe("publish-gate", () => {
  it("默认模式：退出 0，stdout 是形状正确的发布计划", () => {
    const { code, stdout } = run();
    expect(code).toBe(0);
    const plan = JSON.parse(stdout) as unknown;
    expect(Array.isArray(plan)).toBe(true);
    for (const entry of plan as Record<string, unknown>[]) {
      expect(KNOWN_DIRS).toContain(entry["dir"]);
      expect(typeof entry["name"]).toBe("string");
      expect(typeof entry["version"]).toBe("string");
      expect(typeof entry["prerelease"]).toBe("boolean");
    }
  });

  it("非发布形态的 tag：跳过且不红灯", () => {
    const { code, stdout } = run("--tag", "my-marker");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("宿主适配归档 tag（dsh-v*）：不发布任何包", () => {
    const { code, stdout } = run("--tag", "dsh-v9.9.9");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("未知目录的 tag：退出 1，且说明不是已知发布包", () => {
    const { code, stdout, stderr } = run("--tag", "nope-v1.0.0");
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("不是已知发布包");
  });

  it("版本部分不是合法 semver：退出 1", () => {
    const { code, stderr } = run("--tag", "provider-usage-vnotsemver");
    expect(code).toBe(1);
    expect(stderr).toContain("semver");
  });

  it("回归：下划线不属于合法 prerelease（曾用宽口径放行）", () => {
    const { code } = run("--tag", "provider-usage-v1.2.3-extra_underscore");
    expect(code).toBe(1);
  });

  it("--tag 缺少参数：退出 1 并给出用法", () => {
    const { code, stderr } = run("--tag");
    expect(code).toBe(1);
    expect(stderr).toContain("用法");
  });
});
