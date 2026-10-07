/**
 * variant-wiring.ts — 变体的上游客户端与凭据存储装配（CLI 与插件运行时共用）。
 *
 * 为什么单独成模块：装配规则里带着**计划语义**——zcode 变体的
 * \`transformCredential\` 把自己的计划固定进读出的凭据（两个 zcode 变体共享同一份
 * 桌面凭据文档，模型路由 / 额度来源 / 夜免资格都只看 \`credential.zcodePlan\`）。
 * CLI 曾漏掉这一步，把 zcode-start-plan 的额度查询指到了 coding 池子（2026-10 实测）。
 * 两边共用一份装配后这类漂移在结构上不可能再发生。
 *
 * 两条锁：\`test/variant-wiring.test.ts\` 断言计划语义（按变体固定成 start-plan /
 * coding-plan），并断言 src/ 里**只有本模块**构造凭据存储——想绕开装配就得先改测试。
 *
 * @module dsh-any-connect/variant-wiring
 */

import { WorkBuddyCredentialStore } from './auth.js'
import type { WorkBuddyCredential } from './auth.js'
import { WorkBuddyUpstreamClient, ZCodeUpstreamClient } from './upstream.js'
import type { WorkBuddyUpstreamModel } from './upstream.js'
import type { WorkBuddyVariant } from './variants.js'
import { applyZCodePlanOverride } from './zcode-plan-store.js'

/** 该变体对应的上游客户端：zcode 走专属通道，其余走 WorkBuddy。 */
export function upstreamClientFor(
  variant: WorkBuddyVariant,
  options: { models?: readonly WorkBuddyUpstreamModel[] } = {},
): WorkBuddyUpstreamClient | ZCodeUpstreamClient {
  if (variant.kind !== 'zcode') return new WorkBuddyUpstreamClient()
  return new ZCodeUpstreamClient(options.models === undefined ? {} : { models: options.models })
}

/**
 * zcode 变体的计划语义 transform；非 zcode 变体没有这回事，返回 undefined。
 *
 * 返回的函数把该变体自己的计划固定进凭据：Start Plan 变体恒为 \`start-plan\`，
 * Coding Plan 变体恒为 \`coding-plan\`——与桌面 setting.json 里选了什么无关。
 */
export function zcodePlanTransformFor(
  variant: WorkBuddyVariant,
): ((credential: WorkBuddyCredential) => WorkBuddyCredential) | undefined {
  if (variant.kind !== 'zcode') return undefined
  const plan = variant.zcodePlanMode === 'start' ? 'start-plan' : 'coding-plan'
  return credential => applyZCodePlanOverride(credential, plan)
}

/**
 * 按变体规则装配凭据存储：刷新走该变体的客户端，zcode 变体额外固定计划语义。
 *
 * @param options.client - 该变体的上游客户端（见 {@link upstreamClientFor}）。
 * @param options.desktopPath - 显式桌面 auth 文件路径；缺省走变体默认与环境变量。
 * @param options.onWarning - 读凭据过程中的非致命告警出口（宿主 logger）。
 */
export function createVariantCredentialStore(options: {
  variant: WorkBuddyVariant
  client: WorkBuddyUpstreamClient | ZCodeUpstreamClient
  desktopPath?: string | undefined
  onWarning?: ((message: string) => void) | undefined
}): WorkBuddyCredentialStore {
  const { variant, client, desktopPath, onWarning } = options
  const transform = zcodePlanTransformFor(variant)
  return new WorkBuddyCredentialStore({
    variant,
    ...desktopPath === undefined ? {} : { desktopPath },
    refresh: credential => client.refreshToken(credential),
    ...onWarning === undefined ? {} : { onWarning },
    ...transform === undefined ? {} : { transformCredential: transform },
  })
}
