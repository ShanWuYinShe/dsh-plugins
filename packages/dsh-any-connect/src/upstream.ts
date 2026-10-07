/**
 * upstream.ts — 上游客户端门面（对外 API 不变）。
 *
 * 实现按产品拆分：
 * - ./upstream-shared.js：协议类型、常量与两客户端共用助手；
 * - ./upstream-workbuddy.js：WorkBuddy（CodeBuddy / copilot.tencent.com）；
 * - ./upstream-zcode.js：ZCode（bigmodel 订阅通道 + Start Plan）。
 *
 * 2026-10-08 拆分前这里是 1765 行的单体文件；调用方一律继续从这里取。
 *
 * @module dsh-any-connect/upstream
 */
export { normalizeCredits, isZCodeOffpeak, modelWithCurrentPromotion, classifyUpstreamError } from './upstream-shared.js'
export type { UpstreamErrorKind, WorkBuddyUpstreamModel, WorkBuddyModelReasoning, WorkBuddyEffort, WorkBuddyModelBilling, WorkBuddyPromotion, WorkBuddyCreditAccount, WorkBuddyCredits, WorkBuddyRefreshOutcome, WorkBuddyChatResult } from './upstream-shared.js'
export { regionOf, chatBase, prepareChatBody, prepareInternationalChatBody, WorkBuddyUpstreamClient } from './upstream-workbuddy.js'
export type { WorkBuddyRegion, WorkBuddyUpstreamClientOptions } from './upstream-workbuddy.js'
export { prepareAnthropicBody, ZCodeUpstreamClient } from './upstream-zcode.js'
export type { ZCodeUpstreamClientOptions } from './upstream-zcode.js'
