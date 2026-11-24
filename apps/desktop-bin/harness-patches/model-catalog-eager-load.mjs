/**
 * Build-time patch: let the composer name its model without building the catalogue.
 *
 * THE PROBLEM, MEASURED. `dsh-client-ui-model-selection` built the entire model catalogue during
 * startup — `ModelDirectoryResolver`'s constructor called `this.catalog.load()`, which reaches
 * `session/modelCatalog`, asks all 57 registered providers for their models and resolves metadata
 * for all 2,063 of them. Every route holding a credential is probed. Measured here: 2,443 ms cold,
 * dominated by two first-TLS handshakes (`qialike-bee-cn` 2,503 ms, `moonshotai-cn` 2,126 ms);
 * 220 ms warm. A user with DeepSeek and Moonshot configured and DeepSeek selected waits on Moonshot
 * and Bee for data about models they are not using.
 *
 * WHAT THE COMPOSER NEEDS is one name and one effort label. `/api/qialike/active-model` answers
 * that in 124 ms (measured) with a single `resolveModelInfo` for the selected provider only — no
 * enumeration, no other provider touched.
 *
 * TWO EDITS:
 *
 *   1. Replace the eager catalogue load with that lookup, and store its answer as a ONE-GROUP
 *      catalogue kept at `status: "idle"`. Idle matters: `load()` short-circuits on
 *      `status === "ready" && value !== null`, so marking it ready would make the menu show a
 *      single model forever. Idle means "something to display now, the real thing still to come",
 *      and opening the menu performs the real load exactly as before.
 *
 *   2. Let the session store adopt that group's model as `current` when it has none. Without this
 *      the trigger has a group but no selection, so it renders the fallback ("Select a model") —
 *      a worse outcome than the spinner it replaced, because it claims nothing is selected when
 *      the user has a model. With it, the name and effort label render immediately and the
 *      fallback stays for what it was written for: a genuinely empty selection.
 *
 * FAIL CLOSED. Both anchors are literal. A harness that moved either one fails this build rather
 * than quietly reverting to a 2,063-model startup — a regression whose only symptom is slowness,
 * which is exactly the kind of thing that ships unnoticed.
 *
 * @module qialike-desktop/harness-patches/model-catalog-eager-load
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Idempotency marker; also the anchor for "has this patch already run". */
export const EAGER_LOAD_MARKER = 'qialike: the catalogue is not built at startup'

/** The one bundle this patch edits. */
const CLIENT_BUNDLE = '-deepseek-ai-dsh-client-ui-model-selection/lib/client.js'

const ANCHORS = [
  {
    // EDIT 1: the eager load becomes a single-model lookup.
    from: [
      // Pretty form (pre-0.2.2-rc.3).
      '\t\t\t\tthis.catalog = new ModelCatalogDirectory(ctx);\n'
        + '\t\t\t\tthis.catalog.load().catch(() => {});',
      // Minified form: 0.2.2-rc.3 ships client bundles through tsdown's minifier. The identifiers
      // survive, so this is spacing and quoting only.
      'this.catalog=new ModelCatalogDirectory(ctx);this.catalog.load().catch(()=>{})',
    ],
    to: '\t\t\t\tthis.catalog = new ModelCatalogDirectory(ctx);\n'
      + '\t\t\t\t/* ' + EAGER_LOAD_MARKER + ' */\n'
      + '\t\t\t\t// ONE PROVIDER, NOT FIFTY-SEVEN. The full catalogue is built when the menu is\n'
      + '\t\t\t\t// opened (`reload()` on the trigger, and the `/model` contribution), which is the\n'
      + '\t\t\t\t// only moment all 2,063 models are actually on screen. Startup needs the model\n'
      + '\t\t\t\t// the composer is already sending with, and that costs one resolveModelInfo.\n'
      + '\t\t\t\t//\n'
      + '\t\t\t\t// The answer is stored as an IDLE one-group catalogue: idle because `load()`\n'
      + '\t\t\t\t// short-circuits on `status === "ready"`, so a "ready" stand-in would keep the\n'
      + '\t\t\t\t// menu down to a single model for the rest of the session.\n'
      + '\t\t\t\tfetch("api/qialike/active-model", { headers: { accept: "application/json" } })\n'
      + '\t\t\t\t\t.then((response) => response.ok ? response.json() : void 0)\n'
      + '\t\t\t\t\t.then((payload) => {\n'
      + '\t\t\t\t\t\tif (payload === void 0 || payload.ok !== true || payload.value === void 0) return;\n'
      + '\t\t\t\t\t\tconst active = payload.value;\n'
      + '\t\t\t\t\t\tthis.catalog.store.set({\n'
      + '\t\t\t\t\t\t\tvalue: {\n'
      + '\t\t\t\t\t\t\t\tdefault: {\n'
      + '\t\t\t\t\t\t\t\t\tprovider: active.provider,\n'
      + '\t\t\t\t\t\t\t\t\tmodel: active.model\n'
      + '\t\t\t\t\t\t\t\t},\n'
      + '\t\t\t\t\t\t\t\troutableProviders: [active.provider],\n'
      + '\t\t\t\t\t\t\t\tgroups: [{\n'
      + '\t\t\t\t\t\t\t\t\tid: active.provider,\n'
      + '\t\t\t\t\t\t\t\t\tname: active.provider,\n'
      + '\t\t\t\t\t\t\t\t\tmodels: [Object.assign({\n'
      + '\t\t\t\t\t\t\t\t\t\tid: active.model,\n'
      + '\t\t\t\t\t\t\t\t\t\tname: active.name\n'
      + '\t\t\t\t\t\t\t\t\t}, active.reasoning === void 0 ? {} : {\n'
      + '\t\t\t\t\t\t\t\t\t\treasoning: active.reasoning\n'
      + '\t\t\t\t\t\t\t\t\t})]\n'
      + '\t\t\t\t\t\t\t\t}],\n'
      + '\t\t\t\t\t\t\t\tfailures: []\n'
      + '\t\t\t\t\t\t\t},\n'
      + '\t\t\t\t\t\t\tstatus: "idle",\n'
      + '\t\t\t\t\t\t\terror: null\n'
      + '\t\t\t\t\t\t});\n'
      + '\t\t\t\t\t})\n'
      + '\t\t\t\t\t.catch(() => {});',
  },
  {
    // EDIT 2: adopt the stand-in's model as the current selection.
    from: [
      '\t\t\t\t\tcurrent: catalog.value === null ? null : this.store.getSnapshot().current,',
      'current:catalog.value===null?null:this.store.getSnapshot().current',
    ],
    // THE REPLACEMENT MUST MATCH THE SHAPE OF THE SPELLING THAT MATCHED, and that is not cosmetic.
    // The minified anchor has NO trailing comma — it runs straight into the next property — so a
    // replacement ending in `,` produced `null,,...retainedEffort`: a syntax error that broke the
    // whole client bundle and left the application on "Loading plugins…" with nothing in the
    // console, because the module failed to PARSE before it could report anything.
    to: [
      '\t\t\t\t\t// `?? catalog.value.default` is what lets the stand-in above reach the trigger: the\n'
        + '\t\t\t\t\t// store starts with `current: null`, and a group without a selection renders the\n'
        + '\t\t\t\t\t// fallback label instead of the model the user is actually sending with.\n'
        + '\t\t\t\t\tcurrent: catalog.value === null ? null '
        + ': this.store.getSnapshot().current ?? catalog.value.default ?? null,',
      'current:catalog.value===null?null:this.store.getSnapshot().current??catalog.value.default??null',
    ],
  },
]

/**
 * Apply the patch to a farm.
 *
 * @param root - the farm root (never the harness checkout).
 * @param log - progress sink.
 * @returns the files written.
 * @throws Error when the bundle is absent, or an anchor no longer matches.
 */
export function patchModelCatalogEagerLoad({ root, log = () => {} }) {
  const path = join(root, CLIENT_BUNDLE)
  if (!existsSync(path)) {
    throw new Error(
      `qialike-desktop: ${CLIENT_BUNDLE} is missing from the farm. The model-selection bundle is `
      + 'what this patch removes the startup catalogue build from; without it the composer waits '
      + 'for every configured provider again.',
    )
  }
  const original = readFileSync(path, 'utf8')
  if (original.includes(EAGER_LOAD_MARKER)) {
    log(`model-catalog-eager-load: ${CLIENT_BUNDLE} already patched`)
    return []
  }
  let text = original
  // EACH ANCHOR ACCEPTS SEVERAL SPELLINGS, AND EXACTLY ONE MUST MATCH. Harness 0.2.2-rc.3 minifies
  // client bundles, so the same code now reads without whitespace and with backticked strings; before
  // that it was pretty-printed. Both are recorded per anchor, and "none matched" still fails loudly.
  let index = 0
  for (const { from, to } of ANCHORS) {
    index += 1
    const hits = from.filter((spelling) => text.includes(spelling))
    if (hits.length !== 1) {
      throw new Error(
        `qialike-desktop: the vendored ${CLIENT_BUNDLE} does not contain the code this patch `
        + `rewrites (anchor ${String(index)}: ${String(hits.length)} of ${String(from.length)} accepted `
        + 'spellings matched; exactly one must). The harness changed the model-selection bundle, so '
        + 'startup would go back to building every provider group.\n'
        + `  Looking for: ${JSON.stringify(from[0].slice(0, 140))}\n`
        + '  Re-read the current ModelDirectoryResolver constructor / syncInputs and add the new '
        + 'spelling to ANCHORS in apps/desktop-bin/harness-patches/model-catalog-eager-load.mjs.',
      )
    }
    // `to` may be a list parallel to `from`: pick the replacement written for the spelling that
    // matched. A single string is used for both, which is correct only when the trailing syntax is
    // identical between the two forms.
    const replacement = Array.isArray(to) ? to[from.indexOf(hits[0])] : to
    text = text.replace(hits[0], replacement)
  }
  writeFileSync(path, text)
  log(`model-catalog-eager-load: patched ${CLIENT_BUNDLE} (2 edits)`)
  return [path]
}
