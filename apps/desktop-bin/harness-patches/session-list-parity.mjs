/**
 * Build-time patch: make a Workspace's Session list in the desktop sidebar equal the CLI's list for the same
 * directory.
 *
 * WHY THE TWO LISTS DIFFERED AT ALL. The sidebar groups Sessions by Workspace, and the membership of a group
 * is the Workspace registry's `sessionIds` — a list of Sessions that were *attached* to that Workspace. A
 * Session that exists on disk under the same `cwd` but was never attached is therefore not a member of any
 * group, and trails in Ungrouped. Two further rules differed from the CLI:
 *
 *   · the sidebar hid `origin === "subagent"` outright; and
 *   · the Host's `blank` bit is cleared only by `turn/start`, while the CLI's `foldSessionBlank` also clears it
 *     on `user/message`, `assistant/message` and `tool/result`.
 *
 * MEASURED, NOT ASSUMED (2026-10-12, this machine). For Workspace `/home/pipo/deepseek/qialike`: the CLI lists
 * 6 Sessions; the sidebar listed 3. The three missing ones were subagent children — neither attached (so not
 * members) nor visible (the `origin` filter) — while a fourth difference, the `blank` rule, turned out to have
 * no observable effect here at all (it disagrees with the CLI on 0 of the 47 Sessions in the corpus). It is
 * aligned anyway, because it is the same concept defined twice and a future event shape would expose it.
 *
 * WHAT THIS PATCH DOES NOT CHANGE, deliberately. Every registered Workspace is still listed, with its title and
 * order, and Sessions whose `cwd` matches no registered Workspace still trail in Ungrouped. Listing several
 * Workspaces is this application's own feature, not a discrepancy — only the membership of a Workspace's own
 * group is widened, by the one rule the CLI uses: the directory a Session records in its header.
 *
 * THE ANCHORS ARE CODE, NOT PROSE. Each is asserted to occur exactly once before anything is written; a moved
 * anchor throws with the constant to update rather than quietly patching nothing. The patch is idempotent: it
 * writes {@link SESSION_LIST_PARITY_MARKER} into each file it edits, and a second run returns without touching
 * them. A farm is rebuilt from scratch often, so both paths matter.
 *
 * WHY THIS IS A PATCH AND NOT OUR OWN SIDEBAR. The list, its grouping and its visibility rules are the
 * harness's published client bundle, consumed as an artifact (`web-shadow.mjs` explains why it cannot be
 * rebuilt here). Its own locale dictionaries are already patched by `brand-title.mjs` and `hero-headline.mjs`,
 * so the seam and its conventions exist; replacing the sidebar would mean owning a far larger surface.
 *
 * @module qialike-desktop/harness-patches/session-list-parity
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Idempotency marker, written into both edited files. */
export const SESSION_LIST_PARITY_MARKER = 'qialike:session-list-parity'

/** The sidebar's client bundle: grouping, membership and visibility. */
export const CLIENT_TARGET = '-deepseek-ai-dsh-client-ui-workspace/lib/client.js'

/** The Host bundle that folds the `blank` bit into the Session list projection. */
export const HOST_TARGET = '-deepseek-ai-dsh-api-session-controller/lib/index.js'

/** The event types the CLI's `foldSessionBlank` treats as conversation, and so as not-blank. */
export const CONVERSATION_EVENT_TYPES = ['user/message', 'assistant/message', 'tool/result']

/**
 * The exact text this patch anchors on, exported so the test can build a fixture from it rather than restating
 * it — a fixture that spells the anchor differently would pass while the real patch failed.
 */
export const ANCHORS = {
  /**
   * THE CLIENT ANCHORS SHIP IN TWO SPELLINGS, AND BOTH MUST MATCH.
   *
   * Harness 0.2.2-rc.3 minifies its client bundles: whitespace is gone, `"…"` became `` `…` `` and
   * the operator spacing went with it. The IDENTIFIERS are untouched — `workspace`, `list`,
   * `rowState` all survive — so these are formatting differences, not a change of shape, and a
   * literal-only anchor reported "0 occurrences" against a bundle that still had the code.
   *
   * Each entry is therefore a LIST of accepted spellings: the pretty one this patch was written
   * against, and the minified one. The patch tries them in order and requires exactly one of them to
   * occur once, so a genuine upstream rewrite still fails loudly instead of silently matching
   * nothing.
   */
  subagent: [
    '\t\t\tif (session.origin === "subagent") return false;\n',
    'if(session.origin===`subagent`)return false;',
  ],
  /** The membership loop: the only place a group's members are collected for rendering. */
  renderLoop: [
    '\t\t\t\tfor (const id of workspace.sessionIds) {\n',
    'for(const id of workspace.sessionIds){',
  ],
  /** Ungrouped's membership, which must use the same accounting or a Session would appear twice. */
  ungrouped: [
    '\t\t\t\tconst accounted = new Set(workspaces.flatMap((workspace) => workspace.sessionIds));\n'
      + '\t\t\t\treturn list.ids.filter((id) => list.byId[id] !== void 0 && !accounted.has(id));',
    'const accounted=new Set(workspaces.flatMap(workspace=>workspace.sessionIds));'
      + 'return list.ids.filter(id=>list.byId[id]!==void 0&&!accounted.has(id)',
  ],
  /** The same accounting on the pin path, so a pin write agrees with what is rendered. */
  pinAccounted: [
    '\t\tfunction pinOrderSource(workspaces, list, rowState) {\n'
      + '\t\t\tconst accounted = new Set(workspaces.flatMap((workspace) => workspace.sessionIds));',
    'function pinOrderSource(workspaces,list,rowState){'
      + 'const accounted=new Set(workspaces.flatMap(workspace=>workspace.sessionIds));',
  ],
  /** The pin path's per-Workspace member map. */
  pinMembers: [
    '...workspaces.map((workspace) => [workspace.workspaceId, workspace.sessionIds]),',
    '...workspaces.map(workspace=>[workspace.workspaceId,workspace.sessionIds])',
  ],
  /** Where the two helpers are inserted. */
  groupFunction: [
    '\t\tfunction groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder) {',
    'function groupByWorkspace(list,workspaces,archived,archivedFilter,ungroupedOrder){',
  ],
  /** The Host's blank fold. */
  blank: '\tconst blank = state.blank && event.type !== "turn/start";\n',
  /** Where the conversation-type set is inserted, next to the fold it belongs to. */
  foldFunction: 'function applySessionListMetadata(state, event) {',
}

/**
 * The helpers inserted into the client bundle.
 *
 * Membership is expressed once and used in four places (render grouping, Ungrouped's complement, and the pin
 * path's two maps). Spelling the rule out four times is how the four would drift apart, so the patch adds one
 * function and points all four at it.
 */
const CLIENT_HELPERS = `\t\t/**
\t\t* Every Session this Workspace's group shows: the registry's attached ids, plus every Session whose header
\t\t* cwd is this Workspace's path. ${SESSION_LIST_PARITY_MARKER} — the second half is what makes the group
\t\t* equal the CLI's list for the same directory, because the CLI has no registry and groups by cwd alone.
\t\t*
\t\t* A Session already in \`sessionIds\` is never added twice, so a Workspace that attached a Session keeps it
\t\t* in the registry's own position rather than moving it to the end.
\t\t*
\t\t* @param workspace - a Host Workspace view (its \`path\` and \`sessionIds\`).
\t\t* @param list - the Session list snapshot.
\t\t* @returns member ids, registry order first.
\t\t*/
\t\tfunction qialikeWorkspaceMemberIds(workspace, list) {
\t\t\tconst ids = [...workspace.sessionIds];
\t\t\tconst known = new Set(ids);
\t\t\tfor (const id of list.ids) {
\t\t\t\tconst summary = list.byId[id];
\t\t\t\tif (summary === void 0 || known.has(id)) continue;
\t\t\t\tif (summary.cwd !== void 0 && summary.cwd === workspace.path) {
\t\t\t\t\tids.push(id);
\t\t\t\t\tknown.add(id);
\t\t\t\t}
\t\t\t}
\t\t\treturn ids;
\t\t}
\t\t/**
\t\t* The complement used by Ungrouped: every id any Workspace group claims. ${SESSION_LIST_PARITY_MARKER} —
\t\t* it must be derived from the same function the groups are built from, or a Session would be listed twice.
\t\t*
\t\t* @param workspaces - current Host Workspaces.
\t\t* @param list - the Session list snapshot.
\t\t* @returns the accounted ids.
\t\t*/
\t\tfunction qialikeAccountedSessionIds(workspaces, list) {
\t\t\tconst accounted = new Set();
\t\t\tfor (const workspace of workspaces) {
\t\t\t\tfor (const id of qialikeWorkspaceMemberIds(workspace, list)) accounted.add(id);
\t\t\t}
\t\t\treturn accounted;
\t\t}
`

/**
 * Apply the client half: show subagent children, and take group membership from cwd as well as the registry.
 *
 * @param options.root - the farm root (never the harness checkout).
 * @param options.log - progress sink.
 * @returns the files written.
 * @throws Error when the file or one of the anchors is absent.
 */
export function patchSessionListParityClient({ root, log = () => {} }) {
  const path = join(root, CLIENT_TARGET)
  if (!existsSync(path)) {
    throw new Error(
      `qialike-desktop: the session-list-parity target ${CLIENT_TARGET} is missing from the farm at ${root}. `
      + 'Either the harness renamed @deepseek-ai/dsh-client-ui-workspace, or the farm is incomplete. '
      + 'Update CLIENT_TARGET in apps/desktop-bin/harness-patches/session-list-parity.mjs.',
    )
  }
  const original = readFileSync(path, 'utf8')
  if (original.includes(SESSION_LIST_PARITY_MARKER)) {
    log(`session-list-parity: client already applied (${CLIENT_TARGET})`)
    return [CLIENT_TARGET]
  }

  // Every anchor is checked before anything is written, so a moved anchor names itself instead of leaving a
  // half-patched bundle behind.
  // ONE ANCHOR PER NAME, CHOSEN FROM THE ACCEPTED SPELLINGS. Exactly one spelling must occur exactly
  // once: zero means upstream rewrote it (fail loudly), and more than one means the file has two
  // candidate sites and picking one would be a guess.
  // THE CLIENT ANCHORS ONLY. `blank` and `foldFunction` are Host-side strings, not lists, and
  // iterating the whole object would hand `.filter` a string.
  const chosen = {}
  for (const name of ['subagent', 'renderLoop', 'ungrouped', 'pinAccounted', 'pinMembers', 'groupFunction']) {
    const spellings = ANCHORS[name]
    const matches = spellings.filter((spelling) => (original.split(spelling).length - 1) === 1)
    if (matches.length !== 1) {
      const counts = spellings.map((spelling) => String(original.split(spelling).length - 1)).join('/')
      throw new Error(
        `qialike-desktop: the session-list-parity anchor '${name}' matched ${String(matches.length)} `
        + `of its ${String(spellings.length)} accepted spellings (occurrence counts ${counts}; exactly `
        + `one must occur once). Upstream rewrote it — read ANCHORS.${name} in `
        + 'apps/desktop-bin/harness-patches/session-list-parity.mjs and add the new spelling.',
      )
    }
    chosen[name] = matches[0]
  }

  const patched = original
    // The subagent exclusion goes away: the CLI lists these Sessions, and the sidebar's own lineage
    // presentation reads them from the conversation plugin rather than from this list.
    .replace(
      chosen.subagent,
      `\t\t\t// ${SESSION_LIST_PARITY_MARKER}: subagent children are listed here, as the CLI lists them.\n`,
    )
    .replace(chosen.renderLoop, '\t\t\t\tfor (const id of qialikeWorkspaceMemberIds(workspace, list)) {\n')
    .replace(
      chosen.ungrouped,
        chosen.ungrouped.endsWith(');')
          // The pretty anchor ends at the closing `);`, so the replacement must close it too.
          ? '\t\t\t\tconst accounted = qialikeAccountedSessionIds(workspaces, list);\n'
            + '\t\t\t\treturn list.ids.filter((id) => list.byId[id] !== void 0 && !accounted.has(id));'
          // THE MINIFIED ANCHOR STOPS BEFORE THE CLOSING `)`, because the patch cut it there to
          // keep the two spellings parallel. Appending `);` then closed a call the caller still
          // closes, giving `...has(id)));` — one paren too many, so the bundle did not parse.
          : '\t\t\t\tconst accounted = qialikeAccountedSessionIds(workspaces, list);\n'
            // NO CLOSING PAREN HERE: the minified anchor stops before the `)` that closes `filter`,
            // so the original tail still supplies it. Adding one produced `has(id)))})`.
            + '\t\t\t\treturn list.ids.filter((id) => list.byId[id] !== void 0 && !accounted.has(id)',
    )
    .replace(
      chosen.pinAccounted,
      '\t\tfunction pinOrderSource(workspaces, list, rowState) {\n'
      + '\t\t\tconst accounted = qialikeAccountedSessionIds(workspaces, list);',
    )
    .replace(
      // THE TRAILING COMMA FOLLOWS THE SPELLING THAT MATCHED. The minified anchor already ends
      // inside an array literal whose next element comes immediately, so appending this patch's
      // own comma produced `...]),,[``,` — a syntax error that failed to PARSE, which is why
      // the application hung on "Loading plugins…" with an empty console.
      chosen.pinMembers,
        chosen.pinMembers.endsWith(',')
          ? '...workspaces.map((workspace) => [workspace.workspaceId, qialikeWorkspaceMemberIds(workspace, list)]),'
          : '...workspaces.map((workspace) => [workspace.workspaceId, qialikeWorkspaceMemberIds(workspace, list)])',
    )
    .replace(chosen.groupFunction, CLIENT_HELPERS + chosen.groupFunction)

  writeFileSync(path, patched)
  log(`session-list-parity: client patched (${CLIENT_TARGET})`)
  return [CLIENT_TARGET]
}

/**
 * Apply the Host half: clear the `blank` bit on the same events the CLI does.
 *
 * @param options.root - the farm root (never the harness checkout).
 * @param options.log - progress sink.
 * @returns the files written.
 * @throws Error when the file or an anchor is absent.
 */
export function patchSessionListParityHost({ root, log = () => {} }) {
  const path = join(root, HOST_TARGET)
  if (!existsSync(path)) {
    throw new Error(
      `qialike-desktop: the session-list-parity target ${HOST_TARGET} is missing from the farm at ${root}. `
      + 'Either the harness renamed @deepseek-ai/dsh-api-session-controller, or the farm is incomplete. '
      + 'Update HOST_TARGET in apps/desktop-bin/harness-patches/session-list-parity.mjs.',
    )
  }
  const original = readFileSync(path, 'utf8')
  if (original.includes(SESSION_LIST_PARITY_MARKER)) {
    log(`session-list-parity: host already applied (${HOST_TARGET})`)
    return [HOST_TARGET]
  }

  for (const [name, anchor] of Object.entries({ blank: ANCHORS.blank, foldFunction: ANCHORS.foldFunction })) {
    const count = original.split(anchor).length - 1
    if (count !== 1) {
      throw new Error(
        `qialike-desktop: the session-list-parity anchor '${name}' occurs ${String(count)} times in `
        + `${HOST_TARGET} (expected exactly 1). Upstream moved it — read ANCHORS.${name} in `
        + 'apps/desktop-bin/harness-patches/session-list-parity.mjs and update it.',
      )
    }
  }

  const setLiteral = `new Set([${CONVERSATION_EVENT_TYPES.map((type) => `"${type}"`).join(', ')}])`
  const declaration = `/**
* Conversation events that clear the list's \`blank\` bit. ${SESSION_LIST_PARITY_MARKER}
*
* The CLI's \`foldSessionBlank\` treats a Session as non-blank once it has seen a \`turn/start\` OR any
* conversation event; this fold originally looked at \`turn/start\` alone. The two definitions of one concept
* disagree on nothing in today's corpus (measured: 0 of 47 Sessions), and they are aligned here so that a
* Session which records a message without a turn boundary is listed by both products rather than by one.
*/
const QIALIKE_CONVERSATION_EVENT_TYPES = ${setLiteral};
`
  const patched = original
    .replace(ANCHORS.foldFunction, declaration + ANCHORS.foldFunction)
    .replace(
      ANCHORS.blank,
      '\tconst blank = state.blank && event.type !== "turn/start" '
      + '&& !QIALIKE_CONVERSATION_EVENT_TYPES.has(event.type);\n',
    )

  writeFileSync(path, patched)
  log(`session-list-parity: host patched (${HOST_TARGET})`)
  return [HOST_TARGET]
}
