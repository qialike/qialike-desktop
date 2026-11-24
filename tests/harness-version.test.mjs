/**
 * The harness version gate.
 *
 * The behaviour that matters is the semver pre-release rule: a range bound
 * carrying a pre-release only matches same-tuple pre-releases, so the *release*
 * of the ceiling's tuple (e.g. `0.2.0` when the ceiling is `0.2.0-rc.2`) must be
 * rejected as newer while a lower pre-release of that same tuple (e.g.
 * `0.2.0-rc.1`) is accepted. Getting this inverted would either let an
 * unvalidated harness through or block every historical release, and neither
 * shows up until someone builds.
 *
 * THE BOUNDARY CASES ARE DERIVED FROM THE CEILING, NOT WRITTEN OUT. They used to be literals, which
 * meant raising the ceiling turned a passing suite red for no reason other than staleness — and the
 * fix looked like "update the literals" rather than "re-check the rule". Deriving them keeps the
 * assertion about the RULE, so it holds at every ceiling, and a ceiling whose shape the derivation
 * cannot express fails loudly (see `preReleaseBelow`) instead of quietly testing nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import semver from 'semver'
import {
  CLI_APP_DIR,
  CLI_HARNESS_VERSION_MAX,
  CLI_HARNESS_VERSION_MIN,
  CLI_VERSION,
  HARNESS_VERSION_MAX,
  HARNESS_VERSION_MIN,
  assertCliCompatible,
  assertHarnessCompatible,
  assertVersionInRange,
  detectCliVersion,
  detectHarnessVersion,
} from '../apps/desktop-bin/lib/harness-version.mjs'
import { DSH_HARNESS_ENV, harnessRoot } from '../apps/desktop-bin/lib/paths.mjs'

/** A `run` stand-in that reports the given git tag output. */
function gitReturning(stdout) {
  return () => stdout
}

/** The plain release of the ceiling's tuple: the version a naive `>=` range would let through. */
function releaseOf(version) {
  const parsed = semver.parse(version)
  return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`
}

/** The next pre-release of the ceiling's tuple, which must also be rejected. */
function nextPreRelease(version) {
  const next = semver.inc(version, 'prerelease')
  if (next === null) throw new Error(`cannot derive the next pre-release of ${version}`)
  return next
}

/**
 * A pre-release of the ceiling's tuple that sorts *below* it — the case that must be accepted.
 *
 * Assumes a numeric tail (`-rc.2`), which every ceiling so far has had. A ceiling without one yields
 * a version that is not valid semver, so `assertVersionInRange` rejects it and the assertion fails
 * loudly — which is the point: it must not pass by testing nothing.
 */
function preReleaseBelow(version) {
  const parsed = semver.parse(version)
  const head = parsed.prerelease.slice(0, -1)
  const tail = Number(parsed.prerelease.at(-1)) - 1
  return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}-${[...head, tail].join('.')}`
}

/** A `run` stand-in that behaves as if git is unavailable. */
function gitFailing() {
  return () => { throw new Error('git: not found') }
}

describe('detectHarnessVersion', () => {
  it('prefers the nearest git tag and strips the dsh-v prefix', () => {
    const run = gitReturning('dsh-v0.1.7-rc.2\n')
    expect(detectHarnessVersion('/checkout', run)).toBe('0.1.7-rc.2')
  })

  it('accepts a tag without the prefix', () => {
    expect(detectHarnessVersion('/checkout', gitReturning('0.1.7-rc.2'))).toBe('0.1.7-rc.2')
  })

  it('falls back to the root manifest when git fails', () => {
    // The real harness checkout is the fallback's fixture: it has a package.json.
    const version = detectHarnessVersion(harnessRoot(), gitFailing())
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)
  })

  it('reports a missing checkout rather than guessing', () => {
    expect(() => detectHarnessVersion('/nonexistent-checkout', gitFailing()))
      .toThrow(/no harness checkout/)
  })
})

describe('assertVersionInRange', () => {
  it('accepts the exact ceiling and floor', () => {
    expect(assertVersionInRange(HARNESS_VERSION_MAX)).toBe(HARNESS_VERSION_MAX)
    expect(assertVersionInRange(HARNESS_VERSION_MIN)).toBe(HARNESS_VERSION_MIN)
  })

  it('accepts a release inside the range', () => {
    expect(assertVersionInRange('0.1.2')).toBe('0.1.2')
  })

  it('rejects a version newer than the ceiling', () => {
    // The ceiling's own release is the case a naive `>=` range gets wrong: `0.2.0` sorts ABOVE
    // `0.2.0-rc.2`, so it must be refused as newer — not accepted because its tuple matches.
    expect(() => assertVersionInRange(releaseOf(HARNESS_VERSION_MAX))).toThrow(/outside the validated range/)
    expect(() => assertVersionInRange(nextPreRelease(HARNESS_VERSION_MAX))).toThrow(/outside the validated range/)
    expect(() => assertVersionInRange('9.9.9')).toThrow(/newer/)
  })

  it('rejects a version older than the floor', () => {
    expect(() => assertVersionInRange('0.1.0-rc.6')).toThrow(/older/)
  })

  it('accepts a pre-release below the ceiling', () => {
    const below = preReleaseBelow(HARNESS_VERSION_MAX)
    expect(assertVersionInRange(below)).toBe(below)
  })

  it('accepts an in-range pre-release whose tuple matches neither bound', () => {
    // THE CASE THAT DISCRIMINATES THE IMPLEMENTATION FROM A RANGE STRING, and neither this suite nor
    // its predecessor covered it. semver's range rule only lets a pre-release satisfy a comparator
    // set when some comparator carries the same [major.minor.patch], so `>=<floor> <=<ceiling>`
    // REJECTS a mid-range pre-release like `0.1.1-rc.1` — its tuple matches neither bound — while
    // the explicit gte/lte pair accepts it. That is the entire reason `assertVersionInRange` does
    // not use a range string, and the reason is written in a comment there; without this case the
    // comment was unverified, and swapping in a range string kept the suite green.
    //
    // The first assertion pins the rationale rather than the behaviour: if semver ever stops
    // excluding these, this case no longer discriminates and the comment in harness-version.mjs
    // needs rewriting. Failing here is how that gets noticed.
    //
    // Derived from the floor by bumping the patch component, so it stays mid-range and stays
    // tuple-mismatched as the ceiling moves.
    const floor = semver.parse(HARNESS_VERSION_MIN)
    const midRange = `${String(floor.major)}.${String(floor.minor)}.${String(floor.patch + 1)}-rc.1`
    expect(semver.satisfies(midRange, `>=${HARNESS_VERSION_MIN} <=${HARNESS_VERSION_MAX}`)).toBe(false)
    expect(assertVersionInRange(midRange)).toBe(midRange)
  })

  it('names the file to edit and the alternative, so the failure is actionable', () => {
    let message = ''
    try {
      assertVersionInRange('9.9.9')
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('HARNESS_VERSION_MAX')
    expect(message).toContain('apps/desktop-bin/lib/harness-version.mjs')
    // Against the constant, not the literal: this asserts the message names the variable
    // that actually works, and it keeps working if the name is ever changed deliberately.
    // The name's *value* is pinned separately, in checkout-resolution.test.mjs.
    expect(message).toContain(DSH_HARNESS_ENV)
  })

  it('rejects a value that is not a version', () => {
    expect(() => assertVersionInRange('not-a-version')).toThrow(/not.*a semantic version/)
  })
})

describe('the range agrees with the qialike CLI', () => {
  // Both products read and write one $DSH_HOME, including its session store. A
  // divergence would let one of them write a format the other refuses to read,
  // so drift is a test failure rather than a review note.
  it('declares the same bounds as the CLI', () => {
    expect(HARNESS_VERSION_MIN).toBe(CLI_HARNESS_VERSION_MIN)
    expect(HARNESS_VERSION_MAX).toBe(CLI_HARNESS_VERSION_MAX)
  })
})

describe('assertHarnessCompatible', () => {
  it('detects and validates in one call', () => {
    expect(assertHarnessCompatible('/checkout', gitReturning('dsh-v0.1.2'))).toBe('0.1.2')
  })

  it('propagates an out-of-range failure', () => {
    expect(() => assertHarnessCompatible('/checkout', gitReturning('dsh-v2.0.0')))
      .toThrow(/outside the validated range/)
  })
})

describe('the qialike CLI version gate', () => {
  // THE FAILURE THIS CATCHES IS INVISIBLE IN THE ARTIFACT. The CLI's built output is staged into the
  // runtime tree, so a checkout one release behind builds cleanly and produces an installer whose
  // version number is right and whose provider layer is not. That is how a 0.11.0 checkout could ship
  // inside a build expecting 0.11.1: the probe asked whether lib/index.js existed, never which
  // release produced it. So these tests are about the gate existing and refusing, not about the
  // number — which moves every release and is pinned nowhere here on purpose.

  it('accepts exactly the validated release', () => {
    expect(assertCliCompatible('/checkout', () => CLI_VERSION)).toBe(CLI_VERSION)
  })

  it('refuses an older checkout, and says which version it wanted', () => {
    const older = semver.parse(CLI_VERSION)
    // DECREMENT THE MINOR, NOT THE PATCH. `CLI_VERSION` is `0.12.0`, so `patch -= 1` produced
    // `0.12.-1` — not a version at all — and semver threw `Invalid Version` before the gate was
    // reached, which is a failure for a reason unrelated to what this test checks. A minor step
    // back is a valid older version for every release this project has shipped.
    if (older.patch > 0) older.patch -= 1
    else { older.minor -= 1; older.patch = 0 }
    const message = (() => {
      try { assertCliCompatible('/checkout', () => older.format()) } catch (error) { return error.message }
      throw new Error('an older CLI was accepted')
    })()
    expect(message).toContain(`is ${older.format()}`)
    expect(message).toContain(CLI_VERSION)
    expect(message).toMatch(/older/u)
    // The remedy has to name the thing that actually changes the artifact: rebuilding, not editing a
    // version string. A checkout whose manifest carries the right number while lib/ is stale is the
    // one state this gate cannot see, so the message must not imply that an edit is enough.
    expect(message).toMatch(/run its own build/u)
  })

  it('refuses a newer checkout too, because the bytes are copied rather than adapted to', () => {
    const newer = semver.parse(CLI_VERSION)
    newer.patch += 1
    expect(() => assertCliCompatible('/checkout', () => newer.format())).toThrow(/newer/u)
  })

  it('reads the app package, which is the one staged into the runtime tree', () => {
    // A root-manifest reader would compare against a number that never reaches the artifact: the
    // staging function copies packages/qialike-app/{package.json,lib}, not the checkout root.
    const dir = mkdtempSync(join(tmpdir(), 'qialike-cli-'))
    try {
      const app = join(dir, CLI_APP_DIR)
      mkdirSync(app, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.0.1' }))
      writeFileSync(join(app, 'package.json'), JSON.stringify({ version: CLI_VERSION }))
      expect(detectCliVersion(dir)).toBe(CLI_VERSION)
      expect(assertCliCompatible(dir)).toBe(CLI_VERSION)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the missing package rather than reporting a version mismatch', () => {
    expect(() => detectCliVersion('/nonexistent-checkout')).toThrow(/no qialike CLI app package/u)
  })
})
