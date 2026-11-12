import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
// 入口只导出 Loader 四件套（name/inject/config/apply），测试便利值走相对路径导入
// （官方 package-surface 规则：入口不得为测试冻结额外 API）。
// SA-08：五个能力方法已整体搬进 SessionArchiveGateway；测试经真实 Context
// 插件装配（ctx.plugin(Gateway)）取得 Gateway，再直调 @Remote 方法——不再
// 有 createArchiveHost 中间转发对象。
import { SessionArchiveGateway } from "../src/remote.js";
import { createHostContext } from "../src/archive-host-context.js";
import type { StatFile } from "../src/archive-host-context.js";
import type { SessionArchiveConfig } from "../src/plugin-config.js";
import type {
  ArchiveDeleteResult,
  ArchiveDetailResult,
  ArchiveListResult,
  ArchiveUnarchiveResult,
} from "../src/types.js";

const prevHome = process.env.HOME;
const prevDshHome = process.env.DSH_HOME;

let fakeHome: string;
let saRoot: string;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fh-"));
  process.env.HOME = fakeHome;
  process.env.DSH_HOME = fakeHome;
});

afterEach(() => {
  // 兜底：用例超时/中断时测试体内的 finally 可能不执行，fake timers 绝不能
  // 泄漏给同文件后续用例（泄漏会让后续 await delay(...) 永远不 resolve，
  // 一条用例的失败放大成整片红——历史上三条失败正是这种级联）。
  vi.useRealTimers();
  process.env.HOME = prevHome;
  process.env.DSH_HOME = prevDshHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
  if (saRoot !== undefined) {
    try { fs.rmSync(saRoot, { recursive: true, force: true }); } catch {}
  }
});

// ── 夹具 ─────────────────────────────────────────────────────────────

function sessionPath(id: string) {
  return path.join(saRoot, "--proj--", id, "session.jsonl");
}

function writeSession(id: string, events: unknown[]) {
  fs.mkdirSync(path.dirname(sessionPath(id)), { recursive: true });
  fs.writeFileSync(sessionPath(id), JSON.stringify(events));
  return path.dirname(sessionPath(id));
}

/** 写一个首行损坏的日志(模拟宿主 persistence.list() 会静默跳过的孤儿)。 */
function writeCorruptSession(id: string) {
  fs.mkdirSync(path.dirname(sessionPath(id)), { recursive: true });
  fs.writeFileSync(sessionPath(id), "{corrupt-first-line}\n{type:nope}\n");
}

function messageEvent(seq: number, time: number, text: string) {
  return { type: "user/message", seq, time, data: { id: "m" + seq, role: "user", content: [{ type: "text", text }] } };
}

function assistantEvent(seq: number, time: number, text: string) {
  return { type: "assistant/message", seq, time, data: { turn: 1, step: seq, message: { id: "m" + seq, role: "assistant", content: [{ type: "text", text }] }, stream: [] } };
}

const baseCfg: SessionArchiveConfig = { detailMaxMessages: 50, messagePreviewChars: 500, titleReadConcurrency: 2 };

/** 手动闸门
 * SessionPersistenceSnapshot 数组、open() read 句柄读事件流、事件 data
 * 为官方 SessionEventMap 形状（user/message 本体、assistant/message 包装）。
 * stat(id) 快照带 0.2.2 的标准 location（当前代际工件路径），与宿主
 * jsonl 后端的行为一致。
 */
function makeFixture(options: {
  archived?: string[];
  headers?: Array<Record<string, any>>;
  /** sessionQuery 标题索引桩：map 给 fulfilled 标题（缺席=无标题）、
   * reject 列单行 rejected、throwAll 整单抛错。不传=无该服务（回退直读）。 */
  titles?: { map?: Record<string, string>; reject?: string[]; throwAll?: boolean };
  /** 官方持久化 projection 缓存桩：map 给零 I/O 标题（null=缓存明确无标题）、
   * miss 列返回 undefined（缓存行不可用）、throwFor 列抛错（模拟坏行）。
   * 不传=无该服务（回退 sessionQuery/直读）。 */
  projectionTitles?: { map?: Record<string, string | null>; miss?: string[]; throwFor?: string[] };
  /** 观测点：ctx.sessions.get 每次被调用时回调。删除路径只在 exclusive
   * 临界区内部调它，用例据此获得「删除已持锁」的确定性同步点，不再靠
   * delay(50) 之类的墙钟窗口。 */
  onSessionGet?: (sessionId: string) => void;
  /** remoteAccess.allows 桩：默认全放行（owner）；给 false 走非 owner 过滤。 */
  remoteAllows?: (sessionId: string) => boolean;
  /** 覆盖 stat 行为（测「快照 location 失效/竞态」等；返回 undefined = 枚举不到）。 */
  stat?: (id: string) => Promise<Record<string, unknown> | undefined>;
} = {}) {
  const registryState = {
    initialized: true,
    workspaceIds: ["w1"],
    archivedSessionIds: [...(options.archived ?? [])],
  };
  const archiveRegistry = {
    // 官方契约是 getter(读内部 state),unarchiveSession 后必须读到新数组——
    // 静态属性会在移除后与 state 脱钩,host 的 archivedSet() 快照
    // 永远是旧集合(delete↔unarchive 互斥的复验会因此失效)。
    get archivedSessionIds() {
      return registryState.archivedSessionIds;
    },
    // 官方 unarchiveSession：幂等移除，未归档的 id 直接 resolve。
    unarchiveSession: async (sessionId: string) => {
      registryState.archivedSessionIds = registryState.archivedSessionIds.filter((id) => id !== sessionId);
    },
  };
  const headers = options.headers ?? [];
  const sessions = new Map<string, unknown>();
  let eventReads = 0;
  const listed = () => headers.filter((h) => fs.existsSync(sessionPath(h.id)));
  const headerOf = (id: string) => {
    const header = headers.find((h) => h.id === id);
    if (header === void 0) throw new Error("no such session " + id);
    return header;
  };
  const eventsOf = (id: string) => JSON.parse(fs.readFileSync(sessionPath(id), "utf8"));

  const persistenceMock: Record<string, any> = {};
  let statCalls = 0;
  let listCalls = 0;
  let openCalls = 0;
  let titleCalls = 0;
  // 官方契约 stat(id):只读该会话元数据;枚举不到(无 header 或文件已删)
  // 返回 undefined。快照携带 0.2.2 的标准 location(当前代际工件路径)。
  // 四端点都走 stat 逐 id 定位，不做全量 list()。
  persistenceMock.stat = async (id: string) => {
    statCalls++;
    if (options.stat !== undefined) return options.stat(id);
    if (!headers.some((h) => h.id === id) || !fs.existsSync(sessionPath(id))) return void 0;
    const header = headerOf(id);
    return {
      header,
      revision: id + ":rev",
      sizeBytes: fs.statSync(sessionPath(id)).size,
      location: { kind: "jsonl", path: sessionPath(id) },
    };
  };
  persistenceMock.list = async () => {
    listCalls++;
    return listed().map((h) => ({
      header: h,
      revision: h.id + ":rev",
      sizeBytes: fs.statSync(sessionPath(h.id)).size,
    }));
  };
  persistenceMock.open = async (id: string, access: string) => {
    openCalls++;
    if (access !== "read") throw new Error("fixture supports read handles only");
    const header = headerOf(id);
    return {
      header,
      // 官方契约 read(offset,length):offset 起、至多 length 条,超界返回空数组。
      read: async (offset: number = 0, length?: number) => {
        eventReads++;
        const all = eventsOf(id);
        const start = Math.max(0, offset ?? 0);
        const end = typeof length === "number" ? start + length : all.length;
        return { eventState: "owned", events: all.slice(start, end) };
      },
      close: async () => {},
    };
  };
  // sessionQuery 标题索引桩（可选服务）：官方 readTitleSnapshots 语义——
  // 保输入序、逐行 fulfilled/rejected、取消整单抛错由调用方回退。
  const sessionQuery = options.titles === undefined ? undefined : {
    readTitleSnapshots: async (ids: string[]) => {
      titleCalls++;
      if (options.titles!.throwAll === true) throw new Error("index unavailable");
      return ids.map((id) => options.titles!.reject?.includes(id) === true
        ? { sessionId: id, status: "rejected", reason: "unavailable" }
        : {
          sessionId: id,
          status: "fulfilled",
          value: {
            session: { id },
            ...(options.titles!.map?.[id] === undefined
              ? {}
              : { title: { title: options.titles!.map[id] } }),
          },
        });
    },
  };
  // 官方持久化 projection 缓存桩（可选服务）：cachedSnapshot 零 I/O 读 title，
  // cachedPredecessorTitle 在测试里恒不可用（跨代际 hint 由桥自身覆盖）。
  const projectionCache = options.projectionTitles === undefined ? undefined : {
    cachedSnapshot: (header: { id: string }, keys?: readonly string[]) => {
      if (keys === undefined || !keys.includes("title")) throw new Error("fixture: projection keys must include title");
      if (options.projectionTitles!.throwFor?.includes(header.id) === true) throw new Error("fixture: corrupt cached row");
      if (options.projectionTitles!.miss?.includes(header.id) === true) return void 0;
      return { values: { title: options.projectionTitles!.map?.[header.id] ?? null } };
    },
    cachedPredecessorTitle: () => void 0,
  };
  // 刻意的部分桩：只实现被测路径用到的服务面，单点断言为完整 Context。
  // get() 按真实 Cordis 语义实现（缺席服务返回 undefined）：可选服务探测
  // 走 get，直读属性在真 Proxy 下会抛，没有 get 方法的极简 ctx 同样被覆盖。
  const services: Record<string, unknown> = {
    workspaceRegistry: archiveRegistry,
    sessionPersistence: persistenceMock,
    sessions: { get: (id: string) => { options.onSessionGet?.(id); return sessions.get(id); } },
    ...(sessionQuery === undefined ? {} : { sessionQuery }),
    ...(projectionCache === undefined ? {} : { sessionProjectionCache: projectionCache }),
  };
  const ctx = {
    ...services,
    get: (name: string) => services[name],
  } as unknown as Context;

  /** 真实 Context 装配：provide 宿主服务 + 插件化激活 Gateway（SA-08）。
   * 返回带默认 signal 的调用面，测试可以像调用普通方法一样使用 @Remote 方法。 */
  async function gateway(cfg: SessionArchiveConfig = baseCfg, statFile?: StatFile): Promise<GatewayFacade> {
    const real = new Context() as any;
    for (const [name, value] of Object.entries(services)) real.provide(name, value);
    real.provide("remoteAccess", {
      allows: (resource: { kind: string; id?: unknown }) =>
        resource.kind !== "session" || (options.remoteAllows?.(String(resource.id)) ?? true),
    });
    await real.plugin(SessionArchiveGateway, { cfg, statFile });
    const instance = real.get("sessionArchive") as SessionArchiveGateway | undefined;
    if (instance === undefined) throw new Error("Gateway did not activate");
    const signal = () => new AbortController().signal;
    return {
      list: (s?: AbortSignal) => instance.list(s ?? signal()),
      count: (s?: AbortSignal) => instance.count(s ?? signal()),
      detail: (id: string, s?: AbortSignal) => instance.detail(id, s ?? signal()),
      delete: (ids: string[], s?: AbortSignal) => instance.delete(ids, s ?? signal()),
      unarchive: (ids: string[], s?: AbortSignal) => instance.unarchive(ids, s ?? signal()),
    };
  }
  return { ctx, gateway, registryState, headers, sessions, persistenceMock, eventReads: () => eventReads, statCalls: () => statCalls, listCalls: () => listCalls, openCalls: () => openCalls, titleCalls: () => titleCalls };
}

/** 测试侧的 Gateway 调用面：缺省 signal（@Remote 方法要求末尾注入项）。 */
interface GatewayFacade {
  list(signal?: AbortSignal): Promise<ArchiveListResult>;
  count(signal?: AbortSignal): Promise<{ count: number }>;
  detail(sessionId: string, signal?: AbortSignal): Promise<ArchiveDetailResult>;
  delete(sessionIds: string[], signal?: AbortSignal): Promise<ArchiveDeleteResult>;
  unarchive(sessionIds: string[], signal?: AbortSignal): Promise<ArchiveUnarchiveResult>;
}

/** 手动闸门：把「某个异步操作已进入临界区」变成可 await 的确定性同步点。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// ── 用例 ─────────────────────────────────────────────────────────────

describe("session-archive host", () => {
  it("list/detail 基础语义与截断计数(totalMessageCount/truncated)", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-basic-"));
    const f = makeFixture({
      archived: ["s1", "s2", "s-ghost"],
      headers: [
        { id: "s1", cwd: "/proj/a", createdAt: 1000 },
        { id: "s2", cwd: "/proj/b", createdAt: 3000 },
        { id: "s3", cwd: "/proj/c", createdAt: 4000 }, // 未归档:不得出现在列表
      ],
    });
    writeSession("s1", [
      { type: "session/title", seq: 1, time: 1000, data: { title: "第一个归档会话", messageSeqs: [2], source: { kind: "user" } } },
      { type: "user/message", seq: 2, time: 1000, data: { id: "m1", role: "user", content: [{ type: "text", text: "你好" }] } },
      { type: "assistant/message", seq: 3, time: 2000, data: { turn: 1, step: 1, message: { id: "m2", role: "assistant", content: [{ type: "text", text: "你好！有什么可以帮你？" }] }, stream: [] } },
    ]);
    writeSession("s2", [
      { type: "user/message", seq: 1, time: 3000, data: { id: "m3", role: "user", content: [{ type: "text", text: "没有标题的会话" }] } },
    ]);
    writeSession("s3", []);
    const archiveHost = await f.gateway(baseCfg);

    const listResult = await archiveHost.list();
    expect(listResult.items.length === 2 && !listResult.items.some((i) => i.sessionId === "s-ghost")).toBe(true);
    expect(!listResult.items.some((i) => i.sessionId === "s3")).toBe(true);
    const rowOf = (id: string) => listResult.items.find((i) => i.sessionId === id)!;
    expect(rowOf("s1").title === "第一个归档会话"
      && rowOf("s2").title === null).toBe(true);
    expect(listResult.items.every((i) => i.size > 0 && i.updatedAt > 0 && i.live === false)).toBe(true);

    // 宿主归档不停止内存会话、web 重连还会恢复旧 tab,但归档会话已从会话
    // 列表移除、无法继续对话——内存存在不构成删除风险,不再标记"运行中"。
    f.sessions.set("s1", {});
    const listLive = await archiveHost.list();
    expect(listLive.items.find((i) => i.sessionId === "s1")!.live === false).toBe(true);

    // 未截断:messageCount 与 totalMessageCount 一致,truncated 为 false。
    const full = await archiveHost.detail("s1");
    expect(full.title === "第一个归档会话" && full.messages.length === 2
      && full.messages[0]!.role === "user"
      && full.messages[1]!.text.includes("可以帮你")).toBe(true);
    expect(full.messageCount === 2 && full.totalMessageCount === 2 && full.truncated === false).toBe(true);
    expect(full.live === false).toBe(true);

    // 截断语义:上限 2、实际 4 条文本消息时,只返回前两条但如实上报总数。
    const cappedCfg = { ...baseCfg, detailMaxMessages: 2 };
    const cappedHost = await f.gateway(cappedCfg);
    writeSession("s2", [
      messageEvent(1, 10, "一"),
      messageEvent(2, 20, "二"),
      messageEvent(3, 30, "三"),
      messageEvent(4, 40, "四"),
    ]);
    const truncatedDetail = await cappedHost.detail("s2");
    expect(truncatedDetail.messages.length === 2
      && truncatedDetail.messages[0]!.text === "一" && truncatedDetail.messages[1]!.text === "二").toBe(true);
    expect(truncatedDetail.messageCount === 2
      && truncatedDetail.totalMessageCount === 4
      && truncatedDetail.truncated === true).toBe(true);
  });

  it("count 端点 / 删除与详情的归档成员校验 / 标题 mtime 缓存", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-count-"));
    const f = makeFixture({
      archived: ["a1", "a-ghost"],
      headers: [
        { id: "a1", cwd: "/proj/a", createdAt: 1000 },
        { id: "live-unarchived", cwd: "/proj/b", createdAt: 2000 },
      ],
    });
    const archiveHost = await f.gateway(baseCfg);
    writeSession("a1", [{ type: "session/title", seq: 1, time: 1, data: { title: "T-a1", messageSeqs: [], source: { kind: "fallback" } } }]);
    writeSession("live-unarchived", []);

    // count():存在性过滤后的真实数量(a-ghost 文件已删),且不触发任何事件流读取。
    const before = f.eventReads();
    expect((await archiveHost.count()).count === 1).toBe(true);
    expect(f.eventReads() === before).toBe(true);

    // list() 第二次调用命中标题缓存(mtime 未变),不再重读事件流。
    await archiveHost.list();
    const afterFirstList = f.eventReads();
    expect(afterFirstList > before).toBe(true);
    await archiveHost.list();
    expect(f.eventReads() === afterFirstList).toBe(true);

    // deleteArchived:未归档的会话(即使文件存在、不在内存)必须拒绝且不动文件。
    const delForeign = await archiveHost.delete(["live-unarchived"]);
    expect(delForeign.deleted.length === 0
      && delForeign.failed[0]!.reason === "not-archived"
      && fs.existsSync(sessionPath("live-unarchived"))).toBe(true);

    // detail:同样只对归档成员开放；拒绝走官方 RemoteError（稳定 code + 类型化
    // details），调用方按 code 判别而非 instanceof。
    let threw: any = null;
    try { await archiveHost.detail("live-unarchived"); } catch (error) { threw = error; }
    const detailFailure = remoteErrorOf(threw);
    expect(detailFailure?.code).toBe("session-archive/not-archived");
    if (detailFailure?.code === "session-archive/not-archived") {
      expect(detailFailure.details.sessionId).toBe("live-unarchived");
      expect(detailFailure.message).toContain("session not archived");
    } else {
      throw new Error("expected session-archive/not-archived RemoteError");
    }
    expect((await archiveHost.detail("a1")).title === "T-a1").toBe(true);
  });

  it("list: 标题优先读官方 projection 缓存（零 I/O），不读日志也不调 sessionQuery", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-projcache-"));
    const f = makeFixture({
      archived: ["p1", "p2"],
      headers: [
        { id: "p1", cwd: "/proj/p", createdAt: 1000 },
        { id: "p2", cwd: "/proj/p", createdAt: 2000 },
      ],
      // 一旦被调用就会记数：用来证明 projection 命中时没有走这条贵路径。
      titles: { map: {} },
      projectionTitles: { map: { p1: "缓存标题 1", p2: null } },
    });
    const archiveHost = await f.gateway(baseCfg);
    // 文件里写一个不同的标题：命中缓存时不应被读到。
    writeSession("p1", [{ type: "session/title", seq: 1, time: 1, data: { title: "文件标题", messageSeqs: [], source: { kind: "fallback" } } }]);
    writeSession("p2", []);
    const beforeReads = f.eventReads();
    const result = await archiveHost.list();
    const rowOf = (id: string) => result.items.find((i) => i.sessionId === id)!;
    expect(rowOf("p1").title).toBe("缓存标题 1");
    expect(rowOf("p2").title === null).toBe(true);
    expect(f.eventReads()).toBe(beforeReads);
    expect(f.titleCalls()).toBe(0);
  });

  it("list: 快照 location 失效时回退完整定位（迁移/竞态），行仍带体积与 mtime", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-locfallback-"));
    const moved = path.join(saRoot, "--proj--", "r1", "moved.jsonl");
    const f = makeFixture({
      archived: ["r1"],
      headers: [{ id: "r1", cwd: "/proj/r", createdAt: 1000 }],
      projectionTitles: { map: { r1: "缓存标题" } },
      // 快照 location 指向不存在的 moved.jsonl：locateSnapshotFile 的快路径
      // stat 失败，回退 fileInfo → 目录里仍能扫到真实代际 session.jsonl。
      stat: async (id: string) => (id === "r1"
        ? { header: { id: "r1", cwd: "/proj/r", createdAt: 1000 }, revision: "r1:rev", sizeBytes: 1, location: { kind: "jsonl", path: moved } }
        : void 0),
    });
    const archiveHost = await f.gateway(baseCfg);
    writeSession("r1", []);
    const row = (await archiveHost.list()).items[0]!;
    expect(row.title).toBe("缓存标题");
    expect(row.size > 0 && row.updatedAt > 0).toBe(true);
  });

  it("list: projection 未命中且批量标题缺该行时回退逐条直读", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-bulkmiss-"));
    const f = makeFixture({
      archived: ["d1"],
      headers: [{ id: "d1", cwd: "/proj/d", createdAt: 1000 }],
      projectionTitles: { miss: ["d1"] },
      titles: { reject: ["d1"] },
    });
    const archiveHost = await f.gateway(baseCfg);
    writeSession("d1", [{ type: "session/title", seq: 1, time: 1, data: { title: "直读标题", messageSeqs: [], source: { kind: "fallback" } } }]);
    const row = (await archiveHost.list()).items[0]!;
    expect(row.title).toBe("直读标题");
  });
  it("list: projection 缓存未命中/坏行才回退批量标题，并写回 mtime 缓存", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-projmiss-"));
    const f = makeFixture({
      archived: ["c1", "m2", "b3"],
      headers: [
        { id: "c1", cwd: "/proj/p", createdAt: 1000 },
        { id: "m2", cwd: "/proj/p", createdAt: 2000 },
        { id: "b3", cwd: "/proj/p", createdAt: 3000 },
      ],
      titles: { map: { m2: "索引标题", b3: "坏行回退标题" } },
      projectionTitles: { map: { c1: "缓存标题" }, miss: ["m2"], throwFor: ["b3"] },
    });
    const archiveHost = await f.gateway(baseCfg);
    for (const id of ["c1", "m2", "b3"]) writeSession(id, []);
    const first = await archiveHost.list();
    const rowOf = (id: string) => first.items.find((i) => i.sessionId === id)!;
    expect(rowOf("c1").title).toBe("缓存标题");
    expect(rowOf("m2").title).toBe("索引标题");
    expect(rowOf("b3").title).toBe("坏行回退标题");
    expect(f.titleCalls()).toBe(1); // 只对未命中的两个 id 调一次
    // 第二轮：projection 命中的 c1 仍零 I/O，m2/b3 已写回 mtime 缓存（文件未变），
    // 不再触发批量标题；两次 list 都不读事件流。
    await archiveHost.list();
    expect(f.titleCalls()).toBe(1);
    expect(f.eventReads()).toBe(0);
  });

  it("删除语义:显式状态 busy/冷会话可删/ghost 不可确认即拒绝/not-archived/unenumerable 孤儿/批量部分失败聚合", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-del-"));
    const f = makeFixture({
      archived: ["s-busy", "s-quiet", "s-del", "s-ghost", "orphan"],
      headers: [
        { id: "s-busy", cwd: "/proj/a", createdAt: 1000 },
        { id: "s-quiet", cwd: "/proj/d", createdAt: 1500 },
        { id: "s-del", cwd: "/proj/b", createdAt: 2000 },
        { id: "foreign", cwd: "/proj/c", createdAt: 3000 }, // 未归档
      ],
    });
    const archiveHost = await f.gateway(baseCfg);
    writeSession("s-busy", []);
    writeSession("s-quiet", []);
    writeSession("s-del", []);
    writeSession("foreign", []);
    writeCorruptSession("orphan"); // 有文件但首行损坏:persistence.list() 枚举不到
    // 显式状态（RULE-049）：会话在宿主 `sessions` 服务里即「可能活跃」→ busy。
    // 不再用 mtime/size 的增长窗口猜测写入方；内存存在本身就是不可逆删除的
    // 拒绝条件（归档会话被宿主/客户端恢复进内存时同样适用）。
    f.sessions.set("s-busy", {});
    f.sessions.set("s-quiet", {});

    // 批量部分失败聚合:deleted 与 failed 同时出现,各自归类正确、文件状态正确。
    const mixed = await archiveHost.delete(["s-busy", "s-del", "foreign"]);
    expect(mixed.deleted.length === 1 && mixed.deleted[0] === "s-del").toBe(true);
    expect(mixed.failed.length === 2).toBe(true);
    expect(mixed.failed.some((x) => x.sessionId === "s-busy" && x.reason === "busy")).toBe(true);
    expect(mixed.failed.some((x) => x.sessionId === "foreign" && x.reason === "not-archived")).toBe(true);
    expect(!fs.existsSync(sessionPath("s-del"))).toBe(true);
    expect(fs.existsSync(sessionPath("s-busy")) && fs.existsSync(sessionPath("foreign"))).toBe(true);
    expect(mixed.removedFromArchive === 0).toBe(true);
    // 冷会话（不在内存）删除:needsRestart 为空,客户端刷新会话列表后原生
    // "设置 → 已归档会话"页即时消失。
    expect(mixed.needsRestart).toEqual([]);

    // 「静默但在内存」不再被猜成可删：显式状态 busy，文件保持原状。
    const quiet = await archiveHost.delete(["s-quiet"]);
    expect(quiet).toEqual({ deleted: [], failed: [{ sessionId: "s-quiet", reason: "busy" }], removedFromArchive: 0, needsRestart: [] });
    expect(fs.existsSync(sessionPath("s-quiet"))).toBe(true);

    // 会话离开宿主内存（冷文件）后即可删除，且 needsRestart 为空。
    f.sessions.delete("s-quiet");
    const quiet2 = await archiveHost.delete(["s-quiet"]);
    expect(quiet2.deleted.includes("s-quiet")
      && quiet2.failed.length === 0
      && !fs.existsSync(sessionPath("s-quiet"))).toBe(true);
    expect(quiet2.needsRestart).toEqual([]);

    // 损坏首行的孤儿文件:枚举不到但文件确实存在 → 拒绝并保留文件,不谎报成功。
    const orphanResult = await archiveHost.delete(["orphan"]);
    expect(orphanResult.deleted.length === 0
      && orphanResult.failed.length === 1
      && orphanResult.failed[0]!.reason === "unenumerable"
      && fs.existsSync(sessionPath("orphan"))).toBe(true);

    // 真 ghost(从未有文件):cwd 未知时 locate 只能探缺省目录,既探不到真实
    // 文件也确认不了缺失——不再谎报成功,按不可枚举拒绝;ghost id 留在归档
    // 集合由存在性过滤隐藏,面板与侧边栏均不可见。
    const ghostResult = await archiveHost.delete(["s-ghost"]);
    expect(ghostResult.deleted.length === 0
      && ghostResult.failed.length === 1
      && ghostResult.failed[0]!.sessionId === "s-ghost"
      && ghostResult.failed[0]!.reason === "unenumerable"
      && f.registryState.archivedSessionIds.includes("s-ghost")).toBe(true);

    // 离开内存后删除成功:文件与会话目录一并消失,归档集合仍保留 ghost id。
    f.sessions.delete("s-busy");
    const delBusy = await archiveHost.delete(["s-busy"]);
    expect(delBusy.deleted.includes("s-busy")
      && !fs.existsSync(sessionPath("s-busy"))
      && !fs.existsSync(path.join(saRoot, "--proj--", "s-busy"))).toBe(true);
    expect(delBusy.needsRestart).toEqual([]);
    expect(f.registryState.archivedSessionIds.includes("s-busy")).toBe(true);
    expect(!(await archiveHost.list()).items.some((i) => i.sessionId === "s-busy")).toBe(true);
  });

  it("H6 回归:目录归属校验失败时只删文件、保留目录(fail-safe)", async () => {
    // 场景 1:目录名不含 sessionId(模拟布局契约改为哈希目录名)——
    // 文件删除,目录保留,绝不递归误删。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-own1-"));
    const f1 = makeFixture({
      archived: ["s-x"],
      headers: [{ id: "s-x", cwd: "/proj/x", createdAt: 1000 }],
    });
    const archiveHost1 = await f1.gateway(baseCfg);
    writeSession("s-x", []);
    // stat 快照的 location 覆盖为哈希式目录(模拟宿主布局契约改为哈希目录名),
    // 同时让 list 的存在性过滤仍能看到该会话。
    const hashDir = path.join(saRoot, "--proj--", "deadbeef");
    fs.mkdirSync(hashDir, { recursive: true });
    fs.writeFileSync(path.join(hashDir, "session.jsonl"), "[]");
    const realStat = f1.persistenceMock.stat.bind(f1.persistenceMock);
    f1.persistenceMock.stat = async (id: string) => {
      const snapshot = await realStat(id);
      if (id === "s-x" && snapshot !== undefined) {
        return { ...snapshot, location: { kind: "jsonl", path: path.join(hashDir, "session.jsonl") } };
      }
      return snapshot;
    };
    const out1 = await archiveHost1.delete(["s-x"]);
    expect(out1.deleted.includes("s-x")).toBe(true);
    expect(fs.existsSync(path.join(hashDir, "session.jsonl"))).toBe(false); // 文件已删
    expect(fs.existsSync(hashDir)).toBe(true); // 目录保留

    // 场景 2:目录内还有其他会话日志("多会话共目录"布局)——目录保留。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-own2-"));
    const f2 = makeFixture({
      archived: ["s-y"],
      headers: [{ id: "s-y", cwd: "/proj/y", createdAt: 2000 }],
    });
    const archiveHost2 = await f2.gateway(baseCfg);
    writeSession("s-y", []);
    fs.writeFileSync(path.join(saRoot, "--proj--", "s-y", "other-session.jsonl"), "[]");
    // 同目录还躺着本会话旧代际：目录保留但旧代际必须清掉，否则「已彻底删除」
    // 的会话数据仍在磁盘上。
    fs.writeFileSync(path.join(saRoot, "--proj--", "s-y", "session.v1.jsonl"), "[]");
    const out2 = await archiveHost2.delete(["s-y"]);
    expect(out2.deleted.includes("s-y")).toBe(true);
    expect(fs.existsSync(sessionPath("s-y"))).toBe(false); // 本会话当前代际已删
    expect(fs.existsSync(path.join(saRoot, "--proj--", "s-y", "session.v1.jsonl"))).toBe(false); // 旧代际已清
    expect(fs.existsSync(path.join(saRoot, "--proj--", "s-y", "other-session.jsonl"))).toBe(true); // 他者日志保留
    expect(fs.existsSync(path.join(saRoot, "--proj--", "s-y"))).toBe(true); // 目录保留

    // 场景 3:目录归属校验失败 + 同会话多代际并存——降级路径必须清掉本会话
    // 全部旧代际（不能只删 stat 定位到的那一个），目录本身保留。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-own3-"));
    const f3 = makeFixture({
      archived: ["s-z"],
      headers: [{ id: "s-z", cwd: "/proj/z", createdAt: 3000 }],
    });
    const archiveHost3 = await f3.gateway(baseCfg);
    writeSession("s-z", []);
    const hashDir3 = path.join(saRoot, "--proj--", "feedface");
    fs.mkdirSync(hashDir3, { recursive: true });
    fs.writeFileSync(path.join(hashDir3, "session.jsonl"), "[]"); // 当前代际（location 指向它）
    fs.writeFileSync(path.join(hashDir3, "session.v1.jsonl"), "[]"); // 旧代际
    fs.writeFileSync(path.join(hashDir3, "session.v2.jsonl.zstd"), "x"); // 旧代际（zstd）
    const realStat3 = f3.persistenceMock.stat.bind(f3.persistenceMock);
    f3.persistenceMock.stat = async (id: string) => {
      const snapshot = await realStat3(id);
      if (id === "s-z" && snapshot !== undefined) {
        return { ...snapshot, location: { kind: "jsonl", path: path.join(hashDir3, "session.jsonl") } };
      }
      return snapshot;
    };
    const out3 = await archiveHost3.delete(["s-z"]);
    expect(out3.deleted.includes("s-z")).toBe(true);
    expect(fs.existsSync(path.join(hashDir3, "session.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(hashDir3, "session.v1.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(hashDir3, "session.v2.jsonl.zstd"))).toBe(false);
    expect(fs.existsSync(hashDir3)).toBe(true); // 目录仍保留（fail-safe）

    // 场景 4:降级路径无法清掉旧代际（以目录形态占位使 rm 失败）——该 id 必须
    // 记 failed 而不是 deleted（磁盘上仍有本会话数据，不得谎报成功）。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-own4-"));
    const f4 = makeFixture({
      archived: ["s-w"],
      headers: [{ id: "s-w", cwd: "/proj/w", createdAt: 4000 }],
    });
    const archiveHost4 = await f4.gateway(baseCfg);
    writeSession("s-w", []);
    const hashDir4 = path.join(saRoot, "--proj--", "cafebabe");
    fs.mkdirSync(hashDir4, { recursive: true });
    // 目录占位（先建、mtime 更旧）使清理阶段 rm 以 EISDIR 失败 → 残留；
    // 当前代际 session.jsonl 必须最后写，确保 resolveGenerationFile 选中它
    // 而不是这个同名族目录。
    const staleGeneration = path.join(hashDir4, "session.v1.jsonl");
    fs.mkdirSync(staleGeneration);
    fs.writeFileSync(path.join(hashDir4, "session.jsonl"), "[]");
    // 显式把残留条目的 mtime 拨旧：resolveGenerationFile 按最新 mtime 选代际，
    // 不能依赖文件系统的 readdir 顺序/时间戳精度。
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(staleGeneration, staleTime, staleTime);
    const realStat4 = f4.persistenceMock.stat.bind(f4.persistenceMock);
    f4.persistenceMock.stat = async (id: string) => {
      const snapshot = await realStat4(id);
      if (id === "s-w" && snapshot !== undefined) {
        return { ...snapshot, location: { kind: "jsonl", path: path.join(hashDir4, "session.jsonl") } };
      }
      return snapshot;
    };
    const out4 = await archiveHost4.delete(["s-w"]);
    expect(out4.deleted).toEqual([]);
    expect(out4.failed).toHaveLength(1);
    expect(out4.failed[0]!.sessionId).toBe("s-w");
    expect(out4.failed[0]!.reason).toContain("stale session files remain");
    expect(f4.registryState.archivedSessionIds.includes("s-w")).toBe(true);
  });

  it("unarchive:恢复仍存在文件的会话、拒绝 ghost", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-un-"));
    const f = makeFixture({
      archived: ["u1", "u-ghost"],
      headers: [{ id: "u1", cwd: "/proj/a", createdAt: 1000 }],
    });
    const archiveHost = await f.gateway(baseCfg);
    writeSession("u1", []);

    // ghost(无持久化文件)拒绝恢复,归档集合保持原状。
    const ghostUn = await archiveHost.unarchive(["u-ghost"]);
    expect(ghostUn.restored.length === 0
      && ghostUn.removedFromArchive === 0
      && f.registryState.archivedSessionIds.includes("u-ghost")).toBe(true);

    // 正常恢复:仅移出归档集合,会话数据不动。
    const unResult = await archiveHost.unarchive(["u1"]);
    expect(unResult.restored.includes("u1")
      && unResult.removedFromArchive === 1
      && fs.existsSync(sessionPath("u1"))
      && !f.registryState.archivedSessionIds.includes("u1")
      && f.registryState.archivedSessionIds.includes("u-ghost")).toBe(true);

  });

  it("删除后立即复验(无 sleep):单次重建被再删掉;持续重建计入 failed('reappeared')", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-race-"));
    const f = makeFixture({
      archived: ["r1", "r2"],
      headers: [
        { id: "r1", cwd: "/proj/a", createdAt: 1000 },
        { id: "r2", cwd: "/proj/b", createdAt: 2000 },
      ],
    });
    writeSession("r1", []);
    writeSession("r2", []);

    // 确定性版本（无墙钟）：宿主在 rm 之后用 stat 立即复验。用最小测试缝
    // statFile 把「删除后被重建」注入到复验点——r1 只重建一次（第二次复验
    // 消失 → deleted），r2 持续重建（第二次复验仍在 → reappeared）。生产路径
    // 使用 node:fs/promises 的真实 stat（默认值），这里只替换复验用的那一次。
    let fakePresent = 0;
    const statFile = async (candidate: string): Promise<{ size: number; mtimeMs: number }> => {
      if (fakePresent > 0 && (candidate === sessionPath("r1") || candidate === sessionPath("r2"))) {
        fakePresent--;
        return { size: 1, mtimeMs: 1 };
      }
      const info = await fs.promises.stat(candidate);
      return { size: info.size, mtimeMs: info.mtimeMs };
    };
    const archiveHost = await f.gateway(undefined, statFile);

    // 单次重建:rm#1 后复验发现重现、再删一次;第二次复验已消失 → deleted。
    fakePresent = 1;
    expect(await archiveHost.delete(["r1"])).toEqual({ deleted: ["r1"], failed: [], removedFromArchive: 0, needsRestart: [] });
    expect(fs.existsSync(sessionPath("r1"))).toBe(false);

    // 持续重建:两次删除后复验都"仍存在" → 不谎报已删,计入 reappeared。
    fakePresent = 2;
    expect(await archiveHost.delete(["r2"])).toEqual({ deleted: [], failed: [{ sessionId: "r2", reason: "reappeared" }], removedFromArchive: 0, needsRestart: [] });
    // 注：真实文件在两次 rm 后已不存在；reappeared 是对「复验仍存在」的如实上报。
    expect(fs.existsSync(sessionPath("r2"))).toBe(false);
  });

  it("官方契约回归:list() 快照形状 + open 句柄下归档列表与详情完整语义(bug 复现用例)", async () => {
    // 回归：list() 返回 {header,...} 快照数组，必须按 header.id 匹配归档
    // id（误读 item.id 会全为 undefined，归档一个也匹配不上 → 面板恒空）。
    // 夹具即官方契约形状,这里锁 list/count/detail 的完整语义。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-v2-"));
    const f = makeFixture({
      archived: ["v1", "v-ghost"],
      headers: [{ id: "v1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("v1", [
      { type: "session/title", seq: 1, time: 1, data: { title: "快照形状", messageSeqs: [2], source: { kind: "user" } } },
      messageEvent(2, 2, "内容"),
      assistantEvent(3, 3, "回复"),
    ]);
    const archiveHost = await f.gateway(baseCfg);
    const listResult = await archiveHost.list();
    const row = listResult.items[0]!;
    expect(listResult.items.length === 1 && row.sessionId === "v1").toBe(true);
    expect(row.title === "快照形状"
      && row.cwd === "/proj/a"
      && row.createdAt === 1000
      && row.size > 0).toBe(true);
    expect((await archiveHost.count()).count === 1).toBe(true);
    // 官方事件 data 形状:user/message 本体、assistant/message 包装(message.content)。
    const detail = await archiveHost.detail("v1");
    expect(detail.title === "快照形状" && detail.messages.length === 2
      && detail.messages[0]!.role === "user" && detail.messages[0]!.text === "内容"
      && detail.messages[1]!.role === "assistant" && detail.messages[1]!.text === "回复").toBe(true);
  });

  it("stat 快照无 location(pending 会话):列表/详情可用(文件信息降级),删除按不可定位处理", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-noloc-"));
    const f = makeFixture({
      archived: ["n1"],
      headers: [{ id: "n1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("n1", [
      { type: "session/title", seq: 1, time: 1, data: { title: "无定位", messageSeqs: [], source: { kind: "fallback" } } },
    ]);
    // pending 会话的快照没有 location(宿主对未落盘会话省略该字段)。
    const realStatN = f.persistenceMock.stat.bind(f.persistenceMock);
    f.persistenceMock.stat = async (id: string) => {
      const snapshot = await realStatN(id);
      if (snapshot === undefined) return void 0;
      const { location: _location, ...rest } = snapshot;
      return rest;
    };
    const archiveHost = await f.gateway(baseCfg);
    const listResult = await archiveHost.list();
    const pendingRow = listResult.items[0]!;
    expect(listResult.items.length === 1 && pendingRow.sessionId === "n1"
      && pendingRow.title === "无定位").toBe(true);
    // 文件不可定位:size 退化为 0、updatedAt 退化为创建时间。
    expect(pendingRow.size === 0 && pendingRow.updatedAt === 1000).toBe(true);
    // 删除:文件存在但无法定位路径 → 既不能谎报成功也不能删错东西,按 busy
    // 同级的失败语义兜底(failed 上报),文件保持原状。
    const del = await archiveHost.delete(["n1"]);
    expect(del.deleted.length === 0
      && del.failed.length === 1
      && fs.existsSync(sessionPath("n1"))).toBe(true);
  });
  it("旧代际文件名(stat location 指向当前代际落空):恢复/删除按目录扫描落到实际文件", async () => {
    // 线上故障第二形状:历史会话落盘为旧代际名 session.jsonl(.zstd),而
    // stat location 只指向当前格式版本拼出的文件名 → 落空 → 恢复被判
    // "文件不存在"全部拒绝("已恢复 0 个")、删除谎报成功但文件还在。目录路径
    // 不随代际变化,修复后按目录扫描落到实际文件。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-gen-"));
    const f = makeFixture({
      archived: ["g1"],
      headers: [{ id: "g1", cwd: "/proj/a", createdAt: 1000 }],
    });
    // 写旧代际文件名(不带 v 前缀),夹具 locate 会拼 session.jsonl → 命中;
    // 这里直接覆盖 locate，使其永远指向不存在的当前代际名，覆盖“定位落空
    // 后按目录扫描实际文件”的路径。
    const legacyPath = sessionPath("g1");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(legacyPath), "session.v1.jsonl"),
      JSON.stringify([{ type: "session/title", seq: 1, time: 1, data: { title: "旧代际", messageSeqs: [], source: { kind: "fallback" } } }]),
    );
    // 夹具 list() 的存在性过滤固定盯 session.jsonl:补一个空文件让它枚举得到
    // g1(模拟宿主 list 能枚举历史代际),真实内容在 session.v1.jsonl 上。
    fs.writeFileSync(legacyPath, "[]");
    const currentGeneration = path.join(path.dirname(legacyPath), "session.v2.jsonl");
    f.persistenceMock.locate = () => ({ kind: "jsonl", path: currentGeneration });

    const archiveHost = await f.gateway(baseCfg);

    // 恢复:目录扫描落到 session.v1.jsonl → confirm 通过 → 移出归档集合。
    const un = await archiveHost.unarchive(["g1"]);
    expect(un.restored.includes("g1")
      && un.removedFromArchive === 1
      && fs.existsSync(path.join(path.dirname(legacyPath), "session.v1.jsonl"))).toBe(true);

    // 删除:同样按目录扫描,真实文件被删、会话目录一并清理。
    f.registryState.archivedSessionIds.push("g1"); // 恢复到归档态再验删除
    const del = await archiveHost.delete(["g1"]);
    expect(del.deleted.includes("g1")
      && !fs.existsSync(path.join(path.dirname(legacyPath), "session.v1.jsonl"))
      && !fs.existsSync(path.dirname(legacyPath))).toBe(true);
    // 兜底断言:夹具的 session.jsonl 存根也随目录清理消失。
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("代际文件扫描不穿透符号链接目录（SA-11 链接防护）", async () => {
    // resolveGenerationFile 旧实现直接 readdir：目录被换成符号链接时会列出
    // 目标目录内容并把它当代际文件返回，后续删除即穿透链接删目标数据。
    // 新实现先 lstat：链接/非目录一律返回 null。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-link-"));
    const target = path.join(saRoot, "link-target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "session.v1.jsonl"), "{}");
    const linkDir = path.join(saRoot, "link-dir");
    fs.symlinkSync(target, linkDir);
    // 最小 ctx：createHostContext 只消费 workspaceRegistry/sessionPersistence/sessions/get。
    const ctx = {
      workspaceRegistry: { archivedSessionIds: [] },
      sessionPersistence: {},
      sessions: { get: () => undefined },
      get: () => undefined,
    } as unknown as Context;
    const deps = createHostContext(ctx, baseCfg);
    expect(await deps.resolveGenerationFile(linkDir)).toBe(null);
    // 判据有效性：真实目录仍能扫到代际文件。
    expect((await deps.resolveGenerationFile(target))?.endsWith("session.v1.jsonl")).toBe(true);
  });

  it("detail:仅含工具调用的助手消息计入总数并生成 [toolNames] 占位摘要（rc.1 tool-call）", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-toolcall-"));
    const f = makeFixture({
      archived: ["tc1"],
      headers: [{ id: "tc1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("tc1", [
      messageEvent(1, 1, "hi"),
      { type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 1, message: { id: "m2", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }] }, stream: [] } },
    ]);
    const detail = await (await f.gateway()).detail("tc1");
    // 纯工具调用消息在旧实现里 text 为空 → 被跳过（不计 totalMessageCount）；
    // rc.1 形状识别后必须有占位文本并计入总数。
    expect(detail.messages.map((message) => message.text)).toEqual(["hi", "[read]"]);
    expect(detail.totalMessageCount).toBe(2);
  });

  it("stat 抛错:删除按 unenumerable 拒绝,不得谎报成功(0.3.9 同源回归)", async () => {
    // stat 抛错时 snapshotsByIds 枚举不到该 id → 删除按 unenumerable 拒绝;
    // 若任何一层把它误判为 absent,删除路径会记成"幂等删除成功"——文件还在
    // 却进了 deleted。fileInfo 里 stat 抛错也归 unknown(unlocatable),是
    // 「快照拿到之后、fileInfo 再抛」竞态窗口的防御分支。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-loc-"));
    const f = makeFixture({
      archived: ["e1"],
      headers: [{ id: "e1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("e1", []);
    f.persistenceMock.stat = async () => {
      throw new Error("backend contract drift");
    };
    const archiveHost = await f.gateway(baseCfg);
    const del = await archiveHost.delete(["e1"]);
    expect(del.deleted.length === 0
      && del.failed.length === 1
      && del.failed[0]!.sessionId === "e1"
      && del.failed[0]!.reason === "unenumerable"
      && fs.existsSync(sessionPath("e1"))).toBe(true);
    // 恢复同样谨慎拒绝(unknown ≠ located)。
    const un = await archiveHost.unarchive(["e1"]);
    expect(un.restored.length === 0 && f.registryState.archivedSessionIds.includes("e1")).toBe(true);
  });

  it("delete ↔ unarchive 互斥:并发时不出现「文件删除且归档标记移除」的错位", async () => {
    // 变体 A:删除先进临界区 → 显式状态 busy 拒绝（内存中存在即不删）；
    // 恢复的临界区排在删除之后，文件未被删除因此恢复成功。
    // 同步点用 ctx.sessions.get 回调：impl 只在 exclusive 临界区内部查
    // 宿主内存状态，因此「删除已持锁」是可等待的事件，不依赖墙钟窗口。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mx1-"));
    const deleteInCritical = deferred();
    const f = makeFixture({
      archived: ["m1"],
      headers: [{ id: "m1", cwd: "/proj/a", createdAt: 1000 }],
      onSessionGet: (sessionId) => {
        if (sessionId === "m1") deleteInCritical.resolve();
      },
    });
    writeSession("m1", []);
    f.sessions.set("m1", {});
    const archiveHost = await f.gateway(baseCfg);
    const delP = archiveHost.delete(["m1"]);
    await deleteInCritical.promise;              // 删除已持锁（显式状态判定中）
    const unP = archiveHost.unarchive(["m1"]);   // 恢复的临界区必然排在删除之后
    const [del, un] = await Promise.all([delP, unP]);
    expect(del).toEqual({ deleted: [], failed: [{ sessionId: "m1", reason: "busy" }], removedFromArchive: 0, needsRestart: [] });
    expect(un).toEqual({ restored: ["m1"], failed: [], removedFromArchive: 1 });
    expect(fs.existsSync(sessionPath("m1"))).toBe(true);
    expect(!f.registryState.archivedSessionIds.includes("m1")).toBe(true);

    // 变体 B:恢复先持锁落地,删除随后发起 → 锁内复验归档成员资格失败,
    // 拒绝删除,文件保持原状。用 registry.unarchiveSession 闸门把「恢复
    // 进行中」钉成可等待状态,再发起删除,同样不依赖墙钟延时。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mx2-"));
    const f2 = makeFixture({
      archived: ["m2"],
      headers: [{ id: "m2", cwd: "/proj/b", createdAt: 2000 }],
    });
    writeSession("m2", []);
    const archiveHost2 = await f2.gateway(baseCfg);
    const unarchiveInCritical = deferred();
    const releaseUnarchive = deferred();
    const registry = f2.ctx.workspaceRegistry;
    const realUnarchiveSession = registry.unarchiveSession.bind(registry);
    registry.unarchiveSession = async (sessionId) => {
      unarchiveInCritical.resolve();             // confirm 已通过、恢复仍持锁
      await releaseUnarchive.promise;
      return realUnarchiveSession(sessionId);
    };
    const unP2 = archiveHost2.unarchive(["m2"]);
    await unarchiveInCritical.promise;
    const delP2 = archiveHost2.delete(["m2"]); // 必然排在恢复之后
    releaseUnarchive.resolve();
    const [un2, del2] = await Promise.all([unP2, delP2]);
    expect(un2).toEqual({ restored: ["m2"], failed: [], removedFromArchive: 1 });
    expect(del2).toEqual({ deleted: [], failed: [{ sessionId: "m2", reason: "not-archived" }], removedFromArchive: 0, needsRestart: [] });
    expect(fs.existsSync(sessionPath("m2"))).toBe(true);
    expect(f2.registryState.archivedSessionIds.includes("m2")).toBe(false);
  });

  it("detail:畸形 assistant 事件(缺 message)不炸整个请求", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mal-"));
    const f = makeFixture({
      archived: ["d1"],
      headers: [{ id: "d1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("d1", [
      messageEvent(1, 10, "正常消息"),
      // 损坏/异构日志:assistant 事件的 data.message 缺失。
      { type: "assistant/message", seq: 2, time: 20, data: { turn: 1, step: 2, stream: [] } },
    ]);
    const archiveHost = await f.gateway(baseCfg);
    const detail = await archiveHost.detail("d1");
    expect(detail.messages.length === 1
      && detail.messages[0]!.text === "正常消息").toBe(true);
  });

  it("detail:畸形事件(data 本体缺失/null 行)不炸整个请求", async () => {
    // 回归:此前 user/message 走 event.data.content,assistant 走
    // event.data.message?.content——data 本体为 null/undefined 时两个分支
    // 都会 TypeError 且炸掉整个 detail;标题路径 readTitle 同样会被 null 行
    // 炸掉(异常被 rowFor 吞掉,标题静默变 null)。scanSession 现在统一剔除
    // 非对象/null 行,data 缺失的消息按空文本不计入。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mal-data-"));
    const f = makeFixture({
      archived: ["d1"],
      headers: [{ id: "d1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("d1", [
      { type: "session/title", seq: 1, time: 5, data: { title: "畸形会话", messageSeqs: [2], source: { kind: "user" } } },
      messageEvent(2, 10, "正常消息"),
      // data 本体缺失的 user/message(合法 JSON 但不是官方事件形状)。
      { type: "user/message", seq: 3, time: 20, data: undefined },
      // 整行是 null(损坏日志里 JSON 字面量 null)。
      null,
    ]);
    const archiveHost = await f.gateway(baseCfg);
    const detail = await archiveHost.detail("d1");
    expect(detail.title === "畸形会话").toBe(true);
    expect(detail.messages.length === 1
      && detail.messages[0]!.text === "正常消息").toBe(true);
    // list() 的标题读取路径同样不炸,标题正常折叠。
    const items = await archiveHost.list();
    expect(items.items.length === 1 && items.items[0]!.title === "畸形会话").toBe(true);
  });

  it("标题/详情分块读取:>块长的事件流不重不漏,标题(块首)与尾部消息都可达", async () => {
    // 回归:此前 read(0) 全量物化,大日志峰值内存 O(整条日志)。分块后必须
    // 仍然跨块取到全部数据——夹具 read 现在按官方契约 honor offset/length。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-chunk-"));
    const f = makeFixture({
      archived: ["c1"],
      headers: [{ id: "c1", cwd: "/proj/a", createdAt: 1000 }],
    });
    const many: unknown[] = [
      { type: "session/title", seq: 1, time: 10, data: { title: "长会话", messageSeqs: [2], source: { kind: "user" } } },
      messageEvent(2, 20, "第一条"),
    ];
    // 追加到远超 200(块长)条:纯工具型 assistant 事件(无文本,只占用块空间)。
    for (let seq = 3; seq <= 450; seq++) {
      many.push({ type: "assistant/message", seq, time: seq * 10, data: { turn: 1, step: seq, message: { id: "m" + seq, role: "assistant", content: [] }, stream: [] } });
    }
    many.push(messageEvent(451, 4510, "最后一条"));
    writeSession("c1", many);
    const archiveHost = await f.gateway(baseCfg);
    const readsBefore = f.eventReads();

    const items = await archiveHost.list();
    expect(items.items.length === 1 && items.items[0]!.title === "长会话").toBe(true);
    // 451 条事件跨 3 块(200+200+51),标题读取必须真的分块而不是一次性读。
    expect(f.eventReads() - readsBefore).toBe(3);

    const detail = await archiveHost.detail("c1");
    expect(detail.title === "长会话").toBe(true);
    // 空文本 assistant 消息不计入总数;文本消息 2 条都取到。
    expect(detail.totalMessageCount === 2).toBe(true);
    expect(detail.messages.map((m: any) => m.text)).toEqual(["第一条", "最后一条"]);
  });

  it("unarchive 失败语义:failed 覆盖全部未恢复 id;delete 的英文 reason 有本地化映射", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-unf-"));
    const f = makeFixture({
      archived: ["u-ok", "u-ghost", "u-gone"],
      headers: [
        { id: "u-ok", cwd: "/proj/a", createdAt: 1000 },
        { id: "u-gone", cwd: "/proj/b", createdAt: 2000 },
      ],
    });
    writeSession("u-ok", []);
    // u-gone:有 header 但文件已删 → stat 枚举不到。
    const archiveHost = await f.gateway(baseCfg);

    const result = await archiveHost.unarchive(["u-ok", "u-ghost", "u-gone", "u-foreign"]);
    expect(result.restored).toEqual(["u-ok"]);
    expect(result.removedFromArchive).toBe(1);
    const reasonOf = (id: string) => result.failed.find((x: any) => x.sessionId === id)?.reason;
    expect(reasonOf("u-ghost")).toBe("unenumerable"); // 从未有文件
    expect(reasonOf("u-gone")).toBe("unenumerable"); // 文件已删
    expect(reasonOf("u-foreign")).toBe("not-archived"); // 请求了但不在归档集合
    expect(result.failed).toHaveLength(3);
    expect(f.registryState.archivedSessionIds.includes("u-ok")).toBe(false);
    expect(f.registryState.archivedSessionIds.includes("u-ghost")).toBe(true);

    // 空 unarchive:无 failed 无 restored,不崩溃。
    const empty = await archiveHost.unarchive([]);
    expect(empty.restored.length === 0 && empty.failed.length === 0).toBe(true);
  });

  it("count/list 走逐 id stat,不再全量 list()", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-stat-"));
    const f = makeFixture({
      archived: ["s1", "s2", "s-ghost"],
      headers: [
        { id: "s1", cwd: "/proj/a", createdAt: 1000 },
        { id: "s2", cwd: "/proj/b", createdAt: 3000 },
      ],
    });
    writeSession("s1", []);
    writeSession("s2", []);
    const archiveHost = await f.gateway(baseCfg);

    const count = await archiveHost.count();
    expect(count.count).toBe(2); // 幽灵 id 不计
    const items = await archiveHost.list();
    expect(items.items.length).toBe(2);
    // 徽标轮询端点不该打全量枚举:逐 id stat,不碰全量 list()。
    expect(f.listCalls()).toBe(0);
    expect(f.statCalls()).toBeGreaterThanOrEqual(6); // count 3 + list 3
  });

  it("list() 标题优先走 sessionQuery 批量索引（全程不 open 事件流）", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-titles-"));
    const f = makeFixture({
      archived: ["s1", "s2"],
      headers: [
        { id: "s1", cwd: "/proj/a", createdAt: 1000 },
        { id: "s2", cwd: "/proj/b", createdAt: 3000 },
      ],
      titles: { map: { s1: "索引标题" } },
    });
    // s1 文件里是另一个标题：用索引标题才算走了批量路径；s2 索引无标题。
    writeSession("s1", [
      { type: "session/title", seq: 1, time: 1000, data: { title: "文件标题", messageSeqs: [], source: { kind: "user" } } },
    ]);
    writeSession("s2", [
      { type: "user/message", seq: 1, time: 3000, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] } },
    ]);
    const archiveHost = await f.gateway(baseCfg);

    const { items } = await archiveHost.list();
    expect(items.find((i) => i.sessionId === "s1")?.title).toBe("索引标题");
    expect(items.find((i) => i.sessionId === "s2")?.title).toBeNull();
    // 标题零事件流扫描：一次批量调用替代逐行 open。
    expect(f.titleCalls()).toBe(1);
    expect(f.openCalls()).toBe(0);
    expect(f.eventReads()).toBe(0);
  });

  it("索引单行 rejected/整单抛错时回退直读（标题仍对）", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-titles-fb-"));
    const mk = (titles: { map?: Record<string, string>; reject?: string[]; throwAll?: boolean }) => makeFixture({
      archived: ["s1", "s2"],
      headers: [
        { id: "s1", cwd: "/proj/a", createdAt: 1000 },
        { id: "s2", cwd: "/proj/b", createdAt: 3000 },
      ],
      titles,
    });
    const files = () => {
      writeSession("s1", [
        { type: "session/title", seq: 1, time: 1000, data: { title: "文件标题一", messageSeqs: [], source: { kind: "user" } } },
      ]);
      writeSession("s2", [
        { type: "session/title", seq: 1, time: 3000, data: { title: "文件标题二", messageSeqs: [], source: { kind: "user" } } },
      ]);
    };
    // 单行 rejected：该行回退直读，其余仍走索引。
    files();
    const partial = (await mk({ map: { s1: "索引标题" }, reject: ["s2"] }).gateway());
    const partialItems = await partial.list();
    expect(partialItems.items.find((i) => i.sessionId === "s1")?.title).toBe("索引标题");
    expect(partialItems.items.find((i) => i.sessionId === "s2")?.title).toBe("文件标题二");
    // 整单抛错：全量回退直读，标题仍对。
    files();
    const f = mk({ throwAll: true });
    const fallback = await f.gateway(baseCfg);
    const fallbackItems = await fallback.list();
    expect(fallbackItems.items.find((i) => i.sessionId === "s1")?.title).toBe("文件标题一");
    expect(fallbackItems.items.find((i) => i.sessionId === "s2")?.title).toBe("文件标题二");
    expect(f.openCalls()).toBeGreaterThan(0);
  });

  it("真实 Context 未挂载 sessionQuery 时回退直读（可选服务探测走 ctx.get）", async () => {
    // 回归：dsh web 启动曾报 cannot get property "sessionQuery" without
    // inject——真实 ctx 是 Proxy，未声明 inject 的服务直接读属性即抛，只有
    // ctx.get 会对缺席服务返回 undefined。可选服务探测必须走 get；本用例
    // 用真实 Context（未 provide sessionQuery）装配 Gateway，list 仍能回退
    // 直读标题。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-proxy-"));
    const f = makeFixture({
      archived: ["s1"],
      headers: [{ id: "s1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("s1", [
      { type: "session/title", seq: 1, time: 1000, data: { title: "文件标题", messageSeqs: [], source: { kind: "user" } } },
    ]);
    const { items } = await (await f.gateway()).list();
    expect(items.length).toBe(1);
    expect(items[0]?.title).toBe("文件标题");
  });});
