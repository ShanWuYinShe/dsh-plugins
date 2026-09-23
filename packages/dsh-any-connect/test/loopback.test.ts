import { describe, expect, it } from 'vitest'
import { hostIsLoopback, originIsLoopback } from '../src/loopback.js'

/**
 * DNS-rebinding / loopback Host 校验（status 与 probe-control 路由共用的
 * 安全防护）。rebinding 页面把自己的域名解析到 127.0.0.1 后，请求的 Host
 * 仍是攻击者域名——校验必须在任何路由发生之前把它拒掉，所以这里钉死的
 * 是「只放行本机回环拼写」的失败关闭语义：不在清单里的一律拒绝。
 */
describe('hostIsLoopback', () => {
  it('accepts the exact loopback spellings', () => {
    expect(hostIsLoopback('localhost')).toBe(true)
    expect(hostIsLoopback('127.0.0.1')).toBe(true)
    expect(hostIsLoopback('::1')).toBe(true)
    expect(hostIsLoopback('[::1]')).toBe(true)
  })

  it('accepts loopback hosts with a port suffix', () => {
    expect(hostIsLoopback('localhost:3000')).toBe(true)
    expect(hostIsLoopback('127.0.0.1:8787')).toBe(true)
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(hostIsLoopback('LOCALHOST')).toBe(true)
    expect(hostIsLoopback('  localhost  ')).toBe(true)
    expect(hostIsLoopback('\t127.0.0.1\n')).toBe(true)
  })

  it('rejects a bracketed IPv6 host with a port (fail-closed)', () => {
    // 端口剥离只认「头段无冒号 + 尾段纯数字」：[::1] 头段含冒号，整体
    // 不被剥离也不在清单里，按当前语义拒绝。防护代码允许保守拒绝——
    // 浏览器对 localhost 通常发不带端口的 IPv6 或 IPv4 Host。
    expect(hostIsLoopback('[::1]:8080')).toBe(false)
    // 裸 IPv6 带端口本就不是合法 Host 拼写，同样拒绝。
    expect(hostIsLoopback('::1:8080')).toBe(false)
  })

  it('does not strip a non-numeric or empty port suffix', () => {
    expect(hostIsLoopback('localhost:abc')).toBe(false)
    expect(hostIsLoopback('localhost:')).toBe(false)
  })

  it('rejects attacker domains, including rebinding-lookalike spellings', () => {
    expect(hostIsLoopback('evil.com')).toBe(false)
    expect(hostIsLoopback('localhost.evil.com')).toBe(false)
    expect(hostIsLoopback('127.0.0.1.evil.com')).toBe(false)
  })

  it('rejects non-loopback addresses outside the exact-spelling set', () => {
    // 清单是精确拼写而非网段判断：0.0.0.0 与 127.0.0.2 都不在其中。
    expect(hostIsLoopback('0.0.0.0')).toBe(false)
    expect(hostIsLoopback('127.0.0.2')).toBe(false)
  })

  it('rejects missing or blank Host headers', () => {
    expect(hostIsLoopback(undefined)).toBe(false)
    expect(hostIsLoopback('')).toBe(false)
    expect(hostIsLoopback('   ')).toBe(false)
  })
})

describe('originIsLoopback', () => {
  it('passes when Origin is absent (non-browser clients)', () => {
    // 插件自身的 fetch 不带 Origin，放行是默认态；浏览器一定会带。
    expect(originIsLoopback(undefined)).toBe(true)
    expect(originIsLoopback('')).toBe(true)
    expect(originIsLoopback('   ')).toBe(true)
  })

  it('accepts loopback origins with any port and path', () => {
    expect(originIsLoopback('http://localhost:3000')).toBe(true)
    expect(originIsLoopback('http://127.0.0.1:8787')).toBe(true)
    expect(originIsLoopback('http://127.0.0.1/path?x=1')).toBe(true)
    // URL 会剥掉 IPv6 字面量的方括号，hostname 落回 ::1。
    expect(originIsLoopback('https://[::1]:3000/')).toBe(true)
  })

  it('is case-insensitive on the origin host', () => {
    expect(originIsLoopback('HTTPS://LOCALHOST:3000')).toBe(true)
  })

  it('rejects cross origins, including rebinding-lookalike spellings', () => {
    expect(originIsLoopback('https://evil.example.com')).toBe(false)
    expect(originIsLoopback('http://localhost.evil.com')).toBe(false)
  })

  it('rejects unparseable and non-http origins', () => {
    expect(originIsLoopback('not a url')).toBe(false)
    expect(originIsLoopback('http://')).toBe(false)
    // javascript: 等 scheme 的 hostname 为空串，不在清单里。
    expect(originIsLoopback('javascript:alert(1)')).toBe(false)
  })
})
