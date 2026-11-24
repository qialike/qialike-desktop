/**
 * One version across the workspace, and nothing publishable by accident.
 *
 * WHY THIS SUITE EXISTS. A release bumps the version in thirteen manifests, and nothing used to
 * compare them. The failure is quiet in exactly the way release mistakes are: `apps/desktop` can say
 * `0.8.0` while the bundle it loads says `0.7.0`, the application starts, the About panel shows the
 * version compiled into the shell, and the artifact's name shows the one electron-builder read. Two
 * answers to "which version is this?" is a support problem before it is a build problem.
 *
 * The second assertion is about a different quiet failure: every workspace package is `private`, and
 * a missing flag would let `npm publish` push a fragment of the application under its own name. This
 * repository publishes installers, not packages; that is a property worth holding rather than
 * remembering.
 *
 * WHY IT BELONGS IN THE HYGIENE SET. It reads only this repository, so it runs in CI on every pull
 * request, and it is the cheapest possible place to catch a bump that touched some of the manifests.
 *
 * WHAT IS NOT ENFORCED. Which version a release *should* be — SemVer judgement is a human decision.
 * The tag, the artifact name and the compiled About string are checked by the release process, not
 * here; this suite only keeps the manifests from disagreeing with each other.
 *
 * @module qialike-desktop/tests/release-consistency
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

/** The directories whose immediate children are pnpm workspace members. */
const WORKSPACE_GROUPS = ['apps', 'packages']

/** Read and parse one manifest, letting a malformed JSON file fail loudly. */
function manifest(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
}

/**
 * Every workspace member's manifest, as repository-relative paths.
 *
 * Discovery is by directory rather than by a list, so a package added to `packages/` is covered
 * without editing this file. A directory under `apps/` is not necessarily a package —
 * `apps/desktop-bin` is the build tooling and has no manifest — so those are skipped; the count
 * assertion below is what notices if the layout changes wholesale.
 *
 * @returns the manifest paths, sorted so a failure names the same file every run.
 */
function workspaceManifests() {
  return WORKSPACE_GROUPS.flatMap((group) => readdirSync(join(ROOT, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(group, entry.name, 'package.json')))
    .filter((path) => existsSync(join(ROOT, path)))
    .sort()
}

const root = manifest('package.json')
const manifests = workspaceManifests()

describe('release consistency', () => {
  it('finds the workspace members, so an empty sweep cannot pass', () => {
    // The failure mode of a filesystem test is finding nothing and reporting success. The shell, the
    // bundle and the branding package are not optional parts of the repository.
    expect(manifests.length).toBeGreaterThan(10)
    expect(manifests).toContain(join('apps', 'desktop', 'package.json'))
    expect(manifests).toContain(join('packages', 'qialike-desktop-app', 'package.json'))
  })

  it('gives every member the root version', () => {
    expect(root.version).toMatch(/^\d+\.\d+\.\d+$/u)
    const disagreeing = manifests
      .map((path) => ({ path, version: manifest(path).version }))
      .filter((entry) => entry.version !== root.version)
      .map((entry) => `${entry.path}: ${entry.version ?? '(none)'} — expected ${root.version}`)
    expect(disagreeing, 'a release bump touched some manifests but not all of them').toEqual([])
  })

  it('keeps every member private, so a stray publish cannot ship a fragment', () => {
    const publishable = manifests
      .filter((path) => manifest(path).private !== true)
      .map((path) => path)
    expect(publishable, 'these packages are not marked private').toEqual([])
  })
})
