import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ANYCONNECT_VERSION } from '../src/version.js'

/**
 * Guard the single-source-of-truth version contract: src/version.ts reads
 * package.json, so the reported version always tracks the manifest. If that
 * read ever breaks, version.ts falls back to '0.0.0-dev' and the second test
 * goes red, flagging the regression (and the drift it would cause in heartbeat
 * / CLI output).
 *
 * Unlike the upstream project this package came from, the version is NOT a
 * build-time `define`: this monorepo builds with plain `tsc`, which has no
 * define facility. Reading the manifest at runtime also removes the stale-
 * artifact failure mode a define has — bumping the version after a build can
 * no longer ship artifacts reporting the old one.
 */
describe('package version sync', () => {
  it('ANYCONNECT_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(ANYCONNECT_VERSION).toBe(pkg.version)
  })

  /**
   * The runtime read resolves package.json relative to the module, so the built
   * `lib/version.js` must be able to reach the manifest from its own location
   * (`lib/` → `../package.json`). Guarding that keeps a build-layout change
   * from silently degrading the published CLI to the '0.0.0-dev' fallback.
   * Skipped on a fresh clone before the first build.
   */
  it.skipIf(!existsSync(new URL('../lib/', import.meta.url)))('built lib/ artifact resolves the manifest version', async () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const built = await import(new URL('../lib/version.js', import.meta.url).href)
    expect(built.ANYCONNECT_VERSION, 'lib/version.js could not resolve package.json — the published CLI would report the fallback').toBe(pkg.version)
  })
})
