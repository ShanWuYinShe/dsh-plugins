import { describe, expect, it } from 'vitest'
import {
  hasOpenCodePromptPrefix,
  OPENCODE_CLIENT_IDENTITY,
  renderOpenCodePromptPrefix,
  withOpenCodePromptPrefix,
} from '../src/opencode-prompt.js'

describe('OpenCode 提示词前缀与指纹守卫', () => {
  const sessionId = 'ses_test1234567890abcdef'

  it('renderOpenCodePromptPrefix 注入会话 ID 并包含完整的官方 Harness 指纹结构', () => {
    const rendered = renderOpenCodePromptPrefix(sessionId)
    expect(rendered.startsWith(OPENCODE_CLIENT_IDENTITY)).toBe(true)
    expect(rendered).toContain(`<env>\n  Current conversation session ID: ${sessionId}`)
    expect(rendered).toContain('</env>')
    expect(rendered).toContain('# Harness')
    expect(rendered).toContain('# Communication')
    expect(rendered).toContain('# Working in codebases')
    expect(rendered).toContain('LongCat 2.5 Free')
    expect(rendered.length).toBeGreaterThan(1500)
  })

  it('hasOpenCodePromptPrefix 精确判定前缀存在与否', () => {
    expect(hasOpenCodePromptPrefix(OPENCODE_CLIENT_IDENTITY)).toBe(true)
    expect(hasOpenCodePromptPrefix(renderOpenCodePromptPrefix(sessionId))).toBe(true)
    expect(hasOpenCodePromptPrefix('You are a helpful assistant.')).toBe(false)
    expect(hasOpenCodePromptPrefix('')).toBe(false)
    expect(hasOpenCodePromptPrefix(undefined)).toBe(false)
    expect(hasOpenCodePromptPrefix(null)).toBe(false)
    expect(hasOpenCodePromptPrefix(123)).toBe(false)
    expect(hasOpenCodePromptPrefix({})).toBe(false)
  })

  it('withOpenCodePromptPrefix 当缺少或为空提示词时直接返回前缀', () => {
    const expected = renderOpenCodePromptPrefix(sessionId)
    expect(withOpenCodePromptPrefix(undefined, sessionId)).toBe(expected)
    expect(withOpenCodePromptPrefix('', sessionId)).toBe(expected)
    expect(withOpenCodePromptPrefix('   \n\t  ', sessionId)).toBe(expected)
  })

  it('withOpenCodePromptPrefix 保留原有提示词并追加在官方指纹之后', () => {
    const original = 'You are a deep-learning coding assistant for DSH.'
    const result = withOpenCodePromptPrefix(original, sessionId)
    expect(result.startsWith(OPENCODE_CLIENT_IDENTITY)).toBe(true)
    expect(result.endsWith(original)).toBe(true)
    expect(result).toContain(`Current conversation session ID: ${sessionId}`)
    expect(result).toContain(`</env>\n\n${original}`)
  })

  it('withOpenCodePromptPrefix 当已有前缀时不重复叠加', () => {
    const first = withOpenCodePromptPrefix('custom instruction', sessionId)
    const second = withOpenCodePromptPrefix(first, sessionId)
    expect(second).toBe(first)
  })
})
