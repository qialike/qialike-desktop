/**
 * The theme picker — the browser half of `@qialike/qialike-desktop-theme`.
 *
 * HAND-WRITTEN, NOT BUILT, for the reason the providers page spells out at length:
 * the harness's client-bundle preset is unpublished, and the artifact contract it
 * targets is small enough to write directly —
 *
 *     window.__ModuleLoader__.load({ id, factory })
 *     factory(require) -> module.exports   // exports.apply, exports.inject
 *
 * — so this is plain JavaScript with `React.createElement` and no JSX.
 *
 * WHY IT REGISTERS WHAT THE HOST SENDS. The mapping from the CLI's 16-role palette to
 * this surface's `--dsw-alias-*` tokens lives in the Host package, once, where it is
 * unit-tested. Carrying a second copy here would put that table's correctness beyond
 * the reach of the suite, because this file is browser JavaScript that only ever runs
 * inside a live window. So the Host maps, this half registers — and it uses the `id`
 * the Host computed rather than deriving one from the name, which is what keeps the
 * namespacing rule (needed because the CLI ships a scheme called `light` and the
 * harness already has a theme by that id) in exactly one place.
 *
 * WHY THE PREFERENCE IS RE-ASSERTED ON EVERY THEME CHANGE. `ThemeRuntime` owns a
 * durable settings scope whose `adopt()` normalises the preference back to whatever
 * that scope holds — `system`, unless someone changed it. A scheme id is not a valid
 * value for the scope (its schema is the union `light | dark | system`), so it cannot
 * store our choice and will overwrite it the first time it delivers a value. The
 * stored scheme therefore lives in `qialike.json`, and this half re-applies it
 * whenever the runtime drifts.
 *
 * THE INTERACTION THAT FOLLOWS, STATED PLAINLY: while a scheme is chosen, the
 * harness's own Appearance row (the light/dark/system cubes) stops changing the
 * palette, because the scheme's tokens are layered over whatever base it selects.
 * That is coherent rather than a bug — a colourscheme fully specifies a palette,
 * which is the CLI's own model — and it ends the moment the user picks System, Light
 * or Dark in this row, which clears the stored scheme. Both are offered here so the
 * user never has to know which control is authoritative.
 *
 * @module @qialike/qialike-desktop-theme/client
 */

window.__ModuleLoader__.load({
  id: '@qialike/qialike-desktop-theme',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /**
     * The Host route serving the scheme list and the stored preference.
     *
     * DOCUMENT-RELATIVE, with no leading slash: the served document carries
     * `<base href="./">`, and a root-absolute literal resolves against the origin
     * instead of the document — which breaks the moment the surface is mounted under
     * a prefix.
     */
    const API = 'api/qialike/themes'

    // ── styles ────────────────────────────────────────────────────────────────
    //
    // WHY THIS WAS MISSING, AND WHY THAT MATTERED. The row rendered as a bare
    // `<select>` with no styling, so the control the user actually operates was drawn
    // by the user agent: measured in a rendered window, it was a 127x20 grey widget
    // with a `#858585` border, **byte-identical in the dark theme and in dracula**,
    // and white in One Light. It therefore followed `color-scheme` — which is why the
    // dark schemes agreed with each other — but not one colour of the scheme it was
    // choosing. A native dropdown inside a purple Dracula window reads as a piece of
    // another application, and it is the one control in the window that a user
    // interacts with *in order to* change the palette.
    //
    // The fix copies the design system's own field rather than inventing one:
    // `ui-settings-models/ModelsSection.module.css` styles its selects as
    // `bg-layer-1` fill, `border-l4` outline, `label-primary` ink, `radius-md`, 32px
    // tall — and replaces the OS arrow with a 12px chevron, because the native arrow
    // sits flush against the edge and is part of what makes the control look foreign.
    // Every token below is in the theme's own mapping, so the field follows the chosen
    // scheme like the rest of the window; `tests/client-tokens.test.mjs` fails the
    // build if any name here stops existing upstream.
    //
    // The chevron is a data-URI SVG, so it cannot read a CSS variable and has to carry
    // a literal stroke — upstream's own comment says the same about the identical
    // chevron in that file ("#81858C is the caption gray shared by both themes").
    const muted = { color: 'var(--dsw-alias-label-secondary)' }
    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0', fontSize: '13px' },
      heading: { margin: 0, fontSize: '15px', fontWeight: 600 },
      group: { display: 'flex', flexDirection: 'column', gap: '8px' },
      cubes: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      cube: {
        font: 'inherit', cursor: 'pointer', padding: '5px 12px', borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2))',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      },
      cubeOn: {
        font: 'inherit', cursor: 'pointer', padding: '5px 12px', borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-brand-primary, var(--dsw-alias-border-l2))',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, currentColor) 16%, transparent)',
        color: 'var(--dsw-alias-label-primary)',
      },
      stepper: {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '2px 6px', borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2))',
      },
      stepValue: { minWidth: '40px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
      stepButton: {
        font: 'inherit', cursor: 'pointer', lineHeight: 1, padding: '2px 6px',
        borderRadius: '4px', border: 'none', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      expander: {
        font: 'inherit', cursor: 'pointer', alignSelf: 'flex-start', padding: '2px 0',
        border: 'none', background: 'transparent', fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)', textDecoration: 'underline',
      },
      row: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' },
      title: { fontWeight: 600 },
      description: { ...muted, lineHeight: '1.5' },
      field: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      select: {
        font: 'inherit', cursor: 'pointer', boxSizing: 'border-box',
        height: '32px', maxWidth: '240px', padding: '0 32px 0 10px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        appearance: 'none', WebkitAppearance: 'none',
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' "
          + "viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' "
          + "stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 10px center',
        backgroundSize: '12px 12px',
      },
      note: { ...muted, fontSize: '12px' },
      alert: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      path: { fontFamily: 'var(--dsw-font-mono)', fontSize: '11px' },
    }

    /** This plugin's dictionary namespace. */
    const NS = 'qialike-theme'

    const en = {
      'title': 'Theme',
      'description': 'Colour schemes are shared with the qialike CLI: the built-in set, plus any you keep in the themes directory.',
      'label': 'Colour scheme',
      'loading': 'Loading themes…',
      'failed': 'Could not load the themes.',
      'retry': 'Retry',
      'builtinGroup': 'Appearance',
      'shippedGroup': 'Built-in schemes',
      'userGroup': 'Your schemes',
      'system': 'Follow system',
      'light': 'Light',
      'dark': 'Dark',
      'saving': 'Saving…',
      'saveFailed': 'The scheme changed but could not be saved, so it will not survive a restart.',
      'missing': 'The saved scheme is no longer available, so the appearance setting is in charge.',
      'skipped': 'Skipped scheme file(s)',
      'userDir': 'Your schemes are read from',
      'sectionTitle': 'Appearance',
      'appearanceTitle': 'Appearance',
      'appearanceDescription': 'Which palette the interface follows.',
      'fontSizeTitle': 'Font size',
      'fontSizeTextDescription': 'Applies to conversation content only.',
      'fontSizeMore': 'More font sizes',
      'fontSizeCode': 'Code',
      'fontSizeCodeDescription': 'Code blocks and inline code.',
      'fontSizeTerminal': 'Terminal',
      'fontSizeTerminalDescription': 'Output in the terminal panel.',
      'fontSizeUnit': 'px',
      'fontSizeIncrease': 'Larger',
      'fontSizeDecrease': 'Smaller',
    }

    const zh = {
      'title': '主题',
      'description': '配色方案与 qialike 命令行共享：内置方案，以及你放在主题目录中的方案。',
      'label': '配色方案',
      'loading': '正在加载主题…',
      'failed': '无法加载主题。',
      'retry': '重试',
      'builtinGroup': '外观',
      'shippedGroup': '内置方案',
      'userGroup': '你的方案',
      'system': '跟随系统',
      'light': '浅色',
      'dark': '深色',
      'saving': '正在保存…',
      'saveFailed': '配色已切换，但未能保存，重启后不会保留。',
      'missing': '已保存的配色方案不再可用，当前由外观设置决定。',
      'skipped': '已跳过的配色文件',
      'userDir': '你的方案读取自',
      'sectionTitle': '外观',
      'appearanceTitle': '外观',
      'appearanceDescription': '界面跟随哪一套明暗。',
      'fontSizeTitle': '字号大小',
      'fontSizeTextDescription': '仅影响会话内容的字号。',
      'fontSizeMore': '更多字号',
      'fontSizeCode': '代码',
      'fontSizeCodeDescription': '代码块与行内代码。',
      'fontSizeTerminal': '终端',
      'fontSizeTerminalDescription': '终端面板中的输出。',
      'fontSizeUnit': 'px',
      'fontSizeIncrease': '调大',
      'fontSizeDecrease': '调小',
    }

    /**
     * Fetch the scheme list and the stored preference.
     *
     * A non-2xx response and a `{ ok: false }` payload are both failures: the route
     * answers 200 with `ok: false` for a request it understood and could not carry
     * out, and treating that as success would render an empty picker with no
     * explanation.
     *
     * @returns the payload.
     * @throws Error with a message the row can show.
     */
    async function fetchThemes() {
      const response = await fetch(API, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error((payload && payload.message) || String(response.status))
      if (!payload || payload.ok !== true) throw new Error((payload && payload.message) || 'malformed response')
      return payload
    }

    /**
     * Persist the choice.
     *
     * @param name - the scheme name, or null to return to the harness's preference.
     * @returns whether the write landed.
     */
    async function persist(name) {
      try {
        const response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'setPreference', name: name }),
        })
        const payload = await response.json().catch(() => undefined)
        return Boolean(payload && payload.ok === true)
      } catch {
        return false
      }
    }

    /** Services this plugin needs before it can register anything. */
    const inject = ['slots', 'locale', 'theme']

    /**
     * The scheme that paints a photograph behind the window, and where it lives.
     *
     * WHY THE IMAGE IS A TOKEN RATHER THAN A CSS RULE WITH A HARDCODED URL. The theme
     * service's `overrideTokens()` is the public way to layer a value over whatever
     * scheme is active, and it is *scoped by construction*: the layer exists only while
     * this plugin holds it, so switching away from the scheme removes the photograph
     * without this file having to track document state. A stylesheet rule carrying
     * `url(...)` would apply to every scheme instead, and the only way to scope it
     * would be a selector on the scheme's own token values — a string match on inline
     * style, which breaks the moment a palette changes.
     *
     * WHY THE RULE USES A CUSTOM PROPERTY AND NOT `--dsw-alias-bg-base`. That token is
     * the window's base *colour* and 43 upstream rules read it as one
     * (`background: var(--dsw-alias-bg-base)`); replacing it with a `url()` turns every
     * one of them into an image and strips their fill. So the photograph gets its own
     * variable, and one rule opts the frame into it. With the variable unset — every
     * other scheme — that rule resolves to `none` and changes nothing.
     *
     * HOW THE FRAME IS FOUND, WHICH TOOK A LIVE WINDOW TO GET RIGHT. The obvious hook is
     * its CSS-module class, and the first version of this matched `[class*="_frame_"]` on
     * the strength of `_frame_1hfzl_1` in one bundle. The running window disagreed: its
     * frame is `als6gG_frame`, from a lazily-loaded chunk that names classes
     * `<hash>_frame` rather than `_name_<hash>_<n>`. Both spellings exist in the shipped
     * artifact, so a selector built on either is a coin flip — and the failure is
     * completely silent: the override layer is set, the image loads, and nothing paints.
     *
     * So the primary hook is the slot wrapper the layout itself renders —
     * `[data-slot="root"] > div`, stable across hashing because it is an attribute in
     * the TSX, not a generated class. The two class spellings stay as fallbacks for a
     * future build that stops using the slot attribute.
     */
    /**
     * The scheme the surface opens in when the user has never chosen one.
     *
     * Equal to the CLI's own `DEFAULT_SCHEME` (0.11.2), so both front ends of this product
     * open in the same palette. It is a NAME, not an id: the id is namespaced by the Host.
     */
    const DEFAULT_SCHEME = 'moss'

    const PHOTO = {
      schemeId: 'qialike-moss',
      layer: 'qialike-moss-photo',
      variable: '--qialike-moss-photo',
      /**
       * Present on `body` only while the photograph is painted.
       *
       * The gate exists because the rule must not reach the other schemes for even one
       * paint: a CSS custom property cannot gate a declaration (the cascade has no "is
       * this variable set" test), so the bundle toggles an attribute next to it.
       *
       * WHAT THIS DOES NOT SOLVE, MEASURED AND WORTH KNOWING BEFORE EXTENDING IT. The
       * app stacks opaque surfaces, and the frame is *underneath* them: its six direct
       * children do clear (verified in a running window), but the conversation column
       * that actually covers the centre — 1000x793 painting `rgb(21,21,23)` — is a
       * descendant at `centerCol > div > root`, not a child. Making that transparent is
       * a change to the app's surface structure rather than a rule about one element, so
       * it is left out deliberately: the photograph is painted and correct, and visible
       * wherever an opaque surface does not sit over it.
       */
      attribute: 'data-qialike-photo',
      /**
       * The frame itself, in three spellings.
       *
       * A COMMA LIST CANNOT BE SUFFIXED. An earlier version appended ` > div` to a joined
       * selector to reach the frame's children, which binds to the last item only — so
       * the rule looked complete in the source and cleared nothing but the fallbacks. The
       * list is kept unjoined for that reason; anything needing a suffix builds it per
       * item with `.map()`.
       */
      frames: ['[data-slot="root"] > div', '[class*="_frame_"]', '[class$="_frame"]'],
      /** The attribute the presenter publishes for native chrome; this row keeps it honest. */
      sourceAttribute: 'data-ds-theme-source',
      /** Set on an element the scan is clearing; the rule turns its fill transparent. */
      surfaceAttribute: 'data-qialike-photo-surface',
      /**
       * Subtrees the scan must never touch: dialogs, and the layer the shell renders them in.
       *
       * The overlay layer holds every modal, menu and popover; `role="dialog"` and
       * `aria-modal` catch one rendered anywhere else. A dialog is large and opaque on
       * purpose, so without this the size test selects it and clears its fill.
       */
      overlaySelector: '[class*="overlayLayer"],[role="dialog"],[aria-modal="true"]',
      /**
       * How much of the frame an opaque element must cover before it is cleared.
       *
       * 12% is chosen from the measurements, not from taste: the sidebar column is 280 of
       * 1280 wide (22%), the conversation column is the rest (78%), and a card is 8%. So
       * 12% separates "a surface the window is painted on" from "a thing placed on it"
       * with margin on both sides. Lower would start dissolving cards; higher would leave
       * the sidebar solid, which is one of the two symptoms this exists to fix.
       */
      surfaceShare: 0.12,
      // Document-relative: the served document carries `<base href="./">`, and the only
      // URL space the shell serves without knowing file names is `/assets/`.
      url: 'assets/moss-bg.jpg',
    }

    /**
     * Paint the photograph behind the frame while, and only while, its scheme is active.
     *
     * @param ctx - the client root context (needs `theme`).
     * @returns a disposer removing the rule, the layer and the subscription.
     */
    function applyPhoto(ctx, tokenMaps, schemeKinds, getIntent, painter) {
      const frames = PHOTO.frames.join(',')
      const style = document.createElement('style')
      style.id = PHOTO.layer
      style.textContent = `body[${PHOTO.attribute}] ${frames}{`
        + `background-image:var(${PHOTO.variable},none);`
        + 'background-size:cover;background-position:center;background-repeat:no-repeat}'
        // THE SURFACES ON TOP OF THE FRAME, marked by the scan below.
        //
        // WHY A SCAN AND NOT A SELECTOR. The app stacks opaque surfaces several levels
        // deep, and every one of them is a CSS-module class whose name is a build hash —
        // measured in one running window, the frame itself was `als6gG_frame` while the
        // bundle also carried `_frame_1hfzl_1`. Naming them is a guessing game that fails
        // silently: the photograph is painted, correct, and covered.
        //
        // So the scan asks the only question that matters — "is this element a large
        // opaque fill sitting over the frame?" — by measurement rather than by name. The
        // threshold is a fraction of the frame's area, chosen to catch columns (the
        // sidebar is 280 of 1280 wide, 22%) while leaving cards and bubbles alone (the
        // widest measured card is 712x114, 8%).
        + `body[${PHOTO.attribute}] [${PHOTO.surfaceAttribute}]{background-color:transparent!important}`
      document.head.append(style)

      /**
       * The photograph, as one CSS value: the scrim and the image.
       *
       * THE SCRIM IS PART OF THE VALUE, NOT A SECOND LAYER IN THE RULE, and that is what
       * keeps every other scheme untouched: an unset variable resolves to `none`, whereas
       * a gradient written into the rule would paint a dark wash over fifteen schemes
       * that never asked for a photograph.
       *
       * HOW BRIGHT IT ENDS UP, AND WHY THE DARKENING LIVES IN THE ASSET.
       *
       * Reported twice: first invisible, then too bright. The numbers explain both. This
       * photograph's own median is 40/255 — near-black — so under a heavy wash the
       * composite sat at 13..20 and read as a flat colour; brightening it in the asset
       * fixed that and overshot, leaving the composite at 29, which is *above* the moss
       * panel (#141815, luminance 21) and therefore brighter than the surface around it.
       *
       * The mistake in the middle attempt was doing all the work with the scrim. A scrim
       * is an addition, so it compresses everything toward one value: pushing it to 0.85
       * reaches a median of 19 but leaves a standard deviation of 6, which is a texture
       * nobody can see. Darkening the image instead is a multiplication, which keeps the
       * ratios, so a light 0.50 scrim over a 0.50-baked asset lands at a median of 17 with
       * a standard deviation of 11 — the same darkness with twice the detail in it.
       *
       * 17 sits between the scheme's background (15) and its panel (21), which is the
       * whole point: the photograph reads as part of the window rather than as a brighter
       * thing behind it. The ceiling still holds at 70/255, well under the 101 where this
       * scheme's text colour would drop below 4.5:1.
       *
       * THE SCRIM IS NOW TRANSPARENT BECAUSE THE ARTWORK ARRIVES FINISHED. The asset is a
       * rendered effect — measured at a median of 16.8/255 and a maximum of 50/255, which is
       * the 17 the paragraph above calls the target — not a raw photograph that still needs
       * darkening. Scrimming it again would be the "compresses everything toward one value"
       * failure this comment already warns about: measured, a second 0.50 pass takes the
       * standard deviation from 9.8 to 5.4 and the ceiling from 50 to 41, which is the flat
       * colour the earlier attempt was rejected for.
       *
       * SO THE CONTRACT IS NOW THE OTHER WAY ROUND: whatever is placed at `PHOTO.url` must be
       * delivered at the final brightness. `apps/desktop-web/crop-moss-bg.py` produces such a
       * file from a source photograph (crop, tone curve, ceiling), and the alpha stays at 0 so
       * a replacement cannot be darkened twice by accident.
       */
      const value = `linear-gradient(rgba(12,15,13,0),rgba(12,15,13,0)),url("${PHOTO.url}")`

      /** Every element the scan is currently clearing, so a teardown can undo all of it. */
      let cleared = []

      /** Drop the marks the scan made, leaving the elements' own CSS in charge again. */
      const unmark = () => {
        for (const element of cleared) element.removeAttribute(PHOTO.surfaceAttribute)
        cleared = []
      }

      /**
       * Mark the large opaque fills that sit over the frame.
       *
       * MEASURED, NOT NAMED — see the rule's note. Two conditions, both about what the
       * element paints rather than what it is called: it must be an opaque colour (not an
       * image, not a translucent wash), and it must cover at least
       * {@link PHOTO.surfaceShare} of the frame's area.
       *
       * ADD-ONLY, AND THAT IS WHAT STOPS THE FLICKER. The first version also removed the
       * mark from anything that no longer qualified, and reported symptoms followed
       * exactly: the background flashed, and it went solid whenever the pointer moved.
       * A hover restyles elements, the observer fired, and the scan briefly saw a surface
       * mid-transition as not-yet-opaque — dropping the mark restored its fill for a frame
       * before the next scan added it back. Removing marks is now reserved for the two
       * moments where it is the point: leaving the scheme, and teardown.
       *
       * The cost is a stale mark on an element that shrinks below the threshold while the
       * photograph is shown. That element is transparent where it was opaque, which is the
       * direction this feature wants; the marks are all dropped on the way out.
       */
      const clearSurfaces = () => {
        const frame = document.querySelector(frames)
        if (frame === null) return
        const bounds = frame.getBoundingClientRect()
        const area = bounds.width * bounds.height
        if (area === 0) return

        for (const element of frame.querySelectorAll('*')) {
          if (element.hasAttribute(PHOTO.surfaceAttribute)) continue
          const rect = element.getBoundingClientRect()
          if (rect.width * rect.height < area * PHOTO.surfaceShare) continue
          // NEVER CLEAR A DIALOG OR ANYTHING INSIDE ONE.
          //
          // A modal is large and opaque by design, so the size test above selects it — and
          // then this rule makes it transparent, which is the opposite of what a modal is
          // for. Reported as "the model-provider setup window is see-through and I can read
          // the window behind it". Measured on a fresh profile: both the dialog card
          // (466x340) and its full-window backdrop carried the mark and computed
          // `rgba(0, 0, 0, 0)`.
          //
          // The overlay layer is the structural place this surface renders dialogs, menus and
          // popovers; `role`/`aria-modal` cover a modal rendered outside it. Both tests are
          // cheap and neither can match a column, which is what this scan is for.
          if (element.closest(PHOTO.overlaySelector) !== null) continue
          const computed = getComputedStyle(element)
          if (computed.backgroundImage !== 'none') continue
          // `rgba(0, 0, 0, 0)` and `transparent` are already letting the frame through.
          if (computed.backgroundColor === 'transparent') continue
          const alpha = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/u.exec(computed.backgroundColor)?.[1]
          if (alpha !== undefined && Number(alpha) < 0.05) continue
          element.setAttribute(PHOTO.surfaceAttribute, '')
          cleared.push(element)
        }
      }

      let pending = 0
      const observer = new MutationObserver(() => {
        if (pending !== 0) return
        pending = setTimeout(() => {
          pending = 0
          if (document.body.hasAttribute(PHOTO.attribute)) clearSurfaces()
        }, 150)
      })
      const watch = () => observer.observe(document.body, {
        // STRUCTURE ONLY. Watching `class` and `style` made every hover restyle a scan
        // trigger — measured as the background going solid whenever the pointer moved,
        // because a restyled element was re-measured mid-transition. Panels opening and
        // sessions mounting are child-list changes, which is all this needs to see.
        childList: true,
        subtree: true,
      })

      /**
       * Scans scheduled after the scheme is chosen, at increasing delays.
       *
       * MEASURED, AND THE REASON THIS EXISTS AT ALL: with only the observer, the marks
       * were still zero several seconds after the window finished painting. Provoking one
       * more DOM mutation marked three surfaces immediately — so the observer worked and
       * the scan had simply run while the previous tree was still in place, before
       * onboarding gave way to the workspace. The observer cannot see a render that
       * replaced the nodes it had just marked unless something mutates *after* it, and a
       * window that has finished settling does not mutate again.
       *
       * Resize is in the same category: the columns are sized from the viewport, so a
       * resize changes which elements cross the threshold.
       */
      let rescans = []
      const scheduleRescans = () => {
        clearRescans()
        for (const delay of [250, 1000, 2500]) {
          rescans.push(setTimeout(() => {
            if (document.body.hasAttribute(PHOTO.attribute)) clearSurfaces()
          }, delay))
        }
      }
      const clearRescans = () => {
        for (const id of rescans) clearTimeout(id)
        rescans = []
      }
      const onResize = () => {
        if (document.body.hasAttribute(PHOTO.attribute)) clearSurfaces()
      }

      /**
       * The alias tokens this row is currently writing itself, by name.
       *
       * WHY THE ROW PAINTS THE PALETTE AND DOES NOT LEAVE IT TO THE PRESENTER. The
       * harness's `ui-layout` presenter writes `snapshot.active.tokens` onto `body` and is
       * the intended owner of that job. Measured over the DevTools protocol on this
       * build, it does not happen for a scheme restored at startup: four consecutive
       * launches left `body` with zero `--dsw-alias-*` variables and the base palette at
       * the harness's `#151517`, while this row's own listener saw `active.id` as the
       * scheme. The two halves of the client disagreed about what was active, and only
       * one of them painted.
       *
       * Writing the same tokens here removes the dependency on that agreement: the
       * snapshot this row reads is the authority for what it paints, and the values are
       * the Host's own (one table, computed once). The presenter's bookkeeping cannot
       * strip them — it only ever retracts names it wrote itself — so the two cannot
       * fight; if the presenter does apply, it writes the same values.
       */
      let paintedTokens = []

      /**
       * The base value this row last wrote, and the name it is watched through.
       *
       * WHY A SINGLE TOKEN STANDS FOR ALL OF THEM. The presenter strips every name it
       * believes it wrote, in one pass, and it writes the base first — so `bg-base` moving
       * off our value means the whole map went with it. Watching one name keeps the repair
       * check cheap enough to run on every style mutation.
       */
      const WATCHED_TOKEN = '--dsw-alias-bg-base'
      let paintedBase

      /** Remove every token this row wrote, leaving the base palette in charge. */
      const unpaintTokens = () => {
        for (const name of paintedTokens) document.body.style.removeProperty(name)
        paintedTokens = []
        paintedBase = undefined
      }

      /**
       * Paint one scheme's token map onto `body`.
       *
       * @param tokens - `--dsw-alias-*` name to value, as the Host computed it.
       */
      const paintTokens = (tokens) => {
        unpaintTokens()
        for (const [name, tokenValue] of Object.entries(tokens ?? {})) {
          document.body.style.setProperty(name, tokenValue)
          paintedTokens.push(name)
        }
        paintedBase = tokens?.[WATCHED_TOKEN]
      }

      /**
       * Bring the document in line with the choice this row is holding.
       *
       * WHY THE CHOICE AND NOT THE RUNTIME'S `active`. The runtime's preference is owned
       * by a settings scope whose schema is `light | dark | system`, so a scheme id
       * cannot live there: `adopt()` writes `system` over it whenever the scope delivers,
       * which is on startup. Measured over the DevTools protocol on this build, four
       * consecutive launches ended with `body` carrying zero `--dsw-alias-*` variables and
       * the harness's `#151517` while the picker showed the stored scheme — the window
       * painted the defaults under a row that claimed otherwise.
       *
       * Driving from `intent` removes the disagreement: this row knows what the user
       * chose, because it is the thing that chose it, and it paints exactly that. The
       * values are still the Host's own map, so nothing is duplicated or invented.
       *
       * A side effect worth stating: while a scheme is selected this row owns the
       * palette, so the harness's own Light/Dark/System cubes no longer change it. That
       * is the documented model — a colourscheme fully specifies a palette, which is why
       * the row has always offered those three as choices that clear the scheme.
       */
      const sync = () => {
        const wanted = getIntent()
        const scheme = wanted !== null && wanted.kind === 'scheme' ? wanted.id : undefined
        if (scheme !== undefined) {
          // The Host's map wins over the runtime's copy: they are the same values when the
          // runtime has them, and the Host's is present even when it does not.
          paintTokens(tokenMaps.get(scheme))
          // The presenter still publishes `system` here, because that is the preference it
          // believes in — and the Electron preload mirrors this attribute into the native
          // theme, so leaving it alone paints a light title bar over a dark scheme.
          const kind = schemeKinds.get(scheme)
          if (kind !== undefined) document.documentElement.setAttribute(PHOTO.sourceAttribute, kind)
        } else {
          unpaintTokens()
        }

        if (scheme === PHOTO.schemeId) {
          document.body.style.setProperty(PHOTO.variable, value)
          document.body.setAttribute(PHOTO.attribute, '')
          clearSurfaces()
          watch()
          window.addEventListener('resize', onResize)
          scheduleRescans()
        } else {
          document.body.style.removeProperty(PHOTO.variable)
          document.body.removeAttribute(PHOTO.attribute)
          unmark()
          observer.disconnect()
          window.removeEventListener('resize', onResize)
          clearRescans()
        }
      }

      painter.refresh = sync

      /**
       * REPAIR THE PALETTE THE MOMENT SOMETHING STRIPS IT, INSTEAD OF UP TO 1.5 s LATER.
       *
       * The presenter retracts, by name, the tokens it previously wrote — and the names are
       * this row's too, so applying the built-in palette removes ours in the same pass.
       * `SETTLE_DELAYS` re-paints on a timer, which is what made the palette appear: but the
       * last two ticks are at 1.5 s and 3 s, so between a strip and the next tick the window
       * sits on the harness's `#151517` while the picker shows the chosen scheme.
       *
       * MEASURED, and the reason this is here rather than a shorter timer: the packaged
       * build's end-to-end run samples the palette 1200 ms after choosing a scheme, and it
       * failed `--dsw-alias-bg-base=#151517 (palette #282a36)` on one launch and passed on
       * the next three. A race with a two-second window is a flicker a person can see, not
       * only a test that flakes.
       *
       * Watching `style` and re-painting costs nothing when the window is settled: the check
       * compares the value already on `body` and writes only when it differs, so a paint
       * cannot feed itself. The timer stays as the slower backstop for a strip that happens
       * before this observer is attached.
       */
      const repair = () => {
        const wanted = getIntent()
        if (wanted === null || wanted.kind !== 'scheme') return
        if (paintedBase === undefined) return
        if (document.body.style.getPropertyValue(WATCHED_TOKEN) === paintedBase) return
        sync()
      }
      const bodyObserver = new MutationObserver(repair)
      bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['style'] })

      // Read once for the state at mount, then follow changes. Nothing is painted yet —
      // `intent` is null until the stored preference arrives — and every paint below is a
      // no-op until then, so the base palette stays in charge for that window.
      sync()
      const off = ctx.on('theme/change', () => { sync() })
      return () => {
        off()
        observer.disconnect()
        bodyObserver.disconnect()
        if (pending !== 0) clearTimeout(pending)
        clearRescans()
        window.removeEventListener('resize', onResize)
        unmark()
        // The variable and the attribute outlive the rule otherwise: `body` keeps state
        // nothing reads, and a remount would look correct while the leak stayed behind.
        document.body.style.removeProperty(PHOTO.variable)
        document.body.removeAttribute(PHOTO.attribute)
        style.remove()
      }
    }

    /**
     * Register the schemes, restore the stored choice, and mount the row.
     *
     * Everything the row needs is built here and handed to the component through its
     * closure: the harness's slot contract passes no arbitrary props into a registered
     * component, and hanging state off the cordis context to reach it would put our
     * names on an object the whole client shares.
     *
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'qialike-theme: dictionaries')
      /**
       * Scheme id to the tokens the Host sent for it.
       *
       * Kept beside the registrations because the row paints from it directly — see the
       * note on `paintedTokens` for why the palette is not left to the presenter.
       */
      const t = ctx.locale.bind(NS)

      /** What the row renders. Replaced, never mutated in place, so React re-renders. */
      let view = { loading: true, failed: false, data: null, missing: false, saving: false, saveFailed: false }
      const listeners = new Set()
      const setView = (patch) => {
        view = { ...view, ...patch }
        for (const listener of [...listeners]) listener()
      }
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }

      /**
       * The user's expressed intent, which has to survive the runtime normalising the
       * preference behind our back. `null` until the stored choice has been read, so a
       * `theme/change` arriving during startup cannot be read as drift.
       */
      let intent = null

      const tokenMaps = new Map()
      /** Scheme id to `light`/`dark`, for the native-chrome attribute. */
      const schemeKinds = new Map()
      /**
       * The painter's repaint hook, published by the effect below.
       *
       * The load runs in this scope and the painting lives in the effect's, so this is the
       * seam between them: `refresh()` is a no-op until the effect has registered, which
       * is exactly the right behaviour for a load that finishes first.
       */
      const painter = { refresh: () => {} }
      ctx.effect(() => {
        const stop = applyPhoto(ctx, tokenMaps, schemeKinds, () => intent, painter)
        return stop
      }, 'qialike-theme: scheme photograph')

      /** Disposers for the registered schemes, so a remount does not double-register. */
      let registered = []

      /**
       * Register every scheme the Host sent.
       *
       * `register` throws on a duplicate id, so an already-registered theme is skipped
       * rather than replaced: on a remount the previous registrations may not have been
       * disposed yet, and throwing there would take the whole row down.
       *
       * @param payload - the Host's response.
       */
      function registerSchemes(payload) {
        const existing = new Set(ctx.theme.getTheme().themes.map((theme) => theme.id))
        const disposers = []
        for (const scheme of payload.schemes) {
          tokenMaps.set(scheme.id, scheme.tokens)
          schemeKinds.set(scheme.id, scheme.colorScheme)
          if (existing.has(scheme.id)) continue
          try {
            disposers.push(ctx.theme.register({
              id: scheme.id,
              colorScheme: scheme.colorScheme,
              tokens: scheme.tokens,
            }))
            existing.add(scheme.id)
          } catch {
            // One unusable scheme must not cost the other sixteen.
          }
        }
        registered = registered.concat(disposers)
      }

      /**
       * Apply the stored choice.
       *
       * @param payload - the Host's response.
       * @returns whether the stored scheme was unavailable, which the row reports: a
       *   scheme whose file was deleted would otherwise look like a lost setting.
       */
      function applyStoredPreference(payload) {
        // NOTHING STORED MEANS THE SHIPPED DEFAULT, NOT "LEAVE IT TO THE HARNESS".
        //
        // The CLI now resolves an unset `colorscheme` to `moss` — its own palette, and the
        // look this product ships. Letting the desktop fall through to the harness's
        // `system` would make the same product open in two different palettes depending on
        // which of its two front ends you started, which is exactly the kind of divergence
        // that reads as a bug rather than as a preference.
        //
        // It is applied as an INTENT rather than written to `qialike.json`: a user who never
        // chose a scheme has not chosen moss either, so the file stays untouched and the
        // moment they pick anything — including Light or Dark — that choice wins, because
        // `applyStoredPreference` is only reached when nothing is stored.
        //
        // A profile that already stored a scheme never gets here: `stored` is not null, and
        // this branch is skipped. So an upgrade changes nothing for anyone who had chosen.
        const stored = payload.preference ?? DEFAULT_SCHEME
        const scheme = payload.schemes.find((entry) => entry.name === stored)
        if (scheme === undefined) return stored !== payload.preference
        intent = { kind: 'scheme', name: scheme.name, id: scheme.id }
        ctx.theme.setTheme(scheme.id)
        // The settings scope has not necessarily delivered its value yet, and when it
        // does it overwrites this choice. See SETTLE_DELAYS.
        settle()
        return false
      }

      /**
       * Load (or reload) the scheme list, and report the outcome through the view
       * state the row renders from.
       *
       * The single implementation for both the initial load and the row's retry. It
       * takes a liveness check because the initial load outlives the effect that
       * starts it on a remount: registering after disposal would leave themes behind
       * that nothing can remove, and the row would then show a scheme list the
       * registry no longer matches.
       *
       * @param isLive - whether the caller is still mounted. Defaults to always.
       */
      function load(isLive = () => true) {
        setView({ loading: true, failed: false })
        void fetchThemes().then((payload) => {
          if (!isLive()) return
          registerSchemes(payload)
          const missing = applyStoredPreference(payload)
          // Paint from the choice just restored: the runtime's own event may never arrive
          // in a state this row agrees with. See `sync`.
          painter.refresh()
          setView({ loading: false, data: payload, missing })
        }, () => {
          if (!isLive()) return
          setView({ loading: false, failed: true })
        })
      }

      /**
       * Choose a scheme, or one of the harness's appearance preferences.
       *
       * @param value - a registered theme id, which is either a scheme id or `system`.
       */
      function choose(value) {
        const data = view.data
        const scheme = data === null ? undefined : data.schemes.find((entry) => entry.id === value)
        setView({ saving: true, saveFailed: false })
        if (scheme === undefined) {
          // An appearance preference: the runtime persists this itself, and clearing
          // the stored scheme is what returns it to being in charge.
          intent = { kind: 'builtin', id: value }
          ctx.theme.setTheme(value)
          void persist(null).then((ok) => { setView({ saving: false, saveFailed: !ok }) })
          return
        }
        intent = { kind: 'scheme', name: scheme.name, id: scheme.id }
        ctx.theme.setTheme(scheme.id)
        void persist(scheme.name).then((ok) => { setView({ saving: false, saveFailed: !ok }) })
      }

      /**
       * How long the restore keeps re-asserting after it runs, and why it must.
       *
       * MEASURED, NOT DEFENSIVE. Restoring the stored scheme happens inside the load that
       * fills the picker; the harness's settings scope then delivers its own value
       * (`system`, because a scheme id is not in its schema) and `adopt()` writes that
       * over ours and publishes. One `theme/change` arrives with our scheme active, the
       * next with the built-in — and whether the second lands before or after our
       * re-assertion is a race, which is why the same build showed the palette applied on
       * one launch and at `#151517` on the next.
       *
       * Re-asserting from the event alone cannot fix an ordering where the adoption is
       * the LAST thing that happens, so the restore also re-checks on a timer. The
       * delays cover the adoption arriving late; each check is a no-op unless the active
       * theme is not ours, so a settled window does nothing.
       */
      const SETTLE_DELAYS = [0, 50, 200, 600, 1500, 3000]

      /** Pending settle timers, cleared on teardown so a disposed row cannot resurrect. */
      let settleTimers = []

      /** Stop waiting for the runtime to settle. */
      function clearSettle() {
        for (const id of settleTimers) clearTimeout(id)
        settleTimers = []
      }

      /**
       * Re-assert the intent when the runtime drifts.
       *
       * WHAT IS COMPARED IS `active.id`, NOT `preference`. The two can disagree: the
       * runtime's preference is what the settings scope overwrites, while `active` is
       * what the presenter paints. Comparing the preference let a snapshot that carried
       * the built-in palette but our preference string pass as settled — which is the
       * one state that must not be accepted, because the row then shows `moss` selected
       * over a window painted in the defaults.
       *
       * Re-asserting is idempotent and guarded against an unregistered id, which throws,
       * because a remount can dispose the schemes between the two calls.
       *
       * @param snapshot - the runtime's state.
       */
      function onThemeChange(snapshot) {
        if (intent === null || intent.kind !== 'scheme') return
        if (snapshot.active?.id === intent.id) {
          // Settled, so nothing further is scheduled. The timers are left to expire on
          // their own; each is a cheap no-op from here.
          return
        }
        if (!snapshot.themes.some((theme) => theme.id === intent.id)) return
        ctx.theme.setTheme(intent.id)
      }

      /**
       * Wait for the runtime to settle on the stored scheme.
       *
       * Called once the stored preference has been applied. Each tick re-asserts only if
       * the active theme is not ours, so a window that settles immediately pays nothing.
       */
      function settle() {
        clearSettle()
        settleTimers = SETTLE_DELAYS.map((delay) => setTimeout(() => {
          if (intent === null || intent.kind !== 'scheme') return
          const snapshot = ctx.theme.getTheme()
          if (snapshot.active?.id !== intent.id
            && snapshot.themes.some((theme) => theme.id === intent.id)) {
            ctx.theme.setTheme(intent.id)
          }
          // REPAINT LAST, ALWAYS. The harness's presenter removes the token names it
          // wrote by NAME, not by ownership, so when it applies the built-in palette it
          // strips ours too — the values are identical, the names are identical, and it
          // has no way to tell them apart. Measured: this row set 116 tokens and `body`
          // still ended with zero. Repainting from a timer puts this row's write after any
          // synchronous work the emit triggered, which is the only ordering that survives
          // that bookkeeping.
          painter.refresh()
        }, delay))
      }

      ctx.effect(() => {
        const off = ctx.on('theme/change', onThemeChange)
        let live = true
        // The load is what fills the row. Without it the picker would sit on its
        // loading state forever while the themes registered behind it — a window whose
        // colours changed and whose settings row never offered a choice.
        load(() => live)
        return () => {
          live = false
          off()
          clearSettle()
          for (const dispose of registered) {
            try {
              dispose()
            } catch {
              // Best-effort during teardown.
            }
          }
          registered = []
          intent = null
          listeners.clear()
        }
      }, 'qialike-theme: scheme registration')

      /** Read the runtime state React renders from. */
      const useThemeSnapshot = () => {
        const [snapshot, setSnapshot] = React.useState(() => ctx.theme.getTheme())
        React.useEffect(() => {
          // Re-read rather than relying on the event alone: a change can land between
          // the initial render and this subscription.
          setSnapshot(ctx.theme.getTheme())
          return ctx.on('theme/change', (next) => { setSnapshot(next) })
        }, [])
        return snapshot
      }

      /** Render one `<option>` per scheme, grouped by where it came from. */
      function schemeOptions(data) {
        const builtin = data.builtin.map((id) => h('option', { key: 'b-' + id, value: id },
          id === 'system' ? t('system') : id === 'light' ? t('light') : t('dark')))
        const shipped = []
        const user = []
        for (const scheme of data.schemes) {
          const option = h('option', { key: scheme.id, value: scheme.id }, scheme.name)
          if (scheme.source === 'user') user.push(option)
          else shipped.push(option)
        }
        // Three groups because they answer different questions: which appearance
        // preference is in charge, which schemes this build ships, and which of the
        // user's own files were read. One flat list would bury the user's schemes
        // among fifteen shipped ones.
        const groups = [h('optgroup', { key: 'builtin', label: t('builtinGroup') }, builtin)]
        if (shipped.length > 0) groups.push(h('optgroup', { key: 'shipped', label: t('shippedGroup') }, shipped))
        if (user.length > 0) groups.push(h('optgroup', { key: 'user', label: t('userGroup') }, user))
        return groups
      }

      /**
       * The three appearance cubes, reimplemented here because the section owns them now.
       *
       * WHY THIS IS A COPY RATHER THAN THE UPSTREAM ROW. `ui-theme` registers an `appearance`
       * row into General and cannot be disabled — it is the plugin that PROVIDES the `theme`
       * service this whole bundle runs on. The slot contract's answer is to shadow that id
       * with a lower priority and draw the row here, which is what the section does. The cost
       * is honest and worth stating: this copy has to be kept in step with upstream by hand.
       *
       * WHAT IT DOES NOT REIMPLEMENT: the decision. `setTheme` and the persistence path are the
       * runtime's, exactly as the picker below uses them — this draws three buttons and calls
       * the same service.
       */
      function AppearanceCubes() {
        const snapshot = useThemeSnapshot()
        const active = snapshot?.preference
        // The keys are spelled out rather than looked up from a list: a translated key is a
        // string literal at its call site in this repository (the i18n test enforces it), so a
        // `t(value)` over an array would be a key the checker cannot see.
        const cube = (value, label) => h('button', {
          key: value,
          type: 'button',
          style: active === value ? styles.cubeOn : styles.cube,
          'aria-pressed': active === value,
          onClick: () => { choose(value) },
        }, label)
        return h('div', { style: styles.group },
          h('div', { style: styles.title }, t('appearanceTitle')),
          h('div', { style: styles.description }, t('appearanceDescription')),
          h('div', { style: styles.cubes },
            cube('system', t('system')),
            cube('light', t('light')),
            cube('dark', t('dark'))))
      }

      /**
       * The font-size rows, for the same reason and with one addition.
       *
       * Upstream shows the text size and hides the code and terminal sizes behind an
       * expander. Hiding that would LOSE two settings, so the expander is reimplemented too —
       * a "move it" that quietly removed controls would be a worse outcome than leaving the
       * row where it was.
       *
       * The bounds are the runtime's own: `setFontSize` throws outside them, so asking it to
       * clamp would report a range in the UI that the service does not honour. They are
       * restated here because the service does not publish them; a mismatch shows up as a
       * disabled button at the wrong end, not as a crash.
       */
      /** Each role's bounds, restated from the runtime's own spec because it does not publish them. */
      const FONT_ROLES = [
        { role: 'text', min: 10, max: 22 },
        { role: 'code', min: 10, max: 16 },
        { role: 'terminal', min: 10, max: 20 },
      ]

      function FontSizeRow({ role, title, description, min, max }) {
        const snapshot = useThemeSnapshot()
        const current = snapshot?.fontSizes?.[role]
        if (typeof current !== 'number') return null
        const step = (delta) => {
          const next = current + delta
          if (next < min || next > max) return
          try { ctx.theme.setFontSize(role, next) } catch { /* the service refused; the value stays */ }
        }
        return h('div', { style: styles.row },
          h('div', { style: styles.title }, title),
          h('div', { style: styles.description }, description),
          h('div', { style: styles.field },
            h('div', { style: styles.stepper },
              h('span', { style: styles.stepValue }, String(current)),
              h('span', { style: styles.description }, t('fontSizeUnit')),
              h('button', {
                type: 'button', style: styles.stepButton,
                'aria-label': t('fontSizeIncrease'), disabled: current >= max,
                onClick: () => { step(1) },
              }, '\u25b4'),
              h('button', {
                type: 'button', style: styles.stepButton,
                'aria-label': t('fontSizeDecrease'), disabled: current <= min,
                onClick: () => { step(-1) },
              }, '\u25be'))))
      }

      function FontSizeGroup() {
        const [open, setOpen] = React.useState(false)
        return h('div', { style: styles.group },
          h(FontSizeRow, {
            ...FONT_ROLES[0],
            title: t('fontSizeTitle'),
            description: t('fontSizeTextDescription'),
          }),
          h('button', {
            type: 'button', style: styles.expander, 'aria-expanded': open,
            onClick: () => { setOpen(!open) },
          }, open ? t('fontSizeMore') + ' \u25b4' : t('fontSizeMore') + ' \u25be'),
          open
            ? h('div', { style: styles.group },
              h(FontSizeRow, {
                ...FONT_ROLES[1],
                title: t('fontSizeCode'),
                description: t('fontSizeCodeDescription'),
              }),
              h(FontSizeRow, {
                ...FONT_ROLES[2],
                title: t('fontSizeTerminal'),
                description: t('fontSizeTerminalDescription'),
              }))
            : null)
      }

      /**
       * The Appearance section: the three rows that decide how the interface looks.
       *
       * ONE COLUMN BECAUSE THEY ARE ONE SUBJECT. These were rows inside General, interleaved
       * with permissions, language, session log and the version — a column that had grown to
       * thirteen rows answering unrelated questions. The picker is this bundle's own; the two
       * above it are copies of `ui-theme`'s rows, which the priority shadows in `apply` retire
       * from General.
       */
      function AppearanceSection() {
        return h('div', { style: styles.section },
          h('h2', { style: styles.heading }, t('sectionTitle')),
          h(AppearanceCubes),
          h(FontSizeGroup),
          h(ThemeRow))
      }

      /**
       * The row.
       *
       * Defined inside `apply` so it closes over the store, the actions and the theme
       * service, and therefore needs no props from the slot beyond the locale seat.
       */
      function ThemeRow() {
        const [state, setState] = React.useState(view)
        React.useEffect(() => {
          setState(view)
          return subscribe(() => { setState(view) })
        }, [])
        const snapshot = useThemeSnapshot()

        if (state.failed) {
          return h('div', { style: styles.row },
            h('div', { style: styles.title }, t('failed')),
            h('button', { type: 'button', onClick: load }, t('retry')))
        }
        if (state.loading || state.data === null) {
          return h('div', { style: styles.row }, h('div', { style: styles.description }, t('loading')))
        }

        const data = state.data
        const notes = []
        if (state.missing) notes.push(h('div', { key: 'missing', style: styles.note, role: 'status' }, t('missing')))
        if (state.saveFailed) {
          notes.push(h('div', { key: 'saveFailed', style: styles.alert, role: 'alert' }, t('saveFailed')))
        }
        if (Array.isArray(data.skipped) && data.skipped.length > 0) {
          // Surfaced because a user who wrote a scheme and cannot find it in the list
          // has no other way to learn that the file was the problem.
          notes.push(h('div', { key: 'skipped', style: styles.note, role: 'status' },
            t('skipped') + ': ' + data.skipped.map((entry) => entry.file + ' — ' + entry.reason).join('; ')))
        }
        if (typeof data.userDir === 'string') {
          notes.push(h('div', { key: 'dir', style: styles.note },
            t('userDir') + ' ', h('span', { style: styles.path }, data.userDir)))
        }

        // The `<label>` WRAPS the select rather than pointing at it with `htmlFor`: an
        // id would have to be unique in a document that our bundles and the harness
        // both contribute to, and a duplicated id silently binds the label to whichever
        // control won — a failure that reports as "clicking the text does nothing".
        return h('div', { style: styles.row },
          h('div', { style: styles.title }, t('title')),
          h('div', { style: styles.description }, t('description')),
          h('label', { style: styles.field },
            t('label'),
            h('select', {
              style: styles.select,
              value: snapshot.preference,
              onChange: (event) => { choose(event.target.value) },
            }, schemeOptions(data))),
          state.saving ? h('div', { style: styles.note }, t('saving')) : null,
          notes)
      }

      // ── the Appearance section ──────────────────────────────────────────────
      //
      // ONE COLUMN FOR ONE SUBJECT. Appearance, font size and the colour scheme answer the
      // same question — what this window looks like — and they used to be three rows scattered
      // through a General column of thirteen. Order 10 puts this between General (0) and the
      // plugins list.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'qialike-appearance',
        order: 10,
        // A thunk, so the nav row follows the language without re-registering.
        label: () => t('sectionTitle'),
        locale: NS,
      }, AppearanceSection))

      // ── retire `ui-theme`'s two rows from General ───────────────────────────
      //
      // They cannot be reached any other way: `ui-theme` PROVIDES the `theme` service every
      // part of this bundle runs on, so disabling the plugin would take the picker with it.
      // A list slot renders the entry with the LOWEST priority for a given id — the guard's
      // own message says "register at a different priority to shadow it (lowest renders)" —
      // so `-1` placeholders take the cells and draw nothing, and `AppearanceSection` draws
      // the rows instead. `appearance` is 10 and `font-size` is 11 upstream; the priority is
      // what wins the cell, and the order below only keeps the two placeholders sorting
      // predictably among themselves.
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'appearance',
        order: 10,
        priority: -1,
        locale: NS,
      }, () => null))
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'font-size',
        order: 11,
        priority: -1,
        locale: NS,
      }, () => null))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
