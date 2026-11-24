/**
 * Shadow this application's brand over the harness Web dist, and render our document.
 *
 * WHY A SHADOW AND A RENDERED DOCUMENT, RATHER THAN EITHER ALONE. The browser surface's
 * frontend is a Vite bundle built by the harness's own `apps/web` build, which needs that
 * monorepo's workspace, platform module tables and unpublished packages. It is consumed as
 * an artifact (DESIGN §5.1). So branding is overlaid on the built dist — but only where a
 * file's *name* is stable:
 *
 *   · `favicon.svg`, `favicon-dark.svg`, `manifest.webmanifest` — our document references
 *     all three under exactly these relative names, so dropping ours in the dist replaces
 *     them with no markup change at all. That is not a coincidence to rely on silently:
 *     {@link SHADOWED_FILES} lists them and the build refuses to run if the template stops
 *     referencing one.
 *
 * THE DOCUMENT IS OURS; THE ASSET NAMES ARE UPSTREAM'S. `apps/desktop-web/index.html` is
 * this application's own document, rendered into the dist with two substitutions — see its
 * header. The reason it *can* be ours is also the reason a naive replacement would be
 * wrong: `index.html` names content-hashed assets (`./assets/index-Q6zc2uHV.js`), so a
 * document that hardcoded them would break on every upstream rebuild, in a way nothing
 * local observes — the window would simply fail to paint. {@link extractAssetReferences}
 * reads them out of the built document each time, and the render fails loudly if the block
 * it finds is empty or carries no module script.
 *
 * Editing upstream's document in place was the earlier approach. It worked; what it could
 * not do was state our half declaratively — it string-replaced `<title>` inside markup we
 * do not own, so the edit was coupled to a string upstream's build happened to emit.
 *
 * The product name is read from the shell's own `paths.ts` rather than restated, so the
 * window title, the About box and the document title cannot disagree.
 *
 * @module qialike-desktop/web-shadow
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Files copied from `apps/desktop-web/public` over the dist, by stable name. */
export const SHADOWED_FILES = ['favicon.svg', 'favicon-dark.svg', 'manifest.webmanifest']

/** This application's document template, relative to `apps/desktop-web`. */
export const DOCUMENT_TEMPLATE = 'index.html'

/** Where the harness's own asset references are substituted into the template. */
export const ASSET_MARKER = '<!--dsh:assets-->'

/** Where the product name is substituted into the template. */
export const TITLE_MARKER = '<!--dsh:title-->'

/**
 * Lift the harness's own asset references out of its built document.
 *
 * MATCHED AS WHOLE ELEMENTS, NOT AS OPENING TAGS, and the difference is a broken document
 * rather than a cosmetic one. The first version of this matched `/<(?:script|link)\b[^>]*>/`
 * — up to the first `>` — which is correct for a void `<link>` and silently truncates
 * `<script …></script>` to `<script …>`, leaving the tag unclosed so the parser treats the
 * rest of the document as script text. The app would not have started, and the reason would
 * have been invisible in the source because the template itself is fine.
 *
 * Matched on `./assets/` rather than on a filename pattern: the entry script, the vendor
 * modulepreload and both stylesheets all live there, and the names inside are hashed on
 * every rebuild. Anything not pointing into that directory is left behind, so an upstream
 * addition of, say, a remote analytics `<script src="https://…">` is not silently adopted
 * into this document.
 *
 * @param html - the built Web dist's `index.html`.
 * @returns the reference elements, in document order.
 */
export function extractAssetReferences(html) {
  const tags = []
  for (const match of html.matchAll(/<script\b[^>]*>(?:[\s\S]*?<\/script>)?|<link\b[^>]*\/?>/gu)) {
    if (!/\b(?:src|href)="\.\/assets\//u.test(match[0])) continue
    tags.push(match[0])
  }
  return tags
}

/**
 * Render this application's document for a built dist.
 *
 * @param options.template - `apps/desktop-web/index.html`, read verbatim.
 * @param options.upstreamHtml - the built dist's `index.html`, for its asset references.
 * @param options.productName - the name the window and the document should carry.
 * @param options.css - the stylesheet to inline.
 * @returns the document to write.
 * @throws Error when either marker is missing, when the template references an asset the
 *   dist will not carry, or when upstream's document yields no usable asset block — each of
 *   which would otherwise produce a document that looks fine and paints nothing.
 */
export function renderDocument({ template, upstreamHtml, productName, css }) {
  for (const marker of [ASSET_MARKER, TITLE_MARKER]) {
    const count = template.split(marker).length - 1
    if (count !== 1) {
      throw new Error(
        `qialike-desktop: ${DOCUMENT_TEMPLATE} carries ${String(count)} "${marker}" markers, expected exactly `
        + 'one. Update apps/desktop-web/index.html and the constants in web-shadow.mjs together.',
      )
    }
  }
  // Asserted against OUR document, not upstream's: our template is what the browser will
  // fetch them from, so this is what keeps the two halves of the shadow in step. Copying a
  // favicon the document never requests looks like branding and changes nothing, and the
  // visible result — the upstream mark — is easy to mistake for a caching problem.
  for (const file of SHADOWED_FILES) {
    if (!template.includes(file)) {
      throw new Error(
        `qialike-desktop: ${DOCUMENT_TEMPLATE} does not reference ${file}, so shadowing it would have no `
        + 'effect. Update the template or SHADOWED_FILES in apps/desktop-bin/lib/web-shadow.mjs.',
      )
    }
  }
  if (!/<div id="root">/u.test(template)) {
    throw new Error(
      `qialike-desktop: ${DOCUMENT_TEMPLATE} has no <div id="root">, which the client mounts into.`,
    )
  }

  const assets = extractAssetReferences(upstreamHtml)
  if (!assets.some((tag) => /<script\b[^>]*type="module"/u.test(tag))) {
    throw new Error(
      'qialike-desktop: the built Web dist index.html names no module script under ./assets/, so this '
      + 'document would have nothing to start the client with. The upstream document changed shape; '
      + 'update extractAssetReferences in apps/desktop-bin/lib/web-shadow.mjs to match it.',
    )
  }

  const titled = template.replace(TITLE_MARKER, productName)
  const withAssets = titled.replace(ASSET_MARKER, assets.join('\n    '))
  return injectUiStylesheet(withAssets, css)
}

/**
 * Assets that stay in the repository rather than in the dist.
 *
 * The wordmarks are the source the marks are derived from and what M7's packaging
 * icons will be rendered from, but nothing in the *running* application fetches
 * them: the brand plugin inlines the wordmark it needs. Shipping them would put
 * three files in the dist that the shell's static whitelist does not serve —
 * `/brand/…` is not `/assets/…` — so each would be a 404 through the Host proxy,
 * which is a worse answer than not shipping them.
 */
export const SOURCE_ONLY_ASSETS = ['brand/qialike-wordmark-light.svg', 'brand/qialike-wordmark-dark.svg']

/**
 * The stylesheet this application inlines into the served document.
 *
 * A real file rather than a string built here, so the styling is reviewable as
 * styling; the build's only job is to read it, refuse it if it is empty, and place
 * it. See the file's own header for the cascade reasoning behind where it lands.
 *
 * It is NOT copied into the dist: it is inlined, so a copy would be a second
 * version of the same rules that the browser never fetches, and the next person to
 * edit the dist copy would see no effect.
 */
export const UI_STYLESHEET = 'qialike-ui.css'

/** The `id` the injected element carries. */
export const UI_STYLE_ID = 'qialike-ui'

/**
 * Directories copied into the dist's `/assets/` tree.
 *
 * `/assets/` is the one part of the URL space the shell serves without knowing
 * individual file names (`isStaticDocument`), so it is the only place a new asset
 * can live and still be reachable through the Host proxy. A font at `/fonts/…`
 * would be a 404, exactly as `/brand/…` was before the wordmarks were inlined.
 */
export const SHADOWED_ASSET_DIRS = ['assets']

/**
 * Read `PRODUCT_NAME` out of the shell's path module.
 *
 * A source-text read rather than an import: `paths.ts` is TypeScript and this is
 * a plain node build script (the same reason the shell tests read
 * `PROTOCOL_VERSION` textually). Failing loudly matters more than the mechanism —
 * a silently different product name would be a window titled one thing and a
 * document titled another.
 *
 * @param shellPathsFile - absolute path of `apps/desktop/src/paths.ts`.
 * @returns the product name.
 * @throws Error when the constant is not found.
 */
export function readProductName(shellPathsFile) {
  const source = readFileSync(shellPathsFile, 'utf8')
  const match = /export const PRODUCT_NAME = '([^']+)'/u.exec(source)
  if (match === null) {
    throw new Error(
      `qialike-desktop: no PRODUCT_NAME in ${shellPathsFile}. The shell renamed or removed it, so the `
      + 'document title can no longer be derived from it. Update readProductName in '
      + 'apps/desktop-bin/lib/web-shadow.mjs.',
    )
  }
  return match[1]
}

/**
 * Copy this repository's `/assets/` additions into the dist.
 *
 * REFUSES TO OVERWRITE. The upstream dist's `assets/` holds content-hashed Vite
 * output, and a file of ours landing on one of those names would replace a bundle
 * the document references by hash — the application would then fail at runtime with
 * a module that does not parse, and nothing in the build would have said so. A
 * collision means the naming is wrong, not that the copy should win.
 *
 * @param options.distDir - the dist to write into.
 * @param options.sourceDir - `apps/desktop-web/public`.
 * @param options.log - progress sink.
 * @returns how many files were copied.
 * @throws Error when a file would overwrite one upstream emitted.
 */
function copyShadowedAssets({ distDir, sourceDir, log }) {
  let copied = 0
  for (const dir of SHADOWED_ASSET_DIRS) {
    const from = join(sourceDir, dir)
    if (!existsSync(from)) continue
    const walk = (relative) => {
      for (const entry of readdirSync(join(from, relative), { withFileTypes: true })) {
        const next = relative === '' ? entry.name : join(relative, entry.name)
        if (entry.isDirectory()) { walk(next); continue }
        const destination = join(distDir, dir, next)
        if (existsSync(destination)) {
          throw new Error(
            `qialike-desktop: ${dir}/${next} already exists in the Web dist, so shadowing it would `
            + 'replace a file upstream emitted. Upstream asset names are content-hashed and referenced '
            + 'by the document, so this is a naming collision rather than a replacement: rename the file '
            + 'in apps/desktop-web/public, or add it to SOURCE_ONLY_ASSETS if it should not ship.',
          )
        }
        mkdirSync(dirname(destination), { recursive: true })
        cpSync(join(from, relative, entry.name), destination)
        copied += 1
      }
    }
    walk('')
  }
  if (copied > 0) log(`brand: copied ${String(copied)} asset file(s) into ${SHADOWED_ASSET_DIRS.join(', ')}`)
  return copied
}

/**
 * Place the stylesheet in a document, idempotently.
 *
 * Exported so the placement rule can be tested against a document directly, without
 * standing up a dist — the rule is the part with the failure modes, and it is
 * awkward to reach through `applyWebShadow`.
 *
 * @param html - the document.
 * @param css - the stylesheet source.
 * @returns the document with the element present exactly once.
 * @throws Error when the stylesheet would break out of its own element, or when the
 *   document has no `</head>` to insert before.
 */
export function injectUiStylesheet(html, css) {
  // The one injection hazard: `</style>` inside the content closes the element
  // early and spills the remainder into the document as markup. Nothing in the
  // file should contain it, and a check here is cheap next to debugging the
  // resulting parse.
  if (/<\/style/iu.test(css)) {
    throw new Error(
      `qialike-desktop: ${UI_STYLESHEET} contains "</style", which would terminate the injected element `
      + 'early and leak the rest of the stylesheet into the document as markup.',
    )
  }
  const element = `<style id="${UI_STYLE_ID}">\n${css}\n</style>`
  // Idempotent by id: a rebuild over an already-shadowed dist replaces the element
  // rather than adding a second copy, so the two cannot drift apart.
  const existing = new RegExp(`<style id="${UI_STYLE_ID}">[\\s\\S]*?</style>`, 'u')
  if (existing.test(html)) return html.replace(existing, element)
  // Before `</head>` — after the upstream stylesheets, which is what makes the
  // overrides win. See the stylesheet's header; putting it near `<title>` would
  // place it before them and silently lose every conflict.
  //
  // EXACTLY ONE CLOSING HEAD, ASSERTED, and this is not defensive padding. `replace` takes
  // the FIRST match, and an HTML comment that *mentions* the closing tag — which the
  // document's own explanatory header did — wins that race. The stylesheet was then spliced
  // into the middle of the comment: the prose was cut in half, the comment was closed early
  // by its own text, and the rest of the document spilled out as markup. Nothing failed; the
  // rendered document was simply wrong, and the only way it was found was by reading it.
  const closings = html.split('</head>').length - 1
  if (closings !== 1) {
    throw new Error(
      `qialike-desktop: the document to render has ${String(closings)} "</head>" occurrences, expected exactly `
      + 'one. The stylesheet is spliced in before the first, so an extra one — most likely inside a comment '
      + 'in apps/desktop-web/index.html — would take the splice instead. Write the tag as prose (without the '
      + 'angle brackets) in any comment.',
    )
  }
  return html.replace('</head>', `  ${element}\n  </head>`)
}

/**
 * Apply the brand overlay to a built dist, and render this application's document.
 *
 * @param options.distDir - the dist to shadow (the staged copy, never the checkout).
 * @param options.sourceDir - `apps/desktop-web/public`, holding the assets to copy.
 * @param options.templateFile - `apps/desktop-web/index.html`, the document to render.
 * @param options.shellPathsFile - `apps/desktop/src/paths.ts`, for the product name.
 * @param options.log - progress sink.
 * @returns the title and the files it wrote.
 * @throws Error when the dist has no document to take asset references from, when the
 *   template is missing a marker or an asset reference, or when an asset to copy is absent.
 */
export function applyWebShadow({ distDir, sourceDir, templateFile, shellPathsFile, log = () => {} }) {
  const upstreamPath = join(distDir, 'index.html')
  if (!existsSync(upstreamPath)) {
    throw new Error(
      `qialike-desktop: no index.html in ${distDir}, so there are no asset references to render against. `
      + 'The staged Web dist is incomplete.',
    )
  }
  if (!existsSync(templateFile)) {
    throw new Error(`qialike-desktop: the document template ${templateFile} is missing.`)
  }

  // Every asset is checked before anything is written, so a run either produces a complete
  // document or fails — never a dist that looks shadowed and is not.
  for (const file of SHADOWED_FILES) {
    const from = join(sourceDir, file)
    if (!existsSync(from)) {
      throw new Error(`qialike-desktop: the brand asset ${file} is missing from ${sourceDir}.`)
    }
  }
  const stylesheetPath = join(sourceDir, UI_STYLESHEET)
  if (!existsSync(stylesheetPath)) {
    throw new Error(
      `qialike-desktop: the application stylesheet ${UI_STYLESHEET} is missing from ${sourceDir}. `
      + 'The rendered document is expected to carry it; without it the bundled typefaces never load and '
      + 'the window falls back to whatever fontconfig picks.',
    )
  }
  const css = readFileSync(stylesheetPath, 'utf8').trim()
  if (css.length === 0) {
    throw new Error(`qialike-desktop: ${UI_STYLESHEET} is empty, so injecting it would change nothing.`)
  }

  const productName = readProductName(shellPathsFile)
  const document = renderDocument({
    template: readFileSync(templateFile, 'utf8'),
    upstreamHtml: readFileSync(upstreamPath, 'utf8'),
    productName,
    css,
  })

  // The document is rendered BEFORE anything is written, so a template problem fails the
  // build with the dist untouched rather than half-shadowed.
  for (const file of SHADOWED_FILES) {
    cpSync(join(sourceDir, file), join(distDir, file))
  }
  copyShadowedAssets({ distDir, sourceDir, log })
  writeFileSync(upstreamPath, document)
  log(
    `brand: rendered ${DOCUMENT_TEMPLATE} with the dist's asset references, shadowed `
    + `${String(SHADOWED_FILES.length)} asset(s), inlined ${UI_STYLESHEET}, titled "${productName}"`,
  )
  return { title: productName, files: [...SHADOWED_FILES, UI_STYLESHEET] }
}
