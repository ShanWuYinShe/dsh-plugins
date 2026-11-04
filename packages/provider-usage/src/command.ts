/**
 * command.ts — /usage 斜杠命令:在会话里直接读额度文本。
 *
 * 宿主不知道会话当前选了哪个 provider(route.ts:2-9 的同款约束:选择在
 * client),所以命令回答「全部可查 provider」或显式点名的一个,而不是猜测
 * 当前会话。查询走 registry.snapshot 的既有缓存/负缓存/在途合并,顺序执行
 * (billing 端点不接受一页并发二十发,route.ts:136-138 同口径)。
 *
 * @module provider-usage/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { normalizeProviderKey } from './resolve.js'
import type { ProviderUsageRegistry } from './registry.js'
import { resolveUsageLabel, type UsageSnapshot, type UsageWindow } from './types.js'

/**
 * `/usage` 默认读取的总预算（毫秒）。
 *
 * 命令是聊天里的一次同步交互：默认路径只读缓存/负缓存，未命中时才发起上游
 * 查询；预算把这批顺序查询的**总**耗时封顶，避免 11 条账单端点各挂 15s 把
 * 一次命令拖成分钟级。
 */
export const DEFAULT_COMMAND_BUDGET_MS = 20_000

/**
 * `/usage refresh` 的总预算（毫秒）。
 *
 * 显式刷新会绕过缓存、逐条真打上游（11 条账单请求），因此给比默认更长的
 * 预算，但仍有上界：命令必须一次性回答，不能让用户等满「条数 × 单查询
 * deadline」。
 */
export const DEFAULT_REFRESH_COMMAND_BUDGET_MS = 60_000

/** {@link usageCommand} 的可选预算覆盖（测试注入短预算用）。 */
export interface UsageCommandOptions {
  /** 默认（缓存读）路径的总预算。 */
  budgetMs?: number
  /** refresh 路径的总预算。 */
  refreshBudgetMs?: number
}

/**
 * 一行窗口文本:"label 余量 单位"。
 *
 * remain 在契约里可选（余额型窗口只有上限、订阅有效性窗口只有标签），直接插值
 * 会输出 "undefined"；缺余量时用 "—" 占位。unit 也可能是空串（没有计量单位的
 * 有效性窗口），此时不留尾随空格。
 */
function formatWindow(window: UsageWindow): string {
  const remaining = window.remain === undefined ? '—' : `${window.remain}`
  // 命令是单一语言文本（英语基线）：本地化 label 一律取 en，与 client 按
  // DSH 当前语言解析互不冲突。
  const label = resolveUsageLabel(window.label, 'en')
  // unit 与 label 同一套本地化契约；命令只出英语基线，空单位不留尾随空格。
  const unit = resolveUsageLabel(window.unit, 'en')
  return unit === '' ? `${label} ${remaining}` : `${label} ${remaining} ${unit}`
}

/** 一行额度文本:displayName(registry 把注册期 displayName 回填进答案，缺省回 provider 键)+ 逐窗口 "label remain unit"。 */
export function formatUsageLine(snapshot: UsageSnapshot): string {
  const name = snapshot.displayName ?? snapshot.provider
  if (snapshot.error !== undefined) return `${name}: error — ${snapshot.error}`
  if (snapshot.windows.length === 0) return `${name}: the provider reported no usable balance`
  return `${name}: ${snapshot.windows.map(formatWindow).join(', ')}`
}

/** 整份报告:每 provider 一行,顺序与查询顺序一致。 */
export function formatUsageReport(lines: readonly string[]): string {
  return lines.join('\n')
}

/**
 * /usage 的 handler 工厂。registry 只依赖 snapshot/providers 两个成员,
 * 测试可传极简 stub。
 *
 * 参数(rawInput,trim + 小写后):
 * - 空 → 全部已注册 provider(缓存读,60s TTL);
 * - `refresh` → 全部已注册 provider,绕过缓存(显式刷新,预算更长);
 * - 其它 → 视作 provider 键(经 normalizeProviderKey 规范化),未注册键
 *   交给 snapshot() 的推断路径回答,推断无果即为不可查行。
 *
 * 两个路径都受**总预算**约束（{@link DEFAULT_COMMAND_BUDGET_MS} /
 * {@link DEFAULT_REFRESH_COMMAND_BUDGET_MS}）：预算到点时在途读取折叠成失败
 * 快照，命令仍然在有限时间内给出逐 provider 的完整报告。
 *
 * @param registry - provider-usage 注册表（只用到 providers/snapshot）。
 * @param options - 预算覆盖（测试注入短预算）。
 * @returns 命令定义。
 */
export function usageCommand(registry: ProviderUsageRegistry, options: UsageCommandOptions = {}): CommandDefinition {
  const budgetMs = options.budgetMs ?? DEFAULT_COMMAND_BUDGET_MS
  const refreshBudgetMs = options.refreshBudgetMs ?? DEFAULT_REFRESH_COMMAND_BUDGET_MS
  return {
    name: 'usage',
    description: 'Show remaining quota for the queryable LLM providers ("/usage refresh" to bypass the cache)',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const input = invocation.rawInput.trim().toLowerCase()
      const force = input === 'refresh'
      const providers = input === '' || force ? registry.providers() : [normalizeProviderKey(input)]
      if (providers.length === 0) return { kind: 'success', text: 'no queryable provider is registered' }
      // 总预算：一次命令内所有顺序查询共享同一个 deadline 信号。
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort(new Error(`usage command exceeded its ${force ? refreshBudgetMs : budgetMs}ms budget`))
      }, force ? refreshBudgetMs : budgetMs)
      timer.unref?.()
      try {
        const lines: string[] = []
        for (const provider of providers) {
          const snapshot = await registry.snapshot(provider, { force, signal: controller.signal })
          lines.push(snapshot === undefined ? `${provider}: (no querier resolved)` : formatUsageLine(snapshot))
        }
        return { kind: 'success', text: formatUsageReport(lines) }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * 把命令挂到可选的 commands 服务上:极简 profile 缺 commands 时整段跳过,
 * pill 不受影响(index.ts 对 webServer 的同款姿态)。
 */
export function registerUsageCommand(ctx: Context, registry: ProviderUsageRegistry): void {
  ctx.inject(['commands'], commandsCtx => {
    commandsCtx.effect(() => commandsCtx.commands.register(usageCommand(registry)), 'provider-usage: /usage command')
  })
}
