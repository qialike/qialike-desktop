/**
 * Gate: the shared runtime modules must stay free of terminal-UI dependencies.
 *
 * This application reuses host-side modules from the qialike CLI's
 * `@qialike/qialike-app` package — `llm.ts` and its provider templates,
 * `fs-tools.ts`, `bash-policy.ts`, `read-policy.ts`, `config.ts` (DESIGN §1.3).
 * That reuse works because those modules are UI-agnostic: they talk to harness
 * services, not to Ink. The CLI's own panels are the Ink consumers and are not
 * reused.
 *
 * Nothing in the CLI enforces that separation, and nothing needs to: for the CLI
 * every module ends up in one bundle either way. For this application it is a
 * real constraint, because the shared modules are compiled into a Node host
 * process where `ink` does not exist. A single convenience import added in the
 * CLI app — a `formatRow` helper pulled from a panel, say — would break this
 * build while leaving the CLI perfectly healthy.
 *
 * The gate walks the import graph from each shared entry point and fails on a
 * forbidden specifier. It is deliberately a *source* check on the CLI checkout
 * rather than a check of our own build output, so the failure names the file
 * that introduced the dependency instead of surfacing as a resolution error
 * somewhere downstream.
 *
 * @module qialike-desktop/gates/ui-free-shared
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { qialikeRoot } from '../lib/paths.mjs'

/**
 * The modules this application reuses from the CLI's app package.
 *
 * Each is a plain `.ts` module with no JSX; a `.tsx` file would be a mistake
 * here and the gate should say so rather than fail on a parse error.
 */
export const SHARED_MODULES = [
  'packages/qialike-app/src/llm.ts',
  'packages/qialike-app/src/fs-tools.ts',
  'packages/qialike-app/src/bash-policy.ts',
  'packages/qialike-app/src/read-policy.ts',
  'packages/qialike-app/src/config.ts',
]

/**
 * Specifiers the shared graph may never reach.
 *
 * `ink` and `react` are the terminal UI; `react-dom` its renderer. `yoga-wasm-web`
 * arrives through Ink's layout engine. The `@qialike/qialike-app` subpaths that
 * name a panel or the TUI runtime are listed individually because a relative
 * import is resolved to a path first, and these are the module names a future
 * shared helper might plausibly reach for.
 */
export const FORBIDDEN_SPECIFIERS = new Set([
  'ink',
  'react',
  'react-dom',
  'react/jsx-runtime',
  'yoga-wasm-web',
  'string-width',
  '@qialike/qialike-app/panels-conversation',
  '@qialike/qialike-app/panels-approval',
  '@qialike/qialike-app/panels-question',
  '@qialike/qialike-app/panels-models',
])

/** File extensions the walk follows when a relative specifier has none. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json']

/**
 * Extract every module specifier a source file imports or requires.
 *
 * A regex rather than a parser: this runs over another repository's sources,
 * whose toolchain is not ours to depend on, and only the specifier text is
 * needed. Both the static forms and `require`/dynamic `import()` are matched so
 * a lazily-imported panel cannot slip through.
 *
 * @param source - the file text.
 * @returns the specifiers in source order.
 */
export function importSpecifiers(source) {
  const found = []
  const patterns = [
    /\bimport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g, // import x from 'y'
    /\bimport\s*['"]([^'"]+)['"]/g, // import 'y'
    /\bexport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g, // export { x } from 'y'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('y')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('y')
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1])
  }
  return found
}

/**
 * Resolve a relative specifier to a file in the checkout.
 * @returns the absolute path, or undefined when nothing matches.
 */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  if (existsSync(base) && !base.endsWith('/')) {
    try {
      if (readFileSync(base, 'utf8') !== undefined) return base
    } catch { /* a directory: fall through to extension probing */ }
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    if (existsSync(base + extension)) return base + extension
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const indexed = join(base, `index${extension}`)
    if (existsSync(indexed)) return indexed
  }
  return undefined
}

/**
 * Walk the import graph from the shared entry points, looking for forbidden specifiers.
 *
 * @param qialike - the qialike checkout root.
 * @returns one violation per offending edge, empty when clean.
 */
export function checkSharedModulesUIFree(qialike) {
  const violations = []
  const visited = new Set()
  const queue = []

  for (const relativePath of SHARED_MODULES) {
    const entry = join(qialike, relativePath)
    if (!existsSync(entry)) {
      violations.push({
        kind: 'missing-entry',
        file: relativePath,
        specifier: undefined,
        detail: `the shared module ${relativePath} is not in the qialike checkout at ${qialike}`,
      })
      continue
    }
    queue.push({ file: entry, origin: relativePath })
  }

  while (queue.length > 0) {
    const { file, origin } = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)

    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const specifier of importSpecifiers(source)) {
      if (FORBIDDEN_SPECIFIERS.has(specifier)) {
        violations.push({
          kind: 'forbidden-import',
          file: relative(qialike, file),
          specifier,
          detail: `${relative(qialike, file)} imports ${specifier}, reached from ${origin}. `
            + 'The shared modules are compiled into a Node host process, where the terminal UI does not exist.',
        })
        continue
      }
      if (!specifier.startsWith('.')) continue
      const resolved = resolveRelative(file, specifier)
      if (resolved !== undefined) queue.push({ file: resolved, origin })
    }
  }
  return violations
}

/**
 * Gate entry point.
 * @returns `{ ok, violations }`.
 */
export function run() {
  const qialike = qialikeRoot()
  const violations = checkSharedModulesUIFree(qialike)
  return { ok: violations.length === 0, violations }
}

/** Render the gate result for a CLI run. */
export function format(result) {
  if (result.ok) return 'ui-free-shared: ok'
  return ['ui-free-shared: FAILED', ...result.violations.map((v) => `  - ${v.detail}`)].join('\n')
}
