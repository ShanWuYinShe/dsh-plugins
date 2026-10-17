/**
 * dep-collect.mjs 的类型声明。
 *
 * 该模块是 .mjs（供 scripts/*.mjs 直接 import），仓库 tsconfig 不开 allowJs，因此 TS 侧测试
 * 需要这份声明——**补声明而不是用 @ts-expect-error 压制**。声明与实现的一致性由
 * test/dep-collect.test.ts 的「导出面一致」用例钉住。
 */

/** 收集键：同版本多路径只查一次，不同版本分别查。 */
export declare function depKey(name: string, version: string): string;

/**
 * 解析 bun 隔离布局的 store 条目名。只做形态拆分，空版本与否由收集器判定。
 */
export declare function parseBunStoreEntry(entryName: string): { name: string; version: string } | null;

/** 收集器：workspace 排除、空/非法版本跳过、同键去重。 */
export declare function createCollector(workspaceNames: ReadonlySet<string>): {
  deps: Map<string, { name: string; version: string }>;
  collect: (name: string, version: unknown) => void;
};

/** --deep 的 bun 布局分支：目录名清单 → 收集结果。 */
export declare function collectBunStoreEntries(
  entryNames: readonly string[],
  workspaceNames: ReadonlySet<string>,
): Map<string, { name: string; version: string }>;

/**
 * 默认分支：manifest 声明的直接依赖 + hoisted 主版本。
 * readVersion 缺失时返回 undefined，即跳过。
 */
export declare function collectDirectDeps(
  manifests: readonly Record<string, unknown>[],
  workspaceNames: ReadonlySet<string>,
  readVersion: (name: string) => string | undefined,
): Map<string, { name: string; version: string }>;

/**
 * 非 bun 布局（npm/yarn 安装的树）：递归 walk node_modules 收集每个 name@version。
 * 直接读真实 fs，测试用临时目录树驱动。
 */
export declare function collectWalkTree(
  nodeModulesDir: string,
  workspaceNames: ReadonlySet<string>,
): Map<string, { name: string; version: string }>;
