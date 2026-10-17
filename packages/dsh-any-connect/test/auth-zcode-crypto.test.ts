/**
 * enc:v1 凭据解密测试。
 *
 * 2026-10-08 补：这是「用户的加密 api-key 能不能解开」那条线，此前没有直接测试。
 * 解密本身无文件 I/O（只依赖环境与选项），所以可以直接构造真密文喂样本：
 * 用显式选项给出的密钥候选密封，再断言能解回原文。
 */

import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptZCodeEncryptedKey } from '../src/auth-zcode-crypto.js'

const PLATFORM = 'linux'
const HOME = '/tmp/at-rest-fake-home'
const USER = 'tester'
const OPTIONS = { platform: PLATFORM, homedir: HOME, username: USER }
const SECRET = 'zcode-credential-fallback:' + PLATFORM + ':' + HOME + ':' + USER

function seal(plaintext: string, secret = SECRET): string {
  const key = crypto.createHash('sha256').update(secret).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'enc:v1:' + [iv, tag, body].map((part) => part.toString('base64url')).join('.')
}

describe('decryptZCodeEncryptedKey', () => {
  it('非 enc:v1 前缀原样返回（明文 api-key 不受影响）', () => {
    expect(decryptZCodeEncryptedKey('sk-plain-key')).toBe('sk-plain-key')
    expect(decryptZCodeEncryptedKey('')).toBe('')
  })

  it('用显式选项给出的密钥解开密文', () => {
    expect(decryptZCodeEncryptedKey(seal('sk-secret-value'), OPTIONS)).toBe('sk-secret-value')
  })

  it('UTF-8 内容（非 ASCII）也能正确往返', () => {
    const text = '中文密钥 🔑 with spaces'
    expect(decryptZCodeEncryptedKey(seal(text), OPTIONS)).toBe(text)
  })

  it('格式不合法时抛错', () => {
    expect(() => decryptZCodeEncryptedKey('enc:v1:missing-parts', OPTIONS)).toThrow(/Invalid ZCode enc:v1/)
    expect(() => decryptZCodeEncryptedKey('enc:v1:..', OPTIONS)).toThrow(/Invalid ZCode enc:v1/)
    expect(() => decryptZCodeEncryptedKey('enc:v1:a.b.', OPTIONS)).toThrow(/Invalid ZCode enc:v1/)
  })

  it('密钥不对时抛错，而不是返回垃圾明文', () => {
    const sealed = seal('sk-secret-value', 'a-completely-different-secret')
    expect(() => decryptZCodeEncryptedKey(sealed, OPTIONS)).toThrow()
  })
})
