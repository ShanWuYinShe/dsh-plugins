/**
 * upstream-shared.ts — 上游协议共享层：常量与跨客户端助手（协议类型见 upstream-types.ts）。
 *
 * 2026-10-08 从 upstream.ts（1765 行）拆出：原文件同时装着两个产品的 wire 实现
 * 与共享协议层。现在按「共享协议层 / WorkBuddy / ZCode」三分，upstream.ts 退化为
 * re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/upstream-shared
 */

import { deadlineSignal } from './timeout.js'
import type { UpstreamErrorKind, WorkBuddyChatResult, WorkBuddyUpstreamModel } from './upstream-types.js'

export const JSON_TIMEOUT_MS = 30_000

export const ERROR_BODY_LIMIT = 4096

/**
 * chat 请求「响应头到达前」的超时：只覆盖上游接受连接却不返回响应头的
 * 挂死窗口。fetch 一返回（头已到）定时器即撤销——SSE 流式阶段的长寿命
 * 不受它约束（流由调用方断开信号与 pi-ai 侧的 idle 超时兜底）；错误体
 * 的读取也在这枚定时器的保护窗口内完成。与各 JSON 端点的超时同值。
 */
export const CHAT_HEADER_TIMEOUT_MS = 30_000

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The host LLM seam carries this text to the browser, and the host has no
 * locale service — whatever string is produced here is shown verbatim in every
 * UI language. The upstream is inconsistent in a way that matters: some catalog
 * rows report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`), and the unit word would pin the display to English.
 * Dropping a trailing `credits` (case-insensitive, singular or plural) yields
 * the one spelling that reads identically in every language.
 *
 * @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
 * @returns the bare multiplier, or undefined when nothing displayable remains.
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === '') return undefined
  // A string that is only the unit word (`credits`) carries no multiplier.
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

/**
 * Whether the current time falls into the Beijing (UTC+8) off-peak night-free window (23:00 - 09:00).
 */
export function isZCodeOffpeak(date: Date = new Date()): boolean {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: 'numeric',
      hour12: false,
    })
    const hour = parseInt(formatter.format(date), 10)
    return hour >= 23 || hour < 9
  } catch {
    const utc = date.getTime() + date.getTimezoneOffset() * 60000
    const beijingHour = new Date(utc + 3600000 * 8).getHours()
    return beijingHour >= 23 || beijingHour < 9
  }
}

/**
 * Layer the currently-effective promotion onto a copy of one model row.
 *
 * Ported from corrinehu/dsh-workbuddy-connect (MIT). Non-destructive: the
 * model's own `credits` and `badges` are the base, and the promotion is
 * layered onto a copy. A model with no live promotion is returned as-is, so
 * the common case allocates nothing.
 *
 * The expired case is the load-bearing one: the upstream bakes the discounted
 * value into `credits` itself (free rows ship `credits: "x0.00"`), so keeping
 * that value after the window would advertise an ended discount — `free: true`
 * being the worst case. The original price is not recoverable from the row,
 * so the honest answer is to stop asserting one (`rateUnknown`).
 */
export function modelWithCurrentPromotion(
  model: WorkBuddyUpstreamModel,
  now = Date.now(),
  variantKind?: 'workbuddy' | 'zcode',
  nightFreeEligible = true,
): WorkBuddyUpstreamModel {
  // Determine if this model belongs to ZCode (either explicitly marked or by ZCode-specific privilege badges)
  const isZCode = variantKind === 'zcode'
    || (variantKind === undefined && (model.billing?.badges?.some(b => b.includes('150% 额度')) ?? false))

  if (isZCode) {
    // 夜间免费是 Coding Plan 的权益：Start Plan 走普通通道、只有 150% 额度，
    // 不享受 23:00–09:00 免费窗。此时既不能标「夜间免费」，也不能把费率改写成
    // x0.00——那会给用户一个它拿不到的折扣。行里自带的夜免徽标一并摘掉，
    // 其余徽标（如 150% 额度）保留。
    if (!nightFreeEligible) {
      return {
        ...model,
        billing: {
          ...model.billing,
          free: false,
          badges: (model.billing?.badges ?? []).filter(b => !b.includes('夜间免费')),
        },
      }
    }
    const hasNightFreeBadge = model.billing?.badges?.some(b => b.includes('夜间免费'))
    if (hasNightFreeBadge) {
      const offpeak = isZCodeOffpeak(new Date(now))
      if (offpeak) {
        return {
          ...model,
          billing: {
            ...model.billing,
            credits: 'x0.00',
            free: true,
            badges: (model.billing?.badges ?? []).map(b => b === '夜间免费' ? '夜间免费 (生效中)' : b),
          },
        }
      } else {
        // Daytime: keep the row's own baseline when it carries one. When it
        // doesn't (missing, or `x0.00` baked in by the night window), the
        // real daytime price is not recoverable — assert `rateUnknown`
        // instead of inventing a hardcoded rate the upstream may have
        // changed (same posture as expired promotions below).
        const daytimeCredits = model.billing?.credits !== undefined && model.billing.credits !== 'x0.00'
          ? model.billing.credits
          : undefined
        return {
          ...model,
          billing: {
            ...model.billing,
            // credits: undefined 显式抹掉行里被夜间窗口烙上的 x0.00——
            // spread 不能覆盖它,留着就会继续向用户展示已失效的免费价。
            ...daytimeCredits === undefined ? { rateUnknown: true as const, credits: undefined } : { credits: daytimeCredits },
            free: false,
            badges: (model.billing?.badges ?? []).map(b => b === '夜间免费 (生效中)' ? '夜间免费' : b),
          },
        }
      }
    }
    // Other ZCode models (e.g. GLM-5.3 x1.00) remain untouched with their own parameters and billing
    return model
  }

  // WorkBuddy variant (CN and Global): never apply ZCode's 23:00~09:00 off-peak rule
  if (model.promotions === undefined || model.promotions.length === 0) return model
  const promotion = [...model.promotions]
    .sort((a, b) => b.priority - a.priority)
    .find(candidate => now >= candidate.start && now < candidate.end)
  if (promotion === undefined) {
    const derivedFromPromotion = model.billing?.free === true
      || (model.billing?.badges?.length ?? 0) > 0
      || model.promotions.some(candidate => candidate.factor !== 1)
    if (!derivedFromPromotion) return model
    return {
      ...model,
      billing: {
        free: false,
        rateUnknown: true,
      },
    }
  }
  const rate = normalizeCredits(model.billing?.credits)
  const original = rate !== undefined && rate.startsWith('x') ? Number(rate.slice(1)) : Number.NaN
  // A replacement to zero is meaningful even when the base rate is unknown (the
  // App document's Auto row carries an empty rate string); any other multiplier
  // needs a number to scale, so it is skipped rather than invented.
  if (promotion.factor !== 0 && !Number.isFinite(original)) return model
  const value = promotion.factor === 0 ? 0 : original * promotion.factor
  return {
    ...model,
    billing: {
      ...model.billing,
      credits: `x${value.toFixed(2)}`,
      free: value === 0,
      badges: [
        ...(model.billing?.badges ?? []),
        ...promotion.label === '' ? [] : [promotion.label],
      ],
    },
  }
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/**
 * chat 请求落定形态：传输失败 / 可读流 / 非 ok 文本三者之一。settled 为 true
 * 时 result 就是最终结果（超时句柄已释放），调用方直接返回；为 false 时调用方
 * 拿 response/text 续写端点专属判定（通用 classify、Start Plan 的 3012/401 分支）。
 */
export type SettledChatFetch =
  | { settled: true; result: WorkBuddyChatResult }
  | { settled: false; response: Response; text: string }

/**
 * chat 类端点的统一传输骨架：头超时 + 调用方取消融合 + 错误体读取 + 超时句柄全路径释放。
 *
 * WorkBuddy / Coding Plan / Start Plan 的 chat 方法曾各持一份一字不差的拷贝（21 行）：
 * 超时/释放/取消分类的口径一旦修了一处而漏了另两处，就是只在某一产品线出现的挂起或
 * 误分类——与 semver 那次“四份手抄漂移”同一病根。抽成单源后改一处即三处。
 *
 * deliver 只管发请求（把给到的 signal 拼进 fetch，header 组装等前置工作在闭包里做）；
 * 非 ok 文本的后续判定是各端点的事——通用 classify 与 Start Plan 的风控分支语义不同，
 * 不宜塞进共享函数。
 */
export async function settleChatFetch(
  signal: AbortSignal | undefined,
  deliver: (fetchSignal: AbortSignal) => Promise<Response>,
): Promise<SettledChatFetch> {
  // 头超时与调用方取消经宿主 deadline 融合：任一触发都中止请求。
  const headersTimeout = await deadlineSignal(signal, CHAT_HEADER_TIMEOUT_MS, 'ANY_CONNECT_HEADERS')
  let response: Response
  try {
    response = await deliver(headersTimeout.signal)
  } catch (error: unknown) {
    // fetch 本身抛错（取消/传输错误/头超时）同样要拆掉定时器：超时回调对已 settled 的
    // controller 是无害 no-op，但定时器会继续挂住事件循环 30s，连续失败的请求会积攒
    // 一堆待触发回调。
    headersTimeout.dispose()
    // 客户端主动断开不是上游故障，按 client 分类回报。
    if (signal?.aborted) {
      return { settled: true, result: { ok: false, status: 0, kind: 'client', message: 'client disconnected before upstream response' } }
    }
    return { settled: true, result: { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` } }
  }
  if (response.ok) {
    headersTimeout.dispose() // 头已到：流式阶段不受头超时约束
    return { settled: true, result: { ok: true, response } }
  }
  let text: string
  try {
    // 错误体读取仍在头超时的保护窗口内：上游发了头却卡住错误体时，定时器中止请求，
    // 这里按 server 分类兜底而非无限挂起。
    text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
  } catch {
    return { settled: true, result: { ok: false, status: response.status, kind: 'server', message: '(error body unavailable)' } }
  } finally {
    headersTimeout.dispose()
  }
  return { settled: false, response, text }
}

/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
export function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    if (wrapped['role'] === 'developer') wrapped['role'] = 'system'
  }
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
export function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

// 协议类型已搬到 upstream-types.ts：在这里再导出，既有导入路径（含门面）全部不变。
export type {
  UpstreamErrorKind,
  WorkBuddyUpstreamModel,
  WorkBuddyModelReasoning,
  WorkBuddyEffort,
  WorkBuddyModelBilling,
  WorkBuddyPromotion,
  WorkBuddyCreditAccount,
  WorkBuddyCredits,
  WorkBuddyRefreshOutcome,
  WorkBuddyChatResult,
} from './upstream-types.js'

/**
 * 错误文案里的状态码渲染。**这一点看着吹毛求疵，但它是用户能不能看到真实原因的分水岭。**
 *
 * 宿主 `dsh-llm-pi-ai` 的 `classifyPiAiError` 用**文本正则**给错误分类：
 * `/\b(?:401|403)\b/.test(message)` 命中即判 `AUTH`，随后 `dsh-client-ui-chat` 在
 * `code === 'AUTH'` 时会**丢弃我们写的 message**，换成固定的本地化文案「API 密钥无效」。
 * 于是上游真实的 403（code 11140 = auth_forbidden，与密钥无关）被显示成「API 密钥无效」，
 * 用户被误导去重新登录/换密钥——本仓为此实测排查了一整轮。
 *
 * 注意 `HTTP-403` **无效**：`-` 是非词字符，`403` 两侧仍构成 `\b`，照样命中（已实测）。
 * 必须紧邻词字符（`_` 或字母），本实现取 `HTTP_403`。
 *
 * 真·鉴权失败（401）同样走这里——鉴权与否由**插件**分类，不该交给宿主用正则猜。
 */
export function httpStatusLabel(status: number): string {
  return `HTTP_${status}`
}
