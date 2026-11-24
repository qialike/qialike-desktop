/**
 * The edit-follow switch, as the Host reads, writes and validates it.
 *
 * It imports `lib/settings.js` and never `lib/index.js`, and that is the point of the
 * split: the row imports `@deepseek-ai/dsh-home-paths`, which resolves in the assembled
 * runtime tree and not in this repository's `node_modules`, so nothing that imports it can
 * be reached from here. Every rule worth testing therefore lives in the module under test,
 * and the route is covered against a booted profile by
 * `apps/desktop-bin/lib/edit-follow-probe.mjs`.
 *
 * THE CONTRACT THIS PINS, AND WHY IT IS THE INTERESTING PART. The CLI types its own
 * sections as a closed union this repository must not extend, so this row's section name
 * has to be one the CLI does not own — and the CLI must not drop it. Its `writeSection()`
 * persists by spreading the document it just read, so an unknown *top-level* key survives.
 * That is a property of another repository, which is exactly why it is asserted here
 * rather than assumed: if that writer ever changed to emit only its own keys, this row's
 * switch would be dropped on the next CLI run, and the failure would present as a lost
 * setting rather than as a broken contract.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ENABLED, ENABLED_KEY, SECTION,
  mutate, readConfig, readEnabled, writeEnabled,
} from '../packages/qialike-desktop-edit-follow/lib/settings.js'

let dir
let config

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qialike-edit-follow-'))
  config = join(dir, 'qialike.json')
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** The document as it is on disk. */
const onDisk = () => JSON.parse(readFileSync(config, 'utf8'))

describe('the stored switch', () => {
  it('is on when the document does not exist', () => {
    // Asserted against the constant so the documented default and the behaviour cannot
    // drift apart.
    expect(readEnabled(config)).toBe(true)
    expect(DEFAULT_ENABLED).toBe(true)
  })

  it('is on when the document exists but says nothing about it', () => {
    writeFileSync(config, JSON.stringify({ theme: { colorscheme: 'dark' } }))
    expect(readEnabled(config)).toBe(true)
  })

  it('reads a stored false, and a stored true', () => {
    writeEnabled(false, config)
    expect(readEnabled(config)).toBe(false)
    writeEnabled(true, config)
    expect(readEnabled(config)).toBe(true)
  })

  it('falls back to the default for a value that is not a boolean', () => {
    // `"false"` and `0` are typos or another program's values. Coercing them would
    // silently disable a feature the user never turned off.
    for (const value of ['false', '', 0, 1, null, {}, []]) {
      writeFileSync(config, JSON.stringify({ [SECTION]: { [ENABLED_KEY]: value } }))
      expect(readEnabled(config), `value ${JSON.stringify(value)}`).toBe(DEFAULT_ENABLED)
    }
  })

  it('falls back to the default when the section is not an object', () => {
    for (const value of ['yes', 0, null, []]) {
      writeFileSync(config, JSON.stringify({ [SECTION]: value }))
      expect(readEnabled(config), `section ${JSON.stringify(value)}`).toBe(DEFAULT_ENABLED)
    }
  })

  it('falls back to the default when the document is not parsable', () => {
    // A half-written file must not take the settings surface down.
    writeFileSync(config, '{ not json')
    expect(readEnabled(config)).toBe(DEFAULT_ENABLED)
    expect(readConfig(config)).toEqual({})
  })

  it('treats a JSON array as no document at all', () => {
    // `typeof [] === 'object'`, so an array would otherwise be read as a document whose
    // sections are all missing — which happens to be the same answer, but by accident.
    writeFileSync(config, '[1, 2]')
    expect(readConfig(config)).toEqual({})
  })
})

describe('writing the switch', () => {
  it('keeps every other key in the document', () => {
    // The CLI and the two sibling rows share this file, so a write that replaced the
    // document would silently drop the user's colourscheme and provider settings.
    writeFileSync(config, JSON.stringify({
      theme: { colorscheme: 'dracula', colors: { primary: '#ff8800' } },
      llm: { routes: { one: { model: 'x' } } },
      sidebar_mode: 'on',
    }))
    writeEnabled(false, config)
    const document = onDisk()
    expect(document.theme).toEqual({ colorscheme: 'dracula', colors: { primary: '#ff8800' } })
    expect(document.llm).toEqual({ routes: { one: { model: 'x' } } })
    expect(document.sidebar_mode).toBe('on')
    expect(document[SECTION]).toEqual({ [ENABLED_KEY]: false })
  })

  it('keeps sibling keys inside its own section', () => {
    // The section is ours and may grow; a write must not flatten it back to one key.
    writeFileSync(config, JSON.stringify({ [SECTION]: { note: 'mine', [ENABLED_KEY]: true } }))
    writeEnabled(false, config)
    expect(onDisk()[SECTION]).toEqual({ note: 'mine', [ENABLED_KEY]: false })
  })

  it('survives a CLI write, because that writer merges the document it read', () => {
    // `writeSection()` is `persistConfig({ ...readConfig(), [key]: value })`. Modelled
    // here because the property belongs to another repository.
    writeEnabled(true, config)
    const cliWrite = { ...readConfig(config), theme: { colorscheme: 'nord' } }
    writeFileSync(config, `${JSON.stringify(cliWrite, null, 2)}\n`)

    expect(readEnabled(config)).toBe(true)
    expect(onDisk().theme).toEqual({ colorscheme: 'nord' })
  })

  it('writes two-space JSON with a trailing newline, as both products do', () => {
    writeEnabled(false, config)
    const text = readFileSync(config, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "')
  })

  it('writes a document no one else can read', () => {
    // It is the user's whole configuration for a shared home, provider names included.
    writeEnabled(false, config)
    // POSIX expresses this as a mode. Windows has no mode to assert — `chmod` there
    // only toggles the read-only attribute, and who may read a file is decided by the
    // ACL it inherits. The document lives under the user's own `$DSH_HOME`, so it is
    // owner-only by that inheritance rather than by a bit this code sets; asserting
    // 0o600 there would assert the host rather than the property. What is still worth
    // pinning on Windows is that the restricted-mode write did not lose the document.
    if (process.platform === 'win32') {
      expect(readEnabled(config)).toBe(false)
      return
    }
    expect((statSync(config).mode & 0o777).toString(8)).toBe('600')
  })

  it('creates the directory when the home does not exist yet', () => {
    const nested = join(dir, 'a', 'b', 'qialike.json')
    expect(writeEnabled(false, nested)).toBe(true)
    expect(readEnabled(nested)).toBe(false)
  })

  it('reports failure instead of throwing when the path cannot be written', () => {
    // A read-only home must not take the settings surface down. The parent here is a
    // regular FILE, so creating the directory fails with ENOTDIR — deterministic, and
    // unlike a mode-based case it does not depend on who the tests run as.
    const blocking = join(dir, 'not-a-directory')
    writeFileSync(blocking, '')
    expect(writeEnabled(false, join(blocking, 'qialike.json'))).toBe(false)
  })
})

describe('a mutation request', () => {
  it('accepts a boolean and reports it back', () => {
    expect(mutate({ op: 'setEnabled', enabled: false }, config)).toEqual({ ok: true, enabled: false })
    expect(readEnabled(config)).toBe(false)
  })

  it('refuses an unknown op rather than guessing', () => {
    const result = mutate({ op: 'setFollowEverything' }, config)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('setFollowEverything')
  })

  it('refuses a non-boolean, so a typo cannot disable the feature', () => {
    for (const enabled of ['false', 0, null, undefined]) {
      const result = mutate({ op: 'setEnabled', enabled }, config)
      expect(result.ok, `enabled ${JSON.stringify(enabled)}`).toBe(false)
      expect(result.message).toContain('boolean')
    }
    // And nothing was written: the default is still in force.
    expect(readEnabled(config)).toBe(true)
  })
})
