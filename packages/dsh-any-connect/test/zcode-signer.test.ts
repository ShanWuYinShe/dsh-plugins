import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  parseZCodeApiKey,
  solveClientRequestProofOfWork,
  ZCodeClientSigner,
} from '../src/zcode-signer.js'

describe('ZCode signer', () => {
  describe('parseZCodeApiKey', () => {
    it('parses valid key format', () => {
      const parsed = parseZCodeApiKey('57271768622479063.abcdef123456')
      expect(parsed).toEqual({
        apiKeyId: '57271768622479063',
        apiKeySecret: 'abcdef123456',
        credential: '57271768622479063.abcdef123456',
      })
    })

    it('trims whitespace', () => {
      const parsed = parseZCodeApiKey('  myid.mysecret  \n')
      expect(parsed).toEqual({
        apiKeyId: 'myid',
        apiKeySecret: 'mysecret',
        credential: 'myid.mysecret',
      })
    })

    it('returns undefined for invalid format', () => {
      expect(parseZCodeApiKey('')).toBeUndefined()
      expect(parseZCodeApiKey('nodot')).toBeUndefined()
      expect(parseZCodeApiKey('.secret')).toBeUndefined()
      expect(parseZCodeApiKey('id.')).toBeUndefined()
      expect(parseZCodeApiKey('id.secret.extra')).toBeUndefined()
    })
  })

  describe('solveClientRequestProofOfWork', () => {
    it('solves 8-bit proof of work correctly', () => {
      const apiKeyId = 'test-id'
      const sessionId = 'test-session-123'
      const ts = '1700000000000'
      const candidate = solveClientRequestProofOfWork({
        apiKeyId,
        sessionId,
        ts,
        powBits: 8,
      })

      expect(typeof candidate).toBe('string')
      expect(candidate.length).toBeGreaterThan(0)

      const prefixInput = `${apiKeyId}\nzcode\n${sessionId}\n${ts}`
      const hash = crypto.createHash('sha256').update(prefixInput).digest('hex').slice(0, 32)
      const digest = crypto.createHash('sha256').update(`${hash}\n${candidate}`).digest()
      expect(digest[0]).toBe(0)
    })
  })

  describe('ZCodeClientSigner', () => {
    it('performs cryptographic handshake, decrypts ed25519 key, and signs requests', async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
      const privPkcs8Der = privateKey.export({ format: 'der', type: 'pkcs8' })

      const testApiKeyId = 'testkeyid'
      const testApiKeySecret = 'testsecret123456'
      const testApiKey = `${testApiKeyId}.${testApiKeySecret}`

      // Encrypt the private key using HKDF-derived AES-GCM key matching the real protocol
      const KDF_SALT = 'WD_CLIENT_SIGN_KDF_SALT'
      const INFO_PRIV = 'ed25519_priv'
      const aesKeyRaw = crypto.hkdfSync('sha256', testApiKeySecret, KDF_SALT, INFO_PRIV, 32)
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKeyRaw), iv)
      cipher.setAAD(Buffer.from(testApiKeyId, 'utf8'))
      const privB64 = privPkcs8Der.toString('base64')
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(privB64, 'utf8')), cipher.final()])
      const tag = cipher.getAuthTag()
      const privateCipher = Buffer.concat([iv, ciphertext, tag]).toString('base64')

      let handshakeFetchCount = 0
      const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        handshakeFetchCount += 1
        const body = JSON.parse(init?.body as string)
        expect(body.apiKey).toBe(testApiKey)
        expect(typeof body.nonce).toBe('string')
        expect(typeof body.sig).toBe('string')
        expect(typeof body.ts).toBe('string')
        return new Response(JSON.stringify({
          code: 200,
          msg: 'OK',
          data: { privateCipher },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })

      vi.stubGlobal('fetch', mockFetch)

      const signer = new ZCodeClientSigner({ handshakeUrl: 'https://test.bigmodel.local/handshake' })
      const headers = await signer.buildHeaders({ apiKey: testApiKey })

      expect(handshakeFetchCount).toBe(1)
      expect(headers['Authorization']).toBe(`Bearer ${testApiKey}`)
      expect(headers['X-App-Id']).toBe('zcode')
      expect(headers['X-Client-Version']).toBe('3.4.0')
      expect(headers['X-ZCode-App-Version']).toBe('3.4.0')
      expect(headers['X-Title']).toBe('Z Code@cli')
      expect(headers['X-ZCode-Agent']).toBe('glm')
      expect(headers['X-Release-Channel']).toBe('stable')
      expect(typeof headers['X-Session-Id']).toBe('string')
      expect(typeof headers['X-Client-Nonce']).toBe('string')
      expect(typeof headers['X-Client-Pow']).toBe('string')
      expect(typeof headers['X-Client-Sig']).toBe('string')

      // Verify the client signature with the public key
      const expectedSignData = `${testApiKeyId}\n${headers['X-Client-Ts']}\n3.4.0\n${headers['X-Session-Id']}\n${headers['X-Client-Nonce']}`
      const sigBuffer = Buffer.from(headers['X-Client-Sig']!, 'base64')
      const verified = crypto.verify(null, Buffer.from(expectedSignData, 'utf8'), publicKey, sigBuffer)
      expect(verified).toBe(true)

      // Second call should use cached key without refetching handshake
      await signer.buildHeaders({ apiKey: testApiKey })
      expect(handshakeFetchCount).toBe(1)

      vi.unstubAllGlobals()
    })
  })
})
