/**
 * The About panel: what it says, where it says it, and the copy that must not drift.
 *
 * The panel is not reachable in this environment — it opens from a menu item, and nothing here can click
 * one — so these tests check the things that would otherwise be wrong invisibly: a description that
 * reintroduces the harness as the product, a copyright line that disagrees with the one baked into the
 * package metadata, and an About item that exists twice on macOS.
 *
 * The duplication this file guards is real and deliberate: `electron-builder.config.mjs` cannot import
 * `paths.ts` (see the comment on that field), so the copyright string has two homes and a test rather
 * than a shared constant. That is the same arrangement the brand geometry uses, for the same reason.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, SHELL_PATHS_FILE } from '../apps/desktop-bin/lib/paths.mjs'

const MAIN = join(ROOT, 'apps', 'desktop', 'src', 'main.ts')
const BUILDER_CONFIG = join(ROOT, 'apps', 'desktop', 'electron-builder.config.mjs')

const pathsSource = readFileSync(SHELL_PATHS_FILE, 'utf8')
const mainSource = readFileSync(MAIN, 'utf8')
const configSource = readFileSync(BUILDER_CONFIG, 'utf8')

/** The body of a top-level `function name(...)` declaration, up to its closing brace. */
function functionBody(name) {
  const start = mainSource.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`main.ts no longer declares ${name}; update tests/about-panel.test.mjs`)
  const open = mainSource.indexOf('{', start)
  let depth = 0
  for (let i = open; i < mainSource.length; i += 1) {
    if (mainSource[i] === '{') depth += 1
    else if (mainSource[i] === '}') {
      depth -= 1
      if (depth === 0) return mainSource.slice(open, i + 1)
    }
  }
  throw new Error(`could not find the end of ${name} in main.ts`)
}

/** Read one of the shell's exported string constants, failing loudly if it moved. */
function constant(name) {
  const match = new RegExp(`export const ${name} = '([^']+)'`, 'u').exec(pathsSource)
  if (match === null) {
    throw new Error(`apps/desktop/src/paths.ts no longer exports ${name}; update tests/about-panel.test.mjs`)
  }
  return match[1]
}

describe('the About panel', () => {
  it('describes the product, not the platform it is built on', () => {
    // The text it replaced was "Desktop surface for deepseek-harness", which introduced this application
    // as a surface of someone else's product — the same framing the startup card was changed to stop
    // using. The order matters: qialike is the product, the harness is what it is built on.
    const description = constant('PRODUCT_DESCRIPTION')
    expect(description).toContain('for qialike')
    expect(description).toContain('built on deepseek-harness')
    expect(description).not.toMatch(/^Desktop surface/u)
    expect(description.indexOf('qialike')).toBeLessThan(description.indexOf('deepseek-harness'))
  })

  it('does not recite the profile name, which never varies', () => {
    // It printed `paths.profile`, which is `PROFILE_NAME` — a constant this application owns one of. A
    // diagnostic that cannot differ is not a diagnostic; it is a constant shown to every user forever.
    //
    // Scoped to the dialog on purpose. `paths.profile` is used legitimately elsewhere in this file — the
    // bundle-drift check, the diagnostic payload, the disabled-plugins backup — and a file-wide ban would
    // forbid all of those to make one point.
    const dialog = functionBody('showAboutDialog')
    expect(dialog).not.toContain('Profile:')
    expect(dialog).not.toContain('paths.profile')
    // The panel's description line is the only place the product is introduced, so it must not name the
    // profile either.
    expect(constant('PRODUCT_DESCRIPTION')).not.toContain('Profile:')
  })

  it('agrees with the copyright baked into the package metadata', () => {
    // Two homes, so this is the guard. Drift here is the worst kind: one of the two is legal text.
    const declared = constant('COPYRIGHT')
    const match = /copyright: '([^']+)'/u.exec(configSource)
    expect(match, 'electron-builder.config.mjs no longer declares a copyright').not.toBeNull()
    expect(match[1]).toBe(declared)
  })

  it('agrees with the product name in the package metadata', () => {
    // Same class of drift, same guard, and cheap: the config names the product too.
    const match = /productName: '([^']+)'/u.exec(configSource)
    expect(match?.[1]).toBe(constant('PRODUCT_NAME'))
  })

  it('shows the same content on macOS, where the panel is the system one', () => {
    // Without `setAboutPanelOptions`, macOS shows a name and a version while every other platform shows
    // the description and the licence — the two platforms disagreeing about what the product is.
    expect(mainSource).toContain('app.setAboutPanelOptions(')
    for (const field of ['applicationName: PRODUCT_NAME', 'applicationVersion: VERSION', 'credits: PRODUCT_DESCRIPTION', 'copyright: COPYRIGHT']) {
      expect(mainSource, `setAboutPanelOptions is missing ${field}`).toContain(field)
    }
  })

  it('installs the menu the menu module builds', () => {
    // WHAT THIS REPLACED, because the replacement is the lesson. This assertion used to read `main.ts` as
    // text and check that the string `...(isMac ? [] : [{` appeared near "Help" — the TEXT of the change
    // rather than the SHAPE of the menu. When that change turned out to have dropped the `submenu` key,
    // the Help menu became unclickable and this test stayed green. The menu now lives in `./menu.ts` as
    // data, `tests/application-menu.test.mjs` asserts what it contains, and all this has to check is that
    // `main.ts` hands the right inputs to it.
    expect(mainSource).toContain('buildMenuTemplate({')
    expect(mainSource).toContain("isMac: process.platform === 'darwin'")
    expect(mainSource).toContain('productName: PRODUCT_NAME')
    expect(mainSource).toContain('onShowAbout: showAboutDialog')
    expect(mainSource).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate(')
  })

  it('shows the version and both lines in this application’s own dialog', () => {
    expect(mainSource).toContain('detail: `${PRODUCT_DESCRIPTION}\\n${COPYRIGHT}`')
    expect(mainSource).toContain('message: `${PRODUCT_NAME} ${VERSION}`')
  })
})
