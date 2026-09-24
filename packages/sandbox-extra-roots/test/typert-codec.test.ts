import { describe, expect, it } from "vitest";
import { TYPERT } from "../src/typert.host.js";

/**
 * 网关参数校验回归：set(partial) 的畸形输入在方法分发前被拒绝，谓词与
 * remote.ts 的同形检查一致（改一处必须改另一处）。
 */
describe("typert 参数校验", () => {
  it("set(partial)：plain object 通过，其余拒绝", () => {
    const invocation = (TYPERT.invocations as any[]).find((item) => item.method === "set");
    if (invocation === undefined) throw new Error("no invocation for set");
    const param = (invocation.parameters as any[]).find((item) => item.name === "partial");
    if (param === undefined) throw new Error("no parameter partial for set");
    const parse = param.codec.create().parse as (value: unknown) => unknown;
    const good = { extraWritableRoots: ["/tmp/x"] };
    expect(parse(good)).toBe(good);
    expect(parse({})).toEqual({});
    for (const bad of [null, undefined, 1, "x", [], ["/tmp/x"]]) {
      expect(() => parse(bad), `rejects ${JSON.stringify(bad)}`).toThrow(TypeError);
    }
  });
});
