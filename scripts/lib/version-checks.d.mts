/**
 * version-checks.mjs 的类型声明。
 *
 * 该模块是 .mjs（供 scripts/*.mjs 直接 import），而仓库的 tsconfig 不开 allowJs，
 * 因此 TS 侧的测试要导入它就需要这份声明——**补声明而不是用 @ts-expect-error 压制**，
 * 让测试拿到真实签名。
 *
 * 声明与实现的一致性由 test/version-checks.test.ts 的「导出面一致」用例钉住：
 * 实现里新增/删除导出而这里没跟，测试会红。
 */

/** 合法 semver（含 prerelease / build metadata）。 */
export declare const VERSION_RE: RegExp;

/** semver 比较：主/次/补丁按数值，prerelease 段按 semver §11，build metadata 不参与。 */
export declare function compareVersions(a: string, b: string): number;

/** 是否带 prerelease 后缀（出现第一个 - 即算）。 */
export declare function isPrerelease(version: string): boolean;

/** 是否属于稳定线（无 prerelease 后缀）。 */
export declare function isStable(version: string): boolean;

/** CHANGELOG 小节标题所在行索引；-1 表示没有该版本的小节。 */
export declare function findChangelogSection(lines: readonly string[], version: string): number;
