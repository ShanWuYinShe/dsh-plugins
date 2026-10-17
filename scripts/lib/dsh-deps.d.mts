/**
 * dsh-deps.mjs 的类型声明。
 *
 * 该模块是 .mjs（供 scripts/*.mjs 直接 import），仓库 tsconfig 不开 allowJs，因此 TS 侧测试
 * 需要这份声明——**补声明而不是用 @ts-expect-error 压制**。声明与实现的一致性由
 * test/dsh-deps.test.ts 的「导出面一致」用例钉住。
 */

/** 仓库根目录（由模块位置推导）。 */
export declare const ROOT: string;

/** dsh 依赖名前缀。 */
export declare const DEP_PREFIX: string;

/** 参与扫描的依赖区块。 */
export declare const DEP_SECTIONS: readonly string[];

/** 仓库内全部 package.json 的相对路径（根 + packages/*，跳过无 manifest 的残留目录）。 */
export declare function manifestPaths(root?: string): string[];

/** 解析 `^<版本>` 形态的 range；返回版本号或 null（形态不符）。 */
export declare function baselineOf(range: unknown): string | null;

/** 扫描一个 package.json 对象，收集 dsh-* 依赖基线与 dsh.host 声明。 */
export declare function scanManifest(manifest: Record<string, unknown>): {
  baselines: string[];
  hosts: string[];
  invalid: { section: string; name: string; range: unknown }[];
};

/** 聚合一组 manifest：共同基线、host 与非法项计数；不一致时给出标记字符串。 */
export declare function aggregateBaseline(
  reader: (path: string) => Record<string, unknown>,
  root?: string,
  paths?: string[],
): { baseline: string; host: string | undefined; invalid: number };
