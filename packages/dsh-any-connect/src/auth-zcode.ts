/**
 * auth-zcode.ts — ZCode 侧凭据解析：加密 api-key 解密、账号/计划选择、device-mid 与 auth 文档解析。
 *
 * 2026-10-08 从 1160 行的 auth.ts 拆出：类型、路径解析、ZCode 解析、文档解析与
 * 存储类原本在一个文件里。auth.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/auth-zcode
 */

import crypto from 'node:crypto'
import os from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyCredential, ZCodeFamily, ZCodePlanKind } from './auth-types.js'
import { decryptZCodeEncryptedKey } from './auth-zcode-crypto.js'
import type { DecryptZCodeKeyOptions } from './auth-zcode-crypto.js'


/** Every plan kind the desktop client can record for an account provider. */
export const ZCODE_PLAN_KINDS: readonly ZCodePlanKind[] = [
  'individual-coding-plan',
  'team-coding-plan',
  'start-plan',
  'off-peak',
]

/** One decoded account selection, as `setting.json` records it. */
export interface ZCodeAccountSelection {
  family: ZCodeFamily
  plan: ZCodePlanKind
}

/** The account-provider credential key shape the ZCode client writes. */
const ZCODE_ACCOUNT_KEY = /^account-provider:coding-plan:account:(bigmodel|zai)-([a-z-]+):account:([^:]+):api-key$/u

function isPlanKind(value: string): value is ZCodePlanKind {
  return (ZCODE_PLAN_KINDS as readonly string[]).includes(value)
}

/**
 * Read which account provider the ZCode client currently has selected.
 *
 * `setting.json` sits next to `credentials.json` and records the pick as
 * `providerFamilyConnectionSelections: { <family>: { kind } }`, with
 * `providerFamilyDomain` naming the active family. Both are plain JSON (the
 * file holds no secrets), so this is a read of user configuration rather than
 * of credential material; every failure is a miss, never an error.
 */
export function parseZCodePlanSelection(text: string): ZCodeAccountSelection | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const settings = parsed as Record<string, unknown>

  const rawDomain = settings['providerFamilyDomain']
  const domain = typeof rawDomain === 'string' ? rawDomain.trim() : ''
  const family: ZCodeFamily | undefined = domain === 'bigmodel' || domain === 'zai' ? domain : undefined

  const selections = settings['providerFamilyConnectionSelections']
  if (typeof selections !== 'object' || selections === null || Array.isArray(selections)) return undefined
  const byFamily = selections as Record<string, unknown>

  // The active family wins; without one, fall back to the only family that
  // carries a selection — a single-selection document is unambiguous.
  const candidates: ZCodeFamily[] = family !== undefined
    ? [family, ...(family === 'bigmodel' ? ['zai'] as const : ['bigmodel'] as const)]
    : ['bigmodel', 'zai']
  for (const candidate of candidates) {
    const entry = byFamily[candidate]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const kind = (entry as Record<string, unknown>)['kind']
    if (typeof kind === 'string' && isPlanKind(kind)) return { family: candidate, plan: kind }
  }
  return undefined
}

/**
 * Pick which `...:api-key` entry of a ZCode credentials document to use.
 *
 * The document is a flat map keyed by provider id, and a real install holds one
 * entry per account provider the user has ever connected — this machine carries
 * both a team and an individual coding-plan key. Taking the first match (the
 * historical behavior) therefore depended on object insertion order and handed
 * the request whichever key happened to be written first. The client itself
 * resolves through its own `setting.json` selection, so an explicit selection
 * wins here too; only without one does this fall back to the historical scan.
 */
export function selectZCodeAccountKey(
  entries: readonly (readonly [string, string])[],
  selection?: ZCodeAccountSelection,
): { documentKey: string; value: string; uid: string; family?: ZCodeFamily; plan?: ZCodePlanKind } | undefined {
  const typed = entries.flatMap(([documentKey, value]) => {
    const match = ZCODE_ACCOUNT_KEY.exec(documentKey)
    if (match === null) return []
    return [{ documentKey, value, family: match[1] as ZCodeFamily, plan: match[2]!, uid: match[3]! }]
  })
  const shape = (entry: typeof typed[number], plan: ZCodePlanKind | undefined) => ({
    documentKey: entry.documentKey,
    value: entry.value,
    uid: entry.uid,
    family: entry.family,
    ...plan === undefined ? {} : { plan },
  })
  // 只在凭据里确实存在该计划的 key 时才认这个选择。账号计划（start-plan）
  // 从不写 api-key 条目——模型请求本来就该走它账户上的 coding-plan key
  // （这是「按普通 ZCode 150% 额度使用」的口径），此时选择只用于识别账号，
  // 不能让"找不到对应 key"把请求打回文件顺序。
  if (selection !== undefined) {
    const picked = typed.find(entry => entry.family === selection.family && entry.plan === selection.plan)
    if (picked !== undefined) return shape(picked, selection.plan)
  }
  // 账号计划没有自己的 key：回落到同 family 的 coding-plan key 走普通通道。
  // 个人版优先于团队版——团队 key 在服务端需要 bigmodel-organization /
  // bigmodel-project 身份头（本包不发），个人版不需要，是更稳的默认；客户端
  // 自己选中的那把若就在其中，则最先取它。
  const pickFrom = (predicate: (entry: typeof typed[number]) => boolean): typeof typed[number] | undefined =>
    typed.find(entry => entry.family === selection?.family && predicate(entry))
  const preferred = selection === undefined
    ? undefined
    : pickFrom(entry => entry.plan === selection.plan)
      ?? pickFrom(entry => entry.plan === 'individual-coding-plan')
      ?? pickFrom(entry => entry.plan === 'team-coding-plan')
  if (preferred !== undefined) return shape(preferred, preferred.plan as ZCodePlanKind)
  const fallback = typed[0]
  if (fallback === undefined) return undefined
  return shape(fallback, isPlanKind(fallback.plan) ? fallback.plan : undefined)
}

/** Read the account selection recorded beside a ZCode credentials file. */
function readZCodeSelection(desktopPath: string | undefined): ZCodeAccountSelection | undefined {
  if (desktopPath === undefined) return undefined
  try {
    return parseZCodePlanSelection(readFileSync(join(dirname(desktopPath), 'setting.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Basename of the fallback device-id file inside the Harness home. */
export const ZCODE_DEVICE_MID_FILENAME = '.zcode-device-mid'

/**
 * Resolve the stable device id the account-plan endpoints require
 * (`X-Device-Mid`). The desktop client's own value (telemetry state beside the
 * credentials file) wins — requests then look like that install's. Without
 * one, a random UUIDv4 is generated and persisted under `$DSH_HOME` so at
 * least it is stable across requests; per-request randomness is rejected by
 * the upstream (400 code 3001 / 429).
 */
export function resolveZCodeDeviceMid(desktopPath: string | undefined): string {
  if (desktopPath !== undefined) {
    try {
      const telemetry = JSON.parse(readFileSync(join(dirname(desktopPath), 'telemetry-state.json'), 'utf8')) as Record<string, unknown>
      if (typeof telemetry['deviceMid'] === 'string' && telemetry['deviceMid'] !== '') return telemetry['deviceMid']
    } catch {
      // absent or unreadable telemetry state — fall through
    }
  }
  const fallbackPath = join(resolveDshHome(), ZCODE_DEVICE_MID_FILENAME)
  try {
    const persisted = readFileSync(fallbackPath, 'utf8').trim()
    if (persisted !== '') return persisted
  } catch {
    // no persisted fallback yet — generate one
  }
  const generated = crypto.randomUUID()
  try {
    writeFileSync(fallbackPath, `${generated}\n`, { mode: 0o600 })
  } catch {
    // 不落盘也只是退化为每次进程内稳定（内存调用方各自读取时会再生成）；
    // 上游只要求同值复用，尽力而为。
  }
  return generated
}

/**
 * Parse a ZCode credentials.json document into a WorkBuddyCredential
 * representation.
 *
 * Besides the account API key this carries the decrypted `zcodejwttoken` and
 * the device id for the account-plan (Start Plan) channel: both live in the
 * same document / directory, and which credential a request needs follows
 * from the plan in force (see {@link WorkBuddyCredential.zcodePlan}).
 */
export function parseZCodeAuth(text: string, desktopPath?: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const data = parsed as Record<string, unknown>

  const entries = Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  const selection = readZCodeSelection(desktopPath)
  const picked = selectZCodeAccountKey(entries, selection)

  let apiKeyRaw = picked?.value
  let uid = picked?.uid ?? ''
  if (!apiKeyRaw && typeof data['apiKey'] === 'string') {
    apiKeyRaw = data['apiKey']
  }
  if (!apiKeyRaw) return undefined

  let decryptedKey: string
  try {
    decryptedKey = decryptZCodeEncryptedKey(apiKeyRaw, { desktopPath })
  } catch {
    return undefined
  }

  // 计划以**客户端的选择**为准，而不是"哪一把 key 被选中"：账号计划
  // （start-plan / off-peak）在凭据里根本没有对应的 api-key 条目，accessToken
  // 只能回落到账户上的 coding-plan key——那只说明"用哪把 key 发请求"，不说明
  // 账号属于哪个计划。两者用途不同（前者发请求，后者标识账号/展示）。
  const plan = selection?.plan ?? picked?.plan
  // Start Plan 专属通道的凭据材料，与计划解耦提取：文档里有 zcodejwttoken
  // 就带上（解不开只影响该通道，普通通道不受影响），通道是否用它由
  // zcodePlan（生效计划）决定。
  let zcodeJwtToken: string | undefined
  const rawJwt = data['zcodejwttoken']
  if (typeof rawJwt === 'string' && rawJwt !== '') {
    try {
      const decryptedJwt = decryptZCodeEncryptedKey(rawJwt, { desktopPath })
      if (decryptedJwt !== '') zcodeJwtToken = decryptedJwt
    } catch {
      // 解不开就缺省
    }
  }
  return {
    accessToken: decryptedKey,
    refreshToken: '',
    expiresAtMs: Date.parse('2099-12-31T23:59:59.000Z'),
    domain: 'bigmodel.cn',
    uid,
    nickname: 'ZCode User',
    source: 'desktop',
    ...plan === undefined ? {} : { zcodePlan: plan },
    ...zcodeJwtToken === undefined ? {} : { zcodeJwtToken },
    zcodeDeviceMid: resolveZCodeDeviceMid(desktopPath),
  }
}

// enc:v1 解密已搬到 auth-zcode-crypto.ts：在这里再导出，既有导入路径不变。
export { decryptZCodeEncryptedKey } from './auth-zcode-crypto.js'
export type { DecryptZCodeKeyOptions } from './auth-zcode-crypto.js'
