/**
 * catalog-harness.ts — catalog 系列测试共用的 fixture。
 *
 * 2026-10-08 抽取：catalog-refresh 与 catalog-start-plan-fastpath 各自抄了一份
 * 逐字相同的凭据 fixture 与目录行 fixture。两个 fixture 都是纯函数，抽到这里后
 * 只有一份定义，改口径不会漏改另一处。
 *
 * **为什么收尾块没有一起抽**：三个文件确实有逐字相同的 afterEach（dispose fiber +
 * 删临时目录 + 跑清理回调），但它读写的是各文件自己的 \\`context\\` / \\`root\\` 局部变量；
 * 抽成共享实现就得把这些可变状态搬进共享对象，改动面比重复本身更大、风险更高。
 * 这里只记录这个取舍，收尾逻辑仍留在各文件（改动时请三处同步）。
 *
 * @module dsh-any-connect/test/catalog-harness
 */

import type { WorkBuddyModelInfo } from '../src/index.js'

/** 一份已登录的桌面凭据文件，内容只是“看起来登录了”，测试不触真上游。 */
export function signedInDocument(): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1', nickname: '昵称' },
  })
}

/** 一行目录（展示字段之外的字段测试不关心）。 */
export function catalogRow(id: string, name = id): WorkBuddyModelInfo {
  return { id, name, contextWindow: 1000, maxTokens: 100, supportsImages: false }
}
