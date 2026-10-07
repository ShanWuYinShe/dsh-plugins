import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { upstreamClientFor, zcodePlanTransformFor } from "../src/variant-wiring.js";
import { WorkBuddyUpstreamClient, ZCodeUpstreamClient } from "../src/upstream.js";
import { AI_VARIANT, CN_VARIANT, ZCODE_START_PLAN_VARIANT, ZCODE_VARIANT } from "../src/variants.js";
import type { WorkBuddyCredential } from "../src/auth.js";

/** 最小合法凭据：这些用例只看 zcodePlan 的折叠结果。 */
function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAtMs: 0,
    domain: "bigmodel.cn",
    uid: "u1",
    source: "desktop",
    ...overrides,
  };
}

describe("变体装配（CLI 与插件运行时共用）", () => {
  it("客户端选择：zcode 变体走专属通道，其余走 WorkBuddy", () => {
    expect(upstreamClientFor(ZCODE_VARIANT)).toBeInstanceOf(ZCodeUpstreamClient);
    expect(upstreamClientFor(ZCODE_START_PLAN_VARIANT)).toBeInstanceOf(ZCodeUpstreamClient);
    expect(upstreamClientFor(CN_VARIANT)).toBeInstanceOf(WorkBuddyUpstreamClient);
    expect(upstreamClientFor(AI_VARIANT)).toBeInstanceOf(WorkBuddyUpstreamClient);
  });

  it("非 zcode 变体没有计划语义", () => {
    expect(zcodePlanTransformFor(CN_VARIANT)).toBeUndefined();
    expect(zcodePlanTransformFor(AI_VARIANT)).toBeUndefined();
  });

  it("Start Plan 变体把计划固定为 start-plan（即使凭据里写着别的计划）", () => {
    const transform = zcodePlanTransformFor(ZCODE_START_PLAN_VARIANT);
    expect(transform).toBeTypeOf("function");
    expect(transform!(credential({ zcodePlan: "team-coding-plan" })).zcodePlan).toBe("start-plan");
    expect(transform!(credential()).zcodePlan).toBe("start-plan");
  });

  it("Coding Plan 变体保留已有 coding 计划，缺失时落回 individual-coding-plan", () => {
    const transform = zcodePlanTransformFor(ZCODE_VARIANT);
    expect(transform).toBeTypeOf("function");
    // 团队/个人计划是账号事实，不能被变体抹平（否则团队额度会被当成个人额度）。
    expect(transform!(credential({ zcodePlan: "team-coding-plan" })).zcodePlan).toBe("team-coding-plan");
    expect(transform!(credential({ zcodePlan: "individual-coding-plan" })).zcodePlan).toBe("individual-coding-plan");
    expect(transform!(credential()).zcodePlan).toBe("individual-coding-plan");
    // 反过来：Coding Plan 变体绝不能把计划折成 start-plan。
    expect(transform!(credential({ zcodePlan: "start-plan" })).zcodePlan).not.toBe("start-plan");
  });

  it("src/ 里只有 variant-wiring.ts 构造凭据存储", () => {
    const srcDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
    const offenders = readdirSync(srcDir).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".d.ts") &&
        file !== "variant-wiring.ts" &&
        readFileSync(join(srcDir, file), "utf8").includes("new WorkBuddyCredentialStore("),
    );
    // 装配规则（刷新通道 + zcode 计划语义）必须只有一处实现：CLI 曾自己拼一份并
    // 漏掉计划语义，把 zcode-start-plan 的额度查询指到了 coding 池子。
    expect(offenders, "凭据存储的构造应集中在 variant-wiring.ts").toEqual([]);
  });
});
