// 从包的 CHANGELOG.md 提取指定版本的小节，作为 GitHub Release 说明。
// 用法：node scripts/release-notes.mjs <包目录名> <版本>
// 小节标题形如 `## 0.10.2-alpha.0 (2026-09-01)`；找不到对应小节或文件缺失
// 时退回一行占位，让发布流程不因 changelog 缺失而中断。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// 小节判定与 publish-gate 的 changelogHasSection 共享同一实现（见 issue #6）。
import { findChangelogSection } from "./lib/version-checks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [dir, version] = process.argv.slice(2);
if (!dir || !version) {
  console.error("用法: node scripts/release-notes.mjs <包目录名> <版本>");
  process.exit(2);
}

const { name } = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));
const changelogPath = join(ROOT, "packages", dir, "CHANGELOG.md");

let notes = `\`${name}\` v${version} 发布。`;
if (existsSync(changelogPath)) {
  const lines = readFileSync(changelogPath, "utf8").split("\n");
  const start = findChangelogSection(lines, version);
  if (start !== -1) {
    const body = [];
    for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) body.push(lines[i]);
    const text = body.join("\n").trim();
    if (text) notes = text;
  } else {
    console.error(`CHANGELOG.md 中没有 ${version} 小节，使用占位说明`);
  }
} else {
  console.error("CHANGELOG.md 不存在，使用占位说明");
}

console.log(notes);
