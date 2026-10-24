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
import type { UsageSnapshot } from './types.js'

/** snapshot 实际形状:registry 把注册期 displayName 回填进答案(route.test.ts:47 同款)。 */
type SnapshotAnswer = UsageSnapshot & { displayName?: string }

/** 一行额度文本:displayName(缺省回 provider 键)+ 逐窗口 "label remain unit"。 */
export function formatUsageLine(snapshot: SnapshotAnswer): string {
  const name = snapshot.displayName ?? snapshot.provider
  if (snapshot.error !== undefined) return `${name}: error — ${snapshot.error}`
  if (snapshot.windows.length === 0) return `${name}: the provider reported no usable balance`
  const windows = snapshot.windows.map((w) => `${w.label} ${w.remain} ${w.unit}`).join(', ')
  return `${name}: ${windows}`
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
 * - `refresh` → 全部已注册 provider,绕过缓存(显式刷新);
 * - 其它 → 视作 provider 键(经 normalizeProviderKey 规范化),未注册键
 *   交给 snapshot() 的推断路径回答,推断无果即为不可查行。
 */
export function usageCommand(registry: ProviderUsageRegistry): CommandDefinition {
  return {
    name: 'usage',
    description: 'Show remaining quota for the queryable LLM providers ("/usage refresh" to bypass the cache)',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const input = invocation.rawInput.trim().toLowerCase()
      const force = input === 'refresh'
      const providers = input === '' || force ? registry.providers() : [normalizeProviderKey(input)]
      if (providers.length === 0) return { kind: 'success', text: 'no queryable provider is registered' }
      const lines: string[] = []
      for (const provider of providers) {
        const snapshot = await registry.snapshot(provider, { force })
        lines.push(snapshot === undefined ? `${provider}: (no querier resolved)` : formatUsageLine(snapshot as SnapshotAnswer))
      }
      return { kind: 'success', text: formatUsageReport(lines) }
    },
  }
}

/**
 * 把命令挂到可选的 commands 服务上:极简 profile 缺 commands 时整段跳过,
 * pill 不受影响(index.ts 对 webServer 的同款姿态)。
 */
export function registerUsageCommand(ctx: Context, registry: ProviderUsageRegistry): void {
  ctx.inject(['commands'], (commandsCtx: any) => {
    commandsCtx.effect(() => commandsCtx.commands.register(usageCommand(registry)), 'provider-usage: /usage command')
  })
}
