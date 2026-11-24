/**
 * The deepseek-harness compatibility gate.
 *
 * This application composes harness bundles at the *row* level: it disables
 * base rows by id, inserts its own, and relies on harness services whose shape
 * is not part of any published contract. A harness release this build was never
 * validated against must therefore fail loudly at build time rather than
 * half-work at runtime.
 *
 * The bounds are held here rather than imported from the qialike CLI: that
 * repository does not export them, and duplication fails in the safe direction
 * (we reject an unvalidated harness). Raising `MAX` is a deliberate act that
 * follows re-validating this application against the newer harness.
 *
 * @module qialike-desktop/harness-version
 * rc.1 -> rc.3 (1,574 commits) CARRIED NO INTERFACE REVERSALS, WHICH IS THE FIRST TIME THAT HAS BEEN
 * TRUE. `collectIndexInjections(peer)`, `PROFILE_TEMPLATES` in `dsh-official-bundles` and the
 * composite `writableRoots` are all exactly as rc.1 left them, so the three adaptations made for that
 * bump needed no edit. The `writable-roots-windows` patch applied against the composite form without
 * being touched, which is what it was made dual-form for.
 *
 * WHAT DID BREAK WAS THE PATCH MECHANISM ITSELF. rc.3 began shipping its CLIENT bundles minified —
 * whitespace gone, `"…"` replaced by `` `…` ``, operator spacing gone. The identifiers survive, so
 * every one of these was a formatting difference and not a change of shape, but six patches matched
 * literal text and all six failed:
 *   · brand-title, hero-headline, office-engine-message and app-version needed their patterns to
 *     accept backticked values (and, for app-version, a verification that had hard-coded the pretty
 *     `version: "x"` form it then failed to find in its own output);
 *   · session-list-parity and model-catalog-eager-load now carry a LIST of accepted spellings per
 *     anchor and require exactly one to match, so a genuine rewrite still fails loudly.
 * The tests needed the same treatment: assertions about upstream CSS and bundles had to stop
 * naming one spelling of a declaration that upstream writes two ways.
 *
 * ONE REAL API CHANGE DID LAND. `connection.authenticatedUrl()` is gone — token minting moved behind
 * the `webserver/entry-url` event, where `dsh-authentication-token` pushes a ready-made URL into a
 * table the emitter supplies. The Host now calls `entryUrlOf()`, and the seven probe scripts that
 * authenticated themselves the old way were migrated with it; each failed with
 * `ctx.get(...).authenticatedUrl is not a function` before it could report anything.
 *
 * TWO UPSTREAM CHANGES REACHED THE PRODUCT SURFACE:
 *   · `dsh-base` gained a second account row, `ui-account-notifications`, alongside the
 *     `ui-settings-account` this bundle already disables. The desktop posture showed an account
 *     surface it is supposed to have none of until the row was excluded too;
 *   · the theme gained 148 alias tokens across toast, tooltip, hovercard, illustration, json-tree
 *     and chart families. 44 were unmapped. The hovercard family is declared against STATIC colours
 *     and joined `FIXED_DARK_SURFACES`; the rest were assigned to the nearest role by kind. Coverage
 *     is 0.953 with no token mapped that the harness does not define.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { DSH_HARNESS_ENV } from './paths.mjs'

/**
 * Oldest harness this application is validated against.
 *
 * Kept equal to the qialike CLI's floor so the two products can share one
 * `$DSH_HOME` and one session store without one of them silently writing a
 * format the other cannot read.
 */
export const HARNESS_VERSION_MIN = '0.1.0-rc.7'

/**
 * Newest harness this application is validated against.
 *
 * Raising this is only correct after re-checking every id-targeted patch row in
 * `packages/qialike-desktop-app/cordis.patch.yml` and every build-time patch
 * anchor against the newer checkout.
 *
 * THAT RE-CHECK WAS DONE FOR 0.2.0-rc.2, and its evidence is in
 * `~/qialike/qialike-desktop-upgrade-plan.md` §2. In outline: all four build-time patch anchors still
 * match verbatim; all seven upstream rows this application overrides still exist and still live in
 * the same bundle; the two rows upstream deleted (`schedule`, `time-context`, `ui-schedule` — web-app)
 * were never referenced here; the Web dist kept the shape the document template depends on; and the
 * five client slots this application registers into are all still provided upstream.
 *
 * THAT RE-CHECK WAS DONE AGAIN FOR 0.2.1-alpha.2, and its evidence is in
 * `docs/desktop/update/2026-10-12-harness-0.2.0-rc.2-to-0.2.1-alpha.2.md`. In outline:
 *
 *   · All SEVEN build-time patch anchors still match, each exactly once. `session-list-parity`'s
 *     eight anchors are the strictest of these (six in the client bundle, two in the host
 *     controller) and all eight still occur exactly once. The `writable-roots-windows` anchors are
 *     multi-line literals containing TABS, and both still match byte-for-byte.
 *   · All seven upstream rows this application overrides still exist AND still live in the same
 *     bundle. That check is not ceremony: `0.2.1-alpha.1`'s `experimental-package-composition`
 *     upgrade guide states that a row this build overrides may have been REMOVED upstream, in which
 *     case the patch entry silently changes nothing. None was removed.
 *   · Upstream's row churn this time was `skill-badge` + `tool-ralph` removed and `working-directory`
 *     added (base), `tool-ralph` removed and `schedule` + `ui-schedule` added (web-app). Note that
 *     `schedule` and `ui-schedule` are the very rows the 0.2.0-rc.2 re-check saw DELETED — upstream
 *     has since restored them, which is why this check is run rather than remembered. Neither they
 *     nor `skill-badge`/`tool-ralph` are referenced here.
 *   · The shell-facing harness API is unchanged: `RunProfileOptions` still takes exactly the five
 *     fields `apps/desktop-host` passes, and the five `dsh-app-boot` exports it imports still exist
 *     with the same signatures. The preset roster is unchanged.
 *   · The shared session store did NOT fork. `docs/persistence-changes/finalized/v4.json` still
 *     records `sessionFormatVersion: 4`, and every persistence change added in this range that
 *     survives at HEAD is classified `same-version`. That matters more here than for a standalone
 *     product: the CLI shares `$DSH_HOME` with this application, so a format fork would be a data
 *     hazard rather than an inconvenience.
 *
 * The jump is large — 935 upstream commits — so the static re-check is only half the story: slots,
 * the boot contract and runtime behaviour are asserted by the test layers, not by reading patch
 * files. The upgrade report's §5 lists the twelve checks that have to be RUN, of which V6/V7 (a
 * session written by the CLI still lists and opens here, and workspace attribution still holds) are
 * the ones this re-check cannot substitute for: `working-directory` and
 * `working-directory-attribution` both changed in this range, and `session-list-parity` reads
 * `cwd`/`workspace.path`. An anchor that still matches does not prove the meaning behind it did not
 * move.
 *
 * THAT RE-CHECK WAS DONE AGAIN FOR 0.2.1-rc.2 (this release), and its evidence is in
 * `docs/desktop/update/2026-10-17-harness-0.2.1-alpha.2-to-0.2.1-rc.2.md`. In outline, and every
 * line of it was measured rather than remembered:
 *
 *   · All NINE build-time patches still apply, and the pipeline was run against the new checkout
 *     rather than reasoned about: a probe ran `copyFarm` + `applyHarnessPatches` on the new harness
 *     and every anchor matched. That includes `session-list-parity`'s eight anchors and the two
 *     `writable-roots-windows` multi-line literals containing TABS, the strictest of the set.
 *   · All seven upstream rows this application overrides still exist AND still live in the same
 *     bundle: `system-prompt`, `llm-pi-ai`, `llm-deepseek`, `llm-deepseek-account` in `base`;
 *     `ui-settings-models`, `ui-brand-official`, `ui-settings-account` in `web-app`.
 *   · The shell-facing API is unchanged: the five `@deepseek-ai/dsh-app-boot` exports
 *     `apps/desktop-host` imports all still resolve — checked by IMPORTING the built module, not by
 *     reading its source — and `RunProfileOptions` still declares exactly the five fields this
 *     application passes: `environment`, `profile`, `resolvedProfile`, `patchFiles`, `args`.
 *   · The session store did NOT fork, which matters more here than for a standalone product because
 *     the CLI shares `$DSH_HOME`: the migration chain still ends at `v3-to-v4`, so the format is
 *     still 4, and both persistence changes added in this range (`deepseek-search-thinking`,
 *     `user-rpc-principal`) are classified `same-version`.
 *
 * None of those four checks is a runtime check, so none of them can say whether the newer harness
 * still WORKS here. That is what the test layers and the end-to-end suite answered, and the upgrade
 * report records what they found.
 *
 * 0.2.1-rc.2 -> 0.2.1-rc.3 IS SIX COMMITS, AND ONE OF THEM NEEDED A LOOK RATHER THAN A RUBBER STAMP:
 *   · `feat(ui): add navigation entry customization` adds a NEW CLIENT PACKAGE
 *     (`dsh-client-ui-entry-customization`) and a new row in `bundle/web-app/cordis.patch.yml`. This
 *     application mounts that bundle wholesale (`PROFILE_BUNDLES`), so the row arrives on its own —
 *     nothing here needed to opt in. Measured against the rc.3 slot catalogue: **no slot key was
 *     removed**, and the three that appeared (`conversation.session.header.views.actions`,
 *     `sidebar.panellist.actions`, `sidebar.right.tab.guide.actions`) are ones none of our five
 *     client bundles register into, so no existing registration changed meaning;
 *   · `feat(llm): follow the official /models listing on the DeepSeek API-key route` touches
 *     `llm-deepseek-account` and `llm-deepseek-api-key`, not the `qialike-llm` row this application
 *     resolves — the provider catalogue is untouched (verified below);
 *   · the remaining three are a release commit, a merge, and a UI fix for navigation pins.
 *
 * THE PROVIDER LAYER IS BYTE-IDENTICAL, which is the check that matters for this application's own
 * code: comparing the tree staged from CLI 0.11.6 against the CLI 0.12.0 checkout, `llm.js`,
 * `models.js`, `opencode.js`, `china-gateways.js`, `foreign-gateways.js`, `azure.js` and `fs-tools.js`
 * all match exactly. Only `index.js` differs, by 92 bytes, from the hero's site-address change.
 *
 * 0.2.1-rc.3 -> 0.2.1-rc.5 IS THIRTEEN COMMITS, AND THE ONE THAT MATTERED REVERSED A CHANGE THIS
 * BUILD HAD BEEN ADAPTED TO:
 *   · `collectIndexInjections()` NO LONGER TAKES A PEER. rc.3 required one and read
 *     `peer.principal` inside `dsh-api-remote-access`; rc.5 emits `("webserver/index-inject", table)`
 *     and that subscriber now pushes a constant owner baseline. Our Host call is back to no argument
 *     (the Peer construction is gone with it) — see `apps/desktop-host/src/index.ts`;
 *   · `writableRoots` is INLINE again and `workspaceWritableRoots` no longer exists. This build's
 *     Windows boundary patch had been moved to the composite form for rc.3, so it stopped matching;
 *     it now accepts BOTH forms, which is what the CLI's own patch does — its 0.13.0 changelog calls
 *     this out explicitly;
 *   · no slot key was removed or added (diff of the rc.3 and rc.5 slot catalogues is empty), so none
 *     of our five client bundles changed meaning;
 *   · the rest are two UI fixes (thinking-block rendering, a fixed tooltip), an ACP/MCP stdout fix,
 *     two merges and two release commits.
 *
 * Measured against the rc.5 tree: `collectIndexInjections` takes no argument, `buildModelCatalog`
 * still exists, `modelReasoning`/`effectiveProfile`/`PROVIDER_TEMPLATES` unchanged, and the
 * `ui-model-selection` bundle still carries both anchors the eager-load patch rewrites.
 *
 * 0.2.1-rc.5 -> 0.2.2-rc.1 IS A MINOR BUMP ACROSS 2,623 COMMITS, AND IT REVERSES TWO OF THE THREE
 * ADAPTATIONS THE PREVIOUS BUMP REQUIRED:
 *   · `collectIndexInjections()` TAKES A PEER AGAIN. rc.5 withdrew it; 0.2.2-rc.1 restores it and
 *     `dsh-api-remote-access` reads `peer.principal` again, so calling with no argument is a boot
 *     crash rather than a missing row. The Host constructs one Peer per handshake, as it did under
 *     rc.3;
 *   · `PROFILE_TEMPLATES` IS BACK IN `@deepseek-ai/dsh-official-bundles`. rc.5 had moved it into
 *     `dsh-app-boot` and deleted that package; 0.2.2-rc.1 returns the package and drops it from
 *     `app-boot`'s export list. The import and the hand-written declaration move with it — the
 *     mismatch is invisible to `tsc` and surfaces only as a failed boot;
 *   · `writableRoots` IS COMPOSITE AGAIN, spreading `workspaceWritableRoots(policy)`. THIS ONE
 *     NEEDED NO WORK, and that is the point of the change made for rc.5: the patch accepts both
 *     spellings and picks whichever the checkout carries, so the third move in this function's
 *     history cost nothing. Verified: `workspaceWritableRoots` appears 3 times in the rc.1 tree and
 *     the patch applied against the composite form.
 *
 * THE REST WAS CHECKED RATHER THAN ASSUMED:
 *   · the slot catalogue gained six keys and lost none (`contextMenu.content`, `contextMenu.icon`,
 *     `conversation.chat.text-interaction`, `conversation.chat.user.before`, `settings.section.icon`,
 *     `sidebar.session.row.trailing`). None is registered by our five client bundles, so no existing
 *     registration changed meaning;
 *   · `buildModelCatalog` is still present in `session-controller`, and the `ui-model-selection`
 *     bundle still carries both anchors the eager-load patch rewrites;
 *   · the provider layer this application mounts is BYTE-IDENTICAL — see the CLI note below.
 * rc.3 -> rc.5 IS THIRTEEN COMMITS AND REVERSES NOTHING, which is the second time that has been
 * true and the reason nothing above needed editing. All three interfaces this application adapted to
 * are exactly as rc.3 left them: `collectIndexInjections(peer)` still takes a Peer,
 * `PROFILE_TEMPLATES` is still declared in `@deepseek-ai/dsh-official-bundles`, and `writableRoots`
 * is still composite. `writable-roots-windows` applied against it untouched — the third move in that
 * function's history that the dual-form patch absorbed for free.
 *
 * THE CLIENT BUNDLES ARE STILL MINIFIED, AND SMALLER. `ui-model-selection` went from 105,801 bytes
 * to 61,894 and `ui-workspace` from 246,921 to 205,018, which is a tighter minifier rather than a
 * rewritten module: every anchor the six text patches depend on is present in its minified spelling,
 * and all six applied without an edit. That is the payoff for the multi-spelling anchors added for
 * rc.3 — they were written to survive this.
 *
 * ONE BASE DEFAULT DID MOVE, AND IT REACHED THE PRODUCT SURFACE. rc.5 removed `searchProvider` from
 * the base `web` row, so with nothing pinned web search follows the model route: on
 * `deepseek-official` it becomes a Messages request carrying the server-side search tool, and
 * anywhere else the per-search API. The bundle now pins `deepseek-search-api` explicitly — see the
 * `web` row in `packages/qialike-desktop-app/cordis.patch.yml`, which records both the billing
 * argument and the one that decided it: this application lets a user override the built-in
 * `deepseek-official` route's baseURL, and the route-following default would send that gateway's key
 * to the OFFICIAL endpoint.
 *
 * CHECKED RATHER THAN ASSUMED, and unchanged from rc.3 in every case: the slot catalogue gained and
 * lost nothing (`diff` of its keys is empty); `fs-observation-policy` is still `disabled: true` in
 * `dsh-base`, so the bundle's explicit `false` still has work to do; both account rows are still
 * there, so both stay excluded; and the theme still defines 446 tokens of which 148 are aliases, so
 * the mapping's 0.926 coverage and its 10 fixed-dark surfaces are untouched.
 */
export const HARNESS_VERSION_MAX = '0.2.2-rc.5'

/** The qialike CLI's floor, recorded so drift between the two products is visible in review. */
export const CLI_HARNESS_VERSION_MIN = '0.1.0-rc.7'

/**
 * The qialike CLI's ceiling; see {@link CLI_HARNESS_VERSION_MIN}.
 *
 * Moved to 0.2.0-rc.2 alongside {@link HARNESS_VERSION_MAX} because the CLI got there first: its own
 * build already gates on that ceiling, and it is now version 0.9.0. This constant is documentation
 * rather than enforcement — nothing in this build reads it — so leaving it behind would not have
 * broken anything; it would have made the record lie.
 *
 * MOVED TO 0.2.1-alpha.2 AFTER THE CLI GOT THERE, which is the whole point of holding it here. For a
 * few hours this file claimed the opposite — that the CLI's ceiling was still 0.2.0-rc.2 and that the
 * two products had genuinely diverged. That was true when written and false by the time it was read:
 * the CLI landed `5a13a70 feat!: rebuild on deepseek-harness 0.2.1-alpha.2`, which raised its
 * `HARNESS_VERSION_MAX` to the same value and bumped it to 0.10.0. The stale claim is worth recording
 * rather than quietly overwriting, because it is the exact failure this constant exists to catch, and
 * it caught nothing: a comment is not a check. It only works as documentation if someone re-reads it.
 *
 * The two ceilings now agree, so the pair reads as: both products are validated against the same
 * harness range, and this repository's `pnpm build` and the CLI's can both accept the same checkout.
 *
 * What the CLI's rebuild did and did not change for this application:
 *   · It did NOT touch the catalogue surface this build consumes. Measured by importing both the
 *     artifact staged in `dist/runtime` (0.9.3) and the current one (0.10.0): PROVIDER_TEMPLATES
 *     45/45, OPENCODE 2/2, CHINA_GATEWAY 3/3, FOREIGN_GATEWAY 11/11, AZURE 1/1, and
 *     DEEPSEEK_OFFICIAL_ROUTE a string in both — 63 routes either way.
 *   · It DID change `fs-tools`, which this application mounts as the `qialike-fs-tools` row:
 *     5510 -> 5841 bytes. `delete`/`move` now resolve relative paths against the session's CURRENT
 *     directory rather than `policy.workspaceRoot`, so that after a `cd` they name the same file
 *     `write` does. Until this repository is rebuilt, `dist/runtime` stages the OLD build and those
 *     two tools keep the old base. Rebuilding is what picks it up; no source change is needed here.
 *   · `DSH_TOOLS_MODE` needed no work: this application never sets it. And the two new upstream rows
 *     (`working-directory`, `tool-working-directory`) are inherited untouched — which matters, since
 *     the CLI's own note warns that disabling `working-directory` would silently unwire ten plugins
 *     that inject it, Cordis `inject` being "wait", not "fail".
 *   · Both products still share one `$DSH_HOME`, and that remains safe: the session format did not
 *     fork (see {@link HARNESS_VERSION_MAX} — the accepted baseline is still v4 and this range's
 *     surviving persistence changes are all `same-version`).
 */
export const CLI_HARNESS_VERSION_MAX = '0.2.2-rc.5'

/**
 * The qialike CLI release this build is validated against.
 *
 * WHY THE CLI'S OWN VERSION IS A CONTRACT AT ALL. This application does not depend on the CLI as a
 * package — it *stages the CLI's built output into the runtime tree* (`stageQialikeAppPackage` in
 * `own-packages.mjs`): `packages/qialike-app/{package.json,lib}` becomes
 * `dist/runtime/dsh/node_modules/@qialike/qialike-app`. Whatever the checkout last built is therefore
 * frozen into the installer, and the model layer the user gets is that copy — the provider catalogue,
 * the four gateway tables, the wire protocols and the `qialike-llm` row all come from it.
 *
 * WHY EXACT EQUALITY, WHEN THE HARNESS ABOVE IS A RANGE. The harness is a dependency whose API this
 * build adapts to, so a range plus a re-check is the honest shape. The CLI is not adapted to at all:
 * its bytes are copied verbatim, so "a version we have not looked at" and "a version we have not
 * shipped" are the same claim. A patch release is not automatically safe here either — 0.11.0 ->
 * 0.11.1 changed 314 gateway models and fixed two provider `baseURL`s that 404'd on every request,
 * which is precisely the kind of change a provider page shows the user.
 *
 * THE FAILURE THIS EXISTS FOR, WHICH ALREADY HAPPENED. The build's probe for the CLI asks only
 * whether `packages/qialike-app/lib/index.js` EXISTS (`BUILD_PROBES` in `build.mjs`); it never asked
 * which version produced it. So a checkout left at 0.11.0 while this repository expected 0.11.1 built
 * cleanly, passed every gate, and produced an installer whose `latest.yml` said 0.4.1 while the
 * provider layer inside was a release behind. Nothing reported it — the same shape as the stale
 * `CLI_HARNESS_VERSION_MAX` note this file already records ("a comment is not a check").
 *
 * THAT IS WHY THIS ONE IS ENFORCED rather than documented. {@link assertCliCompatible} runs in
 * `build.mjs` next to the harness gate, so the mismatch is a build failure with the remedy in it.
 * Raising this constant is a deliberate act: build the CLI at the new release, re-check the members
 * `types/qialike-app.d.ts` declares still exist, then move the number.
 *
 * 0.11.1 -> 0.11.2 WAS RE-CHECKED, and the check was worth running rather than assuming: this release
 * moves `moss` out of a user file and into `CLASSIC_SCHEMES`, which changes what this build SHIPS (the
 * generated `palettes.js` gains a sixteenth scheme) while touching no provider byte. Verified, not
 * inferred:
 *   · every member `types/qialike-app.d.ts` declares still resolves in the new build — `llm`'s nine,
 *     plus the four gateway tables;
 *   · `llm.js`, `opencode.js`, `china-gateways.js`, `foreign-gateways.js`, `azure.js` and `fs-tools.js`
 *     are BYTE-IDENTICAL to the 0.11.1 build, so the provider catalogue and the gateway tables are
 *     untouched;
 *   · `moss` carries exactly the sixteen palette roles this build's `PALETTE_KEYS` contract demands,
 *     with no extra keys, so the theme extraction accepts it.
 *
 * 0.11.2 -> 0.11.3 WAS RE-CHECKED, and this time `llm.js` DID move (+1.9 KB, 149,097 -> 150,999), so the
 * re-check was not a formality:
 *   · every member `types/qialike-app.d.ts` declares still resolves; the package gained one export
 *     (`parseSse`) and lost none, so nothing this application calls disappeared;
 *   · `PROVIDER_TEMPLATES` is still 45 routes and `DEEPSEEK_OFFICIAL_ROUTE` is still
 *     `deepseek-official`, so the catalogue shape the provider page renders is unchanged;
 *   · the fields that did move are all inside the `qialike` (Bee) route — its model list, a new
 *     `modelsApi` map routing Claude, and a dropped `includeModelPrefixes`. That row ships OFF by
 *     default (`QIALIKE_BEE`, hidden at mount), so it cannot change what a user sees until they turn
 *     it on;
 *   · `opencode.js`, `china-gateways.js`, `foreign-gateways.js`, `azure.js` and `fs-tools.js` are
 *     byte-identical, so the gateway tables and the two workspace mutation tools are untouched.
 *
 * 0.11.3 -> 0.11.4 WAS RE-CHECKED, and it is a BREAKING RENAME rather than a quiet bump:
 *   · every member `types/qialike-app.d.ts` declares still resolves; the package gained
 *     `QIALIKE_BEE_CN_ROUTE` and `QIALIKE_BEE_ROUTES` and lost nothing;
 *   · `PROVIDER_TEMPLATES` went 45 -> 46: Bee now ships TWO deployments, `qialike-bee` (`.com`)
 *     and `qialike-bee-cn` (mainland);
 *   · THE ROUTE WAS RENAMED, `qialike` -> `qialike-bee`. This application holds no literal of it —
 *     the Models page takes the names from this constant — so the rename reached it as a value
 *     rather than as a compile error, which is exactly the shape that needs a re-check;
 *   · both rows sit behind ONE switch that still defaults to off (`DEFAULT_BEE_ENABLED` is
 *     `false`), and the CLI hides the pair together: `if (!resolveBeeEnabled()) for (const route
 *     of QIALIKE_BEE_ROUTES) hiddenRoutes.add(route)`. The page therefore takes a LIST, not a
 *     name — a page that knew only the first would leave the mainland row visible while its
 *     switch read "off", the half-hidden state the CLI's own commit calls out;
 *   · `llm.js` grew by 1,355 bytes; the other five modules are byte-identical.
 *
 * 0.11.4 -> 0.11.5 WAS RE-CHECKED, and it is a PERFORMANCE FIX with no interface change:
 *   · every member `types/qialike-app.d.ts` declares still resolves; the package gained
 *     `dynamicModelsFailure` (and the `DynamicModelsFailure` type) and lost nothing. This
 *     application does not use either — it is the TUI `/models` dialog's "was that a timeout?"
 *     channel — so nothing here needed to change to consume it;
 *   · `PROVIDER_TEMPLATES` stayed at 46 and the route set is identical, `DEEPSEEK_OFFICIAL_ROUTE`
 *     and both `QIALIKE_BEE_ROUTES` are unchanged, so the Models page and the catalogue
 *     expectation are untouched;
 *   · `llm.js` and `models.js` changed; the other five modules are byte-identical.
 *
 * WHY THE BUMP STILL MATTERS DESPITE NO INTERFACE CHANGE: the built `llm.js` now refuses to probe
 * a gateway the user has no credential for, and shortens the budgets — `DYNAMIC_MODELS_TIMEOUT`
 * 4,000 -> 1,500 ms for the picker and a separate 800 ms for the request path. That is a
 * user-visible change in exactly the complaint this application had: the packaged build spent
 * 4,041 ms building the model catalogue because `buildModelCatalog` asks EVERY registered provider
 * (62 of them) and each unconfigured one waited out the full timeout. Measured before the bump:
 * cold `modelCatalog` 2,798 ms; after: 136 ms. A desktop built against 0.11.4 and shipped with a
 * 0.11.5 tree would look identical in code and behave differently, which is precisely the case
 * the version contract exists to make deliberate.
 *
 * 0.11.5 -> 0.11.6 WAS RE-CHECKED, and it is a SITE-SELECTION CHANGE behind the same interfaces:
 *   · every member `types/qialike-app.d.ts` declares still resolves; `PROVIDER_TEMPLATES` stayed at
 *     46 with an identical route set, and `DEEPSEEK_OFFICIAL_ROUTE` and both `QIALIKE_BEE_ROUTES` are
 *     unchanged;
 *   · `llm.js` and `models.js` are BYTE-IDENTICAL to 0.11.5 — the whole provider layer this
 *     application consumes is untouched. Only `index.js` differs: the CLI grew a `site-url` module
 *     and `self-update` now reads the install URL from it;
 *   · the CLI's hero no longer prints a site address, because which deployment a machine should use
 *     cannot be decided at compile time. That removes the only place the CLI and this application
 *     could have disagreed about a URL;
 *   · `site-url` is deliberately NOT exported from the package (`./site-url` is absent from
 *     `exports`), so this application cannot import it even if it wanted to — and it does not: the
 *     Help menu decides by INTERFACE LANGUAGE (`guideUrl`), which is a different question from the
 *     CLI's "where is this machine" (locale territory + time zone). Two questions, two answers,
 *     no shared constant to drift.
 *
 * 0.11.6 -> 0.12.0 WAS RE-CHECKED, and it is a HERO CHANGE plus a harness catch-up:
 *   · every member `types/qialike-app.d.ts` declares still resolves; `PROVIDER_TEMPLATES` stayed at
 *     46 with an identical route set, `DEEPSEEK_OFFICIAL_ROUTE` and both `QIALIKE_BEE_ROUTES` are
 *     unchanged, and `llm.js` exports nothing new and loses nothing;
 *   · ALL SEVEN provider-layer modules are BYTE-IDENTICAL to 0.11.6. Only `index.js` differs, by 92
 *     bytes;
 *   · the hero prints a site address again, and it picks it by SYSTEM LANGUAGE with the same rule
 *     this application's Help menu uses — `zh` reaches `.cn`, everything else `.com`. It is reached
 *     independently on each side (the CLI's own module is not exported from the package), so this is
 *     an agreement by construction, not a shared constant: both read the interface language and both
 *     treat a bare `zh` as Chinese;
 *   · THE ONE PLACE THEY COULD DIFFER is Traditional Chinese: the CLI now keeps `zh_TW` / `zh_HK` /
 *     `zh_MO` / `zh-Hant` on `.com`, while `guideUrl` in `apps/desktop/src/menu.ts` sends every `zh`
 *     tag to `.cn`. That is deliberate and asked for — the user specified "语言为中文 → .cn" for the
 *     Help menu — and it is recorded here rather than silently aligned, because the two surfaces
 *     answer different questions: the hero names the site the binary came from, the Help menu opens
 *     a guide for the person reading it.
 *
 * 0.12.0 -> 0.12.1 -> 0.12.2: A RELEASE THAT WAS WITHDRAWN, AND A CORRECTION TO WHAT I WROTE HERE.
 *
 * 0.12.1 raised four DeepSeek models' limits — `contextWindow` 1,000,000 -> 1,048,576 and
 * `maxTokens` 256,000 -> 393,216 — and this file argued the change made the numbers "correct rather
 * than conservative". The CLI withdrew it the same day, and its reason contradicts that reading:
 *
 *   "抬高每次请求的输出预算会让长会话更早撞上模型的总容量，因此恢复取整值."
 *
 * Raising the per-request output budget makes a long session exhaust the model's total capacity
 * sooner, so the round numbers are the deliberate choice, not a rounding error. 0.12.2 restores
 * them and deletes the whole 0.12.1 change (623 lines: the limit edits, the parser widening for
 * `max_output_tokens` / `context_window` / `input_modalities`, and the audit script).
 *
 * SO THIS APPLICATION IS BACK ON 0.12.0's DATA. Verified rather than assumed: the built-in DeepSeek
 * route reports `contextWindow` 1,000,000 and `maxTokens` 256,000 for all four models again, and
 * `llm.js` is 154,733 bytes — the exact size it had under 0.12.0 — and `models.js` 104,071. Every
 * declared member still resolves; `PROVIDER_TEMPLATES` stayed at 46 with an identical route set;
 * `DEEPSEEK_OFFICIAL_ROUTE` and both `QIALIKE_BEE_ROUTES` are unchanged; no export was added or
 * removed.
 *
 * WHY THE BUMP IS STILL REQUIRED DESPITE THE DATA BEING 0.12.0's. The version string is what the
 * gate compares, and a tree whose numbers happen to match 0.12.0 while claiming to be 0.12.1 is the
 * state that hides the next real change: someone would read 0.12.1 in `package.json`, believe the
 * audited limits were in effect, and skip the re-check. Pinning 0.12.2 records which release these
 * bytes came from.
 *
 * FOR THIS APPLICATION THE OBSERVABLE EFFECT IS A REVERTED DISPLAY. The provider page reports
 * `contextWindow` per model and the composer reads limits through `active-model`, so a user on
 * 0.12.1 would have seen 1,048,576 / 393,216 and now sees 1,000,000 / 256,000. The metadata repair
 * in this version fills profiles with whichever values the pinned CLI carries, which is why the pin
 * and the repair belong to one release.
 *
 * 0.12.2 -> 0.13.0 WAS RE-CHECKED, and it is an adaptation release whose whole subject is the harness
 * bump above:
 *   · every member `types/qialike-app.d.ts` declares still resolves; `PROVIDER_TEMPLATES` stayed at
 *     46 with an identical route set; `DEEPSEEK_OFFICIAL_ROUTE` and both `QIALIKE_BEE_ROUTES` are
 *     unchanged; no export was added or removed;
 *   · ALL SEVEN provider-layer modules are BYTE-IDENTICAL to 0.12.2 — `llm.js`, `models.js`,
 *     `opencode.js`, `china-gateways.js`, `foreign-gateways.js`, `azure.js`, `fs-tools.js`. Only
 *     `index.js` differs, by 17 bytes. So the model limits, the catalogue and the effort tables this
 *     application displays are untouched by this bump;
 *   · what 0.13.0 actually fixes, per its changelog, are harness-shape mismatches in the CLI's own
 *     patches: `writableRoots` anchors, the `workspace-write` prompt sentence under two spellings,
 *     `agent.model.select()` -> a caller-held `ModelSelectionRef`, and `DSH_TOOLS_MODE=ptc`'s
 *     `tools.mode`. None of those reach this application: we mount the CLI's provider layer, not its
 *     TUI patches, and our Host talks to the harness through `collectIndexInjections` and
 *     `buildModelCatalog`, both re-checked above;
 *   · the last item — MCP servers that do not advertise resources no longer write diagnostics to
 *     stdout — does reach us, as one less source of stray output in a process whose stdout the
 *     shell reads.
 *
 * 0.13.0 -> 0.14.0 IS THE CLI'S OWN ADAPTATION TO THE SAME HARNESS BUMP, and it consumes none of the
 * four things it had to fix for itself:
 *   · every member `types/qialike-app.d.ts` declares still resolves; `PROVIDER_TEMPLATES` stayed at
 *     46 with an identical route set; `DEEPSEEK_OFFICIAL_ROUTE` and both `QIALIKE_BEE_ROUTES` are
 *     unchanged; no export was added or removed;
 *   · ALL SEVEN provider-layer modules are BYTE-IDENTICAL to 0.13.0, so the model catalogue, the
 *     limits and the effort tables this application displays do not move with this bump. Only
 *     `index.js` differs, by 17 bytes;
 *   · what 0.14.0 fixes is TUI-side and does not reach us: `writableRoots` anchors, `agent.model`
 *     coming back to the Agent, `tools.config.mode` becoming `z.never()` after the executors moved
 *     out of `dsh-tools`, and a `rrule` CJS-interop failure that only Bun's resolver hits;
 *   · TWO OF ITS `变更` ENTRIES DO DESCRIBE SHARED BEHAVIOUR, and both are already this
 *     application's position: `fs-observation-policy` stays ON here (the CLI pins it explicitly
 *     because 0.2.2 defaults it off), and the new `agent-team` row simply arrives through the
 *     web-app bundle — we neither mount nor suppress it.
 *
 * 0.15.0 ADAPTS THE CLI TO THE SAME HARNESS BUMP AND CONSUMES NOTHING THIS APPLICATION USES. Its
 * seven changelog entries describe: the version pin, `PROVIDER_ERROR` surviving `LlmError` being
 * narrowed to harness code unions (via `LlmError.fromFailure`), a temp-sweep anchor, a third
 * spelling of the workspace-write sentence, the Windows grant moved off the UI thread, and `glob` /
 * `grep` finding their own ripgrep again after resolution moved into `dsh-util-ripgrep`.
 *
 * CHECKED RATHER THAN ASSUMED: every member `types/qialike-app.d.ts` declares still resolves,
 * `PROVIDER_TEMPLATES` is still 46 with an identical route set, and all seven provider-layer modules
 * are byte-identical to 0.14.0 apart from `llm.js` — where `LlmError.fromFailure` is exactly the
 * change its changelog describes, and it keeps this adapter's own error codes intact rather than
 * mapping them onto a built-in one.
 *
 * 0.16.0 ADAPTS THE CLI TO THE SAME HARNESS BUMP. Its changelog lists three things and only the first
 * touches us:
 *   · the version pin, which is this file;
 *   · SAME `searchProvider` DECISION, reached independently and pinned here too — its two arguments
 *     are the ones recorded above, and the baseURL-override one applies to this product identically
 *     because the provider layer is shared;
 *   · Anthropic content refusals now fail with `CONTENT_REFUSED` instead of ending as a normal stop,
 *     which is TUI-side handling but arrives through `llm.js` — the one provider module that differs
 *     from 0.15.0, by 14 lines, all of them that change. The other six are byte-identical, so the
 *     catalogue, limits and effort tables this application displays do not move.
 */
export const CLI_VERSION = '0.16.0'

/** Read and parse a JSON file, with the path in the failure. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`qialike-desktop: cannot read ${file}: ${error.message}`)
  }
}

/**
 * Detect the harness version of a checkout.
 *
 * The nearest git tag wins so a checkout sitting between releases reports the
 * release it descends from, matching the CLI's behaviour. A checkout with no
 * tags falls back to the root manifest.
 *
 * @param harnessRoot - absolute checkout path.
 * @returns the version string, with any `dsh-v` tag prefix stripped.
 * @throws Error when neither source yields a version.
 */
export function detectHarnessVersion(harnessRoot, run = defaultRun) {
  try {
    const tag = run('git', ['-C', harnessRoot, 'describe', '--tags', '--abbrev=0']).trim()
    if (tag.length > 0) return tag.replace(/^dsh-v/, '')
  } catch {
    // Not a git checkout, or it carries no tags: fall through to the manifest.
  }
  const manifest = join(harnessRoot, 'package.json')
  if (!existsSync(manifest)) {
    throw new Error(`qialike-desktop: no harness checkout at ${harnessRoot} (no package.json)`)
  }
  const version = readJson(manifest).version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`qialike-desktop: ${manifest} declares no version`)
  }
  return version.replace(/^dsh-v/, '')
}

/** Run a command, throwing on a non-zero exit; injected so tests need no git. */
function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`)
  return result.stdout ?? ''
}

/**
 * Assert a detected version is inside the validated range.
 *
 * @param version - the version {@link detectHarnessVersion} returned.
 * @returns the version, for chaining.
 * @throws Error explaining both the range and how to proceed.
 */
export function assertVersionInRange(version) {
  if (!semver.valid(version) && !semver.valid(semver.coerce(version))) {
    throw new Error(
      `qialike-desktop: deepseek-harness reports version ${JSON.stringify(version)}, which is not `
      + `a semantic version. Point ${DSH_HARNESS_ENV} at a release checkout.`,
    )
  }
  const normalized = semver.valid(version) ?? String(semver.coerce(version))
  // Explicit gte/lte rather than a range string: a range bound carrying a
  // pre-release only matches same-tuple pre-releases, so `>=0.1.0-rc.7` would
  // wrongly reject every historical 0.1.x release. The CLI documents the same
  // trap; this keeps the two implementations agreeing.
  if (!(semver.gte(normalized, HARNESS_VERSION_MIN) && semver.lte(normalized, HARNESS_VERSION_MAX))) {
    const direction = semver.gt(normalized, HARNESS_VERSION_MAX) ? 'newer' : 'older'
    throw new Error(
      `qialike-desktop: deepseek-harness ${normalized} is outside the validated range `
      + `(${HARNESS_VERSION_MIN} .. ${HARNESS_VERSION_MAX}). This checkout is ${direction} than any `
      + 'release this application was checked against.\n'
      + '  · To use it anyway: re-validate the id-targeted rows in '
      + 'packages/qialike-desktop-app/cordis.patch.yml and the build-time patch anchors, '
      + 'then raise HARNESS_VERSION_MAX in apps/desktop-bin/lib/harness-version.mjs.\n'
      + `  · Otherwise: point ${DSH_HARNESS_ENV} at a checkout inside the range.`,
    )
  }
  return normalized
}

/**
 * Detect the harness version and assert it is in range.
 * @param harnessRoot - absolute checkout path.
 * @returns the validated version.
 */
export function assertHarnessCompatible(harnessRoot, run) {
  return assertVersionInRange(detectHarnessVersion(harnessRoot, run))
}

/** The CLI package directory, relative to its checkout. One definition, three readers. */
export const CLI_APP_DIR = join('packages', 'qialike-app')

/**
 * Read the version of the CLI's app package in a checkout.
 *
 * The *built* package's manifest, not the checkout's root one: `stageQialikeAppPackage` copies
 * `packages/qialike-app/{package.json,lib}`, so this is the version that ends up in the runtime tree
 * and is shown to nobody until a provider row misbehaves. Reading the root manifest would compare
 * against a number that never reaches the artifact.
 *
 * @param cliRoot - absolute path to the qialike checkout.
 * @returns the version string.
 * @throws Error when the package or its version is missing.
 */
export function detectCliVersion(cliRoot) {
  const manifest = join(cliRoot, CLI_APP_DIR, 'package.json')
  if (!existsSync(manifest)) {
    throw new Error(`qialike-desktop: no qialike CLI app package at ${manifest} (no package.json)`)
  }
  const version = readJson(manifest).version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`qialike-desktop: ${manifest} declares no version`)
  }
  return version
}

/**
 * Assert the CLI checkout is the release this build was validated against.
 *
 * Enforced rather than documented, because the failure it catches is invisible in the artifact: the
 * installer carries the staged copy, so a stale checkout produces a correctly-numbered build (see
 * {@link CLI_VERSION}).
 *
 * @param cliRoot - absolute path to the qialike checkout.
 * @param detect - version reader, injected so tests need no checkout.
 * @returns the validated version, for the build's log line.
 * @throws Error naming both versions and the remedy.
 */
export function assertCliCompatible(cliRoot, detect = detectCliVersion) {
  const version = detect(cliRoot)
  if (version === CLI_VERSION) return version
  const direction = semver.gt(version, CLI_VERSION) ? 'newer' : 'older'
  throw new Error(
    `qialike-desktop: the qialike CLI checkout is ${version}, but this build is validated against `
    + `${CLI_VERSION} (${direction}).\n`
    + `  · Its built output is copied into the runtime tree, so an installer built here would ship a `
    + `provider layer that is not the one this application was checked against.\n`
    + `  · To use ${version}: re-check the members types/qialike-app.d.ts declares still exist, then `
    + 'raise CLI_VERSION in apps/desktop-bin/lib/harness-version.mjs.\n'
    + `  · Otherwise: build the checkout at ${CLI_VERSION} — cd into it and run its own build, because `
    + 'lib/ is what gets staged and a version string without a rebuild changes nothing.',
  )
}
