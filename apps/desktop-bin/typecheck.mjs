#!/usr/bin/env node
/**
 * Type check every project, without emitting.
 *
 * WHY THIS IS NOT `tsc -b --dry`. That is what `scripts.typecheck` used to be, and it never type checked
 * anything: `--dry` only reports which projects a build *would* rebuild. Measured on a project containing
 * `const n: number = "…"` (TS2322):
 *
 *   · `tsc -b`        → reports TS2322, exit 1     (this is what `compile` does — a real check)
 *   · `tsc -b --dry`  → exit 0, printing `A non-dry build would build project '…'`
 *
 * So the step was named "type check", described as one in the menu and the docs, and did nothing of the kind.
 * Nothing caught it because it was not in any chain and no test asserted its behaviour: a step that checks
 * nothing is indistinguishable from a step that checks everything and finds no problems.
 *
 * WHY `-p … --noEmit` PER PROJECT INSTEAD OF ONE `-b`. `tsc -b` would write `lib/` — which is exactly what
 * `compile` is for, and doing it here would make two steps with one meaning. `-p <project> --noEmit` type
 * checks and writes nothing, so this step can sit in a fast loop without touching the built tree. The five
 * projects here are independent (no project references between them), so checking each one covers them all.
 *
 * @module qialike-desktop/typecheck
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ROOT } from './lib/paths.mjs'
import { typecheckProjects } from './lib/typecheck-projects.mjs'

/**
 * The TypeScript compiler entry point, resolved rather than looked up on `PATH`.
 *
 * The same reasoning as `lib/electron-binary.mjs`: a bare command name depends on a shim having been generated
 * and on `PATH` being right, and this repository has already been bitten by exactly that once.
 *
 * @returns the absolute path of `bin/tsc`.
 * @throws Error naming the location tried.
 */
function typescriptCompiler() {
  const require = createRequire(join(ROOT, 'package.json'))
  try {
    // Via the manifest, because the package's `exports` map may not expose `bin/tsc` as a subpath.
    return join(require.resolve('typescript/package.json'), '..', 'bin', 'tsc')
  } catch (error) {
    throw new Error(
      'could not resolve the typescript compiler from the repository root '
      + `(${error instanceof Error ? error.message : String(error)}). Run \`pnpm install\` first.`,
    )
  }
}

const requested = process.argv.slice(2)
let projects
try {
  // Explicit arguments win, so a caller (and a test) can point this at any project — that is what makes the
  // "it really does catch a type error" assertion possible without editing the repository's own sources.
  projects = requested.length > 0 ? requested : typecheckProjects(ROOT)
} catch (error) {
  process.stderr.write(`typecheck: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const tsc = typescriptCompiler()
let failed = ''
for (const project of projects) {
  const result = spawnSync(process.execPath, [tsc, '-p', project, '--noEmit'], { cwd: ROOT, stdio: 'inherit' })
  if (result.error !== undefined) {
    process.stderr.write(`typecheck: could not run tsc for ${project}: ${result.error.message}\n`)
    failed = project
    break
  }
  if (result.status !== 0) {
    // Stop at the first failure: tsc's own output is the useful part, and later projects' output would bury it.
    failed = project
    break
  }
}

if (failed !== '') {
  process.stderr.write(`typecheck: FAILED in ${failed}\n`)
  process.exit(1)
}
process.stdout.write(`typecheck: ${projects.length} project(s) checked, nothing emitted\n`)
