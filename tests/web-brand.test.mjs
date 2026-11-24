/**
 * qialike's branding: the document, the assets, and the sidebar.
 *
 * M2's exit criterion is "the application is qialike's appearance", and none of it
 * is visible in this environment — Chromium does not start here, so a wrong
 * favicon or a bundle that never loaded looks exactly like a correct one. The
 * tests below assert the three places branding can silently go missing:
 *
 *   · the **served document** (title, and whether the brand bundle reached the
 *     boot graph at all) — read from the real Host, not from a fixture;
 *   · the **dist** the shell serves (favicons and manifest, which the browser
 *     fetches by URL outside the plugin system);
 *   · the **shadow** itself, whose failure modes are a moved upstream asset name
 *     and a missing product name.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT, SHELL_PATHS_FILE, WEB_PUBLIC_DIR, WEB_TEMPLATE_FILE } from '../apps/desktop-bin/lib/paths.mjs'
import { memberDir } from '../apps/desktop-bin/lib/runtime-tree.mjs'
import { SHADOWED_FILES, UI_STYLESHEET, applyWebShadow, readProductName } from '../apps/desktop-bin/lib/web-shadow.mjs'
import { patchBrandTitle } from '../apps/desktop-bin/harness-patches/brand-title.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
// `memberDir` rather than a spelled-out layout: the runtime tree is de-linked after
// assembly, so members live at `node_modules/<name>` rather than under `packages/`.
const DIST = join(memberDir(RUNTIME_DIR, '@deepseek-ai/dsh-web-frontend'), 'dist')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'provider-registry-probe.mjs')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

/** The product name the shell uses, read the same way the build reads it. */
const PRODUCT_NAME = readProductName(SHELL_PATHS_FILE)

/** Boot once and reuse the report for every document assertion. */
const probe = (() => {
  let pending
  return () => pending ??= new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, RUNTIME_DIR], {
      cwd: RUNTIME_DIR, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code) => {
      const marker = out.indexOf('__REPORT__')
      if (marker < 0) {
        reject(new Error(`the boot probe produced no report (exit ${String(code)}):\n${out}\n${err}`))
        return
      }
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

describe.skipIf(!assembled)('the served document', () => {
  it('is titled with the product name the shell uses', async () => {
    // Derived from `apps/desktop/src/paths.ts` by the build, so this also pins the
    // window title and the About box to the same string.
    const { report } = await probe()
    expect(report.documentTitle).toBe(PRODUCT_NAME)
    // The upstream document title, which the shadow replaces.
    expect(report.documentTitle).not.toBe('DSH Local Build')
  }, 300_000)

  it('carries the brand bundle in its boot graph', async () => {
    // The failure this is for: a `dsh.client` package that is never mounted, or
    // mounted from a package with no dependency edge to a bundle, is discovered by
    // nothing. The document then looks correct and the sidebar keeps its fallback.
    const { report } = await probe()
    expect(report.clientIds).toContain('@qialike/qialike-desktop-brand')
    expect(report.clientIds).toContain('@qialike/qialike-desktop-providers')
  }, 300_000)

  it('activates every entry, so no row silently failed to import', async () => {
    // An entry whose module exports no `apply` gets no fiber and never activates;
    // that is how the brand row was first broken, and nothing logged it.
    const { stderr } = await probe()
    expect(stderr).not.toMatch(/did not activate/u)
    expect(stderr).not.toMatch(/failed to import/u)
  }, 300_000)
})

describe.skipIf(!assembled)('the shadowed dist', () => {
  it('ships qialike favicons, not the upstream ones', () => {
    const light = readFileSync(join(DIST, 'favicon.svg'), 'utf8')
    const dark = readFileSync(join(DIST, 'favicon-dark.svg'), 'utf8')
    // The artwork, in both — asserted by content rather than by a path string, because the mark stopped
    // being a path this repository draws: it is vendored SVG now, rasterised for the launcher and copied
    // for these two. The viewBox is the cheapest thing that only this artwork has, and the plate colour
    // is the one that would go first if someone shadowed a stale file. What the two files must be is
    // `tests/brand-assets.test.mjs`'s assertion; this one is that the DIST got them at all.
    for (const [name, text] of [['favicon.svg', light], ['favicon-dark.svg', dark]]) {
      expect(text, `${name} is not the artwork`).toContain('viewBox="0 0 1024 1024"')
      expect(text, `${name} carries no plate`).toContain('#0E1428')
    }
  })

  it('names the manifest after the product', () => {
    const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8'))
    expect(manifest.name).toBe(PRODUCT_NAME)
    expect(manifest.short_name).toBe(PRODUCT_NAME)
  })

  it('leaves no upstream branding in the document or the manifest', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8')
    const manifest = readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8')
    for (const text of [html, manifest]) {
      expect(text).not.toContain('DeepSeek')
      expect(text).not.toContain('DSH')
      // The boot wordmark's text, which the stylesheet replaces on screen. Spelled
      // HERE and nowhere else that ships: the document inlines the whole
      // stylesheet, so a comment naming it there would put it back into the very
      // document this test keeps it out of.
      expect(text).not.toContain('HARNESS')
    }
  })

  it('keeps the document asset references exactly as upstream emitted them', () => {
    // The reason the shadow edits `<title>` instead of authoring a replacement
    // document: those hashes change on every upstream rebuild, so a hardcoded
    // copy would break on the next one.
    const html = readFileSync(join(DIST, 'index.html'), 'utf8')
    expect(html).toMatch(/src="\.\/assets\/index-[-\w]+\.js"/u)
    expect(html).toMatch(/href="\.\/assets\/vendor-[-\w]+\.js"/u)
  })
})

describe.skipIf(!assembled)('the boot card’s wordmark', () => {
  const ASSETS = join(DIST, 'assets')
  // `UI_STYLESHEET` is the file's NAME — the shadow joins it to whichever dist it
  // renders into — so the repository copy needs the public directory in front.
  const STYLESHEET = join(WEB_PUBLIC_DIR, UI_STYLESHEET)

  /** The upstream stylesheet, concatenated: the classes the shadow has to match. */
  const upstreamCss = () => readdirSync(ASSETS)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(join(ASSETS, name), 'utf8'))
    .join('\n')

  it('matches exactly one upstream class, so an upstream rename fails here', () => {
    // THE ASSERTION THAT MATTERS. The wordmark's text node is the literal
    // `HARNESS`, and the rule that hides it is keyed on the class's LOCAL name
    // because its hash cannot be written down. If upstream renames that class,
    // our selector stops matching, the override silently does nothing, and
    // `HARNESS` comes back on screen — invisible to every other test, since none
    // of them can see the window. This makes the rename fail loudly instead.
    //
    // Exactly one, not at least one: the local name is what makes the selector
    // acceptable at all (see the stylesheet's comment), so a second class
    // carrying it would mean the selector had quietly widened.
    const local = /\[data-dsh-boot\]\s+\[class\*='([^']+)'\]/u.exec(
      readFileSync(STYLESHEET, 'utf8'),
    )?.[1]
    expect(local, 'the stylesheet no longer scopes a rule inside [data-dsh-boot]').toBeDefined()

    const classes = new Set(upstreamCss().match(/\.[-\w]+/gu) ?? [])
    const matches = [...classes].filter((name) => name.includes(local))
    expect(matches).toHaveLength(1)
  })

  it('restores both type properties the zeroed font-size would otherwise take with it', () => {
    // Setting font-size to 0 hides the text node, and it also computes away
    // `letter-spacing: .08em` (an inherited `em` resolves against the very
    // font-size being zeroed) and would render the replacement at font-size 0
    // — an invisible wordmark, which is worse than the wrong one. Both have to be
    // re-declared on the pseudo-element.
    const stylesheet = readFileSync(STYLESHEET, 'utf8')
    const block = /\[class\*='_wordmark_'\]::after\s*\{([^}]*)\}/u.exec(stylesheet)?.[1]
    expect(block, 'no ::after rule draws the replacement wordmark').toBeDefined()
    expect(block).toMatch(/font-size:\s*(?!0\b)[\d.]+px/u)
    expect(block).toMatch(/letter-spacing:\s*[\d.]+em/u)
    expect(block).toContain("content: 'QIALIKE'")
  })
})

describe('applyWebShadow', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-shadow-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * A dist shaped like the real one, this application's template, and the brand assets.
   *
   * TWO DOCUMENTS, AND THEY PLAY DIFFERENT PARTS. `html` is the *built dist's* document —
   * upstream's, whose only lasting contribution is its content-hashed asset references.
   * `template` is ours, rendered over it. `overrides` replaces either independently, which
   * is what lets the tests below break one half without breaking the other.
   */
  function fixture({ html, template } = {}) {
    const distDir = join(root, 'dist')
    const sourceDir = join(root, 'public')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'index.html'), html ?? [
      '<!doctype html><html><head>',
      '<link rel="manifest" href="./manifest.webmanifest" />',
      '<link rel="icon" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />',
      '<link rel="icon" href="./favicon.svg" media="(prefers-color-scheme: light)" />',
      '<title>DSH Local Build</title>',
      '<script type="module" crossorigin src="./assets/index-abc123.js"></script>',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n'))
    // The real template, by default: a fixture that restated it would pass while the
    // shipped document drifted.
    const templateFile = join(root, 'template.html')
    writeFileSync(templateFile, template ?? readFileSync(WEB_TEMPLATE_FILE, 'utf8'))
    for (const file of [...SHADOWED_FILES, 'brand/qialike-wordmark-light.svg']) {
      mkdirSync(join(sourceDir, file, '..'), { recursive: true })
      writeFileSync(join(sourceDir, file), `<svg data-brand="${file}"></svg>\n`)
    }
    // The application stylesheet is a required input to the shadow, so a fixture
    // without it exercises the failure path rather than the success one.
    writeFileSync(join(sourceDir, UI_STYLESHEET), 'body{color:red}\n')
    return { distDir, sourceDir, templateFile, shellPathsFile: SHELL_PATHS_FILE }
  }

  it('titles the document and copies every shadowed asset', () => {
    const options = fixture()
    const result = applyWebShadow(options)
    expect(result.title).toBe(PRODUCT_NAME)
    const html = readFileSync(join(options.distDir, 'index.html'), 'utf8')
    expect(html).toContain(`<title>${PRODUCT_NAME}</title>`)
    // Neither upstream's title text nor either marker survives the render.
    expect(html).not.toContain('DSH Local Build')
    expect(html).not.toContain('<!--dsh:')
    // The asset reference is lifted from the DIST's document — which is the whole reason
    // this can be our document at all, since those names are content-hashed.
    expect(html).toContain('src="./assets/index-abc123.js"')
    for (const file of SHADOWED_FILES) {
      expect(readFileSync(join(options.distDir, file), 'utf8')).toContain(`data-brand="${file}"`)
    }
  })

  it('does not ship assets the document never asks for', () => {
    // `/brand/…` is outside the shell's static whitelist, so shipping it would put
    // a 404 in the dist rather than an asset.
    const options = fixture()
    applyWebShadow(options)
    expect(existsSync(join(options.distDir, 'brand'))).toBe(false)
  })

  it('refuses a template that stopped naming a shadowed asset', () => {
    // Copying a favicon the document never requests would look like branding and change
    // nothing — and the visible result, the upstream mark, reads as a caching problem
    // rather than a build one. Asserted against OUR template, because that is the document
    // the browser fetches them from.
    const bare = '<html><head><!--dsh:assets--><title><!--dsh:title--></title></head>'
      + '<body><div id="root"></div></body></html>'
    const options = fixture({ template: bare })
    expect(() => applyWebShadow(options)).toThrow(/does not reference/)
    let message = ''
    try {
      applyWebShadow(options)
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('web-shadow.mjs')
  })

  it('refuses a template with no title marker', () => {
    // Without the marker the product name would never reach the document, and the window
    // would keep whatever the template happened to say — a silent branding failure.
    const options = fixture({
      template: readFileSync(WEB_TEMPLATE_FILE, 'utf8').replace('<!--dsh:title-->', 'Qialike'),
    })
    expect(() => applyWebShadow(options)).toThrow(/markers, expected exactly one/)
  })

  it('refuses a dist whose document names no module script', () => {
    // The one thing this application cannot supply for itself: the names are hashed on
    // every upstream rebuild, so they are read out of the dist each time. A dist with no
    // module script under ./assets/ would render a document that paints nothing.
    const options = fixture({
      html: '<html><head><link rel="stylesheet" href="./assets/x.css"></head><body></body></html>',
    })
    expect(() => applyWebShadow(options)).toThrow(/names no module script/)
    let message = ''
    try {
      applyWebShadow(options)
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('extractAssetReferences')
  })

  it('refuses when a brand asset is missing from the repository', () => {
    const options = fixture()
    rmSync(join(options.sourceDir, 'favicon.svg'))
    expect(() => applyWebShadow(options)).toThrow(/missing from/)
  })
})

describe('readProductName', () => {
  it('reads the constant the shell actually exports', () => {
    // The real file, so this fails if the shell renames the constant — which would
    // otherwise silently leave the document titled after the upstream product.
    expect(typeof readProductName(SHELL_PATHS_FILE)).toBe('string')
    expect(readProductName(SHELL_PATHS_FILE).length).toBeGreaterThan(0)
  })

  it('fails loudly when the constant is gone', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'qialike-paths-')), 'paths.ts')
    writeFileSync(file, 'export const SOMETHING_ELSE = 1\n')
    expect(() => readProductName(file)).toThrow(/no PRODUCT_NAME/)
    rmSync(file, { force: true })
  })
})

describe('the brand client bundle', () => {
  const bundle = readFileSync(join(ROOT, 'packages', 'qialike-desktop-brand', 'lib', 'client.js'), 'utf8')

  it('registers under the package name, which is the boot graph row id', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packages', 'qialike-desktop-brand', 'package.json'), 'utf8'),
    )
    const id = /id:\s*'([^']+)'/u.exec(bundle)
    expect(id?.[1]).toBe(manifest.name)
  })

  it('occupies the three brand seats', () => {
    for (const slot of ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark']) {
      expect(bundle, slot).toContain(slot)
    }
  })

  it('registers the first-run overlay on an always-mounted seat', () => {
    // `shell.overlay` is declared by `ui-layout`'s root entry, so it lives for the
    // whole window — which is what a first-run screen needs, since the window
    // between startup and a usable provider is exactly when a settings page the
    // user has to find would not help.
    const providers = readFileSync(
      join(ROOT, 'packages', 'qialike-desktop-providers', 'lib', 'client.js'), 'utf8',
    )
    expect(providers).toContain("ctx.slots.inject('shell.overlay'")
    expect(providers).toContain("id: 'qialike.welcome'")
  })

  it('draws the mark and the wordmark in a fixed brand blue, not in a theme token', () => {
    // THIS TEST ASSERTED THE OPPOSITE UNTIL THE BRAND COLOUR LANDED, and that is worth keeping in view
    // rather than quietly rewriting. Its premise was: binding the two groups to `--dsw-alias-label-*`
    // makes one SVG serve both colour schemes and any theme a user installs later, whereas a literal
    // would be illegible in the other scheme. That reasoning was sound and its conclusion was still
    // wrong for this: a brand colour is not supposed to follow the theme, and the literal was chosen by
    // measuring both backgrounds (4.33:1 on white, 4.49:1 on this application's dark one) precisely so
    // the old objection — illegible in the other scheme — does not apply.
    //
    // What replaces the old assertion is its inverse, plus the reason it is now safe. The exact values
    // are checked against the geometry module in `tests/brand-assets.test.mjs`; this one owns the intent:
    // no token, and neither of the inks the mark used before.
    const declared = [...bundle.matchAll(/const (?:INK|TONE) = '([^']+)'/gu)].map((m) => m[1])
    expect(declared, 'the bundle no longer declares both brand colours').toHaveLength(2)
    for (const value of declared) {
      expect(value, 'a brand colour went back to being a theme token').not.toContain('var(')
    }
    expect(bundle).not.toContain('#201e1e')
    expect(bundle).not.toContain('#f1ecec')
  })

  it('inlines the wordmark geometry verbatim from the repository asset', () => {
    // The bundle cannot fetch `/brand/…`: the shell's static whitelist covers only
    // `/`, the favicons, the manifest and `/assets/`, so it would 404 through the
    // proxy. The geometry is copied in, and this is the check that it still
    // matches the file it was copied from.
    const wordmark = readFileSync(join(WEB_PUBLIC_DIR, 'brand', 'qialike-wordmark-light.svg'), 'utf8')
    for (const path of ['m 0,6 v 30 h 18 v 6 h 6 V 36 6 Z m 6,6 H 18 V 30 H 6 Z', 'm 72,6 v 24 6 h 6 18 V 30 H 78 V 6 Z']) {
      expect(wordmark, `source asset lost ${path.slice(0, 24)}`).toContain(path)
      expect(bundle, `bundle lost ${path.slice(0, 24)}`).toContain(path)
    }
    expect(bundle).toContain('0 0 168 42')
  })
})


describe('patchBrandTitle', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-title-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const TARGET = '-deepseek-ai-dsh-client-locale/lib/client.js'

  /** The dictionary as the harness ships it: the same key in two locales. */
  function fixture(text) {
    const file = join(root, TARGET)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text ?? [
      'const en = {',
      '\t\t"brand.localBuild": "DSH Local Build",',
      '\t\t"brand.other": "untouched",',
      '}',
      'const zh = {',
      '\t\t"brand.localBuild": "DSH 本地构建",',
      '}',
      '',
    ].join('\n'))
    return file
  }

  it('names the product in every locale', () => {
    const file = fixture()
    patchBrandTitle({ root, productName: 'Qialike' })
    const text = readFileSync(file, 'utf8')
    expect(text.match(/"Qialike"/gu)).toHaveLength(2)
    expect(text).not.toContain('DSH Local Build')
    expect(text).not.toContain('DSH 本地构建')
    // Only that key: a patch that rewrote the dictionary wholesale would be a much
    // larger change than this one is.
    expect(text).toContain('"brand.other": "untouched"')
  })

  it('anchors on the key, not on the current copy', () => {
    // Upstream rewording a translation must not fail the build — that would be a
    // recurring maintenance cost for no safety. A missing *key* is the real fault.
    const file = fixture('const en = { "brand.localBuild": "a completely new wording" }\n')
    patchBrandTitle({ root, productName: 'Qialike' })
    expect(readFileSync(file, 'utf8')).toContain('"brand.localBuild": "Qialike"')
  })

  it('is idempotent', () => {
    const file = fixture()
    patchBrandTitle({ root, productName: 'Qialike' })
    const once = readFileSync(file, 'utf8')
    patchBrandTitle({ root, productName: 'Qialike' })
    expect(readFileSync(file, 'utf8')).toBe(once)
  })

  it('refuses a bundle with no such key, naming the patch to update', () => {
    fixture('const en = { "brand.somethingElse": "x" }\n')
    expect(() => patchBrandTitle({ root, productName: 'Qialike' })).toThrow(/declares no "brand.localBuild"/)
    let message = ''
    try {
      patchBrandTitle({ root, productName: 'Qialike' })
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('brand-title.mjs')
    // The message must say why deleting the patch is not an option.
    expect(message).toContain('Electron labels the window')
  })

  it('refuses a farm without the locale package', () => {
    expect(() => patchBrandTitle({ root, productName: 'Qialike' })).toThrow(/is missing from the farm/)
  })
})

describe.skipIf(!assembled)('the shipped locale bundle', () => {
  it('carries no build name for the client to fall back to', () => {
    // The document title that web-shadow.mjs sets survives only until the client
    // mounts; `brand.localBuild` is what replaces it, and Electron follows the
    // document title into the window's title bar.
    const bundle = readFileSync(join(
      memberDir(RUNTIME_DIR, '@deepseek-ai/dsh-client-locale'), 'lib', 'client.js',
    ), 'utf8')
    expect(bundle).not.toContain('DSH Local Build')
    expect(bundle).not.toContain('DSH 本地构建')
      // SPACING AFTER THE COLON IS NOT ASSERTED. 0.2.2-rc.3 ships minified client bundles, so the
      // entry reads `"brand.localBuild":"Qialike"` with no space; the pretty form this used to
      // require was a statement about the bundler, not about the product name. The value and the
      // key are what matter.
      expect(bundle).toMatch(new RegExp(`"brand\\.localBuild":\\s*"${PRODUCT_NAME}"`, 'u'))
  })
})
