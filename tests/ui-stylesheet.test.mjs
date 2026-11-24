/**
 * The application stylesheet: how it reaches the document, and what is in it.
 *
 * C's mechanism exists because there is otherwise nowhere to put styling that this
 * product owns. The shell serves only the static documents it knows by name plus
 * everything under `/assets/`, so a stylesheet at `/qialike-ui.css` is a 404 through
 * the Host proxy — the trap the `/brand/` wordmarks hit in M2 — and the bootstrap
 * markup already needs a `<style>` element for its pre-paint rules.
 *
 * THE ASSERTION THAT CARRIES THIS FILE is the cascade position. A `<style>` placed
 * near `<title>` puts it *before* the upstream `<link rel="stylesheet">` elements,
 * and CSS resolves equal specificity by document order — so the overrides would lose
 * every conflict and do nothing. There is no error for that and no visible symptom
 * other than "the application looks upstream", which is indistinguishable from the
 * stylesheet never being injected at all. The ordering test below is the only thing
 * standing between this feature and a silent no-op.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROOT, SHELL_PATHS_FILE, WEB_PUBLIC_DIR, WEB_TEMPLATE_FILE } from '../apps/desktop-bin/lib/paths.mjs'
import {
  SHADOWED_ASSET_DIRS, UI_STYLESHEET, UI_STYLE_ID, applyWebShadow, injectUiStylesheet,
} from '../apps/desktop-bin/lib/web-shadow.mjs'
import { SHADOWED_FILES } from '../apps/desktop-bin/lib/web-shadow.mjs'

/** The real stylesheet this repository ships. */
const REAL_CSS = readFileSync(join(WEB_PUBLIC_DIR, UI_STYLESHEET), 'utf8')

describe('injectUiStylesheet', () => {
  /** A document shaped like the real one: upstream stylesheets, then `</head>`. */
  const DOC = [
    '<!doctype html><html lang="en"><head>',
    '<title>Qialike</title>',
    '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
    '<link rel="stylesheet" crossorigin href="./assets/vendor-abc.css">',
    '<link rel="stylesheet" crossorigin href="./assets/index-def.css">',
    '</head><body><div id="root"></div></body></html>',
  ].join('\n')

  it('places the element after the upstream stylesheets, which is what makes it win', () => {
    // The whole mechanism in one assertion. Both upstream stylesheets must precede
    // ours: at equal specificity the later rule wins, and the upstream palette is
    // declared on `:root` — so an earlier position would silently lose every
    // override rather than fail.
    const out = injectUiStylesheet(DOC, 'body{color:red}')
    const vendor = out.indexOf('./assets/vendor-abc.css')
    const own = out.indexOf(`<style id="${UI_STYLE_ID}">`)
    const index = out.indexOf('./assets/index-def.css')
    expect(own).toBeGreaterThan(vendor)
    expect(own).toBeGreaterThan(index)
    // And still inside the head, so it applies before the body is parsed.
    expect(own).toBeLessThan(out.indexOf('</head>'))
  })

  it('leaves the rest of the document untouched', () => {
    const out = injectUiStylesheet(DOC, 'body{color:red}')
    expect(out).toContain('<script type="module" crossorigin src="./assets/index-abc.js"></script>')
    expect(out).toContain('<div id="root"></div>')
    // Exactly one </head>, not a second one introduced by the insertion.
    expect(out.match(/<\/head>/gu)).toHaveLength(1)
  })

  it('is idempotent', () => {
    // A rebuild over an already-shadowed dist must replace the element, not add a
    // second one. Two copies would be two sets of rules that can drift apart, and
    // the older one would win the ties.
    const once = injectUiStylesheet(DOC, 'body{color:red}')
    const twice = injectUiStylesheet(once, 'body{color:red}')
    expect(twice).toBe(once)
    expect(twice.match(new RegExp(`<style id="${UI_STYLE_ID}">`, 'gu'))).toHaveLength(1)
  })

  it('replaces the content when the stylesheet changed', () => {
    const once = injectUiStylesheet(DOC, 'body{color:red}')
    const twice = injectUiStylesheet(once, 'body{color:blue}')
    expect(twice).toContain('color:blue')
    expect(twice).not.toContain('color:red')
    expect(twice.match(new RegExp(`<style id="${UI_STYLE_ID}">`, 'gu'))).toHaveLength(1)
  })

  it('refuses a stylesheet that would close its own element', () => {
    // The injection hazard: `</style>` in the content ends the element early and the
    // remainder of the stylesheet is parsed as body markup. Cheap to check, and the
    // symptom otherwise is a garbled document rather than an error.
    expect(() => injectUiStylesheet(DOC, 'a{content:"</style>"}')).toThrow(/would terminate the injected element/u)
  })

  it('refuses a document whose head closing tag is absent or ambiguous', () => {
    // Anchor mismatch is a build failure everywhere else in this repository, and it is one
    // here too. BOTH DIRECTIONS ARE ASSERTED, because they fail differently and the second is
    // a real bug this guard was written for: `replace` takes the FIRST match, so a document
    // that merely *mentions* the closing tag in a comment takes the splice inside it — the
    // comment is closed early by its own text and the remainder spills out as markup. That
    // happened, with the document template's own explanatory header, and nothing failed.
    expect(() => injectUiStylesheet('<html><body>no head</body></html>', 'body{}'))
      .toThrow(/0 "<\/head>" occurrences/u)
    expect(() => injectUiStylesheet(
      '<html><head><!-- the splice goes before </head> --><title>t</title></head><body></body></html>',
      'body{}',
    )).toThrow(/2 "<\/head>" occurrences/u)
  })
})

describe('applyWebShadow and the stylesheet', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-ui-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A dist and a public directory shaped like the real ones. */
  // `css` is `null` to omit the file. `undefined` would trip the default parameter,
  // which is a trap worth naming: it silently produces the "present" case and makes
  // the missing-file test pass for the wrong reason.
  function fixture({ css = 'body{color:red}', withAssets = true, upstreamAssets = [] } = {}) {
    const distDir = join(root, 'dist')
    const sourceDir = join(root, 'public')
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), [
      '<!doctype html><html><head>',
      '<link rel="manifest" href="./manifest.webmanifest" />',
      '<link rel="icon" href="./favicon-dark.svg" />',
      '<link rel="icon" href="./favicon.svg" />',
      '<title>DSH Local Build</title>',
      // The module script is what the template needs from the dist; a fixture without one
      // exercises the "nothing to start the client with" guard rather than the success path.
      '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
      '<link rel="stylesheet" href="./assets/index-abc.css">',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n'))
    // Files the upstream build emitted, so a collision can be provoked.
    for (const name of upstreamAssets) {
      mkdirSync(dirname(join(distDir, 'assets', name)), { recursive: true })
      writeFileSync(join(distDir, 'assets', name), 'upstream\n')
    }
    for (const file of SHADOWED_FILES) {
      mkdirSync(dirname(join(sourceDir, file)), { recursive: true })
      writeFileSync(join(sourceDir, file), `asset:${file}\n`)
    }
    if (css !== null) writeFileSync(join(sourceDir, UI_STYLESHEET), css)
    if (withAssets) {
      mkdirSync(join(sourceDir, 'assets', 'fonts'), { recursive: true })
      writeFileSync(join(sourceDir, 'assets', 'fonts', 'F.woff2'), 'font\n')
    }
    // The real template, as `web-brand.test.mjs` does: a fixture that restated it would
    // pass while the shipped document drifted.
    const templateFile = join(root, 'template.html')
    writeFileSync(templateFile, readFileSync(WEB_TEMPLATE_FILE, 'utf8'))
    return { distDir, sourceDir, templateFile, shellPathsFile: SHELL_PATHS_FILE, root }
  }

  it('inlines the stylesheet and copies the asset tree', () => {
    const options = fixture()

    applyWebShadow(options)
    const html = readFileSync(join(options.distDir, 'index.html'), 'utf8')
    expect(html).toContain(`<style id="${UI_STYLE_ID}">`)
    expect(html).toContain('body{color:red}')
    // The font lands under `/assets/`, the only prefix the shell serves without
    // knowing names — and is NOT left as a file the browser would 404 on.
    expect(readFileSync(join(options.distDir, 'assets', 'fonts', 'F.woff2'), 'utf8')).toBe('font\n')
  })

  it('does not copy the stylesheet itself into the dist', () => {
    // It is inlined, so a copy would be rules the browser never fetches — and the
    // next person to edit the copy would see no effect.
    const options = fixture()
    applyWebShadow(options)
    expect(existsSync(join(options.distDir, UI_STYLESHEET))).toBe(false)
  })

  it('refuses to overwrite an asset the upstream build emitted', () => {
    // Upstream names are content-hashed and the document references them by hash, so
    // a collision replaces a bundle rather than an image — and the application then
    // fails at runtime with a module that does not parse, with nothing in the build
    // having said so. A collision means the name is wrong, not that the copy wins.
    const options = fixture({ upstreamAssets: ['fonts/F.woff2'] })
    expect(() => applyWebShadow(options)).toThrow(/already exists in the Web dist/u)
  })

  it('fails the build when the stylesheet is missing', () => {
    const options = fixture({ css: null })
    expect(() => applyWebShadow(options)).toThrow(/application stylesheet/u)
  })

  it('fails the build when the stylesheet is empty', () => {
    // An empty file would inject an empty element: the build "succeeds", the
    // document carries the marker, and nothing is styled.
    const options = fixture({ css: '   \n  \n' })
    expect(() => applyWebShadow(options)).toThrow(/is empty/u)
  })
})

describe('the shipped stylesheet', () => {
  it('declares the three faces, each pointing at a file that exists', () => {
    // A `src:` that 404s is invisible until text renders in the wrong face, and the
    // network panel is the only place it shows. Checking the paths here is what
    // makes a rename or a forgotten download a test failure.
    const sources = [...REAL_CSS.matchAll(/src:\s*url\('([^']+)'\)/gu)].map((match) => match[1])
    expect(sources.length).toBeGreaterThanOrEqual(3)
    for (const source of sources) {
      // Relative to the document root, so `./assets/…` resolves to `/assets/…`.
      expect(source.startsWith('./assets/fonts/'), source).toBe(true)
      const file = join(WEB_PUBLIC_DIR, source.replace(/^\.\//u, ''))
      expect(existsSync(file), `${source} is not in the repository`).toBe(true)
      // A truncated download is a valid-looking file that the browser rejects.
      const bytes = readFileSync(file)
      expect(bytes.subarray(0, 4).toString('latin1'), source).toBe('wOF2')
      expect(bytes.readUInt32BE(8), `${source} declares a different length than it has`).toBe(bytes.length)
    }
  })

  it('ships the licences beside the fonts', () => {
    // Both families are OFL 1.1, which requires the licence to travel with the
    // files. Redistributing them without it is a licence violation, not a tidiness
    // problem, so it is asserted rather than trusted.
    for (const name of ['LICENSE-Inter.txt', 'LICENSE-JetBrainsMono.txt']) {
      const file = join(WEB_PUBLIC_DIR, 'assets', 'fonts', name)
      expect(existsSync(file), name).toBe(true)
      expect(readFileSync(file, 'utf8')).toMatch(/SIL OPEN FONT LICENSE/u)
    }
  })

  it('keeps the CJK faces in the sans stack', () => {
    // Inter has no CJK glyphs, so Chinese text falls through to these. Dropping them
    // would send every Chinese glyph to Arial and its fontconfig substitute — a
    // worse Chinese face than the ones named — which is a regression that would look
    // like a font-bundling success.
    const stack = /--dsw-font-family:\s*([^;]+);/u.exec(REAL_CSS)?.[1] ?? ''
    expect(stack).toContain("'Inter'")
    for (const face of ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei']) {
      expect(stack, face).toContain(face)
    }
    // And Arial still comes last, after the CJK faces rather than before them.
    expect(stack.indexOf('Arial')).toBeGreaterThan(stack.indexOf('PingFang SC'))
  })

  it('defines the mono token upstream only ever consumes', () => {
    // Six sites read `var(--dsw-font-mono, …)` and upstream never defines it, so they
    // take the fallback. Defining it is a fix rather than an override, and the
    // bundled face is what makes those sites stop depending on the host.
    expect(REAL_CSS).toMatch(/--dsw-font-mono:\s*'JetBrains Mono'/u)
    expect(REAL_CSS).toMatch(/--ds-font-family-code:\s*\n?\s*'JetBrains Mono'/u)
  })

  it('sizes the fonts in a way that is worth the bytes', () => {
    // Recorded as a bound rather than a target: the variable files are what make one
    // file cover every weight, and the whole set should stay far below the runtime
    // tree it ships inside. A static-weight set would be several times this.
    const dir = join(WEB_PUBLIC_DIR, 'assets', 'fonts')
    const total = ['InterVariable.woff2', 'InterVariable-Italic.woff2', 'JetBrainsMono-var.woff2']
      .reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
    expect(total).toBeLessThan(2 * 1024 * 1024)
    expect(SHADOWED_ASSET_DIRS).toEqual(['assets'])
    expect(ROOT).toBeTruthy()
  })
})
