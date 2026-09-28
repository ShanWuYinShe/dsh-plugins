import { describe, expect, it, vi } from "vitest";
import { css } from "../client/index.tsx";

// 同 client-focus.test.ts：模块求值期引用 React，给空桩通过即可。
vi.mock("react", () => ({
  createElement: (...args: any[]) => ({ args }),
  useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useRef: () => ({ current: null }),
}));

/**
 * 会话详情文本可读性回归：用户气泡是品牌色填充面，文字颜色必须随之
 * 主题化。写死 \`#fff\` 曾让深色主题下白字压 near-white 气泡
 * （实测对比度 1.05:1，整条消息看不见）；角色标签是气泡上方的兄弟
 * 节点、落在行背景上，同样不能用白色。任一处回退成硬编码白即红灯。
 */
function ruleText(selector: string): string {
  const match = css.match(new RegExp(selector.replace(/[.]/g, "\\.") + "\\{([^}]*)\\}"));
  expect(match, selector + " 规则缺失").not.toBeNull();
  return match?.[1] ?? "";
}

describe("归档详情文本可读性", () => {
  it("用户气泡文字用主题 foreground，不硬编码 #fff", () => {
    const body = ruleText(".sa_msgUser");
    expect(body).toContain("background:var(--dsw-alias-brand-primary");
    expect(body).toContain("color:var(--dsw-alias-label-primary-foreground");
    expect(body).not.toMatch(/color:\s*#fff/i);
    expect(body).not.toMatch(/color:\s*white/i);
  });

  it("用户角色标签不用白色（它在气泡外的行背景上）", () => {
    const body = ruleText(".sa_msgRoleUser");
    expect(body).toContain("var(--dsw-alias-label-secondary)");
    expect(body).not.toMatch(/rgba\(255\s*,\s*255\s*,\s*255/);
    expect(body).not.toMatch(/color:\s*#fff/i);
  });

  it("助手气泡沿用主题标签色", () => {
    const body = ruleText(".sa_msgAssistant");
    expect(body).toContain("color:var(--dsw-alias-label-primary)");
  });

  it("面板内不出现硬编码白色的正文色", () => {
    // 仅允许出现在「错误/危险填充按钮」上（那两处底色本身就是实心红）。
    const offenders = [...css.matchAll(/\.sa_[A-Za-z]+\{[^}]*color:\s*#fff[^}]*\}/g)]
      .map((m) => m[0].slice(0, 40))
      .filter((rule) => !/sa_actionDanger|sa_confirm/.test(rule));
    expect(offenders).toEqual([]);
  });
});
