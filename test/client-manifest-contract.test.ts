import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 插件包（Host + Client 双面包）契约锁：`dsh.client` 的取值域与客户端入口。
 *
 * 官方 `DshClientManifest`（@deepseek-ai/dsh-package-manifest，0.2.2-rc.1）：
 * - `platform`：Web 消费者选 `web`；扫描阶段 `platform !== 'web'` 不产生客户端行，
 *   声明了 `dsh.client` 却缺 `exports["./client"]` 会直接 throw；
 * - `immediately`：boot 第一阶段注册屏障，只有基础设施行（gateway/remotes/
 *   connection/file-upload/hmr）用 true；feature 插件缺省进共享 application 批次；
 * - `external`：基线模块表之外的自造模块请求，普通 feature 插件不得用它取其他
 *   feature 插件的值（packages/client/AGENTS.md「Shared modules and the module graph」）。
 *
 * 本仓四包都是产品可见 feature 插件，上述三项的合规取值是 `web` / 不设置 / 不设置；
 * 现状正确但此前没有锁——平台写错或误加 immediately/external 不会被任何测试发现。
 *
 * 反向验证方式：把任一包 `dsh.client.platform` 改成 `"node"`，本锁必须报红。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Pkg {
  name: string;
  dir: string;
  manifest: Record<string, any>;
}

function packages(): Pkg[] {
  const root = join(ROOT, "packages");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((path) => existsSync(join(path, "package.json")))
    .map((path) => ({
      name: path.split("/").pop()!,
      dir: path,
      manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const PKGS = packages();
const CLIENT_PKGS = PKGS.filter((pkg) => pkg.manifest.dsh?.client !== undefined);

describe("dsh.client manifest 契约", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(CLIENT_PKGS.length).toBeGreaterThanOrEqual(4);
  });

  for (const pkg of CLIENT_PKGS) {
    const client = pkg.manifest.dsh.client;

    it(`${pkg.name}: platform 必须是 web 且导出 ./client 构建产物`, () => {
      expect(client.platform, `${pkg.name}: Web 消费者只认 platform: 'web'`).toBe("web");
      expect(pkg.manifest.exports?.["./client"], `${pkg.name}: 声明 dsh.client 必须导出 ./client`).toBe("./client/client.cjs");
    });

    it(`${pkg.name}: feature 插件不设 immediately / external`, () => {
      // immediately 是 boot 第一阶段屏障（只给基础设施行）；external 是基线模块表
      // 之外的自造请求。两者都不是 feature 插件该有的取值，出现即需重新评审。
      expect(client.immediately, `${pkg.name}: feature 插件不得设置 dsh.client.immediately`).toBeUndefined();
      expect(client.external, `${pkg.name}: feature 插件不得设置 dsh.client.external`).toBeUndefined();
    });
  }
});
