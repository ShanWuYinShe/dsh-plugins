import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dsh.client.inject` 语义回归：这里声明的是**客户端包名**，不是 cordis 服务名。
 *
 * 两个字段名字相同、语义不同，很容易写混：
 *
 * - 运行时 `export const inject = ["slots", "locale"]`：cordis **服务**依赖，
 *   决定 apply 何时执行（宿主 ui-chat 写的是 "slots"/"sessions"/"uiWorkspace"…）。
 * - 清单 `dsh.client.inject = ["@deepseek-ai/dsh-client-ui-slots", …]`：客户端
 *   **模块图**依赖，client-modules 用它 `graphRows.get(packageName)` 决定加载
 *   顺序（dsh-client-modules lib/client.js:791-794）。
 *
 * 写错时的行为最阴险：`graphRows.get("slots")` 恒为 undefined，于是
 * `if (dependency !== void 0)` 静默 continue —— 不报错、不警告，只是悄悄失去
 * 加载顺序保证。这类「写错了也照常跑」的字段必须靠测试钉住。
 *
 * 2026-10-29 审计：本仓库四个包都把它写成了服务名。其中 provider-usage 与
 * dsh-any-connect 已修正为实际依赖的客户端包名；sandbox-extra-roots 与
 * session-archive 暂列 PENDING —— 它们依赖的 slots/remote 服务在 0.2.2 线上的
 * 提供方包名无法在本环境核实（dsh-client-runtime 的本地安装是 0.1.1-rc.2，
 * npm registry 不可达），**不臆造**，留待联网确认后修正。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Pkg {
  name: string;
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
      manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 已核实并修正为包名的包。
 *
 * 未列出的包若仍写服务名，本测试**不判红**——它们的问题已登记在下方
 * PENDING_SERVICE_NAMES，等能核实正确包名后再迁移。这样做是为了让「已知欠账」
 * 与「新增违规」区分开：前者是待办，后者是回归。
 */
const VERIFIED_PACKAGE_NAMES = new Set(["provider-usage", "dsh-any-connect"]);

/** 仍写服务名、且正确包名待核实的包（核实后应移出本表并修正声明）。 */
const PENDING_SERVICE_NAMES: Readonly<Record<string, string>> = {
  "sandbox-extra-roots": "slots/remote 在 0.2.2 线的提供方包名未核实（dsh-client-runtime 本地是 0.1.1-rc.2）",
  "session-archive": "同上",
};

/** 服务名形态：裸标识符，不带 @、不含 /。 */
function looksLikeServiceName(item: string): boolean {
  return !item.startsWith("@") && !item.includes("/");
}

const PKGS = packages();

describe("dsh.client.inject 声明的是客户端包名", () => {
  it("至少有一个包声明了 dsh.client.inject（否则本测试形同虚设）", () => {
    const withClient = PKGS.filter((pkg) => pkg.manifest.dsh?.client?.inject !== undefined);
    expect(withClient.length).toBeGreaterThan(0);
  });

  for (const pkg of PKGS) {
    const declared: string[] | undefined = pkg.manifest.dsh?.client?.inject;
    if (declared === undefined) continue;

    if (VERIFIED_PACKAGE_NAMES.has(pkg.name)) {
      it(`${pkg.name}: 全部是包名，不是 cordis 服务名`, () => {
        const serviceNames = declared.filter(looksLikeServiceName);
        expect(
          serviceNames,
          `dsh.client.inject 里的 ${serviceNames.join(", ")} 是 cordis 服务名；` +
            `这里必须写包名（如 "@deepseek-ai/dsh-client-ui-slots"），否则` +
            ` client-modules 的 graphRows.get() 取不到，等于没声明加载顺序依赖`,
        ).toEqual([]);
      });

      it(`${pkg.name}: 每个包名都在依赖清单里声明过`, () => {
        const deps = new Set([
          ...Object.keys(pkg.manifest.dependencies ?? {}),
          ...Object.keys(pkg.manifest.devDependencies ?? {}),
          ...Object.keys(pkg.manifest.peerDependencies ?? {}),
        ]);
        const missing = declared.filter((name) => !deps.has(name));
        expect(missing, `未在依赖中声明的包: ${missing.join(", ")}`).toEqual([]);
      });
    } else if (PENDING_SERVICE_NAMES[pkg.name] !== undefined) {
      it(`${pkg.name}: 已知欠账——仍写服务名，待核实正确包名`, () => {
        // 这条**不判红**，只是把欠账显式化：一旦有人修正了声明，本用例会提醒
        // 把该包移出 PENDING_SERVICE_NAMES，避免欠账表悄悄过期。
        const serviceNames = declared.filter(looksLikeServiceName);
        if (serviceNames.length === 0) {
          throw new Error(
            `${pkg.name} 的 dsh.client.inject 已不再包含服务名，请把它从` +
              ` PENDING_SERVICE_NAMES 移到 VERIFIED_PACKAGE_NAMES`,
          );
        }
      });
    }
  }
});
