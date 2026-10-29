import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMarketIndex } from "@deepseek-ai/dsh-plugin-market-index";
import type { ManifestInspection, MarketCandidate, PackageDisplay } from "../scripts/lib/plugin-market-core.mjs";
import {
  DEFAULT_GITHUB_REPO,
  MarketInputError,
  PACKAGE_DISPLAY,
  assetNameFor,
  buildSite,
  collectCandidates,
  computeIntegrity,
  computeShasum,
  defaultRegistryUrl,
  MARKET_README,
  expectedNamesFromDisplay,
  inspectManifest,
  mapHostPinToRange,
  normalizeRegistryUrl,
  packumentPath,
  parseReleaseTag,
  previousManifests,
  rawMarketBaseUrl,
  readPackageJsonFromTarball,
  releaseTagFor,
  serializeJson,
  sha256Hex,
  siteDigest,
  validateSite,
} from "../scripts/lib/plugin-market-core.mjs";

/**
 * 插件市场生成器的离线契约测试：不联网、不安装包，全部用 fixture 驱动。
 *
 * 覆盖三件事：
 * 1. 收录规则：Release 元数据筛选（tag 形态 / draft / 资产命名 / 重复版本）与 tarball 内
 *    package.json 判定（dsh.bundle + engines.dsh 原样 / 旧 dsh.host 精确 pin 映射 + 名称/版本一致）；
 * 2. 站点契约：index.json 能被官方 parseMarketIndex 接受，静态 registry 的 packument 与索引
 *    交叉一致（registry 常量、版本集合、engines.dsh、publishTimestamp、dist 摘要），
 *    重复构建逐字节确定；
 * 3. check 的反向验证：非规范 JSON、图标缺失、registry 漂移、engines 不一致、tarball URL
 *    重复/错位、packument 版本集合不一致都必须报错（并给可读原因）。
 *
 * 真实 Releases 的端到端验证由 node scripts/plugin-market.mjs plan/build 在 CI 与本机完成。
 */

// 映射区间的兼容语义用真实 semver 验证：根 devDependencies 已声明 semver（与官方
// @deepseek-ai/dsh-plugin-market-index 依赖的范围同版本），不手写比较器自己验证自己。
const requireForTest = createRequire(import.meta.url);
const semver = requireForTest("semver") as {
  satisfies: (version: string, range: string, options?: { includePrerelease?: boolean }) => boolean;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = DEFAULT_GITHUB_REPO;
const BASE_URL = rawMarketBaseUrl(REPO);
const REGISTRY_URL = defaultRegistryUrl(REPO);
const DIRS = Object.keys(PACKAGE_DISPLAY);
const EXPECTED = expectedNamesFromDisplay();

/** 构造一个最小 ustar 条目（测试用；只用到 name/size/typeflag）。 */
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "utf8");
  header.write("0000000\0", 108, "utf8");
  header.write("0000000\0", 116, "utf8");
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  header.write("00000000000\0", 136, "utf8");
  header.write("        ", 148, "utf8");
  header.write("0", 156, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

/** 构造 npm 形态的 gzip tarball（entries 按给定顺序写入）。 */
function tarballOf(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) blocks.push(tarEntry(entry.name, entry.data));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** 生成一个收录形态的 package.json fixture。 */
function manifestOf(dir: string, version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: nameOf(dir),
    version,
    description: "Plugin " + dir + " " + version,
    license: "MIT",
    engines: { node: ">=24.9.0", dsh: "^0.2.2-alpha.2" },
    peerDependencies: { "@deepseek-ai/cordis": "~4.0.6-alpha.1" },
    dsh: {
      manifestVersion: 1,
      bundle: { patch: "./cordis.patch.yml" },
      client: { platform: "web", inject: ["@deepseek-ai/dsh-client-locale"] },
    },
    homepage: "https://github.com/" + REPO + "/tree/main/packages/" + dir + "#readme",
    repository: { type: "git", url: "git+https://github.com/" + REPO + ".git", directory: "packages/" + dir },
    keywords: ["dsh", dir],
    ...overrides,
  };
}

/** 旧清单形态：没有 engines.dsh，只有 dsh.host 精确 pin（2026-10 之前的发布）。 */
function legacyManifestOf(dir: string, version: string, host: string): Record<string, unknown> {
  return manifestOf(dir, version, {
    engines: { node: ">=22.19.0" },
    dsh: { manifestVersion: 1, bundle: { patch: "./cordis.patch.yml" }, host },
  });
}

/** 既无 engines.dsh 也无 dsh.host 的清单（旧 Release 里确实存在，应继续排除）。 */
function noHostManifestOf(dir: string, version: string): Record<string, unknown> {
  return manifestOf(dir, version, {
    engines: { node: ">=22.19.0" },
    dsh: { manifestVersion: 1, bundle: { patch: "./cordis.patch.yml" } },
  });
}

/** 生成一个 Release 资产 fixture（名称/URL 与真实发布一致）。 */
function assetOf(dir: string, version: string, id = 1): Record<string, unknown> {
  const name = assetNameFor(dir, version);
  return {
    id,
    name,
    size: 1234,
    browser_download_url: "https://github.com/" + REPO + "/releases/download/" + releaseTagFor(dir, version) + "/" + name,
  };
}

/** 生成一个 Release fixture。 */
function releaseOf(
  dir: string,
  version: string,
  options: { published?: string; draft?: boolean; prerelease?: boolean; assets?: readonly unknown[] } = {},
): Record<string, unknown> {
  return {
    tag_name: releaseTagFor(dir, version),
    draft: options.draft === true,
    prerelease: options.prerelease !== false,
    published_at: options.published === undefined ? "2026-10-29T14:04:29Z" : options.published,
    assets: options.assets === undefined ? [assetOf(dir, version)] : options.assets,
  };
}

/** 给候选版本附上 tarball 摘要（真实流程由下载阶段计算）。 */
function withDigests(candidates: readonly MarketCandidate[]): MarketCandidate[] {
  return candidates.map(candidate => {
    const bytes = Buffer.from(candidate.tag);
    return { ...candidate, integrity: computeIntegrity(bytes), shasum: computeShasum(bytes) };
  });
}

/**
 * 与真实仓库同形的 fixture：四个包各若干 alpha 版本，外加各种应排除的 Release。
 * @returns { releases, manifests } manifests 以 tag 为键（缺席 = tarball 读不出）。
 */
function fixture(): { releases: Record<string, unknown>[]; manifests: Map<string, Record<string, unknown>> } {
  const releases: Record<string, unknown>[] = [
    releaseOf("dsh-any-connect", "0.4.28-alpha.5", { published: "2026-10-29T14:04:29Z" }),
    releaseOf("dsh-any-connect", "0.4.28-alpha.4", { published: "2026-10-29T13:23:16Z" }),
    // 0.2.2 适配线之前的稳定版：只有旧字段 dsh.host（精确 pin）→ 映射成 0.2.1 线区间收录。
    releaseOf("dsh-any-connect", "0.4.27", { published: "2026-10-28T07:14:01Z", prerelease: false }),
    // 既无 engines.dsh 也无 dsh.host 的旧版本 → 继续排除。
    releaseOf("dsh-any-connect", "0.4.26", { published: "2026-10-27T07:00:00Z", prerelease: false }),
    releaseOf("provider-usage", "0.2.1-alpha.4", { published: "2026-10-29T13:24:29Z" }),
    // 缺 dsh.bundle 的 alpha 版本 → 排除（索引只收 bundle 包）。
    releaseOf("provider-usage", "0.2.1-alpha.3", { published: "2026-10-29T10:00:59Z" }),
    // 稳定线版本（旧 dsh.host pin）→ 映射收录；覆盖双线共存的索引形态。
    releaseOf("provider-usage", "0.2.0", { published: "2026-10-27T06:00:00Z", prerelease: false }),
    // dsh.host 不是精确版本（range）→ fail-safe 跳过并记录 invalid-dsh-host-pin。
    releaseOf("provider-usage", "0.1.0", { published: "2026-10-20T06:00:00Z", prerelease: false }),
    releaseOf("sandbox-extra-roots", "0.4.28-alpha.3", { published: "2026-10-29T14:05:40Z" }),
    releaseOf("sandbox-extra-roots", "0.4.28-alpha.2", { published: "2026-10-29T13:25:38Z" }),
    releaseOf("sandbox-extra-roots", "0.4.27", { published: "2026-10-28T07:20:00Z", prerelease: false }),
    releaseOf("session-archive", "0.3.32-alpha.3", { published: "2026-10-29T14:06:50Z" }),
    releaseOf("session-archive", "0.3.31", { published: "2026-10-28T07:30:00Z", prerelease: false }),
    // 排除项：草稿、非发布 tag、缺资产、多 tgz 且无约定名、tag 不是精确 semver。
    releaseOf("session-archive", "0.3.32-alpha.4", { draft: true }),
    { tag_name: "dsh-v0.2.2-alpha.2", draft: false, prerelease: false, published_at: "2026-10-29T00:00:00Z", assets: [] },
    { tag_name: "provider-usage-v0.2.1-alpha.2", draft: false, prerelease: true, published_at: "2026-10-29T00:00:00Z", assets: [] },
    releaseOf("sandbox-extra-roots", "0.4.28-alpha.1", {
      assets: [
        { id: 8, name: "sandbox-0.4.28-alpha.1.tgz", size: 1, browser_download_url: "https://github.com/" + REPO + "/releases/download/x/sandbox-0.4.28-alpha.1.tgz" },
        { id: 9, name: "extra.tgz", size: 1, browser_download_url: "https://github.com/" + REPO + "/releases/download/x/extra.tgz" },
      ],
    }),
    { tag_name: "session-archive-v0.3.32-alpha.2", draft: false, prerelease: true, published_at: "not-a-date", assets: [] },
    { tag_name: "session-archive-vnext", draft: false, prerelease: true, published_at: "2026-10-29T00:00:00Z", assets: [] },
  ];
  const manifests = new Map<string, Record<string, unknown>>();
  manifests.set(releaseTagFor("dsh-any-connect", "0.4.28-alpha.5"), manifestOf("dsh-any-connect", "0.4.28-alpha.5"));
  manifests.set(releaseTagFor("dsh-any-connect", "0.4.28-alpha.4"), manifestOf("dsh-any-connect", "0.4.28-alpha.4"));
  manifests.set(
    releaseTagFor("dsh-any-connect", "0.4.27"),
    legacyManifestOf("dsh-any-connect", "0.4.27", "0.2.1-rc.3"),
  );
  manifests.set(releaseTagFor("dsh-any-connect", "0.4.26"), noHostManifestOf("dsh-any-connect", "0.4.26"));
  manifests.set(releaseTagFor("provider-usage", "0.2.1-alpha.4"), manifestOf("provider-usage", "0.2.1-alpha.4"));
  manifests.set(
    releaseTagFor("provider-usage", "0.2.1-alpha.3"),
    manifestOf("provider-usage", "0.2.1-alpha.3", { dsh: { manifestVersion: 1, client: { platform: "web", inject: [] } } }),
  );
  manifests.set(releaseTagFor("sandbox-extra-roots", "0.4.28-alpha.3"), manifestOf("sandbox-extra-roots", "0.4.28-alpha.3"));
  manifests.set(releaseTagFor("sandbox-extra-roots", "0.4.28-alpha.2"), manifestOf("sandbox-extra-roots", "0.4.28-alpha.2"));
  manifests.set(releaseTagFor("sandbox-extra-roots", "0.4.27"), legacyManifestOf("sandbox-extra-roots", "0.4.27", "0.2.1-rc.3"));
  manifests.set(releaseTagFor("sandbox-extra-roots", "0.4.28-alpha.1"), manifestOf("sandbox-extra-roots", "0.4.28-alpha.1"));
  manifests.set(releaseTagFor("session-archive", "0.3.32-alpha.3"), manifestOf("session-archive", "0.3.32-alpha.3"));
  manifests.set(releaseTagFor("session-archive", "0.3.31"), legacyManifestOf("session-archive", "0.3.31", "0.2.1-rc.3"));
  manifests.set(releaseTagFor("provider-usage", "0.2.0"), legacyManifestOf("provider-usage", "0.2.0", "0.2.1-rc.3"));
  // dsh.host 是 range（非精确 pin）→ 不收：值来自真实历史 tarball 里出现过的旧字段。
  manifests.set(releaseTagFor("provider-usage", "0.1.0"), legacyManifestOf("provider-usage", "0.1.0", "^0.2.1"));
  return { releases, manifests };
}

/** 用 fixture 生成站点（重复调用结果应逐字节一致）。 */
function buildFixtureSite() {
  const { releases, manifests } = fixture();
  const collected = collectCandidates(releases, { dirs: DIRS });
  // 所有候选都交给 buildSite：收录判定（dsh.bundle + engines.dsh）由它统一做，
  // 不在此预过滤，这样才能断言 summary.skipped 的排除原因。
  const site = buildSite({
    repo: REPO,
    baseUrl: BASE_URL,
    registryUrl: REGISTRY_URL,
    candidates: withDigests(collected.candidates),
    manifests,
    expectedNames: EXPECTED,
  });
  return { site, collected };
}

/** 读取 fixture 站点里的文件（缺失即抛，避免测试里到处非空断言）。 */
function mustFile(files: ReadonlyMap<string, string>, path: string): string {
  const text = files.get(path);
  if (text === undefined) throw new Error("fixture 缺少文件: " + path);
  return text;
}

/** 取数组某项（fixture 断言用；缺失即失败而不是静默 undefined）。 */
function mustItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error("fixture 缺少索引 " + String(index));
  return item;
}

/** packages/ 目录 → npm 包名（fixture 期望值；缺失即失败）。 */
function nameOf(dir: string): string {
  const name = EXPECTED[dir];
  if (name === undefined) throw new Error("fixture 缺少包名: " + dir);
  return name;
}

/** packages/ 目录 → 展示元数据（缺失即失败）。 */
function displayOf(dir: string | undefined): PackageDisplay {
  if (dir === undefined) throw new Error("fixture 未找到包目录");
  const display = PACKAGE_DISPLAY[dir];
  if (display === undefined) throw new Error("fixture 缺少展示元数据: " + dir);
  return display;
}

/** 索引里的 LocalizedText（string | 语言映射）；测试取 en。 */
function english(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, string>).en;
}

/** 克隆站点并对某个 JSON 文件做局部修改（值会按规范序列化写回）。 */
function mutateJson(files: ReadonlyMap<string, string>, path: string, mutate: (value: any) => void): Map<string, string> {
  const next = new Map(files);
  const value = JSON.parse(mustFile(files, path));
  mutate(value);
  next.set(path, serializeJson(value));
  return next;
}

/** 收录判定失败原因（失败即抛，避免在可辨识联合上到处断言）。 */
function reasonOf(inspection: ManifestInspection): string {
  if (inspection.eligible) throw new Error("期望不收录，但判定为可收录");
  return inspection.reason;
}

/** 取 dsh.host pin 的映射区间（失败即抛，避免到处非空断言）。 */
function mappedOf(pin: string): string {
  const range = mapHostPinToRange(pin);
  if (range === undefined) throw new Error("pin 无法映射: " + pin);
  return range;
}

/** 用既有站点还原出的历史版本重建站点（模拟 CI 的 build --previous）。 */
function rebuildFromPrevious(files: ReadonlyMap<string, string>) {
  const previous = previousManifests({ files, expectedNames: EXPECTED });
  const candidates = [...previous.entries()].map(([tag, prior]) => {
    const parsed = parseReleaseTag(tag, DIRS);
    if (parsed === undefined) throw new Error("fixture tag 不合法: " + tag);
    return {
      dir: parsed.dir,
      version: parsed.version,
      tag,
      publishedAt: prior.publishedAt,
      asset: { name: assetNameFor(parsed.dir, parsed.version), size: 0, browserDownloadUrl: prior.tarball },
      fallbackAsset: false,
      prerelease: true,
      integrity: prior.integrity,
      shasum: prior.shasum,
    };
  });
  const manifests = new Map<string, Record<string, unknown>>([...previous].map(([tag, prior]) => [tag, prior.manifest]));
  return buildSite({ repo: REPO, baseUrl: BASE_URL, registryUrl: REGISTRY_URL, candidates, manifests, expectedNames: EXPECTED });
}

/** 运行 check 站点的最小封装（与 CLI 同样的注入）。 */
function checkSite(files: ReadonlyMap<string, string>) {
  return validateSite({ files, repo: REPO, baseUrl: BASE_URL, registryUrl: REGISTRY_URL, expectedNames: EXPECTED, parseIndex: parseMarketIndex });
}

describe("类型声明与实现一致", () => {
  it("plugin-market-core.d.mts 的导出面与实现一致（防止声明漂移）", async () => {
    const actual = Object.keys(await import("../scripts/lib/plugin-market-core.mjs")).sort();
    const declared = [...readFileSync(join(ROOT, "scripts/lib/plugin-market-core.d.mts"), "utf8")
      .matchAll(/export declare (?:const|function|class) (\w+)/g)].map(match => match[1] as string).sort();
    expect(actual).toEqual(declared);
  });
});

describe("发布 tag 与资产命名", () => {
  it("tag/资产名与 publish.yml 约定一致", () => {
    expect(releaseTagFor("session-archive", "0.3.32-alpha.3")).toBe("session-archive-v0.3.32-alpha.3");
    expect(assetNameFor("session-archive", "0.3.32-alpha.3")).toBe("chaoset-session-archive-0.3.32-alpha.3.tgz");
    expect(parseReleaseTag("session-archive-v0.3.32-alpha.3", DIRS)).toEqual({ dir: "session-archive", version: "0.3.32-alpha.3" });
  });

  it("非发布形态的 tag 返回 undefined", () => {
    expect(parseReleaseTag("dsh-v0.2.2-alpha.2", DIRS)).toBeUndefined();
    expect(parseReleaseTag("session-archive-vnext", DIRS)).toBeUndefined();
    expect(parseReleaseTag("unknown-pkg-v1.0.0", DIRS)).toBeUndefined();
    expect(parseReleaseTag(42, DIRS)).toBeUndefined();
  });

  it("registry URL 规范化：补尾斜杠，拒绝非 http(s)/带查询串", () => {
    expect(normalizeRegistryUrl(BASE_URL + "/npm")).toBe(BASE_URL + "/npm/");
    expect(normalizeRegistryUrl("http://127.0.0.1:54321/npm/")).toBe("http://127.0.0.1:54321/npm/");
    expect(() => normalizeRegistryUrl("ftp://example.com/")).toThrow(MarketInputError);
    expect(() => normalizeRegistryUrl("https://example.com/npm/?x=1")).toThrow(MarketInputError);
    expect(() => normalizeRegistryUrl("not a url")).toThrow(MarketInputError);
  });
});

describe("collectCandidates", () => {
  it("筛选 Release：tag 形态、draft、资产命名、published_at", () => {
    const { collected } = buildFixtureSite();
    const versions = collected.candidates.map(candidate => candidate.dir + "@" + candidate.version);
    expect(versions).toEqual([
      "dsh-any-connect@0.4.28-alpha.5",
      "dsh-any-connect@0.4.28-alpha.4",
      "dsh-any-connect@0.4.27",
      "dsh-any-connect@0.4.26",
      "provider-usage@0.2.1-alpha.4",
      "provider-usage@0.2.1-alpha.3",
      "provider-usage@0.2.0",
      "provider-usage@0.1.0",
      "sandbox-extra-roots@0.4.28-alpha.3",
      "sandbox-extra-roots@0.4.28-alpha.2",
      "sandbox-extra-roots@0.4.27",
      "session-archive@0.3.32-alpha.3",
      "session-archive@0.3.31",
    ]);
    const reasons = collected.skipped.map(item => item.tag + " => " + item.reason);
    expect(reasons).toContain("session-archive-v0.3.32-alpha.4 => draft");
    expect(reasons).toContain("sandbox-extra-roots-v0.4.28-alpha.1 => asset-name-mismatch");
    expect(reasons).toContain("provider-usage-v0.2.1-alpha.2 => asset-missing");
    expect(reasons).toContain("session-archive-v0.3.32-alpha.2 => missing-published-at");
  });

  it("只有单个 .tgz 且命名不符时兜底收录（fallbackAsset）", () => {
    const release = releaseOf("provider-usage", "0.2.1-alpha.9", {
      assets: [{ id: 3, name: "renamed-0.2.1-alpha.9.tgz", size: 1, browser_download_url: "https://github.com/" + REPO + "/releases/download/provider-usage-v0.2.1-alpha.9/renamed-0.2.1-alpha.9.tgz" }],
    });
    const collected = collectCandidates([release], { dirs: DIRS });
    expect(collected.candidates).toHaveLength(1);
    expect(mustItem(collected.candidates, 0).fallbackAsset).toBe(true);
    expect(mustItem(collected.candidates, 0).asset.name).toBe("renamed-0.2.1-alpha.9.tgz");
  });

  it("同一版本重复出现时保留发布时间较新的一条", () => {
    const older = releaseOf("session-archive", "0.3.32-alpha.3", { published: "2026-10-01T00:00:00Z" });
    const newer = releaseOf("session-archive", "0.3.32-alpha.3", { published: "2026-10-29T14:06:50Z" });
    const collected = collectCandidates([older, newer], { dirs: DIRS });
    expect(collected.candidates).toHaveLength(1);
    expect(mustItem(collected.candidates, 0).publishedAt).toBe(Date.parse("2026-10-29T14:06:50Z") / 1000);
    expect(collected.skipped.some(item => item.reason === "duplicate-version")).toBe(true);
  });
});

describe("tarball 读取与收录判定", () => {
  it("从 tar 里读出 package/package.json（不要求它是第一个条目）", () => {
    const manifest = manifestOf("provider-usage", "0.2.1-alpha.4");
    const bytes = tarballOf([
      { name: "package/README.md", data: Buffer.from("# readme\n") },
      { name: "package/package.json", data: Buffer.from(JSON.stringify(manifest)) },
      { name: "package/lib/index.js", data: Buffer.from("export {}\n") },
    ]);
    expect(readPackageJsonFromTarball(bytes)).toEqual(manifest);
  });

  it("非法 gzip / 缺 package.json 给出可读错误", () => {
    expect(() => readPackageJsonFromTarball(Buffer.from("not a tarball"))).toThrow(/gzip/);
    const empty = tarballOf([{ name: "package/README.md", data: Buffer.from("x") }]);
    expect(() => readPackageJsonFromTarball(empty)).toThrow(/缺少 package\/package.json/);
  });

  it("收录条件：名称/版本一致 + dsh.bundle + engines.dsh 或旧 dsh.host 精确 pin", () => {
    const candidate = { version: "0.2.1-alpha.4", tag: "provider-usage-v0.2.1-alpha.4" };
    expect(inspectManifest(manifestOf("provider-usage", "0.2.1-alpha.4"), candidate, nameOf("provider-usage"))).toEqual({
      eligible: true,
      enginesDsh: "^0.2.2-alpha.2",
      rangeSource: "engines",
    });
    expect(reasonOf(inspectManifest(null, candidate, nameOf("provider-usage")))).toBe("manifest-not-object");
    expect(reasonOf(inspectManifest(manifestOf("dsh-any-connect", "0.2.1-alpha.4"), candidate, nameOf("provider-usage")))).toMatch(/name-mismatch/);
    expect(reasonOf(inspectManifest(manifestOf("provider-usage", "0.2.1-alpha.3"), candidate, nameOf("provider-usage")))).toMatch(/version-mismatch/);
    expect(reasonOf(inspectManifest(manifestOf("provider-usage", "0.2.1-alpha.3", { engines: { node: ">=24.9.0" } }), { version: "0.2.1-alpha.3", tag: "provider-usage-v0.2.1-alpha.3" }, nameOf("provider-usage")))).toBe("missing-engines-dsh");
    expect(reasonOf(inspectManifest(manifestOf("provider-usage", "0.2.1-alpha.3", { dsh: { manifestVersion: 1 } }), { version: "0.2.1-alpha.3", tag: "provider-usage-v0.2.1-alpha.3" }, nameOf("provider-usage")))).toBe("missing-dsh-bundle");
  });

  it("旧清单只有 dsh.host 精确 pin 时映射成该宿主线区间", () => {
    const candidate = { version: "0.4.27", tag: "dsh-any-connect-v0.4.27" };
    expect(inspectManifest(legacyManifestOf("dsh-any-connect", "0.4.27", "0.2.1-rc.3"), candidate, nameOf("dsh-any-connect"))).toEqual({
      eligible: true,
      enginesDsh: ">=0.2.1-rc.3 <0.2.2-0",
      rangeSource: "dsh-host",
    });
    // pin 不是精确版本（range/非法）→ fail-safe 跳过，原因里带上原值便于排查。
    expect(reasonOf(inspectManifest(legacyManifestOf("dsh-any-connect", "0.4.27", "^0.2.1"), candidate, nameOf("dsh-any-connect")))).toBe('invalid-dsh-host-pin: "^0.2.1"');
    expect(reasonOf(inspectManifest(legacyManifestOf("dsh-any-connect", "0.4.27", "latest"), candidate, nameOf("dsh-any-connect")))).toBe('invalid-dsh-host-pin: "latest"');
    // 两者都没有 → missing-engines-dsh。
    expect(reasonOf(inspectManifest(noHostManifestOf("dsh-any-connect", "0.4.27"), candidate, nameOf("dsh-any-connect")))).toBe("missing-engines-dsh");
  });
});

describe("buildSite", () => {
  it("同时收录 0.2.2 预览线与旧 0.2.1 稳定线，各插件按版本降序", () => {
    const { site } = buildFixtureSite();
    const index = JSON.parse(mustFile(site.files, "index.json"));
    const names = index.plugins.map((plugin: any) => plugin.name);
    expect(names).toEqual(DIRS.map(dir => nameOf(dir)));
    const anyConnect = index.plugins.find((plugin: any) => plugin.name === nameOf("dsh-any-connect"));
    expect(anyConnect.versions.map((version: any) => version.version)).toEqual(["0.4.28-alpha.5", "0.4.28-alpha.4", "0.4.27"]);
    expect(site.summary.versionCount).toBe(10);
    expect(site.summary.rangeSources).toEqual({ engines: 6, "dsh-host": 4 });
    const skippedReasons = site.summary.skipped.map(item => item.reason).join("\n");
    expect(skippedReasons).toContain("missing-engines-dsh");
    expect(skippedReasons).toContain("missing-dsh-bundle");
    expect(skippedReasons).toContain("invalid-dsh-host-pin");
  });

  it("index.json 被官方 parseMarketIndex 接受，且元数据完整", () => {
    const { site } = buildFixtureSite();
    const index = parseMarketIndex(JSON.parse(mustFile(site.files, "index.json")), BASE_URL + "/index.json");
    expect(index.format).toBe(1);
    expect(english(index.title)).toBeTruthy();
    expect(Object.keys(index.metadata.categories).length).toBeGreaterThan(0);
    for (const plugin of index.plugins) {
      expect(plugin.icon).toBe(BASE_URL + "/icons/" + displayOf(DIRS.find(dir => nameOf(dir) === plugin.name)).slug + ".svg");
      expect(plugin.metadata.category).toBeTruthy();
      for (const version of plugin.versions) {
        expect(version.source).toEqual({ type: "npm", registry: REGISTRY_URL });
        expect(["^0.2.2-alpha.2", ">=0.2.1-rc.3 <0.2.2-0"]).toContain(version.engines.dsh);
        expect(Number.isInteger(version.publishTimestamp)).toBe(true);
      }
    }
  });

  it("静态 registry 的 packument 与索引一致（版本/时间/dist 摘要）", () => {
    const { site } = buildFixtureSite();
    const index = JSON.parse(mustFile(site.files, "index.json"));
    for (const plugin of index.plugins as any[]) {
      const packument = JSON.parse(mustFile(site.files, packumentPath(plugin.name)));
      expect(packument.name).toBe(plugin.name);
      expect(Object.keys(packument.versions).sort()).toEqual(plugin.versions.map((version: any) => version.version).sort());
      for (const version of plugin.versions as any[]) {
        const packed = packument.versions[version.version];
        expect(packed.version).toBe(version.version);
        expect(packed.engines.dsh).toBe(version.engines.dsh);
        expect(packed.dsh.bundle).toBeTruthy();
        // 旧清单版本：packument 保留原始 dsh.host，engines.dsh 必须等于它映射出的区间；
        // 新清单版本：engines.dsh 原样使用，且 packument 不应出现 dsh.host。
        if (packed.dsh.host === undefined) {
          expect(packed.engines.dsh).toBe("^0.2.2-alpha.2");
        } else {
          expect(packed.engines.dsh).toBe(mapHostPinToRange(packed.dsh.host));
          expect(packed.engines.dsh).toBe(">=0.2.1-rc.3 <0.2.2-0");
        }
        expect(packed.engines.node).toBeTruthy();
        expect(packed.dist.tarball).toBe(
          "https://github.com/" + REPO + "/releases/download/" + releaseTagFor(plugin.name.replace("@chaoset/", ""), version.version)
            + "/" + assetNameFor(plugin.name.replace("@chaoset/", ""), version.version),
        );
        // 静态 registry 只承载本仓插件；依赖段会把 pnpm 的 --registry 引向静态 registry 而 404，
        // 宿主依赖由宿主 runtime resolution 补齐（见 core 里 packumentVersion 的注释）。
        for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
          expect(packed[section], "packument 不得声明 " + section).toBeUndefined();
        }
        expect(packed.dist.integrity).toMatch(/^sha512-/);
        expect(packed.dist.shasum).toMatch(/^[0-9a-f]{40}$/);
        expect(Date.parse(packument.time[version.version]) / 1000).toBe(version.publishTimestamp);
      }
      const stable = plugin.versions.filter((version: any) => !version.version.includes("-"));
      const expectedLatest = stable.length > 0 ? stable[0].version : plugin.versions[0].version;
      expect(packument["dist-tags"].latest).toBe(expectedLatest);
    }
  });

  it("图标是确定性 SVG 且每个插件一个", () => {
    const { site } = buildFixtureSite();
    for (const [dir, display] of Object.entries(PACKAGE_DISPLAY)) {
      const svg = mustFile(site.files, "icons/" + display.slug + ".svg");
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.endsWith("\n")).toBe(true);
      expect(svg).toContain('aria-label="' + display.title.zh);
      expect(nameOf(dir)).toBeTruthy();
    }
  });

  it("market 分支根目录带固定 README（说明由 CI 生成）", () => {
    const { site } = buildFixtureSite();
    expect(mustFile(site.files, "README.md")).toBe(MARKET_README);
    expect(MARKET_README).toContain("请勿手工编辑");
    expect(site.files.size).toBe(10);
  });

  it("既有站点可还原历史版本并重建出完全相同的站点（--previous）", () => {
    const { site } = buildFixtureSite();
    const previous = previousManifests({ files: site.files, expectedNames: EXPECTED });
    expect([...previous.keys()].sort()).toEqual([
      "dsh-any-connect-v0.4.27",
      "dsh-any-connect-v0.4.28-alpha.4",
      "dsh-any-connect-v0.4.28-alpha.5",
      "provider-usage-v0.2.0",
      "provider-usage-v0.2.1-alpha.4",
      "sandbox-extra-roots-v0.4.27",
      "sandbox-extra-roots-v0.4.28-alpha.2",
      "sandbox-extra-roots-v0.4.28-alpha.3",
      "session-archive-v0.3.31",
      "session-archive-v0.3.32-alpha.3",
    ]);
    const rebuilt = rebuildFromPrevious(site.files);
    expect(rebuilt.summary.digest).toBe(site.summary.digest);
    for (const path of site.files.keys()) expect(rebuilt.files.get(path)).toBe(site.files.get(path));
  });

  it("重复构建逐字节确定（与 Map 插入顺序无关）", () => {
    const first = buildFixtureSite().site;
    const second = buildFixtureSite().site;
    expect(siteDigest(first.files)).toBe(siteDigest(second.files));
    expect([...first.files.keys()].sort()).toEqual([...second.files.keys()].sort());
    for (const path of first.files.keys()) expect(first.files.get(path)).toBe(second.files.get(path));
  });
});

describe("版本区分（稳定线 / 预览线）", () => {
  it("dsh.host 精确 pin → 该宿主线区间（映射单测）", () => {
    expect(mappedOf("0.2.1-rc.3")).toBe(">=0.2.1-rc.3 <0.2.2-0");
    expect(mappedOf("0.2.1")).toBe(">=0.2.1 <0.2.2-0");
    expect(mappedOf("0.2.2-alpha.2")).toBe(">=0.2.2-alpha.2 <0.2.3-0");
    expect(mappedOf("0.1.6-alpha.2")).toBe(">=0.1.6-alpha.2 <0.1.7-0");
    // 只接受精确版本：range / 非法值一律 undefined（收录侧 fail-safe 跳过）。
    for (const invalid of ["^0.2.1", "~0.2.1", ">=0.2.1", "0.2", "0.2.1.x", "latest", "0.2.1 || 0.2.2", "", " 0.2.1 ", 42, null, undefined]) {
      expect(mapHostPinToRange(invalid), "pin 应拒绝: " + String(invalid)).toBeUndefined();
    }
  });

  it("映射区间的 semver 语义（宿主兼容检查用 includePrerelease 比较）", () => {
    const satisfies = (host: string, range: string): boolean => semver.satisfies(host, range, { includePrerelease: true });
    const stableLine = mappedOf("0.2.1-rc.3");
    // 0.2.1 线：只认自己这条线（下界含 pin 及其后的同线版本，上界排除 0.2.2 全部版本）。
    expect(satisfies("0.2.1-rc.3", stableLine)).toBe(true);
    expect(satisfies("0.2.1", stableLine)).toBe(true);
    expect(satisfies("0.2.1-alpha.1", stableLine)).toBe(false);
    expect(satisfies("0.2.0-rc.2", stableLine)).toBe(false);
    expect(satisfies("0.2.2-alpha.2", stableLine)).toBe(false);
    expect(satisfies("0.2.2", stableLine)).toBe(false);
    // 0.2.2 线：新清单 engines.dsh 原样使用，同线 alpha/rc/final 都兼容。
    const previewLine = "^0.2.2-alpha.2";
    expect(satisfies("0.2.2-alpha.2", previewLine)).toBe(true);
    expect(satisfies("0.2.2-rc.1", previewLine)).toBe(true);
    expect(satisfies("0.2.2", previewLine)).toBe(true);
    expect(satisfies("0.2.1", previewLine)).toBe(false);
    expect(satisfies("0.2.2-alpha.1", previewLine)).toBe(false);
    expect(satisfies("0.3.0-alpha.1", previewLine)).toBe(false);
  });

  it("行为矩阵：稳定宿主默认推荐稳定版，预览宿主回退 versions[0]", () => {
    const { site } = buildFixtureSite();
    const index = JSON.parse(mustFile(site.files, "index.json"));
    const satisfies = (host: string, range: string): boolean => semver.satisfies(host, range, { includePrerelease: true });
    /** 复刻宿主 discover 行为：兼容版本里优先最高稳定版；没有则回退 versions[0]（索引降序首条）。 */
    function recommend(host: string, plugin: any): string {
      const compatible = plugin.versions.filter((version: any) => satisfies(host, version.engines.dsh));
      const stable = compatible.filter((version: any) => !version.version.includes("-"));
      if (stable.length > 0) return stable[0].version;
      return compatible.length > 0 ? compatible[0].version : plugin.versions[0].version;
    }
    const stableHost: Record<string, string> = {
      "@chaoset/dsh-any-connect": "0.4.27",
      "@chaoset/provider-usage": "0.2.0",
      "@chaoset/sandbox-extra-roots": "0.4.27",
      "@chaoset/session-archive": "0.3.31",
    };
    const previewHost: Record<string, string> = {
      "@chaoset/dsh-any-connect": "0.4.28-alpha.5",
      "@chaoset/provider-usage": "0.2.1-alpha.4",
      "@chaoset/sandbox-extra-roots": "0.4.28-alpha.3",
      "@chaoset/session-archive": "0.3.32-alpha.3",
    };
    for (const plugin of index.plugins as any[]) {
      // 0.2.1 稳定宿主：默认到该包最高的稳定版；预览版在版本列表全部不兼容。
      expect(recommend("0.2.1", plugin), plugin.name).toBe(stableHost[plugin.name]);
      for (const version of plugin.versions as any[]) {
        if (!version.version.includes("-")) continue;
        expect(satisfies("0.2.1", version.engines.dsh), plugin.name + "@" + version.version).toBe(false);
      }
      // 0.2.2-alpha.2 / rc / final 宿主：只兼容预览线，默认回退 versions[0]（最高预览版）。
      for (const host of ["0.2.2-alpha.2", "0.2.2-rc.1", "0.2.2"]) {
        expect(recommend(host, plugin), host + " " + plugin.name).toBe(previewHost[plugin.name]);
        for (const version of plugin.versions as any[]) {
          if (!version.version.includes("-")) {
            // 稳定线版本在预览宿主下不可安装（区间上界排除整条预览线）。
            expect(satisfies(host, version.engines.dsh), host + " " + plugin.name + "@" + version.version).toBe(false);
          }
        }
      }
    }
  });
});

describe("validateSite（check 的正向与反向）", () => {
  it("自建站点通过校验，并且摘要与 buildSite 一致", () => {
    const { site } = buildFixtureSite();
    const result = checkSite(site.files);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary.digest).toBe(siteDigest(site.files));
    expect(result.summary.plugins).toBe(4);
    expect(result.summary.versionCount).toBe(10);
  });

  it("registry 漂移被拒绝", () => {
    const { site } = buildFixtureSite();
    const files = mutateJson(site.files, "index.json", (index: any) => {
      index.plugins[0].versions[0].source.registry = "https://registry.npmjs.org/";
    });
    const result = checkSite(files);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/source\.registry 期望/);
  });

  it("图标文件缺失被拒绝", () => {
    const { site } = buildFixtureSite();
    const files = new Map(site.files);
    files.delete("icons/" + displayOf("dsh-any-connect").slug + ".svg");
    const result = checkSite(files);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/缺少文件|缺少图标文件/);
  });

  it("engines.dsh 与 packument 不一致被拒绝", () => {
    const { site } = buildFixtureSite();
    const pluginName = nameOf("provider-usage");
    const files = mutateJson(site.files, packumentPath(pluginName), (packument: any) => {
      const version = mustItem(Object.keys(packument.versions), 0);
      packument.versions[version].engines.dsh = "^9.9.9";
    });
    const result = checkSite(files);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/engines\.dsh 与索引不一致/);
  });

  it("tarball URL 错位与重复被拒绝", () => {
    const { site } = buildFixtureSite();
    const pluginName = nameOf("dsh-any-connect");
    const broken = mutateJson(site.files, packumentPath(pluginName), (packument: any) => {
      const versions = Object.keys(packument.versions);
      packument.versions[mustItem(versions, 0)].dist.tarball = "https://example.com/a.tgz";
    });
    expect(checkSite(broken).errors.join("\n")).toMatch(/dist\.tarball 期望/);
    const duplicated = mutateJson(site.files, packumentPath(pluginName), (packument: any) => {
      const versions = Object.keys(packument.versions);
      packument.versions[mustItem(versions, 1)].dist.tarball = packument.versions[mustItem(versions, 0)].dist.tarball;
    });
    expect(checkSite(duplicated).errors.join("\n")).toMatch(/tarball URL 重复/);
  });

  it("packument 版本集合与索引不一致被拒绝", () => {
    const { site } = buildFixtureSite();
    const pluginName = nameOf("sandbox-extra-roots");
    const files = mutateJson(site.files, packumentPath(pluginName), (packument: any) => {
      delete packument.versions["0.4.28-alpha.2"];
      delete packument.time["0.4.28-alpha.2"];
    });
    const result = checkSite(files);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/缺少版本 0\.4\.28-alpha\.2/);
  });

  it("packument 里出现依赖段被拒绝（防止 --registry 解析宿主依赖 404）", () => {
    const { site } = buildFixtureSite();
    const pluginName = nameOf("dsh-any-connect");
    const files = mutateJson(site.files, packumentPath(pluginName), (packument: any) => {
      const version = mustItem(Object.keys(packument.versions), 0);
      packument.versions[version].dependencies = { zod: "4.4.3" };
    });
    const result = checkSite(files);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/不得声明 dependencies/);
  });

  it("映射区间被手改（上界不是下一条线）被拒绝", () => {
    const { site } = buildFixtureSite();
    const pluginName = nameOf("dsh-any-connect");
    const wrong = ">=0.2.1-rc.3 <0.3.0-0";
    const withIndex = mutateJson(site.files, "index.json", (index: any) => {
      const plugin = index.plugins.find((candidate: any) => candidate.name === pluginName);
      const version = plugin.versions.find((candidate: any) => candidate.version === "0.4.27");
      version.engines.dsh = wrong;
    });
    const files = mutateJson(withIndex, packumentPath(pluginName), (packument: any) => {
      packument.versions["0.4.27"].engines.dsh = wrong;
    });
    expect(checkSite(files).errors.join("\n")).toMatch(/映射区间应以/);
  });

  it("dsh.host 与 engines.dsh 的映射关系不一致被拒绝", () => {
    const { site } = buildFixtureSite();
    const pluginName = nameOf("dsh-any-connect");
    // dsh.host 仍是 0.2.1-rc.3，但 engines.dsh 被改成 0.2.1-rc.9 的映射区间（索引同步手改）。
    const wrong = mappedOf("0.2.1-rc.9");
    const withIndex = mutateJson(site.files, "index.json", (index: any) => {
      const plugin = index.plugins.find((candidate: any) => candidate.name === pluginName);
      const version = plugin.versions.find((candidate: any) => candidate.version === "0.4.27");
      version.engines.dsh = wrong;
    });
    const files = mutateJson(withIndex, packumentPath(pluginName), (packument: any) => {
      packument.versions["0.4.27"].engines.dsh = wrong;
    });
    expect(checkSite(files).errors.join("\n")).toMatch(/应等于 dsh\.host 的映射结果/);
  });

  it("映射区间版本缺少来源 dsh.host 被拒绝", () => {
    const { site } = buildFixtureSite();
    const files = mutateJson(site.files, packumentPath(nameOf("dsh-any-connect")), (packument: any) => {
      delete packument.versions["0.4.27"].dsh.host;
    });
    expect(checkSite(files).errors.join("\n")).toMatch(/缺少来源字段 dsh\.host/);
  });

  it("非规范 JSON 被拒绝", () => {
    const { site } = buildFixtureSite();
    const files = new Map(site.files);
    files.set("index.json", JSON.stringify(JSON.parse(mustFile(files, "index.json"))));
    expect(checkSite(files).errors.join("\n")).toMatch(/不是规范序列化/);
  });

  it("marker README 被手改/删除被拒绝", () => {
    const { site } = buildFixtureSite();
    const edited = new Map(site.files);
    edited.set("README.md", MARKET_README + "手工追加一行\n");
    expect(checkSite(edited).errors.join("\n")).toMatch(/README\.md 内容与生成器内置说明不一致/);
    const missing = new Map(site.files);
    missing.delete("README.md");
    expect(checkSite(missing).errors.join("\n")).toMatch(/缺少文件: README\.md/);
  });

  it("多余文件被拒绝", () => {
    const { site } = buildFixtureSite();
    const files = new Map(site.files);
    files.set("rogue.txt", "hi\n");
    expect(checkSite(files).errors.join("\n")).toMatch(/多余文件/);
  });

  it("索引插件顺序/集合与展示元数据不一致被拒绝", () => {
    const { site } = buildFixtureSite();
    const reordered = mutateJson(site.files, "index.json", (index: any) => {
      index.plugins.reverse();
    });
    expect(checkSite(reordered).errors.join("\n")).toMatch(/插件顺序\/集合/);
    const unknown = mutateJson(site.files, "index.json", (index: any) => {
      index.plugins[0].name = "@chaoset/unknown-plugin";
    });
    expect(checkSite(unknown).errors.join("\n")).toMatch(/未知插件/);
  });

  it("官方 parseMarketIndex 拒绝的索引被报告", () => {
    const { site } = buildFixtureSite();
    const files = mutateJson(site.files, "index.json", (index: any) => {
      delete index.title;
    });
    expect(checkSite(files).errors.join("\n")).toMatch(/parseMarketIndex 拒绝索引/);
  });
});

describe("摘要工具", () => {
  it("integrity/shasum 与 node:crypto 一致，站点摘要与文件顺序无关", () => {
    const bytes = Buffer.from("hello market");
    expect(computeIntegrity(bytes)).toBe("sha512-" + createHash("sha512").update(bytes).digest("base64"));
    expect(computeShasum(bytes)).toBe(createHash("sha1").update(bytes).digest("hex"));
    expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    const a = new Map<string, string>([["b.json", "b\n"], ["a.json", "a\n"]]);
    const b = new Map<string, string>([["a.json", "a\n"], ["b.json", "b\n"]]);
    expect(siteDigest(a)).toBe(siteDigest(b));
  });
});

describe("check 子命令（离线 CLI 契约）", () => {
  const dirs: string[] = [];

  function writeSite(files: ReadonlyMap<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "plugin-market-"));
    dirs.push(dir);
    for (const [path, text] of files) {
      const filePath = join(dir, path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, text);
    }
    return dir;
  }

  function runCheck(out: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("node", [join(ROOT, "scripts/plugin-market.mjs"), "check", "--out", out], { cwd: ROOT, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("合法站点 exit 0 并输出摘要 JSON", () => {
    const { site } = buildFixtureSite();
    const out = writeSite(site.files);
    const result = runCheck(out);
    expect(result.stderr).toContain("check 通过");
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.ok).toBe(true);
    expect(summary.summary.versionCount).toBe(10);
  });

  it("被篡改的站点 exit 1 并列出原因", () => {
    const { site } = buildFixtureSite();
    const files = mutateJson(site.files, "index.json", (index: any) => {
      index.plugins[0].versions[0].source.registry = "https://registry.npmjs.org/";
    });
    const out = writeSite(files);
    const result = runCheck(out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("check 失败");
    expect(JSON.parse(result.stdout.trim()).ok).toBe(false);
  });

  it("清理临时站点目录", () => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    expect(dirs.length).toBe(0);
  });
});
