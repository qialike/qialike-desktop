/**
 * Take the CLI's colour schemes out of its sources.
 *
 * WHAT IS BEING EXTRACTED, AND WHY IT IS NOT AN IMPORT. The schemes live in two
 * places in the qialike checkout, and neither is reachable by importing:
 *
 *   · `classic-schemes.ts` — 13 third-party skins (catppuccin, dracula, gruvbox, …)
 *     as a plain `Record<string, ThemePalette>`. It imports only a *type*, so it
 *     transpiles cleanly, exactly like the policy modules in `cli-policy.mjs`.
 *   · `theme-plugin.ts` — the two remaining palettes (`light` = Atom One Light,
 *     `one-dark` = Atom One Dark) written as inline literals inside a module that
 *     imports React and drives an Ink dialog. It cannot be imported, and the hexes
 *     are upstream provenance that should not be retyped into this repository and
 *     left to drift.
 *
 * So the literals are read out of the **syntax tree** instead: a `BUILTIN_SCHEMES`
 * object literal whose properties are objects of string values is unambiguous, and
 * reading it costs one AST walk with no evaluation — React is never loaded.
 *
 * The third built-in, `dark`, is deliberately skipped. It is `{ ...theme }`, the
 * TUI palette proxy's initial values, which are the harness's *own* web dark
 * palette — this surface already ships that as its built-in `dark`, so registering
 * it again would be a second theme with one palette.
 *
 * WHAT IS NOT EXTRACTED: `theme.ts`'s `DEFAULTS` is not exported, and the CLI's
 * `theme` proxy is a mutable TUI singleton rather than scheme data. Neither is
 * needed once `dark` is skipped.
 *
 * @module qialike-desktop/cli-themes
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import ts from 'typescript'

/** The sources, and what each contributes. */
const CLASSIC = { file: 'classic-schemes.ts', exportName: 'CLASSIC_SCHEMES' }
const PLUGIN = { file: 'theme-plugin.ts', objectName: 'BUILTIN_SCHEMES' }

/** The palettes to read out of `theme-plugin.ts`'s object literal, in output order. */
const EXTRACTED = ['light', 'one-dark']

/** Where the sources sit inside the qialike checkout. */
const SOURCE_DIR = join('packages', 'qialike-app', 'src')

/**
 * The palette keys, in the CLI's declaration order.
 *
 * Duplicated here as a *contract check* rather than as a mapping: a palette that
 * gained or lost a key would otherwise flow straight into the token table, where a
 * missing key silently yields one unstyled surface instead of a build failure.
 */
export const PALETTE_KEYS = [
  'bg', 'panel', 'element', 'borderSubtle', 'border', 'borderActive',
  'text', 'textMuted', 'primary', 'secondary', 'accent',
  'success', 'warning', 'info', 'error', 'yellow',
]

/** A palette is a record of the keys above to CSS colour strings. */
function assertPalette(name, palette) {
  const missing = PALETTE_KEYS.filter((key) => typeof palette?.[key] !== 'string')
  const extra = Object.keys(palette ?? {}).filter((key) => !PALETTE_KEYS.includes(key))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `qialike-desktop: the scheme "${name}" does not match the palette shape: `
      + `${missing.length > 0 ? `missing ${missing.join(', ')}` : ''}`
      + `${missing.length > 0 && extra.length > 0 ? '; ' : ''}`
      + `${extra.length > 0 ? `unexpected ${extra.join(', ')}` : ''}. `
      + 'The scheme sources changed shape, so the token mapping in lib/tokens.js no longer covers them. '
      + 'Update PALETTE_KEYS and the mapping together.',
    )
  }
}

/** Transpile one source module to ESM text, failing on syntax errors. */
function transpile(path, fileName) {
  const result = ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, isolatedModules: true },
  })
  const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length > 0) {
    throw new Error(
      `qialike-desktop: cannot compile ${fileName}: `
      + errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    )
  }
  return result.outputText
}

/**
 * Read the palettes out of `theme-plugin.ts`'s `BUILTIN_SCHEMES` literal.
 *
 * Only object literals of string-valued properties are taken. The two spreads the
 * literal also contains (`{ ...theme }` for `dark`, `...CLASSIC_SCHEMES`) are
 * skipped by shape rather than by name, so the walker keeps working if upstream
 * reorders or adds another inline scheme.
 *
 * @param source - the module text.
 * @returns the palettes found, keyed by property name.
 */
function extractInlinePalettes(source) {
  const file = ts.createSourceFile('theme-plugin.ts', source, ts.ScriptTarget.ES2023, true)
  const found = {}
  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== PLUGIN.objectName) continue
        if (declaration.initializer === undefined || !ts.isObjectLiteralExpression(declaration.initializer)) {
          throw new Error(`qialike-desktop: ${PLUGIN.objectName} in ${PLUGIN.file} is not an object literal`)
        }
        for (const property of declaration.initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue
          const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined
          if (name === undefined) continue
          const palette = {}
          for (const entry of property.initializer.properties) {
            if (!ts.isPropertyAssignment(entry) || !ts.isStringLiteralLike(entry.initializer)) continue
            const key = ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name) ? entry.name.text : undefined
            if (key !== undefined) palette[key] = entry.initializer.text
          }
          found[name] = palette
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The banner on the generated module, naming what produced it. */
const BANNER = `/**
 * GENERATED — do not edit.
 *
 * The CLI's colour schemes, read out of the qialike checkout by
 * \`apps/desktop-bin/lib/cli-themes.mjs\` as part of \`pnpm run build\`. The checkout is
 * a read-only input, so a wrong value here is fixed upstream or in the extraction
 * step — never in this file.
 *
 * Each palette is the CLI's 16-key semantic palette (bg, panel, element, borders,
 * text, primary/secondary/accent, and the four states). It is NOT a set of CSS
 * tokens: the mapping from these roles to \`--dsw-alias-*\` lives in \`lib/tokens.js\`,
 * which is hand-written and reviewed, because it is a judgement about this surface
 * rather than a fact about the CLI's.
 */
`

/**
 * Compile the CLI's schemes into a package's `lib/`.
 *
 * @param options.qialike - the resolved qialike checkout root.
 * @param options.outDir - the directory to write into (created if absent).
 * @param options.log - progress sink.
 * @returns the generated file name.
 * @throws Error when a source is missing, of the wrong shape, or the schemes come
 *   out empty — each of which would otherwise ship a theme list that is short or
 *   malformed with no build-time signal.
 *
 * Asynchronous because the classic skins are read by *importing* their transpiled
 * copy: writing it to a scratch file and importing is what keeps the CLI as the
 * single source of those hexes, and it is worth one `await` in the build.
 */
export async function compileCliThemes({ qialike, outDir, log = () => {} }) {
  const sourceDir = join(qialike, SOURCE_DIR)
  for (const { file } of [CLASSIC, PLUGIN]) {
    if (!existsSync(join(sourceDir, file))) {
      throw new Error(
        `qialike-desktop: the scheme source ${SOURCE_DIR}/${file} is missing from ${qialike}. `
        + 'DESIGN §7.3 depends on the CLI\'s built-in schemes, so this is a build failure rather than a '
        + 'skipped step. Update the paths in apps/desktop-bin/lib/cli-themes.mjs if the CLI moved them.',
      )
    }
  }

  // `classic-schemes.ts` is transpiled and imported rather than parsed, because its
  // values are already a data structure; only the React-coupled module needs the AST
  // walk. The transpiled copy goes to a scratch file so the import cannot pick up a
  // stale artifact from the runtime tree.
  const scratch = join(tmpdir(), `qialike-classic-${String(process.pid)}.mjs`)
  writeFileSync(scratch, transpile(join(sourceDir, CLASSIC.file), CLASSIC.file))
  let classic
  try {
    const module = await import(pathToFileURL(scratch).href)
    classic = module[CLASSIC.exportName]
    if (classic === undefined || typeof classic !== 'object') {
      throw new Error(`qialike-desktop: ${CLASSIC.file} exports no ${CLASSIC.exportName}`)
    }
  } finally {
    rmSync(scratch, { force: true })
  }

  const inline = extractInlinePalettes(readFileSync(join(sourceDir, PLUGIN.file), 'utf8'))
  const palettes = {}
  for (const [name, palette] of Object.entries(classic)) {
    assertPalette(name, palette)
    palettes[name] = palette
  }
  for (const name of EXTRACTED) {
    const palette = inline[name]
    if (palette === undefined) {
      throw new Error(
        `qialike-desktop: ${PLUGIN.file} declares no inline "${name}" scheme. It was found by walking `
        + `${PLUGIN.objectName}'s object literal, so upstream renamed or restructured it — update EXTRACTED `
        + 'in apps/desktop-bin/lib/cli-themes.mjs.',
      )
    }
    assertPalette(name, palette)
    palettes[name] = palette
  }
  if (Object.keys(palettes).length === 0) {
    throw new Error('qialike-desktop: extraction produced no schemes at all')
  }

  mkdirSync(outDir, { recursive: true })
  const body = `${BANNER}export const SCHEME_PALETTES = ${JSON.stringify(palettes, null, 2)}\n`
  const destination = join(outDir, 'palettes.js')
  if (existsSync(destination) && readFileSync(destination, 'utf8') === body) {
    log(`themes: palettes.js unchanged (${String(Object.keys(palettes).length)} schemes)`)
  } else {
    writeFileSync(destination, body)
    log(`themes: palettes.js (${String(Object.keys(palettes).length)} schemes: ${Object.keys(palettes).join(', ')})`)
  }
  return 'palettes.js'
}
