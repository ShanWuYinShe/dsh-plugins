import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 其余发布 / 维护脚本的命令行契约测试。
 *
 * 2026-10-08 补（承接发布门禁那一轮）：scripts/*.mjs 此前全部没有测试。这里覆盖三件事——
 * 依赖基线自洽、Release 说明的占位降级、宿主适配的 dry-run **真的不写文件**。
 *
 * 断言与仓库当前状态无关：只校验退出码、输出形态与「dry-run 前后工作区无差异」，
 * 不假设某个具体版本号或某个包一定有待发布内容。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const script = (name: string): string => join(ROOT, "scripts", name);

function run(file: string, ...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [script(file), ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function gitStatus(): string {
  return spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout;
}

describe("dsh-baseline", () => {
  it("仓库的 dsh 依赖基线自洽：退出 0 并输出一个版本号", () => {
    const { code, stdout } = run("dsh-baseline.mjs");
    expect(code, stdout).toBe(0);
    // 形如 0.2.1-alpha.1 / 0.1.2-rc.1 / 0.4.0
    expect(stdout).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});

describe("release-notes", () => {
  it("release-notes 缺参数：退出 2 并给出用法", () => {
    const { code, stderr } = run("release-notes.mjs");
    expect(code).toBe(2);
    expect(stderr).toContain("用法");
  });

  it("CHANGELOG 里没有该版本时退回占位说明（不让发布流程中断）", () => {
    const { code, stdout, stderr } = run("release-notes.mjs", "dsh-any-connect", "99.99.99");
    expect(code).toBe(0);
    expect(stdout).toContain("99.99.99");
    expect(stderr).toContain("没有 99.99.99 小节");
  });

  it("未知包目录时**大声失败**，而不是静默产出一份说明", () => {
    const { code } = run("release-notes.mjs", "no-such-package", "1.0.0");
    expect(code).not.toBe(0);
  });
});

describe("adapt-dsh", () => {
  it("adapt-dsh 缺参数：退出 2 并给出用法", () => {
    const { code, stderr } = run("adapt-dsh.mjs");
    expect(code).toBe(2);
    expect(stderr).toContain("用法");
  });

  it("--dry-run 只打印计划、**不改动工作区**", () => {
    const before = gitStatus();
    const { code, stdout } = run("adapt-dsh.mjs", "0.1.2-rc.1", "--dry-run");
    expect(code, stdout).toBe(0);
    expect(stdout).toContain("dry-run");
    expect(gitStatus()).toBe(before);
  });
});
