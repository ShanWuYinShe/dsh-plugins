// scripts/lib/version-checks.mjs — semver 与 CHANGELOG 小节判定的共享实现。
// 消费方：scripts/publish-gate.mjs（发布门禁）、scripts/release-notes.mjs
// （Release 说明提取）、scripts/dsh-follow-status.mjs（基线核对）、
// scripts/adapt-dsh.mjs（宿主适配入参校验）。
// 此前四份手抄发生过真实漂移（adapt-dsh 的 \\w+ 口径放行非法 semver），
// 提取为单一来源后漂移在结构上不再可能。错误策略由调用方决定——
// 本模块只做纯判定，不做任何 exit/log 决策。

/** 合法 semver（含 prerelease / build metadata）。非法版本号若放行，
 * compareVersions 会产出 NaN 静默通过「落后于已归档版本」比较。 */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// semver 比较（不含 prerelease 与 build metadata 以外的差异）：主/次/补丁按
// 数值比；带 prerelease 的版本小于同号正式版；prerelease 标识符逐段比，数字
// 段小于字母段，段数少的是前缀、更小。语义与 npm 一致。
export function compareVersions(a, b) {
  function parse(v) {
    const plus = v.indexOf("+");
    const noBuild = plus === -1 ? v : v.slice(0, plus); // build metadata 不参与比较
    const dash = noBuild.indexOf("-");
    const core = dash === -1 ? noBuild : noBuild.slice(0, dash);
    const [maj, min, pat] = core.split(".").map(Number);
    return { maj, min, pat, pre: dash === -1 ? null : noBuild.slice(dash + 1).split(".") };
  }
  const x = parse(a);
  const y = parse(b);
  for (const k of ["maj", "min", "pat"]) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const xi = x.pre[i];
    const yi = y.pre[i];
    // 标识符段数呈前缀关系时少者更小（semver §11）。undefined 必须先拦，
    // 否则下方 /^\d+$/.test(undefined) 恒 false 落进字母段分支得出反向结论
    // （实测 0.3.14-alpha.1 与 0.3.14-alpha 的比较方向曾与 semver 相反）。
    if (xi === undefined) return -1;
    if (yi === undefined) return 1;
    const nx = /^\d+$/.test(xi);
    const ny = /^\d+$/.test(yi);
    if (nx && ny) {
      const d = Number(xi) - Number(yi);
      if (d) return d;
    } else if (nx) {
      return -1;
    } else if (ny) {
      return 1;
    } else if (xi !== yi) {
      return xi < yi ? -1 : 1;
    }
  }
  return 0;
}

// 版本是否带 prerelease 后缀。与 compareVersions 的判定同口径：出现第一个
// `-` 即 prerelease，不看标识符内容（semver 对纯数字首标识符同样视为
// prerelease）。
export function isPrerelease(version) {
  return version.includes("-");
}

// 版本是否属于稳定线（无 prerelease 后缀）。
export function isStable(version) {
  return !isPrerelease(version);
}

/** CHANGELOG 小节标题（`## <版本>` 或 `## <版本> `开头）在 lines 中的行
 * 索引；-1 表示没有该版本的小节。发布门禁与 Release 说明提取共用这一
 * 判定（带空格边界：不会把 0.4.5-beta 误判为 0.4.5 的小节）。 */
export function findChangelogSection(lines, version) {
  return lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
}
