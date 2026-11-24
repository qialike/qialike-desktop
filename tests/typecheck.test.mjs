/**
 * The type check step, which used to check nothing.
 *
 * WHY THIS SUITE EXISTS. `scripts.typecheck` was `tsc -b <the five projects> --dry`, and `--dry` does not type
 * check: it reports which projects a build *would* rebuild. A project containing
 * `const n: number = "…"` (TS2322) exits **0** under `--dry` and **1** under `tsc -b`. So for as long as it
 * existed, the step named "type check" — and described that way in the menu and in the docs — type checked
 * nothing at all.
 *
 * Nothing caught it because the step is in no chain and no test asserted what it does. That is the general
 * shape being guarded here: **a step that checks nothing is indistinguishable from a step that checks
 * everything and finds no problems.** So these assertions are about behaviour (does it fail on a type error?)
 * rather than about which flags appear in a string — with one exception noted below, which is cheap and reads
 * as the defect it prevents.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { typecheckProjects } from '../apps/desktop-bin/lib/typecheck-projects.mjs'

const RUNNER = join(ROOT, 'apps', 'desktop-bin', 'typecheck.mjs')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * Run the type check runner and capture its verdict.
 *
 * @param args - project paths; empty means "whatever the manifest says".
 * @returns the exit status and combined output.
 */
function runTypecheck(args = []) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * A throwaway composite project, so the runner can be pointed at a project whose contents this test controls.
 *
 * @param source - the contents of the project's only source file.
 * @returns the project directory.
 */
function scratchProject(source) {
  const dir = mkdtempSync(join(tmpdir(), 'qialike-typecheck-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      composite: true,
      strict: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'out',
      declaration: true,
    },
    include: ['a.ts'],
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'a.ts'), `${source}\n`)
  return dir
}

const created = []
const scratch = (source) => {
  const dir = scratchProject(source)
  created.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

describe('the type check step', () => {
  it('covers exactly the projects compile builds', () => {
    // One list, read from the manifest: the two steps must never drift apart, or one of them stops checking
    // part of the tree.
    const projects = typecheckProjects(ROOT)
    const fromCompile = manifest.scripts['build:packages'].split(/\s+/)
      .filter((token) => token.startsWith('packages/') || token.startsWith('apps/'))
    expect(projects).toEqual(fromCompile)
    expect(projects).toHaveLength(5)
  })

  it('names projects that exist and carry a tsconfig', () => {
    for (const project of typecheckProjects(ROOT)) {
      expect(existsSync(join(ROOT, project, 'tsconfig.json')), `${project}/tsconfig.json is missing`).toBe(true)
    }
  })

  it('fails on a project that contains a type error', () => {
    // THE ASSERTION THIS SUITE EXISTS FOR. Under the old `--dry` spelling this exits 0.
    const { status, output } = runTypecheck([scratch('const n: number = "not a number"')])
    expect(status, output).not.toBe(0)
    expect(output).toContain('TS2322')
  })

  it('passes on a project that is type-correct', () => {
    // The other half of the pair: a runner that failed on everything would satisfy the assertion above.
    const { status, output } = runTypecheck([scratch('const n: number = 1\nexport { n }')])
    expect(status, output).toBe(0)
  })

  it('covers every project it names, not just the first', () => {
    // The runner stops at the first failure, so a bad project in the second position proves it does not stop
    // after the first argument.
    const good = scratch('const n: number = 1\nexport { n }')
    const bad = scratch('const n: number = "not a number"')
    const { status, output } = runTypecheck([good, bad])
    expect(status, output).not.toBe(0)
    expect(output).toContain('TS2322')
  })

  it('checks the repository itself without writing anything', () => {
    // `-p … --noEmit`: this step must be usable in a fast loop without rebuilding `lib/`, which is what
    // `compile` is for.
    const built = join(ROOT, 'apps', 'desktop', 'lib', 'main.js')
    const before = existsSync(built) ? readFileSync(built) : undefined
    const { status, output } = runTypecheck()
    expect(status, output).toBe(0)
    expect(output).toContain('5 project(s)')
    if (before !== undefined) expect(readFileSync(built)).toEqual(before)
  })

  it('does not go back to a flag that reports staleness instead of checking types', () => {
    // A cheap guard, and the readable statement of the defect: `--dry` is the one flag that looks right and
    // checks nothing. Behaviour is asserted above; this keeps the wrong spelling from returning unnoticed.
    expect(manifest.scripts.typecheck).not.toContain('--dry')
  })

  it('is reached from the manifest through the runner, so the link cannot break silently', () => {
    // `verify.sh typecheck` → `pnpm run typecheck` → this file. The behaviour assertions above cover the
    // runner; this covers the edge that would otherwise leave it unused — a fix that is present in the tree
    // and not on the path proves nothing.
    expect(manifest.scripts.typecheck).toContain('apps/desktop-bin/typecheck.mjs')
    expect(existsSync(RUNNER), `${RUNNER} is missing`).toBe(true)
  })
})

describe('the project list', () => {
  /** A repository whose root manifest is whatever the caller supplies. */
  const withManifest = (contents) => {
    const root = mkdtempSync(join(tmpdir(), 'qialike-typecheck-root-'))
    created.push(root)
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(contents, null, 2)}\n`)
    return root
  }

  it('refuses to check nothing when the table is missing', () => {
    // The failure mode that matters: not "reports an error" but "reports nothing and exits 0".
    expect(() => typecheckProjects(withManifest({ scripts: { build: 'node build.mjs' } }))).toThrow(/build:packages/u)
  })

  it('refuses an empty table', () => {
    expect(() => typecheckProjects(withManifest({ scripts: { 'build:packages': '   ' } }))).toThrow(/build:packages/u)
  })

  it('refuses a table that names no project', () => {
    expect(() => typecheckProjects(withManifest({ scripts: { 'build:packages': 'tsc -b --dry' } })))
      .toThrow(/lists no project/u)
  })

  it('reports an unreadable manifest rather than passing quietly', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qialike-typecheck-empty-'))
    created.push(empty)
    expect(() => typecheckProjects(empty)).toThrow(/could not read/u)
  })

  it('follows the table when a project is added to it', () => {
    const root = withManifest({ scripts: { 'build:packages': 'tsc -b packages/one apps/two new-three' } })
    expect(typecheckProjects(root)).toEqual(['packages/one', 'apps/two'])
  })
})
