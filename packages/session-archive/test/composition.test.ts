import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/**
 * 最小 REAL-composition 回归（SA-19 / RULE-080）：
 * 经**真实 Cordis Loader**（@deepseek-ai/cordis-plugin-loader）按包名加载
 * Host 入口 `@chaoset/session-archive`（package.json exports → 构建产物
 * lib/index.js，与宿主安装路径一致），**持久化用真实 jsonl 后端**
 * （@deepseek-ai/dsh-session-persistence-jsonl，compression:'none' 便于直接
 * 读回磁盘行），而不是手搓装配。
 *
 * 本用例钉住：
 * - 真实 Loader 装配宿主入口：Loader 用包导出的 `Config` schema 校验并补全
 *   config，apply 挂上 Gateway 服务；
 * - Gateway 的 Remote 方法读取**真实后端写出的会话日志**：list/detail 的
 *   标题与消息来自 jsonl 后端，磁盘文件可被直接读回验证（真实文件世界）；
 * - delete 经真实后端 stat 定位后物理删除文件与目录；
 * - dispose（Loader 条目移除）后 Gateway 服务从 ctx 消失（RULE-086 host 侧
 *   处置面），重新 create 可再次挂载（HMR 重载语义）。
 *
 * 装配面说明：sessionPersistence 是真实 jsonl 后端；workspaceRegistry /
 * sessions / remoteAccess 是本插件消费的宿主业务服务，真实实现分别属于
 * workspace 注册表与会话生命周期，本最小装配用同形状桩（归档集合 + 无内存
 * 会话 + owner 放行），不影响「真实装配 + 真实持久化 + 真实文件世界」的判据。
 */

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const TITLE = '真实后端标题'

let root: string
let ctx: Context
let entryId: string

/** 真实 jsonl 后端写出的会话日志绝对路径（由后端 stat 的 location 给出）。 */
async function realLogPath(): Promise<string> {
  const snapshot = await ctx.sessionPersistence.stat(SESSION_ID as SessionId)
  const location = snapshot?.location?.path
  if (typeof location !== 'string') throw new Error('真实 jsonl 后端未返回 location.path')
  return location
}

/** 用真实后端写一个会话（标题 + 一条用户消息），返回落盘路径。 */
async function writeRealSession(): Promise<string> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SESSION_ID as SessionId,
    createdAt: 1000,
    cwd: '/proj/a',
    isSeeded: false,
  }
  const events = [
    {
      type: 'session/title',
      seq: 0,
      time: 1,
      data: { title: TITLE, messageSeqs: [], source: { kind: 'user' } },
    },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      // 表面事件必须带 surfaceOp（官方 v4 存储契约）；title 是 log-only 事件。
      surfaceOp: 'append',
      data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真实 jsonl 文件里的消息' }] },
    },
  ] as unknown as SessionEvent[]
  const handle = await ctx.sessionPersistence.create(header)
  await handle.append(events)
  await handle.flush()
  await handle.close()
  return realLogPath()
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-compose-'))
  ctx = new Context()
  // 真实 JSONL 持久化后端（compression:'none'：磁盘是逐行可读文本，
  // 便于断言「真的是这份文件提供的列表/详情」）。
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  // 宿主业务服务桩：归档集合 + 无内存会话（可删）+ owner 放行。
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [SESSION_ID] },
    unarchiveSession: async () => {},
  } as never)
  ctx.provide('sessions', { get: () => undefined } as never)
  ctx.provide('remoteAccess', { allows: () => true } as never)
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  entryId = await ctx.loader.create({ name: '@chaoset/session-archive', config: {} })
  await ctx.loader.await()
})

afterEach(async () => {
  try { await ctx.loader.remove(entryId) } catch {}
  await ctx.loader.await()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('真实 Loader + 真实 jsonl 后端装配（SA-19 / RULE-080）', () => {
  it('按包名加载 Host 入口：Config 默认值生效、Gateway 服务挂载', () => {
    const gateway = ctx.get('sessionArchive') as { list: (signal: AbortSignal) => Promise<unknown> } | undefined
    expect(gateway).toBeDefined()
    expect(typeof gateway!.list).toBe('function')
    expect(ctx.loader.resolve(entryId).options.name).toBe('@chaoset/session-archive')
  })

  it('list/detail 读取真实后端写出的会话日志，磁盘文件可读回同一内容', async () => {
    const logPath = await writeRealSession()
    // 真实文件世界：location 指向后端实际文件，且明文（compression:none）可读。
    expect(fs.existsSync(logPath)).toBe(true)
    expect(logPath.endsWith('.jsonl')).toBe(true)
    expect(fs.readFileSync(logPath, 'utf8')).toContain(TITLE)

    const gateway = ctx.get('sessionArchive') as {
      list: (signal: AbortSignal) => Promise<{ items: Array<{ sessionId: string; title: string | null; size: number; updatedAt: number }> }>
      detail: (sessionId: string, signal: AbortSignal) => Promise<{ title: string | null; messages: Array<{ text: string }> }>
    }
    const signal = new AbortController().signal
    const list = await gateway.list(signal)
    expect(list.items.map((item) => item.sessionId)).toEqual([SESSION_ID])
    expect(list.items[0]!.title).toBe(TITLE)
    expect(list.items[0]!.size).toBeGreaterThan(0)
    expect(list.items[0]!.updatedAt).toBeGreaterThan(0)

    const detail = await gateway.detail(SESSION_ID, signal)
    expect(detail.title).toBe(TITLE)
    expect(detail.messages.map((message) => message.text)).toEqual(['真实 jsonl 文件里的消息'])
  })

  it('delete 经真实后端定位后物理删除文件与目录；Loader 条目移除后 Gateway 消失、重建可再挂载', async () => {
    const logPath = await writeRealSession()
    const sessionDir = path.dirname(logPath)
    const gateway = ctx.get('sessionArchive') as {
      delete: (ids: string[], signal: AbortSignal) => Promise<{ deleted: string[]; failed: unknown[] }>
    }
    const result = await gateway.delete([SESSION_ID], new AbortController().signal)
    expect(result).toEqual({ deleted: [SESSION_ID], failed: [], removedFromArchive: 0, needsRestart: [] })
    expect(fs.existsSync(logPath)).toBe(false)
    expect(fs.existsSync(sessionDir)).toBe(false)
    // 真实后端也确认会话已不存在。
    expect(await ctx.sessionPersistence.stat(SESSION_ID as SessionId)).toBeUndefined()

    // dispose：真实 Loader 移除条目 → Gateway 服务（ctx.plugin 注册）被回收。
    await ctx.loader.remove(entryId)
    await ctx.loader.await()
    expect(ctx.get('sessionArchive')).toBeUndefined()

    // 重新 create（等价 HMR reload）→ 服务重新可用。
    entryId = await ctx.loader.create({ name: '@chaoset/session-archive', config: {} })
    await ctx.loader.await()
    expect(ctx.get('sessionArchive')).toBeDefined()
  })
})
