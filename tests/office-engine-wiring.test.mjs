/**
 * The two upstream behaviours the Office-engine wiring rests on.
 *
 * WHY CONTRACT LOCKS RATHER THAN TESTS OF OUR OWN CODE. The wiring is four lines: append a directory
 * to `NODE_PATH`, call `Module._initPaths()`, and let `@deepseek-ai/libreoffice-kit` resolve its
 * engine through `require.resolve`. Nothing in that is ours, and none of it is public API:
 * `_initPaths` is underscored, and the kit's resolution strategy is an implementation detail. If
 * either changes, an installed engine stops being found and the symptom is a preview that keeps
 * saying the engine is missing — after a successful 46 MiB download. That failure is silent, which
 * is what makes it worth a test that breaks loudly instead.
 *
 * MEASURED, BEFORE THIS FILE EXISTED, because the mechanism was not obvious:
 *
 *     ① NODE_PATH unset            require.resolve.paths() does not include the target
 *     ② process.env.NODE_PATH = x  still does not — Node builds its path list once, at bootstrap
 *     ③ x plus Module._initPaths() it does, in the same process, and resolution succeeds
 *
 * Step ③ is the one that matters and the one that could quietly stop being true, so it is asserted
 * as behaviour rather than as the presence of a function.
 *
 * WHAT IS NOT LOCKED, AND WHY. The kit is not resolved at all here: it lives in the assembled
 * runtime tree, so anything reading it has to guard on that tree existing, and a skipped test that
 * locks a contract is not a lock. The kit's own half is covered by `tests/office-engine-install`
 * where it can be — the target table there mirrors `platformTarget`, and a change upstream shows up
 * as a wrong engine name rather than as a silent no-op.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OFFICE_MESSAGE_MARKER,
  OFFICE_MESSAGE_REPLACEMENTS,
  patchOfficeEngineMessage,
} from '../apps/desktop-bin/harness-patches/office-engine-message.mjs'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-wiring-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the NODE_PATH lever', () => {
  it('still needs _initPaths, and still works because of it', async () => {
    // The whole of "the engine becomes resolvable without a restart". Asserted as a before/after on
    // a module that is NOT this one, because that is the kit's situation: it calls
    // `createRequire(import.meta.url)` from its own file and asks for a package by name.
    const engine = join(root, 'engines', 'node_modules', '@deepseek-ai', 'wired')
    mkdirSync(engine, { recursive: true })
    writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@deepseek-ai/wired', version: '1.0.0' }))

    // A separate module, loaded from its own directory, so its resolution starts somewhere else.
    const probeFile = join(root, 'probe.mjs')
    writeFileSync(probeFile, [
      "import { createRequire } from 'node:module'",
      'const require = createRequire(import.meta.url)',
      'export const resolve = (name) => {',
      '  try { return require.resolve(`${name}/package.json`) } catch { return null }',
      '}',
    ].join('\n'))
    const probe = await import(pathToFileURL(probeFile).href)

    const original = process.env.NODE_PATH
    try {
      delete process.env.NODE_PATH
      expect(probe.resolve('@deepseek-ai/wired')).toBeNull()

      process.env.NODE_PATH = join(root, 'engines', 'node_modules')
      // Step ②: setting the variable alone does nothing, and asserting it keeps the next line
      // meaningful — if Node ever starts reading NODE_PATH lazily, this tells us the `_initPaths`
      // call has become unnecessary rather than load-bearing.
      expect(probe.resolve('@deepseek-ai/wired')).toBeNull()

      const module_ = createRequire(import.meta.url)('node:module')
      expect(typeof module_._initPaths, 'Module._initPaths is gone; the row cannot refresh NODE_PATH')
        .toBe('function')
      module_._initPaths()

      expect(probe.resolve('@deepseek-ai/wired')).toBe(join(engine, 'package.json'))
    } finally {
      if (original === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = original
      const module_ = createRequire(import.meta.url)('node:module')
      module_._initPaths()
    }
  })

  it('is a separator the resolver understands, on this platform', async () => {
    // The row splits and joins `NODE_PATH` itself rather than using `path.delimiter`, because the
    // variable is read by Node's resolver and the two agree on every platform Node supports. This
    // asserts that claim where it is cheap to check rather than trusting it.
    const { NODE_PATH_SEPARATOR } = await import('../packages/qialike-desktop-office-engine/lib/install.js')
    expect(NODE_PATH_SEPARATOR).toBe(process.platform === 'win32' ? ';' : ':')
  })
})

describe('the Settings message patch', () => {
  /** A farm with just the two files the patch edits. */
  function makeFarm({ text } = {}) {
    const body = text ?? OFFICE_MESSAGE_REPLACEMENTS
      .map(({ from }) => `  "office.unavailable": ${JSON.stringify(from)},`)
      .join('\n')
    for (const target of [
      '-deepseek-ai-dsh-client-ui-sidebar-documentpreview/lib/client.js',
      '-deepseek-ai-dsh-client-ui-sidebar-documentpreview/lib/types/client/office/locales.js',
    ]) {
      const path = join(root, target)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, `${body}\n`)
    }
    return root
  }

  it('replaces both languages and marks what it touched', () => {
    // Both spellings matter: a locale the patch missed would leave half the users with a sentence
    // that names a cause they cannot act on.
    makeFarm()
    const written = patchOfficeEngineMessage({ root })
    expect(written).toHaveLength(2)
    const text = readFileSync(join(root, written[0]), 'utf8')
    for (const { to } of OFFICE_MESSAGE_REPLACEMENTS) expect(text).toContain(to)
    expect(text).toContain(OFFICE_MESSAGE_MARKER)
    // The old sentence must be gone, not merely accompanied by the new one.
    for (const { from } of OFFICE_MESSAGE_REPLACEMENTS) expect(text).not.toContain(from)
  })

  it('keeps the idempotency marker out of the sentence the user reads', () => {
    // THE TEST WHOSE ABSENCE SHIPPED A DEFECT. `from` and `to` are dictionary VALUES, so the marker
    // appended to `to` landed INSIDE the string literal — not a comment there, just text. 0.3.10 and
    // 0.3.11 therefore told the user to install the engine and then showed them
    // `/* qialike:office-engine-message */` on the end of that sentence. The old assertions could not
    // see it: they checked that `to` was present and that the marker was present, and both were true
    // — of a file whose value had grown a trailing comment.
    //
    // So this asserts the boundary instead of the contents: the character right after the sentence
    // must be the quote that closes the literal.
    makeFarm()
    const written = patchOfficeEngineMessage({ root })
    const text = readFileSync(join(root, written[0]), 'utf8')
    for (const { to } of OFFICE_MESSAGE_REPLACEMENTS) {
      const at = text.indexOf(to)
      expect(at, `expected the file to carry: ${to}`).toBeGreaterThan(-1)
      expect(["'", '"']).toContain(text[at + to.length])
    }
    // And the marker is still there, outside — that is what makes a second pass a no-op.
    expect(text).toContain(OFFICE_MESSAGE_MARKER)
  })

  it('is idempotent, so a second pass over one farm cannot double-apply', () => {
    makeFarm()
    patchOfficeEngineMessage({ root })
    const before = readFileSync(join(root, '-deepseek-ai-dsh-client-ui-sidebar-documentpreview/lib/client.js'), 'utf8')
    patchOfficeEngineMessage({ root })
    const after = readFileSync(join(root, '-deepseek-ai-dsh-client-ui-sidebar-documentpreview/lib/client.js'), 'utf8')
    expect(after).toBe(before)
    expect(after.split(OFFICE_MESSAGE_MARKER)).toHaveLength(before.split(OFFICE_MESSAGE_MARKER).length)
  })

  it('throws when the harness rewords the sentence, instead of silently doing nothing', () => {
    // The failure this prevents is the worst kind: a build that succeeds, ships the old message, and
    // says nothing. Upstream rewording it is expected eventually, and this is what turns that into a
    // named failure with the file to edit in it.
    makeFarm({ text: '  "office.unavailable": "Something else entirely."' })
    expect(() => patchOfficeEngineMessage({ root })).toThrow(/reworded|carries neither/u)
  })

  it('throws when a target package is missing, naming the file to update', () => {
    expect(() => patchOfficeEngineMessage({ root })).toThrow(/missing from the farm/u)
  })
})

describe('the assembled runtime carries the patch', () => {
  const runtimeDir = join(process.cwd(), 'dist', 'runtime', 'dsh')
  const assembled = existsSync(join(runtimeDir, 'desktop-runtime.json'))
  const bundle = join(
    runtimeDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-client-ui-sidebar-documentpreview',
    'lib',
    'client.js',
  )

  it.skipIf(!assembled)('serves the Settings sentence rather than the service one', () => {
    // The end of the patch's journey: what the browser is actually handed. A patch that applied to
    // the farm but did not reach the tree would pass the tests above and change nothing for a user.
    const text = readFileSync(bundle, 'utf8')
    expect(text).toContain(OFFICE_MESSAGE_MARKER)
    for (const { from } of OFFICE_MESSAGE_REPLACEMENTS) expect(text).not.toContain(from)
  })
})
