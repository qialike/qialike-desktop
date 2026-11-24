/**
 * The version Settings shows, and whose version that is.
 *
 * WHAT THIS GUARDS. Settings → General carried the HARNESS's version — `0.2.1-alpha.2`, a component the user
 * never installed — while the updater beside it offered this product's `0.3.x` releases. Two numbers for one
 * product, and the visible one is not the one that updates. Upstream compiles its own version into the row;
 * this product replaces it at build time.
 *
 * WHY THE TESTS ARE ABOUT THE REWRITE RATHER THAN THE VALUE. The value changes every release, so the
 * interesting behaviour is that a SECOND build at a NEW version rewrites the first one's answer. A patch that
 * checked only for its marker — as its neighbours in that directory do, correctly, for strings that do not
 * change — would leave the previous release's number on screen and report success.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APP_VERSION_MARKER,
  APP_VERSION_TARGETS,
  patchAppVersion,
} from '../apps/desktop-bin/harness-patches/app-version.mjs'

/** The row as the bundler emits it: a literal inside a call. */
const BUNDLE = `function CurrentVersionRow({ t }) {
    return _jsx("div", { className: css.row, children: t("general.currentVersion", { version: "0.2.1-alpha.2" }) });
}
`

describe('the app-version patch', () => {
  let root
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-version-'))
    for (const target of APP_VERSION_TARGETS) {
      const path = join(root, target)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, BUNDLE)
    }
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** What the served bundle now says the version is. */
  function shown() {
    const text = readFileSync(join(root, APP_VERSION_TARGETS[0]), 'utf8')
    const match = /general\.currentVersion['"],\s*\{\s*version:\s*['"]([^'"]*)['"]/u.exec(text)
    return match?.[1]
  }

  it("replaces the harness's version with this product's", () => {
    patchAppVersion({ root, version: '0.3.12' })
    expect(shown()).toBe('0.3.12')
    expect(readFileSync(join(root, APP_VERSION_TARGETS[0]), 'utf8')).not.toContain('0.2.1-alpha.2')
  })

  it('rewrites the previous release when a new one is built over it', () => {
    // THE CASE THE NEIGHBOURING PATCHES WOULD GET WRONG, and the reason this one does not test for its marker
    // to decide whether to act: the farm can already carry the last release's answer, and a marker check
    // would call that "already applied" and ship a stale number.
    patchAppVersion({ root, version: '0.3.12' })
    patchAppVersion({ root, version: '0.3.13' })
    expect(shown()).toBe('0.3.13')
    const text = readFileSync(join(root, APP_VERSION_TARGETS[0]), 'utf8')
    // The old value is gone and the marker was not stacked up.
    expect(text).not.toContain('0.3.12')
    expect(text.split(APP_VERSION_MARKER)).toHaveLength(2)
  })

  it('is idempotent, so rebuilding the same version changes nothing', () => {
    patchAppVersion({ root, version: '0.3.12' })
    const once = readFileSync(join(root, APP_VERSION_TARGETS[0]), 'utf8')
    patchAppVersion({ root, version: '0.3.12' })
    expect(readFileSync(join(root, APP_VERSION_TARGETS[0]), 'utf8')).toBe(once)
  })

  it('leaves the bundle valid JavaScript, marker and all', () => {
    // The marker is a comment placed between the value and the object's closing brace. A block comment there
    // cannot swallow what follows it the way a `//` comment would, and this asserts the shape that makes that
    // true rather than trusting it.
    patchAppVersion({ root, version: '0.3.12' })
    const text = readFileSync(join(root, APP_VERSION_TARGETS[0]), 'utf8')
    expect(text).toMatch(/version:\s*"0\.3\.12"\s*\/\* qialike:app-version \*\/\s*\}/u)
    // Parsed for real, by the same engine that will parse it in the browser. `new Function` compiles the
    // body without running it, which is exactly the claim: the marker comment did not break the syntax.
    expect(() => new Function(text)).not.toThrow()
  })

  it('handles the single-quoted spelling too, rather than only the one this build emits', () => {
    // The compiled sibling copies upstream ships use single quotes. This patch targets the double-quoted
    // bundle, but an anchor that silently stopped matching after a bundler change would fail the build for the
    // wrong reason — so both spellings are accepted and tested.
    const target = APP_VERSION_TARGETS[0]
    writeFileSync(join(root, target), BUNDLE.replace(/"/gu, "'"))
    patchAppVersion({ root, version: '0.3.12' })
    expect(shown()).toBe('0.3.12')
  })

  it('refuses an absent target, naming the file to update', () => {
    rmSync(join(root, APP_VERSION_TARGETS[0]))
    expect(() => patchAppVersion({ root, version: '0.3.12' })).toThrow(/missing from the farm/u)
  })

  it('refuses when the row cannot be found, instead of writing nothing', () => {
    // A silent no-op here ships the harness's version — the exact defect this patch exists to remove — and
    // nothing else in the build would notice.
    writeFileSync(join(root, APP_VERSION_TARGETS[0]), 'function CurrentVersionRow() { return null }\n')
    expect(() => patchAppVersion({ root, version: '0.3.12' })).toThrow(/expected exactly one/u)
  })

  it('refuses an ambiguous bundle rather than picking one', () => {
    // Two calls mean the anchor no longer identifies the row, and a guess would put this product's version
    // somewhere it does not belong.
    const target = join(root, APP_VERSION_TARGETS[0])
    writeFileSync(target, BUNDLE + BUNDLE)
    expect(() => patchAppVersion({ root, version: '0.3.12' })).toThrow(/found 2/u)
  })

  it('refuses a version it was not given, rather than writing "undefined"', () => {
    for (const bad of [undefined, '', '   ', 42]) {
      expect(() => patchAppVersion({ root, version: bad }), JSON.stringify(bad)).toThrow(/needs a version/u)
    }
  })
})
