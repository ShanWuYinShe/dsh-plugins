import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 回环守卫一致性回归：两个包各自持有的那份「回环请求判定」不能静默分叉。
 *
 * 背景：dsh-any-connect 与 provider-usage **独立发布、不能互相 import**，所以回环守卫
 * （Host 检查挡 DNS-rebinding、Origin 检查挡跨站读取）在两边各留一份。provider-usage 的
 * 注释写明这是有意的：「语义镜像 dsh-any-connect，分化时偏向拒绝」。
 *
 * 但「有意分化」只覆盖 originIsLoopback 的那一处**收紧**（空串 Origin：any-connect 放行、
 * provider-usage 拒绝）。**其余部分是同一份安全判定，分叉就是漏洞**：一边认的 loopback 主机名
 * 另一边不认，等于同一台机器上两个插件门禁强度不同。2026-10-08 之前就发生过一次
 * （`[::1]garbage` 上 shim 版与标准版语义不一致，见 loopback.ts 里的历史注释）。
 *
 * 判据：
 * 1. LOOPBACK_HOSTS 主机名集合、hostnameOfHost、hostIsLoopback 三者在两文件里必须逐字一致
 *    （忽略注释与空白）；
 * 2. originIsLoopback 的差异必须**恰好**是那一处已登记的收紧，多一分少一分都报错。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const A = "packages/dsh-any-connect/src/loopback.ts";
const B = "packages/provider-usage/src/route.ts";

/** 抓取顶层声明（到列 0 的右花括号，或单行 const 为止）。 */
function declaration(text: string, pattern: RegExp): string {
  const start = text.search(pattern);
  if (start === -1) return "";
  const rest = text.slice(start);
  if (rest.startsWith("const ")) return (rest.split("\n")[0] ?? "").trim();
  const end = rest.indexOf("\n}");
  return end === -1 ? "" : rest.slice(0, end + 2);
}

/** 去掉注释、导出前缀与空白，只留语义。 */
function normalize(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/\bexport\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LOOPBACK_HOSTS = /const LOOPBACK_HOSTS =/;
const HOSTNAME_OF_HOST = /function hostnameOfHost\(/;
const HOST_IS_LOOPBACK = /function hostIsLoopback\(/;
const ORIGIN_IS_LOOPBACK = /function originIsLoopback\(/;

describe("回环守卫一致性", () => {
  const a = readFileSync(join(ROOT, A), "utf8");
  const b = readFileSync(join(ROOT, B), "utf8");

  it("主机名集合、hostnameOfHost、hostIsLoopback 两边逐字一致", () => {
    const cases: [string, RegExp][] = [
      ["LOOPBACK_HOSTS", LOOPBACK_HOSTS],
      ["hostnameOfHost", HOSTNAME_OF_HOST],
      ["hostIsLoopback", HOST_IS_LOOPBACK],
    ];
    for (const [label, pattern] of cases) {
      const left = normalize(declaration(a, pattern));
      const right = normalize(declaration(b, pattern));
      expect(left.length, label + " 抽取失败（规则会空转）").toBeGreaterThan(0);
      expect(right, label + " 在 " + A + " 与 " + B + " 之间分叉了").toBe(left);
    }
  });

  it("originIsLoopback 的差异恰好是已登记的那一处收紧", () => {
    const left = normalize(declaration(a, ORIGIN_IS_LOOPBACK));
    const right = normalize(declaration(b, ORIGIN_IS_LOOPBACK));
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    // any-connect 放行空串 Origin（视为非浏览器客户端），provider-usage 收紧为拒绝。
    expect(left).toContain("origin.trim() === ''");
    expect(right).not.toContain("origin.trim() === ''");
    expect(left.replace(" || origin.trim() === ''", "")).toBe(right);
  });

  it("文件仍各自持有本地副本（防止有人误改成跨包 import）", () => {
    expect(a).toContain("const LOOPBACK_HOSTS");
    expect(b).toContain("const LOOPBACK_HOSTS");
    // 只禁「跨包 import」：注释里互相引用（说明差异）是允许的。
    expect(/from\s+['"][^'"]*provider-usage/.test(a)).toBe(false);
    expect(/from\s+['"][^'"]*dsh-any-connect/.test(b)).toBe(false);
  });
});
