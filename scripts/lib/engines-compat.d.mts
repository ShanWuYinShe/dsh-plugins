// scripts/lib/engines-compat.mjs 的类型声明（与实现导出面由
// test/engines-compat.test.ts 的「类型声明与实现一致」用例锁定）。

/** 语义化版本的"下一线"基础号（0.2.2-rc.3 → "0.2.3"）。 */
export declare function nextLineOf(version: string): string;
/** 生成发布包兼容范围：">=<下界> <下一线>-0" 形态。 */
export declare function formatCompatRange(version: string, floor: string): string;
/** 解析严格形态的兼容范围；形态不符返回 undefined。 */
export declare function parseCompatRange(declared: unknown): { floor: string; nextLine: string } | undefined;
/** engines.dsh 声明形态：精确版本 / 同线兼容范围 / 非法。 */
export declare function enginesDshKind(declared: unknown): "exact" | "compat" | "invalid";
/** 发布包 engines.dsh 相对构建基线的问题清单（空数组 = 通过）。 */
export declare function enginesDshProblems(declared: unknown, baseline: string): string[];
