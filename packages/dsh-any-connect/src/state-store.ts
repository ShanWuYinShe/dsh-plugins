/**
 * state-store.ts — 插件状态域：自有凭据副本的宿主官方持久化（storageDomain）。
 *
 * 2026-10-11 迁移：自有凭据副本从 `$DSH_HOME` 根下的散文件（`.workbuddy-auth.json`
 * 等 4 份）收敛进宿主存储域 `<DSH_HOME>/storages/dsh_any_connect/`
 * （`@deepseek-ai/dsh-storage-domain`，与 dsh-workspace / dsh-schedule 同一机制）：
 *
 * - 白拿宿主的类型化校验（zod schema）、每域单写链原子写、损坏记录
 *   `backup-and-skip`、随 DSH_HOME 隔离——原 `withFileLock` +
 *   `writeFileAtomic` 的自管实现退役。
 * - 域名 `dsh_any_connect` 受 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`）约束，
 *   不能用包名的连字符拼写。
 * - 迁移（{@link migrateLegacyCredentialFiles}）：宿主启动后跑一次，读旧根文件
 *   → 写域 → 删旧文件；**先写域成功才删旧**，任何一步失败旧文件原样保留，
 *   下次启动重试。
 * - CLI（bin）没有宿主 storageDomain 服务，用
 *   {@link openStandaloneStateStore} 独立实例化同款 json backend 打开**同一**
 *   存储单元——两侧读写语义一致，logout 删域数据与插件运行时所见相同。
 * - 域 open 失败时插件运行时 fail loud：静默回落文件会造成域与文件双写分裂。
 *
 * @module dsh-any-connect/state-store
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { descriptorOf, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseOwnDocument } from './auth-document.js'
import type { WorkBuddyCredential } from './auth-types.js'

/** 域内单条凭据记录：即插件统一的凭据形态（WorkBuddy 与 ZCode 共用）。 */
const credentialSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAtMs: z.number(),
  refreshExpiresAtMs: z.number().optional(),
  domain: z.string(),
  uid: z.string(),
  enterpriseId: z.string().optional(),
  nickname: z.string().optional(),
  source: z.enum(['desktop', 'dsh']),
  zcodePlan: z.enum(['individual-coding-plan', 'team-coding-plan', 'start-plan', 'off-peak']).optional(),
  zcodeJwtToken: z.string().optional(),
  zcodeDeviceMid: z.string().optional(),
}).strict()

/**
 * 插件状态域声明。`layout: 'per-record'`：每条凭据一个文件，各变体互不影响；
 * 坏记录挪到备份位（`backup-and-skip`）而不是让整个域打不开。
 */
export const anyConnectDomain = defineDomain({
  name: 'dsh_any_connect',
  version: 1,
  layout: 'per-record',
  tables: {
    auth: domainTable(credentialSchema),
  },
  invalidRecords: 'backup-and-skip',
})

/** 域内凭据表的键：变体 id（workbuddy / workbuddy-ai / zcode / zcode-start-plan）。 */
type VariantId = string

/** 自有凭据副本的持久化接口：域实现与 standalone 实现共用。 */
export interface WorkBuddyStateStore {
  /** 读一份凭据副本；无副本（含记录损坏）返回 undefined。 */
  read(variantId: VariantId): Promise<WorkBuddyCredential | undefined>
  /** 写（覆盖）一份凭据副本。 */
  write(variantId: VariantId, credential: WorkBuddyCredential): Promise<void>
  /** 删一份凭据副本（logout）；副本不存在时静默成功。 */
  clear(variantId: VariantId): Promise<void>
}

/** 域实现的凭据表名。 */
const AUTH_TABLE = 'auth'

/** 宿主 storageDomain 域句柄的状态存取包装（插件运行时用）。 */
export function domainStateStore(domain: Domain<typeof anyConnectDomain>): WorkBuddyStateStore {
  const table = domain.table(AUTH_TABLE)
  return {
    // 域读是内存同步，但接口统一异步签名，两侧实现可互换。
    read: async variantId => table.get(variantId),
    write: async (variantId, credential) => {
      await table.put(variantId, credential)
    },
    clear: async variantId => {
      await table.delete(variantId)
    },
  }
}

/**
 * CLI 的独立状态存取：绕过宿主服务，直接实例化同款 json backend 打开**同一**
 * 存储单元（`<DSH_HOME>/storages/dsh_any_connect/`）。宿主进程内也持有该单元的
 * 句柄，但 json 单元是目录式 per-record 布局，短命 CLI 的单次读写与运行时的
 * 域写链不共享内存态——读写各自落盘后天然一致；logout（删记录）与运行时
 * refresh（写记录）同时发生的窗口小到可以接受，与原跨进程文件锁同量级。
 */
export async function openStandaloneStateStore(): Promise<WorkBuddyStateStore & { close(): Promise<void> }> {
  const backend = new JsonStorageBackend(join(resolveDshHome(), 'storages'))
  const unit = await backend.kv.open(descriptorOf(anyConnectDomain))
  const readAll = async (): Promise<Record<VariantId, WorkBuddyCredential>> => {
    const snapshot = await unit.loadAll()
    const raw = (snapshot.tables[AUTH_TABLE] ?? {}) as Record<VariantId, unknown>
    const parsed: Record<VariantId, WorkBuddyCredential> = {}
    for (const [key, value] of Object.entries(raw)) {
      const result = credentialSchema.safeParse(value)
      // 损坏记录与 readOwn 的策略一致：视为无凭据，不炸诊断。
      if (result.success) parsed[key] = result.data
    }
    return parsed
  }
  return {
    read: async variantId => (await readAll())[variantId],
    write: async (variantId, credential) => {
      await unit.putRecord(AUTH_TABLE, variantId, credentialSchema.parse(credential))
    },
    clear: async variantId => {
      await unit.deleteRecord(AUTH_TABLE, variantId)
    },
    close: async () => {
      await unit.close()
      await backend.close()
    },
  }
}

/**
 * 旧散文件迁移：把状态域接管前的两处自有凭据副本搬进域——
 *
 * 1. 旧根布局（`$DSH_HOME` 根下的 `.workbuddy-auth.json` 等 4 份，2026-10-11 前）；
 * 2. 状态目录回落副本（`.dsh-any-connect/` 下的同名文件）：域 open 之前的回落
 *    窗口（注入前的 refresh）可能在这里落过盘，也要收编，否则成为孤儿副本。
 *
 * 只在宿主启动时跑一次；每份文件独立处理，单份失败不影响其余。**先写域成功
 * 才删源**，任何一步失败源文件原样保留、下次启动重试。两处同名时以状态目录
 * 的那份为准（它是更晚的回落写）。返回已迁移的源文件路径（诊断用）。
 */
export async function migrateLegacyCredentialFiles(
  state: WorkBuddyStateStore,
  legacyPathFor: (ownFilename: string) => string,
  fallbackPathFor: (ownFilename: string) => string,
  onWarning?: (message: string) => void,
): Promise<readonly string[]> {
  const migrated: string[] = []
  for (const ownFilename of LEGACY_OWN_FILENAMES) {
    const variantId = ownFilenameToVariantId(ownFilename)
    // 两处来源按「旧根在前、回落目录在后」的顺序收编：同名时后写的覆盖先写的，
    // 正好让更新的回落副本胜出。
    for (const sourcePath of [legacyPathFor(ownFilename), fallbackPathFor(ownFilename)]) {
      let text: string
      try {
        text = await readFile(sourcePath, 'utf8')
      } catch {
        continue // 不存在（绝大多数用户的稳态）——安静跳过
      }
      const credential = parseOwnDocument(text)
      if (credential === undefined) {
        onWarning?.(`state-store: legacy credential file ${sourcePath} is unreadable; left in place untouched`)
        continue
      }
      try {
        await state.write(variantId, credential)
      } catch (error: unknown) {
        // 写域失败绝不能删源文件：源副本是唯一落盘副本（先写域成功才删源）。
        onWarning?.(`state-store: migrating ${sourcePath} into the state domain failed (${String(error)}); the file is kept and migration retries on next start`)
        continue
      }
      try {
        await rm(sourcePath, { force: true })
        migrated.push(sourcePath)
      } catch (error: unknown) {
        // 域里已经有了,删源失败只留下一个陈旧副本——下次启动重删。
        onWarning?.(`state-store: removing the migrated legacy file ${sourcePath} failed: ${String(error)}`)
      }
    }
  }
  return migrated
}

/** 旧根布局里的自有凭据副本文件名（迁移输入；与 variants.ts 的 ownFilename 一致）。 */
export const LEGACY_OWN_FILENAMES = [
  '.workbuddy-auth.json',
  '.workbuddy-ai-auth.json',
  '.zcode-auth.json',
  '.zcode-sp-auth.json',
] as const

/** 旧文件名 → 变体 id（迁移时决定记录落进哪条）。 */
function ownFilenameToVariantId(ownFilename: string): VariantId {
  switch (ownFilename) {
    case '.workbuddy-auth.json': return 'workbuddy'
    case '.workbuddy-ai-auth.json': return 'workbuddy-ai'
    case '.zcode-auth.json': return 'zcode'
    case '.zcode-sp-auth.json': return 'zcode-start-plan'
    default: throw new Error(`state-store: unknown legacy own filename ${JSON.stringify(ownFilename)}`)
  }
}
