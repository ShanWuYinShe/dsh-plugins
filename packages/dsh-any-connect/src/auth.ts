/**
 * auth.ts — 凭据解析门面（对外 API 不变）。
 *
 * 实现拆分：
 * - ./auth-types.js：类型与 RegionMismatchError；
 * - ./auth-paths.js：认证文件路径解析；
 * - ./auth-zcode.js：ZCode 凭据/计划/device-mid 解析；
 * - ./auth-document.js：WorkBuddy 凭据文档解析；
 * - ./auth-store.js：WorkBuddyCredentialStore。
 *
 * 2026-10-08 拆分前这里是 1160 行的单体文件；调用方继续从这里取。
 *
 * @module dsh-any-connect/auth
 */
export { RegionMismatchError } from './auth-types.js'
export type { WorkBuddyCredential, WorkBuddyAuthStatus, WorkBuddyStoreOptions, ZCodeFamily, ZCodePlanKind } from './auth-types.js'
export { WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, workbuddyOwnAuthPath, defaultDesktopAuthCandidates, defaultZCodeDesktopCandidates, desktopAuthCandidatesFor } from './auth-paths.js'
export { decryptZCodeEncryptedKey, parseZCodePlanSelection, selectZCodeAccountKey, parseZCodeAuth } from './auth-zcode.js'
export type { DecryptZCodeKeyOptions, ZCodeAccountSelection } from './auth-zcode.js'
export { parseWorkBuddyAuth } from './auth-document.js'
export { WorkBuddyCredentialStore } from './auth-store.js'
