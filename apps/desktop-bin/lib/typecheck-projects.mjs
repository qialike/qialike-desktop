/**
 * The projects the type check covers, read from the manifest instead of restated here.
 *
 * WHY DERIVE. `compile` and the type check must cover the **same** projects, or one of them quietly stops
 * checking part of the tree. The list already exists — it is the argument list of `scripts.build:packages` —
 * so it is read from there rather than copied. Add a project to that script and the type check follows.
 *
 * WHY IT THROWS INSTEAD OF RETURNING AN EMPTY LIST. The failure this guards against is not "the check reports
 * an error" but "the check reports nothing and exits 0". A step that type checks zero projects looks exactly
 * like a step that type checks everything and finds no problems — the same shape as the defect this module was
 * written for, where `tsc -b --dry` exited 0 without type checking anything at all. So a missing, renamed or
 * emptied table is an error, never a pass.
 *
 * @module qialike-desktop/typecheck-projects
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A project path in the manifest starts with one of these. */
const PROJECT_PREFIXES = ['packages/', 'apps/']

/**
 * The project directories to type check.
 *
 * @param root - the repository root.
 * @returns project paths relative to `root`, in manifest order.
 * @throws Error when the manifest or its `build:packages` table cannot yield any project.
 */
export function typecheckProjects(root) {
  const manifestPath = join(root, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const script = manifest?.scripts?.['build:packages']
  if (typeof script !== 'string' || script.trim() === '') {
    throw new Error(
      `${manifestPath} has no non-empty scripts.build:packages, which is where the project list lives. `
      + 'Without it the type check would cover nothing and still succeed.',
    )
  }

  const projects = script.split(/\s+/).filter((token) => PROJECT_PREFIXES.some((prefix) => token.startsWith(prefix)))
  if (projects.length === 0) {
    throw new Error(
      `scripts.build:packages in ${manifestPath} lists no project (nothing starting with `
      + `${PROJECT_PREFIXES.map((p) => `'${p}'`).join(' or ')}): ${script}`,
    )
  }
  return projects
}
