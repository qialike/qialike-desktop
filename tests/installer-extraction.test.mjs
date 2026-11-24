/**
 * The Windows installer decompresses its payload once, not twice.
 *
 * WHY THIS SUITE EXISTS. The change it guards lives in a *dependency's* NSIS template
 * (`app-builder-lib`'s `extractAppPackage.nsh`), applied by `pnpm patch`, and nothing in
 * this repository's source would look different if it stopped being applied. The file a
 * reader would inspect — `apps/desktop/electron-builder.config.mjs` — is unchanged by the
 * patch, and `path: line` review cannot see inside `node_modules`. So the property is
 * asserted here, against the template electron-builder actually resolves, rather than
 * trusted to the lockfile.
 *
 * WHAT IT COSTS TO GET WRONG. Upstream's macro decompresses into `$PLUGINSDIR\7z-out` and
 * then copies the whole tree into the install directory with `CopyFiles`, writing every
 * file twice. Measured on this application's 25,838-file payload, that second write is
 * 237 s of a 582 s install. Reverting the patch does not break the build — it just makes
 * every install five times slower, silently, which is exactly the kind of regression a
 * test has to catch because no gate would.
 *
 * THE OTHER HALF IS THAT THE FAILURE PATH SURVIVES. `CopyFiles` reports a locked
 * destination through NSIS's error flag, and upstream's retry loop is built on it. The
 * patched macro checks `Nsis7z::Extract`'s own result instead, so a failed decompression
 * is still reported instead of leaving a half-written installation behind.
 *
 * The reasoning, the measurements, and the two alternatives that were built and timed are
 * in `docs/desktop/windows-install-performance.md`.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const require = createRequire(import.meta.url)

/**
 * The `package.json` of the `app-builder-lib` that electron-builder resolves.
 *
 * Resolved through `electron-builder`'s own manifest rather than by globbing
 * `node_modules/.pnpm/app-builder-lib@*`, because `pnpm patch` leaves the unpatched
 * directory in place beside the patched one. A glob would happily read the stale copy and
 * report the two-phase extraction as still present — or, worse, the reverse of what the
 * build does.
 *
 * @returns the absolute path to the resolved package's manifest.
 * @throws Error when the resolution chain is broken.
 */
function appBuilderLibManifest() {
  const builderManifest = require.resolve('electron-builder/package.json')
  return createRequire(builderManifest).resolve('app-builder-lib/package.json')
}

/**
 * The NSIS template electron-builder will compile.
 *
 * @returns the template's source text.
 * @throws Error when the template is missing, which is its own regression.
 */
function installerTemplate() {
  return readFileSync(
    join(dirname(appBuilderLibManifest()), 'templates', 'nsis', 'include', 'extractAppPackage.nsh'),
    'utf8',
  )
}

/**
 * The body of one `!macro`, without its comments or blank lines.
 *
 * Comments are dropped because the patched macro *documents* the `CopyFiles` pass it
 * replaces; an assertion against the raw text would fail on its own explanation. Blank
 * lines are dropped so a `toEqual` on directives reads as the sequence of things NSIS
 * will actually do.
 *
 * @param source - the template's text.
 * @param name - the macro to extract, without the `!macro` prefix.
 * @returns the macro's directive lines, trimmed.
 * @throws Error when the macro is absent, which is its own regression.
 */
function macroDirectives(source, name) {
  const start = source.indexOf(`!macro ${name} `)
  if (start === -1) throw new Error(`no !macro ${name} in the NSIS template`)
  const end = source.indexOf('!macroend', start)
  if (end === -1) throw new Error(`!macro ${name} is not closed`)
  return source.slice(start, end).split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

describe('the payload is decompressed once, straight into the install directory', () => {
  it('resolves to a template through electron-builder, not to a stale copy beside it', () => {
    // Not a tautology: it is what makes every assertion below about the package the build
    // uses. If it ever resolved elsewhere, the rest of this file would be describing a file
    // nobody compiles.
    expect(installerTemplate()).toContain('!macro extractUsing7za FILE')
  })

  it('does not stage the tree in $PLUGINSDIR and copy it afterwards', () => {
    const directives = macroDirectives(installerTemplate(), 'extractUsing7za').join('\n')

    // The two-phase shape, each half asserted separately so a failure names which half
    // came back: the staging directory, and the copy that reads from it.
    expect(directives).not.toContain('7z-out')
    expect(directives).not.toContain('CopyFiles')
    expect(directives).not.toContain('RMDir')
  })

  it('decompresses exactly once, into whatever $OUTDIR the installer set', () => {
    const directives = macroDirectives(installerTemplate(), 'extractUsing7za')

    const extractions = directives.filter((line) => line.startsWith('Nsis7z::Extract'))
    expect(extractions).toEqual(['Nsis7z::Extract "${FILE}"'])
    // Upstream aimed the decompression at its own scratch directory first. With no staging
    // there is nothing to aim, and an added `SetOutPath` here would silently relocate the
    // installation: `installSection.nsh` sets `$OUTDIR` to `$INSTDIR` before calling in.
    expect(directives.filter((line) => line.startsWith('SetOutPath'))).toEqual([])
  })

  it('checks the post-condition, because there is no return value to check', () => {
    const directives = macroDirectives(installerTemplate(), 'extractUsing7za')

    // THE ASSERTION THIS FILE GOT WRONG FIRST, AND WHY IT MATTERS.
    //
    // `Nsis7z::Extract` reports NOTHING: it pushes no result and sets no error flag. The
    // first version of this patch assumed otherwise and checked `Pop $R0` / `$R0 != ""`.
    // That pops a value the macro never pushed, and NSIS answers an empty pop by raising
    // its own error flag and LEAVING THE VARIABLE UNTOUCHED — so the test would have read
    // whatever unrelated code last wrote `$R0`. Since the branch ends in `Quit`, that is
    // either dead code or an aborted installation, and which one it is would depend on the
    // installer's register state.
    //
    // The save/restore pair upstream has around its own `Pop` is what makes this checkable
    // without running anything: `Push $OUTDIR` … `Pop $R0` … `SetOutPath $R0` can only be a
    // save and a restore of `$OUTDIR`, because if `Pop $R0` read an extraction result then
    // `SetOutPath $R0` would aim `$OUTDIR` at that result and upstream's own `CopyFiles`
    // would copy the application nowhere. So nothing may be popped here.
    expect(directives.filter((line) => line.startsWith('Pop'))).toEqual([])

    // What replaces it: a post-condition that cannot be confused with a return value. Joined for the
    // containment assertions below — `toContain` on an array is membership, not a substring search, and
    // mixing the two silently asserts the wrong thing.
    const text = directives.join('\n')
    expect(text).toContain('${IfNot} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(text).toContain('$(decompressionFailed)')
    expect(text).toContain('Quit')
  })
})

describe('the patch is declared, and the patch and the tree agree', () => {
  /** The path `pnpm-workspace.yaml` declares for app-builder-lib's patch. */
  function declaredPatchPath() {
    const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
    const block = /patchedDependencies:\n((?:\s+.*\n)+)/u.exec(workspace)?.[1] ?? ''
    const match = /^\s+app-builder-lib@(\S+):\s*(\S+)\s*$/mu.exec(block)
    if (match === null) throw new Error('pnpm-workspace.yaml declares no app-builder-lib patch')
    return { spec: match[1], path: match[2] }
  }

  it('declares a patch for the app-builder-lib version that is installed', () => {
    const { spec, path: patchPath } = declaredPatchPath()
    const installed = JSON.parse(readFileSync(appBuilderLibManifest(), 'utf8'))
    // A version bump that leaves the patch behind is the failure this catches: pnpm would
    // then apply nothing, the install would quietly go back to writing every file twice,
    // and the only symptom would be a slower installer.
    expect(spec).toBe(installed.version)
    expect(patchPath).toBe(`patches/app-builder-lib@${spec}.patch`)
  })

  it('keeps the reasoning in the patch file, so the edit is reviewable outside node_modules', () => {
    const { path: patchPath } = declaredPatchPath()
    const patch = readFileSync(join(ROOT, patchPath), 'utf8')

    // The patch is the reviewable artifact; node_modules is not in review. It has to carry
    // the macro it replaces and the reason, not just a diff with no explanation.
    expect(patch).toContain('diff --git a/templates/nsis/include/extractAppPackage.nsh')
    expect(patch).toContain('!macro extractUsing7za FILE')
    expect(patch).toContain('EXTRACT STRAIGHT INTO THE INSTALLATION DIRECTORY')
    expect(patch).toContain('CopyFiles')
  })
})

describe('what the installer keeps, because the patch was chosen over the cheaper alternatives', () => {
  it('still builds a differential package, so the updater keeps its block map', async () => {
    // The point of patching the template rather than passing `useZip: true`: a zip build
    // takes the `nsisunz::Unzip` branch, which extracts in one pass too, but it forces
    // `differentialPackage` off — costing the updater its block map and the downloader
    // about 41.5 MB on every update. Asserted here because that trade is the whole reason
    // this patch exists, and it is one config line away from being undone.
    const config = (await import('../apps/desktop/electron-builder.config.mjs')).default
    expect(config.nsis.differentialPackage).toBe(true)
    expect(config.nsis.useZip).toBeUndefined()
  })
})
