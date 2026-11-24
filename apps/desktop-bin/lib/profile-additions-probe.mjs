/**
 * Boot the composed profile and report the facts that only a boot can show.
 *
 * NOT a test itself — a child program `tests/profile-additions.test.mjs` spawns. It runs in its own
 * process for the same reason the other probes do: `runProfile` installs a runtime interception,
 * mounts a real profile, and takes over process lifetime.
 *
 * WHY THIS EXISTS. Moving the harness gate from 0.1.7-rc.2 to 0.2.0-rc.2 changed which rows the
 * upstream bundles mount, and three of those changes are invisible in every static check:
 *
 *   · `desktop-product-telemetry` and `product-analytics` are NEW web-app rows, both guarded by
 *     `ctx.get('profileContext')?.name !== 'desktop'`. This application's profile is named
 *     `qialike-desktop`, so both should stay disabled — but that safety rests on a *name comparison*,
 *     which means renaming the profile would silently switch telemetry on. Asserting it makes the
 *     dependency explicit instead of incidental.
 *   · `otel` is a NEW base row with NO `disabled` key, so it mounts. Whether that produces outbound
 *     requests is not something a file can answer.
 *   · `ui-settings-session-log` is a new web-app row that brought a new settings namespace
 *     (`session-log-deepseek`) with it. Counting namespaces is how a silently-unmounted row shows up.
 *
 * Usage: `node profile-additions-probe.mjs <absolute runtimeDir>`; prints `__REPORT__{json}`.
 *
 * @module qialike-desktop/profile-additions-probe
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  process.stderr.write('usage: profile-additions-probe.mjs <runtimeDir>\n')
  process.exit(2)
}

// A relative path here fails *silently* — `installAnchor` is handed to the profile loader, and a
// relative one leaves the profile composed with no services, so every `ctx.get()` is undefined and the
// failure surfaces wherever the caller looks first. Refused with a sentence instead.
if (!isAbsolute(runtimeDir)) {
  process.stderr.write(
    `profile-additions-probe: runtimeDir must be absolute, got ${JSON.stringify(runtimeDir)}.\n`,
  )
  process.exit(2)
}

// A throwaway home: the probe must not read or write the developer's own `$DSH_HOME`.
const home = mkdtempSync(join(tmpdir(), 'qialike-additions-'))
process.env.DSH_HOME = home

try {
  const appBoot = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href)
  const profileBoot = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js')).href)

  const profileDir = join(home, 'profiles', 'qialike-desktop')
  appBoot.initProfile(profileDir, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@qialike/qialike-desktop-app',
  ])
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor)

  const running = await profileBoot.runProfile({
    environment: appBoot.loadLayeredEnv('dsh'),
    profile: 'qialike-desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--port', '0'],
  })

  const ctx = running.ctx

  // Every Loader row the composition settled on, by id.
  //
  // `entry.disabled` IS THE EVALUATED FLAG, and `entry.options.disabled` is not. The options object
  // carries the raw `!!js "…"` expression — a truthy *string* — so reading it reports `false` for
  // every row and would have made this probe assert the opposite of the truth. Upstream reads
  // `entry.disabled` for exactly this purpose in `app-boot`'s own loader sweep, and it can throw when
  // the expression fails, so the read is guarded rather than assumed.
  //
  // `fiber.state` is what distinguishes "disabled" from "mounted": 0 pending, 2 active, 3 failed,
  // 4 disposed. A row that is neither disabled nor active is the silent case this exists to catch.
  const rows = [...ctx.loader.entries()]
    .filter((entry) => typeof entry.options?.id === 'string')
    .map((entry) => {
      let disabled = null
      try {
        disabled = entry.disabled === true
      } catch {
        disabled = 'expression threw'
      }
      return { id: entry.options.id, disabled, fiberState: entry.fiber?.state ?? null }
    })
  const byId = new Map(rows.map((row) => [row.id, row]))

  // The services a mounted row provides. Presence is what distinguishes "disabled" from "mounted but
  // registered nothing" for the rows where a service is the observable effect.
  const services = {
    productAnalytics: ctx.get('productAnalytics') !== undefined,
    otel: ctx.get('otel') !== undefined,
    sessionLog: ctx.get('sessionLog') !== undefined,
  }

  const settings = ctx.get('settings')
  const namespaces = (settings?.describe({ redactSecrets: true }) ?? []).map((row) => row.ns).sort()

  process.stdout.write(`__REPORT__${JSON.stringify({
    profileName: ctx.get('profileContext')?.name ?? null,
    rowCount: rows.length,
    // The three rows this probe was written for, with whatever the loader decided.
    watched: {
      desktopProductTelemetry: byId.get('desktop-product-telemetry') ?? null,
      productAnalytics: byId.get('product-analytics') ?? null,
      otel: byId.get('otel') ?? null,
      uiSettingsSessionLog: byId.get('ui-settings-session-log') ?? null,
    },
    services,
    namespaces,
    // Our own rows, so a slot that stopped matching shows up as a missing row rather than as a
    // quietly smaller application.
    ourRows: rows.map((row) => row.id).filter((id) => id.startsWith('qialike-')),
  })}\n`)

  await running.shutdown.shutdown(0)
  process.exit(0)
} finally {
  rmSync(home, { recursive: true, force: true })
}
