/**
 * Point the Office preview's "unavailable" message at the place that can fix it.
 *
 * WHY THIS PATCH EXISTS. When the document engine cannot start, the preview renders a sentence and
 * a Retry button. Upstream's sentence says the document preview *service* is not enabled on the
 * computer running the harness — which was the only cause it knew about, and describes a situation
 * the user has no control over. In this product there is now a second cause and a control for it:
 * a build may deliberately leave the engine out, and Settings has a row that installs one. Retrying
 * cannot help with either, so a message that only says "unavailable" leaves the user with a button
 * that fails and no way to learn why.
 *
 * WHY IT NAMES SETTINGS RATHER THAN A SECTION. The section label belongs to the harness's own
 * dictionaries and may be renamed or reorganised; naming it here would put a second copy of that
 * name in this repository, wrong the moment it moves. The row's own title is "Office previews",
 * which is the same subject as this message, so the destination is findable from the sentence
 * alone. Settings is also the honest place to look in *both* causes: on a build that bundles the
 * engine, the row reports that it is included, which tells the user the engine is present and the
 * fault is elsewhere.
 *
 * WHY THE EXACT STRING AND NOT A KEY. The value being replaced is a dictionary *value*; the keys
 * (`office.unavailable` and its siblings) are stable, so the replacement is anchored on the value
 * and the marker is written beside it. A missing string is an error rather than a no-op: a silent
 * no-op would ship the old message and nothing would say the patch had stopped applying — the
 * failure mode `tests/` and the other patches in this directory are each written against.
 *
 * @module qialike-desktop/harness-patches/office-engine-message
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Idempotency marker, appended to each replacement. */
export const OFFICE_MESSAGE_MARKER = 'qialike:office-engine-message'

/**
 * The farm files carrying the sentence.
 *
 * The built bundle is what the browser loads, so it is the one that matters. The compiled copy under
 * `lib/types/` is shipped too and is patched so the two cannot disagree; the `.ts` source and the
 * source map are removed later by `pruneNonRuntimeFiles`, so they are deliberately not touched.
 */
export const OFFICE_MESSAGE_TARGETS = [
  '-deepseek-ai-dsh-client-ui-sidebar-documentpreview/lib/client.js',
  '-deepseek-ai-dsh-client-ui-sidebar-documentpreview/lib/types/client/office/locales.js',
]

/**
 * The sentences to replace, by language.
 *
 * Measured from the farm rather than guessed: both spellings are the ones upstream ships today, and
 * the test asserts they are still there so a reworded upstream turns this into a build failure
 * instead of a quietly unpatched tree.
 *
 * THE DESTINATION IS A PLUGINS TAB, AND THE SENTENCE HAS TO SAY SO. These two `to` values named
 * "Settings → General → Office previews" from 0.4.5 until 0.4.7, and the row moved to the Built-in
 * plugins page in 0.4.6 — the same release that taught `packages/qialike-desktop-office-engine` to
 * register into `settings.plugins.tab`. Nothing tied the two together, so for one release the
 * application told every user to open a place that no longer contains the row. The name of the page
 * is the harness's (`ui-settings-plugins` calls its nav entry "内置插件" / "Built-in plugins"); it is
 * spelled out here for the same reason the sentence spells out "Settings" at all — a message that
 * sends the reader looking is worse than no message.
 */
export const OFFICE_MESSAGE_REPLACEMENTS = [
  {
    from: 'Office previews are unavailable. Enable the document preview service on the computer running DeepSeek Harness.',
    to: 'Office previews need the document engine, which is not installed. Open Settings → Built-in plugins → Office previews and choose Install.',
  },
  {
    from: 'Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。',
    to: 'Office 预览需要文档引擎，而它尚未安装。请在“设置 → 内置插件 → Office 预览”中点击“安装文档引擎”。',
  },
]

/**
 * Apply the patch to a farm.
 *
 * @param options.root - the farm root (never the harness checkout).
 * @param options.log - progress sink.
 * @returns the files written.
 * @throws Error when a target is absent, or when a target carries neither the original sentence nor
 *   the marker — the two cases where this patch would otherwise do nothing.
 */
export function patchOfficeEngineMessage({ root, log = () => {} }) {
  const written = []
  for (const target of OFFICE_MESSAGE_TARGETS) {
    const path = join(root, target)
    if (!existsSync(path)) {
      throw new Error(
        `qialike-desktop: the office-message target ${target} is missing from the farm at ${root}. `
        + 'Either the harness renamed @deepseek-ai/dsh-client-ui-sidebar-documentpreview, or the farm '
        + 'is incomplete. Update OFFICE_MESSAGE_TARGETS in '
        + 'apps/desktop-bin/harness-patches/office-engine-message.mjs.',
      )
    }
    const text = readFileSync(path, 'utf8')
    if (text.includes(OFFICE_MESSAGE_MARKER)) {
      log(`office-message: already applied (${target})`)
      written.push(target)
      continue
    }
    let patched = text
    let replaced = 0
    for (const { from, to } of OFFICE_MESSAGE_REPLACEMENTS) {
      if (!patched.includes(from)) continue
      // A plain split/join rather than a RegExp: the sentences contain punctuation a pattern would
      // have to escape, and there is nothing here that needs matching beyond literal equality.
      patched = patched.split(from).join(to)
      // THE MARKER GOES OUTSIDE THE STRING, AND THAT IS THE WHOLE POINT OF THIS STEP. `from` and `to`
      // are dictionary VALUES — the text between the quotes — so appending the marker to `to` put it
      // inside the literal, where it was not a comment at all but part of the sentence. It shipped
      // that way in 0.3.10 and 0.3.11: the preview panel told users to install the engine and then
      // showed them `/* qialike:office-engine-message */`. A block comment placed after the closing
      // quote is still inside the object literal, so it cannot swallow a following comma the way a
      // `//` comment would, and it is invisible to the reader.
      const at = patched.indexOf(to)
      const close = patched[at + to.length]
      // A BACKTICK COUNTS AS A CLOSING QUOTE TOO. Harness 0.2.2-rc.3 ships minified client
      // bundles, and the minifier emits dictionary values with backticks; accepting only the two
      // quote characters turned a successful replacement into a hard failure here.
      if (close !== "'" && close !== '"' && close !== '`') {
        throw new Error(
          `qialike-desktop: replaced the Office message in ${target} but the character after it is `
          + `${JSON.stringify(close)}, not a quote. The dictionary's shape changed, so the idempotency `
          + 'marker cannot be placed outside the string. Update this patch in '
          + 'apps/desktop-bin/harness-patches/office-engine-message.mjs.',
        )
      }
      patched = `${patched.slice(0, at + to.length + 1)} /* ${OFFICE_MESSAGE_MARKER} */`
        + patched.slice(at + to.length + 1)
      replaced += 1
    }
    if (replaced === 0) {
      throw new Error(
        `qialike-desktop: ${target} carries neither the Office unavailable message nor the marker, so `
        + 'this patch would change nothing. The harness reworded it; update '
        + 'OFFICE_MESSAGE_REPLACEMENTS in apps/desktop-bin/harness-patches/office-engine-message.mjs.\n'
        + '  · Do not delete this patch: without it the preview tells the user the document preview '
        + 'service is not enabled, and never mentions that Settings can install one.',
      )
    }
    writeFileSync(path, patched)
    log(`office-message: redirected ${String(replaced)} locale(s) to Settings (${target})`)
    written.push(target)
  }
  return written
}
