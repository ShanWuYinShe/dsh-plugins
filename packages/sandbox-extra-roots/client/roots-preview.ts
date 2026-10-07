/**
 * roots-preview.ts — 危险根的客户端预览（纯函数，可单测）。
 *
 * 2026-10-08 从 425 行的单体 client/index.tsx 拆出：平台近似、系统目录词法前缀、
 * 预设、逐行分析与阻塞判定；与 host 的 classifyRoot 口径保持一致。
 *
 * @module sandbox-extra-roots/roots-preview
 */



var ua = typeof navigator !== "undefined" ? String(navigator.userAgent || navigator.platform || "") : "";
export var isDarwin = /Mac/i.test(ua);
export var isWindows = /Win/i.test(ua);
// 与 host classifyRoot 的过滤口径保持一致的客户端预览（词法级）：
// 让"会被静默丢弃的行"在保存前就可见，而不是保存后只看到"已保存"。
const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin"];
// darwin 下系统目录的 realpath 拼写(/etc → /private/etc):/private 是
// 这些目录的词法祖先,host 判为 filter 级静默剔除——预览若只比字面
// 会漏掉用户最常见的 macOS 拼写。
const DARWIN_SYSTEM_REALPATHS = ["/private/etc", "/private/usr", "/private/bin", "/private/sbin"];
// 主目录的词法祖先是 reject 级(host 拒绝保存),典型拼写按平台近似:
// darwin 在 /Users/<name>,Linux 在 /home/<name>,Windows 在 C:\Users\<name>。
// host 按 homedir 精确判定;客户端只标这些常见祖先,宁可少标(交给 host
// 拒绝),不误标合法路径。
const HOME_ANCESTORS = isDarwin ? ["/users"] : isWindows ? ["c:/users"] : ["/home"];
function isDirPrefix(prefix: string, path: string): boolean {
  if (prefix === "" || path === "") return false;
  return (path + "/").startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}
export function analyzeRootsText(text: string) {
  const problems: Array<{ line: number; kind: string; value: string }> = [];
  const seen = new Set<string>();
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    // ~/x：host 保存时展开为用户主目录下的子路径，客户端无法解析 home，
    // 视为合法。裸 ~ 是主目录本身——host 按 homedir 判 reject 拒绝保存，
    // 预览同样标 danger。
    if (line === "~") {
      problems.push({ line: index + 1, kind: "danger", value: line });
      return;
    }
    if (line.startsWith("~/") || line.startsWith("~\\")) return;
    const isAbsoluteLike = line.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(line);
    if (!isAbsoluteLike) {
      problems.push({ line: index + 1, kind: "invalid", value: line });
      return;
    }
    const normalized = line.replace(/[\\/]+$/, "") || "/";
    if (seen.has(normalized)) {
      problems.push({ line: index + 1, kind: "duplicate", value: line });
      return;
    }
    seen.add(normalized);
    const cmp = normalized.replace(/\\/g, "/").toLowerCase();
    if (normalized === "/" || /^[a-zA-Z]:[\\/]?$/.test(normalized)) {
      problems.push({ line: index + 1, kind: "danger", value: line });
    } else if (HOME_ANCESTORS.includes(cmp)) {
      problems.push({ line: index + 1, kind: "homeAncestor", value: line });
    } else if ([...SYSTEM_DIRS, ...(isDarwin ? DARWIN_SYSTEM_REALPATHS : [])].some((dir) => {
      const d = dir.toLowerCase();
      return cmp === d || isDirPrefix(cmp, d);
    })) {
      problems.push({ line: index + 1, kind: "system", value: line });
    }
  });
  return problems;
}
// host 必然拒绝的行(invalid/danger/homeAncestor)存在时禁用保存:与其让
// 用户点了保存再读一段英文 TypeError,不如按钮禁用+行内原因。判据具名导出，
// 保存按钮与单测共用同一条，避免两边各写一份而漂移。
export function hasBlockingProblems(problems: Array<{ kind: string }>): boolean {
  return problems.some((p) => p.kind === "invalid" || p.kind === "danger" || p.kind === "homeAncestor");
}
// 一键添加的常用工具缓存预设：各工具开箱默认路径（均可被环境变量覆盖，
// 不适用直接改文本）。只收录“写缓存、不含凭证”的目录：含明文凭证的
// （~/.docker、~/.ssh、~/.aws 等）永不进预设。点选即显式 opt-in——用户
// 对亲手加入的负责；解除沙盒边界的条目（/、主目录等）仍会被保存
// 判据拒绝，不在责任口径内。
type RootPresetPlatform = "darwin" | "linux" | "win32";
interface RootPreset { path: string; platforms: RootPresetPlatform[]; }
const ROOT_PRESETS: RootPreset[] = [
  { path: "~/.npm", platforms: ["darwin", "linux"] },
  { path: "~/.cache/pip", platforms: ["linux"] },
  { path: "~/Library/Caches/pip", platforms: ["darwin"] },
  { path: "~/.cargo", platforms: ["darwin", "linux", "win32"] },
  { path: "~/go/pkg/mod", platforms: ["darwin", "linux", "win32"] },
];
export function presetsForPlatform(isDarwin: boolean, isWindows: boolean): string[] {
  const platform: RootPresetPlatform = isDarwin ? "darwin" : isWindows ? "win32" : "linux";
  return ROOT_PRESETS.filter((preset) => preset.platforms.includes(platform)).map((preset) => preset.path);
}
// chip 点击的纯拼接：已存在（去首尾空格比对）则原样返回，避免 duplicate
// 预览对“一键添加”误报；否则另起一行追加并补换行，光标行保持可继续输入。
export function appendRootLine(draft: string | null, path: string): string | null {
  if (draft === null) return null;
  if (draft.split("\n").some((line) => line.trim() === path)) return draft;
  const trimmedEnd = draft.replace(/\s+$/, "");
  return (trimmedEnd.length === 0 ? "" : trimmedEnd + "\n") + path + "\n";
}
