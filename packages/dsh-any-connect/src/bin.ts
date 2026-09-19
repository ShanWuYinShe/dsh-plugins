#!/usr/bin/env node
/** Standalone status/diagnostics CLI for the dsh-any-connect bundle. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCredentialStore, workbuddyOwnAuthPath, WORKBUDDY_AUTH_FILE_ENV } from './auth.js'
import { WorkBuddyUpstreamClient } from './upstream.js'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, FALLBACK_ZCODE_MODELS } from './catalog.js'
import { ZcodeCredentialStore, maskApiKey, zcodeOwnAuthPath, ZCODE_API_KEY_ENV } from './zcode-auth.js'
import { ZcodeUpstreamClient } from './zcode-upstream.js'
import { CN_VARIANT, variantFor, WORKBUDDY_VARIANTS, ZCODE_VARIANT } from './variants.js'
import type { WorkBuddyVariant } from './variants.js'
import { ANYCONNECT_VERSION } from './version.js'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.js'

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
    '  --provider  which product to inspect: workbuddy, workbuddy-ai, or zcode',
    '              (defaults to workbuddy)',
    '  --json   emit one secret-free JSON document (doctor/status only)',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** WorkBuddy credential store wired for CLI diagnostics. */
function makeWorkBuddyStore(variant: WorkBuddyVariant): WorkBuddyCredentialStore {
  const client = new WorkBuddyUpstreamClient()
  return new WorkBuddyCredentialStore({ variant, refresh: credential => client.refreshToken(credential) })
}

/** Compiled-in roster size per provider id. */
const FALLBACK_COUNT_BY_ID = new Map<string, number>([
  [CN_VARIANT.id, FALLBACK_WORKBUDDY_MODELS.length],
  [WORKBUDDY_VARIANTS[1]!.id, FALLBACK_WORKBUDDY_AI_MODELS.length],
  [ZCODE_VARIANT.id, FALLBACK_ZCODE_MODELS.length],
])

function fallbackFor(variant: WorkBuddyVariant): number {
  return FALLBACK_COUNT_BY_ID.get(variant.id) ?? 0
}

async function doctor(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  if (variant.kind === 'zcode') return zcodeDoctor(jsonOutput, variant)
  const store = makeWorkBuddyStore(variant)
  const status = await store.status()
  const desktopPresent = await store.desktopFilePresent()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-any-connect',
    version: ANYCONNECT_VERSION,
    provider: variant.id,
    node: process.version,
    desktopAuthFile: {
      path: store.desktopAuthPath() ?? `(no platform default; set ${variant.env ?? WORKBUDDY_AUTH_FILE_ENV})`,
      present: desktopPresent,
    },
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
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `${variant.displayName} Connect ${ANYCONNECT_VERSION} on ${process.version}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} (${report.desktopAuthFile.path})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Sign-in state: ${report.signIn}`,
      `Static fallback models: ${report.fallbackModels}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return status.state === 'signed-in' && desktopPresent ? 0 : 1
}

/** zcode doctor: key presence, source, and a one-request live validation. */
async function zcodeDoctor(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = new ZcodeCredentialStore()
  const status = await store.status()
  const credential = await store.current().catch(() => undefined)
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  // Live key check: one tiny messages request. Coding-plan keys bill by
  // units, and 32 output tokens are negligible — an invalid key is exactly
  // what doctor exists to catch, so the request is worth its cost.
  let ping: { ok: boolean; status?: number; message: string } | undefined
  if (credential !== undefined) {
    const client = new ZcodeUpstreamClient()
    try {
      const result = await client.forwardMessages(
        credential,
        JSON.stringify({ model: 'GLM-5.3-Flash', max_tokens: 32, messages: [{ role: 'user', content: 'ping' }] }),
        AbortSignal.timeout(15_000),
      )
      ping = result.ok
        ? { ok: true, status: result.status, message: 'key accepted' }
        : { ok: false, status: result.status, message: result.body.slice(0, 200) }
    } catch (error: unknown) {
      ping = { ok: false, message: safeMessage(error) }
    }
  }
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-any-connect',
    version: ANYCONNECT_VERSION,
    provider: variant.id,
    node: process.version,
    keySource: credential?.source,
    keyMasked: credential === undefined ? undefined : maskApiKey(credential.accessToken),
    ownKeyFile: zcodeOwnAuthPath(),
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: status.state,
    fallbackModels: fallbackFor(variant),
    ping,
    hints: [
      ...credential !== undefined ? [] : [`No GLM Coding Plan API key configured; set it via the plugin settings (apiKeyZcode), ${ZCODE_API_KEY_ENV}, or ${zcodeOwnAuthPath()}.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `${variant.displayName} Connect ${ANYCONNECT_VERSION} on ${process.version}`,
      `API key: ${report.keySource === undefined ? 'not configured' : `configured (${report.keySource}; ${report.keyMasked})`}`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Static fallback models: ${report.fallbackModels}`,
      ...ping === undefined ? [] : [`Live key check: ${ping.ok ? 'accepted' : `rejected (http ${ping.status ?? '?'}): ${ping.message}`}`],
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return credential !== undefined && (ping === undefined || ping.ok) ? 0 : 1
}

async function status(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store: WorkBuddyCredentialStore | ZcodeCredentialStore = variant.kind === 'zcode'
    ? new ZcodeCredentialStore()
    : makeWorkBuddyStore(variant)
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
  // zcode 无积分账本（套餐额度藏在有签名的管理面之后），也不存在 token
  // 过期——status 只报 key 来源与掩码。
  if (variant.kind === 'zcode') {
    const credential = await (store as ZcodeCredentialStore).current()
    if (jsonOutput) {
      printJson({
        schemaVersion: JSON_SCHEMA_VERSION,
        package: 'dsh-any-connect',
        version: ANYCONNECT_VERSION,
        provider: variant.id,
        status: 'signed-in',
        keySource: credential?.source,
        keyMasked: credential === undefined ? undefined : maskApiKey(credential.accessToken),
        hostBundle: hostState,
      })
      return 0
    }
    process.stdout.write([
      `${variant.displayName} Connect: signed in (key from ${credential?.source ?? 'unknown'})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
      'Client card: load failures are logged to the browser console only; the host provider is unaffected.',
      '',
    ].join('\n'))
    return 0
  }
  const workbuddyStore = store as WorkBuddyCredentialStore
  let credits: { total: number; error?: string } | undefined
  try {
    const credential = await workbuddyStore.current()
    if (credential !== undefined) credits = { total: (await new WorkBuddyUpstreamClient().fetchCredits(credential)).total }
  } catch (error: unknown) {
    credits = { total: 0, error: safeMessage(error) }
  }
  const expiresAt = authStatus.expiresAtMs !== undefined ? new Date(authStatus.expiresAtMs).toISOString() : undefined
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
      hostBundle: hostState,
    })
    return 0
  }
  process.stdout.write([
    `${variant.displayName} Connect: signed in${authStatus.nickname === undefined ? '' : ` as ${authStatus.nickname}`}`,
    ...expiresAt === undefined ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
    credits?.error === undefined
      ? `Remaining credit: ${credits?.total ?? 'unknown'}`
      : `Remaining credit: unavailable (${credits.error})`,
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
      providerId = flags[index + 1]
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
      `dsh-any-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map(v => v.id).join(', ')}\n`,
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
        if (variant.kind === 'zcode') {
          const zcodeStore = new ZcodeCredentialStore()
          await zcodeStore.logout()
          process.stdout.write(`ZCode Connect: removed ${zcodeStore.ownAuthPath()}; a key configured via settings or ${ZCODE_API_KEY_ENV} is untouched\n`)
          return 0
        }
        const store = makeWorkBuddyStore(variant)
        await store.logout()
        process.stdout.write(`${variant.displayName} Connect: removed ${workbuddyOwnAuthPath(variant.ownFilename)}; the desktop app's sign-in is untouched\n`)
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-any-connect: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
