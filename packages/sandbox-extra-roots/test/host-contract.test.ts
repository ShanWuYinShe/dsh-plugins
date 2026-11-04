/**
 * 宿主契约接线锁：dsh.d.ts 只声明局部类型，**不得再增强**官方
 * @deepseek-ai/cordis 的 Context。
 *
 * 背景：本包曾以 `declare module '@deepseek-ai/cordis' { interface Context {
 * sandboxPolicy: {...} } }` 补声明宿主服务面。该增强会随发布产物
 * lib/index.d.ts 一起发给消费者，而官方 @deepseek-ai/dsh-sandbox-policy 的
 * SandboxPolicyService 属性类型不同 → 消费者同时看到两份官方类型时 TS2717
 * （subsequent property declarations must have the same type）。
 *
 * 修法是局部类型 + 使用点显式 cast（见 src/dsh.d.ts 与 wrap.ts 的 fs 包装）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('dsh.d.ts 宿主契约接线', () => {
  it('不增强官方 Context,只导出局部 HostSandboxPolicy 类型', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'src', 'dsh.d.ts'), 'utf8')
    expect(text).not.toMatch(/^\s*declare module\s+['"]@deepseek-ai\/cordis['"]/m)
    expect(text).toMatch(/export interface HostSandboxPolicy/)
  })
})
