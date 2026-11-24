/**
 * The application menu, as data.
 *
 * WHY THIS IS A SEPARATE MODULE RATHER THAN INLINE IN `main.ts`. It was inline, and a change to it broke
 * the Help menu without any test noticing: the About item lost the `submenu` key that held it, so the Help
 * entry had nothing to open and clicking it did nothing. The test that was supposed to cover this asserted
 * that a substring appeared in `main.ts` — it checked the text of the change, not the shape of the menu,
 * so it passed while the menu was dead.
 *
 * `main.ts` cannot be imported by a test (it builds a window, a protocol and a Host when loaded), but this
 * can: it is pure data. `electron` is imported as a TYPE only, so importing this module starts nothing.
 *
 * The trade is deliberate: the menu is small, and being able to state what it contains is worth more than
 * keeping it beside the code that installs it. `installMenu` in `main.ts` is now two lines.
 *
 * @module @qialike/desktop/menu
 */

import type { MenuItemConstructorOptions } from 'electron'

/**
 * The product's user guide, in the deployment that matches the interface language.
 *
 * WHY TWO HOSTS. The product runs two independent deployments — `qialike.com` for the international
 * market and `qialike.cn` for the mainland — with their own consoles, accounts and content. The
 * guide is written per deployment, so sending a Chinese-language user to the international site
 * lands them on pages whose account links and pricing do not apply to them.
 *
 * WHY THE LANGUAGE DECIDES, AND WHY THAT IS NOT A GEOGRAPHIC CLAIM. There is no reliable, offline
 * way to ask "which country is this machine in": a timezone is a guess (`Asia/Shanghai` is also
 * what a great many machines outside China are configured with), and an IP lookup would mean a
 * network call on a menu action. The interface language is the one signal the application already
 * has, and it is the one the user chose — a person running the Chinese interface is being served
 * the Chinese deployment, which is exactly the deployment whose guide is useful to them.
 *
 * EVERY `zh` TAG GOES TO `.cn`, AND THE REGION AND SCRIPT SUBTAGS ARE IGNORED ON PURPOSE. `zh-TW`,
 * `zh-HK` and `zh-Hant-TW` also get the mainland site. They are Chinese interfaces, and the mainland
 * guide is written in Chinese rather than in a language those readers did not choose; splitting on
 * script would send a Traditional-script reader to an English page, which is the worse of the two
 * mismatches. The region a machine is set to is also not the question this answers — it is the
 * language the user reads.
 *
 * The language subtag is compared, not the whole tag: `app.getLocale()` answers in BCP 47
 * (`zh-CN`, `zh-Hans-CN`), and a check against the full string would miss `zh-Hans-CN`, which is
 * what macOS actually reports. This is the same rule `guideLabel` applies, so the menu entry and
 * the address behind it can never disagree about whether this is a Chinese interface.
 *
 * @param locale - a BCP 47 tag, as `app.getLocale()` returns it.
 * @returns the guide's address for this locale.
 */
export function guideUrl(locale: string): string {
  const language = locale.trim().toLowerCase().split(/[-_]/u)[0]
  return language === 'zh' ? 'https://qialike.cn' : 'https://qialike.com'
}

/**
 * The international guide.
 *
 * Kept as a named constant because it is the answer for every locale that is not Chinese, and
 * naming it keeps the tests that assert "everything else gets .com" readable. Anything that shows
 * the address to a user must call {@link guideUrl} instead — a constant cannot know the locale.
 */
export const USER_GUIDE_URL = 'https://qialike.com'

/**
 * The buttons the guide dialog offers, in the order its responses are read.
 *
 * WHY THE DIALOG EXISTS AT ALL, RATHER THAN ONE CALL TO `shell.openExternal`. Because that call CANNOT be
 * trusted to report its own failure, and this was measured rather than assumed:
 *
 *   · The default browser on the machine this was found on is a SNAP. Snap launches through
 *     `systemd-run`, and when the caller is inside a namespace systemd cannot attribute to a unit, the
 *     launch fails with `cannot create transient scope … Process N is a kernel thread, refusing`.
 *   · **`xdg-open` still exits 0 when that happens.** So `shell.openExternal` resolves, and a `catch`
 *     around it never runs: the menu item does nothing at all, with nothing in any log.
 *
 * A dialog whose default button opens the browser and whose second button copies the link is therefore the
 * only shape that helps in BOTH worlds: the working one costs one keypress (Enter), and the broken one puts
 * the address in the user's hands along with the reason it may not have opened. The cost is real and worth
 * stating: a click on the menu item no longer opens the browser by itself.
 */
export const GUIDE_BUTTONS = ['Open in browser', 'Copy link', 'Close']

/**
 * What the guide dialog's response means.
 *
 * A pure mapping, in this module rather than in `main.ts`, for the reason the whole menu is here: `main.ts`
 * cannot be imported by a test (it starts a window, a protocol and a Host), so a rule that lives in it can
 * only be checked by clicking. This is the rule — which button does what — and the test pins it against
 * {@link GUIDE_BUTTONS} so the two cannot drift.
 *
 * @param response - the index `dialog.showMessageBox` resolved with.
 * @returns `'open'` for the default button, `'copy'` for the second, `'dismiss'` for anything else.
 */
export function guideActionFor(response: number): 'open' | 'copy' | 'dismiss' {
  if (response === 0) return 'open'
  if (response === 1) return 'copy'
  // Anything else is a dismissal, INCLUDING an index this build does not expect. Treating an unknown
  // response as "open" would launch a browser on a keypress the user did not intend.
  return 'dismiss'
}

/**
 * The guide's label, in the language the interface is in.
 *
 * `app.getLocale()` answers in BCP 47 (`zh-CN`, `zh-Hans-CN`, `en-US`), and the language subtag is the part
 * that decides this — a region is not a language. Everything that is not Chinese gets the English label,
 * which is the honest default: the guide's own pages are written per language, and a label we cannot
 * translate is better than one we guess at.
 *
 * @param locale - a BCP 47 tag, as `app.getLocale()` returns it.
 * @returns the label for this locale.
 */
export function guideLabel(locale: string): string {
  const language = locale.trim().toLowerCase().split(/[-_]/u)[0]
  return language === 'zh' ? '使用指南' : 'User guide'
}

/** What {@link buildMenuTemplate} needs to know. Passed in rather than imported, so it is testable. */
export interface MenuInputs {
  /** Whether this is macOS, which has a system application menu and system About panel. */
  isMac: boolean
  /** The product name, used in the About item's label. */
  productName: string
  /** The interface locale, as `app.getLocale()` reports it; decides the guide's label. */
  locale: string
  /** Opens the About dialog. */
  onShowAbout: () => void
  /** Opens the user guide in the user's browser. */
  onOpenGuide: () => void
}

/**
 * Build the application menu.
 *
 * A minimal menu: the product is driven from its own UI, so this carries the platform's standard editing
 * and window roles plus one Help entry.
 *
 * WHY HELP IS PRESENT ON MACOS NOW, HAVING BEEN ABSENT. The entry used to hold About and nothing else, and
 * on macOS About already lives in the application menu that `role: 'appMenu'` contributes with the same
 * dialog behind it — so the Help entry there would have been a duplicate whose only real content was a
 * label. It was omitted rather than left empty. The guide changed that: it has no macOS equivalent, so
 * omitting Help on macOS would now withhold the one thing this menu is for. About stays out of it there,
 * for the reason it was omitted before.
 *
 * An entry with an empty or missing `submenu` is not merely useless: it is unclickable, which is the defect
 * this module exists to keep out. Every top-level entry below therefore has either a `role` or a `submenu`,
 * and the test asserts that rather than trusting it.
 *
 * WHY ONLY THE GUIDE'S LABEL IS LOCALIZED. The role menus (`editMenu`, `windowMenu`) are spelled by the
 * platform. The labels this module writes itself — `View`, `Help`, `About …` — are English and stay English;
 * translating them is a change to the whole menu rather than to this item. The guide is the exception
 * because of what it is for: someone who cannot read the English label is exactly the person who needs the
 * guide, and a menu item they cannot identify is one they will not click.
 *
 * @param inputs - the platform, the product name, the locale, and the two callbacks.
 * @returns the template for `Menu.buildFromTemplate`.
 */
export function buildMenuTemplate({
  isMac, productName, locale, onShowAbout, onOpenGuide,
}: MenuInputs): MenuItemConstructorOptions[] {
  return [
    // On macOS the first menu is the application menu, which the platform supplies — About, Services,
    // Hide, Quit and the rest. Nothing here should duplicate it.
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        // The guide first and About last: the thing a user came to the Help menu for belongs at the top,
        // and About is where every platform puts it.
        { label: guideLabel(locale), click: onOpenGuide },
        // About is contributed by `role: 'appMenu'` on macOS, with the same dialog behind it.
        ...(isMac ? [] : [
          { type: 'separator' as const },
          { label: `About ${productName}`, click: onShowAbout },
        ]),
      ],
    },
  ]
}
