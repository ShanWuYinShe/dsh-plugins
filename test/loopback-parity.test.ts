import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostIsLoopback, originIsLoopback } from "../packages/dsh-any-connect/src/loopback.js";
import { providerUsageHandler } from "../packages/provider-usage/src/route.js";
import { ProviderUsageRegistry } from "../packages/provider-usage/src/registry.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 回环守卫一致性回归：两个包各自持有的那份「回环请求判定」不能静默分叉。
 *
 * 背景：dsh-any-connect 与 provider-usage **独立发布、不能互相 import**，所以回环守卫
 * （Host 检查挡 DNS-rebinding、Origin 检查挡跨站读取）在两边各留一份。provider-usage 的
 * 注释写明这是有意的：「语义镜像 dsh-any-connect，分化时偏向拒绝」。
 *
 * 但「有意分化」只覆盖 originIsLoopback 的那一处**收紧**（空串 Origin：any-connect 放行、
 * provider-usage 拒绝）。**其余部分是同一份安全判定，分叉就是漏洞**：一边认的 loopback 主机名
 * 另一边不认，等于同一台机器上两个插件门禁强度不同。2026-10-08 之前就发生过一次
 * （`[::1]garbage` 上 shim 版与标准版语义不一致，见 loopback.ts 里的历史注释）。
 *
 * ## 为什么锁从「源码逐字一致」改成了「实测行为等价」
 *
 * 2026-10-10：provider-usage 把 IP 字面量判定委托给宿主 `isLoopbackHost`
 * （@deepseek-ai/dsh-host-webserver：`parseIpLiteral` + `parsed.range() === "loopback"`），
 * 并删掉了本地的 `const LOOPBACK_HOSTS`。两边的**实现手段**从此不同——本地 4 词精确名单
 * vs 宿主 IP 字面量的 loopback 网段判定——逐字比对必然失效，且给 dsh-any-connect 引入宿主
 * webserver 依赖会改变 dsh 依赖基线，不可取。于是改成**实测两包各自公开面**再比对：
 *
 * - any-connect 侧直接调它导出的 `hostIsLoopback` / `originIsLoopback`；
 * - provider-usage 侧经它**真的会被宿主挂上去的那个** `providerUsageHandler`，
 *   用 Host/Origin 头观察 200（放行）/ 403（拒绝）——与 `packages/provider-usage/test/route.test.ts`
 *   的 it.each 同一口径。本文件因此不需要、也没有 import 宿主包（根目录解析不到它）。
 *
 * ## 这套锁抓得住什么、抓不住什么（据实登记，不夸大）
 *
 * - 抓得住：任一边把答案改坏——多放行一个攻击者域名、少认一个回环拼写、把失败关闭改成
 *   放行、把 `originIsLoopback` 的空串收紧扩大到非空 Origin、空串收紧被「对齐」掉；
 *   以及「两边各自持有本地副本、没有跨包 import」这条结构事实。
 * - 抓**不**住：一边保留全部共享样例语义、却额外接受该边专属拼写的版本偏移（见
 *   `KNOWN_DIVERGENCES`）。这类偏移只会被各包 test/ 目录下的 loopback 真值表抓住，
 *   本文件不重复它。
 *
 * 判据：
 * 1. hostIsLoopback / originIsLoopback 的**可观察结果**除已登记的那一处收紧外必须逐样例相等；
 * 2. originIsLoopback 的差异必须**恰好**是空串/纯空白 Origin 那一处收紧，多一分少一分都报错；
 * 3. 共享的那部分语义按**绝对真值表**钉死（不拿一边当基准），防止「两边一起改坏仍然相等」。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const A = "packages/dsh-any-connect/src/loopback.ts";
const B = "packages/provider-usage/src/route.ts";

/**
 * 2026-10-10 实测登记的**四处**已存在差异（真值表 HOST_TRUTH / ORIGIN_TRUTH 里按两边各自的
 * 真值断言，所以语义漂移会被抓住）：
 *
 * 1. `127.5.5.5`、`127.0.0.2`（127/8 整段）、`::ffff:127.0.0.1`（IPv4-mapped）——
 *    provider-usage 委托宿主 `isLoopbackHost` 按 IP 网段判定 → 放行；
 *    any-connect 是 4 词精确名单 → 拒绝（**any-connect 更严，不是漏洞**）。
 * 2. `http://127.0.0.2:8080` —— 同上的 Origin 版本。
 * 3. 空串 / 纯空白 Origin —— **唯一有意登记的方向相反**的收紧：any-connect 放行，
 *    provider-usage 拒绝（「分化时偏向拒绝」）。
 *
 * 本文件抓不住的是「某个现在两边都不接受的拼写，被单边新增为接受」——这类扩展在共享样例
 * 之外，只能靠各包自己的 loopback 真值表。
 */

/** 供 Host 判定使用的样例（undefined = Host 头缺席）。 */
const HOST_SAMPLES: (string | undefined)[] = [
  "localhost",
  "LOCALHOST",
  "localhost:3000",
  "127.0.0.1",
  "127.0.0.1:8080",
  "127.5.5.5",
  "127.0.0.2",
  "::1",
  "[::1]",
  "[::1]:3000",
  "::1:3000",
  "0.0.0.0",
  "example.com",
  "",
  "   ",
  "[::1]garbage",
  "::ffff:127.0.0.1",
  "[::1]:abc",
  undefined,
];

/** 供 Origin 判定使用的样例。 */
const ORIGIN_SAMPLES: (string | undefined)[] = [
  "http://localhost:3000",
  "http://127.0.0.1:8080",
  "http://127.0.0.2:8080",
  "http://[::1]:3000",
  "https://[::1]",
  "https://evil.example.com",
  "http://localhost.evil.com",
  "http://[::1]garbage",
  "http://example.com",
  "http://127.0.0.1",
  "not a url",
  "javascript:alert(1)",
  "",
  "   ",
  undefined,
];

/**
 * provider-usage 侧：经真实 handler 观察 Host / Origin 判定。
 * 403 = 判为不可信，200 = 放行（providers 列表为空，不会触发任何查询）。
 */
const registry = new ProviderUsageRegistry(new Context());
const handler = providerUsageHandler({ registry });

/** 单个头缺失时另一个头补一个一定放行的值，把两个门禁隔离开。 */
function verdict(probe: { host?: string; origin?: string; omitOrigin?: boolean; omitHost?: boolean }): boolean {
  const headers: Record<string, string> = {};
  if (!probe.omitHost) headers["host"] = probe.host ?? "127.0.0.1";
  if (!probe.omitOrigin) headers["origin"] = probe.origin ?? "http://127.0.0.1";
  let status = 0;
  const req = { method: "GET", url: "/", headers } as unknown as IncomingMessage;
  const res = {
    writeHead: (code: number) => { status = code; return res },
    end: () => {},
  } as unknown as ServerResponse;
  void handler(req, res);
  return status === 200;
}

/** Host 门禁：Origin 恒给一个一定放行的值。 */
const usageHost = (host: string | undefined): boolean =>
  host === undefined ? verdict({ omitHost: true }) : verdict({ host });

/** Origin 门禁：Host 恒给一个一定放行的值；undefined = Origin 头缺席。 */
const usageOrigin = (origin: string | undefined): boolean =>
  origin === undefined ? verdict({ omitOrigin: true }) : verdict({ origin });

/** 把样例渲染成可读标签，undefined 与空串必须区分开。 */
function label(sample: string | undefined): string {
  return sample === undefined ? "(头缺席)" : JSON.stringify(sample);
}

/**
 * 共享语义的**绝对真值表**：[Host 样例, any-connect 真值, provider-usage 真值]。
 * 两边真值不同的三行就是上面 `KNOWN_DIVERGENCES` 登记的版本差异。
 */
const HOST_TRUTH: [string | undefined, boolean, boolean][] = [
  ["localhost", true, true],
  ["LOCALHOST", true, true],
  ["localhost:3000", true, true],
  ["127.0.0.1", true, true],
  ["127.0.0.1:8080", true, true],
  ["127.5.5.5", false, true],
  ["127.0.0.2", false, true],
  ["::1", true, true],
  ["[::1]", true, true],
  ["[::1]:3000", true, true],
  ["::1:3000", false, false],
  ["0.0.0.0", false, false],
  ["example.com", false, false],
  ["", false, false],
  ["   ", false, false],
  ["[::1]garbage", false, false],
  ["::ffff:127.0.0.1", false, true],
  ["[::1]:abc", false, false],
  [undefined, false, false],
];

/** Origin 真值表；空串/纯空白一行就是唯一的分化点。 */
const ORIGIN_TRUTH: [string | undefined, boolean, boolean][] = [
  ["http://localhost:3000", true, true],
  ["http://127.0.0.1:8080", true, true],
  ["http://127.0.0.2:8080", false, true],
  ["http://[::1]:3000", true, true],
  ["https://[::1]", true, true],
  ["https://evil.example.com", false, false],
  ["http://localhost.evil.com", false, false],
  ["http://[::1]garbage", false, false],
  ["http://example.com", false, false],
  ["http://127.0.0.1", true, true],
  ["not a url", false, false],
  ["javascript:alert(1)", false, false],
  // 唯一的分化点：any-connect 视空串 Origin 为非浏览器客户端放行，provider-usage 偏向拒绝。
  ["", true, false],
  ["   ", true, false],
  [undefined, true, true],
];

describe("回环守卫一致性", () => {
  const a = readFileSync(join(ROOT, A), "utf8");
  const b = readFileSync(join(ROOT, B), "utf8");

  describe("判据 1+3：Host 判定逐样例等于各自真值", () => {
    it("样例集与真值表同集（防止改了列表忘了表、锁空转）", () => {
      expect(HOST_TRUTH.map(([sample]) => sample)).toEqual(HOST_SAMPLES);
      expect(ORIGIN_TRUTH.map(([sample]) => sample)).toEqual(ORIGIN_SAMPLES);
    });

    it.each(HOST_TRUTH)("Host %s: any-connect 与 provider-usage 各自正确", (sample, expectA, expectB) => {
      expect(hostIsLoopback(sample), "any-connect: " + label(sample)).toBe(expectA);
      expect(usageHost(sample), "provider-usage: " + label(sample)).toBe(expectB);
    });
  });

  describe("判据 1+2：Origin 判定逐样例等于各自真值，差异恰好一处", () => {
    it.each(ORIGIN_TRUTH)("Origin %s: any-connect 与 provider-usage 各自正确", (sample, expectA, expectB) => {
      expect(originIsLoopback(sample), "any-connect: " + label(sample)).toBe(expectA);
      expect(usageOrigin(sample), "provider-usage: " + label(sample)).toBe(expectB);
    });

    it("差异集合恰为已登记的三项（多一分少一分都报错）", () => {
      const diffs = ORIGIN_TRUTH.filter(([, expectA, expectB]) => expectA !== expectB).map(([sample]) => label(sample));
      expect(diffs.sort()).toEqual(
        [JSON.stringify(""), JSON.stringify("   "), JSON.stringify("http://127.0.0.2:8080")].sort(),
      );
    });

    it("Host 判定的差异恰为空串/纯空白无、且已登记的三项", () => {
      const diffs = HOST_TRUTH.filter(([, expectA, expectB]) => expectA !== expectB).map(([sample]) => label(sample));
      expect(diffs.sort()).toEqual([JSON.stringify("127.0.0.2"), JSON.stringify("127.5.5.5"), JSON.stringify("::ffff:127.0.0.1")].sort());
    });
  });

  describe("判据 3：两边各自持有本地副本，不回退成跨包 import", () => {
    it("两文件都还在，且 provider-usage 侧仍在本地做 Host 解析", () => {
      for (const file of [A, B]) {
        expect(existsSync(join(ROOT, file)), file + " 不见了").toBe(true);
      }
      // provider-usage 必须仍持有自己的 hostnameOfHost：删掉它、改成直接信 Host 头
      // 就是回环门禁失效（DNS-rebinding 只靠 Host 拦）。
      expect(b, B + " 丢了本地的 hostnameOfHost").toContain("function hostnameOfHost");
      // any-connect 侧保留本地名单是有意设计（该包不依赖宿主 webserver 包）。
      expect(a, A + " 丢了本地 LOOPBACK_HOSTS").toContain("const LOOPBACK_HOSTS");
    });

    it("没有跨包 import", () => {
      expect(/from\s+['"][^'"]*provider-usage/.test(a)).toBe(false);
      expect(/from\s+['"][^'"]*dsh-any-connect/.test(b)).toBe(false);
    });
  });
});
