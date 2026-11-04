/**
 * state-store.ts — 插件状态域：自有凭据副本的宿主官方持久化（storageDomain）。
 *
 * 2026-10-11 起自有凭据副本收敛进宿主存储域
 * `<DSH_HOME>/storages/dsh_any_connect/`（`@deepseek-ai/dsh-storage-domain`，与
 * dsh-workspace / dsh-schedule 同一机制）。旧位置的自动搬迁已在 DSH 0.2.2-alpha.2
 * 适配中删除（不保留旧兼容，见 CHANGELOG「破坏性变更」）：
 *
 * - 白拿宿主的类型化校验（zod schema）、每域单写链原子写、损坏记录
 *   `backup-and-skip`、随 DSH_HOME 隔离——原 `withFileLock` +
 *   `writeFileAtomic` 的自管实现退役。
 * - 域名 `dsh_any_connect` 受 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`）约束，
 *   不能用包名的连字符拼写。
 * - CLI（bin）没有宿主 storageDomain 服务，用
 *   {@link openStandaloneStateStore} 独立实例化同款 json backend 打开**同一**
 *   存储单元——两侧读写语义一致，logout 删域数据与插件运行时所见相同。
 * - 域 open 失败时插件运行时记一条 error 日志后继续走文件回落（见 index.ts 的
 *   storageDomain inject）：模型代理主链路不因持久化层故障整体不可用，域就绪后
 *   以域为准。
 *
 * @module dsh-any-connect/state-store
 */

import { join } from 'node:path'
import { z } from 'zod'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { descriptorOf, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyCredential } from './auth-types.js'
import type { CreditLedgerPersistence, CreditLedgerState } from './credit-ledger.js'

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
 * 台账（credit-ledger.ts）一天的聚合记录。与凭据同域不同表：都是「按变体一条」
 * 的数据，域保持 version 1——per-record 布局的版本检查按记录进行，新表只是
 * 新记录，存量凭据记录不受影响、无需迁移。
 */
const ledgerDaySchema = z.object({
  date: z.string(),
  peak: z.number(),
  last: z.number(),
  consumed: z.number(),
  granted: z.number(),
  samples: z.number(),
  updatedAtMs: z.number(),
}).strict()

const ledgerSchema = z.object({
  days: z.array(ledgerDaySchema).max(31),
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
    ledger: domainTable(ledgerSchema),
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

/** 域内台账表的表名。 */
const LEDGER_TABLE = 'ledger'

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
 * 宿主域句柄的台账持久化（credit-ledger.ts 的 CreditLedgerPersistence 实现）。
 * 写走域的单写链，与凭据副本互不阻塞。
 */
export function domainCreditLedgerPersistence(domain: Domain<typeof anyConnectDomain>): CreditLedgerPersistence {
  const table = domain.table(LEDGER_TABLE)
  return {
    load: async variantId => table.get(variantId),
    save: async (variantId, state) => {
      await table.put(variantId, state)
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
export async function openStandaloneStateStore(): Promise<WorkBuddyStateStore & {
  /** 读台账（credit-ledger）一条记录；CLI status 的今日统计只读用。 */
  readLedger(variantId: VariantId): Promise<CreditLedgerState | undefined>
  close(): Promise<void>
}> {
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
  const readLedger = async (variantId: VariantId): Promise<CreditLedgerState | undefined> => {
    const snapshot = await unit.loadAll()
    const raw = snapshot.tables[LEDGER_TABLE] as Record<string, unknown> | undefined
    const value = raw?.[variantId]
    if (value === undefined) return undefined
    const result = ledgerSchema.safeParse(value)
    // 损坏台账与凭据同一策略：视为无数据，不炸诊断。
    return result.success ? result.data : undefined
  }
  return {
    read: async variantId => (await readAll())[variantId],
    readLedger,
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
