/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

/**
 * The client entry degrades a DSH client-API breaking change (a slot-contract
 * rename, or the locale double-registration throw under HMR) to console noise,
 * so the pill never takes the chat page down with it.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages); instead we replicate the exact try/catch shape from
 * `client/index.tsx` and assert it swallows simulated throws.
 *
 * DRIFT WARNING: the `apply()` below is a manual mirror of the real
 * `apply()` in `client/index.tsx`. It is NOT the product code, so this test
 * only proves the fallback idea works — it cannot detect a regression in the
 * real entry. If you change that guarded body or its `console.error` message,
 * update the mirror here too; a mismatch is invisible to this test.
 */

/** Mirror of client/index.tsx apply() body — keep in sync with the real one. */
function apply(ctx: any): void {
  try {
    const namespace = 'providerUsage'
    ctx.effect(() => {
      try {
        ctx.locale.register(namespace, { zh: {}, en: {} })
      } catch (error: unknown) {
        const message = String((error as any)?.message ?? error)
        if (!message.includes('already')) console.warn('provider-usage: locale dictionary registration failed: ' + message)
      }
    }, 'provider-usage: pill copy')
    const t = ctx.locale.bind(namespace)
    ctx.slots.inject('conversation.composer.dock', () => {
      throw new Error('not reached')
    })
    void t
  } catch (error: unknown) {
    console.error('[provider-usage] client pill failed to load (host registry unaffected):', error)
  }
}

/** Fake ctx whose effect runs its setup synchronously, like the real host. */
function fakeCtx(options: { registerThrows?: Error; injectThrows?: Error; injectCalled?: () => void } = {}): any {
  return {
    effect: (fn: () => void) => { fn() },
    locale: {
      register: () => {
        if (options.registerThrows !== undefined) throw options.registerThrows
        return () => {}
      },
      bind: () => () => '',
    },
    slots: {
      inject: () => {
        options.injectCalled?.()
        if (options.injectThrows !== undefined) throw options.injectThrows
      },
    },
  }
}

describe('provider-usage client fallback', () => {
  it('swallows a slot registration failure instead of throwing', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })

    // Simulate a DSH loader that throws on ctx.slots.inject (a renamed slot or
    // a changed registration contract). Loose `any` on purpose: we only test
    // the try/catch boundary, not the DSH client API types.
    const ctx = fakeCtx({ injectThrows: new Error('slot "conversation.composer.dock" is not declared') })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('client pill failed to load')
    expect(String(errors[0])).toContain('is not declared')

    spy.mockRestore()
  })

  it('ignores the locale double-registration throw (HMR) and still injects the pill', () => {
    const errors: unknown[] = []
    const warns: unknown[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args) })

    let injectCalled = false
    const ctx = fakeCtx({
      registerThrows: new Error('locale namespace "providerUsage" already has locale "zh"'),
      injectCalled: () => { injectCalled = true },
    })

    expect(() => apply(ctx)).not.toThrow()
    expect(warns).toHaveLength(0)
    expect(errors).toHaveLength(0)
    expect(injectCalled).toBe(true)

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('warns on a non-HMR locale failure and still injects the pill', () => {
    const errors: unknown[] = []
    const warns: unknown[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args) })

    let injectCalled = false
    const ctx = fakeCtx({
      registerThrows: new Error('locale service unavailable'),
      injectCalled: () => { injectCalled = true },
    })

    expect(() => apply(ctx)).not.toThrow()
    expect(warns).toHaveLength(1)
    expect(String(warns[0])).toContain('locale dictionary registration failed')
    expect(String(warns[0])).toContain('locale service unavailable')
    expect(errors).toHaveLength(0)
    expect(injectCalled).toBe(true)

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
