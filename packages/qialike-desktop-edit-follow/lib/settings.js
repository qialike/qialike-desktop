/**
 * The edit-follow switch: where it is stored, how it is read, and what a mutation may do.
 *
 * WHY THIS IS A MODULE OF ITS OWN, SEPARATE FROM THE ROW. The row imports
 * `@deepseek-ai/dsh-home-paths` for the default document path, and that package resolves
 * only in the assembled runtime tree — not in this repository's `node_modules`. Anything
 * importing it therefore cannot be unit-tested here at all, which is why the theme row's
 * own tests boot a composed profile to reach its route. Splitting the storage rules out
 * means the merge, the default and the validation are covered by fast unit tests, and the
 * row is left holding nothing but wiring.
 *
 * WHY THE FILE IS `qialike.json` AND NOT THE HARNESS'S SETTINGS DOCUMENT. The harness's
 * settings document belongs to a *profile*, so a value written there is invisible to the
 * CLI's profiles — the wall the theme and providers rows also hit. `qialike.json` is the
 * file both products read.
 *
 * WHY THE SECTION IS NAMED `desktop_edit_follow`. The CLI types its own sections as a
 * closed union (`PluginSectionKey`) that this repository must not extend, so the name has
 * to be one it does not already own. Its `writeSection()` persists by spreading the
 * document it just read, so an unknown top-level key survives a CLI write. `tests/
 * edit-follow-settings.test.mjs` asserts that property rather than assuming it, because it
 * belongs to another repository.
 *
 * The write mirrors the CLI's `persistConfig()` — merge rather than replace, two-space
 * JSON, trailing newline, mode 0600, because this document holds the user's whole
 * configuration for a shared home — with one deliberate improvement: this write is
 * atomic, and the CLI's is not.
 *
 * @module @qialike/qialike-desktop-edit-follow/settings
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The `qialike.json` section this row owns. */
export const SECTION = 'desktop_edit_follow'

/** The key inside that section. */
export const ENABLED_KEY = 'enabled'

/**
 * What the switch is when the file, the section, or the key says nothing.
 *
 * On, and the analysis document records why that is defensible here and not in an editor:
 * this application has no editor, so watching the agent work is the main activity rather
 * than something that competes with the user's own typing. It is only defensible together
 * with the quieting rules the bundle implements — never while the column is collapsed,
 * stop when the user takes over, never for subagents.
 */
export const DEFAULT_ENABLED = true

/**
 * Read the configuration document.
 *
 * Absent or unparsable is `{}` rather than an error, matching the CLI and the two sibling
 * rows: a half-written file must not take the settings surface down, and a missing key
 * means the default.
 *
 * @param path - the document to read.
 * @returns the parsed document, or an empty one.
 */
export function readConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {
    // Missing or malformed -> defaults.
  }
  return {}
}

/**
 * Persist the configuration document atomically.
 *
 * A temporary file in the same directory, then a rename: a reader sees either the previous
 * document or the next one, never a truncated one. The mode is applied at creation and
 * again by chmod, because `mode` only governs creation — an existing 0644 file keeps its
 * bits.
 *
 * @param next - the complete document to write.
 * @param path - where to write it.
 * @returns whether the write landed.
 */
export function writeConfig(next, path) {
  const temporary = join(dirname(path), `.${String(process.pid)}.qialike.json.tmp`)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    return true
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Best-effort cleanup; the write failure is what matters.
    }
    return false
  }
}

/**
 * The stored switch, or the default.
 *
 * A non-boolean reads as the default rather than being coerced: `"false"` and `0` are
 * typos or another program's values, and reading them as `false` would silently disable a
 * feature the user never turned off.
 *
 * @param path - the document to read.
 * @returns whether following is enabled.
 */
export function readEnabled(path) {
  const section = readConfig(path)[SECTION]
  if (typeof section !== 'object' || section === null) return DEFAULT_ENABLED
  const value = section[ENABLED_KEY]
  return typeof value === 'boolean' ? value : DEFAULT_ENABLED
}

/**
 * Persist the switch, preserving everything else in the document.
 *
 * @param enabled - the new value.
 * @param path - the document to write.
 * @returns whether the write landed.
 */
export function writeEnabled(enabled, path) {
  const config = readConfig(path)
  const section = typeof config[SECTION] === 'object' && config[SECTION] !== null ? config[SECTION] : {}
  return writeConfig({ ...config, [SECTION]: { ...section, [ENABLED_KEY]: enabled } }, path)
}

/**
 * Apply one mutation and report what happened.
 *
 * @param body - the parsed request body.
 * @param path - the document to write.
 * @returns the response payload.
 */
export function mutate(body, path) {
  if (body.op !== 'setEnabled') return { ok: false, message: `unknown op ${JSON.stringify(body.op)}` }
  if (typeof body.enabled !== 'boolean') return { ok: false, message: 'enabled must be a boolean' }
  if (!writeEnabled(body.enabled, path)) return { ok: false, message: `could not write ${path}` }
  return { ok: true, enabled: body.enabled }
}
