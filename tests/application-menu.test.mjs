/**
 * The application menu, as data.
 *
 * WHY THIS FILE EXISTS AT ALL, in the author's words: I broke the Help menu and this test did not notice.
 * The About item lost the `submenu` key that held it, so the Help entry had nothing to open and clicking
 * it did nothing at all. What was supposed to cover it asserted that a substring appeared in `main.ts` —
 * the text of the change, not the shape of the menu — so it stayed green while the menu was dead.
 *
 * Every test here therefore asserts on the TEMPLATE, which `main.ts` builds from `./menu.ts`. Nothing in
 * this environment can click a native menu, so the template is the only place this can be checked; the
 * point is to check the structure rather than a description of it.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'
// A `.mjs` test cannot carry TypeScript syntax, so the module's types stay on its side of the fence.
import { GUIDE_BUTTONS, USER_GUIDE_URL, buildMenuTemplate, guideActionFor, guideLabel, guideUrl } from '../apps/desktop/src/menu.ts'

/** Build a template for a platform, with spies standing in for the two things a click can do. */
function template(overrides = {}) {
  const onShowAbout = vi.fn()
  const onOpenGuide = vi.fn()
  const entries = buildMenuTemplate({
    isMac: false, productName: 'Qialike', locale: 'en-US', onShowAbout, onOpenGuide, ...overrides,
  })
  return { entries, onShowAbout, onOpenGuide }
}

/** The Help menu's items, or an empty list when there is no Help menu. */
function helpItems(entries) {
  return entries.find((entry) => entry.label === 'Help')?.submenu ?? []
}

describe('buildMenuTemplate', () => {
  it('makes every top-level entry either a platform role or a menu with something in it', () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ACTUAL BUG, and the reason it is written generally rather
    // than about Help. A top-level entry with neither a `role` nor a `submenu` is a dead menu: the label
    // appears in the menu bar and clicking it does nothing. That is what shipped, on every platform.
    for (const isMac of [true, false]) {
      const { entries } = template({ isMac })
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        const usable = entry.role !== undefined
          || (entry.submenu !== undefined && entry.submenu.length > 0)
        expect(usable, `a top-level entry is dead: ${JSON.stringify(entry)}`).toBe(true)
      }
    }
  })

  it('gives Help the guide and, off macOS, the About item', () => {
    const { entries } = template()
    const help = entries.find((entry) => entry.label === 'Help')
    expect(help, 'no Help entry').toBeDefined()
    expect(Array.isArray(help?.submenu), 'Help has no submenu, so it cannot be opened').toBe(true)
    const items = help?.submenu ?? []
    // The guide first, About last: the order is the one every platform uses, and the guide is what this
    // menu exists for now.
    expect(items.map((item) => item.label ?? item.type)).toEqual(['User guide', 'separator', 'About Qialike'])
  })

  it('keeps the guide on macOS and drops only the About item there', () => {
    // THE CHANGE THIS TEST GUARDS. Help used to be absent on macOS because About was its only content and
    // `role: 'appMenu'` already contributes that. The guide has no macOS equivalent, so the menu is now
    // present there — and omitting it would withhold the one thing it is for.
    const { entries } = template({ isMac: true })
    const items = helpItems(entries)
    expect(items.map((item) => item.label ?? item.type)).toEqual(['User guide'])
    expect(entries.some((entry) => entry.label === 'Help'), 'Help is missing on macOS').toBe(true)
  })

  it('wires each item to its own action, and to nothing else', () => {
    // A click handler that is missing, or attached to the wrong entry, is invisible until someone clicks —
    // and here the two entries sit next to each other, so a mix-up would be silent.
    const { entries, onShowAbout, onOpenGuide } = template()
    const items = helpItems(entries)
    const guide = items[0]
    const about = items[2]
    expect(typeof guide?.click).toBe('function')
    expect(typeof about?.click).toBe('function')
    guide?.click?.()
    expect(onOpenGuide).toHaveBeenCalledTimes(1)
    expect(onShowAbout, 'the guide click reached the About dialog').not.toHaveBeenCalled()
    about?.click?.()
    expect(onShowAbout).toHaveBeenCalledTimes(1)
    expect(onOpenGuide).toHaveBeenCalledTimes(1)
  })

  it('points the guide at the product site, and names the product from the caller', () => {
    // The URL is a product fact and lives in one place; this asserts the value rather than that a string
    // exists, because a guide that opens the wrong site is worse than no guide.
    expect(USER_GUIDE_URL).toBe('https://qialike.com')
    // The window title, the About panel and this label are one fact (see paths.ts).
    const { entries } = template({ productName: 'Something Else' })
    expect(helpItems(entries).at(-1)?.label).toBe('About Something Else')
  })

  describe('the guide dialog', () => {
    it('maps every button it offers, so a press cannot be read as a different one', () => {
      // THE ASSERTION THAT KEEPS THE BUTTONS AND THE RULE TOGETHER. The mapping lives in `menu.ts` and the
      // dialog lives in `main.ts`, which no test can import — so the two are pinned here rather than trusted
      // to stay in step. A reordered `GUIDE_BUTTONS` with an unchanged `guideActionFor` would send "Copy
      // link" to the browser and "Close" to the clipboard, and nothing else would notice.
      expect(GUIDE_BUTTONS[guideActionFor(0) === 'open' ? 0 : -1]).toBe('Open in browser')
      expect(GUIDE_BUTTONS[guideActionFor(1) === 'copy' ? 1 : -1]).toBe('Copy link')
      expect(GUIDE_BUTTONS.at(-1)).toBe('Close')
      expect(GUIDE_BUTTONS).toHaveLength(3)
    })

    it('reads the two named buttons and treats everything else as a dismissal', () => {
      expect(guideActionFor(0)).toBe('open')
      expect(guideActionFor(1)).toBe('copy')
      expect(guideActionFor(2)).toBe('dismiss')
      // INCLUDING AN INDEX THIS BUILD DOES NOT EXPECT. A response outside the list must not fall through to
      // "open": that would launch a browser on a keypress the user did not intend, which is the one outcome
      // worse than doing nothing.
      for (const unexpected of [3, 7, -1, 0.5, Number.NaN]) {
        expect(guideActionFor(unexpected), String(unexpected)).toBe('dismiss')
      }
    })

    it('keeps the cancel button the one that does nothing', () => {
      // `cancelId` is the last button, and it must map to a dismissal — pressing Escape or closing the dialog
      // is not consent to open anything.
      expect(guideActionFor(GUIDE_BUTTONS.length - 1)).toBe('dismiss')
    })
  })

  describe('the guide label follows the interface language', () => {
    it('answers Chinese for every Chinese tag, whatever the region or script', () => {
      // `app.getLocale()` answers in BCP 47 and the region is not the language: a check that compared the
      // whole tag would miss `zh-Hans-CN`, which is a spelling macOS and Windows both produce.
      for (const locale of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-TW', 'ZH_cn']) {
        expect(guideLabel(locale), locale).toBe('使用指南')
      }
    })

    it('answers English for everything else, including a tag it cannot parse', () => {
      for (const locale of ['en', 'en-US', 'ja-JP', 'de', '', '  ', 'zzz']) {
        expect(guideLabel(locale), JSON.stringify(locale)).toBe('User guide')
      }
    })

    it('reaches the menu, not just the helper', () => {
      const { entries } = template({ locale: 'zh-CN' })
      expect(helpItems(entries)[0]?.label).toBe('使用指南')
    })
  })

  describe('the guide address follows the interface language', () => {
    it('answers the mainland deployment for every Chinese tag, whatever the region or script', () => {
      // THE REGION AND SCRIPT SUBTAGS ARE IGNORED ON PURPOSE, and this is the case that pins it:
      // `zh-TW` and `zh-Hant-TW` are Traditional-script interfaces, and they still get `.cn`. The
      // mainland guide is written in Chinese, which is the language those readers chose; splitting on
      // script would send them to an English page instead, the worse of the two mismatches.
      for (const locale of [
        'zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG',
        'zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW', 'ZH_cn', 'zh_CN',
      ]) {
        expect(guideUrl(locale), locale).toBe('https://qialike.cn')
      }
    })

    it('agrees with the label about which interfaces are Chinese', () => {
      // ONE RULE, TWO CONSUMERS. `guideLabel` decides the menu entry's wording and `guideUrl` decides
      // the address behind it; if they ever disagree the entry says 使用指南 and opens an English
      // page. Comparing them across the same tag list is what keeps them from drifting apart.
      for (const locale of ['zh', 'zh-CN', 'zh-Hans-CN', 'zh-TW', 'zh-Hant-TW', 'en-US', 'ja-JP', '']) {
        const chinese = guideLabel(locale) === '使用指南'
        expect(guideUrl(locale) === 'https://qialike.cn', locale).toBe(chinese)
      }
    })

    it('answers the international deployment for everything else, including a tag it cannot parse', () => {
      for (const locale of ['en', 'en-US', 'ja-JP', 'de-DE', '', '  ', 'zzz']) {
        expect(guideUrl(locale), JSON.stringify(locale)).toBe('https://qialike.com')
      }
    })

    it('agrees with the international constant on every non-Chinese tag', () => {
      // `USER_GUIDE_URL` is kept for readability in the "everything else" assertions; this is what stops
      // it drifting into a third answer if the international host ever changes.
      for (const locale of ['en-US', 'fr', 'ja-JP']) {
        expect(guideUrl(locale), locale).toBe(USER_GUIDE_URL)
      }
    })

    it('is the only place the address is decided', async () => {
      // THE GUARD AGAINST A FUTURE HALF-CHANGE. `main.ts` used to reach for `USER_GUIDE_URL` directly in
      // nine places — the dialog text, the copy, the open, two log lines, the failure detail and the
      // retry copy. A single one left behind would show one address while opening another, and the user
      // would read a link that does not match the page they were sent to. Reading the source is the cheap
      // way to state that the decision has exactly one home.
      const main = await readFile(join(ROOT, 'apps', 'desktop', 'src', 'main.ts'), 'utf8')
      expect(main).not.toContain('USER_GUIDE_URL')
      expect(main).toContain('guideUrl(app.getLocale())')
    })
  })

  it('puts the application menu first on macOS, and nowhere else', () => {
    // It has to be first: macOS treats the first menu as the application menu, and `role: 'appMenu'`
    // declares About, Services, Hide and Quit.
    expect(template({ isMac: true }).entries[0]?.role).toBe('appMenu')
    expect(template({ isMac: false }).entries.some((entry) => entry.role === 'appMenu')).toBe(false)
  })

  it('carries the standard editing and window roles', () => {
    // The product is driven from its own UI, so these two are the whole reason a menu exists at all —
    // without them the platform's copy, paste and window shortcuts stop working.
    const { entries } = template()
    const roles = entries.map((entry) => entry.role).filter((role) => role !== undefined)
    expect(roles).toContain('editMenu')
    expect(roles).toContain('windowMenu')
  })

  it('gives every View submenu entry a role or a separator type', () => {
    // Same class of failure one level down: an entry in a submenu with neither does nothing.
    const view = template().entries.find((entry) => entry.label === 'View')
    const items = view?.submenu ?? []
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.role !== undefined || item.type === 'separator', `dead View item: ${JSON.stringify(item)}`).toBe(true)
    }
  })
})
