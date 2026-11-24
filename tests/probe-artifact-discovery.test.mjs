/**
 * The update probe derives the artifact it offers, instead of naming one release.
 *
 * WHY THIS IS A TEST AND NOT A HABIT. `apps/desktop-bin/lib/update-feed-probe.mjs` is a
 * hand-run diagnostic: no build step touches it, nothing imports it, and no test spawned it
 * — it was reachable only from README prose. It carried the literal
 * `qialike-0.1.0-x86_64.AppImage`, and `electron-builder.config.mjs` named artifacts
 * `'${productName}-${version}-${arch}.${ext}'`. So the next version bump would have renamed
 * the file and left the probe dying at `readFileSync` with ENOENT —
 * discovered mid-release, which is when a broken instrument costs the most. That is the same
 * shape of failure `script-syntax.test.mjs` exists for, and the same reason it is asserted
 * here rather than remembered.
 *
 * THE NAME HAS MOVED TWICE SINCE, and the guard moved with it, which is the point of asserting on
 * the source: on 2026-10-13 it became `qialike-${version}-${arch}.${ext}` (lower case, for a
 * release host that refused the capitalised form) and then `qialike-desktop-linux-${arch}.${ext}`
 * (`linux` spelled out, and the version dropped). A guard that only knew the first spelling would
 * have stopped guarding at the first rename without anyone noticing — so it now rejects the old
 * `qialike-<digit>` shape *and* the current `qialike-desktop-linux-…` one.
 *
 * The discovery happens before the application is launched, so every assertion below runs
 * without a display, without a real artifact and without a built tree.
 *
 * The happy-path case does bind the probe's feed port (19234), so a leaked probe from an
 * earlier run would surface here as EADDRINUSE. That is worth surfacing rather than hiding:
 * the same lesson is recorded for the window probes, where a hardcoded debug port once made a
 * run report a stale window's state as fact.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'update-feed-probe.mjs')

let sandbox

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'qialike-discovery-'))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * Run the probe against an artifact directory.
 *
 * The binary cannot exist, so the probe always fails — but only *after* discovery and the feed
 * handshake, which is where the interesting behaviour is. A nonexistent path is deliberate
 * rather than `/bin/true`: it makes the launch fail immediately and deterministically instead
 * of waiting out a readiness timeout for a process that will never open a debug port.
 *
 * @param artifactDir - the directory to hand the probe.
 * @returns the exit code and both streams.
 */
function runProbe(artifactDir) {
  const result = spawnSync(process.execPath, [PROBE, '/nonexistent/qialike-binary', artifactDir], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

/** Write a file of the given name into the sandbox, with bytes to hash. */
function place(name, contents = 'not really an appimage\n') {
  writeFileSync(join(sandbox, name), contents)
  return name
}

/**
 * The probe's source with its comments removed.
 *
 * COMMENTS ARE PROSE, AND THIS FILE'S COMMENT *SHOULD* NAME THE OLD LITERAL — it explains why
 * discovery replaced it, and an explanation that cannot quote the mistake is a worse
 * explanation. So the check is about executable text, and the comments have to come out first.
 *
 * Block comments are removed outright; only line comments that *begin* a line are removed,
 * so a `//` inside a string (this file has `http://127.0.0.1:…`) cannot truncate a line of
 * real code and hide a literal behind it.
 *
 * @param source - the file's text.
 * @returns the text with comments removed.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//u.test(line))
    .join('\n')
}

describe('the probe names no release', () => {
  it('carries no hardcoded artifact filename', () => {
    // The regression itself: a product name immediately followed by a digit is a version
    // literal, which is exactly the coupling that breaks on the next bump. Asserted against
    // the source because that is where the mistake lives — a behavioural test cannot see a
    // literal that happens to still match today's build.
    //
    // Checked in code, not comments: see `withoutComments`.
    const code = withoutComments(readFileSync(PROBE, 'utf8'))
    // Two patterns, because the name has had two spellings and a guard knows the one it was
    // taught: `/qialike-\d/` is the `qialike-<version>-…` era (still the shape a reverted
    // `artifactName` would produce), and `/qialike-desktop-linux-/` is the current one, which
    // carries no digit for the first pattern to catch. Case-insensitive so that neither a
    // capitalised revert nor the `Qialike` product name slips past.
    const literals = [
      ...(code.match(/qialike-\d[^'"`\s]*/giu) ?? []),
      ...(code.match(/qialike-desktop-linux-[^'"`\s]*/giu) ?? []),
    ]
    expect(literals, `hardcoded artifact name(s): ${literals.join(', ')}`).toEqual([])
  })

  it('reads the directory it was given', () => {
    // The shape of the fix, so a later rewrite cannot satisfy the check above by simply
    // dropping the name while also dropping the discovery.
    const code = withoutComments(readFileSync(PROBE, 'utf8'))
    expect(code).toContain('readdirSync(artifactDir)')
  })

  it('filters on the extension the feed it writes actually serves', () => {
    // `latest-linux.yml` is what this probe produces, so an `.AppImage` floor is a
    // consequence of the probe's purpose, not a convenience. If that ever changes, the
    // filter is the line to revisit — which is why it is asserted.
    const code = withoutComments(readFileSync(PROBE, 'utf8'))
    expect(code).toContain(".endsWith('.AppImage')")
  })
})

describe('the artifact directory must answer unambiguously', () => {
  it('refuses an empty directory, and says the directory is empty', () => {
    const { code, err } = runProbe(sandbox)
    expect(code).toBe(2)
    expect(err).toContain('no .AppImage')
    expect(err).toContain('present: (empty)')
  })

  it('refuses a directory holding no AppImage, and lists what it did find', () => {
    // The Linux release produces a `.deb` beside the AppImage, so pointing the probe at a
    // directory that holds only the deb is a realistic slip. Naming the file it saw is what
    // makes that a one-line diagnosis.
    place('qialike-desktop-linux-amd64.deb')
    const { code, err } = runProbe(sandbox)
    expect(code).toBe(2)
    expect(err).toContain('no .AppImage')
    expect(err).toContain('qialike-desktop-linux-amd64.deb')
  })

  it('refuses to choose between several, and names the candidates', () => {
    // Refused rather than guessed: offering whichever the directory listed first would make
    // the feed's subject depend on directory order, and the probe would still exit 0 while
    // reporting on a file nobody meant.
    place('qialike-desktop-linux-x86_64.AppImage')
    place('qialike-desktop-linux-arm64.AppImage')
    const { code, err } = runProbe(sandbox)
    expect(code).toBe(2)
    expect(err).toContain('ambiguous')
    expect(err).toContain('qialike-desktop-linux-arm64.AppImage')
    expect(err).toContain('qialike-desktop-linux-x86_64.AppImage')
  })
})

describe('discovery is independent of this repository’s version', () => {
  it('offers whatever single AppImage is there, and hashes that file', () => {
    // This test used to place `qialike-7.7.7-x86_64.AppImage` and argue that `7.7.7` appears
    // nowhere in the repository, so a pass could not come from a literal matching today's build.
    // Artifact names carry no version since 2026-10-13, so that argument has no subject left —
    // the equivalent property is now about the *architecture*: `riscv64` is a name this
    // repository never builds (the linux targets list x64 and arm64 only), so a pass still cannot
    // come from a literal, and discovery is still shown to work by extension rather than by a
    // list of names it recognises.
    const name = place('qialike-desktop-linux-riscv64.AppImage', 'invented bytes\n')
    const { code, out } = runProbe(sandbox)
    // Not 2: the probe got past argument and discovery validation, into the launch it is
    // expected to fail at.
    expect(code).not.toBe(2)
    expect(out).toContain('feed:')
    expect(out).toContain(name)
    // A digest, not an empty string: the file was read, which is the step that used to throw
    // when the name was wrong.
    expect(out).toMatch(/sha512 [A-Za-z0-9+/]{16}/u)
  })
})
