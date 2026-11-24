# @qialike/desktop-web

qialike's own browser-surface assets.

## What this is, and why it is a shadow rather than a build

The application renders the harness browser surface, whose built frontend is a
Vite bundle (`assets/index-<hash>.js`, `assets/vendor-<hash>.js`) produced by the
harness's own `apps/web` build. **That bundle cannot be built from here**: it
needs the harness monorepo's workspace, its platform module tables, its
client-build environment defines, and a dozen packages that are not published.
The dist is therefore consumed as an artifact (DESIGN §5.1) and this repository
*shadows* it — overlaying the files that carry branding — rather than
reimplementing it.

The overlay is deliberately small, and that is the point. Branding that lives in
a file with a stable name can be replaced without touching the document:

| File | Upstream | Ours |
|---|---|---|
| `favicon.svg` | the DeepSeek mark | the qialike mark, light scheme |
| `favicon-dark.svg` | the DeepSeek mark | the qialike mark, dark scheme |
| `manifest.webmanifest` | "DeepSeek Harness" / "DSH" | "Qialike" |

The upstream `index.html` already references all three by those exact relative
names, so **no markup has to be rewritten** for them. The one thing that does is
the `<title>`, and the shadow edits that single element rather than authoring a
replacement document — re-authoring it would mean hardcoding the content-hashed
asset URLs, which change on every upstream rebuild.

One piece of upstream branding is not in a file at all, so replacing the file is
not available for it: the harness's boot card draws a **wordmark as a text node**
in the bundle, and the user sees it in the middle of the window for about a second
while the Host boots. `public/qialike-ui.css` replaces it by collapsing that text
node's `font-size` to zero and drawing the product name on `::after`, keyed on the
class's local name inside `[data-dsh-boot]`. That is a third kind of shadow —
neither a shadowed file nor an edited element — and the reasoning for the selector,
including why a substring match is acceptable here when it was rejected for
component classes, is in that stylesheet's own comment. `tests/web-brand.test.mjs`
asserts the selector still matches exactly one upstream class, so an upstream
rename fails the build instead of silently restoring the old wordmark.

`brand/` holds the source assets the **wordmark** is derived from. They are copied
in from the workspace's `svg/` directory and kept byte-identical there.

The mark and the wordmark are drawn in **DeepSeek's brand blue** (`#4D6BFE`, the colour DeepSeek's own
mark uses) rather than in the theme's text ink. That is a deliberate reversal of the property this
directory used to rely on: a token-made mark adapted to all sixteen schemes, and a brand colour must be
the same blue everywhere. The wordmark keeps its two tones as two blues; the two favicons are now the
same colour, because the brand blue was chosen to read on a light and a dark background alike (4.33:1 and
4.49:1 respectively).

**The bee's abdomen is the one exception: its two bands are drawn in the bee's own yellow (`#FFCC00`).**
The mark was a single ink by design, and this breaks that — deliberately, because a bee drawn entirely in
one blue reads as an abstract insect and the yellow is what names it. The cost is measured rather than
discovered later: that yellow is **12.85:1** on the application's dark background and **1.41:1** on white,
so on a light scheme the two accented bands do not read as yellow, they read as **absent**, and the bee
appears to have lost its abdomen. The application's own default is dark, which is why the colour is worth
having anyway; a dark outline under the silhouette is the known fix, and it is a decision not yet taken.

The square mark is no longer a crop of the wordmark. It was the leading `q` glyph,
which guaranteed the two could not drift apart; it is now a drawing of its own — a
bee — because the product's mark should not be a piece of its name. That property is
given up deliberately, and what replaces it is a different guarantee: the mark's
artwork lives in exactly one place, `apps/desktop-bin/lib/brand-colours.mjs`, which
derives the two favicons and the launcher's `icon.png` from it as well, and
`tests/brand-assets.test.mjs` asserts that every committed copy still matches.

## Later

M2's second half — an own frontend with a Welcome page — lands here. At that
point this directory stops being an overlay and becomes the `sourceDist` the
build assembles from, which is why `webFrontendMember` already takes its dist as
a parameter rather than assuming the harness's.
