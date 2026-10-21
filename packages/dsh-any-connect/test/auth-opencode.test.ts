import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultOpenCodeCandidates,
  desktopAuthCandidatesFor,
  OPENCODE_VARIANT,
  WorkBuddyCredentialStore,
  parseOpenCodeAuth,
  defaultOpenCodePublicCredential,
} from '../src/index.js'

describe('OpenCode Auth and Credential Resolution', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencode-auth-test-'))
  })

  afterEach(async () => {
    delete process.env['OPENCODE_API_KEY']
    await rm(tempDir, { recursive: true, force: true })
  })

  it('defaultOpenCodeCandidates 返回平台预设的 OpenCode 配置路径', () => {
    const candidates = defaultOpenCodeCandidates()
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    expect(candidates.some(c => c.includes('auth.json'))).toBe(true)
    expect(candidates.some(c => c.includes('opencode.json'))).toBe(true)
    expect(desktopAuthCandidatesFor(OPENCODE_VARIANT)).toEqual(candidates)
  })

  describe('parseOpenCodeAuth', () => {
    it('空字符串或 public 回退为 defaultOpenCodePublicCredential', () => {
      const expected = { accessToken: 'public', nickname: 'Free Tier (public)', domain: 'opencode.ai' }
      expect(parseOpenCodeAuth('')).toMatchObject(expected)
      expect(parseOpenCodeAuth('   ')).toMatchObject(expected)
      expect(parseOpenCodeAuth('public')).toMatchObject(expected)
      expect(parseOpenCodeAuth('{"apiKey":"public"}')).toMatchObject(expected)
    })

    it('解析直接传入的纯文本 API Key', () => {
      const cred = parseOpenCodeAuth('sk_opencode_12345678')
      expect(cred.accessToken).toBe('sk_opencode_12345678')
      expect(cred.nickname).toBe('OpenCode API Key')
      expect(cred.domain).toBe('opencode.ai')
    })

    it('解析标准 JSON 中的 apiKey / token / accessToken', () => {
      expect(parseOpenCodeAuth(JSON.stringify({ apiKey: 'key_from_api_key' })).accessToken).toBe('key_from_api_key')
      expect(parseOpenCodeAuth(JSON.stringify({ token: 'key_from_token' })).accessToken).toBe('key_from_token')
      expect(parseOpenCodeAuth(JSON.stringify({ accessToken: 'key_from_access_token' })).accessToken).toBe('key_from_access_token')
    })

    it('解析 opencode.json 中的 provider.opencode.settings.apiKey 结构', () => {
      const opencodeJson = {
        provider: {
          opencode: {
            settings: {
              apiKey: 'opencode_nested_key_999',
            },
          },
        },
      }
      const cred = parseOpenCodeAuth(JSON.stringify(opencodeJson))
      expect(cred.accessToken).toBe('opencode_nested_key_999')
      expect(cred.nickname).toBe('OpenCode API Key')
    })

    it('解析 opencode.apiKey 简写结构', () => {
      const cred = parseOpenCodeAuth(JSON.stringify({ opencode: { apiKey: 'simple_nested_key' } }))
      expect(cred.accessToken).toBe('simple_nested_key')
    })

    it('解析 OpenCode CLI auth.json 中的 { opencode: { type: "api", key: "..." } } 结构', () => {
      const authJson = {
        opencode: {
          type: 'api',
          key: 'sk_from_cli_auth_json',
        },
      }
      const cred = parseOpenCodeAuth(JSON.stringify(authJson))
      expect(cred.accessToken).toBe('sk_from_cli_auth_json')
    })

    it('无 API Key 的 opencode.json 配置（如仅配置 plugins/mcp）安全回退至 public', () => {
      const opencodeConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['superpowers@git+https://github.com/obra/superpowers.git'],
        mcp: {},
      }
      const cred = parseOpenCodeAuth(JSON.stringify(opencodeConfig, null, 2))
      expect(cred.accessToken).toBe('public')
      expect(cred.nickname).toBe('Free Tier (public)')
    })

    it('仅包含其他 Provider 的 auth.json 安全回退至 public', () => {
      const otherAuth = {
        'zhipuai-coding-plan': { type: 'api', key: '123456' },
        'deepseek': { type: 'api', key: 'sk-999999' },
      }
      const cred = parseOpenCodeAuth(JSON.stringify(otherAuth))
      expect(cred.accessToken).toBe('public')
    })

    it('含换行符或花括号的非法文本不被当作 Bearer Token，安全回退至 public', () => {
      expect(parseOpenCodeAuth('sk_invalid\nkey').accessToken).toBe('public')
      expect(parseOpenCodeAuth('{\n "broken": json\n}').accessToken).toBe('public')
    })
  })

  describe('WorkBuddyCredentialStore 针对 OPENCODE_VARIANT 的行为', () => {
    const mockRefresh = async (c: any) => ({ accessToken: c.accessToken })

    it('无配置且无文件时，安全回退到 public 免费通道', async () => {
      const store = new WorkBuddyCredentialStore({
        variant: OPENCODE_VARIANT,
        refresh: mockRefresh,
        ownPath: join(tempDir, 'own.json'),
        desktopPath: join(tempDir, 'non_existent_auth.json'),
      })
      const cred = await store.current()
      expect(cred).toBeDefined()
      expect(cred?.accessToken).toBe('public')
      expect(cred?.nickname).toBe('Free Tier (public)')
      const resolved = await store.resolve()
      expect(resolved.accessToken).toBe('public')
    })

    it('设置 OPENCODE_API_KEY 环境变量时，优先使用环境变量中的密钥', async () => {
      process.env['OPENCODE_API_KEY'] = 'opencode_env_secret_key'
      const store = new WorkBuddyCredentialStore({
        variant: OPENCODE_VARIANT,
        refresh: mockRefresh,
        ownPath: join(tempDir, 'own.json'),
      })
      const cred = await store.current()
      expect(cred).toBeDefined()
      expect(cred?.accessToken).toBe('opencode_env_secret_key')
      expect(cred?.nickname).toBe('OpenCode API Key')
    })

    it('显式配置 desktopPath 为 API Key 文本时，直接提取生效', async () => {
      const store = new WorkBuddyCredentialStore({
        variant: OPENCODE_VARIANT,
        refresh: mockRefresh,
        ownPath: join(tempDir, 'own.json'),
        desktopPath: 'sk_user_custom_direct_key',
      })
      const cred = await store.current()
      expect(cred).toBeDefined()
      expect(cred?.accessToken).toBe('sk_user_custom_direct_key')
    })

    it('显式配置 desktopPath 为文件路径且文件存在时，读取并解析', async () => {
      const authFile = join(tempDir, 'custom_opencode_auth.json')
      await writeFile(authFile, JSON.stringify({ apiKey: 'file_configured_key_123' }), 'utf8')
      const store = new WorkBuddyCredentialStore({
        variant: OPENCODE_VARIANT,
        refresh: mockRefresh,
        ownPath: join(tempDir, 'own.json'),
        desktopPath: authFile,
      })
      const cred = await store.current()
      expect(cred).toBeDefined()
      expect(cred?.accessToken).toBe('file_configured_key_123')
    })

    it('显式配置 desktopPath 为无 apiKey 的 opencode.json 时，安全回退到 public 免费通道', async () => {
      const configFile = join(tempDir, 'opencode.json')
      await writeFile(configFile, JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        plugin: ['superpowers@git+https://github.com/obra/superpowers.git'],
        mcp: {},
      }), 'utf8')
      const store = new WorkBuddyCredentialStore({
        variant: OPENCODE_VARIANT,
        refresh: mockRefresh,
        ownPath: join(tempDir, 'own.json'),
        desktopPath: configFile,
      })
      const cred = await store.current()
      expect(cred).toBeDefined()
      expect(cred?.accessToken).toBe('public')
      expect(cred?.nickname).toBe('Free Tier (public)')
    })
  })
})
