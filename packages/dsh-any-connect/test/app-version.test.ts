import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appUserAgent,
  FALLBACK_APP_VERSION,
  installedAppVersion,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
} from '../src/app-version.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('validAppVersion', () => {
  it('accepts N.N.N[.N] and rejects header-splitting input', () => {
    expect(validAppVersion('5.5.6')).toBe(true)
    expect(validAppVersion('5.5.6.1')).toBe(true)
    expect(validAppVersion('5.5.6\nEvil: 1')).toBe(false)
    expect(validAppVersion('WorkBuddy AI/5.5.6')).toBe(false)
    expect(validAppVersion('')).toBe(false)
    expect(validAppVersion(undefined)).toBe(false)
  })
})

describe('readBundleVersion', () => {
  it('reads CFBundleShortVersionString out of XML plists', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-appver-'))
    const plist = join(root, 'Info.plist')
    await writeFile(plist, `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleName</key><string>WorkBuddy AI</string>
<key>CFBundleShortVersionString</key><string>5.5.6</string>
</dict></plist>`, 'utf8')
    expect(await readBundleVersion(plist)).toBe('5.5.6')
  })

  it('reports missing files and binary plists as unreadable', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-appver-'))
    expect(await readBundleVersion(join(root, 'nope.plist'))).toBeUndefined()
    const binary = join(root, 'binary.plist')
    await writeFile(binary, Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74]))
    expect(await readBundleVersion(binary)).toBeUndefined()
  })
})

describe('installedAppVersion', () => {
  // macOS 上走真实安装路径（有/无 App 结果都合法），只在非 macOS 钉住平台守卫。
  it.skipIf(process.platform === 'darwin')('returns undefined off macOS rather than guessing paths', async () => {
    expect(await installedAppVersion()).toBeUndefined()
  })
})

describe('resolveAppVersion', () => {
  it('prefers the installed App and caches it for later', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-appver-'))
    const path = join(root, '.workbuddy-ai-version.json')
    const first = await resolveAppVersion({
      installed: async () => ({ version: '5.5.6', bundle: 'WorkBuddy AI.app' }),
      path,
    })
    expect(first).toEqual({ version: '5.5.6', source: 'installed', bundle: 'WorkBuddy AI.app' })
    // Uninstalled later: the saved value applies.
    const second = await resolveAppVersion({ installed: async () => undefined, path })
    expect(second).toEqual({ version: '5.5.6', source: 'saved' })
  })

  it('falls back to the compiled-in constant when nothing is readable', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-appver-'))
    const resolved = await resolveAppVersion({
      installed: async () => undefined,
      path: join(root, 'missing.json'),
    })
    expect(resolved).toEqual({ version: FALLBACK_APP_VERSION, source: 'fallback' })
  })

  it('ignores a malformed saved value', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-appver-'))
    const path = join(root, '.workbuddy-ai-version.json')
    await writeFile(path, '{"version":"5.5.6\nEvil"}', 'utf8')
    const resolved = await resolveAppVersion({ installed: async () => undefined, path })
    expect(resolved.source).toBe('fallback')
  })
})

describe('appUserAgent', () => {
  it('builds the spaceless form the gateway splits on', () => {
    expect(appUserAgent('5.5.6')).toBe('WorkBuddyAI/5.5.6')
  })

  it('throws rather than sending a malformed header', () => {
    expect(() => appUserAgent('5.5.6\nEvil: 1')).toThrow()
  })
})
