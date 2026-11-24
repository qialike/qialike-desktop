/**
 * The rows the 0.2.0-rc.2 upgrade added, and the ones whose safety is a name comparison.
 *
 * WHY THIS SUITE EXISTS. Moving the harness gate from 0.1.7-rc.2 to 0.2.0-rc.2 pulled in 448 upstream
 * commits, and three of the row changes are invisible to every static check this repository had:
 *
 *   1. **`desktop-product-telemetry` and `product-analytics` are new, and both are guarded by
 *      `ctx.get('profileContext')?.name !== 'desktop'`.** This application's profile is named
 *      `qialike-desktop`, so the guard keeps them off. That is safe today and *accidentally* so: the
 *      safety rests on a name comparison, which means renaming the profile would silently start
 *      shipping analytics. The assertion makes the dependency explicit.
 *   2. **`otel` is a new base row with no `disabled` key, so it mounts.** Whether that matters is a
 *      question about *what consumes the service*, and the answer is unchanged by the upgrade — but
 *      that had to be established rather than assumed, and it is recorded below.
 *   3. **`ui-settings-session-log` is a new web-app row that brought the `session-log-deepseek`
 *      settings namespace with it**, which is why the namespace count moved 14 → 15. A row that
 *      silently failed to mount would show up here as a smaller number.
 *
 * HOW THE STATE IS READ, because the obvious way is wrong. `entry.options.disabled` holds the raw
 * `!!js "…"` expression — a truthy *string* — so reading it reports `false` for every row and would
 * have asserted the exact opposite of the truth. The evaluated flag is `entry.disabled`, which is what
 * upstream's own loader sweep reads, and `entry.fiber.state` (2 = active) distinguishes disabled from
 * mounted. Both are read by the probe; this file asserts on its report.
 *
 * The probe boots the profile in-process, so it is skipped when the runtime tree is absent.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'profile-additions-probe.mjs')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

/** `fiber.state` for an active row, as `app-boot` numbers it. */
const FIBER_ACTIVE = 2

/** Boot once and reuse: the profile takes seconds to settle. */
const probe = (() => {
  let pending
  return () => pending ??= new Promise((resolve, reject) => {
    // `cwd` and an absolute runtime path are both load-bearing: a relative path leaves the profile
    // composed with no services, which the probe refuses outright.
    const child = spawn(process.execPath, [PROBE, RUNTIME_DIR], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, DSH_HOME: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('close', () => {
      const marker = out.indexOf('__REPORT__')
      if (marker < 0) {
        reject(new Error(`the probe printed no report. stderr:\n${err}`))
        return
      }
      resolve(JSON.parse(out.slice(marker + '__REPORT__'.length)))
    })
  })
})()

describe.skipIf(!assembled)('the rows 0.2.0-rc.2 added', () => {
  it('keeps both telemetry rows off, and asserts the guard that keeps them off', async () => {
    // The assertion is the pairing: the rows are disabled AND the profile is not named `desktop`.
    // Either fact alone is a coincidence; together they are the reason, and a rename that breaks the
    // second while leaving the first would show up here.
    const report = await probe()
    expect(report.profileName).not.toBe('desktop')
    expect(report.watched.desktopProductTelemetry?.disabled).toBe(true)
    expect(report.watched.productAnalytics?.disabled).toBe(true)
    // Disabled means no fiber at all, which is the stronger statement: a row with a pending fiber
    // could still activate later.
    expect(report.watched.desktopProductTelemetry?.fiberState).toBe(null)
    expect(report.watched.productAnalytics?.fiberState).toBe(null)
    // And the service they would provide is absent, which is the effect a user could observe.
    expect(report.services.productAnalytics).toBe(false)
  })

  it('mounts the otel service, which changes nothing because its consumer is unchanged', async () => {
    // `otel` is a Service definition — it opens no channel itself; the senders are the rows that
    // consume it. The upstream web-app rows that would send product telemetry are disabled above, and
    // `session-telemetry-otel` (base) is identical in both harness versions, down to its
    // `mode: … || 'FEEDBACK_ONLY'` default, so this repository's behaviour is what it already was.
    // Recorded here so the next upgrade re-checks the consumer rather than the service.
    const report = await probe()
    expect(report.watched.otel?.disabled).toBe(false)
    expect(report.watched.otel?.fiberState).toBe(FIBER_ACTIVE)
    expect(report.services.otel).toBe(true)
  })

  it('mounts the new session-log settings row and its namespace', async () => {
    // 14 → 15 namespaces: this row is the reason. Asserting both halves means a row that mounts but
    // fails to register its namespace is distinguishable from one that never mounted.
    const report = await probe()
    expect(report.watched.uiSettingsSessionLog?.disabled).toBe(false)
    expect(report.watched.uiSettingsSessionLog?.fiberState).toBe(FIBER_ACTIVE)
    expect(report.namespaces).toContain('session-log-deepseek')
  })

  it('keeps every one of this application’s own rows mounted', async () => {
    // A slot that stopped matching would drop a row rather than fail, so the set is asserted. These
    // ten cover the visible surface: the settings page, the model layer, the four gateway groups, the
    // theme picker, the two workspace mutations and this application's policy row.
    const report = await probe()
    for (const id of [
      'qialike-fs-tools',
      'qialike-policy',
      'qialike-llm',
      'qialike-opencode',
      'qialike-china-gateways',
      'qialike-foreign-gateways',
      'qialike-azure',
      'qialike-theme',
      'qialike-providers',
      'qialike-brand',
    ]) {
      expect(report.ourRows, `${id} is not mounted`).toContain(id)
    }
  })
})
