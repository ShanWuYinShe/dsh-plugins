import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dsh.client.inject` 语义回归：这里声明的是**客户端包名**，不是 cordis 服务名，
 * 且列出的必须是真正带 `dsh.client` 声明的客户端模块包。
 *
 * 两个字段名字相同、语义不同，很容易写混：
 *
 * - 运行时 `export const inject = ["slots", "locale"]`：cordis **服务**依赖，
 *   决定 apply 何时执行（宿主 ui-chat 写的是 "slots"/"sessions"/"uiWorkspace"…）。
 * - 清单 `dsh.client.inject = ["@deepseek-ai/dsh-client-ui-renderer", …]`：客户端
 *   **模块图**依赖，client-modules 用它 `graphRows.get(packageName)` 决定加载
 *   顺序。
 *
 * 写错时的行为最阴险：`graphRows.get("slots")` 恒为 undefined，于是
 * `if (dependency !== void 0)` 静默 continue —— 不报错、不警告，只是悄悄失去
 * 加载顺序保证。这类「写错了也照常跑」的字段必须靠测试钉住（2026-10-29 审计
 * 时四个包全部写过服务名，根因即此）。
 *
 * 本测试同时把「服务名 → 客户端包名」的映射钉死：从 client 入口解析 cordis
 * inject 数组，再要求清单里出现对应提供方包。新增服务时映射表必须同步扩展，
 * 否则用例会带着服务名报错——这正是想要的效果。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** cordis 客户端服务 → 提供该服务的客户端模块包（host 0.2.2-alpha.2 实测）。 */
const SERVICE_PROVIDERS: Readonly<Record<string, string>> = {
  slots: "@deepseek-ai/dsh-client-ui-renderer",
  locale: "@deepseek-ai/dsh-client-locale",
  remote: "@deepseek-ai/dsh-api-remotes",
  resources: "@deepseek-ai/dsh-client-resources",
  // host-repo 核对（2026-10-29）：workspaces 由 api/workspace-controller 的
  // client service 提供（super(ctx,'workspaces')），sessions 由
  // api/session-controller 的 client sessions 服务提供；不是 ui-workspace /
  // ui-session 这两个展示层包。
  sessions: "@deepseek-ai/dsh-api-session-controller",
  workspaces: "@deepseek-ai/dsh-api-workspace-controller",
  modelDirectories: "@deepseek-ai/dsh-client-ui-model-selection",
};

interface Pkg {
  name: string;
  dir: string;
  manifest: Record<string, any>;
}

function packages(): Pkg[] {
  const dir = join(ROOT, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .filter((path) => {
      try {
        return statSync(join(path, "package.json")).isFile();
      } catch {
        return false;
      }
    })
    .map((path) => ({
      name: path.split("/").pop()!,
      dir: path,
      manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 服务名形态：裸标识符，不带 @、不含 /。 */
function looksLikeServiceName(item: string): boolean {
  return !item.startsWith("@") && !item.includes("/");
}

/** 从 client 入口源码解析 cordis inject 的服务名数组（两种导出/c声明写法都认）。 */
function clientServiceInject(pkg: Pkg): string[] {
  const file = join(pkg.dir, "client", "index.tsx");
  try {
    const text = readFileSync(file, "utf8");
    const match = text.match(/export\s+const\s+inject\s*=\s*\[([^\]]*)\]/) ?? text.match(/const\s+inject\s*=\s*\[([^\]]*)\]/);
    if (match === null) return [];
    return [...match[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
  } catch {
    return [];
  }
}

/** 该包依赖清单里声明的全部包名。 */
function declaredDeps(pkg: Pkg): Set<string> {
  const manifest = pkg.manifest;
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

/** 解析某客户端包是否真的带 dsh.client 声明（从该包自己的 node_modules 解析）。 */
function installedClientManifest(pkg: Pkg, specifier: string): Record<string, any> | undefined {
  try {
    const requireFrom = createRequire(join(pkg.dir, "package.json"));
    return JSON.parse(readFileSync(requireFrom.resolve(`${specifier}/package.json`), "utf8"));
  } catch {
    return undefined;
  }
}

const PKGS = packages();
const CLIENT_PKGS = PKGS.filter((pkg) => pkg.manifest.dsh?.client !== undefined);

describe("dsh.client.inject 声明的是客户端包名与客户端模块", () => {
  it("至少有一个包声明了 dsh.client（否则本测试形同虚设）", () => {
    expect(CLIENT_PKGS.length).toBeGreaterThan(0);
  });

  for (const pkg of CLIENT_PKGS) {
    const declared: string[] = pkg.manifest.dsh?.client?.inject ?? [];

    it(`${pkg.name}: 全部是包名，不是 cordis 服务名`, () => {
      const serviceNames = declared.filter(looksLikeServiceName);
      expect(
        serviceNames,
        `dsh.client.inject 里的 ${serviceNames.join(", ")} 是 cordis 服务名；` +
          "这里必须写客户端包名，否则 client-modules 的 graphRows.get() 取不到，等于没声明加载顺序依赖",
      ).toEqual([]);
    });

    it(`${pkg.name}: 每个包名都在依赖清单里声明过`, () => {
      const deps = declaredDeps(pkg);
      const missing = declared.filter((name) => !deps.has(name));
      expect(missing, `未在依赖中声明的包: ${missing.join(", ")}`).toEqual([]);
    });

    it(`${pkg.name}: 每个包名都指向真正带 dsh.client 的客户端模块`, () => {
      // 客户端库（如 @deepseek-ai/dsh-client-ui-slots）不是模块图里的行：
      // 写进 inject 会被 graphRows 静默忽略，属于无效声明。
      const invalid = declared.filter((name) => {
        const manifest = installedClientManifest(pkg, name);
        return manifest === undefined || manifest.dsh?.client === undefined;
      });
      expect(invalid, `这些包不是带 dsh.client 的客户端模块（或未安装）: ${invalid.join(", ")}`).toEqual([]);
    });

    it(`${pkg.name}: 运行时 cordis inject 的每个服务都有对应提供方包`, () => {
      const services = clientServiceInject(pkg);
      expect(services.length, `${pkg.name}: client 入口应声明 cordis inject 服务`).toBeGreaterThan(0);
      const unknown = services.filter((service) => SERVICE_PROVIDERS[service] === undefined);
      expect(unknown, `未知服务名（请扩展 SERVICE_PROVIDERS 映射）: ${unknown.join(", ")}`).toEqual([]);
      const missingProviders = services
        .map((service) => SERVICE_PROVIDERS[service]!)
        .filter((provider) => !declared.includes(provider));
      expect(missingProviders, `清单缺少服务提供方包: ${missingProviders.join(", ")}`).toEqual([]);
    });

    it(`${pkg.name}: 清单无重复项`, () => {
      expect(new Set(declared).size).toBe(declared.length);
    });
  }
});
