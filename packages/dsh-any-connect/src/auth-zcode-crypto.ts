/**
 * auth-zcode-crypto.ts — ZCode 凭据里 enc:v1 与 enc:v2 值的解密（AES-256-GCM）。
 *
 * 历史与格式演进：
 * - enc:v1：基于 zcode-credential-fallback 的伪静态派生密钥（单机/跨系统容错）。
 *   格式：enc:v1:<iv>.<tag>.<cipherBuffer>
 * - enc:v2（3.18.2+）：引入系统安全存储（OS Keyring，service="ZCode Credential Encryption"）
 *   与环境/文件托管存储（env / credential-secret），密文格式为：
 *   enc:v2:<source>:<keyFingerprint>:<iv>.<tag>.<cipherBuffer>
 *   其中 keyFingerprint 为 32 字节 AES 密钥的 SHA-256 前 24 位十六进制。
 *
 * 本模块实现两代格式的自适应解密，并对已解析的 32 字节密钥进行内存缓存。
 *
 * @module dsh-any-connect/auth-zcode-crypto
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isWsl, windowsPathForWsl } from './auth-paths.js'

const require = createRequire(import.meta.url)

export interface DecryptZCodeKeyOptions {
  desktopPath?: string
  platform?: string
  homedir?: string
  username?: string
  /** 显式提供用于解密的 32 字节 key、43 字符 base64url 密码或 raw secret（测试/显式注入）。 */
  secret?: string | Buffer
  /** 显式指定 ZCode 可执行文件路径。 */
  zcodeBin?: string
  /** 显式指定 @napi-rs/keyring .node 文件路径。 */
  keyringNodePath?: string
  /** 自定义密钥解析钩子（单测/自定义环境注入）。 */
  keyResolver?: (context: {
    source: 'os' | 'env'
    keyFingerprint: string
    desktopPath?: string
    account: string
  }) => Buffer | undefined
  /** 显式传入 keyCache，默认使用模块级全局内存缓存。 */
  keyCache?: Map<string, Buffer>
}

/** 模块级 32-byte AES 密钥内存缓存，按 24 位 keyFingerprint 索引。 */
const MEMORY_KEY_CACHE = new Map<string, Buffer>()

/** 清理全局密钥缓存（供测试重置状态使用）。 */
export function clearZCodeKeyCache(): void {
  MEMORY_KEY_CACHE.clear()
}

/** 预置全局密钥缓存（供测试注入已知密钥使用）。 */
export function setZCodeKeyCache(fingerprint: string, key: Buffer): void {
  MEMORY_KEY_CACHE.set(fingerprint, key)
}

/** 计算 32 字节 AES 密钥的 24 位十六进制指纹。 */
export function computeZCodeKeyFingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)
}

/** ZCode 客户端 Keyring 服务名。 */
const KEYRING_SERVICE = 'ZCode Credential Encryption'

/** 单行内嵌 helper 脚本：通过 ZCode 客户端内部的 @napi-rs/keyring 读取系统密钥。 */
const KEYRING_HELPER_SCRIPT = 'const p=require("node:path"),f=require("node:fs"),a=process.argv[1],c=[p.join(p.dirname(p.dirname(process.execPath)),"Resources","app.asar.unpacked","node_modules","@napi-rs"),p.join(p.dirname(process.execPath),"resources","app.asar.unpacked","node_modules","@napi-rs")];let k;for(const d of c){try{for(const s of f.readdirSync(d)){if(s.startsWith("keyring-")){for(const n of f.readdirSync(p.join(d,s))){if(n.endsWith(".node")){k=p.join(d,s,n);break;}}if(k)break;}}}catch{}if(k)break;}if(!k)process.exit(1);const m=require(k),e=new m.Entry("ZCode Credential Encryption",a),w=e.getPassword();if(!w)process.exit(2);process.stdout.write(w);'

/** 候选 ZCode 可执行文件发现。 */
function resolveZCodeBin(configured?: string, platform: string = process.platform): string | undefined {
  if (configured && existsSync(configured)) return configured
  const envBin = process.env.ZCODE_ELECTRON_BIN?.trim()
  if (envBin && existsSync(envBin)) return envBin

  const home = homedir()
  const candidates: string[] = []
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/ZCode.app/Contents/MacOS/ZCode',
      join(home, 'Applications', 'ZCode.app', 'Contents', 'MacOS', 'ZCode'),
    )
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    candidates.push(
      join(localAppData, 'Programs', 'ZCode', 'ZCode.exe'),
      join(localAppData, 'ZCode', 'ZCode.exe'),
      join(programFiles, 'ZCode', 'ZCode.exe'),
    )
  } else if (platform === 'linux') {
    candidates.push(
      '/opt/ZCode/zcode',
      '/usr/bin/zcode',
      join(home, '.local', 'share', 'zcode', 'zcode'),
    )
    if (isWsl()) {
      const winProfile = windowsPathForWsl(process.env['USERPROFILE'])
      const winLocal = windowsPathForWsl(process.env['LOCALAPPDATA'])
      if (winLocal) {
        candidates.push(join(winLocal, 'Programs', 'ZCode', 'ZCode.exe'))
        candidates.push(join(winLocal, 'ZCode', 'ZCode.exe'))
      } else if (winProfile) {
        candidates.push(join(winProfile, 'AppData', 'Local', 'Programs', 'ZCode', 'ZCode.exe'))
      }
    }
  }

  for (const cand of candidates) {
    try {
      if (existsSync(cand)) return cand
    } catch {}
  }
  return undefined
}

/** 候选 @napi-rs/keyring .node 文件发现。 */
function resolveZCodeKeyringNode(configured?: string, platform: string = process.platform): string | undefined {
  if (configured && existsSync(configured)) return configured
  const envNode = process.env.ZCODE_KEYRING_NODE?.trim()
  if (envNode && existsSync(envNode)) return envNode

  const home = homedir()
  const searchDirs: string[] = []
  if (platform === 'darwin') {
    searchDirs.push(
      '/Applications/ZCode.app/Contents/Resources/app.asar.unpacked/node_modules/@napi-rs',
      join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@napi-rs'),
    )
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    searchDirs.push(
      join(localAppData, 'Programs', 'ZCode', 'resources', 'app.asar.unpacked', 'node_modules', '@napi-rs'),
      join(localAppData, 'ZCode', 'resources', 'app.asar.unpacked', 'node_modules', '@napi-rs'),
      join(programFiles, 'ZCode', 'resources', 'app.asar.unpacked', 'node_modules', '@napi-rs'),
    )
  } else if (platform === 'linux') {
    searchDirs.push(
      '/opt/ZCode/resources/app.asar.unpacked/node_modules/@napi-rs',
      join(home, '.local', 'share', 'zcode', 'resources', 'app.asar.unpacked', 'node_modules', '@napi-rs'),
    )
  }

  for (const dir of searchDirs) {
    try {
      if (!existsSync(dir)) continue
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (!entry.startsWith('keyring-')) continue
        const subDir = join(dir, entry)
        const subFiles = readdirSync(subDir)
        for (const file of subFiles) {
          if (file.endsWith('.node')) {
            const full = join(subDir, file)
            if (existsSync(full)) return full
          }
        }
      }
    } catch {}
  }
  return undefined
}

/** 通过 ZCode Electron 二进制（ELECTRON_RUN_AS_NODE=1）运行 helper 提取密码。 */
function resolveKeyringPasswordViaHelper(zcodeBin: string, account: string): string | undefined {
  try {
    const stdout = execFileSync(zcodeBin, ['-e', KEYRING_HELPER_SCRIPT, account], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const trimmed = stdout.trim()
    return trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}

/** 通过动态加载 @napi-rs/keyring .node 原生模块提取密码。 */
function resolveKeyringPasswordViaNodeModule(nodePath: string, account: string): string | undefined {
  try {
    const mod = require(nodePath) as {
      Entry: new (service: string, account: string) => { getPassword: () => string | null }
    }
    const entry = new mod.Entry(KEYRING_SERVICE, account)
    const pwd = entry.getPassword()
    return pwd ? pwd.trim() : undefined
  } catch {
    return undefined
  }
}

/** 在 macOS 上通过系统 security 命令行工具尝试读取通用密码（短超时 1000ms）。 */
function resolveKeyringPasswordViaCli(account: string, platform: string = process.platform): string | undefined {
  if (platform !== 'darwin') return undefined
  try {
    const stdout = execFileSync('security', [
      'find-generic-password',
      '-s', KEYRING_SERVICE,
      '-a', account,
      '-w',
    ], {
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const trimmed = stdout.trim()
    return trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}

/** 尝试将给定的原始材料归一化为 32 字节 AES key。 */
function tryKeyCandidate(raw: string | Buffer, expectedFingerprint: string): Buffer | undefined {
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 32 && computeZCodeKeyFingerprint(raw) === expectedFingerprint) {
      return raw
    }
    return undefined
  }
  const text = raw.trim()
  if (text === '') return undefined

  // 1. 若为 43 字符 base64url 编码（keyring 原生格式，32 字节）
  if (text.length === 43 && /^[A-Za-z0-9_-]+$/.test(text)) {
    try {
      const decoded = Buffer.from(text, 'base64url')
      if (decoded.length === 32 && computeZCodeKeyFingerprint(decoded) === expectedFingerprint) {
        return decoded
      }
    } catch {}
  }

  // 2. 尝试作为 raw secret 进行 sha256 派生（env: 模式标准语义）
  const hashed = crypto.createHash('sha256').update(text, 'utf8').digest()
  if (computeZCodeKeyFingerprint(hashed) === expectedFingerprint) {
    return hashed
  }

  return undefined
}

/** 解密 enc:v2 密文 */
function decryptV2(encStr: string, options?: DecryptZCodeKeyOptions): string {
  const parts = encStr.slice('enc:v2:'.length).split(':')
  if (
    parts.length !== 3
    || !parts[0]
    || !parts[1]
    || !parts[2]
    || !['os', 'env'].includes(parts[0])
    || !/^[a-f0-9]{24}$/.test(parts[1])
  ) {
    throw new Error('Invalid ZCode enc:v2 credential format')
  }

  const [source, keyFingerprint, payload] = parts as ['os' | 'env', string, string]
  const payloadParts = payload.split('.')
  if (payloadParts.length !== 3 || !payloadParts[0] || !payloadParts[1] || !payloadParts[2]) {
    throw new Error('Invalid ZCode enc:v2 credential format')
  }

  const [ivB64, tagB64, cipherB64] = payloadParts
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const cipherBuffer = Buffer.from(cipherB64, 'base64url')

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid ZCode enc:v2 credential format')
  }

  const cache = options?.keyCache ?? MEMORY_KEY_CACHE
  let key = cache.get(keyFingerprint)

  if (!key) {
    if (source === 'env') {
      const candidateSecrets: (string | Buffer)[] = []
      if (options?.secret !== undefined) candidateSecrets.push(options.secret)
      if (process.env.ZCODE_CREDENTIAL_SECRET) candidateSecrets.push(process.env.ZCODE_CREDENTIAL_SECRET)
      if (process.env.ZCODE_CREDENTIAL_SECRET_FILE) {
        try {
          candidateSecrets.push(readFileSync(process.env.ZCODE_CREDENTIAL_SECRET_FILE, 'utf8'))
        } catch {}
      }
      if (options?.desktopPath) {
        try {
          const secretFile = join(dirname(options.desktopPath), 'credential-secret')
          if (existsSync(secretFile)) {
            candidateSecrets.push(readFileSync(secretFile, 'utf8'))
          }
        } catch {}
      }

      for (const secret of candidateSecrets) {
        const candidate = tryKeyCandidate(secret, keyFingerprint)
        if (candidate) {
          key = candidate
          break
        }
      }
    } else {
      // source === 'os'
      const credFilePath = options?.desktopPath
        ? resolve(options.desktopPath)
        : resolve(homedir(), '.zcode', 'v2', 'credentials.json')
      const account = crypto.createHash('sha256').update(credFilePath).digest('hex')

      // 1. 优先自定义 keyResolver
      if (options?.keyResolver) {
        const resolved = options.keyResolver({ source, keyFingerprint, desktopPath: options.desktopPath, account })
        if (resolved && resolved.length === 32 && computeZCodeKeyFingerprint(resolved) === keyFingerprint) {
          key = resolved
        }
      }

      // 2. 检查 options?.secret 与环境变量 ZCODE_CREDENTIAL_SECRET
      if (!key && options?.secret !== undefined) {
        key = tryKeyCandidate(options.secret, keyFingerprint)
      }
      if (!key && process.env.ZCODE_CREDENTIAL_SECRET) {
        key = tryKeyCandidate(process.env.ZCODE_CREDENTIAL_SECRET, keyFingerprint)
      }

      // 3. 优先通过 ZCode Electron 二进制 helper 提取（真实安装最快且无 Keychain 延迟）
      if (!key) {
        const zcodeBin = resolveZCodeBin(options?.zcodeBin, options?.platform)
        if (zcodeBin) {
          const pwd = resolveKeyringPasswordViaHelper(zcodeBin, account)
          if (pwd) {
            key = tryKeyCandidate(pwd, keyFingerprint)
          }
        }
      }

      // 4. 尝试直接 require @napi-rs/keyring .node 原生模块
      if (!key) {
        const nodePath = resolveZCodeKeyringNode(options?.keyringNodePath, options?.platform)
        if (nodePath) {
          const pwd = resolveKeyringPasswordViaNodeModule(nodePath, account)
          if (pwd) {
            key = tryKeyCandidate(pwd, keyFingerprint)
          }
        }
      }

      // 5. 尝试系统 CLI（macOS security）
      if (!key) {
        const pwd = resolveKeyringPasswordViaCli(account, options?.platform)
        if (pwd) {
          key = tryKeyCandidate(pwd, keyFingerprint)
        }
      }

      // 6. 尝试凭据目录下的 credential-secret 文件
      if (!key && options?.desktopPath) {
        try {
          const secretFile = join(dirname(options.desktopPath), 'credential-secret')
          if (existsSync(secretFile)) {
            const content = readFileSync(secretFile, 'utf8')
            key = tryKeyCandidate(content, keyFingerprint)
          }
        } catch {}
      }
    }
  }

  if (!key) {
    throw new Error(
      `Unable to resolve ZCode enc:v2 key (source: ${source}, fingerprint: ${keyFingerprint});`
      + ' unlock the OS keyring or configure ZCODE_CREDENTIAL_SECRET',
    )
  }

  cache.set(keyFingerprint, key)

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(cipherBuffer), decipher.final()]).toString('utf8')
  } catch (err: unknown) {
    throw new Error(`Failed to decrypt ZCode enc:v2 credential: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 解密 enc:v1 密文（向后兼容） */
function decryptV1(encStr: string, options?: DecryptZCodeKeyOptions): string {
  const parts = encStr.slice('enc:v1:'.length).split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Invalid ZCode enc:v1 credential format')
  }
  const [ivB64, tagB64, cipherB64] = parts
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const cipherBuffer = Buffer.from(cipherB64, 'base64url')

  let currentUsername = 'unknown'
  try {
    currentUsername = os.userInfo().username
  } catch {}

  const currentPlatform = options?.platform ?? (process.platform || os.platform())
  const currentHomedir = options?.homedir ?? homedir()

  const secrets: string[] = []

  // 1. Explicit env override if set
  if (process.env.ZCODE_CREDENTIAL_SECRET) {
    secrets.push(process.env.ZCODE_CREDENTIAL_SECRET)
  }

  // 2. Explicit options if passed
  if (options?.platform && options?.homedir && options?.username) {
    secrets.push(`zcode-credential-fallback:${options.platform}:${options.homedir}:${options.username}`)
  }

  // 3. Current host runtime fallback
  secrets.push(`zcode-credential-fallback:${currentPlatform}:${currentHomedir}:${currentUsername}`)
  if (os.homedir() !== currentHomedir) {
    secrets.push(`zcode-credential-fallback:${currentPlatform}:${os.homedir()}:${currentUsername}`)
  }

  // 4. If desktopPath is a Windows path mounted in WSL (/mnt/<drive>/Users/<user>/...):
  const pathToCheck = options?.desktopPath
  if (pathToCheck) {
    const mntMatch = /^\/mnt\/([a-zA-Z])\/Users\/([^/]+)/iu.exec(pathToCheck)
    if (mntMatch) {
      const drive = mntMatch[1]!.toUpperCase()
      const winUser = mntMatch[2]!
      secrets.push(`zcode-credential-fallback:win32:${drive}:\\Users\\${winUser}:${winUser}`)
      secrets.push(`zcode-credential-fallback:win32:${drive}:/Users/${winUser}:${winUser}`)
    }
  }

  // 5. If running inside WSL, try Windows user profile credentials
  if (isWsl()) {
    const winProfile = windowsPathForWsl(process.env['USERPROFILE'])
    const winUser = winProfile ? basename(winProfile) : basename(currentHomedir)
    secrets.push(`zcode-credential-fallback:win32:C:\\Users\\${winUser}:${winUser}`)
    secrets.push(`zcode-credential-fallback:win32:C:/Users/${winUser}:${winUser}`)
    secrets.push(`zcode-credential-fallback:win32:C:\\Users\\${currentUsername}:${currentUsername}`)
    secrets.push(`zcode-credential-fallback:win32:C:/Users/${currentUsername}:${currentUsername}`)
  }

  // 6. If on Windows, check USERPROFILE and USERNAME env vars
  if (currentPlatform === 'win32') {
    const winProfile = process.env['USERPROFILE']
    const winUser = process.env['USERNAME'] ?? currentUsername
    if (winProfile) {
      secrets.push(`zcode-credential-fallback:win32:${winProfile}:${winUser}`)
      secrets.push(`zcode-credential-fallback:win32:${winProfile.replace(/\\/g, '/')}:${winUser}`)
    }
  }

  const candidateSecrets = [...new Set(secrets)]
  let lastError: unknown
  for (const secret of candidateSecrets) {
    try {
      const aesKey = crypto.createHash('sha256').update(secret).digest()
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(cipherBuffer), decipher.final()]).toString('utf8')
    } catch (err) {
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Invalid ZCode enc:v1 credential format')
}

/**
 * 解密 ZCode 加密凭据（自动识别 enc:v1 / enc:v2；非 enc: 前缀原样返回）。
 */
export function decryptZCodeEncryptedKey(
  encStr: string,
  options?: DecryptZCodeKeyOptions,
): string {
  if (!encStr.startsWith('enc:')) return encStr
  if (encStr.startsWith('enc:v1:')) return decryptV1(encStr, options)
  if (encStr.startsWith('enc:v2:')) return decryptV2(encStr, options)
  throw new Error('Unsupported ZCode credential encryption version')
}

// 供单元测试覆盖平台发现分支
export { resolveZCodeBin, resolveZCodeKeyringNode, resolveKeyringPasswordViaCli }
