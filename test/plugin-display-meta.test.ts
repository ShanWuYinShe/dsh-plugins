import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore 市场生成器是 .mjs，无类型声明；这里只取展示元数据常量。
import { PACKAGE_DISPLAY } from "../scripts/lib/plugin-market-core.mjs";

/**
 * 插件展示元数据锁：bundle 必须能被 Plugin Manager 读出本地化标题/描述与图标。
 *
 * 官方机制（host-repo packages/boot/app-boot/src/package-meta.ts 的
 * `readPluginMeta`）：包根 specifier 读取 `exports['./locale/*.json']` 暴露的
 * `<specifier>/locale/en.json`（同目录其他语言文件逐个解析，`meta.title` /
 * `meta.description` 必须是纯字符串），图标优先取 package.json 顶层 `icon`
 * （包内相对路径），否则取导出的 `<specifier>/icon`；SVG/PNG/JPEG/WebP 且
 * ≤256 KiB。缺失时 Plugin Manager 卡片标题回退为裸包名、图标回退通用图形。
 *
 * 2026-11-04 审计发现四包全部缺失（只显示 `@chaoset/<pkg>` 与通用图标），
 * 且两个展示面（market 静态索引 vs Plugin Manager 本地读取）文案不一致。
 * 本锁把「包内元数据存在且与市场元数据一致」钉死。
 *
 * 反向验证方式：删掉任一包 `locale/zh.json`（或把 icon 改成绝对路径），
 * 本锁必须报红。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 官方 package-meta.ts 的图标大小上限。 */
const MAX_ICON_BYTES = 256 * 1024;

const DISPLAY: Record<string, any> = PACKAGE_DISPLAY;

function packages(): { name: string; dir: string; manifest: Record<string, any> }[] {
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

describe("插件展示元数据：locale meta + icon + 与市场元数据一致", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(PKGS.length).toBeGreaterThanOrEqual(4);
    for (const pkg of PKGS) {
      expect(DISPLAY[pkg.name], `${pkg.name}: 市场生成器 PACKAGE_DISPLAY 缺该包展示元数据`).toBeDefined();
    }
  });

  for (const pkg of PKGS) {
    const display = DISPLAY[pkg.name];

    it(`${pkg.name}: package.json 声明 icon 与 locale 导出并在 files 内`, () => {
      expect(pkg.manifest.icon, `${pkg.name}: 顶层 icon 必须是包内相对路径`).toBe("./icon.svg");
      expect(pkg.manifest.exports?.["./locale/*.json"], `${pkg.name}: exports 缺 ./locale/*.json`).toBe("./locale/*.json");
      expect(pkg.manifest.files).toContain("icon.svg");
      expect(pkg.manifest.files).toContain("locale/*.json");
    });

    it(`${pkg.name}: icon.svg 存在、合法且与市场图标同源`, () => {
      const file = join(pkg.dir, "icon.svg");
      expect(existsSync(file), `${pkg.name}: 缺 icon.svg`).toBe(true);
      const bytes = statSync(file).size;
      expect(bytes, `${pkg.name}: icon.svg 超过官方 256 KiB 上限`).toBeLessThanOrEqual(MAX_ICON_BYTES);
      const svg = readFileSync(file, "utf8");
      expect(svg.trimStart().startsWith("<svg"), `${pkg.name}: icon.svg 不是 SVG`).toBe(true);
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg, `${pkg.name}: icon 背景色与市场图标不一致`).toContain(display.icon.background);
      for (const path of display.icon.paths as string[]) {
        expect(svg, `${pkg.name}: icon 图形与市场图标不一致（缺 ${path.slice(0, 24)}…）`).toContain(path);
      }
    });

    for (const language of ["en", "zh"] as const) {
      it(`${pkg.name}: locale/${language}.json 提供非空 title/description 且与市场文案一致`, () => {
        const file = join(pkg.dir, "locale", `${language}.json`);
        expect(existsSync(file), `${pkg.name}: 缺 locale/${language}.json`).toBe(true);
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        const title = parsed?.meta?.title;
        const description = parsed?.meta?.description;
        // 官方 reader 用 textOf 拒绝空串/非字符串：这里同样要求纯字符串。
        expect(typeof title, `${pkg.name}: meta.title 必须是纯字符串`).toBe("string");
        expect(typeof description, `${pkg.name}: meta.description 必须是纯字符串`).toBe("string");
        expect(title.trim()).not.toBe("");
        expect(description.trim()).not.toBe("");
        expect(title, `${pkg.name}: locale/${language} 标题与市场元数据不一致`).toBe(display.title[language]);
        expect(description, `${pkg.name}: locale/${language} 描述与市场元数据不一致`).toBe(display.description[language]);
      });
    }
  }
});
