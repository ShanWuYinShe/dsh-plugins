/**
 * auth-document.ts — WorkBuddy 凭据文档解析（桌面端与插件自有格式）。
 *
 * 2026-10-08 从 1160 行的 auth.ts 拆出：类型、路径解析、ZCode 解析、文档解析与
 * 存储类原本在一个文件里。auth.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/auth-document
 */

import type { WorkBuddyCredential } from './auth-types.js'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  credential: WorkBuddyCredential
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
  return credential
}

/** Serialize the plugin-owned copy. */
export function ownDocument(credential: WorkBuddyCredential): OwnDocument {
  return { version: OWN_FORMAT_VERSION, credential }
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
export function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  const raw = document['credential'] as Record<string, unknown>
  // parseWorkBuddyAuth 认桌面文件的 expiresAt/refreshExpiresAt 拼写,而自有
  // 副本直接序列化 WorkBuddyCredential(字段名带 Ms 后缀)——这一不对称曾让
  // 副本每次读回 expiresAtMs=0,needsRefresh 恒真,每条请求都打一次刷新
  // 端点。序列化前补上桌面拼写别名,存量副本(只带 Ms 字段)同样解析。
  const authLike = 'expiresAt' in raw ? raw : {
    ...raw,
    'expiresAt': raw['expiresAtMs'],
    ...'refreshExpiresAtMs' in raw ? { 'refreshExpiresAt': raw['refreshExpiresAtMs'] } : {},
  }
  // 自有副本把 WorkBuddyCredential 平铺序列化,身份字段(uid / enterpriseId /
  // nickname)与 auth 字段同层;而 parseWorkBuddyAuth 只从 account 段读身份,
  // 因此这一层包装必须同时充当 auth 与 account——否则副本读回后 uid 恒为空串,
  // 上游请求退化成 X-No-User-Id,目录归属键变成 ":"(账号身份丢失)。
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: authLike, account: authLike }))
  if (credential === undefined) return undefined
  return { ...credential, source: 'dsh' }
}

/** Whether a filesystem error reports an absent path. */
export function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
