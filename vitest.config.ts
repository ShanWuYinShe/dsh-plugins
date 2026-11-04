import { transform } from "esbuild";
import { defineConfig } from "vitest/config";

// 测试环境与用户真实 ~/.dsh 隔离:插件的官方包加载器在模块求值期会读取
// $DSH_HOME/profiles/node_modules 安装闭包 fallback 与 profile 依赖树,
// 用户本机是否初始化过 profile 会改变测试的解析路径。
//
// **每个测试文件一份全新的空 DSH_HOME**:由 test/setup-test-home.ts 在文件开始前
// 创建(父目录由 test/global-setup.ts 每轮清空)。URL 解析链因此永远走不到
// profiles/,官方包一律回落到包自身依赖树;同时任何测试写下的凭据/目录缓存/
// 状态域都不会泄漏给其它测试,结果只由仓库状态决定,与执行顺序、并行度、
// 上一轮残留无关。运行期需要覆盖 DSH_HOME 的测试(sandbox.test.ts 等)仍可在
// 自身 beforeEach 里覆盖。

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
    // 每个测试文件一份全新 DSH_HOME（见文件头）；globalSetup 每轮清空父目录，
    // 两次运行之间也不留残留。
    setupFiles: ["./test/setup-test-home.ts"],
    globalSetup: ["./test/global-setup.ts"],
    coverage: {
      // 覆盖率门禁分两层，不要混为一谈：
      //   1. **全局阈值**（本文件的 thresholds）：四个聚合百分比的粗网兜底；
      //   2. **逐文件棘轮**（scripts/coverage-ratchet.mjs + scripts/coverage-baseline.json）：
      //      每个纳入 coverage 的源文件都不得低于版本化基线（容差 0.2pp），
      //      新增文件必须达到全局阈值，消失文件由基线维护命令清理。
      //      `bun run test:coverage` = build → vitest --coverage → 棘轮校验。
      // 官方规则 RULE-088（docs/testing.md「Coverage gate」）的门禁口径是
      // `packages/*/*/src` **逐文件 100%**；未覆盖行往往是死代码，应由门禁提示
      // 删除而不是补测试凑数。逐文件 100% 是长期目标，当前先用棘轮保证
      // 「今天不比昨天差」，并让每个文件的缺口在基线文件里可见、可追踪。
      //
      // 覆盖率面 = 四包 host src 与 client 源文件（不含测试、d.ts、bin 产物）。
      // reporter 必须保留 `json-summary`：棘轮脚本读 coverage/coverage-summary.json。
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: [
        "packages/*/src/**/*.ts",
        "packages/*/client/**/*.ts",
        "packages/*/client/**/*.tsx",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.d.ts",
        // bin 入口是构建期自包含 bundle 的源码，运行路径由包内 bin 测试覆盖；
        // 它不是宿主插件面（不计入 RULE-088 的插件源码覆盖目标）。
        "packages/*/src/bin.ts",
        // 构建产物（gitignore），不计入覆盖率面。
        "packages/*/client/client.cjs",
      ],
      // 有测试失败时也生成 coverage-summary.json，保证棘轮步骤能给出
      // 「哪个文件退化了」的可执行报错，而不是只看到测试红灯。
      reportOnFailure: true,
      thresholds: {
        // 阈值 = 实测向下取整并留 ~1pp 抖动余量，只允许上调（棘轮）；下调
        // 等同放宽门禁，必须在提交信息里说明。逐文件不得回退由
        // scripts/coverage-baseline.json + 棘轮脚本保证。
        // 2026-11-05 实测（补齐三包测试后）：stmts 92.09 / branch 84.19 /
        // funcs 94.70 / lines 94.80。
        statements: 91,
        branches: 83,
        functions: 93,
        lines: 93,
      },
    },
  },
});
