/**
 * resource-provider.ts — usage 的 resource 订阅面(protocol 'provider-usage')。
 *
 * 宿主 0.2.1-rc.3 的 dsh-client-resources 把「URL 地址 → live 值」统一成
 * client 侧订阅:provider.open 首帧给当前值、之后每帧一个变更,最后一个
 * 订阅者释放时 signal abort、流必须结束。把 hook 里手写的 60s 轮询搬进
 * 这里,组件只剩 useResource(address) 消费;同地址多订阅者由 registry
 * 去重(单流单定时器)。
 *
 * 数据通道仍是既有同源 route(fetchSnapshot)——resource 模型不改变取数
 * 语义,只改变「谁来轮询、谁被多个视图共享」。手动刷新(force)会更新宿主
 * registry 的缓存,流的下一帧(≤60s)自然带上强刷后的值。
 *
 * @module provider-usage/resource-provider
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ResourceProvider, Resources } from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { fetchSnapshot, type SnapshotAnswer } from './fetch-snapshot.js'
import type { UsageSnapshot } from '../src/types.js'

/** 本插件独占的 resource 协议键(dsh-resource:// 的 host 段)。 */
export const USAGE_RESOURCE_PROTOCOL = 'provider-usage'

/** 逐 provider 地址;provider 键经 encodeURIComponent 进 path 段。 */
export function usageResourceAddress(provider: string): string {
  return `dsh-resource://${USAGE_RESOURCE_PROTOCOL}/${encodeURIComponent(provider)}`
}

/** 从地址还原 provider 键;非本协议地址返回 undefined。 */
export function providerOfAddress(address: string): string | undefined {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.host !== USAGE_RESOURCE_PROTOCOL) return undefined
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  return name === '' ? undefined : name
}

/** 与 hook 轮询同节奏:宿主缓存也是 60s 量级,双重节流意义不大,单一来源即可。 */
export const RESOURCE_POLL_INTERVAL_MS = 60_000

/** abort 可打断的 sleep;abort 后 resolve,由调用方检查后退出。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * 一条地址的 live 流:首帧立即,之后每 RESOURCE_POLL_INTERVAL_MS 取一次,
 * 序列化结果有变化才推帧(fetchSnapshot 每次带新 fetchedAt,值变检测按
 * 业务内容比较,避免恒推)。错误不产 failure 帧(RemoteFailure 构造需要
 * 宿主错误码表),折叠成带 error 字段的 UsageSnapshot——pill 的失败渲染
 * 走既有 error 路径。
 */
export async function* usageStream(address: string, signal: AbortSignal, intervalMs: number = RESOURCE_POLL_INTERVAL_MS): AsyncGenerator<RemoteResult<SnapshotAnswer>> {
  const provider = providerOfAddress(address)
  if (provider === undefined) return
  let last: string | undefined
  while (!signal.aborted) {
    try {
      const answer = await fetchSnapshot(provider, signal)
      if (signal.aborted) return
      if (answer !== undefined) {
        const serialized = JSON.stringify(answer)
        if (serialized !== last) {
          last = serialized
          yield { ok: true, value: answer }
        }
      }
    } catch (error: unknown) {
      if (signal.aborted) return
      const failed: UsageSnapshot = {
        provider,
        windows: [],
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }
      const serialized = JSON.stringify(failed)
      if (serialized !== last) {
        last = serialized
        yield { ok: true, value: failed }
      }
    }
    await sleep(intervalMs, signal)
  }
}

/**
 * 在浏览器插件上下文注册本协议的 provider。resources 是可选服务(GUI 装配,
 * 独立 dsh-web 部署可能没有):探测不到就跳过,pill 回退 hook 内的轮询。
 *
 * @returns 反注册器;未注册时是 no-op。
 */
export function registerProviderUsageResources(ctx: ClientContext): () => void {
  let resources: Resources | undefined
  try {
    resources = (ctx as unknown as { get(name: string): unknown }).get('resources') as Resources | undefined
  } catch {
    return () => {}
  }
  if (resources === undefined || typeof resources.register !== 'function') return () => {}
  const provider: ResourceProvider<'provider-usage'> = {
    protocol: USAGE_RESOURCE_PROTOCOL,
    open: (address, openContext) => usageStream(address, openContext.signal),
  }
  return resources.register(provider)
}
