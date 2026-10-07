/**
 * The last catalog that actually loaded, kept per account.
 *
 * Ported from corrinehu/dsh-workbuddy-connect `src/catalog-store.ts` (MIT):
 * without it a restart always drops the user to the built-in roster even when
 * a good catalog was fetched minutes earlier. The built-in roster is a
 * snapshot taken once; a fetched catalog is what the upstream actually serves
 * to this account.
 *
 * What this deliberately is *not*:
 *
 * - not a cache with a freshness policy — it never prevents a fetch, it only
 *   answers when a fetch cannot;
 * - not shared across accounts (a different account can see a different roster
 *   and different promotions);
 * - not a place for secrets: model metadata only, never a token. The account
 *   key is a `uid:enterpriseId` identity already visible in the status document.
 *
 * @module dsh-any-connect/catalog-store
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyCredential } from './auth.js'
import type { WorkBuddyUpstreamModel } from './upstream.js'

/** On-disk format this reader accepts; other versions are discarded. */
const CATALOG_FORMAT_VERSION = 1

/** Basename of the CN saved catalog inside the Harness home. */
export const WORKBUDDY_CATALOG_FILENAME = '.workbuddy-catalog.json'

/** Basename of the international saved catalog inside the Harness home. */
export const WORKBUDDY_AI_CATALOG_FILENAME = '.workbuddy-ai-catalog.json'

/** One saved catalog: the account it belonged to, and the models it listed. */
export interface SavedWorkBuddyCatalog {
  /** `uid:enterpriseId` the catalog was fetched for. */
  account: string
  /** Which document answered (the chat base URL), so a roster fetched from one
   * endpoint is never served as another's. */
  source: string
  /** When the fetch succeeded, epoch milliseconds. */
  fetchedAtMs: number
  models: readonly WorkBuddyUpstreamModel[]
}

interface CatalogDocument {
  version: typeof CATALOG_FORMAT_VERSION
  entries: Record<string, SavedWorkBuddyCatalog>
}

/** Plugin-owned saved-catalog path inside the Harness home. */
export function workbuddyCatalogPath(filename: string = WORKBUDDY_CATALOG_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/** Account identity keying one saved catalog. */
export function credentialIdentity(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string {
  return `${credential.uid}:${credential.enterpriseId ?? ''}`
}

/** Whether a parsed value is a model row worth keeping. */
function isModel(value: unknown): value is WorkBuddyUpstreamModel {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string' && row['id'] !== ''
    && typeof row['name'] === 'string'
    && typeof row['contextWindow'] === 'number' && Number.isFinite(row['contextWindow'])
    && typeof row['maxTokens'] === 'number' && Number.isFinite(row['maxTokens'])
    && typeof row['supportsImages'] === 'boolean'
}

/** Whether a parsed value is a saved catalog this reader can trust. */
function isSaved(value: unknown): value is SavedWorkBuddyCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry['account'] !== 'string' || entry['account'] === '') return false
  if (typeof entry['source'] !== 'string' || entry['source'] === '') return false
  if (typeof entry['fetchedAtMs'] !== 'number' || !Number.isFinite(entry['fetchedAtMs'])) return false
  const models = entry['models']
  if (!Array.isArray(models) || models.length === 0) return false
  return models.every(isModel)
}

/** Constructor dependencies; the path is injectable so tests never touch the real home. */
export interface WorkBuddyCatalogStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string
}

/**
 * The last successful catalog per account, read once and written atomically.
 *
 * Malformed content reads as "nothing saved" rather than throwing: this file
 * is an optimization for the offline and first-seconds cases, and a corrupt one
 * must never be able to stop the plugin from starting.
 */
export class WorkBuddyCatalogStore {
  private readonly path: string
  private entries: Record<string, SavedWorkBuddyCatalog>

  constructor(options: WorkBuddyCatalogStoreOptions = {}) {
    this.path = options.path ?? workbuddyCatalogPath()
    this.entries = loadDocument(this.path)
  }

  /** The saved catalog for one account, or undefined when none was kept. */
  saved(account: string): SavedWorkBuddyCatalog | undefined {
    return this.entries[account]
  }

  /** Remember one account's catalog; failures degrade to not remembering. */
  async save(entry: SavedWorkBuddyCatalog): Promise<void> {
    this.entries = { ...this.entries, [entry.account]: entry }
    try {
      // Parents first: the lock file cannot be created inside a directory
      // that does not exist yet (a fresh DSH_HOME), and the lock helper
      // does not create them.
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      await withFileLock(this.path, async () => {
        // 锁内重读已提交状态再合并:withFileLock 的契约是「锁内执行
        // read-render-commit 周期,后获锁者重读」,直接写内存快照会让跨
        // 进程共享同一 DSH_HOME 的后写者用旧快照抹掉前写者刚保存的账号
        // 目录——锁防写坏,不防丢更新。内存侧条目(刚保存的)在同 account
        // 冲突时胜出,合并结果同步回内存缓存。
        const committed = loadDocument(this.path)
        this.entries = { ...committed, ...this.entries }
        await writeFileAtomic(
          this.path,
          `${JSON.stringify({ version: CATALOG_FORMAT_VERSION, entries: this.entries }, null, 2)}\n`,
          { mode: 0o600 },
        )
      })
    } catch {
      // A state file that cannot be written must not take the plugin down: the
      // worst case is that the observation is not remembered.
    }
  }
}

/** Read and validate the on-disk document; anything unexpected is "nothing saved". */
function loadDocument(path: string): Record<string, SavedWorkBuddyCatalog> {
  let parsed: unknown
  try {
    if (!existsSync(path)) return {}
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const document = parsed as Record<string, unknown>
  if (document['version'] !== CATALOG_FORMAT_VERSION) return {}
  const entries = document['entries']
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return {}
  const kept: Record<string, SavedWorkBuddyCatalog> = {}
  for (const [account, entry] of Object.entries(entries as Record<string, unknown>)) {
    if (isSaved(entry)) kept[account] = entry
  }
  return kept
}
