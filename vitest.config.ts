import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";

// 测试环境与用户真实 ~/.dsh 隔离:插件的官方包加载器在模块求值期会读取
// $DSH_HOME/profiles/node_modules 安装闭包 fallback 与 profile 依赖树,
// 用户本机是否初始化过 profile 会改变测试的解析路径。指向 .workwork 内
// 一个不会出现 profiles/ 的目录,两条 harness 环境链全部走不通,官方包
// 一律回落到包自身依赖树(bun 安装的 optionalDependencies),结果只由
// 仓库状态决定。运行期需要 DSH_HOME 的测试(sandbox.test.ts 等)在
// beforeEach 里自行覆盖该变量,不受影响。
const TEST_DSH_HOME = join(resolve(import.meta.dirname ?? "."), ".workwork", "dsh-test-home");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    passWithNoTests: true,
    env: { DSH_HOME: TEST_DSH_HOME },
  },
});
