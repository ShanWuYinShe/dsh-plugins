import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KIND_STATUS, upstreamFailureMessage } from '../src/shim-http.js'
import { classifyUpstreamError, httpStatusLabel } from '../src/upstream-shared.js'

/**
 * 失败文案的回归锁：它必须同时躲开宿主的两道文本判定，并如实说明 403 的真实语义。
 *
 * 2026-10-08 建立（起因是一次真实排障）：海外版 workbuddy-ai 的 chat 被上游以
 * 403 / code 11140 拒绝，插件把状态码裸写进文案（`(http 403)`）；宿主 dsh-llm-pi-ai 的
 * `classifyPiAiError` 用 `/\b(?:401|403)\b/` 做文本分类，命中即判 `AUTH`，随后
 * `dsh-client-ui-chat` 在 `code === 'AUTH'` 时**丢弃我们写的 message**，显示固定的
 * 「API 密钥无效」——凭据明明有效（doctor signed-in、额度 100、模型目录 200），用户却被告知
 * 去换密钥。本锁把这个坑钉死。
 *
 * 注意 `HTTP-403` **无效**：`-` 是非词字符，`403` 两侧仍构成 `\b`。必须紧邻
 * 词字符（`_` 或字母），实现取 `HTTP_403`。这条也是实测出来的，别凭直觉改回去。
 */

// 与宿主 dsh-llm-pi-ai/lib/index.js 的 classifyPiAiError 同源。
const HOST_AUTH_RE = /\b(?:401|403)\b/
const HOST_OTHER_RULES: Array<[string, RegExp]> = [
  ['QUOTA', /quota|insufficient|balance/i],
  ['RATE_LIMIT', /\b429\b|rate.?limit/i],
  ['INVALID_REQUEST', /\b413\b|payload too large|request body too large/i],
  ['INVALID_REQUEST2', /\b400\b|invalid.?request/i],
  ['SERVER', /\b5\d\d\b/],
  ['TIMEOUT', /\btime(?:d)?\s*out\b|timeout/i],
  ['TRANSPORT', /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i],
]

const REAL_403_BODY = JSON.stringify({
  code: 11140,
  msg: 'request illegal',
  requestId: '0b2d5765-9563-4e96-bdeb-f1af7edc8319',
  displayMsg: {
    en: 'The content did not pass the safety review. Please adjust and retry.',
    zh: '内容未通过安全审核，请调整后重试',
  },
})

describe('httpStatusLabel', () => {
  it('渲染的状态码不触发宿主 AUTH 正则（HTTP_403 形式）', () => {
    expect(HOST_AUTH_RE.test(httpStatusLabel(403))).toBe(false)
    expect(HOST_AUTH_RE.test(httpStatusLabel(401))).toBe(false)
    expect(httpStatusLabel(403)).toBe('HTTP_403')
    expect(httpStatusLabel(401)).toBe('HTTP_401')
  })

  it('反例：裸状态码与 http-403 都会命中（说明本锁不是空转）', () => {
    expect(HOST_AUTH_RE.test('(http 403)')).toBe(true)
    expect(HOST_AUTH_RE.test('status 403')).toBe(true)
    // 连字符是非词字符，403 两侧仍是词边界 —— HTTP-403 也逃不掉。
    expect(HOST_AUTH_RE.test('HTTP-403')).toBe(true)
  })
})

describe('upstreamFailureMessage', () => {
  it('403 如实说明是授权问题，不把上游那句“安全审核”当结论', () => {
    const message = upstreamFailureMessage('workbuddy-ai', 'client', 403, REAL_403_BODY)
    expect(message).toContain('auth_forbidden')
    expect(message).toContain('非密钥失效')
    expect(message).toContain('非内容审核')
    // 上游原文仍保留，便于诊断。
    expect(message).toContain('11140')
  })

  it('任何状态下都不触发宿主任何一条分类规则（否则文案会被覆盖或误分类）', () => {
    for (const status of [400, 401, 402, 403, 404, 413, 429, 500, 502, 503]) {
      const message = upstreamFailureMessage('workbuddy-ai', 'client', status, REAL_403_BODY)
      expect(HOST_AUTH_RE.test(message), `status=${status} 触发了 AUTH`).toBe(false)
      for (const [name, re] of HOST_OTHER_RULES) {
        // 例外：文档里保留的 11140 原文不含这些；但 500/502/503 会命中 SERVER，
        // 那是**正确**分类（确实是服务端错误），故只对 4xx 断言不误判。
        if (status < 500) expect(re.test(message), `status=${status} 触发了 ${name}`).toBe(false)
      }
    }
  })

  it('非 403 保持原有单行格式（不引入误导性前缀）', () => {
    const message = upstreamFailureMessage('workbuddy', 'hard_credit', 402, 'insufficient credit')
    expect(message).toBe('workbuddy upstream hard_credit (HTTP_402): insufficient credit')
  })

  it('KIND_STATUS 的每个 kind 都能造出安全文案（覆盖全部失败类别）', () => {
    for (const [kind, status] of Object.entries(KIND_STATUS)) {
      const message = upstreamFailureMessage('workbuddy-ai', kind, status, REAL_403_BODY)
      if (status < 500) expect(HOST_AUTH_RE.test(message), `kind=${kind} 触发了 AUTH`).toBe(false)
      expect(message.length).toBeGreaterThan(0)
    }
  })
})

describe('源码里不再裸写状态码（防回归到文案层）', () => {
  // **扫描范围为什么只有 dsh-any-connect**：判据是「文案会流到宿主 dsh-llm-pi-ai
  // 的文本分类器 classifyPiAiError（/\b(?:401|403)\b/ 命中→AUTH→我们的 message 被丢弃）」。
  // 只有 LLM 流错误的 message 会走那条路；provider-usage 的用量错误走 /usage JSON 路由
  // 到浏览器 pill，不经过 pi-ai 分类器——所以**刻意不扫**其它包（判据贴意图，不用近似代理）。
  // 曾按「任何包都查」的近似代理扫到 provider-shared 一处，核实后发现它到不了分类器，
  // 是假阳性，已还原——这条边界说明就是为防后人再犯同样的过度泛化。
  // 宿主按文本正则分类：\b(?:401|403)\b 命中即判 AUTH，随后我们的 message 被丢弃。
  // 所以「状态码进错误文案」必须统一走 httpStatusLabel（渲染成 HTTP_403）。
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

  /** 会被宿主当文本读取的渲染点：模板串里直接插 status / response.status / res.status。 */
  const BARE_STATUS = new RegExp(String.raw`\$\{[^}]*\b(?:status|response\.status|res\.status)\b[^}]*\}`, 'g')

  /** 例外：这些不是 HTTP 状态码，或已由专用渲染器处理。 */
  const ALLOWED: ReadonlyArray<{ file: string; reason: string }> = [
    { file: 'upstream-shared.ts', reason: 'httpStatusLabel 自身实现' },
    { file: 'bin.ts', reason: 'status.reason 是登录态原因字符串，不是 HTTP 状态码' },
  ]

  it('src 下没有绕过 httpStatusLabel 的裸状态码插值', () => {
    const offenders: string[] = []
    for (const name of readdirSync(SRC)) {
      if (!name.endsWith('.ts')) continue
      if (ALLOWED.some((a) => a.file === name)) continue
      const text = readFileSync(join(SRC, name), 'utf8')
      text.split('\n').forEach((line: string, index: number) => {
        if (line.includes('httpStatusLabel')) return
        for (const match of line.matchAll(BARE_STATUS)) {
          offenders.push(name + ':' + (index + 1) + '  ' + match[0])
        }
      })
    }
    expect(offenders, '这些状态码插值会被宿主按文本重新分类（403 -> AUTH），请改用 httpStatusLabel').toEqual([])
  })

  it('扫描面非空（防止规则空转）', () => {
    const files = readdirSync(SRC).filter((n: string) => n.endsWith('.ts'))
    expect(files.length).toBeGreaterThanOrEqual(40)
    expect(files).toContain('shim-http.ts')
    expect(files).toContain('upstream-shared.ts')
  })

  it('判据本身有效：能识别裸状态码', () => {
    const bare = 'throw new Error(String.raw`failed (http ' + '\${response.status})`)'
    expect([...bare.matchAll(BARE_STATUS)].length).toBe(1)
    const safe = 'throw new Error(String.raw`failed (' + '\${httpStatusLabel(response.status)})`)'
    expect(safe.includes('httpStatusLabel')).toBe(true)
  })

  it('字符串字面量里也没有裸 401/403（防硬编码漏网）', () => {
    // 上一版扫描只查 `${...}` 插值，漏掉了**硬编码字面量**——实际就在
    // upstream-zcode-start-plan.ts 里抓到一处 'Start Plan 凭据失效（HTTP 401）'。
    // 宿主正则不看来源，字面量一样会被判 AUTH、文案照样被替换。
    const LITERAL = /(['"\u0060])((?:(?!\1)[^\\]|\\.)*?)\1/g
    const offenders: string[] = []
    for (const name of readdirSync(SRC)) {
      if (!name.endsWith('.ts')) continue
      readFileSync(join(SRC, name), 'utf8').split('\n').forEach((line: string, index: number) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return // 注释不是文案
        for (const match of line.matchAll(LITERAL)) {
          if (/\b(?:401|403)\b/.test(match[2] ?? '')) {
            offenders.push(name + ':' + (index + 1) + '  ' + trimmed.slice(0, 80))
          }
        }
      })
    }
    expect(offenders, '文案里硬编码的 401/403 会被宿主判成 AUTH；请写 HTTP_401/HTTP_403').toEqual([])
  })

  it('判据有效：三种引号都命中，HTTP_403 与数字比较放过', () => {
    const LITERAL = /(['"\u0060])((?:(?!\1)[^\\]|\\.)*?)\1/g
    const hits = (line: string): boolean =>
      [...line.matchAll(LITERAL)].some((m) => /\b(?:401|403)\b/.test(m[2] ?? ''))
    expect(hits("message: 'failed (HTTP 403)'")).toBe(true)
    expect(hits('message: "failed (HTTP 401)"')).toBe(true)
    expect(hits('message: `failed (HTTP 403)`')).toBe(true)
    expect(hits("message: 'failed (HTTP_403)'")).toBe(false)
    expect(hits('if (response.status === 401) {')).toBe(false)
  })
})

describe('auth_forbidden 分类', () => {
  it('403 归类为 auth_forbidden（授权拒绝，与泛化 client 不同）', () => {
    // 实测：海外版 workbuddy-ai 对未开通 chat 权益的账号，所有模型一律
    // 403 + code 11140；官方错误码表同口径（auth/auth_forbidden）。单列出来，
    // kind 才与「参数错误的 400」区分开，上层指引才准确。
    expect(classifyUpstreamError(403, '{"code":11140}')).toBe('auth_forbidden')
    expect(classifyUpstreamError(403, '')).toBe('auth_forbidden')
  })

  it('会话标记仍优先于 403（body 含 session 标记时归 session_dead）', () => {
    expect(classifyUpstreamError(403, 'Offline user session not found')).toBe('session_dead')
  })

  it('KIND_STATUS：auth_forbidden 刻意映射 400（而非 403，避免宿主误判 AUTH）', () => {
    expect(KIND_STATUS['auth_forbidden']).toBe(400)
  })

  it('auth_forbidden 的失败文案安全且如实', () => {
    const message = upstreamFailureMessage('workbuddy-ai', 'auth_forbidden', 400,
      '{"code":11140,"msg":"request illegal"}')
    expect(/\b(?:401|403)\b/.test(message)).toBe(false) // 不触发宿主 AUTH
    expect(message).toContain('workbuddy-ai upstream auth_forbidden (HTTP_400)')
  })
})
