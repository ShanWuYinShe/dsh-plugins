import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const dirs: string[] = []

function runWithEnv(file: string, envOverrides: Record<string, string>, ...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [script(file), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  })
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr }
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

describe("dsh-follow-status", () => {
  // 这个脚本是 AGENTS.md「分支选择铁律」的判定来源：**承诺永远 exit 0**——它是
  // 状态工具不是门禁，网络/依赖问题都不能把它变成红灯。npm 不可达时降级为
  // 单行说明且**不输出周期判定**（半截信息会误导分支选择），这两点都要钉住。

  /**
   * 构造一个只含 node 与**假 npm** 的 PATH。假 npm 按参数回放固定的 dist-tags /
   * versions JSON（把「网络依赖」变成确定化输入）；FAKE_NPM_MODE=broken 时以非零
   * 退出，用于触发降级路径。
   */
  function fakePath(mode: "ok" | "broken"): string {
    const dir = mkdtempSync(join(tmpdir(), "dsh-follow-fakebin-"))
    dirs.push(dir)
    symlinkSync(process.execPath, join(dir, "node"))
    // 脚本还会调 git（branchExists/gitTags/branchBaseline），缺了会 ENOENT 直接崩
    symlinkSync("/usr/bin/git", join(dir, "git"))
    const npm = [
      "#!/bin/sh",
      mode === "broken" ? "exit 1" : "true",
      'case "$*" in',
      '  *dist-tags*) echo \'{"latest":"0.2.0","next":"0.2.1-alpha.1"}\' ;;',
      '  *versions*) echo \'["0.1.0-rc.1","0.2.0-rc.1","0.2.0-rc.2","0.2.1-alpha.1"]\' ;;',
      '  *) echo "{}" ;;',
      'esac',
    ].join("\n")
    writeFileSync(join(dir, "npm"), npm, { mode: 0o755 })
    return dir
  }

  it("活跃期判定（假 npm 供数）：输入定，输出定", () => {
    // dist-tags 的 next（0.2.1-alpha.1）高于稳定线 ⇒ 应判【活跃期】并给出阶段指引；
    // 分支基线行来自本地 git 与 package.json，✔/⚠/✗ 由仓库状态决定，只断言行存在。
    const { code, stdout, stderr } = runWithEnv("dsh-follow-status.mjs", {
      PATH: fakePath("ok"),
      FAKE_NPM_MODE: "ok",
    })
    expect(code).toBe(0)
    expect(stdout).toContain("dsh 稳定线(最新 rc) = 0.2.0-rc.2")
    expect(stdout).toContain("进行中预发布线 = 0.2.1-alpha.1")
    expect(stdout).toContain("当前处于【活跃期】")
    expect(stdout).toContain("main")
    expect(stdout).toContain("alpha")
  })

  it("npm 不可达：降级为单行说明、退出 0，绝不输出半截周期判定", () => {
    const { code, stdout, stderr } = runWithEnv("dsh-follow-status.mjs", { PATH: fakePath("broken") })
    expect(code).toBe(0)
    expect(stdout).toContain("npm registry 查询失败")
    expect(stdout).toContain("跳过核对")
    // 降级时**不输出**稳定线/预发布线判定（避免用残缺信息误导分支选择）
    expect(stdout).not.toContain("阶段指引")
    expect(stderr).not.toContain("at ") // 不该把堆栈甩给用户
  })
})
