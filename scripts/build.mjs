// 全仓构建，三段顺序固定：
//   1) 每包 tsc 编译 src/ → lib/（含 dsh.d.ts 增强合并）
//   2) typert 工件生成（scripts/typert.mjs → lib/typert.*）
//   3) esbuild 打包 client/index.tsx → client/client.cjs
// 顺序不能换：client 源码用包自引用子路径 import "@chaoset/<pkg>/remote"，
// esbuild 解析到 lib/typert.remote-client.js，故生成必须早于 client 打包。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { formatTypertFailure, generateTypertArtifacts, TypertGenerationError } from "./typert.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 包列表从目录派生而非硬编码:硬编码清单在增删包时必然漂移
// (vision-router 删除时就漏改过这里,导致构建直接 ENOENT)。
const PACKAGES = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  // 与 publish-gate / bundle.test 同口径：包移除后的残留目录不参与枚举
  // （有 src/ 而无 package.json 的中间状态会让 tsc 直接 ENOENT 崩溃）。
  .filter((name) => existsSync(join(ROOT, "packages", name, "package.json")))
  .sort();

function tsc(pkgDir) {
  execFileSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", join(pkgDir, "tsconfig.json")], { stdio: "inherit", cwd: ROOT });
}

// tsgo/tsc 不会把 .d.ts 输入复制到 outDir，src/dsh.d.ts 里的 declare module
// 增强（ctx.sandbox/fs/sandboxPolicy/settings 等）必须并入 lib/index.d.ts
// 才能随发布产物提供给消费者。tsgo 7.0.2 拒绝在 .ts 源码里内联这些
// declare module（TS2310 自引用 / TS2664 可选依赖不可解析），因此由
// 构建脚本在 tsc 之后把 dsh.d.ts 的内容插入 lib/index.d.ts 开头
// （放前面让消费者先看到环境增强声明；哨兵注释写 "appended" 是历史
// 命名，保留它只为幂等判定的稳定）。
const AUGMENTATION_MARKER = "// ── dsh.d.ts augmentations (appended by scripts/build.mjs) ──";
function appendDshAugmentations(pkgDir) {
  const dshDts = join(pkgDir, "src", "dsh.d.ts");
  const indexPath = join(pkgDir, "lib", "index.d.ts");
  if (!existsSync(dshDts) || !existsSync(indexPath)) return;
  const indexContent = readFileSync(indexPath, "utf8");
  if (indexContent.includes(AUGMENTATION_MARKER)) return; // 幂等:重复构建不重复插入
  // 泛查 "declare module" 会误判:tsc 输出本身可能含 declare module 块,
  // 那种情况下插入会被跳过、增强丢失。改用本脚本写入的哨兵注释判定。
  const dshContent = readFileSync(dshDts, "utf8");
  writeFileSync(indexPath, AUGMENTATION_MARKER + "\n" + dshContent.trim() + "\n\n" + indexContent);
}

async function buildClient(pkgDir, pkgName, pkgId) {
  const result = await build({
    entryPoints: [join(pkgDir, "client", "index.tsx")],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: ["es2020"],
    // JSX 走 automatic 运行时（宿主 ModuleLoader 映射 react 与
    // react/jsx-runtime，官方 client 插件即此形态）。不显式声明时 esbuild
    // 按 tsconfig 解析回 classic 转换，产物引用裸 `React.createElement`——
    // 页面没有全局 React 就会在渲染时抛 ReferenceError（曾让侧栏徽章与
    // 设置卡片在稳定版宿主上崩溃）。
    jsx: "automatic",
    // zod：生成的 remote-client 工件顶部 import zod（codec 工厂用）。宿主 Web 壳的
    // PLATFORM_MODULES（@deepseek-ai/dsh-client-web）把 zod 作为共享平台模块提供给
    // 客户端的 require，故这里 external，让 client.cjs 的 require("zod") 取宿主单例。
    // remote-info（@deepseek-ai/dsh-typert-protocol/remote-info）是纯 ESM 数据工厂、
    // 无共享运行时身份，不能 external（宿主模块表里没有它），随 bundle 内置——与官方
    // tsdown 客户端打包的 INLINE_SAFE/GENERATED_REMOTE 判定一致。
    external: ["react", "react/jsx-runtime", "zod"],
    // 压缩产物（实测体积 -37~39%）：client.cjs 是宿主加载进浏览器的分发
    // 产物，与 npm 包发布 dist 同理不做可读性保留；调试看 client/ 源码。
    minify: true,
    write: false,
  });
  const body = result.outputFiles[0].text;
  if (body.includes("window.__ModuleLoader__.load")) {
    throw new Error(`client bundle for ${pkgName} is double-wrapped`);
  }
  // body 直接嵌入、不做按行缩进：minify 会把 "\n" 这类字符串字面量优化成
  // 跨行的模板字面量（真换行更短），按行加缩进会把空格注进模板字面量内部、
  // 改变字符串值——曾把设置卡片的 split("\n") 变成 split("\n    ")，保存的
  // 目录列表整体失效。缩进只是美观，正确性优先。
  const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkgId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  }
});
`;
  writeFileSync(join(pkgDir, "client", "client.cjs"), wrapped);
}

// ── 阶段 1：Host 源码编译（tsc 只碰 src/ → lib/*.js|d.ts，不清理 lib/） ──
const compiled = [];
for (const pkg of PACKAGES) {
  const pkgDir = join(ROOT, "packages", pkg);
  if (!existsSync(join(pkgDir, "src"))) {
    console.log(`skipped ${pkg}: no src/`);
    continue;
  }
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  tsc(pkgDir);
  appendDshAugmentations(pkgDir);
  compiled.push({ pkg, pkgDir, pkgName: pkgJson.name });
}

// ── 阶段 2：Typert 工件生成（tsc 之后、client 打包之前） ──
// 失败必须让构建失败：client 依赖 ./remote 工件，缺失时 bundle 会以难懂的错误收场。
try {
  const typert = generateTypertArtifacts(ROOT);
  const files = typert.artifacts.length * 2
    + typert.artifacts.filter((artifact) => artifact.remote !== undefined).length * 3;
  console.log(`typert: ${typert.artifacts.length} 个包 / ${files} 个工件文件`);
} catch (error) {
  if (!(error instanceof TypertGenerationError)) throw error;
  console.error(formatTypertFailure(error));
  process.exit(1);
}

// ── 阶段 3：Client 打包（externals 见 buildClient） ──
for (const { pkg, pkgDir, pkgName } of compiled) {
  if (existsSync(join(pkgDir, "client", "index.tsx"))) {
    await buildClient(pkgDir, pkg, pkgName);
  }
  console.log(`built ${pkg}`);
}
