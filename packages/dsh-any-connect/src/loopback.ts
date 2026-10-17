/**
 * Loopback request guards shared by the status and probe-control routes.
 *
 * Ported from corrinehu/dsh-workbuddy-connect `src/loopback.ts` (MIT).
 *
 * @module dsh-any-connect/loopback
 */

/** Host spellings that name this machine's loopback interface. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Strip an optional `:port` suffix, IPv6-bracket aware. */
function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    // [v6] 或 [v6]:port → 取括号内：浏览器经 IPv6 同源访问页面时 Host
    // 恒为 `[::1]:port`，拒绝它会把插件自己的 fetch 一起杀掉（宿主支持
    // 0.0.0.0 监听，此时 IPv6 回环可达）。括号不闭合、或括号后跟的不
    // 是空串/:纯数字端口，原样返回（必不在清单内，fail-closed）。
    const end = hostname.indexOf(']')
    if (end === -1) return hostname
    const rest = hostname.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return hostname
    return hostname.slice(0, end + 1)
  }
  // A trailing `:port` follows the last colon only when the head holds no
  // other colon (otherwise it is part of a bare IPv6 literal, which without
  // brackets is not a legal Host spelling anyway).
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
 * Host, so this check drops those before any routing happens.
 */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser
 * clients (the plugin's own fetch calls) send no Origin at all and pass.
 *
 * 空串 Origin 也按「非浏览器客户端」放行（本插件自己的 fetch 不带 Origin，
 * 浏览器不会发空串）。注意 provider-usage 的同名函数在此**唯一一处**收紧
 * 为拒绝（「分化时偏向拒绝」）；且 provider-usage 的 IP 字面量判定已委托
 * 宿主 `isLoopbackHost`（127/8 全段等），本包保留本地 4 词精确名单——
 * 两边不再逐字一致（实测分歧见根 test/loopback-parity.test.ts 的注释），
 * 所以一致性由**两处**共同守：根 `test/loopback-parity.test.ts` 用真值表
 * 钉住共享语义与「分化恰好是空串 Origin」，本包 `test/loopback.test.ts`
 * 钉住 4 词名单的失败关闭语义。
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}
