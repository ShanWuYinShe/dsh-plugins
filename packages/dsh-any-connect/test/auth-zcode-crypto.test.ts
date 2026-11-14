/**
 * ZCode 凭据解密测试（enc:v1 与 enc:v2）。
 *
 * 2026-10-08 补 enc:v1 测试；
 * 2026-11 适配 ZCode 3.18.2+ 引入的 enc:v2（系统 Keyring / 环境变量 / credential-secret 托管存储）。
 */

import crypto from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearZCodeKeyCache,
  computeZCodeKeyFingerprint,
  decryptZCodeEncryptedKey,
  resolveKeyringPasswordViaCli,
  resolveZCodeBin,
  resolveZCodeKeyringNode,
  setZCodeKeyCache,
} from '../src/auth-zcode-crypto.js'

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

function sealV2(
  plaintext: string,
  key: Buffer,
  options: { source?: 'os' | 'env'; iv?: Buffer; tag?: Buffer; tamperedCipher?: boolean } = {},
): string {
  const source = options.source ?? 'os'
  const fingerprint = computeZCodeKeyFingerprint(key)
  const iv = options.iv ?? crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  let body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  if (options.tamperedCipher) {
    body = Buffer.from(body)
    body[0] = (body[0] ?? 0) ^ 0xff
  }
  const tag = options.tag ?? cipher.getAuthTag()
  const payload = [iv, tag, body].map((part) => part.toString('base64url')).join('.')
  return `enc:v2:${source}:${fingerprint}:${payload}`
}

describe('decryptZCodeEncryptedKey', () => {
  beforeEach(() => {
    clearZCodeKeyCache()
  })

  afterEach(() => {
    clearZCodeKeyCache()
  })

  describe('enc:v1 向后兼容', () => {
    it('非 enc: 前缀原样返回（明文 api-key 不受影响）', () => {
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

    it('enc:v1 通过 process.env.ZCODE_CREDENTIAL_SECRET 解密', () => {
      const oldEnv = process.env.ZCODE_CREDENTIAL_SECRET
      try {
        process.env.ZCODE_CREDENTIAL_SECRET = 'env-override-v1-secret'
        const ciphertext = seal('env-v1-val', 'env-override-v1-secret')
        expect(decryptZCodeEncryptedKey(ciphertext)).toBe('env-v1-val')
      } finally {
        if (oldEnv === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET
        else process.env.ZCODE_CREDENTIAL_SECRET = oldEnv
      }
    })

    it('enc:v1 WSL /mnt 路径挂载场景派生 Windows 用户路径', () => {
      const desktop = '/mnt/c/Users/alice/.zcode/credentials.json'
      const keyStr = 'zcode-credential-fallback:win32:C:\\Users\\alice:alice'
      const ciphertext = seal('wsl-secret', keyStr)
      expect(decryptZCodeEncryptedKey(ciphertext, { desktopPath: desktop })).toBe('wsl-secret')
    })

    it('未知加密版本抛出明确错误', () => {
      expect(() => decryptZCodeEncryptedKey('enc:v9:anything')).toThrow(/Unsupported ZCode credential encryption version/)
    })
  })

  describe('enc:v2 解密', () => {
    it('source=os 通过 options.secret（43 字符 base64url）解开密文', () => {
      const rawKey = crypto.randomBytes(32)
      const secret = rawKey.toString('base64url')
      const ciphertext = sealV2('sk-zcode-secret-42', rawKey, { source: 'os' })
      expect(decryptZCodeEncryptedKey(ciphertext, { secret })).toBe('sk-zcode-secret-42')
    })

    it('source=os 通过 options.secret（32 字节 Buffer）解开密文', () => {
      const rawKey = crypto.randomBytes(32)
      const ciphertext = sealV2('sk-zcode-buffer-key', rawKey, { source: 'os' })
      expect(decryptZCodeEncryptedKey(ciphertext, { secret: rawKey })).toBe('sk-zcode-buffer-key')
    })

    it('source=os 通过 options.keyResolver 解密并命中内存缓存', () => {
      const rawKey = crypto.randomBytes(32)
      const expectedFp = computeZCodeKeyFingerprint(rawKey)
      const ciphertext = sealV2('api-key-resolved', rawKey, { source: 'os' })
      let resolverCallCount = 0

      const keyResolver = (ctx: { source: 'os' | 'env'; keyFingerprint: string; desktopPath?: string; account: string }) => {
        resolverCallCount += 1
        expect(ctx.source).toBe('os')
        expect(ctx.keyFingerprint).toBe(expectedFp)
        expect(ctx.desktopPath).toBe('/fake/desktop/credentials.json')
        expect(ctx.account).toBe(crypto.createHash('sha256').update('/fake/desktop/credentials.json').digest('hex'))
        return rawKey
      }

      // 首次解密：调用 resolver 并存入缓存
      const first = decryptZCodeEncryptedKey(ciphertext, { desktopPath: '/fake/desktop/credentials.json', keyResolver })
      expect(first).toBe('api-key-resolved')
      expect(resolverCallCount).toBe(1)

      // 第二次解密：走内存缓存，不再次调用 resolver
      const second = decryptZCodeEncryptedKey(ciphertext, { desktopPath: '/fake/desktop/credentials.json', keyResolver: () => undefined })
      expect(second).toBe('api-key-resolved')
      expect(resolverCallCount).toBe(1)
    })

    it('source=os 支持外部注入的 keyCache', () => {
      const rawKey = crypto.randomBytes(32)
      const fp = computeZCodeKeyFingerprint(rawKey)
      const customCache = new Map<string, Buffer>([[fp, rawKey]])
      const ciphertext = sealV2('custom-cache-val', rawKey, { source: 'os' })
      expect(decryptZCodeEncryptedKey(ciphertext, { keyCache: customCache })).toBe('custom-cache-val')
    })

    it('source=os 预置 setZCodeKeyCache 可成功解密', () => {
      const rawKey = crypto.randomBytes(32)
      const fp = computeZCodeKeyFingerprint(rawKey)
      setZCodeKeyCache(fp, rawKey)
      const ciphertext = sealV2('preset-cache-val', rawKey, { source: 'os' })
      expect(decryptZCodeEncryptedKey(ciphertext)).toBe('preset-cache-val')
    })

    it('source=os 通过 zcodeBin 运行 helper 成功提取密码并解密', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'zcode-helper-test-'))
      try {
        const rawKey = crypto.randomBytes(32)
        const secret = rawKey.toString('base64url')
        const mockBin = join(tempDir, 'mock-zcode')
        await writeFile(mockBin, `#!/usr/bin/env node\nprocess.stdout.write("${secret}");\n`, { mode: 0o755 })
        const ciphertext = sealV2('helper-decrypted-value', rawKey, { source: 'os' })
        const result = decryptZCodeEncryptedKey(ciphertext, { zcodeBin: mockBin })
        expect(result).toBe('helper-decrypted-value')
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('source=os helper 进程执行失败时优雅降级并报错', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'zcode-helper-fail-'))
      try {
        const rawKey = crypto.randomBytes(32)
        const fp = computeZCodeKeyFingerprint(rawKey)
        const mockBin = join(tempDir, 'mock-zcode-fail')
        await writeFile(mockBin, `#!/usr/bin/env node\nprocess.exit(1);\n`, { mode: 0o755 })
        const ciphertext = sealV2('failed-helper', rawKey, { source: 'os' })
        expect(() => decryptZCodeEncryptedKey(ciphertext, { zcodeBin: mockBin, platform: 'linux' })).toThrow(
          new RegExp(`Unable to resolve ZCode enc:v2 key \\(source: os, fingerprint: ${fp}\\)`),
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('source=os 通过 keyringNodePath 模拟原生模块成功提取密码解密', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'zcode-node-test-'))
      try {
        const rawKey = crypto.randomBytes(32)
        const secret = rawKey.toString('base64url')
        const mockNode = join(tempDir, 'mock-keyring.cjs')
        await writeFile(
          mockNode,
          `module.exports = { Entry: class { constructor() {} getPassword() { return "${secret}"; } } };\n`,
          'utf8',
        )
        const ciphertext = sealV2('node-decrypted-val', rawKey, { source: 'os' })
        const result = decryptZCodeEncryptedKey(ciphertext, {
          zcodeBin: '/no-bin-here',
          keyringNodePath: mockNode,
          platform: 'linux',
        })
        expect(result).toBe('node-decrypted-val')
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('source=env 通过 options.secret（普通文本经 sha256 派生）解开密文', () => {
      const secret = 'my-custom-env-secret-string-12345'
      const rawKey = crypto.createHash('sha256').update(secret, 'utf8').digest()
      const ciphertext = sealV2('env-plain-result', rawKey, { source: 'env' })
      expect(decryptZCodeEncryptedKey(ciphertext, { secret })).toBe('env-plain-result')
    })

    it('source=env 通过 process.env.ZCODE_CREDENTIAL_SECRET 环境变量解密', () => {
      const secret = 'env-var-secret-abc-xyz-987654321'
      const rawKey = crypto.createHash('sha256').update(secret, 'utf8').digest()
      const ciphertext = sealV2('env-var-result', rawKey, { source: 'env' })
      const old = process.env.ZCODE_CREDENTIAL_SECRET
      try {
        process.env.ZCODE_CREDENTIAL_SECRET = secret
        expect(decryptZCodeEncryptedKey(ciphertext)).toBe('env-var-result')
      } finally {
        if (old === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET
        else process.env.ZCODE_CREDENTIAL_SECRET = old
      }
    })

    it('source=env 通过 ZCODE_CREDENTIAL_SECRET_FILE 托管文件解密', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'zcode-secret-file-'))
      try {
        const secret = 'managed-file-secret-long-enough-32-chars!'
        const rawKey = crypto.createHash('sha256').update(secret, 'utf8').digest()
        const secretPath = join(tempDir, 'my-secret.txt')
        await writeFile(secretPath, `${secret}\n`, 'utf8')

        const ciphertext = sealV2('managed-file-value', rawKey, { source: 'env' })
        const old = process.env.ZCODE_CREDENTIAL_SECRET_FILE
        try {
          process.env.ZCODE_CREDENTIAL_SECRET_FILE = secretPath
          expect(decryptZCodeEncryptedKey(ciphertext)).toBe('managed-file-value')
        } finally {
          if (old === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET_FILE
          else process.env.ZCODE_CREDENTIAL_SECRET_FILE = old
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('source=env / os 通过同目录 credential-secret 托管文件解密', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'zcode-cred-secret-'))
      try {
        const rawKey = crypto.randomBytes(32)
        const secret = rawKey.toString('base64url')
        await writeFile(join(tempDir, 'credential-secret'), secret, 'utf8')

        const credPath = join(tempDir, 'credentials.json')
        const ciphertext = sealV2('cred-secret-file-val', rawKey, { source: 'os' })
        expect(decryptZCodeEncryptedKey(ciphertext, { desktopPath: credPath, zcodeBin: '/no-bin', platform: 'linux' })).toBe('cred-secret-file-val')
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('source=os credential-secret 文件内容为普通字符串时经 sha256 匹配解密', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'zcode-cred-secret-hash-'))
      try {
        const textSecret = 'plain-text-secret-not-base64url-length!'
        const rawKey = crypto.createHash('sha256').update(textSecret, 'utf8').digest()
        await writeFile(join(tempDir, 'credential-secret'), textSecret, 'utf8')
        const credPath = join(tempDir, 'credentials.json')
        const ciphertext = sealV2('plain-text-secret-val', rawKey, { source: 'os' })
        expect(decryptZCodeEncryptedKey(ciphertext, { desktopPath: credPath, zcodeBin: '/no-bin', platform: 'linux' })).toBe('plain-text-secret-val')
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('source=os 通过 process.env.ZCODE_CREDENTIAL_SECRET 环境变量解密', () => {
      const rawKey = crypto.randomBytes(32)
      const secretB64 = rawKey.toString('base64url')
      const ciphertext = sealV2('test-secret-payload', rawKey, { source: 'os' })
      const oldEnv = process.env.ZCODE_CREDENTIAL_SECRET
      try {
        process.env.ZCODE_CREDENTIAL_SECRET = secretB64
        const plaintext = decryptZCodeEncryptedKey(ciphertext, { zcodeBin: '/non/existent', platform: 'linux' })
        expect(plaintext).toBe('test-secret-payload')
      } finally {
        if (oldEnv === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET
        else process.env.ZCODE_CREDENTIAL_SECRET = oldEnv
      }
    })

    it('source=env 通过同目录 credential-secret 普通文本 sha256 派生解密', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'zcode-env-cred-file-'))
      try {
        const plainText = 'my-env-file-secret-raw-string'
        const rawKey = crypto.createHash('sha256').update(plainText, 'utf8').digest()
        await writeFile(join(tempDir, 'credential-secret'), plainText, 'utf8')
        const credPath = join(tempDir, 'credentials.json')
        const ciphertext = sealV2('env-file-derived', rawKey, { source: 'env' })
        expect(decryptZCodeEncryptedKey(ciphertext, { desktopPath: credPath })).toBe('env-file-derived')
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('未找到匹配指纹的密钥时抛出带指纹的明确错误', () => {
      const rawKey = crypto.randomBytes(32)
      const fp = computeZCodeKeyFingerprint(rawKey)
      const ciphertext = sealV2('cannot-open', rawKey, { source: 'os' })
      expect(() =>
        decryptZCodeEncryptedKey(ciphertext, {
          platform: 'linux',
          zcodeBin: '/non/existent/bin',
          keyringNodePath: '/non/existent/node',
        })
      ).toThrow(new RegExp(`Unable to resolve ZCode enc:v2 key \\(source: os, fingerprint: ${fp}\\)`))
    })

    it('密文被篡改时抛出 authentication tag verification failed 错误', () => {
      const rawKey = crypto.randomBytes(32)
      const ciphertext = sealV2('valid-original', rawKey, { source: 'os', tamperedCipher: true })
      expect(() => decryptZCodeEncryptedKey(ciphertext, { secret: rawKey })).toThrow(/Failed to decrypt ZCode enc:v2 credential/)
    })

    it('enc:v2 格式校验拦截畸形密文', () => {
      // 缺少字段
      expect(() => decryptZCodeEncryptedKey('enc:v2:os:short')).toThrow(/Invalid ZCode enc:v2/)
      // 非法 source
      expect(() => decryptZCodeEncryptedKey('enc:v2:badsource:0123456789abcdef01234567:a.b.c')).toThrow(/Invalid ZCode enc:v2/)
      // 非法指纹（长度不足 24 或含非法字符）
      expect(() => decryptZCodeEncryptedKey('enc:v2:os:0123:a.b.c')).toThrow(/Invalid ZCode enc:v2/)
      expect(() => decryptZCodeEncryptedKey('enc:v2:os:ZZZZ456789abcdef01234567:a.b.c')).toThrow(/Invalid ZCode enc:v2/)
      // payload 段数不足或超长
      expect(() => decryptZCodeEncryptedKey('enc:v2:os:0123456789abcdef01234567:a.b')).toThrow(/Invalid ZCode enc:v2/)
      expect(() => decryptZCodeEncryptedKey('enc:v2:os:0123456789abcdef01234567:..')).toThrow(/Invalid ZCode enc:v2/)
      // iv 长度不为 12 或 tag 长度不为 16
      const badIv = Buffer.from('short-iv').toString('base64url')
      const goodTag = crypto.randomBytes(16).toString('base64url')
      const body = Buffer.from('data').toString('base64url')
      expect(() => decryptZCodeEncryptedKey(`enc:v2:os:0123456789abcdef01234567:${badIv}.${goodTag}.${body}`)).toThrow(/Invalid ZCode enc:v2/)
    })

    it('平台路径与 CLI 发现辅助函数容错', async () => {
      expect(resolveZCodeBin('/non/existent', 'win32')).toBeUndefined()
      expect(resolveZCodeBin('/non/existent', 'linux')).toBeUndefined()
      const darwinBin = resolveZCodeBin('/non/existent', 'darwin')
      expect(darwinBin === undefined || typeof darwinBin === 'string').toBe(true)

      expect(resolveZCodeKeyringNode('/non/existent', 'win32')).toBeUndefined()
      expect(resolveZCodeKeyringNode('/non/existent', 'linux')).toBeUndefined()
      const darwinNode = resolveZCodeKeyringNode('/non/existent', 'darwin')
      expect(darwinNode === undefined || typeof darwinNode === 'string').toBe(true)

      expect(resolveKeyringPasswordViaCli('some-account', 'linux')).toBeUndefined()

      // 验证显式存在的文件与环境变量 ZCODE_ELECTRON_BIN / ZCODE_KEYRING_NODE 命中逻辑
      const tempDir = await mkdtemp(join(os.tmpdir(), 'zcode-env-bin-'))
      const fakeBin = join(tempDir, 'fake-bin')
      const fakeNode = join(tempDir, 'fake.node')
      await writeFile(fakeBin, '')
      await writeFile(fakeNode, '')
      expect(resolveZCodeBin(fakeBin, 'darwin')).toBe(fakeBin)
      expect(resolveZCodeKeyringNode(fakeNode, 'darwin')).toBe(fakeNode)

      const oldBin = process.env.ZCODE_ELECTRON_BIN
      const oldNode = process.env.ZCODE_KEYRING_NODE
      try {
        process.env.ZCODE_ELECTRON_BIN = fakeBin
        process.env.ZCODE_KEYRING_NODE = fakeNode
        expect(resolveZCodeBin(undefined, 'win32')).toBe(fakeBin)
        expect(resolveZCodeKeyringNode(undefined, 'win32')).toBe(fakeNode)
      } finally {
        if (oldBin === undefined) delete process.env.ZCODE_ELECTRON_BIN
        else process.env.ZCODE_ELECTRON_BIN = oldBin
        if (oldNode === undefined) delete process.env.ZCODE_KEYRING_NODE
        else process.env.ZCODE_KEYRING_NODE = oldNode
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('enc:v1 win32 平台下尝试 USERPROFILE 与 USERNAME 候选', () => {
      const winSecret = 'zcode-credential-fallback:win32:C:\\Users\\winuser:winuser'
      const ciphertext = seal('win32-val', winSecret)
      const oldProfile = process.env['USERPROFILE']
      const oldUser = process.env['USERNAME']
      try {
        process.env['USERPROFILE'] = 'C:\\Users\\winuser'
        process.env['USERNAME'] = 'winuser'
        expect(decryptZCodeEncryptedKey(ciphertext, { platform: 'win32' })).toBe('win32-val')
      } finally {
        if (oldProfile === undefined) delete process.env['USERPROFILE']
        else process.env['USERPROFILE'] = oldProfile
        if (oldUser === undefined) delete process.env['USERNAME']
        else process.env['USERNAME'] = oldUser
      }
    })
  })
})
