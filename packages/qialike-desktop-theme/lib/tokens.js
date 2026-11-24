/**
 * The mapping from the CLI's colour schemes to this surface's CSS tokens.
 *
 * TWO DIFFERENT THINGS ARE BEING RECONCILED. The CLI describes a scheme as 16
 * *semantic roles* — `bg`, `panel`, `element`, `borderSubtle`, `border`,
 * `borderActive`, `text`, `textMuted`, `primary`, `secondary`, `accent` and the
 * four states — because that is what an Ink surface needs to paint itself. This
 * surface names **104 `--dsw-alias-*` variables** instead: layers, borders by
 * level, label ranks, button families, interactive states, scrollbars, onboarding,
 * markdown and diff colours.
 *
 * The mapping is therefore *authored*, not derived, and this file is the whole of
 * it: one table, one review. It is a judgement about how a 16-role palette should
 * reach a 104-token surface, which is why it is hand-written and commented rather
 * than generated — there is no fact of the matter to extract.
 *
 * WHY BROAD RATHER THAN MINIMAL. A theme definition is applied as inline CSS
 * variables *over* the base palette, so any token left unmapped keeps the harness's
 * own colour. A mapping that covered only the documented handful would produce a
 * window whose shell is dracula and whose buttons, scrollbars and code blocks are
 * still DeepSeek — which reads as a rendering bug rather than as a theme.
 *
 * WHAT IS DELIBERATELY LEFT ALONE: four tokens, all of them surfaces the harness
 * paints dark *in every theme* and labels with a colour that never flips — the
 * tooltip family and the toast family. They are listed in `FIXED_DARK_SURFACES`
 * with the upstream declarations that establish the invariant. Mapping them onto
 * a 16-role palette is not a matter of taste but a legibility bug: the light
 * schemes make the surface near-white while the label stays white, and the
 * numbers are asserted in `tests/theme-legibility.test.mjs`.
 *
 * Beyond those four, every alias token with a plausible parent role is mapped.
 * Tokens whose role has no counterpart in 16 colours are assigned to the nearest
 * role by *kind* (a border token takes a border role, never a background one),
 * and each such choice carries a comment.
 *
 * @module qialike-desktop/themes/tokens
 */

/**
 * The CLI palette roles, and the tokens each one paints.
 *
 * Grouped by role kind. Within a group the assignment follows the CLI's own
 * semantic ladder: `bg` → `panel` → `element` is back-to-front, and
 * `borderSubtle` → `border` → `borderActive` is increasing emphasis.
 */
export const TOKEN_MAP = Object.freeze({
  /** The page itself, behind everything. */
  bg: [
    '--dsw-alias-bg-base',
  ],

  /**
   * Raised surfaces: cards, the sidebar, menus, tips.
   *
   * `bg-l1` joins `bg-layer-1` here: the two naming generations describe the same
   * rung of the same ladder, and grouping them differently would put two adjacent
   * surfaces on two different roles.
   *
   * `toast-bg` and `tooltip-bg` USED TO BE HERE, and removing them is the fix
   * recorded in `FIXED_DARK_SURFACES`: the harness paints both surfaces dark in
   * every theme and labels them with a fixed light colour, so recolouring the
   * surface alone inverts the pair in the two light schemes.
   */
  panel: [
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-l1',
    '--dsw-alias-bg-module-platform',
    '--dsw-alias-bg-document-preview',
    '--dsw-alias-settings-card-fill',
    '--dsw-alias-onboarding-card-fill',
    '--dsw-specific-sidebar-fill',
    '--dsw-specific-tip',
    // Raised fills the harness added in 0.2.2-rc.3: cards, their tiles, the menu group header and the illustration plate.
    '--dsw-alias-card-fill',
    '--dsw-alias-card-tile-fill',
    '--dsw-alias-menu-group-header-fill',
    '--dsw-alias-illustration-surface',
    '--dsw-alias-illustration-background',
  ],

  /**
   * Further-raised elements, overlays, and every neutral *fill*.
   *
   * THE FILLS ARE HERE RATHER THAN UNDER A STATE ROLE, and that is a correction
   * worth recording: hover and pressed fills are a change of *surface*, not a
   * change of *meaning*. Mapping them to `info` would have made every button,
   * toolbar and hovered row in the window drift toward the informational hue in all
   * sixteen schemes — a tint the palettes never asked for.
   *
   * `button-contrast-fill` takes `text` instead (below): its role is the
   * highest-contrast fill, which in a 16-role palette is the text colour read as a
   * surface.
   */
  element: [
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-layer-4',
    '--dsw-alias-bg-l2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-bg-skeleton',
    '--dsw-alias-bg-multi-select',
    '--dsw-alias-button-elevated-fill',
    '--dsw-alias-button-floating-fill',
    '--dsw-alias-button-floating-hover',
    '--dsw-alias-button-tool-bar-fill',
    '--dsw-alias-button-tool-bar-fill-invisible',
    '--dsw-alias-button-tool-bar-hover',
    '--dsw-alias-button-ghost-active-fill',
    '--dsw-alias-button-ghost-active-hover',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-interactive-bg-hover-solid',
    '--dsw-alias-onboarding-secondary-fill',
    '--dsw-alias-fill-l1',
    '--dsw-alias-fill-l2',
    '--dsw-alias-bg-mask-1',
    '--dsw-alias-bg-mask-2',
    '--dsw-alias-bg-mask-3',
    '--dsw-alias-bg-mask-drop',
    '--dsw-alias-bg-mask-photo',
    '--dsw-specific-bubble',
    '--dsw-specific-input-major',
    '--dsw-specific-login-input',
    '--dsw-specific-menu',
    '--dsw-specific-selector',
    // `--dsw-specific-sidebar-nav-item-hover` WAS HERE AND THE HARNESS RETIRED IT. It was declared
    // twice in 0.2.1-rc.2's `design-platform.css` and zero times in rc.3's, which turned the entry
    // into an assignment to a variable nothing declares — exactly the failure the token-mapping test
    // exists to catch, and it caught it. Dropping the line is the whole fix: the sidebar's hover state
    // now takes whatever the harness derives from `-active`, and painting it from our own scheme
    // would have been the "one surface stops following the theme" bug in reverse.
    // Inset fills: the turn trigger, the illustration recess, and the JSON tree hover band.
    '--dsw-alias-turn-trigger-bg',
    '--dsw-alias-illustration-inset',
    '--dsw-alias-illustration-backing',
    '--dsw-alias-json-tree-hover',
    // The hover half of the turn trigger and of a card: same rung, one step lit.
    '--dsw-alias-turn-trigger-bg-hover',
    '--dsw-alias-card-fill-hover',
  ],

  /**
   * Hairlines, the quietest borders, and hairline-weight fills.
   *
   * The scrollbar tracks are grouped here: a track is a background, but at border
   * weight it is the least conspicuous way to make a scrollbar follow the scheme,
   * and using `panel` would put a raised surface where a hairline belongs.
   */
  borderSubtle: [
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2-darkmode-thin',
    '--dsw-alias-settings-card-stroke',
    '--dsw-alias-scrollbar-bg-l1',
    '--dsw-alias-scrollbar-bg-l2',
    '--dsw-alias-fill-tsp-secondary',
    // The illustration shadow reads as a soft edge, not as a surface.
    '--dsw-alias-illustration-shadow',
  ],

  /** Ordinary borders, separators, and the hover weight of a scrollbar. */
  border: [
    '--dsw-alias-border-l2',
    '--dsw-alias-border-l3',
    '--dsw-alias-separator-primary',
    '--dsw-alias-button-ghost-active-border',
    '--dsw-alias-onboarding-checkbox-border',
    '--dsw-alias-scrollbar-hover-l1',
    '--dsw-alias-scrollbar-hover-l2',
    // "Inverted" borders are drawn on top of an inverted surface, so the role that
    // matches them by *kind* is an ordinary border rather than an emphasised one:
    // they are not more important than the border they sit beside, only drawn
    // against a different background.
    '--dsw-alias-border-inverted',
    '--dsw-alias-border-inverted2',
    // The selected border and the switch thumb: both are edges of emphasis rather than fills.
    '--dsw-alias-border-selected',
    '--dsw-alias-switch-thumb',
  ],

  /**
   * The most emphatic border and the two "this one is active" fills: focus,
   * selection, the current sidebar item, a dragged-over target.
   *
   * `interactive-bg-active` and `sidebar-nav-item-active` are fills, but their role
   * is the statement `borderActive` makes, and in every scheme the active fill is a
   * low-contrast tint of the active border rather than a surface colour — so the
   * emphasis ladder is preserved.
   */
  borderActive: [
    '--dsw-alias-border-l4',
    '--dsw-alias-interactive-bg-active',
    '--dsw-specific-sidebar-nav-item-active',
  ],

  /**
   * Primary text: the default reading colour, plus the label that sits on the
   * contrast fill.
   *
   * `button-contrast-fill` is here because the 16-role palette has no "contrast"
   * role and the text colour is the one that already means "the opposite of the
   * background" — which is what a contrast fill is.
   *
   * `toast-label` WAS here and is not any more: it is the label of a surface that
   * is dark in every theme, so it must stay white rather than follow the scheme's
   * ink. See `FIXED_DARK_SURFACES`.
   */
  text: [
    '--dsw-alias-label-primary',
    '--dsw-alias-label-primary-foreground',
    '--dsw-alias-label-primary-inverted',
    '--dsw-alias-label-document-preview',
    '--dsw-alias-markdown-tag',
    '--dsw-alias-button-contrast-fill',
    // The shimmer is a translucent ink drawn over the page, so it follows the text role. The four
    // labels that USED to sit here were moved to FIXED_DARK_SURFACES: they are painted on surfaces
    // the harness pins dark, and following the text role put dark ink on a dark card in the two
    // light schemes — measurably illegible, and the e2e legibility check caught it.
    '--dsw-alias-label-shimmer',
    // The document selection tint and the "deep diving" label pair, both expressed as ink over the page.
    '--dsw-alias-bg-document-selection',
    '--dsw-alias-label-deep-diving',
    '--dsw-alias-label-deep-diving-shimmer',
  ],

  /**
   * Secondary and tertiary text, icons, placeholders.
   *
   * `label-primary-bluish` is a *primary* rank with a hue; it is grouped here
   * because the schemes that define it use their muted role for it, and placing it
   * with `text` would give one label rank two sources.
   */
  textMuted: [
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-label-quaternary',
    '--dsw-alias-label-caption',
    '--dsw-alias-label-dimmed',
    '--dsw-alias-label-primary-dimmed',
    '--dsw-alias-label-primary-bluish',
    '--dsw-alias-menu-icon',
    '--dsw-alias-markdown-placeholder',
  ],

  /** The brand: links, primary buttons, the accent a scheme is known by. */
  primary: [
    '--dsw-alias-brand-primary',
    '--dsw-alias-brand-primary-invert',
    '--dsw-alias-brand-primary-new-colorprimary-new-color',
    '--dsw-alias-brand-text',
    '--dsw-alias-link',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-button-primary-hover',
    '--dsw-alias-button-primary-dimmed',
    '--dsw-alias-onboarding-accent',
    '--dsw-alias-interactive-bg-hover-accent',
    '--dsw-specific-sidebar-nav-item-active-accent',
    // The primary action's fill and the "done" state, which the harness paints in its primary hue.
    '--dsw-alias-button',
    '--dsw-alias-state-done-primary',
    '--dsw-alias-hovercard-state-done',
  ],

  /**
   * The scheme's second hue.
   *
   * `state-business-primary` is the harness's "neutral informational" state — the
   * one state with no success/warning/error meaning — which is what a second accent
   * is for. `markdown-citation` takes the same role.
   */
  secondary: [
    '--dsw-alias-state-business-primary',
  ],

  /**
   * The scheme's third hue, used for code chrome.
   *
   * The code-block and inline-code fills are `element`-like, but the CLI's palette
   * carries a dedicated `element` role that already paints the raised surfaces; the
   * code fills are grouped with `accent` because every scheme in the set tints them
   * toward its accent rather than toward its neutral surface.
   */
  accent: [
    // Syntax and trajectory colours: the scheme's third hue, which is what code chrome has always used here.
    '--dsw-alias-trajectory-accent',
    '--dsw-alias-illustration-detail',
    '--dsw-alias-json-tree-property',
    '--dsw-alias-json-tree-string',
    '--dsw-alias-json-tree-number',
    '--dsw-alias-json-tree-keyword',
    '--dsw-alias-json-tree-punctuation',
    '--dsw-alias-json-tree-icon',
  ],

  /** Success: the state, and the added side of every diff. */
  success: [
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-success-secondary',
    '--dsw-alias-file-diff-added-marker',
  ],

  /**
   * Warning.
   *
   * ONE SPELLING, and the second one was removed by upstream in 0.2.0-rc.2. `--dsw-alias-state-warn-*`
   * is the family the stylesheets define. `--dsw-alias-state-warning-primary` was never defined by the
   * harness at all — upstream's own architecture note calls it "the nonexistent
   * `--dsw-alias-state-warning-primary` alias" — but two of its stylesheets *read* it with a fallback
   * to `state-business-primary` (`var(--dsw-alias-state-warning-primary, …)`), so setting it replaced
   * that fallback with the scheme's real warning colour. 0.2.0-rc.2 cleaned both call sites up, so the
   * token now has no reader and setting it only invites the next reader to think it is part of the
   * contract.
   *
   * The whole family takes `warning`, including the *label*: see the `yellow` entry
   * below for why the label is not given to the one role that sometimes differs.
   */
  warning: [
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-state-warn-secondary',
    '--dsw-alias-state-warn-label',
    // The hovercard's error mark keeps the warning role: it is an alert accent, not a filled danger surface.
    '--dsw-alias-hovercard-state-error',
  ],

  /**
   * The CLI's `yellow` — deliberately mapped to nothing.
   *
   * IT IS A DISTINCT ROLE, and that is worth stating because the obvious assumption
   * is wrong: `warning` and `yellow` are the same hex in 8 of the 15 schemes and
   * differ in the other 7 (gruvbox `warning=#fe8019` against `yellow=#d3869b`,
   * everforest `#e69875` against `#dbbc7f`).
   *
   * So why map it nowhere? Because this surface has no token that means "the
   * scheme's second emphasis colour" — all five warn-family tokens are already
   * claimed — and the one candidate, `state-warn-label`, is the warn family's *text*
   * colour. Giving it to `yellow` would make the warn text disagree with the warn
   * fills in those 7 schemes: a pink warning label above an orange warning banner.
   * Leaving the role unmapped keeps each semantic family coherent, and costs nothing
   * observable, because there is no surface here that paints the CLI's `yellow` in
   * the first place.
   *
   * The empty list is kept rather than the key being deleted: it records that the
   * role was considered and answered, which is the difference between a decision and
   * an oversight.
   */
  yellow: [],

  /** Error: the state as fill and as text, the danger hover, and every deletion. */
  error: [
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-error-secondary',
    '--dsw-alias-label-error',
    '--dsw-alias-file-diff-deleted-marker',
    '--dsw-alias-interactive-bg-hover-danger',
  ],

  /**
   * Informational — and now nothing else.
   *
   * The neutral fills that used to sit here moved to `element`; what remains is the
   * idle state and the two buttons that are explicitly informational.
   */
  info: [
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-button-info-fill',
    '--dsw-alias-button-info-hover',
    // The three chart series: informational marks rather than state.
    '--dsw-alias-chart-system',
    '--dsw-alias-chart-tools',
    '--dsw-alias-chart-messages',
  ],
})

/**
 * Tokens that are a TINT of a role rather than the role's ink.
 *
 * WHY THIS EXISTS, AND THE DEFECT IT FIXES. Every token in {@link TOKEN_MAP} receives the
 * role's own colour, which is right for ink — labels, borders, glyphs. But this harness
 * also ships a family of tokens that are *surfaces*: the background of an inline code span,
 * a code block and its banner, the "+" side of a diff, the soft `state-*-tertiary` washes,
 * a citation chip, a highlighted bubble. Upstream paints those with a pale or dark tint and
 * puts ordinary label ink on top — its own dark values make that plain
 * (`file-diff-added-bg: rgb(31, 49, 36)` is green mixed into the background, not green).
 *
 * Handing them the saturated role instead produced a window whose inline code was a
 * mid-brightness teal block behind warm-white text: **1.86:1**, reported as "some characters
 * have a light blue box under them and the white text is hard to read". Every member of this
 * family had the same defect (success 1.80:1, warning 1.66:1); only the one the user happened
 * to look at was reported.
 *
 * So they are derived instead: {@link tintOf} mixes the role colour into the palette's own
 * background. That is palette-agnostic by construction — a light scheme mixes toward its
 * pale background and gets a pale tint, a dark scheme gets a dark one, and both keep the
 * hue that makes "added" green and "deleted" red.
 */
export const TINT_MAP = Object.freeze({
  primary: [
    // `button-primary-dimmed` is NOT here: it is the disabled state of a primary button, and
    // the ink on it is `label-primary-foreground` — a saturated fill is correct for it, the way
    // it is for `button-primary-fill`. Tinting it made three schemes' own text fail a 4.5:1
    // check against `label-primary`, which is not the ink that lands there.
    '--dsw-specific-bubble-highlight',
  ],
  secondary: [
    '--dsw-alias-state-business-tertiary',
    '--dsw-alias-markdown-citation',
  ],
  accent: [
    '--dsw-alias-markdown-inline-code',
    '--dsw-alias-markdown-code-block',
    '--dsw-alias-markdown-code-block-banner',
    '--dsw-alias-markdown-code-segment-selected',
    '--dsw-alias-markdown-code-segment-unselected',
  ],
  success: [
    '--dsw-alias-state-success-tertiary',
    '--dsw-alias-code-diff-added',
    '--dsw-alias-file-diff-added-bg',
    '--dsw-alias-file-diff-added-gutter',
  ],
  warning: ['--dsw-alias-state-warn-tertiary'],
  error: [
    '--dsw-alias-code-diff-deleted',
    '--dsw-alias-file-diff-deleted-bg',
    '--dsw-alias-file-diff-deleted-gutter',
  ],
})

/**
 * The most of the role colour a tint may carry.
 *
 * 0.20 is measured against both ends: the resulting surface keeps **10.65:1** against moss's
 * label ink (the saturated value was 1.86:1), and still separates from the background by
 * 1.40:1, so a code span is visible as a span. Upstream's own `file-diff-added-bg` sits in
 * the same band. Lower loses the box; higher starts pulling the surface toward the ink it
 * has to carry.
 *
 * IT IS A CEILING, NOT THE VALUE. A scheme whose own body text is already dim —
 * `solarized-light`'s is 4.13:1 against its own background — cannot carry a surface that
 * dark at this ratio without falling under the text it has to hold, and demanding otherwise
 * would be asking the tint to beat the scheme. {@link tintFor} therefore walks down from
 * here until the palette's ink is readable on the result, keeping as much hue as that allows.
 */
export const TINT_RATIO = 0.20

/**
 * The contrast a tint must leave for the ink it carries.
 *
 * 4.0 rather than 4.5 because the floor has to be reachable by the dimmest shipped scheme:
 * `solarized-light` puts its own body text at 4.13:1 against its own background, so a bar of
 * 4.5 would fail every tint in it no matter what this file did. This is the same "parity is
 * the honest bar" reasoning the legibility suite records for the tooltip.
 */
export const TINT_MIN_CONTRAST = 4.0

/**
 * The tokens this mapping must never set, and why.
 *
 * THE INVARIANT IS THE HARNESS'S, NOT OURS, AND IT IS WRITTEN IN ITS SOURCES. The
 * tooltip and the toast are painted dark in **every** theme — including the
 * harness's own light theme — and labelled with a colour that is *also* fixed:
 * `--dsw-static-neutral-bluish-00` (white) for the tooltip, and the toast label
 * plus its action link likewise.
 *
 *   · `ui-primitives/src/Tooltip.module.css` — `background:
 *     var(--dsw-alias-tooltip-bg); color: var(--dsw-static-neutral-bluish-00)`.
 *     The surface is an alias (dark in both themes: bluish-850 light / bluish-750
 *     dark), the label is a static white that never flips.
 *   · `ui-primitives/src/Toast.module.css` — "The design platform's toast surface
 *     is dark in BOTH themes (bluish-800 light / bluish-750 dark), so the label
 *     and the action text below stay fixed instead of flipping with the theme."
 *   · `ui-primitives/src/ShortcutKeys.module.css` — the keycaps inside a tooltip
 *     read `--dsw-alias-tooltip-key-bg`, which `ui-theme` derives *from* the
 *     tooltip surface (`color-mix(… , white 18%)`); their glyph inherits the
 *     tooltip's white.
 *
 * A 16-role palette has one light rung, and the schemes call it `panel`. Mapping
 * the surface to it painted the tooltip near-white in `light` (#f0f0f0) and
 * `solarized-light` (#eee8d5) while the label stayed white: **1.14:1 and 1.23:1**,
 * i.e. an invisible tooltip in exactly the two schemes a light-theme user picks.
 * Unmapping restores the harness's own pair — 13.94:1 in its light theme, 9.59:1 in
 * its dark one, and 12.10:1 / 9.59:1 for the toast — which keeps working in all
 * sixteen schemes, because it no longer depends on them.
 *
 * WHY NOT REPAIR THE LABEL INSTEAD. Because the label is `--dsw-static-*`: that
 * ramp is shared by the whole interface, is not ours to redefine, and a tooltip
 * that follows a light scheme is a different product decision — a light tooltip
 * needs a dark label, a border and a shadow the surface does not have. The harness
 * has already made that decision twice, deliberately.
 *
 * The mapping is not merely absent — it is *asserted* absent, from these
 * declarations, in `tests/theme-legibility.test.mjs`. If upstream ever tokenises
 * the labels, that test fails and says so, which is the point at which these four
 * tokens become mappable.
 */
export const FIXED_DARK_SURFACES = Object.freeze([
  {
    token: '--dsw-alias-tooltip-bg',
    label: 'var(--dsw-static-neutral-bluish-00)',
    labelHex: '#ffffff',
    source: 'packages/client/ui-primitives/src/Tooltip.module.css',
    why: 'the surface is an alias, but its label is the static white declared on the next line',
  },
  {
    token: '--dsw-alias-tooltip-key-bg',
    label: 'var(--dsw-static-neutral-bluish-00)',
    labelHex: '#ffffff',
    source: 'packages/client/ui-primitives/src/ShortcutKeys.module.css',
    why: 'derived from the tooltip surface by ui-theme; the cap glyph inherits the tooltip label',
  },
  {
    token: '--dsw-alias-toast-bg',
    label: 'var(--dsw-alias-toast-label)',
    labelHex: '#ffffff',
    source: 'packages/client/ui-primitives/src/Toast.module.css',
    why: 'the toast surface is dark in both themes by design — see its own comment',
  },
  {
    token: '--dsw-alias-toast-label',
    label: 'var(--dsw-static-neutral-bluish-00)',
    labelHex: '#ffffff',
    source: 'packages/client/ui-primitives/src/Toast.module.css',
    why: 'fixed together with the surface, so that the pair never inverts',
  },
  // THE HOVERCARD FAMILY JOINS THE SAME INVARIANT IN HARNESS 0.2.2-rc.3, and for the same reason:
  // every member is declared against a STATIC colour rather than an alias, so recolouring the surface
  // without its labels would invert the pair in the two light schemes — a near-white card carrying
  // near-white text. Measured in `packages/client/ui-theme/src/styles/design-platform.css`:
  //
  //   hovercard-bg              var(--dsw-static-neutral-bluish-850)
  //   hovercard-label-primary   var(--dsw-static-neutral-bluish-00)      (#ffffff)
  //   hovercard-label-secondary var(--dsw-static-neutral-bluish-300)
  //   hovercard-label-tertiary  var(--dsw-static-neutral-bluish-400)
  //
  // `state-done` and `state-error` are left OUT: they are accent marks on a fixed surface rather than
  // the surface's own text, and pinning them would stop a theme from ever tinting its state colours.
  {
    token: '--dsw-alias-hovercard-bg',
    label: 'var(--dsw-alias-hovercard-label-primary)',
    labelHex: '#ffffff',
    source: 'packages/client/ui-theme/src/styles/design-platform.css',
    why: 'declared against a static dark blue; its primary label is static white',
  },
  {
    token: '--dsw-alias-tooltip-label',
    label: 'var(--dsw-static-neutral-bluish-00)',
    labelHex: '#ffffff',
    source: 'packages/client/ui-theme/src/styles/design-platform.css',
    why: 'tokenised in 0.2.2-rc.3, but still declared as the static white the tooltip was written against',
  },
  {
    token: '--dsw-alias-label-on-color',
    label: 'var(--dsw-static-neutral-bluish-00)',
    labelHex: '#ffffff',
    source: 'packages/client/ui-theme/src/styles/design-platform.css',
    why: 'ink drawn on a colour fill (the send button is the one that shows); the harness keeps it white in both themes',
  },
  {
    token: '--dsw-alias-hovercard-label-secondary',
    label: 'var(--dsw-static-neutral-bluish-300)',
    labelHex: '#b0b3b8',
    source: 'packages/client/ui-theme/src/styles/design-platform.css',
    why: 'secondary text on the fixed dark hover card; the contrast is asserted in theme-legibility.test.mjs',
  },
  {
    token: '--dsw-alias-hovercard-label-tertiary',
    label: 'var(--dsw-static-neutral-bluish-400)',
    labelHex: '#8b8f96',
    source: 'packages/client/ui-theme/src/styles/design-platform.css',
    why: 'tertiary text on the fixed dark hover card; same pair, same reason',
  },
  {
    token: '--dsw-alias-hovercard-label-primary',
    label: 'var(--dsw-static-neutral-bluish-00)',
    labelHex: '#ffffff',
    source: 'packages/client/ui-theme/src/styles/design-platform.css',
    why: 'fixed white on the fixed dark card — pinned so the pair cannot invert',
  },
])

/** The prefix every id this product registers carries. */
export const THEME_ID_PREFIX = 'qialike-'

/**
 * The id a scheme is registered under.
 *
 * PREFIXED, AND THAT IS LOAD-BEARING. The CLI's scheme set contains `light`, and
 * this surface already ships a built-in theme with that id —
 * `ThemeRuntime.register()` throws on a duplicate (`theme "light" is already
 * registered`), so registering under the scheme's own name would fail on the first
 * scheme and take the whole theme row down with it. The CLIs `dark` is the same
 * palette as the harness's built-in `dark`, which is the collision in its most
 * literal form.
 *
 * The *bare* name stays the scheme's identity in `qialike.json`, because that is
 * the value the CLI reads and writes. The two are deliberately different strings.
 *
 * @param schemeName - the scheme's name as the CLI knows it.
 * @returns the id to register under.
 */
export function themeIdFor(schemeName) {
  return `${THEME_ID_PREFIX}${schemeName}`
}

/**
 * A hex colour, in the four forms CSS accepts.
 *
 * THE SET IS THE CLI'S, deliberately. Its user-scheme loader validates with
 * `/^#[0-9a-fA-F]{3,8}$/`, so a `~/.dsh/themes/*.json` written for the terminal
 * client may legitimately carry a 4- or 8-digit value (the alpha forms). Accepting
 * only the two opaque forms would drop those roles from such a scheme on this
 * surface alone — the same file producing a complete palette in the CLI and a
 * partial one here, with nothing to indicate why.
 */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu

/**
 * Expand a hex colour to its long form, or return undefined when it is not one.
 *
 * Shorthand is expanded so every value reaching a CSS variable has one shape, which
 * is what lets the token-mapping tests assert a form rather than a set of forms.
 *
 * Hex only. A palette written as `rgb(...)` or a named colour is rejected rather
 * than passed through: the value would be written into a CSS variable that the
 * browser may then ignore, producing a silently unstyled surface instead of a
 * visible failure.
 *
 * @param value - the colour string.
 * @returns the expanded colour, or undefined.
 */
export function normalizeHex(value) {
  if (typeof value !== 'string') return undefined
  const hex = value.trim().toLowerCase()
  if (!HEX.test(hex)) return undefined
  const digits = hex.slice(1)
  // `#abc` -> `#aabbcc`, `#abcd` -> `#aabbccdd`.
  return digits.length <= 4 ? `#${[...digits].map((digit) => digit + digit).join('')}` : hex
}

/**
 * Relative luminance of a colour, per WCAG 2.1.
 *
 * @param hex - a `#rrggbb` colour.
 * @returns luminance in `[0, 1]`.
 */
function luminance(hex) {
  const channel = (offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/**
 * Which base palette a scheme builds on, derived from its own background.
 *
 * DERIVED RATHER THAN DECLARED, because user schemes have nowhere to declare it:
 * `~/.dsh/themes/<name>.json` is documented as `{ name, palette }` and carries no
 * colour-scheme field. Deriving also means a user's light scheme gets the light
 * base for free, instead of inheriting whichever default we guessed.
 *
 * @param palette - the scheme's palette.
 * @returns `'light'` or `'dark'`.
 */
export function colorSchemeOf(palette) {
  const bg = normalizeHex(palette?.bg)
  if (bg === undefined) return 'dark'
  // The midpoint is a threshold on luminance, not on perceived lightness, so it
  // sits low: `#fafafa` (One Light) is 0.94 and `#282a36` (dracula) is 0.02, and
  // every scheme in the set is far from the boundary.
  return luminance(bg) > 0.5 ? 'light' : 'dark'
}

/**
 * Turn one palette into a harness `ThemeDefinition`.
 *
 * @param options.name - the scheme's CLI name; the id is derived from it.
 * @param options.palette - the 16-role palette.
 * @returns the definition, or undefined when the palette has no usable colours.
 *   Undefined rather than throwing because a malformed *user* scheme should cost
 *   that one scheme, not the whole list.
 */
export function toThemeDefinition({ name, palette }) {
  const tokens = {}
  let mapped = 0
  for (const [role, tokenNames] of Object.entries(TOKEN_MAP)) {
    const value = normalizeHex(palette?.[role])
    if (value === undefined) continue
    for (const token of tokenNames) {
      // A token claimed by two roles keeps the first role that supplied it, and the
      // table is ordered so that is the more specific one: `warning` sets the warn
      // family before `yellow` re-states it, and `yellow` is only reached when
      // `warning` was absent.
      if (tokens[token] === undefined) tokens[token] = value
    }
    mapped += 1
  }

  // Surfaces are derived, not copied: see TINT_MAP. Applied after the ink so a token can
  // never appear in both halves without the tint winning — which is the direction that
  // keeps text readable.
  for (const [role, tokenNames] of Object.entries(TINT_MAP)) {
    const tint = tintFor(normalizeHex(palette?.[role]), palette)
    if (tint === undefined) continue
    for (const token of tokenNames) tokens[token] = tint
  }

  // A palette that mapped nothing is not a theme; treating it as one would put an
  // entry in the picker that changes no colour when clicked.
  if (mapped === 0) return undefined
  return { id: themeIdFor(name), colorScheme: colorSchemeOf(palette), tokens, scheme: name }
}

/**
 * Mix a role colour into a background at a fixed ratio.
 *
 * A plain per-channel blend in sRGB, which is what upstream's own tints are.
 *
 * @param role - the role's colour, or undefined when the palette omits it.
 * @param background - the palette's `bg`, already normalized.
 * @param ratio - how much of the role to keep; defaults to {@link TINT_RATIO}.
 * @returns the tint as `#rrggbb`, or undefined when either input is unusable.
 */
export function tintOf(role, background, ratio = TINT_RATIO) {
  if (role === undefined || background === undefined) return undefined
  const channel = (hex, index) => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)
  const mixed = [0, 1, 2].map((index) => Math.round(channel(role, index) * ratio + channel(background, index) * (1 - ratio)))
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The tint to use for one role in one palette: as much hue as its ink allows.
 *
 * Walks down from {@link TINT_RATIO} until the palette's own text colour reaches
 * {@link TINT_MIN_CONTRAST} on the result. Most schemes stop at the first step, because
 * 0.20 already leaves their text ten to twelve to one; the dim ones — solarized and its light
 * twin — trade hue for readability, which is the right way round: an unreadable code span has
 * no design value, while a slightly flatter one is merely quiet.
 *
 * @param role - the role's colour.
 * @param palette - the palette supplying `bg` and `text`.
 * @returns the tint, or undefined when the palette cannot express one.
 */
export function tintFor(role, palette) {
  const background = normalizeHex(palette?.bg)
  const ink = normalizeHex(palette?.text)
  const at = normalizeHex(role)
  if (background === undefined || at === undefined) return undefined
  // No ink to protect: the ceiling is the answer.
  if (ink === undefined) return tintOf(at, background)
  for (let step = 0; step <= 9; step += 1) {
    const ratio = Number((TINT_RATIO - step * 0.02).toFixed(2))
    if (ratio <= 0) break
    const candidate = tintOf(at, background, ratio)
    if (contrastRatio(ink, candidate) >= TINT_MIN_CONTRAST) return candidate
  }
  // Even the faintest tint cannot hold this ink; return the faintest, so the surface still
  // reads as one rather than disappearing.
  return tintOf(at, background, 0.02)
}

/**
 * Every token name this mapping can set.
 *
 * Exported for the tests and for the build's coverage check: the table is the
 * product's claim about which parts of the window follow a scheme, and a typo in a
 * token name would otherwise be an assignment to a CSS variable nothing reads —
 * invisible, and the exact failure a theme feature is hardest to notice.
 *
 * @returns the token names, de-duplicated and sorted.
 */
export function mappedTokens() {
  return [...new Set([...Object.values(TOKEN_MAP).flat(), ...Object.values(TINT_MAP).flat()])].sort()
}

/**
 * The WCAG 2.1 contrast ratio between two opaque hex colours.
 *
 * The point of having it in the library rather than in one test: exactly one
 * implementation of "is this pair readable" is used by the unit test, by the
 * legibility probe that runs against a real window, and by anyone auditing a
 * scheme by hand. Two implementations would let the number in the test and the
 * number in the report disagree, which is worse than either alone.
 *
 * @param a - a hex colour.
 * @param b - a hex colour.
 * @returns the ratio, from 1 (identical) to 21 (black on white).
 * @throws when either argument is not a hex colour — a silent 1 would read as
 *   "unreadable" and a silent NaN as "fine", and both are the wrong answer.
 */
export function contrastRatio(a, b) {
  const left = normalizeHex(a)
  const right = normalizeHex(b)
  if (left === undefined || right === undefined) {
    throw new TypeError(`contrastRatio needs two hex colours, got ${String(a)} and ${String(b)}`)
  }
  // The alpha forms are accepted by the palette loader; comparing them as if they
  // were opaque would overstate the contrast of a half-transparent colour, so drop
  // the alpha channel rather than pretend to model compositing.
  const light = luminance(left.slice(0, 7))
  const dark = luminance(right.slice(0, 7))
  const [high, low] = light > dark ? [light, dark] : [dark, light]
  return (high + 0.05) / (low + 0.05)
}
