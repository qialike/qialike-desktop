/**
 * Boot the composed profile and report which persisted sessions its store lists.
 *
 * NOT a test itself — a child program `tests/session-sharing.test.mjs` spawns. It runs in its
 * own process for the same reason the other probes do: `runProfile` installs a runtime
 * interception, mounts a real profile, and takes over process lifetime.
 *
 * WHAT THIS EXISTS TO PIN. All three surfaces — the CLI's `tui` profile, the `web` profile
 * upstream ships, and this application's `qialike-desktop` profile — are meant to share one
 * session corpus, because the `dsh-base` bundle all three inherit pins the store to
 * `dshHomePath('sessions')`, which resolves from `$DSH_HOME` and not from the profile
 * directory. That is a property of *composition*, so nothing in this repository's build
 * checks would notice if it stopped being true: a profile that pinned its own session root
 * (or a shell that overrode `DSH_HOME` to a profile-specific value) would still build, still
 * boot, still serve the browser surface — the sessions just would not be there.
 *
 * HOW IT PROVES IT. Sessions are seeded by copying real session directories out of the shared
 * store before the profile boots, so the copies are byte-identical to what another product
 * wrote. Then the store is asked what it lists. A store that read a profile-local directory
 * would list nothing.
 *
 * Usage: `node session-sharing-probe.mjs <absolute runtimeDir> [sessionsSource]`; prints
 * `__REPORT__{json}`.
 *
 * @module qialike-desktop/session-sharing-probe
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  process.stderr.write('usage: session-sharing-probe.mjs <runtimeDir> [sessionsSource]\n')
  process.exit(2)
}

// An absolute path is load-bearing, and a relative one fails *silently* rather than loudly:
// `installAnchor` is passed to the profile loader, and a relative one leaves the profile
// composed with no services at all — every `ctx.get()` returns undefined, which surfaces as
// whatever the caller touches first. That is a genuinely confusing failure to debug, so it is
// refused here with a sentence instead.
if (!isAbsolute(runtimeDir)) {
  process.stderr.write(
    `session-sharing-probe: runtimeDir must be absolute, got ${JSON.stringify(runtimeDir)}. `
    + 'A relative path leaves the profile composed with no services, so the report would be '
    + 'meaningless rather than merely wrong.\n',
  )
  process.exit(2)
}

const sourceRoot = process.argv[3]

// A throwaway home: the probe must not read or write the developer's own `$DSH_HOME`, or a
// stale profile and a stale corpus would decide what it reports.
const home = mkdtempSync(join(tmpdir(), 'qialike-sharing-'))
process.env.DSH_HOME = home

try {
  const appBoot = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href)
  const profileBoot = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js')).href)
  const homePaths = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-home-paths', 'lib', 'index.js')).href)

  // ── Seed the corpus the way another product would have left it ────────────────
  //
  // Copied verbatim, structure and bytes: the format is the harness's, and inventing a
  // stand-in would test the stand-in instead.
  const sessionsRoot = homePaths.dshHomePath('sessions')
  const seeded = []
  if (sourceRoot !== undefined && existsSync(sourceRoot)) {
    for (const project of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const from = join(sourceRoot, project.name)
      for (const session of readdirSync(from, { withFileTypes: true })) {
        if (!session.isDirectory()) continue
        const target = join(sessionsRoot, project.name, session.name)
        cpSync(join(from, session.name), target, { recursive: true })
        seeded.push(`${project.name}/${session.name}`)
      }
    }
  }

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
  const store = ctx.get('sessionPersistence')
  const snapshots = store === undefined ? [] : await store.list()
  const listedIds = snapshots.map((snapshot) => snapshot.header.id)

  process.stdout.write(`__REPORT__${JSON.stringify({
    dshHome: home,
    sessionsRoot,
    // Where the profile lives, so a reader can see the two are different directories.
    profileDir,
    seededCount: seeded.length,
    listedCount: listedIds.length,
    // Would be 0 if the store read a profile-local corpus.
    seededVisible: seeded.filter((entry) => listedIds.includes(entry.split('/')[1])).length,
    titles: snapshots.map((snapshot) => snapshot.header.title ?? null),
  })}\n`)

  // The teardown the other probes use. A bare `process.exit(0)` leaves the profile's timers
  // and web server behind, so the child never exits and the spawning test waits out its whole
  // timeout — with a correct report already sitting in its stdout buffer, which is a genuinely
  // confusing way to fail.
  await running.shutdown.shutdown(0)
  process.exit(0)
} finally {
  rmSync(home, { recursive: true, force: true })
}
