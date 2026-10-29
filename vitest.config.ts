import { join, resolve } from "node:path";
import { transform } from "esbuild";
import { defineConfig } from "vitest/config";

// 测试环境与用户真实 ~/.dsh 隔离:插件的官方包加载器在模块求值期会读取
// $DSH_HOME/profiles/node_modules 安装闭包 fallback 与 profile 依赖树,
// 用户本机是否初始化过 profile 会改变测试的解析路径。指向 .workwork 内
// 一个不会出现 profiles/ 的目录,两条 harness 环境链全部走不通,官方包
// 一律回落到包自身依赖树(bun 安装的 optionalDependencies),结果只由
// 仓库状态决定。运行期需要 DSH_HOME 的测试(sandbox.test.ts 等)在
// beforeEach 里自行覆盖该变量,不受影响。
const TEST_DSH_HOME = join(resolve(import.meta.dirname ?? "."), ".workwork", "dsh-test-home");

/**
 * TC39 标准装饰器预转译（enforce: 'pre'）。
 *
 * 宿主 0.2.2 起远程服务面用官方 `@Remote` 标准装饰器（TC39 stage 3）声明，
 * 而 Vite 8 默认的 oxc 转换后端只认 legacy 装饰器：直接 import 带标准装饰器的
 * 源码会抛 SyntaxError（源码里 `@(0, import_x.Remote)("get") get() {…}`）。
 * 这里用已在本仓 devDependencies 的 esbuild 做一次 pre-transform（esbuild 0.28
 * 支持标准装饰器并按 target 降级），让 vitest 与被测源码的语义和 tsc 构建
 * （`standard` 装饰器）一致。
 *
 * 不要改用顶层 `esbuild: { target }`：Vite 8 会以「Both esbuild and oxc options
 * were set」告警并忽略；也不要试图只配 `oxc.target`——那只影响降级目标，不会把
 * 标准装饰器转成 legacy 语义。
 */
const standardDecorators = {
  name: "dsh-test-standard-decorators",
  enforce: "pre" as const,
  async transform(code: string, id: string) {
    const file = id.split("?", 1)[0] ?? id;
    if (!/\.tsx?$/.test(file) || file.includes("/node_modules/")) return null;
    const result = await transform(code, {
      loader: file.endsWith(".tsx") ? "tsx" : "ts",
      target: "es2022",
      format: "esm",
      jsx: "automatic",
      sourcemap: true,
      sourcefile: file,
    });
    return { code: result.code, map: result.map === "" ? null : JSON.parse(result.map) };
  },
};

export default defineConfig({
  plugins: [standardDecorators],
  test: {
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    // false：测试目录被清空/改名（include 匹配不到任何用例）时必须红灯，
    // 不允许「零用例即通过」静默放行。
    passWithNoTests: false,
    env: { DSH_HOME: TEST_DSH_HOME },
  },
});
