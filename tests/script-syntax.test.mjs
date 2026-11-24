/**
 * Every diagnostic script in this repository parses.
 *
 * WHY THIS IS A TEST AND NOT A HABIT. The probes, the e2e chain and the packager are
 * plain `.mjs` programs that no build step touches — `tsc` never sees them, no bundler
 * reads them, and nothing imports them. So a syntax error in one of them is discovered
 * at the worst possible moment: when someone runs a release check and gets a stack
 * trace from `node:internal/modules/esm/loader` instead of a measurement.
 *
 * THAT IS NOT HYPOTHETICAL, WHICH IS WHY THE FILE EXISTS. `apps/desktop-bin/e2e.mjs`
 * was written with a quoted identifier inside a comment *inside a template literal* —
 * the comment text closed the template mid-expression. The reported line was where the
 * parser gave up rather than where the problem was, so it took a bisect over fourteen
 * truncations to find, on a file whose whole purpose is to save exactly that kind of
 * time. The harness itself warns about this in a comment ("No backticks in this
 * comment: it lives inside a template literal"), which is how the class is known.
 *
 * A `node --check` per file is a fraction of a second and would have caught it before
 * the first run, so it is asserted here rather than remembered.
 *
 * The second assertion is about the same mistake in a different costume: an `.mjs`
 * file whose top level uses `await` must actually be a module, and `node --check`
 * reports that separately from a parse error. Both are covered by the same command, so
 * the test reports the checker's own message verbatim rather than paraphrasing it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

/**
 * Every `.mjs` under a directory, recursively.
 *
 * @param dir - the directory to walk.
 * @returns absolute paths, sorted so a failure names the same file every run.
 */
function scriptsUnder(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...scriptsUnder(path))
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(path)
  }
  return out
}

describe('the repository’s standalone scripts', () => {
  // `apps/desktop-bin` holds the farm, the packager, the gates and every probe. It is
  // the directory a release runs, and none of it is compiled.
  const scripts = scriptsUnder(join(ROOT, 'apps', 'desktop-bin'))

  it('finds the scripts, so this suite cannot pass by walking an empty tree', () => {
    // The failure mode of a file-system test is finding nothing and reporting success.
    // The packager and the probes are not optional parts of the repository.
    expect(scripts.length).toBeGreaterThan(15)
    expect(scripts.map((path) => relative(ROOT, path))).toContain(join('apps', 'desktop-bin', 'e2e.mjs'))
  })

  for (const script of scripts) {
    const name = relative(ROOT, script)
    it(`${name} parses`, () => {
      // `--check` reads the file and compiles it without running it, which is exactly
      // the question: a probe that does something on import must not be executed here.
      try {
        execFileSync(process.execPath, ['--check', script], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
        // The checker's own message, verbatim: it names the line and the construct, and
        // a paraphrase would drop the one detail that makes it findable.
        expect.fail(`${name} does not parse:\n${output}`)
      }
    })
  }

  it('gates and probes are executable-agnostic, so a missing bit is not a failure', () => {
    // Recording an expectation rather than asserting one: these run through `node`, not
    // through their own shebang, so the mode is not load-bearing. Asserted as a
    // property of the set so a future reader does not "fix" it by chmod'ing.
    for (const script of scripts) {
      const mode = statSync(script).mode & 0o777
      expect(mode & 0o400, `${relative(ROOT, script)} should be readable`).toBe(0o400)
    }
  })
})
