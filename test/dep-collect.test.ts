import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBunStoreEntries,
  collectDirectDeps,
  collectWalkTree,
  createCollector,
  depKey,
  parseBunStoreEntry,
} from "../scripts/lib/dep-collect.mjs";

/**
 * 依赖收集纯逻辑的直接测试（scripts/lib/dep-collect.mjs）。
 *
 * 2026-10-08 补：audit-deps.mjs 是发布前的漏洞门禁，收集错了（漏包、错版本）不会报错，
 * 只会让审计静默少查——典型的无自然信号退化。收集逻辑从脚本里抽成纯函数后，在这里钉住。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const WS = new Set(["@chaoset/dsh-any-connect"]);

describe("类型声明与实现一致", () => {
  it("dep-collect.d.mts 的导出面与实现一致（防止声明漂移）", async () => {
    const actual = Object.keys(await import("../scripts/lib/dep-collect.mjs")).sort();
    const declared = [...readFileSync(join(ROOT, "scripts/lib/dep-collect.d.mts"), "utf8")
      .matchAll(/export declare (?:const|function) (\w+)/g)].map((match) => match[1] as string).sort();
    expect(actual).toEqual(declared);
  });
});

describe("depKey", () => {
  it("同版本多路径只查一次，不同版本分别查", () => {
    expect(depKey("foo", "1.0.0")).toBe("foo@1.0.0");
    expect(depKey("foo", "1.0.0")).toBe(depKey("foo", "1.0.0"));
    expect(depKey("foo", "1.0.0")).not.toBe(depKey("foo", "2.0.0"));
  });
});

describe("parseBunStoreEntry", () => {
  it("解析普通包目录名", () => {
    expect(parseBunStoreEntry("foo@1.2.3")).toEqual({ name: "foo", version: "1.2.3" });
    expect(parseBunStoreEntry("foo@1.2.3-alpha.1")).toEqual({ name: "foo", version: "1.2.3-alpha.1" });
  });

  it("scoped 包的 / 存为 +，只替换第一个", () => {
    expect(parseBunStoreEntry("@deepseek-ai+dsh-sandbox@0.1.7-rc.2")).toEqual({
      name: "@deepseek-ai/dsh-sandbox",
      version: "0.1.7-rc.2",
    });
  });

  it("按最后一个 @ 切分（npm 版本不含 @，此分支实际走不到，仅钉住确定性）", () => {
    expect(parseBunStoreEntry("foo@1.0.0@beta")).toEqual({ name: "foo@1.0.0", version: "beta" });
  });

  it("无 @ 或 @ 开头视为形态不符", () => {
    expect(parseBunStoreEntry("foobar")).toBeNull();
    expect(parseBunStoreEntry("@foobar")).toBeNull();
    expect(parseBunStoreEntry("")).toBeNull();
  });

  it("空版本只做形态拆分，由收集器统一过滤", () => {
    expect(parseBunStoreEntry("foo@")).toEqual({ name: "foo", version: "" });
  });
});

describe("createCollector", () => {
  it("workspace 自有包不收集", () => {
    const { deps, collect } = createCollector(WS);
    collect("@chaoset/dsh-any-connect", "0.4.0");
    collect("foo", "1.0.0");
    expect([...deps.keys()]).toEqual(["foo@1.0.0"]);
  });

  it("空与非法版本跳过", () => {
    const { deps, collect } = createCollector(new Set());
    collect("a", "");
    collect("b", undefined);
    collect("c", 42);
    collect("d", null);
    collect("e", "1.0.0");
    expect([...deps.keys()]).toEqual(["e@1.0.0"]);
  });

  it("同键去重，不同版本分别保留", () => {
    const { deps, collect } = createCollector(new Set());
    collect("foo", "1.0.0");
    collect("foo", "1.0.0");
    collect("foo", "2.0.0");
    expect(deps.size).toBe(2);
    expect(deps.get("foo@1.0.0")).toEqual({ name: "foo", version: "1.0.0" });
  });
});

describe("collectBunStoreEntries", () => {
  it("混合清单：只收合法项，workspace 成员排除", () => {
    const deps = collectBunStoreEntries(
      ["foo@1.0.0", "@deepseek-ai+bar@2.0.0", "broken", "@leader", "@chaoset/dsh-any-connect@0.4.0", "foo@"],
      WS,
    );
    expect([...deps.keys()].sort()).toEqual(["@deepseek-ai/bar@2.0.0", "foo@1.0.0"]);
  });
});

describe("collectDirectDeps", () => {
  const manifests = [
    {
      dependencies: { foo: "^1.0.0", "@chaoset/dsh-any-connect": "0.4.0" },
      devDependencies: { bar: "~2.0.0" },
    },
    {
      optionalDependencies: { foo: "^1.0.0", baz: "^3.0.0" },
      peerDependencies: { qux: "^4.0.0" },
    },
  ];
  const versions: Record<string, string> = {
    foo: "1.2.3",
    bar: "2.1.0",
    baz: "3.0.1",
    qux: "4.0.0",
  };

  it("四个区块都扫，跨 manifest 去重，workspace 排除", () => {
    const calls: string[] = [];
    const deps = collectDirectDeps(manifests, WS, (name) => {
      calls.push(name);
      return versions[name];
    });
    expect([...deps.keys()].sort()).toEqual(["bar@2.1.0", "baz@3.0.1", "foo@1.2.3", "qux@4.0.0"]);
    // foo 在两个 manifest 里都声明，只读一次安装版本。
    expect(calls.filter((name) => name === "foo")).toHaveLength(1);
  });

  it("未安装（reader 返回 undefined）即跳过", () => {
    const deps = collectDirectDeps([{ dependencies: { missing: "^1.0.0" } }], new Set(), () => undefined);
    expect(deps.size).toBe(0);
  });

  it("dsh.host 等非依赖字段不参与", () => {
    const deps = collectDirectDeps([{ dsh: { host: "0.2.1-alpha.1" } }], new Set(), () => "9.9.9");
    expect(deps.size).toBe(0);
  });
});

describe("collectWalkTree", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function pkg(root: string, dirRel: string, manifest: Record<string, unknown>): void {
    const dir = join(root, dirRel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }

  it("收集普通包、scoped 包与嵌套 node_modules，跳过点目录与坏文件", () => {
    const root = mkdtempSync(join(tmpdir(), "dep-collect-walk-"));
    dirs.push(root);
    pkg(root, "foo", { name: "foo", version: "1.0.0" });
    pkg(root, "@scope/bar", { name: "@scope/bar", version: "2.0.0" });
    // 读的是 package.json 里声明的名字，不是目录名（npm 语义）。
    pkg(root, "foo/node_modules/nested", { name: "nested", version: "0.0.1" });
    pkg(root, "@chaoset/dsh-any-connect", { name: "@chaoset/dsh-any-connect", version: "0.4.0" });
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, ".hidden", "package.json"), JSON.stringify({ name: "hidden", version: "9.9.9" }));
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "package.json"), "{not json");
    mkdirSync(join(root, "noname"), { recursive: true });
    writeFileSync(join(root, "noname", "package.json"), JSON.stringify({ version: "1.0.0" }));
    const deps = collectWalkTree(root, WS);
    expect([...deps.keys()].sort()).toEqual(["@scope/bar@2.0.0", "foo@1.0.0", "nested@0.0.1"]);
  });

  it("不存在的根目录返回空表而不抛错", () => {
    expect(collectWalkTree(join(tmpdir(), "dep-collect-no-such-dir"), new Set()).size).toBe(0);
  });
});
