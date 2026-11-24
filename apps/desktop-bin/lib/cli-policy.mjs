/**
 * Compile the CLI's two policy modules into our own package.
 *
 * WHY THIS EXISTS AT ALL. The secrets read guard and the shell fences live in
 * `read-policy.ts` and `bash-policy.ts` in the qialike checkout, and DESIGN §7.5
 * requires their semantics here. The obvious move — import them — does not work,
 * twice over:
 *
 *   · `@qialike/qialike-app` exports `./read-policy` nowhere. It is a *source*
 *     module, bundled by the CLI's own build into its root entry.
 *   · The root entry is not importable either: it statically imports `ink` and
 *     `react`, and pulling a terminal UI into the Host process is exactly what
 *     §7.5 forbids and what the `ui-free-shared` gate exists to prevent.
 *
 * DESIGN §5.1 anticipated this and prescribed the answer in its reuse table:
 * read `@qialike/qialike-app/src/**`, "由本仓库构建直接编译这几个源文件". The package
 * already publishes `./src/*`, and the gate already asserts that the dependency
 * graph from these two files never reaches `ink`, `react` or any TUI-only module —
 * which is what makes compiling them safe.
 *
 * WHY `transpileModule` RATHER THAN A PROGRAM. These files import only *types*
 * (`import type { PreToolDecision }`), so there is nothing to resolve and nothing
 * to type-check: the job is a mechanical strip of type syntax. A full program would
 * additionally demand that `@deepseek-ai/dsh-tools` resolve from *this* project,
 * which it does not — that package exists in the assembled runtime tree, not in our
 * `node_modules`. Failing on an unresolvable type import would make the build
 * depend on tree-assembly order for no benefit.
 *
 * The compile is not where safety comes from: `ui-free-shared` is. This step
 * re-asserts the one property it depends on (no runtime import survives into the
 * output) against the actual artifact rather than the source graph.
 *
 * @module qialike-desktop/cli-policy
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/** The sources to compile, and the names they take in our package. */
const SOURCES = [
  { from: 'read-policy.ts', to: 'read-policy.js' },
  { from: 'bash-policy.ts', to: 'bash-policy.js' },
]

/** Where the sources sit inside the qialike checkout. */
const SOURCE_DIR = join('packages', 'qialike-app', 'src')

/**
 * The banner on every emitted file.
 *
 * Generated code that looks hand-written is a trap: the next person edits it, and
 * the edit disappears at the next build. The banner names the source, the command
 * that regenerates it, and the fact that it cannot be imported directly.
 */
const BANNER = (source) => `/**
 * GENERATED — do not edit.
 *
 * Compiled from \`@qialike/qialike-app/src/${source}\` in the qialike checkout by
 * \`apps/desktop-bin/lib/cli-policy.mjs\`, which runs as part of \`pnpm run build\`.
 * The checkout is a read-only input, so the fix for anything wrong here is upstream
 * or in the compile step — never in this file.
 *
 * WHY COMPILED RATHER THAN IMPORTED: the module is not published as a subpath, and
 * the CLI's root entry that contains it statically imports \`ink\` and \`react\`.
 * See the compile step's own header, and DESIGN §5.1.
 */
`

/**
 * Compile the CLI's policy modules into a package's `lib/`.
 *
 * @param options.qialike - the resolved qialike checkout root.
 * @param options.outDir - the directory to write into (created if absent).
 * @param options.log - progress sink.
 * @returns the written file names.
 * @throws Error when a source is missing, or when the output would carry a runtime
 *   import — the two ways this step can silently produce a broken or unsafe module.
 */
export function compileCliPolicy({ qialike, outDir, log = () => {} }) {
  const sourceDir = join(qialike, SOURCE_DIR)
  mkdirSync(outDir, { recursive: true })

  const written = []
  for (const source of SOURCES) {
    const path = join(sourceDir, source.from)
    if (!existsSync(path)) {
      throw new Error(
        `qialike-desktop: the policy source ${SOURCE_DIR}/${source.from} is missing from ${qialike}. `
        + 'DESIGN §7.5 depends on it, so this is a build failure rather than a skipped step: without it the '
        + 'secrets read guard and the shell fences would mount as nothing. Update SOURCES in '
        + 'apps/desktop-bin/lib/cli-policy.mjs if the CLI moved the module.',
      )
    }

    const result = ts.transpileModule(readFileSync(path, 'utf8'), {
      fileName: source.from,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        // Syntax-only: `import type` is elided by construction, and a type error in
        // someone else's module is not this build's to report.
        isolatedModules: true,
        removeComments: false,
      },
    })

    const syntaxErrors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
    if (syntaxErrors.length > 0) {
      const rendered = syntaxErrors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
      throw new Error(
        `qialike-desktop: cannot compile ${SOURCE_DIR}/${source.from}: ${rendered.join('; ')}. `
        + 'The CLI is expected to ship compiling TypeScript; read-only inputs are not exempt from that.',
      )
    }

    // The one property the mount depends on, asserted against the artifact. A
    // surviving runtime import would mean the module is not the pure decision
    // function this package mounts, and on a TUI-only specifier it would drag a
    // terminal UI into the Host.
    const survivingImports = [...result.outputText.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gmu)]
      .map((match) => match[1])
    if (survivingImports.length > 0) {
      throw new Error(
        `qialike-desktop: ${SOURCE_DIR}/${source.from} compiled to a module with runtime imports `
        + `(${survivingImports.join(', ')}). This package mounts it into the Host process, where those would `
        + 'have to resolve and where a terminal UI must never be pulled in. Check for a non-type import.',
      )
    }

    const text = BANNER(source.from) + result.outputText
    const destination = join(outDir, source.to)
    // Written only when the content changed, so a rebuild does not churn mtimes and
    // produce a diff in files nobody edited.
    if (existsSync(destination) && readFileSync(destination, 'utf8') === text) {
      log(`policy: ${source.to} unchanged`)
    } else {
      writeFileSync(destination, text)
      log(`policy: ${source.from} -> ${source.to}`)
    }
    written.push(source.to)
  }
  return written
}

/** The file names {@link compileCliPolicy} produces, for callers that must check them. */
export const CLI_POLICY_FILES = SOURCES.map((source) => source.to)
