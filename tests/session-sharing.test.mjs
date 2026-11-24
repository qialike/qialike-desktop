/**
 * The three surfaces share one session corpus (verified, not assumed).
 *
 * WHY THIS NEEDS A TEST AT ALL. "The CLI, the web app and this application see the same
 * sessions" is a property of *composition*, not of this repository's build. Every check that
 * guards the build would still pass if it stopped being true: the profile would still
 * compose, the Host would still boot, the browser surface would still render. The only
 * difference would be an empty session list — and the failure would look exactly like "the
 * user has no sessions yet".
 *
 * The mechanism is one line in the `dsh-base` bundle patch that all three surfaces inherit:
 *
 *     - id: session-persistence-jsonl
 *       config:
 *         root: !!js dshHomePath('sessions')
 *
 * `dshHomePath` resolves from `$DSH_HOME`, not from the profile directory, so the corpus is
 * shared while *executable* state (the profile: package set, lockfile, patches) stays
 * separate. Sessions and the workspace registry are shared; harness settings are not — they
 * persist through the active profile's patch layer.
 *
 * TWO KINDS OF ASSERTION, because they fail for different reasons. The static ones read the
 * shipped patch files, so they hold on any machine and catch a changed root. The dynamic one
 * boots the profile against a corpus seeded with real session directories and asks the store
 * what it lists, so it catches a root that is *effectively* profile-local even when the patch
 * still says otherwise (a shell overriding `DSH_HOME`, for instance). The dynamic half needs
 * a real corpus to copy from, so it is skipped where there is none.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { memberDir } from '../apps/desktop-bin/lib/runtime-tree.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'session-sharing-probe.mjs')
const BASE_PATCH = join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml')
// `memberDir` rather than pnpm's `packages/<flattened>` layout: the runtime tree is
// de-linked after assembly, so the bundle lives at `node_modules/@qialike/…`.
const OWN_PATCH = join(memberDir(RUNTIME_DIR, '@qialike/qialike-desktop-app'), 'cordis.patch.yml')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

/** The real shared store, used only as a source of well-formed sessions to copy. */
const REAL_SESSIONS = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const hasCorpus = existsSync(REAL_SESSIONS)
  && readdirSync(REAL_SESSIONS, { withFileTypes: true }).some((entry) => entry.isDirectory())

/** Boot once and reuse: the profile takes seconds to settle. */
const probe = (() => {
  let pending
  return () => pending ??= new Promise((resolve, reject) => {
    // `cwd` and an absolute runtime path are both load-bearing: a relative path leaves the
    // profile composed with no services, which the probe now refuses outright.
    const child = spawn(process.execPath, [PROBE, RUNTIME_DIR, REAL_SESSIONS], {
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
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

/** Read one row's `root:` line out of a patch file, without a YAML parser. */
function pinnedRoot(patchPath, rowId) {
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim().startsWith(`- id: ${rowId}`))
  if (start < 0) return undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().startsWith('- id: ')) break
    const match = /^\s*root:\s*(.+)$/u.exec(line)
    if (match) return match[1].trim()
  }
  return undefined
}

describe.skipIf(!assembled)('the shared base pins the session and workspace stores', () => {
  it('points the jsonl session store at dshHomePath, not at the profile', () => {
    // The whole sharing property is this one expression. `dshHomePath('sessions')` is
    // `$DSH_HOME/sessions`; anything else — a bare relative path, a profile-local directory —
    // would give each surface its own corpus while still booting cleanly.
    expect(pinnedRoot(BASE_PATCH, 'session-persistence-jsonl')).toBe("!!js dshHomePath('sessions')")
  })

  it('points the workspace registry at dshHomePath too, so grouping agrees', () => {
    // The registry (`workspace.json`) is what puts sessions under a project heading, and the
    // CLI's own patch explains that it mounted this same registry precisely so its sessions
    // are not listed as "Ungrouped" in the web sidebar. A profile-local registry would split
    // that grouping even with a shared corpus.
    expect(pinnedRoot(BASE_PATCH, 'storage-json')).toBe("!!js dshHomePath('storages')")
  })

  it('is not overridden by this application, which inherits it', () => {
    // Asserted because an override is the plausible way to break sharing later: it would look
    // deliberate in review and would be invisible at runtime until someone missed a session.
    expect(pinnedRoot(OWN_PATCH, 'session-persistence-jsonl')).toBeUndefined()
    expect(pinnedRoot(OWN_PATCH, 'storage-json')).toBeUndefined()
  })
})

describe.skipIf(!assembled || !hasCorpus)('a corpus another product wrote is visible here', () => {
  it('lists every seeded session, so the store is not profile-local', async () => {
    const { report, stderr } = await probe()
    // A row that failed to resolve would still boot; this is the cheap guard that the report
    // came from a fully composed profile rather than a partly empty one.
    expect(stderr).not.toMatch(/did not activate/u)
    expect(report.seededCount).toBeGreaterThan(0)
    // Exact equality, not "at least one": the throwaway home holds nothing else, so any
    // shortfall means sessions were written somewhere the store does not read.
    expect(report.listedCount).toBe(report.seededCount)
    expect(report.seededVisible).toBe(report.seededCount)
  }, 300_000)

  it('keeps the corpus outside the profile directory, which is what makes it shared', async () => {
    const { report } = await probe()
    // Both live under the one temp $DSH_HOME, as siblings — `sessions/` beside
    // `profiles/qialike-desktop/`. The assertion is that neither contains the other.
    expect(report.sessionsRoot.startsWith(report.profileDir)).toBe(false)
    expect(report.profileDir.startsWith(report.sessionsRoot)).toBe(false)
    // `${sep}` rather than a literal '/': the property is that the corpus is a
    // `sessions/` sibling of `profiles/<name>/`, and which character separates those
    // segments is the host's business. Spelling them with '/' asserted the host, and
    // failed on Windows for a path that was correct.
    expect(report.sessionsRoot).toContain(`${sep}sessions`)
    expect(report.profileDir).toContain(`${sep}profiles${sep}`)
  }, 300_000)
})
