/**
 * qialike's branding for the browser surface — the sidebar mark and wordmark,
 * and the conversation hero mark.
 *
 * Hand-written, like the settings page in `@qialike/qialike-desktop-providers`
 * and for the same reason: the harness's client-bundle preset is unpublished, and
 * the artifact contract it targets is small enough to write directly. See that
 * package's `lib/client.js` for the full rationale.
 *
 * THE MARK IS A BEE, the wordmark still spells `qialike`, and the two are no longer
 * the same drawing: the mark is the vendored artwork in `apps/desktop-web/public/brand/qialike-bee.svg`,
 * which is also what the favicons and the launcher icon are derived from. See the
 * `square mark` section below for why that property was given up.
 *
 * WHY THE WORDMARK IS INLINE RATHER THAN FETCHED. The source of truth is
 * `apps/desktop-web/public/brand/qialike-wordmark-{light,dark}.svg`, which the
 * build copies into the repository. Serving that file to the browser would need
 * the shell's static whitelist to grow a `/brand/` entry — the whitelist covers
 * `/`, the favicons, the manifest and `/assets/`, and nothing else — so the
 * wordmark would come back 404 through the Host proxy. Inlining it instead costs
 * ~2 KB in a bundle that is already fetched, and removes a request. The favicons
 * and the manifest stay files, because the browser fetches those by URL outside
 * the plugin system.
 *
 * WHY ONE SVG AND NOT TWO VARIANTS. The light and dark wordmarks differ **only**
 * in palette: three paths in one tone, four in the other. Those two groups are
 * what the `INK` and `TONE` constants below fill, so one copy of the geometry
 * serves both. This used to be done with theme tokens, which also served any
 * theme a user installs; it is now done with two literals of the brand blue, and
 * the section below says why that property was given up. The static favicons have
 * always been two files, because a favicon is its own document with no access to
 * the page's variables.
 *
 * @module @qialike/qialike-desktop-brand/client
 */

window.__ModuleLoader__.load({
  id: '@qialike/qialike-desktop-brand',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** The brand name. Not a locale string: a brand name does not translate. */
    const BRAND = 'qialike'

    // ── the colour: DeepSeek's brand blue ────────────────────────────────────
    //
    // THE MARK AND THE WORDMARK USED TO FOLLOW THE THEME — `--dsw-alias-label-primary`
    // and `-secondary` — which made them adapt to all sixteen schemes and to any
    // theme a user installs. That was a real property and it is deliberately given
    // up, because a brand colour is the opposite kind of thing: it has to be the
    // same blue on a light scheme, a dark scheme and a user's own theme, or it is
    // not a brand colour. So these are literals now, and nothing here is a token.
    //
    // #4d6bfe is DeepSeek's own, not a blue chosen by eye: it is what
    // `deepseek-harness/website/public/favicon.svg` fills its whale with, and the
    // value `--dsw-alias-brand-primary` declares as its own fallback.
    //
    // MEASURED ON BOTH BACKGROUNDS BEFORE COMMITTING TO ONE LITERAL, because a fixed
    // colour has to survive light and dark alike: 4.33:1 on white, 4.49:1 on this
    // application's own dark background (#0d0d0e, sampled from a screenshot). WCAG
    // exempts logotypes from the text-contrast floor and the mark is one, but the
    // number is worth having rather than leaning on the exemption.
    //
    // THE WORDMARK KEEPS ITS TWO TONES, now two blues: `qia` in the lighter step and
    // `like` in the brand blue. Worth knowing which half now reads first, because it
    // is not the half that did: a lighter colour is more prominent on a dark
    // background, so on the dark default `qia` leads where the old grey/near-white
    // pair made `like` lead. On a light background the order matches the old one.
    // The lighter step is `--dsw-static-deepseek-400`, a colour of DeepSeek's own
    // ramp rather than an invented tint.
    //
    // THE COPIES ARE ASSERTED. `apps/desktop-bin/lib/brand-colours.mjs` is the single
    // source for the two blues — the mark's own colours now come from its artwork, which
    // carries them itself — and this bundle cannot import that module, so
    // `tests/brand-assets.test.mjs` compares the two.
    const INK = '#4d6bfe'
    const TONE = '#7aaaff'

    // ── the wordmark ─────────────────────────────────────────────────────────
    //
    // Geometry copied verbatim from `brand/qialike-wordmark-light.svg`, split by
    // the tone its `fill` named. The dark variant carries identical geometry with
    // different fills, which is what makes the split into tokens possible.

    /** The secondary-tone glyphs: `q`, the first `i`, `a`. */
    const WORDMARK_TONE = [
      ['path', { key: 'q', fillRule: 'evenodd', d: 'm 0,6 v 30 h 18 v 6 h 6 V 36 6 Z m 6,6 H 18 V 30 H 6 Z' }],
      ['rect', { key: 'i', x: 30, y: 6, width: 6, height: 30 }],
      ['path', { key: 'a', fillRule: 'evenodd', d: 'm 48,6 v 6 h 6 6 v 6 h -6 -6 -6 v 6 6 6 h 6 6 6 6 V 30 24 18 12 6 h -6 -6 z m 0,18 h 6 6 v 6 h -6 -6 z' }],
    ]

    /** The ink-tone glyphs: `l`, the second `i`, `k`, `e`. */
    const WORDMARK_INK = [
      ['path', { key: 'l', d: 'm 72,6 v 24 6 h 6 18 V 30 H 78 V 6 Z' }],
      ['rect', { key: 'i2', x: 102, y: 6, width: 6, height: 30 }],
      ['path', {
        key: 'k',
        d: 'M114,6h6v6h-6z M132,6h6v6h-6z M114,12h6v6h-6z M126,12h6v6h-6z M114,18h12v6h-12z'
          + ' M114,24h6v6h-6z M126,24h6v6h-6z M114,30h6v6h-6z M132,30h6v6h-6z',
      }],
      ['path', { key: 'e', fillRule: 'evenodd', d: 'm 144,6 v 6 6 6 6 6 h 6 6 6 6 v -6 h -6 -6 -6 v -6 h 6 6 6 V 18 12 6 h -6 -6 -6 z m 6,6 h 6 6 v 6 h -6 -6 z' }],
    ]

    /** The wordmark's own viewBox; its aspect is 4:1. */
    const WORDMARK_VIEWBOX = '0 0 168 42'
    const WORDMARK_RATIO = 168 / 42

    /** Render a list of `[tag, props]` glyph rows. */
    function glyphs(rows, fill) {
      return rows.map(([tag, props]) => h(tag, { ...props, fill }))
    }

    // ── the square mark ──────────────────────────────────────────────────────
    //
    // A bee: the vendored artwork, inserted as it is. The single source is
    // `apps/desktop-web/public/brand/qialike-bee.svg` — the same file the two favicons and the
    // launcher's `icon.png` are derived from, through `apps/desktop-bin/brand-assets.mjs`. This bundle
    // cannot import it: the bundle is hand-written and inlined into the served document.
    //
    // WHY IT IS INSERTED RATHER THAN TRANSCRIBED. The wordmark above is written out as `[tag, props]`
    // rows, and that works because it is six paths. This drawing is ninety-odd elements name-referencing
    // ten gradients and fourteen filters; a transcription of that would be a second source of the
    // drawing, and the one thing this copy must not be is a paraphrase of it.
    // `tests/brand-assets.test.mjs` compares this string against the artwork, so an edit to either side
    // alone fails the build rather than shipping two different logos.
    //
    // THE PLATE IS REMOVED FOR THESE TWO SEATS, AND ONLY THESE. The artwork paints a dark rounded plate
    // behind the bee — right for an application icon, which has to supply its own background, and wrong
    // here: these seats sit on a surface the theme already paints, so a fixed dark plate is a dark chip
    // that stays dark on a light scheme. Removing it lets the seat's own background show through, which
    // is what "the background follows the theme" means when the theme is what draws the background.
    //
    // `icon.png` and the two favicons keep the plate; they go through `brand-assets.mjs`, not this file.
    // The removal is a transform on the verbatim markup rather than an edited copy, so the string above
    // stays comparable to the artwork byte for byte and this difference is a thing to read and test.
    //
    // WHAT GOES, AND WHY EACH IS PART OF THE PLATE: the rounded square and its hairline border, the faint
    // grid drawn inside it, and the shadow it casts — that last one would otherwise float under the bee
    // on the seat's own background, with nothing casting it. The plate's own gradient definition stays in
    // `<defs>`: nothing references it once the rect is gone, and leaving it keeps this transform to the
    // elements that are actually painted.
    //
    // WHAT THIS COSTS, MEASURED: the bee occupies 64% of the canvas width and 85% of its height (the
    // artwork's plate is what filled the rest), and its centre sits 5% above the canvas centre. Both show
    // up as a slightly smaller, slightly high mark in the seat. Tightening `MARK_VIEWBOX` to the bee's own
    // bounds is the change to make if that matters more than the mark being the artwork unaltered.
    //
    // IDS ARE PREFIXED PER SEAT. The artwork names ten gradients and four filters, and this bundle puts
    // the mark in two places at once. Two copies of those ids in one document is invalid; while both
    // copies are identical every `url(#…)` resolves to the first and looks right, and that stops being
    // true the moment the two seats are not identical. A prefix per seat fixes it without a counter,
    // which would churn the DOM on every re-render.
    const MARK_VIEWBOX = '0 0 1024 1024'

    /** The artwork's contents: everything the source SVG's root element holds, verbatim. */
    const MARK_MARKUP = `
  <defs>
    <!-- 背景：深色科技底 -->
    <radialGradient id="bgGrad" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="#1E2A4A"/>
      <stop offset="60%" stop-color="#0E1428"/>
      <stop offset="100%" stop-color="#060912"/>
    </radialGradient>

    <!-- 身体：金黄到琥珀的径向渐变 -->
    <radialGradient id="bodyGrad" cx="38%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#FFE9A0"/>
      <stop offset="35%" stop-color="#FFC93C"/>
      <stop offset="70%" stop-color="#E89A0C"/>
      <stop offset="100%" stop-color="#9C5E00"/>
    </radialGradient>

    <!-- 头部渐变 -->
    <radialGradient id="headGrad" cx="38%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#FFE9A0"/>
      <stop offset="40%" stop-color="#FFC93C"/>
      <stop offset="75%" stop-color="#E89A0C"/>
      <stop offset="100%" stop-color="#9C5E00"/>
    </radialGradient>

    <!-- 条纹 -->
    <linearGradient id="stripeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#3A2A10"/>
      <stop offset="50%" stop-color="#1A1206"/>
      <stop offset="100%" stop-color="#0A0804"/>
    </linearGradient>

    <!-- 翅膀：简化版，单一柔和渐变 -->
    <linearGradient id="wingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#EAF6FF" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="#9FD8FF" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#4A8FD8" stop-opacity="0.12"/>
    </linearGradient>

    <!-- 高光 -->
    <radialGradient id="specular" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>

    <!-- 地面阴影 -->
    <radialGradient id="groundShadow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>

    <!-- 绒毛纹理 -->
    <filter id="fuzz" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" result="noise"/>
      <feColorMatrix in="noise" type="saturate" values="0" result="gray"/>
      <feComponentTransfer in="gray" result="soft">
        <feFuncA type="linear" slope="0.18"/>
      </feComponentTransfer>
      <feComposite in="soft" in2="SourceGraphic" operator="in"/>
    </filter>

    <!-- 外发光 -->
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="16" result="b"/>
      <feMerge>
        <feMergeNode in="b"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <!-- 柔光 -->
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
  </defs>

  <!-- 圆角底板 -->
  <rect x="48" y="48" width="928" height="928" rx="200" fill="url(#bgGrad)"/>
  <rect x="48" y="48" width="928" height="928" rx="200" fill="none" stroke="#3A6BFF" stroke-width="2" opacity="0.35"/>
  <g opacity="0.08" stroke="#7FB8FF" stroke-width="1">
    <path d="M48 240 H976 M48 400 H976 M48 560 H976 M48 720 H976 M48 880 H976"/>
    <path d="M240 48 V976 M400 48 V976 M560 48 V976 M720 48 V976 M880 48 V976"/>
  </g>

  <!-- 地面阴影 -->
  <ellipse cx="512" cy="920" rx="280" ry="40" fill="url(#groundShadow)"/>

  <!-- ===== 翅膀（简化版） ===== -->
  <g opacity="0.9">
    <!-- 左翅 -->
    <ellipse cx="340" cy="360" rx="160" ry="108" fill="url(#wingGrad)" stroke="#BFE6FF" stroke-width="3" transform="rotate(-24 340 360)"/>

    <!-- 右翅 -->
    <ellipse cx="684" cy="360" rx="160" ry="108" fill="url(#wingGrad)" stroke="#BFE6FF" stroke-width="3" transform="rotate(24 684 360)"/>
  </g>

  <!-- ===== 身体 ===== -->
  <g filter="url(#glow)">
    <ellipse cx="512" cy="585" rx="215" ry="270" fill="url(#bodyGrad)"/>
    <ellipse cx="512" cy="585" rx="215" ry="270" fill="#FFD76A" filter="url(#fuzz)" opacity="0.9"/>
    <ellipse cx="512" cy="585" rx="215" ry="270" fill="none" stroke="#8A5200" stroke-width="4" opacity="0.7"/>
    <ellipse cx="430" cy="470" rx="80" ry="130" fill="url(#specular)" opacity="0.35"/>
    <ellipse cx="600" cy="720" rx="120" ry="120" fill="#7A4A00" opacity="0.28" filter="url(#softGlow)"/>
  </g>

  <!-- ===== 两条黑色横纹（缩短 + 下移） ===== -->
  <g>
    <path d="M368 620 Q512 582 656 620" stroke="url(#stripeGrad)" stroke-width="44" fill="none" stroke-linecap="round"/>
    <path d="M368 610 Q512 572 656 610" stroke="#5A4420" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.6"/>
    <path d="M368 632 Q512 594 656 632" stroke="#000000" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.5"/>

    <path d="M362 740 Q512 702 662 740" stroke="url(#stripeGrad)" stroke-width="44" fill="none" stroke-linecap="round"/>
    <path d="M362 730 Q512 692 662 730" stroke="#5A4420" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.6"/>
    <path d="M362 752 Q512 714 662 752" stroke="#000000" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.5"/>
  </g>

  <!-- ===== 头部 ===== -->
  <g filter="url(#glow)">
    <circle cx="512" cy="308" r="150" fill="url(#headGrad)"/>
    <circle cx="512" cy="308" r="150" fill="#FFD76A" filter="url(#fuzz)" opacity="0.9"/>
    <circle cx="512" cy="308" r="150" fill="none" stroke="#8A5200" stroke-width="4" opacity="0.7"/>
    <ellipse cx="460" cy="250" rx="60" ry="46" fill="url(#specular)" opacity="0.5"/>
    <ellipse cx="560" cy="400" rx="80" ry="60" fill="#7A4A00" opacity="0.25" filter="url(#softGlow)"/>
  </g>

  <!-- ===== 眼睛（圆眼） ===== -->
  <g>
    <circle cx="458" cy="294" r="40" fill="#7A4A00" opacity="0.35" filter="url(#softGlow)"/>
    <circle cx="566" cy="294" r="40" fill="#7A4A00" opacity="0.35" filter="url(#softGlow)"/>

    <circle cx="458" cy="292" r="36" fill="#FFFDF5"/>
    <circle cx="566" cy="292" r="36" fill="#FFFDF5"/>
    <circle cx="458" cy="292" r="36" fill="none" stroke="#3A2A10" stroke-width="3"/>
    <circle cx="566" cy="292" r="36" fill="none" stroke="#3A2A10" stroke-width="3"/>

    <circle cx="462" cy="296" r="22" fill="#1A0F04"/>
    <circle cx="570" cy="296" r="22" fill="#1A0F04"/>
    <circle cx="456" cy="288" r="7" fill="#FFFFFF"/>
    <circle cx="564" cy="288" r="7" fill="#FFFFFF"/>
    <circle cx="468" cy="302" r="3" fill="#FFFFFF" opacity="0.7"/>
    <circle cx="576" cy="302" r="3" fill="#FFFFFF" opacity="0.7"/>
  </g>

  <!-- ===== 微笑嘴 ===== -->
  <path d="M466 352 Q512 402 558 352" stroke="#1A0F04" stroke-width="12" fill="none" stroke-linecap="round"/>
  <path d="M470 350 Q512 396 554 350" stroke="#FFE9A0" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.5"/>

  <!-- ===== 触角 ===== -->
  <g>
    <path d="M452 182 Q404 66 322 54" stroke="#1A0F04" stroke-width="14" fill="none" stroke-linecap="round"/>
    <path d="M452 182 Q404 66 322 54" stroke="#6A4A10" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.5"/>
    <circle cx="452" cy="182" r="9" fill="#1A0F04"/>
    <circle cx="310" cy="50" r="22" fill="url(#bodyGrad)" stroke="#8A5200" stroke-width="3"/>
    <circle cx="304" cy="44" r="7" fill="#FFFFFF" opacity="0.6"/>

    <path d="M572 182 Q620 66 702 54" stroke="#1A0F04" stroke-width="14" fill="none" stroke-linecap="round"/>
    <path d="M572 182 Q620 66 702 54" stroke="#6A4A10" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.5"/>
    <circle cx="572" cy="182" r="9" fill="#1A0F04"/>
    <circle cx="714" cy="50" r="22" fill="url(#bodyGrad)" stroke="#8A5200" stroke-width="3"/>
    <circle cx="708" cy="44" r="7" fill="#FFFFFF" opacity="0.6"/>
  </g>`

    /**
     * The artwork without the plate it is drawn on, which is what these two seats show.
     *
     * Each pattern matches the artwork's own text, including its two-space indentation, and each is
     * anchored to a comment the artwork carries where it can be: a change to the artwork that stops one of
     * these matching would leave the plate in place, so `tests/brand-client.test.mjs` renders a seat and
     * asserts the plate is absent — a transform that silently stopped working would fail there.
     */
    const IN_APP_MARKUP = MARK_MARKUP
      // The rounded square, its hairline border, and the grid drawn inside it.
      .replace(/\n  <!-- 圆角底板 -->\n  <rect x="48"[^\n]*\n  <rect x="48"[^\n]*\n  <g opacity="0\.08" stroke="#7FB8FF"[\s\S]*?<\/g>/u, '')
      // The shadow it casts, which nothing would cast once the plate is gone.
      .replace(/\n  <!-- 地面阴影 -->\n  <ellipse cx="512" cy="920"[^\n]*/u, '')

    /**
     * The artwork without its plate, with ids namespaced for one seat.
     * @param seat - a short, stable label. Two seats rendering at once must not share ids.
     * @returns the markup to insert.
     */
    function markMarkup(seat) {
      const prefix = 'qk-' + seat + '-'
      return IN_APP_MARKUP.replaceAll('id="', 'id="' + prefix).replaceAll('url(#', 'url(#' + prefix)
    }

    /**
     * The sidebar mark: `size` square, in the sidebar's brand seat.
     * @param props - owner share, which carries the requested square edge.
     */
    function BrandMark(props) {
      const size = props.size
      return h('svg', {
        width: size, height: size, viewBox: MARK_VIEWBOX,
        role: 'img', 'aria-label': BRAND, focusable: 'false',
        dangerouslySetInnerHTML: { __html: markMarkup('sidebar') },
      })
    }

    /**
     * The sidebar wordmark.
     *
     * The seat supplies no props: its occupant owns its own content and width, so
     * the height is fixed here and the width follows the wordmark's 4:1 aspect.
     */
    function BrandName() {
      return h('svg', {
        width: 18 * WORDMARK_RATIO, height: 18, viewBox: WORDMARK_VIEWBOX,
        role: 'img', 'aria-label': BRAND, focusable: 'false',
      }, [
        ...glyphs(WORDMARK_TONE, TONE),
        ...glyphs(WORDMARK_INK, INK),
      ])
    }

    /**
     * The mark above the conversation hero.
     * @param props - owner share: a requested edge, plus the host's class that
     *   preserves the surrounding hero geometry.
     */
    function HeroBrandMark(props) {
      const size = props.size
      return h('svg', {
        width: size, height: size, viewBox: MARK_VIEWBOX, className: props.className,
        role: 'img', 'aria-label': BRAND, focusable: 'false',
        dangerouslySetInnerHTML: { __html: markMarkup('hero') },
      })
    }

    /** Required Cordis service: the UI slot registry. */
    const inject = ['slots']

    /**
     * Register the three brand seats.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      // All three are `single`, so exactly one occupant each. The upstream
      // occupant of the two sidebar seats is `ui-brand-official`, which this
      // bundle's patch disables; the hero seat ships empty.
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark))
      ctx.slots.inject('sidebar.brand.name', () =>
        ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName))
      ctx.slots.inject('conversation.hero.brand.mark', () =>
        ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HeroBrandMark))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
