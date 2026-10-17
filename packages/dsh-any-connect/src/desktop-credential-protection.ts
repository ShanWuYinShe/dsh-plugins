/**
 * desktop-credential-protection.ts — 门面（对外 API 不变）。
 *
 * 实现拆分：
 * - ./desktop-auth-envelope.js：凭据信封分类/解封/AAD；
 * - ./desktop-discovery.js：发现共享层、macOS 发现与错误分类；
 * - ./desktop-discovery-windows.js：Windows 注册表发现；
 * - ./desktop-at-rest-key.js：at-rest 保护密钥解析器。
 *
 * 2026-10-08 拆分前这里是 1196 行的单体文件；调用方继续从这里取。
 *
 * @module dsh-any-connect/desktop-credential-protection
 */
export { keyIdsOf, classifyDesktopAuthDocument, unwrapDesktopAuthDocument, buildAuthenticatedContextAad, openAuthField, sealAuthFieldForTest, parseAtRestPayload, deriveProtectorKey } from './desktop-auth-envelope.js'
export type { WorkBuddySignedOutReasonCode, DesktopAuthFormat, WorkBuddyEnvelope, WrappedAuthField, DesktopAuthClassification, WorkBuddyAtRestPayload } from './desktop-auth-envelope.js'
export { WORKBUDDY_ELECTRON_BIN_ENV, defaultWorkBuddyElectronPath, electronDiscoveryFor, WorkBuddyElectronPathError, reasonCodeOf } from './desktop-discovery.js'
export type { WorkBuddyElectronDiscovery, WorkBuddyDiscoveryTools } from './desktop-discovery.js'
export { workBuddyWindowsDiscoveryTools } from './desktop-discovery-windows.js'
export type { WorkBuddyWindowsDiscoveryTools } from './desktop-discovery-windows.js'
export { atRestKeyProviderFor, WorkBuddyAtRestKeyProvider } from './desktop-at-rest-key.js'
export type { WorkBuddyKeyPayloadSource, WorkBuddyAtRestKeyProviderOptions } from './desktop-at-rest-key.js'
