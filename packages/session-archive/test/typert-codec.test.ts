import { describe, expect, it } from "vitest";
import { TYPERT } from "../src/typert.host.js";

/**
 * 网关参数校验回归：typert 网关 decode 走 codec.create().parse()，畸形
 * 输入必须在方法分发前被拒绝（remote.ts 的方法层手写检查保留，两处语义
 * 一致——改一处必须改另一处）。结果 codec 保持透传（host 构造）。
 */
function paramParse(method: string, name: string): (value: unknown) => unknown {
  const invocation = (TYPERT.invocations as any[]).find((item) => item.method === method);
  if (invocation === undefined) throw new Error(`no invocation for ${method}`);
  const param = (invocation.parameters as any[]).find((item) => item.name === name);
  if (param === undefined) throw new Error(`no parameter ${name} for ${method}`);
  return param.codec.create().parse;
}

describe("typert 参数校验", () => {
  it("detail(sessionId)：非空字符串通过，其余拒绝", () => {
    const parse = paramParse("detail", "sessionId");
    expect(parse("s1")).toBe("s1");
    for (const bad of ["", 1, null, undefined, {}, ["x"]]) {
      expect(() => parse(bad), `rejects ${JSON.stringify(bad)}`).toThrow(TypeError);
    }
  });
  it("delete/unarchive(sessionIds)：字符串数组通过，异形与超限拒绝", () => {
    for (const method of ["delete", "unarchive"]) {
      const parse = paramParse(method, "sessionIds");
      expect(parse(["a", "b"])).toEqual(["a", "b"]);
      expect(parse([])).toEqual([]);
      for (const bad of ["x", [""], [1], [null], null, {}, new Array(5001).fill("x")]) {
        expect(() => parse(bad), `${method} rejects ${JSON.stringify(bad)?.slice(0, 20)}`).toThrow(TypeError);
      }
    }
  });
  it("结果 codec 保持透传（host 构造，非信任边界）", () => {
    const invocation = (TYPERT.invocations as any[]).find((item) => item.method === "list");
    const value = { items: [] };
    expect(invocation.result.create().parse(value)).toBe(value);
  });
});
