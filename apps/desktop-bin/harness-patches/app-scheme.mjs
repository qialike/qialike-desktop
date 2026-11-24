/**
 * Build-time patch: teach the shipped browser surface this application's scheme.
 *
 * WHY THIS PATCH EXISTS AT ALL. The harness browser surface hardcodes its own
 * application scheme in two places, at two different layers, and both of them
 * have to agree with the scheme this shell actually registers or local images
 * silently stop rendering:
 *
 *   1. `@deepseek-ai/dsh-util-workspace-path`'s `fileMediaUrl(base, path)` refuses
 *      any base that is neither `http(s):` nor `dsh-app://app/`. It returns
 *      `undefined`, so the caller's `resolve()` returns `undefined`, and the image
 *      stays inert. This is the *first* gate — it fires before a URL exists.
 *   2. `@deepseek-ai/dsh-client-ui-primitives`'s markdown renderer re-checks the
 *      rewritten URL against `dsh-app://app/api/file?` before displaying it.
 *
 * Neither failure throws, logs, or degrades visibly: the image is replaced by its
 * alt text. That is the R4 class of defect (a package that starts normally and
 * quietly does less), and it is why this patch fails the build on a moved anchor
 * rather than skipping.
 *
 * WHY PATCHING RATHER THAN RENAMING THE SCHEME. Registering the shell as
 * `dsh-app:` would make both literals correct for free (DESIGN §12.2 R10 records
 * that alternative). This build keeps `qialike-app` — a decision, not an
 * accident — and pays for it with the two edits below.
 *
 * WHERE THE CODE ACTUALLY RUNS. The literal is not in one file. It is inlined,
 * separately, into each artifact that uses it:
 *
 *   · `assets/index-<hash>.js` in the built Web dist — the markdown renderer's
 *     whitelist. This file lives in the **harness checkout** (`apps/web/dist`),
 *     which is read-only, so {@link stageWebFrontendSchemed} copies it into the
 *     scratch directory first and the runtime tree is assembled from the copy.
 *   · `client-ui-chat/lib/client.js` and
 *     `client-ui-sidebar-documentpreview/lib/client.js` — `fileMediaUrl`, inlined
 *     into each plugin bundle that calls it. These are farm copies.
 *
 * WHY THE ANCHOR IS THE BARE ORIGIN. Each target contains the literal
 * `dsh-app://app/` and nothing else that resembles it, so the patch rewrites
 * every occurrence of that one string rather than matching the surrounding
 * syntax. Bundled output is minified and its identifiers change between harness
 * releases; the origin does not. A whole-file literal replace is therefore both
 * narrower and more durable than an expression-shaped anchor.
 *
 * THE MAP FILES ARE LEFT ALONE. `assets/*.js.map` also carries the literal (in
 * `sourcesContent`). Rewriting several megabytes of source maps to keep a
 * devtools view byte-accurate would slow every build for no runtime effect, so
 * the maps stay stale while the executed JavaScript is corrected. Debuggers
 * viewing that one function will show the upstream spelling.
 *
 * @module qialike-desktop/harness-patches/app-scheme
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The scheme this application registers, as `apps/desktop/src/main.ts` spells it. */
export const APP_SCHEME = 'qialike-app'

/** The application origin; the value every rewritten literal has to produce. */
export const APP_ORIGIN = `${APP_SCHEME}://app`

/** The upstream origin every anchor in this patch is written against. */
export const UPSTREAM_ORIGIN = 'dsh-app://app'

/**
 * Farm files that **execute in the browser** and carry `fileMediaUrl`'s base guard.
 *
 * These are required: the boot graph fetches both plugin bundles, so a farm
 * without them is a farm this build does not understand, not a farm that does
 * not need the patch.
 */
const REQUIRED_FARM_ANCHORS = [
  '-deepseek-ai-dsh-client-ui-chat/lib/client.js',
  '-deepseek-ai-dsh-client-ui-sidebar-documentpreview/lib/client.js',
]

/**
 * Farm files that carry the literal but are not fetched by the browser.
 *
 * `@deepseek-ai/dsh-util-workspace-path` and `@deepseek-ai/dsh-client-ui-primitives`
 * ship no `dsh.client` entry, so they are libraries inlined into the bundles
 * above rather than plugin bundles of their own. They are patched when present so
 * the tree stays self-consistent, and skipped when absent, because their absence
 * costs nothing at runtime.
 */
const OPTIONAL_FARM_ANCHORS = [
  '-deepseek-ai-dsh-util-workspace-path/lib/index.js',
  '-deepseek-ai-dsh-util-workspace-path/lib/types/index.js',
  '-deepseek-ai-dsh-client-ui-primitives/lib/index.js',
]

/**
 * Rewrite every upstream origin in one file into this application's.
 *
 * @param path - the file to rewrite.
 * @param options.required - whether a file without the literal is a failure.
 * @param options.log - progress sink.
 * @returns `'patched'`, `'already'`, or `'absent'` (skipped).
 * @throws Error when `required` and the file carries neither spelling.
 */
function rewriteOrigin(path, { required, log }) {
  const text = readFileSync(path, 'utf8')
  if (text.includes(UPSTREAM_ORIGIN)) {
    writeFileSync(path, text.replaceAll(UPSTREAM_ORIGIN, APP_ORIGIN))
    log(`app-scheme: patched ${path}`)
    return 'patched'
  }
  if (text.includes(APP_ORIGIN)) {
    log(`app-scheme: already applied (${path})`)
    return 'already'
  }
  if (!required) return 'absent'
  throw new Error(
    `qialike-desktop: ${path} contains neither "${UPSTREAM_ORIGIN}" nor "${APP_ORIGIN}". The `
    + 'harness no longer spells its application origin the way this patch expects, so the scheme '
    + 'rewrite can no longer be applied.\n'
    + '  · Re-read the current origin in the harness checkout and update this module '
    + '(apps/desktop-bin/harness-patches/app-scheme.mjs).\n'
    + '  · Do not delete this patch while the shell registers APP_SCHEME: without it the markdown '
    + 'renderer refuses every local image and `fileMediaUrl` returns undefined, both silently '
    + '(DESIGN §12.2 R10).',
  )
}

/**
 * Adopt this application's scheme in the farm copies of the shipped client code.
 *
 * @param root - the farm root (never the harness checkout).
 * @param log - progress sink.
 * @returns the files written, in the order they were visited.
 * @throws Error when a required anchor file is missing or has moved.
 */
export function patchAppSchemeFarm({ root, log = () => {} }) {
  const written = []
  for (const file of REQUIRED_FARM_ANCHORS) {
    const path = join(root, file)
    if (!existsSync(path)) {
      throw new Error(
        `qialike-desktop: the required app-scheme anchor ${file} is missing from the farm at ${root}. `
        + 'The boot graph fetches this plugin bundle, so either the harness renamed the package or '
        + 'the farm is incomplete. Update REQUIRED_FARM_ANCHORS in '
        + 'apps/desktop-bin/harness-patches/app-scheme.mjs.',
      )
    }
    rewriteOrigin(path, { required: true, log })
    written.push(file)
  }
  for (const file of OPTIONAL_FARM_ANCHORS) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    rewriteOrigin(path, { required: false, log })
    written.push(file)
  }
  return written
}

/** The built-Asset naming the Web dist uses for its JavaScript chunks. */
const ASSET_SCRIPT = /\.js$/u

/** Whether a directory entry is one of the dist's JavaScript chunks. */
function isAssetScript(name) {
  return ASSET_SCRIPT.test(name) && !name.endsWith('.map')
}

/**
 * Copy a built Web dist aside and adopt this application's scheme in its chunks.
 *
 * The dist is read from the harness checkout, which this build treats as
 * read-only (DESIGN §3 D12), so the copy is what gets patched and what the
 * runtime tree is assembled from. M2 replaces the dist wholesale with this
 * repository's own; this stage is then the natural seam for that swap rather
 * than an extra moving part.
 *
 * Every JavaScript chunk is scanned rather than one name being hardcoded: the
 * file is content-hash-named, and which chunk inlines the markdown renderer is
 * a bundler decision that has already moved between harness releases.
 *
 * @param sourceDist - the dist to copy (the harness's own by default).
 * @param targetDir - the directory to lay the patched copy out in.
 * @param log - progress sink.
 * @returns the directory holding the patched copy.
 * @throws Error when the dist is not a built frontend, or when no chunk carries
 *   either spelling of the origin.
 */
export function stageWebFrontendSchemed({ sourceDist, targetDir, log = () => {} }) {
  if (!existsSync(join(sourceDist, 'index.html'))) {
    throw new Error(
      `qialike-desktop: no built Web frontend at ${sourceDist} (no index.html), so the scheme `
      + 'rewrite has nothing to act on. Build it first: cd <harness> && pnpm run build:web',
    )
  }
  // A stale copy would keep serving the previous scheme after a scheme change.
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  cpSync(sourceDist, targetDir, { recursive: true, preserveTimestamps: true })

  const assets = join(targetDir, 'assets')
  const chunks = existsSync(assets) ? readdirSync(assets).filter(isAssetScript) : []
  let found = 0
  for (const name of chunks) {
    const path = join(assets, name)
    if (rewriteOrigin(path, { required: false, log }) !== 'absent') found += 1
  }
  if (found === 0) {
    throw new Error(
      `qialike-desktop: none of the ${String(chunks.length)} JavaScript chunk(s) in ${sourceDist}/assets `
      + `contains "${UPSTREAM_ORIGIN}" or "${APP_ORIGIN}". The built frontend no longer spells its `
      + 'application origin the way this patch expects, so the markdown renderer would refuse every '
      + 'local image.\n'
      + '  · Check whether the origin moved into another chunk directory or was renamed, and update '
      + 'stageWebFrontendSchemed in apps/desktop-bin/harness-patches/app-scheme.mjs.',
    )
  }
  log(`app-scheme: staged Web dist at ${targetDir} (${String(found)} chunk(s) rewritten)`)
  return targetDir
}
