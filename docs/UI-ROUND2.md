# UI round 2 — what was measured, what was fixed, and what still needs eyes

This is the record of the second pass over the interface, after the first one shipped
a stylesheet layer, self-hosted type and a fix to the provider page's theme blindness.
It exists because the first pass ended with "please look at the seven screenshots",
and the honest answer to that request turned out to be: **some of what those
screenshots were supposed to settle is arithmetic, and two real defects were sitting
in the part that is not.**

The division of labour this document is built on:

| Question | Who answers it | Why |
|---|---|---|
| Is this text readable? | **Arithmetic** — WCAG contrast, computed from palette values | No display, no eyes and no judgement are involved |
| Is this control consistent with the theme? | **A real window** — read the computed colour of the rendered node | A DOM measurement is a fact about the running product |
| Is this dense enough? Is this beautiful? | **A human** | Not derivable, and not this repository's to assert |

---

## 1. The defect that started this: an inverted pair, invisible on hover

### What was wrong

The harness paints the **tooltip and the toast dark in every theme** and labels them
with a colour that **never flips**:

- `ui-primitives/src/Tooltip.module.css` — `background: var(--dsw-alias-tooltip-bg)`
  with `color: var(--dsw-static-neutral-bluish-00)` (a static white) on the next line.
- `ui-primitives/src/Toast.module.css` — its own comment: *"The design platform's
  toast surface is dark in BOTH themes (bluish-800 light / bluish-750 dark), so the
  label and the action text below stay fixed instead of flipping with the theme."*
- `ui-primitives/src/ShortcutKeys.module.css` — the keycaps inside a tooltip read
  `--dsw-alias-tooltip-key-bg`, which `ui-theme` derives **from the tooltip surface**
  (`color-mix(… , white 18%)`), and their glyph inherits the tooltip's white.

Our theme mapping assigned the surfaces to the palette's `panel` role — the only
light rung a 16-role palette has. In the two light schemes that made a near-white
rectangle carrying white text, and **nothing in the repository could see it**: the
tooltip exists only while a pointer is over an anchor, so it appears in no
screenshot, no static scan, and no assertion that does not first move a pointer.

### The fix

Four tokens — `--dsw-alias-tooltip-bg`, `--dsw-alias-tooltip-key-bg`,
`--dsw-alias-toast-bg`, `--dsw-alias-toast-label` — are **removed from the mapping**
and recorded in `FIXED_DARK_SURFACES` (`packages/qialike-desktop-theme/lib/tokens.js`)
with the upstream file that establishes each one. Leaving them unset restores the
harness's own pair, which no longer depends on the scheme. Coverage moves 121/123 →
**117/123**.

Repairing the *label* instead was rejected: it is a `--dsw-static-*` value shared by
the whole interface, and a tooltip that follows a light scheme is a different product
decision (it needs a dark label, a border and a shadow the surface does not have).
The harness has already made that decision twice, deliberately.

### The measurement, in a real window

`apps/desktop-bin/lib/ui-legibility-probe.mjs` launches the packaged AppImage,
dismisses the first-run overlay, searches the interactive elements for one that
actually mounts a bubble, hovers it and reads the rendered colours back. The
"before" frame is produced by re-applying the defect **in the live document** —
setting `--dsw-alias-tooltip-bg` to the scheme's `panel` — so both frames come from
the same build and nothing else differs between them:

| scheme | before (mapping's value) | after (harness's value) |
|---|---|---|
| `qialike-light` (Atom One Light) | `#f0f0f0` — **1.14:1** | `#2c2c2e` — **13.94:1** |
| `qialike-solarized-light` | `#eee8d5` — **1.23:1** | `#2c2c2e` — **13.94:1** |
| `qialike-dracula` | `#21222c` — 15.79:1 | `#43454a` — **9.59:1** |

The two figures predicted from the palettes alone (1.14, 1.23) are the two figures
measured in the window. Dracula was never broken, which is the shape of the bug: it
only ever affected the schemes a light-theme user picks.

Screenshots: `/home/pipo/qialike/screens/ui-round2/<scheme>.tooltip-{fixed,before}.png`
(1280×793; the two frames differ by ~2 450 px, all inside x152–334, the sidebar strip
the bubble occupies).

**One implementation note worth keeping**, because it produced a silent false
negative: the harness declares its whole token sheet on **`body`**, not on `:root`
(`design-platform.css` has `body { … }` and `body[data-ds-dark-theme] { … }`). The
first sabotage set the override on `documentElement`, was shadowed by the nearer
declaration, and measured the *fixed* state twice. The symptom was two byte-identical
frames, which is the good version of that failure.

---

## 2. The second defect: the theme picker was the one control the theme did not reach

The row rendered a bare `<select>` with no styling, so the user agent drew it.
Measured in the window: a 127×20 widget with a `#3b3b3b` fill and a `#858585` border
that was **byte-identical in the dark theme and in dracula**, and white in One Light.
It followed `color-scheme` — which our own `colorScheme` field sets — and not one
colour of the scheme it was choosing.

Fixed by giving the row the design system's own field, taken from
`ui-settings-models/ModelsSection.module.css`: `bg-layer-1` fill, `border-l4`
outline, `label-primary` ink, `radius-md`, 32 px tall, `appearance: none` and the
shared 12 px chevron (a data-URI SVG, which cannot read a CSS variable and therefore
carries the same literal stroke upstream's own comment explains). Every token is in
the theme's mapping, so the field now follows the chosen scheme;
`tests/client-tokens.test.mjs` fails the build if any of those names stops existing,
and a new assertion in `tests/theme-client.test.mjs` pins the shape.

---

## 3. What the screenshot audit got right, and what it could not see

A quantitative pass over the seven screenshots (Pillow, no OCR) produced geometry,
palettes, spacing and glyph-core contrast. Its numbers are trustworthy; two of its
conclusions were not, and the difference matters for anyone reading it:

| Audit claim | Verdict |
|---|---|
| No region ≥8×3 px holds a constant colour across dark / dracula / One Light, at any tolerance up to ±32/255 | **Correct, and stronger than expected** — the "hardcoded colour ignores the theme" signature is absent at UI scale |
| `#1f6feb` and `#cfd3b6` have zero hits in all seven images | **Correct** — consistent with the first pass's fix |
| `#c9c9c9` is "light-only" and worth a grep | **Resolved, and it is not a bug.** It is the `light` scheme's own `border` role (`#c9c9c9`), i.e. our mapping working. The dark shots show `#454547` for the same rules because that is the harness's dark border, not a different literal |
| "04 has real sub-4.5:1 body text (3.06:1, 3.10:1 ×3 rows)" | **Overstated.** Those are **glyph-core** samples; at 13–16 px the strokes are sub-pixel wide, so the darkest pixel is an anti-aliased blend toward the background and understates the contrast. The palette value behind them is `#696c77` → **4.19:1** on the `element` surface and **4.59:1** on `panel`. For scale, the harness's own light theme ships `label-tertiary` at **3.42:1** on its module surface, so this is at or above the baseline, not below it |
| The 127×20 scheme-blind control | **Correct, and it was ours** — the theme picker (§2) |
| Geometry is stable across the settings shots; only colours change | **Correct** — panel x239–1040, y23–769, content column x452–1010, identical in every scheme |

**What pixels cannot answer, and the audit said so:** text content (no OCR), CSS
token names, whether the fonts are self-hosted, which family is rendered, and any
hover or focus state. The last one is exactly the gap the tooltip defect lived in.

> The audit's raw output (1 117 lines, with per-image character grids and the scripts
> that produced them) is at `.build-scratch/ui-round2/screenshot-audit.md`. That path
> is a scratch directory and is not committed; everything load-bearing is in this
> document.

---

## 4. Recorded, deliberately not changed: white glyphs on a palette accent

`--dsw-alias-button-info-fill` (the send button) and
`--dsw-alias-state-error-primary` (the failed-attachment badge) both carry a fixed
white glyph upstream. We map them to the scheme's `info` and `error` roles, and in
the dark schemes those roles are *pale*, so the white glyph reads as low as
**1.49:1** (catppuccin) against the harness's own worst of **2.16:1** (white on its
dark-theme deepseek-400 send button).

That is the same failure class at a lesser degree, and it is **not** fixed here,
because closing the gap means deepening two tokens that upstream also reads as *ink*
in four other places (`ui-sidebar-browser`'s error text, `ui-user-questions`,
`ui-settings-general`, `ui-conversation`). Deepening them would darken that text on
dark backgrounds. It is a visual trade-off rather than a bug fix, so it is recorded as
risk **R13** in `DESIGN.md` §12.2 with a **1.4:1 floor asserted** in
`tests/theme-legibility.test.mjs` — any scheme that slips below it fails the suite
with the full table of numbers attached.

---

## 5. Still unverified, stated plainly

- **Whether any of it looks good.** The colours are proven to be applied (computed
  values in a real window), the contrast is proven to be sufficient (arithmetic, and
  now a rendered measurement for the tooltip), and neither of those is a statement
  about appearance. The seven original screenshots plus the six new tooltip frames
  are the evidence for that call, and it is not mine to make.
- **Density and type scale.** The audit measured row pitch (77 px modal on the
  settings page, 57.0 px on the providers page), panel insets (212 px left / 30 px
  right), and line ink heights, but em size and cap height could not be separated
  from x-height at this resolution. Changing either without a rendered comparison
  would be a guess.
- **`read_image` is unavailable in this environment** — the harness binary is shipped
  without `sharp` and the tool fails with `Cannot find module 'sharp'`. Every image
  statement in this document comes from Pillow measurements or from the DOM, never
  from my having looked at a picture.
