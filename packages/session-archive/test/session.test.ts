import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { createArchiveHost } from "../src/index.js";

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

/**
 * 官方契约夹具：list() 返回
 * SessionPersistenceSnapshot 数组、open() read 句柄读事件流、事件 data
 * 为官方 SessionEventMap 形状（user/message 本体、assistant/message 包装）。
 * 默认带 locate——jsonl 后端的诊断钩子（不在抽象契约上），
 * withLocate=false 覆盖无 locate 后端的降级路径;withStat=false 覆盖
 * stat 不在契约上的宿主(四端点回退全量 list() 的降级路径)。
 */
function makeFixture(options: {
  archived?: string[];
  headers?: Array<Record<string, any>>;
  withLocate?: boolean;
  /** false = stat 不在契约上的宿主(四端点回退全量 list() 的降级路径)。 */
  withStat?: boolean;
  /** sessionQuery 标题索引桩：map 给 fulfilled 标题（缺席=无标题）、
   * reject 列单行 rejected、throwAll 整单抛错。不传=无该服务（回退直读）。 */
  titles?: { map?: Record<string, string>; reject?: string[]; throwAll?: boolean };
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
  const withLocate = options.withLocate ?? true;
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

  const persistenceMock: Record<string, any> = withLocate
    ? { locate: (meta: { id: string }) => ({ kind: "jsonl", path: sessionPath(meta.id) }) }
    : {};
  let statCalls = 0;
  let listCalls = 0;
  let openCalls = 0;
  let titleCalls = 0;
  // 官方契约 stat(id):只读该会话元数据;枚举不到(无 header 或文件已删)
  // 返回 undefined。四端点都走 stat 逐 id 定位，不做全量 list()。
  // withStat=false 时完全不挂 stat——钉住 snapshotsByIds 的全量 list() 回退。
  if (options.withStat !== false) persistenceMock.stat = async (id: string) => {
    statCalls++;
    if (!headers.some((h) => h.id === id) || !fs.existsSync(sessionPath(id))) return void 0;
    const header = headerOf(id);
    return { header, revision: id + ":rev", sizeBytes: fs.statSync(sessionPath(id)).size };
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
  // 刻意的部分桩：只实现被测路径用到的服务面，单点断言为完整 Context。
  // get() 按真实 Cordis 语义实现（缺席服务返回 undefined）：可选服务探测
  // 走 get，直读属性在真 Proxy 下会抛，没有 get 方法的极简 ctx 同样被覆盖。
  const services: Record<string, unknown> = {
    workspaceRegistry: archiveRegistry,
    sessionPersistence: persistenceMock,
    sessions: { get: (id: string) => sessions.get(id) },
    ...(sessionQuery === undefined ? {} : { sessionQuery }),
  };
  const ctx = {
    ...services,
    get: (name: string) => services[name],
  } as unknown as Context;
  return { ctx, registryState, headers, sessions, persistenceMock, eventReads: () => eventReads, statCalls: () => statCalls, listCalls: () => listCalls, openCalls: () => openCalls, titleCalls: () => titleCalls };
}

const baseCfg = { detailMaxMessages: 50, messagePreviewChars: 500, titleReadConcurrency: 2 };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);

    const listResult = await archiveHost.list();
    expect(listResult.items.length === 2 && !listResult.items.some((i) => i.sessionId === "s-ghost")).toBe(true);
    expect(!listResult.items.some((i) => i.sessionId === "s3")).toBe(true);
    expect(listResult.items.find((i) => i.sessionId === "s1").title === "第一个归档会话"
      && listResult.items.find((i) => i.sessionId === "s2").title === null).toBe(true);
    expect(listResult.items.every((i) => i.size > 0 && i.updatedAt > 0 && i.live === false)).toBe(true);

    // 宿主归档不停止内存会话、web 重连还会恢复旧 tab,但归档会话已从会话
    // 列表移除、无法继续对话——内存存在不构成删除风险,不再标记"运行中"。
    f.sessions.set("s1", {});
    const listLive = await archiveHost.list();
    expect(listLive.items.find((i) => i.sessionId === "s1").live === false).toBe(true);

    // 未截断:messageCount 与 totalMessageCount 一致,truncated 为 false。
    const full = await archiveHost.detail("s1");
    expect(full.title === "第一个归档会话" && full.messages.length === 2
      && full.messages[0]!.role === "user"
      && full.messages[1]!.text.includes("可以帮你")).toBe(true);
    expect(full.messageCount === 2 && full.totalMessageCount === 2 && full.truncated === false).toBe(true);
    expect(full.live === false).toBe(true);

    // 截断语义:上限 2、实际 4 条文本消息时,只返回前两条但如实上报总数。
    const cappedCfg = { ...baseCfg, detailMaxMessages: 2 };
    const cappedHost = createArchiveHost(f.ctx, cappedCfg);
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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
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
    const delForeign = await archiveHost.deleteArchived(["live-unarchived"]);
    expect(delForeign.deleted.length === 0
      && delForeign.failed[0]!.reason === "not-archived"
      && fs.existsSync(sessionPath("live-unarchived"))).toBe(true);

    // detail:同样只对归档成员开放。
    let threw: any = null;
    try { await archiveHost.detail("live-unarchived"); } catch (error) { threw = error; }
    expect(threw !== null && threw.code === "NOT_ARCHIVED").toBe(true);
    expect((await archiveHost.detail("a1")).title === "T-a1").toBe(true);
  });

  it("删除语义:busy 增长判定/静默会话可删/ghost 不可确认即拒绝/not-archived/unenumerable 孤儿/批量部分失败聚合", async () => {
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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    writeSession("s-busy", []);
    writeSession("s-quiet", []);
    writeSession("s-del", []);
    writeSession("foreign", []);
    writeCorruptSession("orphan"); // 有文件但首行损坏:persistence.list() 枚举不到
    f.sessions.set("s-busy", {});
    f.sessions.set("s-quiet", {});

    // 模拟活跃生成流:每 50ms 往 s-busy 日志 append(比沉降观察窗口 300ms
    // 密),窗口内体积必然增长。
    const appender = setInterval(() => {
      try { fs.appendFileSync(sessionPath("s-busy"), "x"); } catch {}
    }, 50);

    // 批量部分失败聚合:deleted 与 failed 同时出现,各自归类正确、文件状态正确。
    const mixed = await archiveHost.deleteArchived(["s-busy", "s-del", "foreign"]);
    expect(mixed.deleted.length === 1 && mixed.deleted[0] === "s-del").toBe(true);
    expect(mixed.failed.length === 2).toBe(true);
    expect(mixed.failed.some((x) => x.sessionId === "s-busy" && x.reason === "busy")).toBe(true);
    expect(mixed.failed.some((x) => x.sessionId === "foreign" && x.reason === "not-archived")).toBe(true);
    expect(!fs.existsSync(sessionPath("s-del"))).toBe(true);
    expect(fs.existsSync(sessionPath("s-busy")) && fs.existsSync(sessionPath("foreign"))).toBe(true);
    expect(mixed.removedFromArchive === 0).toBe(true);
    // s-del 是冷文件(不在内存):needsRestart 为空,客户端刷新会话列表后
    // 原生"设置 → 已归档会话"页即时消失。
    expect(mixed.needsRestart).toEqual([]);
    clearInterval(appender);

    // 静默会话回归(线上误报用例):在内存(tab 恢复)、mtime 被宿主批量落盘/
    // 迁移/flush 刷新过(60s 内),但沉降观察窗口内体积静止——不是活跃生成流,
    // 必须可删,不得报"请先停止"。
    const quiet = await archiveHost.deleteArchived(["s-quiet"]);
    expect(quiet.deleted.includes("s-quiet")
      && quiet.failed.length === 0
      && !fs.existsSync(sessionPath("s-quiet"))).toBe(true);
    // s-quiet 文件已删但内存会话仍在:ghost 保留 + 内存摘要仍在 → 原生页在
    // 宿主重启前仍会显示,如实返回 needsRestart 供客户端提示用户。
    expect(quiet.needsRestart).toEqual(["s-quiet"]);

    // 损坏首行的孤儿文件:枚举不到但文件确实存在 → 拒绝并保留文件,不谎报成功。
    const orphanResult = await archiveHost.deleteArchived(["orphan"]);
    expect(orphanResult.deleted.length === 0
      && orphanResult.failed.length === 1
      && orphanResult.failed[0]!.reason === "unenumerable"
      && fs.existsSync(sessionPath("orphan"))).toBe(true);

    // 真 ghost(从未有文件):cwd 未知时 locate 只能探缺省目录,既探不到真实
    // 文件也确认不了缺失——不再谎报成功,按不可枚举拒绝;ghost id 留在归档
    // 集合由存在性过滤隐藏,面板与侧边栏均不可见。
    const ghostResult = await archiveHost.deleteArchived(["s-ghost"]);
    expect(ghostResult.deleted.length === 0
      && ghostResult.failed.length === 1
      && ghostResult.failed[0]!.sessionId === "s-ghost"
      && ghostResult.failed[0]!.reason === "unenumerable"
      && f.registryState.archivedSessionIds.includes("s-ghost")).toBe(true);

    // 不在内存即冷文件:即使 mtime 新鲜(写入方已随会话停止消失)也直接删,
    // 不做增长观察。文件与会话目录一并消失,归档集合仍保留 ghost id。
    f.sessions.delete("s-busy");
    const delBusy = await archiveHost.deleteArchived(["s-busy"]);
    expect(delBusy.deleted.includes("s-busy")
      && !fs.existsSync(sessionPath("s-busy"))
      && !fs.existsSync(path.join(saRoot, "--proj--", "s-busy"))).toBe(true);
    // 内存已清空的冷删除:needsRestart 为空,原生页刷新即消失。
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
    const archiveHost1 = createArchiveHost(f1.ctx, baseCfg);
    writeSession("s-x", []);
    // locate 覆盖为哈希式目录,同时让 list 的存在性过滤仍能看到该会话
    const hashDir = path.join(saRoot, "--proj--", "deadbeef");
    fs.mkdirSync(hashDir, { recursive: true });
    fs.writeFileSync(path.join(hashDir, "session.jsonl"), "[]");
    const realLocate = f1.persistenceMock.locate;
    f1.persistenceMock.locate = (meta: { id: string }) =>
      meta.id === "s-x" ? { kind: "jsonl", path: path.join(hashDir, "session.jsonl") } : realLocate(meta);
    const out1 = await archiveHost1.deleteArchived(["s-x"]);
    expect(out1.deleted.includes("s-x")).toBe(true);
    expect(fs.existsSync(path.join(hashDir, "session.jsonl"))).toBe(false); // 文件已删
    expect(fs.existsSync(hashDir)).toBe(true); // 目录保留

    // 场景 2:目录内还有其他会话日志("多会话共目录"布局)——目录保留。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-own2-"));
    const f2 = makeFixture({
      archived: ["s-y"],
      headers: [{ id: "s-y", cwd: "/proj/y", createdAt: 2000 }],
    });
    const archiveHost2 = createArchiveHost(f2.ctx, baseCfg);
    writeSession("s-y", []);
    fs.writeFileSync(path.join(saRoot, "--proj--", "s-y", "other-session.jsonl"), "[]");
    const out2 = await archiveHost2.deleteArchived(["s-y"]);
    expect(out2.deleted.includes("s-y")).toBe(true);
    expect(fs.existsSync(sessionPath("s-y"))).toBe(false); // 本会话文件已删
    expect(fs.existsSync(path.join(saRoot, "--proj--", "s-y", "other-session.jsonl"))).toBe(true); // 他者日志保留
    expect(fs.existsSync(path.join(saRoot, "--proj--", "s-y"))).toBe(true); // 目录保留
  });

  it("unarchive:恢复仍存在文件的会话、拒绝 ghost;降级路径仅按存在性过滤", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-un-"));
    const f = makeFixture({
      archived: ["u1", "u-ghost"],
      headers: [{ id: "u1", cwd: "/proj/a", createdAt: 1000 }],
    });
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
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

    // 降级(registry 无写入通道):列表按存在性过滤幽灵 id;恢复返回空而不崩溃。
    const degraded = createArchiveHost({
      ...f.ctx,
      workspaceRegistry: { archivedSessionIds: ["u1", "u-ghost"] },
    } as unknown as Context, baseCfg);
    const degList = await degraded.list();
    expect(degList.items.length === 1 && degList.items[0].sessionId === "u1").toBe(true);
    const degUn = await degraded.unarchive(["u1"]);
    expect(degUn.restored.length === 0 && degUn.removedFromArchive === 0).toBe(true);
  });

  it("TOCTOU 删除后复验:单次重建被再删掉;持续重建计入 failed('reappeared')", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-race-"));
    const f = makeFixture({
      archived: ["r1", "r2"],
      headers: [
        { id: "r1", cwd: "/proj/a", createdAt: 1000 },
        { id: "r2", cwd: "/proj/b", createdAt: 2000 },
      ],
    });
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    writeSession("r1", []);
    writeSession("r2", []);

    // 单次重建:生成流恰在删除窗口内落盘(100ms 后写回,早于 300ms 复验点)
    // → 复验发现重现、再删一次,最终计入 deleted 且文件确实不在。
    const recreate = setTimeout(() => {
      try { writeSession("r1", []); } catch {}
    }, 100);
    const once = await archiveHost.deleteArchived(["r1"]);
    clearTimeout(recreate);
    expect(once.deleted.includes("r1") && !fs.existsSync(sessionPath("r1"))).toBe(true);

    // 持续重建:每 50ms 写回一次,两次 rm 都压不掉 → failed('reappeared')。
    const writer = setInterval(() => {
      try {
        fs.mkdirSync(path.dirname(sessionPath("r2")), { recursive: true });
        fs.writeFileSync(sessionPath("r2"), "{}");
      } catch {}
    }, 50);
    const repeated = await archiveHost.deleteArchived(["r2"]);
    clearInterval(writer);
    expect(repeated.deleted.length === 0
      && repeated.failed.length === 1
      && repeated.failed[0]!.sessionId === "r2"
      && repeated.failed[0]!.reason === "reappeared").toBe(true);
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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    const listResult = await archiveHost.list();
    expect(listResult.items.length === 1 && listResult.items[0].sessionId === "v1").toBe(true);
    expect(listResult.items[0].title === "快照形状"
      && listResult.items[0].cwd === "/proj/a"
      && listResult.items[0].createdAt === 1000
      && listResult.items[0].size > 0).toBe(true);
    expect((await archiveHost.count()).count === 1).toBe(true);
    // 官方事件 data 形状:user/message 本体、assistant/message 包装(message.content)。
    const detail = await archiveHost.detail("v1");
    expect(detail.title === "快照形状" && detail.messages.length === 2
      && detail.messages[0]!.role === "user" && detail.messages[0]!.text === "内容"
      && detail.messages[1]!.role === "assistant" && detail.messages[1]!.text === "回复").toBe(true);
  });

  it("无 locate 的宿主后端:列表/详情可用(文件信息降级),删除按不可定位处理", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-noloc-"));
    const f = makeFixture({
      withLocate: false,
      archived: ["n1"],
      headers: [{ id: "n1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("n1", [
      { type: "session/title", seq: 1, time: 1, data: { title: "无定位", messageSeqs: [], source: { kind: "fallback" } } },
    ]);
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    const listResult = await archiveHost.list();
    expect(listResult.items.length === 1 && listResult.items[0].sessionId === "n1"
      && listResult.items[0].title === "无定位").toBe(true);
    // 文件不可定位:size 退化为 0、updatedAt 退化为创建时间。
    expect(listResult.items[0].size === 0 && listResult.items[0].updatedAt === 1000).toBe(true);
    // 删除:文件存在但无法定位路径 → 既不能谎报成功也不能删错东西,按 busy
    // 同级的失败语义兜底(failed 上报),文件保持原状。
    const del = await archiveHost.deleteArchived(["n1"]);
    expect(del.deleted.length === 0
      && del.failed.length === 1
      && fs.existsSync(sessionPath("n1"))).toBe(true);
  });
  it("无 stat 的宿主后端:四端点回退全量 list() 的降级路径", async () => {
    // 钉住 snapshotsByIds 的降级:stat 不在契约上的宿主(老版本/异构后端)
    // 回退一次全量 list() 按需挑出归档 id——此前该分支零覆盖,夹具恒有 stat。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-nostat-"));
    const f = makeFixture({
      withStat: false,
      archived: ["s1", "s2"],
      headers: [
        { id: "s1", cwd: "/proj/a", createdAt: 1000 },
        { id: "s2", cwd: "/proj/b", createdAt: 2000 },
      ],
    });
    writeSession("s1", [
      { type: "session/title", seq: 1, time: 1, data: { title: "无stat一", messageSeqs: [], source: { kind: "fallback" } } },
      messageEvent(2, 2, "内容"),
    ]);
    writeSession("s2", [
      { type: "session/title", seq: 1, time: 1, data: { title: "无stat二", messageSeqs: [], source: { kind: "fallback" } } },
    ]);
    const archiveHost = createArchiveHost(f.ctx, baseCfg);

    // list/count 走回退,行为与 stat 路径一致。
    const listResult = await archiveHost.list();
    expect(listResult.items.length === 2).toBe(true);
    expect(listResult.items.find((i: any) => i.sessionId === "s1")?.title === "无stat一").toBe(true);
    expect((await archiveHost.count()).count === 2).toBe(true);
    expect(f.listCalls() > 0).toBe(true); // 确实走了全量 list() 回退

    // delete 的 ghost 判定在回退路径下照常:文件删掉后 list() 枚举不到,
    // 幂等删除(absent)语义与 stat 路径一致。
    const del = await archiveHost.deleteArchived(["s2"]);
    expect(del.deleted.length === 1 && del.deleted[0] === "s2").toBe(true);
  });

  it("旧代际文件名(locate 指向当前代际落空):恢复/删除按目录扫描落到实际文件", async () => {
    // 线上故障第二形状:历史会话落盘为旧代际名 session.jsonl(.zstd),而
    // locate() 只按当前格式版本拼文件名 → stat 落空 → 恢复被判"文件不存在"
    // 全部拒绝("已恢复 0 个")、删除谎报成功但文件还在。目录路径不随代际
    // 变化,修复后按目录扫描落到实际文件。
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

    const archiveHost = createArchiveHost(f.ctx, baseCfg);

    // 恢复:目录扫描落到 session.v1.jsonl → confirm 通过 → 移出归档集合。
    const un = await archiveHost.unarchive(["g1"]);
    expect(un.restored.includes("g1")
      && un.removedFromArchive === 1
      && fs.existsSync(path.join(path.dirname(legacyPath), "session.v1.jsonl"))).toBe(true);

    // 删除:同样按目录扫描,真实文件被删、会话目录一并清理。
    f.registryState.archivedSessionIds.push("g1"); // 恢复到归档态再验删除
    const del = await archiveHost.deleteArchived(["g1"]);
    expect(del.deleted.includes("g1")
      && !fs.existsSync(path.join(path.dirname(legacyPath), "session.v1.jsonl"))
      && !fs.existsSync(path.dirname(legacyPath))).toBe(true);
    // 兜底断言:夹具的 session.jsonl 存根也随目录清理消失。
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("locate 抛错:删除按 unlocatable 拒绝,不得谎报成功(0.3.9 同源回归)", async () => {
    // fileInfo 的外层兜底若把 locate 抛错误判为 absent,删除路径会记成
    // "幂等删除成功"——文件还在却进了 deleted。按语义表必须归 unknown,
    // 对应删除路径的 unlocatable 拒绝。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-loc-"));
    const f = makeFixture({
      archived: ["e1"],
      headers: [{ id: "e1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("e1", []);
    f.persistenceMock.locate = () => {
      throw new Error("backend contract drift");
    };
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    const del = await archiveHost.deleteArchived(["e1"]);
    expect(del.deleted.length === 0
      && del.failed.length === 1
      && del.failed[0]!.sessionId === "e1"
      && del.failed[0]!.reason === "unlocatable"
      && fs.existsSync(sessionPath("e1"))).toBe(true);
    // 恢复同样谨慎拒绝(unknown ≠ located)。
    const un = await archiveHost.unarchive(["e1"]);
    expect(un.restored.length === 0 && f.registryState.archivedSessionIds.includes("e1")).toBe(true);
  });

  it("delete ↔ unarchive 互斥:并发时不出现「文件删除且归档标记移除」的错位", async () => {
    // 变体 A:删除先进临界区(在内存 + mtime 新鲜 → 300ms 沉降窗口),恢复
    // 排队等到删除完成后 confirm → absent → 拒绝恢复。没有互斥时 confirm
    // 可在沉降窗口内探到 located,unarchiveSession 会把 id 移出集合——文件没了、
    // 归档标记也没了,内存会话重回侧边栏。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mx1-"));
    const f = makeFixture({
      archived: ["m1"],
      headers: [{ id: "m1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("m1", []);
    f.sessions.set("m1", {});
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    const delP = archiveHost.deleteArchived(["m1"]);
    await delay(50);
    const unP = archiveHost.unarchive(["m1"]);
    const [del, un] = await Promise.all([delP, unP]);
    expect(del.deleted.includes("m1")).toBe(true);
    expect(un.restored.length === 0).toBe(true);
    expect(!fs.existsSync(sessionPath("m1"))).toBe(true);
    // ghost id 留在集合,由存在性过滤隐藏。
    expect(f.registryState.archivedSessionIds.includes("m1")).toBe(true);

    // 变体 B:恢复先落地,删除随后 → 锁内复验归档成员资格失败,拒绝删除,
    // 文件保持原状。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mx2-"));
    const f2 = makeFixture({
      archived: ["m2"],
      headers: [{ id: "m2", cwd: "/proj/b", createdAt: 2000 }],
    });
    writeSession("m2", []);
    const archiveHost2 = createArchiveHost(f2.ctx, baseCfg);
    const unP2 = archiveHost2.unarchive(["m2"]);
    await delay(50);
    const delP2 = archiveHost2.deleteArchived(["m2"]);
    const [un2, del2] = await Promise.all([unP2, delP2]);
    expect(un2.restored.includes("m2")).toBe(true);
    expect(del2.deleted.length === 0
      && del2.failed.length === 1
      && del2.failed[0]!.reason === "not-archived"
      && fs.existsSync(sessionPath("m2"))).toBe(true);
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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    const detail = await archiveHost.detail("d1");
    expect(detail.title === "畸形会话").toBe(true);
    expect(detail.messages.length === 1
      && detail.messages[0]!.text === "正常消息").toBe(true);
    // list() 的标题读取路径同样不炸,标题正常折叠。
    const items = await archiveHost.list();
    expect(items.items.length === 1 && items.items[0].title === "畸形会话").toBe(true);
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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    const readsBefore = f.eventReads();

    const items = await archiveHost.list();
    expect(items.items.length === 1 && items.items[0].title === "长会话").toBe(true);
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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);

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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);

    const count = await archiveHost.count();
    expect(count.count).toBe(2); // 幽灵 id 不计
    const items = await archiveHost.list();
    expect(items.items.length).toBe(2);
    // 徽标轮询端点不该打全量枚举:stat 缺失才回退 list()。
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
    const archiveHost = createArchiveHost(f.ctx, baseCfg);

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
    const partial = createArchiveHost(mk({ map: { s1: "索引标题" }, reject: ["s2"] }).ctx, baseCfg);
    const partialItems = await partial.list();
    expect(partialItems.items.find((i) => i.sessionId === "s1")?.title).toBe("索引标题");
    expect(partialItems.items.find((i) => i.sessionId === "s2")?.title).toBe("文件标题二");
    // 整单抛错：全量回退直读，标题仍对。
    files();
    const f = mk({ throwAll: true });
    const fallback = createArchiveHost(f.ctx, baseCfg);
    const fallbackItems = await fallback.list();
    expect(fallbackItems.items.find((i) => i.sessionId === "s1")?.title).toBe("文件标题一");
    expect(fallbackItems.items.find((i) => i.sessionId === "s2")?.title).toBe("文件标题二");
    expect(f.openCalls()).toBeGreaterThan(0);
  });

  it("真 Cordis 代理语义下回退直读（未 inject 的直接属性访问抛错）", async () => {
    // 回归：dsh web 启动曾报 cannot get property "sessionQuery" without
    // inject——真实 ctx 是 Proxy，未声明 inject 的服务直接读属性即抛，只有
    // ctx.get 会对缺席服务返回 undefined。可选服务探测必须走 get。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-proxy-"));
    const f = makeFixture({
      archived: ["s1"],
      headers: [{ id: "s1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("s1", [
      { type: "session/title", seq: 1, time: 1000, data: { title: "文件标题", messageSeqs: [], source: { kind: "user" } } },
    ]);
    const proxied = new Proxy(f.ctx as unknown as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (prop === "get") return (name: string) => (target as Record<string, unknown>)[name];
        if (prop in target) return Reflect.get(target, prop, receiver);
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    });
    const archiveHost = createArchiveHost(proxied as unknown as Context, baseCfg);
    const { items } = await archiveHost.list();
    expect(items.length).toBe(1);
    expect(items[0]?.title).toBe("文件标题");
  });
});
