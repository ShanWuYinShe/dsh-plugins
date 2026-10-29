/**
 * plugin-market-core.mjs 的类型声明。
 *
 * 该模块是 .mjs（供 scripts/plugin-market.mjs 与 TS 测试直接 import），仓库 tsconfig
 * 不开 allowJs，因此 TS 侧需要这份声明——**补声明而不是用 @ts-expect-error 压制**。
 * 声明与实现的一致性由 test/plugin-market.test.ts 的「导出面一致」用例钉住。
 */

/** LocalizedText：字符串或「语言 id → 字符串」对象（索引格式要求含 en）。 */
export type LocalizedRecord = Readonly<Record<string, string>>;

/** 索引里的分类/标签声明。 */
export interface MarketDeclaration {
  readonly title: LocalizedRecord;
}

/** 索引里的排序键声明。 */
export interface MarketSortKeyDeclaration {
  readonly title: LocalizedRecord;
  readonly order: 'asc' | 'desc';
}

/** 一个发布包的展示元数据（图标由 background + paths 渲染成确定性 SVG）。 */
export interface PackageDisplay {
  readonly slug: string;
  readonly title: LocalizedRecord;
  readonly description: LocalizedRecord;
  readonly category: string;
  readonly labels: readonly string[];
  readonly order: number;
  readonly icon: { readonly background: string; readonly paths: readonly string[] };
}

/** collectCandidates 的候选版本。 */
export interface MarketCandidate {
  readonly dir: string;
  readonly version: string;
  readonly tag: string;
  /** Release 发布时间（Unix 秒）。 */
  readonly publishedAt: number;
  readonly asset: {
    readonly name: string;
    readonly size: number;
    readonly id?: number;
    readonly browserDownloadUrl: string;
  };
  /** 资产名不是约定名、但该 Release 只有一个 .tgz 时按它兜底。 */
  readonly fallbackAsset: boolean;
  readonly prerelease: boolean;
  /** tarball 摘要（IO 层下载后附加；buildSite 需要）。 */
  integrity?: string;
  shasum?: string;
}

/** buildSite 的输入。 */
export interface BuildSiteInput {
  readonly repo?: string;
  readonly baseUrl?: string;
  readonly registryUrl?: string;
  readonly candidates?: readonly MarketCandidate[];
  readonly manifests?: ReadonlyMap<string, Record<string, unknown>>;
  readonly expectedNames?: Readonly<Record<string, string>>;
}

/** buildSite / validateSite 的摘要。 */
export interface SiteSummary {
  readonly plugins: number;
  readonly versionCount: number;
  readonly digest: string;
}

/** buildSite 的结果。 */
export interface BuiltSite {
  readonly files: Map<string, string>;
  readonly summary: SiteSummary & {
    readonly repo: string;
    readonly baseUrl: string;
    readonly registryUrl: string;
    readonly plugins: readonly { readonly name: string; readonly versions: readonly string[] }[];
    /** 生效 engines.dsh 的来源统计：精确声明 / 范围取下界 / 旧清单 dsh.host 精确 pin。 */
    readonly rangeSources: { readonly exact: number; readonly floor: number; readonly 'dsh-host': number };
    readonly skipped: readonly { readonly tag: string; readonly reason: string }[];
  };
}

/** validateSite 的输入。 */
export interface ValidateSiteInput {
  readonly files: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  readonly repo?: string;
  readonly baseUrl?: string;
  readonly registryUrl?: string;
  readonly expectedNames?: Readonly<Record<string, string>>;
  readonly parseIndex: (value: unknown, indexUrl: string) => unknown;
}

/** validateSite 的结果。 */
export interface ValidatedSite {
  readonly ok: boolean;
  readonly errors: string[];
  readonly summary: SiteSummary;
}

/** 生成器输入错误（消息面向使用者）。 */
export declare class MarketInputError extends Error {
  constructor(message: string);
}

/** 默认 GitHub 仓库（owner/name）。 */
export declare const DEFAULT_GITHUB_REPO: string;
/** 站点目录名（发行分支根下，默认 alpha：market/）。 */
export declare const MARKET_DIR: string;
/** 默认站点引用名（alpha；收敛合入 main 后由 CI 传 main）。 */
export declare const DEFAULT_MARKET_REF: string;
/** 索引标题。 */
export declare const MARKET_TITLE: LocalizedRecord;
/** 索引说明。 */
export declare const MARKET_DESCRIPTION: LocalizedRecord;
/** 索引声明的分类。 */
export declare const MARKET_CATEGORIES: Readonly<Record<string, MarketDeclaration>>;
/** 索引声明的标签。 */
export declare const MARKET_LABELS: Readonly<Record<string, MarketDeclaration>>;
/** 索引声明的排序键。 */
export declare const MARKET_SORT_KEYS: Readonly<Record<string, MarketSortKeyDeclaration>>;
/** 发布包目录 → 展示元数据。 */
export declare const PACKAGE_DISPLAY: Readonly<Record<string, PackageDisplay>>;
/** market 分支根目录的说明文件内容（CI 生成，内容固定）。 */
export declare const MARKET_README: string;

/** 站点原始内容根 URL（发行分支根下的 market/ 目录，无尾斜杠）。 */
export declare function rawMarketBaseUrl(repo?: string, ref?: string): string;
/** 索引源 URL。 */
export declare function defaultIndexUrl(repo?: string, ref?: string): string;
/** 静态 npm registry 根 URL（以斜杠结尾）。 */
export declare function defaultRegistryUrl(repo?: string, ref?: string): string;
/** 规范化 registry URL（http(s) 绝对 URL + 结尾斜杠）。 */
export declare function normalizeRegistryUrl(value: string): string;
/** 发布 tag 名。 */
export declare function releaseTagFor(dir: string, version: string): string;
/** Release 资产名。 */
export declare function assetNameFor(dir: string, version: string): string;
/** 解析发布 tag；非发布形态返回 undefined。 */
export declare function parseReleaseTag(tag: unknown, dirs: readonly string[]): { dir: string; version: string } | undefined;
/** 从 Releases API 记录收集候选版本。 */
export declare function collectCandidates(
  releases: readonly unknown[],
  options?: { dirs?: readonly string[] },
): { candidates: MarketCandidate[]; skipped: { tag: string; reason: string }[] };
/** 收录判定结果：生效的精确 engines.dsh pin 及其来源。 */
export type ManifestInspection =
  | {
      readonly eligible: true;
      /** 精确宿主版本 pin（index/packument 里的 engines.dsh）。 */
      readonly enginesDsh: string;
      readonly rangeSource: 'exact' | 'floor' | 'dsh-host';
      /** 来源为 floor（声明了范围、取下界）时保留的原始声明，供离线复核。 */
      readonly declaredEnginesDsh?: string;
    }
  | { readonly eligible: false; readonly reason: string };
/** 判断 tarball 内 package.json 是否收录（精确 engines.dsh 原样 / 范围取下界 / 旧 dsh.host 精确 pin）。 */
export declare function inspectManifest(
  manifest: unknown,
  candidate: Pick<MarketCandidate, 'version' | 'tag'>,
  expectedName: string,
): ManifestInspection;
/** 把声明值（精确 SemVer 或 ^X/~X/>=X 范围）化成精确宿主版本 pin；无法判定返回 undefined。 */
export declare function exactPinOfDeclared(declared: unknown): string | undefined;
/** 读取 tarball 内的 package/package.json（不安装、不执行）。 */
export declare function readPackageJsonFromTarball(bytes: Uint8Array): Record<string, unknown>;
/** npm tarball 的 sha512 SRI integrity。 */
export declare function computeIntegrity(bytes: Uint8Array): string;
/** npm tarball 的 sha1 shasum（40 位十六进制）。 */
export declare function computeShasum(bytes: Uint8Array): string;
/** JSON 规范序列化（两空格缩进 + 结尾换行）。 */
export declare function serializeJson(value: unknown): string;
/** 文本 sha256（十六进制）。 */
export declare function sha256Hex(text: string): string;
/** 站点摘要（路径排序后逐文件聚合）。 */
export declare function siteDigest(files: ReadonlyMap<string, string>): string;
/** 包名 → packument 的站点相对路径。 */
export declare function packumentPath(name: string): string;
/** 从候选版本 + 清单组装站点（确定性）。 */
export declare function buildSite(input: BuildSiteInput): BuiltSite;
/** build 用：展示元数据推出的 dir → 包名（测试用）。 */
export declare function expectedNamesFromDisplay(): Record<string, string>;
/** 离线校验站点。 */
export declare function validateSite(input: ValidateSiteInput): ValidatedSite;

/** previousManifests 还原出的一条历史版本信息。 */
export interface PreviousManifest {
  readonly manifest: Record<string, unknown>;
  readonly integrity: string;
  readonly shasum: string;
  readonly publishedAt: number;
  readonly tarball: string;
}
/** 从既有站点（index.json + packument）还原历史版本的清单与摘要（--previous 复用）。 */
export declare function previousManifests(input: {
  readonly files: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  readonly expectedNames?: Readonly<Record<string, string>>;
}): Map<string, PreviousManifest>;
