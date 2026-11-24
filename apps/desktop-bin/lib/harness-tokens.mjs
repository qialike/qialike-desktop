/**
 * The design tokens the harness's browser surface actually defines.
 *
 * WHY THIS IS A MODULE AND NOT A TEST HELPER. Two suites need the same answer and
 * must not drift: the theme mapping asserts that every token it *sets* exists, and
 * the client-bundle check asserts that every token our plugins *reference* exists.
 * A second copy of the scan would let one of them pass against a stale idea of the
 * harness.
 *
 * WHY THE CHECK MATTERS AT ALL. A token name that does not exist is not an error
 * anywhere: `color: var(--dsw-alias-border-secondary)` with no fallback resolves to
 * nothing, and with a fallback quietly uses the fallback forever. The styling looks
 * deliberate, the theme picker appears to work, and one surface simply never follows
 * the theme. Nothing in a build or a type-checker can see it, so the only defence is
 * reading both sides and comparing.
 *
 * Scanned from the CHECKOUT rather than the assembled runtime tree: the question is
 * what the harness's own sources define, and answering it from a tree would make the
 * result depend on which tree happened to be assembled.
 *
 * @module qialike-desktop/harness-tokens
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every `--dsw-*` custom property name the harness's client packages mention.
 *
 * A *mention*, not strictly a definition: the scan cannot tell `--x: red` from
 * `var(--x)` without parsing CSS, and it does not need to. The assertion this
 * serves is "our bundle names a token the harness knows about", and a name that
 * appears anywhere in the harness client sources — defined or merely consumed —
 * satisfies that. Over-collecting is the safe direction: it can only fail to catch
 * a typo, never invent a false failure.
 *
 * @param harness - the resolved harness checkout root.
 * @param options.subdir - the directory to scan, relative to the checkout.
 * @returns the token names.
 */
export function collectHarnessTokens(harness, options = {}) {
  const found = new Set()
  // The prefix families the design system uses. `static` is included because those
  // tokens are referenced by our own bundles too and are just as real.
  // At least two segments after `--dsw-`, so a family prefix written in prose
  // ("the `--dsw-alias-*` family") is not collected as a token name.
  const pattern = /--dsw-(?:alias|specific|static|font|radius|elevation|spacing)(?:-[a-z0-9]+)+/gu
  const root = join(harness, options.subdir ?? join('packages', 'client'))
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        // `node_modules` is a link farm and `src` duplicates what `lib` carries.
        if (entry.name === 'node_modules' || entry.name === 'src') continue
        walk(path, depth + 1)
        continue
      }
      if (!/\.(css|js)$/u.test(entry.name)) continue
      try {
        // KaTeX and the vendored chunks are megabytes of unrelated CSS; a token
        // cannot be defined only there, and reading them costs seconds.
        if (statSync(path).size > 4_000_000) continue
        for (const match of readFileSync(path, 'utf8').matchAll(pattern)) found.add(match[0])
      } catch { /* unreadable file: not this check's business */ }
    }
  }
  walk(root, 0)
  return found
}

/**
 * Strip comments from JavaScript source, so a scan reads code and not prose.
 *
 * WHY THIS IS NECESSARY RATHER THAN PEDANTIC. A bundle that documents a corrected
 * token — "`--dsw-alias-border-secondary` does not exist" — would otherwise be
 * reported as *referencing* it, and the check would fail on the very comment that
 * records the fix. That trains the next reader to weaken the assertion, which is a
 * worse outcome than the false positive.
 *
 * Block comments are removed, and line comments only where `//` begins a line. A
 * trailing comment after code is left in place, deliberately: telling one from the
 * `//` in a `https://` literal needs a real tokenizer, and the failure direction here
 * is a false positive on a trailing comment rather than a missed token — the latter
 * being impossible, since removing text can only remove matches.
 *
 * @param source - the file contents.
 * @returns the source with comments blanked, preserving line count.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//u.test(line) ? '' : line))
    .join('\n')
}

/**
 * Every `--dsw-*` token name a source file's *code* references.
 *
 * @param source - the file contents.
 * @returns the token names, de-duplicated and sorted.
 */
export function referencedTokens(source) {
  // Two segments minimum: `--dsw-alias-*` in prose is a family reference rather than
  // a token, and one segment is never a real name in this vocabulary.
  const pattern = /--dsw-[a-z0-9]+(?:-[a-z0-9]+)+/gu
  const code = withoutComments(source)
  return [...new Set([...code.matchAll(pattern)].map((match) => match[0]))].sort()
}
