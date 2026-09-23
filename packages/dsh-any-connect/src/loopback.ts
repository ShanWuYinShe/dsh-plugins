/**
 * Loopback request guards shared by the status and probe-control routes.
 *
 * Ported from corrinehu/dsh-workbuddy-connect `src/loopback.ts` (MIT).
 *
 * @module dsh-any-connect/loopback
 */

/** Host spellings that name this machine's loopback interface. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Strip an optional `:port` suffix without breaking bare IPv6 literals. */
function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  // A trailing `:port` follows the last colon only when the head holds no
  // other colon (otherwise it is part of an IPv6 literal).
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
