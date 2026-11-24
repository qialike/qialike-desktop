/**
 * Every file a manifest promises must exist in a fresh checkout.
 *
 * WHY THIS EXISTS, AND WHAT IT CAUGHT. `.gitignore` ignores a package's whole `lib`
 * directory and then un-ignores the hand-written files one by one, because `lib` is *mixed*:
 * a package may compile into it, ship a hand-written browser half beside its compiled
 * siblings, or have nothing to compile it with at all. The exceptions are therefore
 * per-file, and a missing one fails in the worst possible way — **the file is on disk, every
 * other test passes, the build finds it, and only a fresh checkout is broken**, as a package
 * whose `main` points at nothing.
 *
 * It caught exactly that while the edit-follow package was being added: `lib/index.js` and
 * `lib/settings.js` were ignored, so the commit would have carried the browser half of a
 * package whose host half did not exist.
 *
 * THE TWO RULES, WHICH ARE NOT THE SAME RULE.
 *
 *   · `lib/client.js` is hand-written in EVERY package. The harness's client-bundle preset
 *     is unpublished, so there is nothing to generate one with, and `.gitignore` un-ignores
 *     it across `packages/*` for that reason. It must never be ignored anywhere.
 *   · Every other `lib/` file is hand-written only when its package has no `src/` and no
 *     `build` script. When it has either, that file is a build output and must BE ignored —
 *     committing one would put generated code in every source diff, and a rebuild would
 *     churn files nobody had changed.
 *
 * THE FILE NO MANIFEST MENTIONS, which is the case that made this test necessary twice over.
 * The theme row `require`s `lib/tokens.js` without declaring it, and the edit-follow row does
 * the same with `lib/settings.js`; the first run of this suite caught the edit-follow row's
 * `lib/index.js` and NOT its `lib/settings.js`, because only one of them is in the manifest.
 *
 * So a package with no `src` and no `build` script is checked by DIRECTORY: every `.js` under
 * its `lib` is hand-written, because nothing can regenerate any of them. That covers the
 * undeclared sibling without parsing imports — reading relative `require`s out of
 * hand-written JavaScript with a regular expression is the kind of check that reports a false
 * failure the first time someone writes an import it did not anticipate.
 *
 * WHAT IS STILL NOT COVERED: an undeclared hand-written file in a package that DOES compile.
 * There `lib` holds both kinds, so nothing distinguishes them but the manifest, and an
 * unlisted one is invisible to this file. None exists today; the exception would have to be
 * added to `.gitignore` by hand, as the theme's and this row's were.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OWN_PACKAGES } from '../apps/desktop-bin/lib/own-packages.mjs'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

/**
 * The files the build generates, as repository-relative paths.
 *
 * FROM THE BUILD'S OWN DECLARATION, not from a guess about the package. Two packages ship a
 * directory that is partly generated with no `src` and no `build` script to say so —
 * `qialike-desktop-policy` gets `read-policy.js` and `bash-policy.js` compiled from the CLI's
 * sources by `cli-policy.mjs`, and `qialike-desktop-theme` gets `palettes.js` from
 * `cli-themes.mjs`. Inferring "nothing generates this" from an absent `src` therefore
 * misclassified all three as hand-written, which is how the first version of this suite
 * reported them. `OWN_PACKAGES[].requires` is where the build already records exactly this
 * fact — it is the list checked before a package is placed, "a fresh checkout has the entry
 * point and neither dependency" — so it is read rather than duplicated.
 */
const GENERATED = new Set(
  OWN_PACKAGES.flatMap((entry) => (entry.requires ?? []).map((file) => `${entry.dir}/${file}`)),
)

/** Every workspace package directory, from the globs `pnpm-workspace.yaml` declares. */
function packageDirs() {
  const dirs = []
  for (const group of ['packages', 'apps']) {
    const base = join(ROOT, group)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const dir = join(base, name)
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push({ group, name, dir })
    }
  }
  return dirs
}

/**
 * Whether git refuses to add a path.
 *
 * `git check-ignore` is the property worth asserting rather than `git ls-files`: a file that
 * is merely NEW is untracked too, so a tracked-ness assertion would fail on every addition
 * before its first commit — which is precisely when the mistake is worth catching. What
 * matters is that an ignored file cannot be committed at all, `git add -A` included.
 *
 * @param rel - a repository-relative path.
 * @returns whether git ignores it.
 */
function ignored(rel) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', rel], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    // Exit 1 means "not ignored", which is the answer these assertions want.
    return false
  }
}

/** The paths git already tracks. */
const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((line) => line !== ''),
)

/**
 * One package's declared module paths, split by which rule governs them.
 *
 * `main` plus every `exports` target; a string target and a conditional object are both
 * read, because both forms appear here. Paths are normalised and deduplicated in one step,
 * because a manifest may spell one file two ways — `./lib/index.js` in `exports` and
 * `lib/index.js` in `main` — and checking it twice would only obscure the report.
 *
 * @param manifest - the parsed package.json.
 * @returns the browser halves, and the other declared modules.
 */
function declaredEntries(manifest) {
  const all = new Set()
  const add = (value) => {
    if (typeof value === 'string' && /\.(?:js|mjs|cjs)$/u.test(value)) all.add(normalize(value))
    else if (typeof value === 'object' && value !== null) for (const nested of Object.values(value)) add(nested)
  }
  add(manifest.main)
  add(manifest.exports)
  const entries = [...all]
  return {
    browsers: entries.filter((entry) => entry.endsWith('/client.js')),
    others: entries.filter((entry) => !entry.endsWith('/client.js')),
  }
}

/** Every declared module of every package, tagged with why it is (or is not) hand-written. */
function inventory() {
  const rows = []
  for (const { group, name, dir } of packageDirs()) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const generated = existsSync(join(dir, 'src')) || manifest.scripts?.build !== undefined
    const { browsers, others } = declaredEntries(manifest)
    for (const entry of browsers) rows.push({ rel: `${group}/${name}/${entry}`, handWritten: true })
    for (const entry of others) {
      const rel = `${group}/${name}/${entry}`
      rows.push({ rel, handWritten: !generated && !GENERATED.has(rel) })
    }
  }
  return rows.filter((row) => existsSync(join(ROOT, row.rel)))
}

describe('hand-written files are never ignored', () => {
  it('finds the packages to check, so an empty sweep cannot pass', () => {
    const rows = inventory()
    // Both kinds must be present, or one of the two rules below is checking nothing at all.
    expect(rows.filter((row) => row.handWritten).length).toBeGreaterThan(4)
    expect(rows.filter((row) => !row.handWritten).length).toBeGreaterThan(2)
  })

  it('un-ignores every hand-written entry point, browser halves included', () => {
    const broken = inventory().filter((row) => row.handWritten && ignored(row.rel)).map((row) => row.rel)
    expect(broken, 'these files are ignored, so a fresh checkout would not have them').toEqual([])
  })

  it('un-ignores every file in a lib that nothing can regenerate', () => {
    // The declared-entry-point check above cannot see an undeclared sibling, which is how
    // `lib/settings.js` slipped past it. In a package with no `src` and no `build` script
    // every `.js` under `lib` is hand-written, so the directory is the promise.
    const broken = []
    let checked = 0
    for (const { group, name, dir } of packageDirs()) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (existsSync(join(dir, 'src')) || manifest.scripts?.build !== undefined) continue
      const lib = join(dir, 'lib')
      if (!existsSync(lib)) continue
      for (const file of readdirSync(lib)) {
        if (!file.endsWith('.js')) continue
        const rel = `${group}/${name}/lib/${file}`
        // Generated siblings live beside hand-written ones and are named by the build.
        if (GENERATED.has(rel)) continue
        checked += 1
        if (ignored(rel)) broken.push(rel)
      }
    }
    expect(checked, 'no hand-written lib files were found to check').toBeGreaterThan(4)
    expect(broken, 'these files are ignored, so a fresh checkout would not have them').toEqual([])
  })
})

describe('generated files stay ignored', () => {
  it('does not commit an entry point the build regenerates', () => {
    // The other direction. A committed build output would appear in every source diff and be
    // rewritten by every rebuild, so "the file is on disk" is not the point — it must not be
    // in the repository.
    const committed = inventory().filter((row) => !row.handWritten && tracked.has(row.rel)).map((row) => row.rel)
    expect(committed).toEqual([])
  })
})
