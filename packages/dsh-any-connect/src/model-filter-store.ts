/**
 * model-filter-store.ts — 持久化模型黑名单/排除列表（每个变体独立）。
 *
 * 允许用户在插件设置页中删除/排除不需要的模型，并支持一键恢复默认。
 * 排除的 ID 列表持久化在 <DSH_HOME>/cache/dsh-any-connect/<variant>-excluded-models.json。
 *
 * @module dsh-any-connect/model-filter-store
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import { CACHE_DIRNAME } from './catalog-store.js'

export interface ModelFilterStoreOptions {
  path?: string
}

export class ModelFilterStore {
  private readonly path: string
  private excluded = new Set<string>()

  constructor(variantId: string, options: ModelFilterStoreOptions = {}) {
    this.path = options.path ?? dshCachePath(CACHE_DIRNAME, `${variantId}-excluded-models.json`)
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw) as { excluded?: unknown }
      if (Array.isArray(parsed?.excluded)) {
        this.excluded = new Set(
          parsed.excluded.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim()),
        )
      }
    } catch {
      this.excluded = new Set()
    }
  }

  getExcluded(): readonly string[] {
    return Array.from(this.excluded)
  }

  isExcluded(modelId: string): boolean {
    return this.excluded.has(modelId.trim())
  }

  async exclude(modelId: string): Promise<void> {
    const trimmed = modelId.trim()
    if (trimmed === '') return
    this.excluded.add(trimmed)
    await this.save()
  }

  /**
   * 恢复单个模型。
   *
   * 与 {@link restore} 的差别不是便利性，是**误伤范围**：一键恢复会把用户
   * 之前刻意隐藏的模型全部放回列表，想保持原样就得再逐个隐藏一遍。用户报告
   * 的正是这个场景，所以单条恢复是主路径，全量恢复只作为「清空重来」的出口。
   *
   * @param modelId - 要恢复的模型 id。
   * @returns 该模型此前是否确实处于隐藏状态（false 表示本来就没隐藏）。
   */
  async restoreOne(modelId: string): Promise<boolean> {
    const trimmed = modelId.trim()
    if (trimmed === '') return false
    if (!this.excluded.delete(trimmed)) return false
    await this.save()
    return true
  }

  /**
   * 恢复全部隐藏模型。
   *
   * @returns 恢复前处于隐藏状态的模型 id（供调用方回报影响范围）。
   */
  async restore(): Promise<readonly string[]> {
    const restored = Array.from(this.excluded)
    this.excluded.clear()
    await this.save()
    return restored
  }

  private async save(): Promise<void> {
    try {
      const dir = dirname(this.path)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const data = JSON.stringify({ version: 1, excluded: Array.from(this.excluded) }, null, 2)
      await writeFileAtomic(this.path, data, { mode: 0o600 })
    } catch {
      // 容错：写盘失败不阻塞内存状态
    }
  }
}
