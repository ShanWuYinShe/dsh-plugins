import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 网关层 ↔ typert 服务面一致性回归。
 *
 * 两处描述的是同一组远程端点，却由不同机制消费：
 * - \`remote.ts\` 用 markRemoteMethod 标记网关原型方法（运行时分发用）；
 * - \`typert.host.ts\` 用 invocations 声明方法、参数与结果 codec（宿主路由与
 *   浏览器侧的编解码用）。
 *
 * 两边都写着「两处语义一致——改一处必须改另一处」，但此前没有任何东西保证它。
 * 本测试把「方法集合」与「参数名」两两对齐：只在一侧加/删/改名即红灯。
 * （结果类型无法从网关侧推断，不在此列。）
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** 网关层标记的方法名（remote.ts 的 markRemoteMethod 调用）。 */
function markedMethods(remote: string): string[] {
  return [...remote.matchAll(/markRemoteMethod\(\s*[\w.$]+\.prototype\s*,\s*["']([A-Za-z_$][\w$]*)["']/g)].map(
    (match) => match[1]!,
  );
}

/** 服务面声明：方法名 → 参数名（typert.host.ts 的 invocations）。 */
function declaredSurface(host: string): Map<string, string[]> {
  const surface = new Map<string, string[]>();
  // 按 method 声明位置切片：不能按花括号切——parameters 里还有嵌套对象。
  const marks = [...host.matchAll(/method:\s*["']([A-Za-z_$][\w$]*)["']/g)];
  for (let index = 0; index < marks.length; index++) {
    const mark = marks[index]!;
    const end = index + 1 < marks.length ? marks[index + 1]!.index! : host.length;
    const block = host.slice(mark.index!, end);
    const parameters = block.match(/parameters:\s*\[([\s\S]*?)\n\s*\]/)?.[1] ?? "";
    const names = [...parameters.matchAll(/name:\s*["']([A-Za-z_$][\w$]*)["']/g)].map((match) => match[1]!);
    surface.set(mark[1]!, names);
  }
  return surface;
}

/** 网关方法签名里的参数名。 */
function gatewayParams(remote: string): Map<string, string[]> {
  const params = new Map<string, string[]>();
  for (const match of remote.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\(([^)]*)\)\s*(?::\s*[^{]+)?\{/gm)) {
    // 先剥泛型：Record<string, any> 里的逗号不是参数分隔符。
    let signature = match[2]!;
    for (let previous = ""; previous !== signature; ) {
      previous = signature;
      signature = signature.replace(/<[^<>]*>/g, "");
    }
    const names = signature
      .split(",")
      .map((part) => part.trim().split(/[?:]/)[0]!.trim())
      .filter((name) => name.length > 0);
    params.set(match[1]!, names);
  }
  return params;
}

describe("网关层与 typert 服务面一致", () => {
  for (const pkg of PACKAGES) {
    const remotePath = join(ROOT, "packages", pkg, "src", "remote.ts");
    const hostPath = join(ROOT, "packages", pkg, "src", "typert.host.ts");
    if (!existsSync(remotePath) || !existsSync(hostPath)) continue;

    it(`${pkg}: 方法集合与参数名一一对应`, () => {
      const remote = readFileSync(remotePath, "utf8");
      const surface = declaredSurface(readFileSync(hostPath, "utf8"));
      expect(surface.size, "服务面应声明至少一个 invocation").toBeGreaterThan(0);

      expect(new Set(markedMethods(remote)), "markRemoteMethod 与 invocations.method 必须同集合").toEqual(
        new Set(surface.keys()),
      );

      const gateway = gatewayParams(remote);
      for (const [method, names] of surface) {
        expect(gateway.get(method), `网关缺少方法 ${method}`).toBeDefined();
        expect(gateway.get(method), `${method} 的参数名两侧必须一致`).toEqual(names);
      }
    });
  }
});
