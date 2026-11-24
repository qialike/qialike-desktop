/**
 * Turning a startup failure into something a person can act on.
 *
 * WHY THIS IS A MODULE RATHER THAN FOUR LINES IN `main.ts`. The dialog used to hand the user up to 1000
 * characters of the Host's error verbatim, and a real one looks like this:
 *
 *     Error invoking remote method 'qialike-desktop:boot': Error: qialike desktop: the Host failed to
 *     start: dsh: startup failed: 4 required plugins did not activate
 *
 *     Failed plugins (91):
 *     hmr
 *     Package: @deepseek-ai/dsh-hmr
 *     failed to import
 *     typert-loader
 *     Package: @deepseek-ai/dsh-typert-loader
 *     AggregateError: typert-loader: 1 typert contributor(s) failed to register:
 *     … 85 more, ending in a stack trace inside a temporary directory
 *
 * It was reported as "a dialog with no way to act on it", and that is accurate: ninety-one entries, a
 * column of package names, and no statement of what to do. Three things were wrong with it, and each is
 * fixed here rather than in the caller:
 *
 *   1. **The first line is the summary and was not treated as one.** It says "4 required plugins did not
 *      activate", which is the whole story; everything after it is evidence. The dialog now shows that line
 *      and nothing else in its `message` field.
 *   2. **A list of 91 things is not a summary.** It is now the count plus the names of the first few.
 *   3. **Some failures have a specific remedy, and the text names it.** An interrupted AppImage extraction
 *      leaves a partial tree, and the path in the error is the directory to remove. That is detected and
 *      stated with the command to run, because "restart the application" does not clear it — the next launch
 *      re-unpacks over the same path only if the partial tree is gone.
 *
 * The full text is never lost: the caller writes it to the desktop log, and the dialog names that file. An
 * excerpt of it is shown only when the failure has no shape this module recognises, because otherwise the
 * parts above already say what failed and what to do.
 *
 * PURE ON PURPOSE. Everything here is a string transformation, so it is testable against the real message
 * above without an Electron runtime — which matters, because this is the one piece of the failure path that
 * a test can actually reach.
 *
 * @module @qialike/desktop/startup-failure
 */

/** Bounds, so a pathological failure cannot make the dialog unreadable or unusably wide. */
const MESSAGE_LIMIT = 240
const EXCERPT_LIMIT = 600
const PLUGIN_NAMES_LIMIT = 5

/** A summary the dialog can show, and the full text the caller should keep. */
export interface StartupFailureSummary {
  /** One line: what failed. */
  readonly message: string
  /** Bounded evidence, any actionable remedy, and where the full text was written. */
  readonly detail: string
}

/** The blank line the Host puts between its summary and its evidence. */
const PLUGIN_SECTION = /^Failed plugins \((\d+)\):\s*$/mu

/** An AppImage's unpacked copy, as it appears in a module-resolution error. */
const EXTRACTION_DIR = /(\S*appimage_extracted_[0-9a-f]+)/u

/**
 * The wrappers a host error arrives in, stripped from the dialog's headline.
 *
 * WHY THIS IS WORTH DOING TO A FIRST LINE. The headline is the only part of the dialog most people read, and
 * the honest first line of a real failure is 159 characters of plumbing:
 *
 *     Error invoking remote method 'qialike-desktop:boot': Error: qialike desktop: the Host failed to
 *     start: dsh: startup failed: 4 required plugins did not activate
 *
 * The fact is the last clause. These patterns peel the transport and the attribution off the front so the
 * headline reads "4 required plugins did not activate".
 *
 * NOTHING IS LOST BY STRIPPING: the full first line is still the first thing in the excerpt below, and the
 * whole message is in the log. Applied repeatedly, because they nest — and never below a floor, so a message
 * that is nothing but wrappers keeps its original text rather than becoming empty.
 */
const HEADLINE_WRAPPERS = [
  /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/u,
  /^Error:\s*/u,
  /^qialike desktop:\s*/u,
  /^the Host failed to start:\s*/u,
  /^dsh:\s*/u,
  /^startup failed:\s*/u,
]

/** The shortest a stripped headline may become before the original is used instead. */
const HEADLINE_FLOOR = 12

/**
 * Reduce a failure's first line to the fact it is reporting.
 *
 * @param line - the first non-empty line.
 * @returns the line without its transport wrappers, or the line itself when stripping would leave too
 *   little to be meaningful.
 */
function headline(line: string): string {
  let text = line.trim()
  for (let pass = 0; pass < HEADLINE_WRAPPERS.length; pass += 1) {
    let changed = false
    for (const pattern of HEADLINE_WRAPPERS) {
      const next = text.replace(pattern, '')
      if (next !== text) { text = next.trim(); changed = true }
    }
    if (!changed) break
  }
  return text.length >= HEADLINE_FLOOR ? text : line.trim()
}

/** Cut a string to `limit` characters, on a word boundary where one is near the end. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`
}

/**
 * The plugin names in the Host's failure list.
 *
 * The list is name-first — a plugin's name is the line above its `Package:` line — so it is read that way
 * rather than by counting lines, which would break the moment upstream adds a field. Anything unexpected
 * yields no names and the caller falls back to a text excerpt; a summary is not worth a fragile parser.
 *
 * @param text - the Host's message.
 * @returns the total the list claims, and the names it names, or `undefined` when there is no list.
 */
function readPluginList(text: string): { total: number; names: string[] } | undefined {
  const header = PLUGIN_SECTION.exec(text)
  if (header === null) return undefined
  const lines = text.slice(header.index + header[0].length).split('\n')
  const names: string[] = []
  for (const [index, line] of lines.entries()) {
    const next = lines[index + 1]
    if (next === undefined) break
    // A plugin name is followed by its package. Everything else — the reason, the stack, the indented
    // continuation lines — is context.
    if (!next.startsWith('Package: ')) continue
    if (line.trim() === '' || line.startsWith(' ')) continue
    names.push(line.trim())
  }
  return { total: Number(header[1]), names }
}

/**
 * Summarise a startup failure for the dialog.
 *
 * @param text - what the client or the Host reported.
 * @param options.logPath - where the caller wrote the full text, or absent when the write failed. A dialog
 *   that names a file which does not exist is worse than one that shows the text, so a missing path changes
 *   what is shown rather than being ignored.
 * @returns the message and detail fields for `dialog.showMessageBox`.
 */
export function summariseStartupFailure(
  text: string,
  { logPath }: { logPath?: string },
): StartupFailureSummary {
  const lines = text.split('\n')
  const first = lines.find((line) => line.trim() !== '') ?? 'the client reported an unspecified startup failure'
  const message = clip(headline(first), MESSAGE_LIMIT)

  const parts: string[] = []

  const plugins = readPluginList(text)
  if (plugins !== undefined && plugins.names.length > 0) {
    const shown = plugins.names.slice(0, PLUGIN_NAMES_LIMIT)
    // "and N more" counts the names this summary is holding back, not the difference between the total and
    // the limit. The two are not the same number: a message can name fewer plugins than its header counts,
    // and the first version of this line claimed 86 more names when it had read two.
    const hidden = plugins.names.length - shown.length
    const more = hidden > 0 ? `, and ${String(hidden)} more` : ''
    parts.push(`Plugins that did not load (${String(plugins.total)}): ${shown.join(', ')}${more}.`)
  }

  // The remedy, when the failure names one. Checked before the generic advice below, because "restart the
  // application" is not the fix for a partial unpack — the next launch finds the same partial tree.
  const extraction = EXTRACTION_DIR.exec(text)?.[1]
  if (extraction !== undefined) {
    parts.push(
      'The application\u2019s unpacked copy is incomplete, which happens when an extraction is interrupted '
      + '(the machine restarted, or the process was killed). Remove it and start again:\n'
      + `  rm -rf ${extraction}`,
    )
  }

  parts.push(
    logPath === undefined
      ? 'The full details could not be written to this application\u2019s log, so they follow below.'
      : `Full details: ${logPath}`,
  )

  // EVIDENCE ONLY WHEN THE SUMMARY IS THIN, which is a rule with a reason rather than a length budget.
  //
  // When the failure has a shape this module recognises, the parts above already say what failed and what to
  // do, and the raw text adds nothing but length: it repeats the plugin list the summary counted and the
  // directory the remedy names. When it has no shape — an unexpected error — there is nothing else to show,
  // and a bounded excerpt is the difference between a dialog someone can act on and a headline.
  //
  // The full text is never lost either way: it is in the log this dialog names — or, when there is no log,
  // here, which is the one case where the evidence has to be shown even though the summary understood it.
  if (plugins === undefined && extraction === undefined || logPath === undefined) {
    const body = lines.slice(1).join('\n').trim()
    if (body !== '') parts.push(clip(body, EXCERPT_LIMIT))
  }

  return { message, detail: parts.join('\n\n') }
}
