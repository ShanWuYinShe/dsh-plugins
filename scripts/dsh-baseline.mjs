// 输出当前分支的 dsh 依赖基线（全部 @deepseek-ai/dsh-* range 的共同
// `^<版本>` 锚点，如 `0.1.2-rc.1`）。publish.yml 在 main 流水成功后用
// 它打 `dsh-v<基线>` 归档 tag（表示"该提交 = 对 dsh 此稳定版的已验证
// 适配"）；`bun run dsh-status` 的判定逻辑见 dsh-follow-status.mjs。
//
// 严格模式：任何非 `^<版本>` 形态的 dsh 依赖、基线不一致、dsh.host 缺失
// 或不一致都 exit 1——发布归档的 tag 不允许带糊的状态。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateBaseline, manifestPaths, scanManifest, ROOT } from "./lib/dsh-deps.mjs";

const manifests = manifestPaths(ROOT).map((path) => ({
  path,
  manifest: JSON.parse(readFileSync(join(ROOT, path), "utf8")),
}));

// 严格校验 1:所有 dsh-* range 都是 ^<版本> 形态
for (const { path, manifest } of manifests) {
  for (const { section, name, range } of scanManifest(manifest).invalid) {
    console.error(`dsh-baseline: ${path} [${section}] ${name} 不是 ^<版本> 形态: ${range}`);
    process.exit(1);
  }
}

const { baseline, host } = aggregateBaseline((path) => JSON.parse(readFileSync(join(ROOT, path), "utf8")));
if (baseline.startsWith("[不一致")) {
  console.error(`dsh-baseline: 依赖基线不一致: ${baseline}`);
  process.exit(1);
}
if (typeof host !== "string") {
  console.error("dsh-baseline: 发布包缺少 dsh.host 适配声明（package.json 的 dsh.host 字段）");
  process.exit(1);
}
if (host !== baseline) {
  console.error(`dsh-baseline: dsh.host (${host}) 与依赖基线 (${baseline}) 不一致`);
  process.exit(1);
}
console.log(baseline);
