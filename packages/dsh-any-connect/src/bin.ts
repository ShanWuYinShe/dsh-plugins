#!/usr/bin/env node
/**
 * bin.ts — dsh-any-connect 的独立诊断 CLI（doctor / status / logout）。
 *
 * 与插件本体共用同一份凭据存储与上游客户端，因此 doctor 看到的就是插件运行时
 * 会看到的状态；密钥类输出经 safeMessage 脱敏。
 *
 * @module dsh-any-connect/bin
 */
/** Standalone status/diagnostics CLI for the dsh-any-connect bundle. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCredentialStore, workbuddyOwnAuthPath, WORKBUDDY_AUTH_FILE_ENV } from './auth.js'
import { openStandaloneStateStore } from './state-store.js'
import type { WorkBuddyCreditAccount } from './upstream.js'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, FALLBACK_ZCODE_MODELS } from './catalog.js'
import { FALLBACK_ZCODE_START_PLAN_MODELS } from './zcode-plan-models.js'
import { CN_VARIANT, variantFor, PROVIDER_VARIANTS, WORKBUDDY_VARIANTS, ZCODE_START_PLAN_VARIANT, ZCODE_VARIANT } from './variants.js'
import type { WorkBuddyVariant } from './variants.js'
import { ANYCONNECT_VERSION } from './version.js'
import { currentPlanWindow, startPlanWindows } from './usage.js'
import { summarize } from './credit-ledger.js'
import type { CreditLedgerState } from './credit-ledger.js'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.js'
import { WORKBUDDY_ELECTRON_BIN_ENV } from './desktop-credential-protection.js'
import { createVariantCredentialStore, upstreamClientFor } from './variant-wiring.js'
import { variantIsStartPlan } from './variant-runtime.js'

type Action = 'doctor' | 'logout' | 'status'

const JSON_SCHEMA_VERSION = 1

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-any-connect <doctor|status|logout> [--provider <id>] [--json]',
    '',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  status   sign-in state, remaining WorkBuddy credit, and host-bundle health',
    '  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)',
    '  --provider  which product to inspect: workbuddy, workbuddy-ai, zcode,',
    '              or zcode-start-plan (defaults to workbuddy)',
    '              (defaults to workbuddy)',
    '  --json   emit one secret-free JSON document (doctor/status only)',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** 进程内共享的 standalone 状态域句柄；run() 结束时统一释放（见 closeSharedState）。 */
let sharedStateClose: (() => Promise<void>) | undefined

/**
 * CLI 侧的台账只读（standalone 单元里的 ledger 表）：status 命令展示「今日已用」。
 * 只读不写——宿主进程是唯一的记账者，短命 CLI 写域有跨进程窗口。
 */
let sharedLedgerReader: ((variantId: string) => Promise<CreditLedgerState | undefined>) | undefined

/** Credential store wired for CLI diagnostics. */
async function makeWorkBuddyStore(variant: WorkBuddyVariant): Promise<WorkBuddyCredentialStore> {
  // 与插件运行时同一份装配（见 variant-wiring.ts）：计划语义 / 刷新通道都由它
  // 决定，CLI 不再自己拼一遍——历史上正是这里漏掉 transformCredential，把
  // zcode-start-plan 的额度查询指到了 coding 池子。
  // 状态域独立打开（与插件运行时同一存储单元，见 state-store.ts）：logout 删的
  // 域副本与插件运行时所见一致；域打不开时降级文件回落并告警，诊断照常工作。
  // 句柄进程内只开一份（单命令单次），close 由 run() 的收尾统一调用。
  let state
  try {
    const standalone = await openStandaloneStateStore()
    state = standalone
    sharedStateClose = () => standalone.close()
    sharedLedgerReader = variantId => standalone.readLedger(variantId)
  } catch (error: unknown) {
    console.warn(`dsh-any-connect: state domain unavailable (${String(error)}); owned-copy operations use the file fallback`)
  }
  return createVariantCredentialStore({ variant, client: upstreamClientFor(variant), ...state === undefined ? {} : { state } })
}

/** run() 收尾：释放状态域句柄（幂等；未打开过则空操作）。 */
async function closeSharedState(): Promise<void> {
  const close = sharedStateClose
  sharedStateClose = undefined
  sharedLedgerReader = undefined
  await close?.().catch(() => {})
}

/** Compiled-in roster size per provider id. */
const FALLBACK_COUNT_BY_ID = new Map<string, number>([
  [CN_VARIANT.id, FALLBACK_WORKBUDDY_MODELS.length],
  [WORKBUDDY_VARIANTS[1]!.id, FALLBACK_WORKBUDDY_AI_MODELS.length],
  [ZCODE_VARIANT.id, FALLBACK_ZCODE_MODELS.length],
  [ZCODE_START_PLAN_VARIANT.id, FALLBACK_ZCODE_START_PLAN_MODELS.length],
])

function fallbackFor(variant: WorkBuddyVariant): number {
  return FALLBACK_COUNT_BY_ID.get(variant.id) ?? 0
}

async function doctor(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = await makeWorkBuddyStore(variant)
  const status = await store.status()
  const desktopPresent = await store.desktopFilePresent()
  const desktopPath = await store.resolvedDesktopAuthPath()
  // 关键诊断三者:文件在不在(desktopFilePresent)、是不是 5.6 加密信封
  // (desktopFormat)、以及加密时要去执行哪个二进制取密钥(helper)。凭据
  // 存在却仍未登录,只可能是后两者之一。
  const desktopFormat = await store.desktopAuthFormat()
  const helperPath = store.atRestHelperPath()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-any-connect',
    version: ANYCONNECT_VERSION,
    provider: variant.id,
    node: process.version,
    desktopAuthFile: {
      path: desktopPath ?? store.desktopAuthPath() ?? `(no platform default; set ${variant.env ?? WORKBUDDY_AUTH_FILE_ENV})`,
      present: desktopPresent,
      format: desktopFormat,
    },
    atRestHelper: helperPath ?? `(not configured; set ${variant.electron?.envVar ?? '(no helper for this variant)'})`,
    ownAuthFile: workbuddyOwnAuthPath(variant.ownFilename),
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: status.state,
    ...status.reason === undefined ? {} : { signInReason: status.reason },
    fallbackModels: fallbackFor(variant),
    hints: [
      ...status.state === 'signed-in' ? [] : [`Sign in once in the ${variant.appName} desktop app, then run status again.`],
      ...desktopPresent ? [] : [`No ${variant.appName} desktop auth file at the expected path; set ${variant.env ?? WORKBUDDY_AUTH_FILE_ENV} if it lives elsewhere.`],
      ...desktopFormat !== 'encrypted' || helperPath !== undefined
        ? []
        : [`The desktop credential is encrypted (WorkBuddy 5.6+) and no ${variant.appName} Electron binary was found; set ${variant.electron?.envVar ?? WORKBUDDY_ELECTRON_BIN_ENV} to the app's executable.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `${variant.displayName} Connect ${ANYCONNECT_VERSION} on ${process.version}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} (${report.desktopAuthFile.path})`,
      `Desktop credential format: ${report.desktopAuthFile.format}`,
      `At-rest key helper: ${report.atRestHelper}`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Sign-in state: ${report.signIn}`,
      ...status.reason === undefined ? [] : [`Sign-in reason: ${status.reason}`],
      `Static fallback models: ${report.fallbackModels}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return status.state === 'signed-in' && desktopPresent ? 0 : 1
}

/**
 * One human-readable credit line per provider family: WorkBuddy speaks in
 * credits, while the two ZCode variants speak the same language as the
 * composer-dock pill (per-model token pools for Start Plan, subscription
 * validity for Coding Plan) — printing the raw total would read "1" for a
 * healthy Coding Plan subscription and an unlabelled token count for Start
 * Plan. Start Plan 上游按模型分池且池子互不通用（2026-10-24 实测），每池一行；
 * Coding Plan 维持订阅有效性单行。
 */
function humanCredits(
  variant: WorkBuddyVariant,
  credits: { total: number; error?: string } | undefined,
  accounts: readonly WorkBuddyCreditAccount[] | undefined,
): string {
  if (credits?.error !== undefined) return `Remaining credit: unavailable (${credits.error})`
  if (credits === undefined || accounts === undefined) return 'Remaining credit: unknown'
  if (variant.kind !== 'zcode') return `Remaining credit: ${credits.total}`
  const windows = variantIsStartPlan(variant) ? startPlanWindows(accounts) : currentPlanWindow(accounts)
  if (windows.length === 0) {
    return 'Start Plan quota: no active balance today (claim it in the ZCode client)'
  }
  return windows.map(window => {
    if (window.remain === undefined || window.limit === undefined) return `${window.label}: active`
    const reset = window.resetsAt !== undefined
      ? `, expires ${new Date(window.resetsAt).toLocaleString()}`
      : ''
    return `Start Plan quota: ${window.remain.toLocaleString()} / ${window.limit.toLocaleString()} tokens (${window.label})${reset}`
  }).join('\n')
}

async function status(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = await makeWorkBuddyStore(variant)
  const authStatus = await store.status()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  if (authStatus.state !== 'signed-in') {
    if (jsonOutput) {
      printJson({ schemaVersion: JSON_SCHEMA_VERSION, package: 'dsh-any-connect', version: ANYCONNECT_VERSION, provider: variant.id, status: 'signed-out', hostBundle: hostState })
    } else {
      process.stdout.write(`${variant.displayName} Connect: signed out\nHost bundle: ${hostState}\n`)
    }
    return 1
  }
  const workbuddyStore = store as WorkBuddyCredentialStore
  let credits: { total: number; error?: string } | undefined
  let creditAccounts: readonly WorkBuddyCreditAccount[] | undefined
  try {
    const credential = await workbuddyStore.current()
    if (credential !== undefined) {
      const client = upstreamClientFor(variant)
      const answer = await client.fetchCredits(credential)
      credits = { total: answer.total }
      creditAccounts = [...answer.accounts]
    }
  } catch (error: unknown) {
    credits = { total: 0, error: safeMessage(error) }
  }
  let expiresAt: string | undefined
  if (authStatus.expiresAtMs !== undefined && Number.isFinite(authStatus.expiresAtMs)) {
    try {
      expiresAt = new Date(authStatus.expiresAtMs).toISOString()
    } catch {
      expiresAt = undefined
    }
  }
  // 今日消耗统计（credit-ledger）：宿主进程记账、CLI 只读展示；台账缺席
  // （域打不开/今天还没有样本）时省略字段，不编数字。
  let creditsToday: ReturnType<typeof summarize> | undefined
  if (variant.kind === 'workbuddy' && sharedLedgerReader !== undefined) {
    try {
      const ledgerState = await sharedLedgerReader(variant.id)
      creditsToday = ledgerState === undefined ? undefined : summarize(ledgerState.days)
    } catch {
      creditsToday = undefined
    }
  }
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-any-connect',
      version: ANYCONNECT_VERSION,
      provider: variant.id,
      status: 'signed-in',
      ...expiresAt === undefined ? {} : { accessTokenExpires: expiresAt },
      ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
      ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
      source: authStatus.source,
      credits: credits?.total,
      ...credits?.error === undefined ? {} : { creditsError: credits.error },
      ...creditsToday === undefined ? {} : {
        creditsToday: {
          consumed: creditsToday.today.consumed,
          granted: creditsToday.today.granted,
          peak: creditsToday.today.peak,
          samples: creditsToday.today.samples,
        },
      },
      // ZCode 的额度语义与 WorkBuddy 点数不同:窗口按 pill 同一口径给出
      // (Start Plan 是按模型分池的 token 计数池、每池一条,Coding Plan 是
      // 订阅有效性),total 只是兼容字段。
      ...variant.kind === 'zcode' && creditAccounts !== undefined
        ? { quotaWindows: variantIsStartPlan(variant) ? startPlanWindows(creditAccounts) : currentPlanWindow(creditAccounts) }
        : {},
      hostBundle: hostState,
    })
    return 0
  }
  process.stdout.write([
    `${variant.displayName} Connect: signed in${authStatus.nickname === undefined ? '' : ` as ${authStatus.nickname}`}`,
    ...expiresAt === undefined ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
    humanCredits(variant, credits, creditAccounts),
    // 今日消耗（估算口径：宿主进程运行期间的采样差分，样本间「发放+消耗」
    // 抵消的量会被低估；今天还没有样本时不输出这一行）。
    ...(creditsToday === undefined ? [] : [
      `Today: used ${creditsToday.today.consumed}, granted +${creditsToday.today.granted}, peak ${creditsToday.today.peak}`
        + ` (${creditsToday.today.samples} samples, estimated)`,
    ]),
    `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
    'Client card: load failures are logged to the browser console only; the host provider is unaffected.',
    '',
  ].join('\n'))
  return 0
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['doctor', 'logout', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-any-connect: expected doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')

  // `--provider <id>` (or `--provider=<id>`); absent means the CN provider, so
  // every existing invocation keeps its behaviour.
  let providerId: string | undefined
  const rest: string[] = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--provider') {
      // 末尾缺值(--provider 后没有参数)必须报错而非静默回落 CN 默认:
      // 「没传 flag」与「传了 flag 没给值」是两种意图,混同会让用户以为
      // 查询的是别的 provider,拿到 CN 的诊断且退出码正常。
      const value = flags[index + 1]
      if (value === undefined) {
        process.stderr.write(`dsh-any-connect: --provider expects a value; expected one of ${PROVIDER_VARIANTS.map(v => v.id).join(', ')}\n`)
        return 1
      }
      providerId = value
      index += 1
      continue
    }
    if (flag.startsWith('--provider=')) {
      providerId = flag.slice('--provider='.length)
      continue
    }
    rest.push(flag)
  }
  const variant = providerId === undefined ? CN_VARIANT : variantFor(providerId)
  if (variant === undefined) {
    process.stderr.write(
      `dsh-any-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${PROVIDER_VARIANTS.map(v => v.id).join(', ')}\n`,
    )
    return 1
  }
  const unknown = rest.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-any-connect: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput, variant)
      case 'status':
        return await status(jsonOutput, variant)
      case 'logout': {
        const store = await makeWorkBuddyStore(variant)
        await store.logout()
        process.stdout.write(`${variant.displayName} Connect: removed the plugin-owned credential copy (state domain, file fallback ${workbuddyOwnAuthPath(variant.ownFilename)}); the desktop app's sign-in is untouched\n`)
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-any-connect: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  } finally {
    // 所有出口（含各分支的 return 与异常路径）之后统一释放状态域句柄。
    await closeSharedState()
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
