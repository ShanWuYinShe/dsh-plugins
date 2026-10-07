/**
 * auth-zcode-crypto.ts — ZCode 凭据里 enc:v1 值的解密（AES-256-GCM）。
 *
 * 2026-10-08 从 343 行的 auth-zcode.ts 拆出：这段只依赖环境与选项（无文件 I/O），
 * 与账号/计划解析无关；单独成模块后可以直接构造密文喂样本测试。
 *
 * 密钥候选按「显式 env → 显式选项 → 当前运行时 → WSL/Windows 的宿主 profile」顺序尝试，
 * 全部失败才抛错（最后一个错误原样抛出，便于定位是「格式不对」还是「密钥不对」）。
 *
 * @module dsh-any-connect/auth-zcode-crypto
 */

import crypto from 'node:crypto'
import os from 'node:os'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { isWsl, windowsPathForWsl } from './auth-paths.js'

export interface DecryptZCodeKeyOptions {
  desktopPath?: string
  platform?: string
  homedir?: string
  username?: string
}

/** Decrypt enc:v1:<iv>.<tag>.<cipher> encrypted values from credentials.json */
export function decryptZCodeEncryptedKey(
  encStr: string,
  options?: DecryptZCodeKeyOptions,
): string {
  if (!encStr.startsWith('enc:v1:')) return encStr
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

  const currentPlatform = process.platform || os.platform()
  const currentHomedir = homedir()

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
