/**
 * The theme route, against the composed profile and a seeded home.
 *
 * WHY A BOOTED PROFILE RATHER THAN A UNIT TEST OF THE MODULE. The host row imports
 * `@deepseek-ai/dsh-home-paths`, which resolves in the assembled runtime tree and not
 * in this repository's `node_modules` — so the module cannot be imported here at all.
 * It is booted instead, which is also the stronger test: the route runs under the real
 * resolver, the real connection and the real home, so a row that failed to activate
 * (the `warning: 1 entry did not activate` failure that shipped M5's read guard
 * inert) is caught rather than assumed.
 *
 * The seeded home is what makes the assertions meaningful:
 *
 *   · `my-scheme.json` — a user scheme in the CLI's `{ name, palette }` format;
 *   · `nameless.json` — no `name`, so the file name has to stand in;
 *   · `broken.json` — unparsable, and must cost that one scheme;
 *   · `empty.json` — parses but carries no colour, skipped for a different reason;
 *   · `dracula.json` — clashes with a shipped scheme, and must LOSE;
 *   · `notes.txt` — not JSON, and not considered at all.
 *
 * WHAT IS NOT COVERED HERE: anything after the palette. That the mapped tokens reach
 * CSS variables on a real window, that `colorScheme` moves the base palette, and that
 * a scheme is legible are facts about a rendered surface, and this environment cannot
 * render one. `tests/theme-client.test.mjs` covers the bundle up to the registry
 * boundary; the pixels are left to a desktop.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { SCHEME_PALETTES } from '../packages/qialike-desktop-theme/lib/palettes.js'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'theme-probe.mjs')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

/** Boot once for every assertion below: the profile takes seconds to settle. */
const probe = (() => {
  let pending
  return () => pending ??= new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, RUNTIME_DIR], {
      cwd: RUNTIME_DIR,
      // The probe seeds its own throwaway home; the developer's must not be read.
      env: { ...process.env, DSH_HOME: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code) => {
      const marker = out.indexOf('__REPORT__')
      if (marker < 0) {
        reject(new Error(`the theme probe produced no report (exit ${String(code)}):\n${out}\n${err}`))
        return
      }
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

describe.skipIf(!assembled)('the theme row', () => {
  it('activates, so no row silently failed to resolve', async () => {
    // The failure this guards is one line on stderr — `warning: 1 entry did not
    // activate` — while the profile boots, serves and renders normally. It is how
    // M5's read guard shipped inert, and a row naming a package the bundle does not
    // depend on is dismissed by the resolver's own closure walk.
    const { report, stderr } = await probe()
    expect(stderr).not.toMatch(/did not activate/u)
    expect(report.activation.themeRow).toBe(true)
  })

  it('puts the client bundle in the document the browser is served', async () => {
    // A package that declares `dsh.client` but is reached by no mounted row is
    // discovered by nothing, so the picker would not exist however correct the bundle
    // is. This is the half of "the picker is there" a host probe can see.
    const { report } = await probe()
    expect(report.clientIds).toContain('@qialike/qialike-desktop-theme')
  })
})

describe.skipIf(!assembled)('the scheme list', () => {
  it('serves every scheme the CLI ships', async () => {
    const { report } = await probe()
    expect(report.route.status).toBe(200)
    expect(report.route.ok).toBe(true)
    for (const name of ['catppuccin', 'dracula', 'gruvbox', 'nord', 'light', 'one-dark', 'solarized-light']) {
      expect(report.route.names, name).toContain(name)
    }
  })

  it('reads the user’s own schemes from the themes directory', async () => {
    const { report } = await probe()
    expect(report.route.sources.sort()).toEqual(['my-scheme', 'nameless'])
    // No `name` in the document, so the file name stands in — the CLI's rule.
    expect(report.route.names).toContain('nameless')
  })

  it('lets a shipped scheme win a name clash, as the CLI does', async () => {
    // The seeded `dracula.json` defines `bg: #000000`. The CLI merges built-ins last,
    // so the shipped `#282a36` must be what the route serves — otherwise a file named
    // after a shipped scheme silently redefines it.
    const { report } = await probe()
    expect(report.route.draculaBackground).toBe('#282a36')
    expect(report.route.sources).not.toContain('dracula')
  })

  it('costs one scheme for a bad file and nothing more', async () => {
    // The two files fail for different reasons — one does not parse, one parses
    // without a usable colour — and both must leave the rest of the list intact.
    const { report } = await probe()
    expect(report.route.skippedFiles).toEqual(
      expect.arrayContaining(['themes/broken.json', 'themes/empty.json']),
    )
    // The rest are still there: every shipped scheme, plus the 2 usable user files.
    //
    // DERIVED, because the literal this used to carry went stale the moment the CLI added a
    // scheme (`moss`, in 0.11.2) — a red test that reported "17 !== 18" and taught nobody
    // anything about the rule being asserted. The rule is "a bad file costs one scheme".
    expect(report.route.schemeCount).toBe(Object.keys(SCHEME_PALETTES).length + 2)
  })

  it('ignores a non-JSON file entirely', async () => {
    const { report } = await probe()
    expect(report.route.skippedFiles.some((file) => file.endsWith('notes.txt'))).toBe(false)
    expect(report.route.names).not.toContain('notes')
  })

  it('gives every scheme a namespaced, unique id and a mapped token set', async () => {
    // The id is the registry key, so a duplicate throws inside `register()` and takes
    // the whole picker down; the tokens are what the scheme actually changes, so an
    // empty set would be an entry that does nothing when chosen.
    const { report } = await probe()
    expect(report.route.idsNamespaced).toBe(true)
    expect(report.route.idsUnique).toBe(true)
    expect(report.route.everySchemeHasTokens).toBe(true)
  })

  it('tells the client which appearance preferences to offer', async () => {
    const { report } = await probe()
    expect(report.route.builtin).toEqual(['system', 'light', 'dark'])
  })
})

describe.skipIf(!assembled)('the stored preference', () => {
  it('reads it from the CLI’s own section and key', async () => {
    // `theme.colorscheme` — the key `/theme dracula` writes. Sharing the key is what
    // makes a click here and a command there the same act.
    const { report } = await probe()
    expect(report.route.preference).toBe(report.home.seededPreference)
  })

  it('writes it back, preserving the rest of the file', async () => {
    const { report } = await probe()
    expect(report.write.ok).toBe(true)
    expect(report.write.stored).toBe('dracula')
    // `colors` holds the CLI's per-role overrides. Dropping it would be data loss with
    // no visible cause, so it is asserted rather than assumed.
    expect(report.write.preservedColors).toEqual({ accent: '#123456' })
    expect(report.write.preservedLlm).toBe(true)
  })

  it('refuses a name it cannot serve, rather than storing it', async () => {
    // A typo persisted would make the next start fall back silently, leaving the user
    // unable to tell a bad name from a lost setting.
    const { report } = await probe()
    expect(report.write.rejectedUnknown).toBe(true)
    expect(report.write.rejectedMessage).toMatch(/no scheme named/u)
  })

  it('clears the key when the user returns to an appearance preference', async () => {
    // Removing the key and storing a scheme are different intentions; only the second
    // should re-apply on the next start. The colours survive either way.
    const { report } = await probe()
    expect(report.write.clearedOk).toBe(true)
    expect(report.write.keyRemoved).toBe(true)
    expect(report.write.colorsSurvivedClear).toEqual({ accent: '#123456' })
    expect(report.write.preferenceAfterClear).toBeNull()
  })

  it('rejects an unknown operation', async () => {
    const { report } = await probe()
    expect(report.write.unknownOpRejected).toBe(true)
  })
})
