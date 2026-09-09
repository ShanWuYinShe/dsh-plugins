import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
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

/**
 * 双线持久化夹具。v2（默认）模拟 dsh 0.1.3+ 契约：list() 返回
 * SessionPersistenceSnapshot 数组、open() read 句柄读事件流、无 readFrom；
 * v1 模拟 0.1.2 及更早：list() 返回 header 数组、readFrom 读事件流。
 * 两者默认都带 locate——jsonl 后端在 0.1.3 起仍提供该诊断钩子（只是从
 * 抽象契约移除），withLocate=false 覆盖无 locate 后端的降级路径。
 */
function makeFixture(options: {
  archived?: string[];
  headers?: Array<Record<string, any>>;
  contract?: "v1" | "v2";
  withLocate?: boolean;
} = {}) {
  const registryState = {
    initialized: true,
    workspaceIds: ["w1"],
    archivedSessionIds: [...(options.archived ?? [])],
  };
  const archiveRegistry = {
    archivedSessionIds: registryState.archivedSessionIds,
    enqueueOperation: async (operation: () => unknown) => { await operation(); },
    requireState: () => registryState,
    setState: (next: Record<string, unknown>) => { Object.assign(registryState, next); },
  };
  const contract = options.contract ?? "v2";
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
  if (contract === "v1") {
    persistenceMock.list = async () => listed();
    persistenceMock.readFrom = async (id: string) => {
      eventReads++;
      return { meta: headerOf(id), events: eventsOf(id) };
    };
  } else {
    persistenceMock.list = async () => listed().map((h) => ({
      header: h,
      revision: h.id + ":rev",
      sizeBytes: fs.statSync(sessionPath(h.id)).size,
    }));
    persistenceMock.open = async (id: string, access: string) => {
      if (access !== "read") throw new Error("fixture supports read handles only");
      const header = headerOf(id);
      return {
        header,
        read: async () => { eventReads++; return { eventState: "owned", events: eventsOf(id) }; },
        close: async () => {},
      };
    };
  }
  const ctx = {
    workspaceRegistry: archiveRegistry,
    sessionPersistence: persistenceMock,
    sessions: { get: (id: string) => sessions.get(id) },
  };
  return { ctx, registryState, headers, sessions, eventReads: () => eventReads, contract };
}

const baseCfg = { detailMaxMessages: 50, messagePreviewChars: 500, titleReadConcurrency: 2 };

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
      { type: "session/title", seq: 1, time: 1000, data: { title: "第一个归档会话", messageSeqs: [2] } },
      { type: "user/message", seq: 2, time: 1000, data: { id: "m1", role: "user", content: [{ type: "text", text: "你好" }] } },
      { type: "assistant/message", seq: 3, time: 2000, data: { id: "m2", role: "assistant", content: [{ type: "text", text: "你好！有什么可以帮你？" }] } },
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
      && full.messages[0].role === "user"
      && full.messages[1].text.includes("可以帮你")).toBe(true);
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
      && truncatedDetail.messages[0].text === "一" && truncatedDetail.messages[1].text === "二").toBe(true);
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
    writeSession("a1", [{ type: "session/title", seq: 1, time: 1, data: { title: "T-a1" } }]);
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
      && delForeign.failed[0].reason === "not-archived"
      && fs.existsSync(sessionPath("live-unarchived"))).toBe(true);

    // detail:同样只对归档成员开放。
    let threw: any = null;
    try { await archiveHost.detail("live-unarchived"); } catch (error) { threw = error; }
    expect(threw !== null && threw.code === "NOT_ARCHIVED").toBe(true);
    expect((await archiveHost.detail("a1")).title === "T-a1").toBe(true);
  });

  it("删除语义:busy/live/ghost 幂等/not-archived/unenumerable 孤儿/批量部分失败聚合", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-del-"));
    const f = makeFixture({
      archived: ["s-busy", "s-del", "s-ghost", "orphan"],
      headers: [
        { id: "s-busy", cwd: "/proj/a", createdAt: 1000 },
        { id: "s-del", cwd: "/proj/b", createdAt: 2000 },
        { id: "foreign", cwd: "/proj/c", createdAt: 3000 }, // 未归档
      ],
    });
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    writeSession("s-busy", []);
    writeSession("s-del", []);
    writeSession("foreign", []);
    writeCorruptSession("orphan"); // 有文件但首行损坏:persistence.list() 枚举不到
    f.sessions.set("s-busy", {});

    // 批量部分失败聚合:deleted 与 failed 同时出现,各自归类正确、文件状态正确。
    const mixed = await archiveHost.deleteArchived(["s-busy", "s-del", "foreign"]);
    expect(mixed.deleted.length === 1 && mixed.deleted[0] === "s-del").toBe(true);
    expect(mixed.failed.length === 2).toBe(true);
    expect(mixed.failed.some((x) => x.sessionId === "s-busy" && x.reason === "busy")).toBe(true);
    expect(mixed.failed.some((x) => x.sessionId === "foreign" && x.reason === "not-archived")).toBe(true);
    expect(!fs.existsSync(sessionPath("s-del"))).toBe(true);
    expect(fs.existsSync(sessionPath("s-busy")) && fs.existsSync(sessionPath("foreign"))).toBe(true);
    expect(mixed.removedFromArchive === 0).toBe(true);

    // 损坏首行的孤儿文件:枚举不到但 locate 探测得到 → 拒绝并保留文件,不谎报成功。
    const orphanResult = await archiveHost.deleteArchived(["orphan"]);
    expect(orphanResult.deleted.length === 0
      && orphanResult.failed.length === 1
      && orphanResult.failed[0].reason === "unenumerable"
      && fs.existsSync(sessionPath("orphan"))).toBe(true);

    // 真 ghost(从未有文件):幂等删除成功,ghost id 保留在归档集合。
    const ghostResult = await archiveHost.deleteArchived(["s-ghost"]);
    expect(ghostResult.deleted.includes("s-ghost")
      && ghostResult.failed.length === 0
      && f.registryState.archivedSessionIds.includes("s-ghost")).toBe(true);

    // busy 解除后可删:文件与会话目录一并消失,归档集合仍保留 ghost id。
    f.sessions.delete("s-busy");
    const delBusy = await archiveHost.deleteArchived(["s-busy"]);
    expect(delBusy.deleted.includes("s-busy")
      && !fs.existsSync(sessionPath("s-busy"))
      && !fs.existsSync(path.join(saRoot, "--proj--", "s-busy"))).toBe(true);
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
    const realLocate = f1.ctx.sessionPersistence.locate;
    f1.ctx.sessionPersistence.locate = (meta: { id: string }) =>
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
    }, baseCfg);
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
      && repeated.failed[0].sessionId === "r2"
      && repeated.failed[0].reason === "reappeared").toBe(true);
  });

  it("0.1.3+ 契约回归:list() 快照形状下归档列表不再恒空(bug 复现用例)", async () => {
    // 线上故障的直接形状:dsh 0.1.3 起 list() 返回 {header,...} 快照数组,
    // 旧代码读 item.id 全为 undefined,归档 id 一个也匹配不上 → 面板恒空。
    // 夹具默认即 v2 契约,这里锁 list/count/detail 在该形状下的完整语义。
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-v2-"));
    const f = makeFixture({
      archived: ["v1", "v-ghost"],
      headers: [{ id: "v1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("v1", [
      { type: "session/title", seq: 1, time: 1, data: { title: "快照形状" } },
      { type: "user/message", seq: 2, time: 2, data: { id: "m1", role: "user", content: [{ type: "text", text: "内容" }] } },
    ]);
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    const listResult = await archiveHost.list();
    expect(listResult.items.length === 1 && listResult.items[0].sessionId === "v1").toBe(true);
    expect(listResult.items[0].title === "快照形状"
      && listResult.items[0].cwd === "/proj/a"
      && listResult.items[0].createdAt === 1000
      && listResult.items[0].size > 0).toBe(true);
    expect((await archiveHost.count()).count === 1).toBe(true);
    const detail = await archiveHost.detail("v1");
    expect(detail.title === "快照形状" && detail.messages.length === 1
      && detail.messages[0].text === "内容").toBe(true);
  });

  it("0.1.2 契约(v1:header 数组 + readFrom)下全量语义保持", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-v1-"));
    const f = makeFixture({
      contract: "v1",
      archived: ["o1", "o-ghost"],
      headers: [{ id: "o1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("o1", [
      { type: "session/title", seq: 1, time: 1, data: { title: "旧契约" } },
      { type: "user/message", seq: 2, time: 2, data: { id: "m1", role: "user", content: [{ type: "text", text: "旧内容" }] } },
    ]);
    const archiveHost = createArchiveHost(f.ctx, baseCfg);
    const listResult = await archiveHost.list();
    expect(listResult.items.length === 1 && listResult.items[0].sessionId === "o1"
      && listResult.items[0].title === "旧契约").toBe(true);
    expect((await archiveHost.count()).count === 1).toBe(true);
    expect((await archiveHost.detail("o1")).messages[0].text === "旧内容").toBe(true);
  });

  it("无 locate 的宿主后端:列表/详情可用(文件信息降级),删除按不可定位处理", async () => {
    saRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-noloc-"));
    const f = makeFixture({
      withLocate: false,
      archived: ["n1"],
      headers: [{ id: "n1", cwd: "/proj/a", createdAt: 1000 }],
    });
    writeSession("n1", [
      { type: "session/title", seq: 1, time: 1, data: { title: "无定位" } },
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
    // 这里直接覆盖 locate 模拟 0.1.5 行为:永远指向不存在的当前代际名。
    const legacyPath = sessionPath("g1");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(legacyPath), "session.v1.jsonl"),
      JSON.stringify([{ type: "session/title", seq: 1, time: 1, data: { title: "旧代际" } }]),
    );
    // 夹具 list() 的存在性过滤固定盯 session.jsonl:补一个空文件让它枚举得到
    // g1(模拟宿主 list 能枚举历史代际),真实内容在 session.v1.jsonl 上。
    fs.writeFileSync(legacyPath, "[]");
    const currentGeneration = path.join(path.dirname(legacyPath), "session.v2.jsonl");
    f.ctx.sessionPersistence.locate = () => ({ kind: "jsonl", path: currentGeneration });

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
});
