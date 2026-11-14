// 输出当前分支的 dsh 依赖基线（全部 @deepseek-ai/dsh-* range 的共同
// `^<版本>` 锚点，如 `0.1.2-rc.1`）。`dsh-v<基线>` 归档 tag（表示"该提交 =
// 对 dsh 此稳定版的已验证适配"）由用户手工打，CI 绝不自动创建；
// `bun run dsh-status` 的判定逻辑见 dsh-follow-status.mjs。
//
// 严格模式（发布门禁）：任何非 `^<版本>` 形态的 dsh 依赖、依赖基线不一致、
// engines.dsh 缺失/形态非法/与依赖基线不自洽（根 private 必须精确等于基线；
// 发布包必须精确等于基线或覆盖基线的同线兼容范围）、残留旧字段 dsh.host
// 都 exit 1——发布归档的 tag 不允许带糊的状态。
// 逐 manifest 的兼容声明判据来自 lib/dsh-deps.mjs 的 enginesProblems（语义与
// lib/engines-compat.mjs 同源），本脚本只负责打印与 exit 决策。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateBaseline, enginesProblems, manifestPaths, scanManifest, ROOT } from "./lib/dsh-deps.mjs";
import { VERSION_RE } from "./lib/version-checks.mjs";

const manifests = manifestPaths(ROOT).map((path) => ({
  path,
  manifest: JSON.parse(readFileSync(join(ROOT, path), "utf8")),
}));

// 严格校验 1:所有 dsh-* range 都是 ^<版本> 形态；engines.dsh 形态合法
// （精确宿主版本或严格形态的同线兼容范围，值是否对得上基线见校验 2）。
for (const { path, manifest } of manifests) {
  for (const { section, name, range } of scanManifest(manifest).invalid) {
    if (section === "engines") {
      console.error(`dsh-baseline: ${path} [engines] dsh 形态非法（必须是精确 SemVer，或带上下界的同线兼容范围「>=0.2.2-rc.2 <0.2.3-0」）: ${range}`);
    } else {
      console.error(`dsh-baseline: ${path} [${section}] ${name} 不是 ^<版本> 形态: ${range}`);
    }
    process.exit(1);
  }
}

// 严格校验 2:依赖基线必须是唯一合法版本号（根 private 的 engines.dsh 不参与
// 引擎聚合，但依赖 range 仍全仓共同）。
const { baseline } = aggregateBaseline((path) => JSON.parse(readFileSync(join(ROOT, path), "utf8")));
if (baseline.startsWith("[不一致")) {
  console.error(`dsh-baseline: 依赖基线不一致: ${baseline}`);
  process.exit(1);
}
if (!VERSION_RE.test(baseline)) {
  console.error(`dsh-baseline: 找不到全仓唯一的 dsh 依赖基线（全部 dsh-* range 的 ^<版本> 锚点）: ${baseline}`);
  process.exit(1);
}

// 严格校验 3:兼容声明与依赖基线自洽。根 private 必须精确等于基线；发布包
// 接受精确基线或覆盖基线的同线兼容范围（上界切在下一线、下界同基础号且 <= 基线）。
let problems = 0;
for (const { path, manifest } of manifests) {
  for (const problem of enginesProblems(manifest, baseline)) {
    console.error(`dsh-baseline: ${path}: ${problem}`);
    problems++;
  }
}
if (problems > 0) process.exit(1);
console.log(baseline);
