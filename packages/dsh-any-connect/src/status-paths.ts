/** Node-free constants and types shared by the Host and browser halves. */

/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-any-connect/status'

/**
 * The international (WorkBuddy AI) variant's own status route.
 *
 * A separate constant rather than a computed suffix so both halves reference
 * literal strings: the browser bundle and the host bundle are built
 * independently, and a shared expression is one build-config drift away from
 * the card asking a route the host never mounted.
 */
export const WORKBUDDY_AI_STATUS_PATH = '/plugins/dsh-any-connect/ai/status'

export const WORKBUDDY_PROBE_PATH = '/plugins/dsh-any-connect/probe'

/** Plugin-owned probe control endpoint (international variant). */
export const WORKBUDDY_AI_PROBE_PATH = '/plugins/dsh-any-connect/ai/probe'

/** ZCode variant status route. */
export const ZCODE_STATUS_PATH = '/plugins/dsh-any-connect/zcode/status'

/** ZCode variant probe route. */
export const ZCODE_PROBE_PATH = '/plugins/dsh-any-connect/zcode/probe'

/** ZCode Start Plan variant status route. */
export const ZCODE_SP_STATUS_PATH = '/plugins/dsh-any-connect/zcode-sp/status'

/** ZCode Start Plan variant probe route. */
export const ZCODE_SP_PROBE_PATH = '/plugins/dsh-any-connect/zcode-sp/probe'

/** One model's recorded probe observation, as the card displays it. */
export interface WorkBuddyWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface WorkBuddyWebProbeSection {
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Recorded observations. */
  results: readonly WorkBuddyWebProbeModel[]
}

/** Action requested from the probe control route. */
export interface WorkBuddyProbeAction {
  /**
   * `refresh` re-reads the credential and re-fetches the model catalog.
   * Detection itself is automatic (every catalog refresh sweeps the missing
   * candidates), so this is the route's only action — still a write that
   * spends a request against the upstream, which is why it keeps this route's
   * in-process key and loopback guards rather than the read-only status GET.
   */
  action: 'refresh'
}

/**
 * One served model, as the card's unified model list renders it: one row
 * carrying every per-model fact the card shows — display name, working
 * context window, billing convenience facts, declared effort levels, and the
 * larger selectable windows. (Detection results stay in the probe section:
 * they carry their own validation/probed-at metadata.)
 */
export interface WorkBuddyWebModelRow {
  id: string
  name: string
  /**
   * Working budget in tokens: the window the plugin actually requests under
   * (the international document's `contextWindow.defaultLength` where
   * declared, else the row's input ceiling).
   */
  contextWindow: number
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /**
   * Credits multiplier in display form, e.g. `x0.79`. Unlike the model
   * picker's copy, the card renders through the browser locale, so this value
   * may be interpolated into a localized sentence rather than shown bare.
   */
  credits?: string
  /**
   * The rate cannot be stated right now, and the card must say so.
   *
   * Set for a row whose price came from a promotion that has since ended: the
   * upstream bakes the discounted value into the cached row, and the original
   * price is not recoverable from it, so neither the old figure nor `free` may
   * be repeated. The card renders "refresh to see the price" instead.
   */
  rateUnknown?: true
  /**
   * Upstream-declared effort levels, exactly as the catalog row declares them.
   * Absent means the row declares no explicit set — the probe section's
   * detection results (if any) then say what the upstream actually accepts.
   */
  efforts?: readonly string[]
  /**
   * Selectable larger windows the upstream declares, excluding the working
   * budget itself. Reported, never chosen: offering the ceiling as though it
   * were the working window would overstate the budget (the desktop app's
   * window picker is client-side policy that appears nowhere in the catalog).
   */
  largerWindows: readonly number[]
}

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  /**
   * The upstream plan this package belongs to, when it names one.
   *
   * Account plans (ZCode Start Plan) report an activity name that changes over
   * time, while a coding-plan subscription reports the product name; the card
   * shows whichever the upstream actually returned instead of a fixed label.
   */
  planName?: string
  remain: number
  size: number
  expiredAt?: string
  /**
   * The pool is granted for one day and does not carry over — the card says so
   * instead of letting a daily reset read as an accumulating balance.
   */
  sameDay?: true
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
}

/**
 * Where the models a card is currently showing came from.
 *
 * The card must distinguish a live catalog from the built-in fallback, and
 * say when the last attempt failed — otherwise a stale list is
 * indistinguishable from an offline one, and a user cannot tell whether the
 * models they see still match the upstream.
 */
export interface WorkBuddyWebCatalog {
  /**
   * Where the models on screen came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch,
   * restored after a restart or a failed fetch) → `fallback` (the roster
   * compiled into the plugin). The card distinguishes them because "stale"
   * and "offline with a saved list" are different situations for the user.
   *
   * `live` 且 `fetchedAt` 很新**并不等于「一切正常」**：Start Plan 今日未领取时
   * 上游查询成功却返回空名单，那也是一次新鲜的 `live`。这种情况由
   * {@link WorkBuddyWebCatalog.empty} 显式标出，见下。
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch milliseconds. */
  fetchedAt?: number
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
  /**
   * 这次拉取**明确成功，但上游一个模型都没给**。
   *
   * 没有这个字段时，空名单在卡片上和「插件坏了」长得一模一样：source=live、
   * fetchedAt 就是刚才，却列出 0 个模型——用户填好了凭据、看着「刚刚拉取成功」，
   * 却一个模型都没有，无从判断该等、该重试、还是该去领取。
   *
   * 标出来之后卡片能说人话：这是**上游如实回答「目前没有可用模型」**，不是故障。
   * 对 Start Plan 那正是「今日活动未领取/已过期」——卡片再据 `startPlanClaim`
   * 给出下一步（去客户端领一次，见 claim 提示块）。
   *
   * 与 `error` 互斥：有 error 就是**没拉到**（保留上一份名单），不是「拉到了空的」。
   */
  empty?: true
}

/** The JSON document the plugin card renders. */
export type WorkBuddyWebStatus =
  | {
    status: 'signed-out'
    /**
     * Why no credential is usable, when that is diagnosable rather than simply
     * "nobody signed in" — today a credential belonging to the other product.
     * The card renders it in place of the generic sign-in hint.
     */
    reason?: string
  }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    /** Every served model, one row each — the card's unified model list. */
    models?: readonly WorkBuddyWebModelRow[]
    /** Where those models came from, and whether the last fetch failed. */
    catalog?: WorkBuddyWebCatalog
    /** Reasoning-effort probe state and recorded observations. */
    probe?: WorkBuddyWebProbeSection
    /**
     * In-process key authorizing probe control writes. Handed to the card with
     * the status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    probeKey?: string
    /**
     * 今日 Start Plan 待领取提示。**只有 Start Plan 变体会带这个字段**，其余
     * 变体整个字段不出现——卡片据此区分"不该有这回事"与"探测没成功"。
     */
    startPlanClaim?: WorkBuddyWebStartPlanClaim
  }
  | { status: 'error'; message: string }

/**
 * 今日 Start Plan 领取提示（`startPlanClaim` 字段的形状）。
 *
 * **`unknown` 与 `none` 必须分开**：探测没成功（网络失败/上游报错/超时/凭据
 * 不可读）时报 `unknown`，绝不能塌成 `none`——那会让用户读到"今天没得领"
 * 并放弃一次本可以完成的领取。
 *
 * `captchaRequired` 是**常态**而非错误：ZCode 的领取必须过一次阿里云验证码，
 * 而该 token 由客户端渲染进程 `window.AliyunCaptcha` 签发、与浏览器指纹绑定，
 * 纯 Node 侧无法生成（实测无码一律 `HTTP 400 code 3007`）。所以插件能自动
 * 做的只有"探测到今天有可领项并如实告知"，领取需要用户在 ZCode 客户端点一次。
 */
export interface WorkBuddyWebStartPlanClaim {
  state: 'available' | 'none' | 'unknown'
  /** 可领取项的 plan_id（state 为 available 时）。 */
  planId?: string
  /** 可领取项的展示名（state 为 available 时）。 */
  planName?: string
  /** 需要用户去客户端完成一次验证码验证才能领取；available 时恒为 true。 */
  captchaRequired?: true
  /** state 为 unknown 时的可读原因（已脱敏）。 */
  reason?: string
}
