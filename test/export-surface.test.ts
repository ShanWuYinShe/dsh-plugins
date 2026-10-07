import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 导出面回归：不留「无人使用的转发导出」。
 *
 * 拆模块时门面文件常顺手多转出几个名字，后来调用方改从新模块直接导入，转发就没人用了。
 * 这类残留不会报错，但会让「这个符号到底归哪个模块」变得含糊——同一符号在两处都像
 * 是它的家。2026-10-08 审计清掉 10 处（auth.ts / web-status.ts /
 * desktop-credential-protection.ts 等），本测试防止再长回来。
 *
 * 判据：值转发（export 花括号 from 相对模块）里的名字，必须有人从**这个**模块导入它
 * （同包测试也算使用者）。真要留给包外消费者（宿主按路径加载）的名字登记在
 * EXTERNAL_CONSUMERS 里并写明理由。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);
const SOURCE_RE = /\.tsx?$/;

/** 由包外消费者按路径加载、因此必须保留的转发导出。 */
const EXTERNAL_CONSUMERS = new Set<string>([
  // 例：'./src/typert.host.js :: TYPERT'（宿主加载器按 exports map 的 ./typert 取用）。
]);

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  if (specifier.endsWith(".js")) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${stem}.js`);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`);
  }
  candidates.push(join(base, "index.ts"), join(base, "index.tsx"));
  return candidates.find((candidate) => existsSync(candidate));
}

/** 本文件的文档注释里举例写了转发导出，不该被自己的规则扫到。 */
const SELF = fileURLToPath(import.meta.url);
const files = collect(ROOT).filter((file) => file !== SELF);

/** 一次读盘：文件 → 文本（两个用例共用，避免同一份文件被反复读取）。 */
const TEXTS = new Map<string, string>(files.map((file) => [file, readFileSync(file, "utf8")]));

/**
 * 一次扫描建索引：目标模块 → 从它导入/转发的名字集合（含通配 '*'）。
 *
 * 2026-10-08 改为「先建索引再查」：此前每个转发导出都重扫一遍全部文件
 * （O(候选 × 文件) 次读盘 + 正则），单个用例 3.4s、占全量测试时长 1/5。
 */
function buildImporterIndex(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of files) {
    const text = TEXTS.get(file) ?? "";
    const add = (target: string, name: string): void => {
      let names = index.get(target);
      if (names === undefined) {
        names = new Set<string>();
        index.set(target, names);
      }
      names.add(name);
    };
    for (const pattern of [
      /import\s+(?:type\s+)?\{([^{}]*?)\}\s+from\s+["'](\.[^"']+)["']/g,
      /export\s+(?:type\s+)?\{([^{}]*?)\}\s+from\s+["'](\.[^"']+)["']/g,
    ]) {
      for (const match of text.matchAll(pattern)) {
        const target = resolveSpecifier(match[2]!, file);
        if (target === undefined) continue;
        for (const part of match[1]!.split(",")) {
          const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) add(target, name);
        }
      }
    }
    for (const match of text.matchAll(/(?:import|export)\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s+["'](\.[^"']+)["']/g)) {
      const target = resolveSpecifier(match[1]!, file);
      if (target !== undefined) add(target, "*");
    }
  }
  return index;
}

/** 索引只在首次用到时构建（两个用例共用同一份）。 */
let importerIndex: Map<string, Set<string>> | undefined;
function importersOf(target: string): Set<string> {
  importerIndex ??= buildImporterIndex();
  return importerIndex.get(target) ?? new Set<string>();
}

describe("导出面", () => {
  it("转发导出必须真的有人从这个模块导入", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // 包入口（index.ts/index.tsx）的转发就是包的公开 API：由宿主/其它包经 exports map
      // 使用，仓库内没有相对导入者属正常，不在此判据范围内。
      if (/\/index\.tsx?$/.test(file)) continue;
      const text = TEXTS.get(file) ?? "";
      const used = importersOf(file);
      if (used.has("*")) continue;
      // 只看**值**转发：\`export type { ... }\` 是门面的公开类型面，没有仓库内使用者也是
      // 故意的（对外契约），不该按「残留」处理。
      for (const match of text.matchAll(/export\s+\{([^{}]*?)\}\s+from\s+["'](\.[^"']+)["']/g)) {
        for (const part of match[1]!.split(",")) {
          const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
          if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
          const key = `${file.slice(ROOT.length + 1)} :: ${name}`;
          if (!used.has(name) && !EXTERNAL_CONSUMERS.has(key)) offenders.push(key);
        }
      }
    }
    expect(offenders, "这些转发导出没有任何使用者：删掉它，或登记为包外消费者").toEqual([]);
  });

  it("判据本身有效（扫到足够多的模块与转发导出）", () => {
    const reexports = files.reduce(
      (sum, file) => sum + [...(TEXTS.get(file) ?? "").matchAll(/export\s+(?:type\s+)?\{[^{}]*?\}\s+from\s+["']\.[^"']+["']/g)].length,
      0,
    );
    expect(files.length).toBeGreaterThan(150);
    expect(reexports, "转发导出数量应可观（否则判据空转）").toBeGreaterThan(20);
  });
});
