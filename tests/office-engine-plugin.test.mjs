/**
 * Pruning the LibreOffice engine out of the assembled runtime tree.
 *
 * WHY THIS IS WORTH A SUITE. The step exists to remove 145–182 MiB from a shipped application, so the
 * cases that matter are the ones where it removes the wrong thing or the wrong amount:
 *
 *   · **the adapter must survive.** `@deepseek-ai/libreoffice-kit` is the package the Office row mounts
 *     and the one that resolves an engine. The engine prefix ends in a dash precisely so a prefix test
 *     cannot match it, and that single character is the difference between a smaller tree and a tree
 *     whose Office preview cannot load at all — a failure that surfaces at runtime, far from here.
 *   · **the name must come from the manifest, not the directory.** A directory called
 *     `libreoffice-kit-wasm` proves nothing about what is inside it, and a prune that deleted on that
 *     resemblance would delete a package it was never pointed at.
 *   · **nothing else may go.** The tree holds ~300 packages; this removes one or two.
 *
 * Fixtures are real directories on disk, because what is under test is what a walk of a real tree does.
 * The sizes are real bytes so the reported saving is the measured one rather than a guess.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { OFFICE_MESSAGE_REPLACEMENTS } from '../apps/desktop-bin/harness-patches/office-engine-message.mjs'
import {
  OFFICE_ENGINE_ENV,
  OFFICE_ENGINE_MODES,
  OFFICE_ENGINE_PREFIX,
  defaultOfficeEngineMode,
  officeEngineMode,
  pruneOfficeEngine,
} from '../apps/desktop-bin/lib/runtime-tree.mjs'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-office-prune-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a file of a given size, creating its directory. */
function place(path, bytes = 1) {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, 'x'.repeat(bytes))
}

/** Write a package's manifest, the way a real tree has one. */
function packageAt(name, { files = { 'index.js': 4 } } = {}) {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0' })}\n`)
  for (const [file, bytes] of Object.entries(files)) place(`node_modules/${name}/${file}`, bytes)
}

/** The engine a Linux tree carries, at the size class it really is. */
function linuxEngine() {
  packageAt(`${OFFICE_ENGINE_PREFIX}wasm`, {
    files: { 'assets/soffice.wasm': 1000, 'assets/soffice.data': 200, 'prebuilds.json': 30 },
  })
}

/** The adapter, which must survive every prune. */
function adapter() {
  packageAt(OFFICE_ENGINE_PREFIX.slice(0, -1), { files: { 'lib/index.js': 50, 'lib/cli.js': 20 } })
}

describe('the mode switch', () => {
  it('prunes on Linux and Windows by default, and not on macOS', () => {
    // Linux shipped without the engine first: the installer, the Settings row, the message patch
    // and the preview-after-install path are all verified there, so the 145.3 MiB is not paid by
    // every user for a feature most sessions never use.
    expect(officeEngineMode({}, 'linux')).toBe('plugin')
    expect(defaultOfficeEngineMode('linux')).toBe('plugin')
    // Windows followed, and its two former objections are answered rather than outweighed: the
    // native engine packages are published at the pinned version (`libreoffice-kit-win32-x64@0.1.5`),
    // which is what the missing WebAssembly fallback would have covered, and the VC-runtime probe
    // now reads the on-demand install root as well, so the redistributable diagnosis survives the
    // prune. Neither is a reason to ship 182 MiB to every user.
    expect(officeEngineMode({}, 'win32')).toBe('plugin')
    expect(defaultOfficeEngineMode('win32')).toBe('plugin')
    // macOS has not been through that verification, so it still carries the engine.
    expect(officeEngineMode({}, 'darwin')).toBe('bundled')
    expect(defaultOfficeEngineMode('darwin')).toBe('bundled')
  })

  it('reads an empty or blank value as "no opinion", not as a policy', () => {
    for (const platform of ['linux', 'win32']) {
      expect(officeEngineMode({ [OFFICE_ENGINE_ENV]: '' }, platform)).toBe(defaultOfficeEngineMode(platform))
      expect(officeEngineMode({ [OFFICE_ENGINE_ENV]: '   ' }, platform)).toBe(defaultOfficeEngineMode(platform))
    }
  })

  it('lets an explicit value override the platform default either way', () => {
    // Which is what makes the flip reversible without a second code path: a release that wants the
    // engine back in the Linux package sets one environment variable.
    expect(officeEngineMode({ [OFFICE_ENGINE_ENV]: 'bundled' }, 'linux')).toBe('bundled')
    expect(officeEngineMode({ [OFFICE_ENGINE_ENV]: 'plugin' }, 'win32')).toBe('plugin')
  })

  it('reads both policies, and is not case- or space-sensitive', () => {
    expect(OFFICE_ENGINE_MODES).toEqual(['bundled', 'plugin'])
    expect(officeEngineMode({ [OFFICE_ENGINE_ENV]: 'plugin' }, 'win32')).toBe('plugin')
    expect(officeEngineMode({ [OFFICE_ENGINE_ENV]: ' Plugin ' }, 'win32')).toBe('plugin')
    expect(officeEngineMode({ [OFFICE_ENGINE_ENV]: 'BUNDLED' }, 'linux')).toBe('bundled')
  })

  it('refuses an unknown value instead of choosing for the operator', () => {
    // Silently bundling ships the 145 MB they asked to remove; silently pruning ships an
    // application whose Office preview cannot work. A build that stops and says which word it did
    // not understand is better than either.
    expect(() => officeEngineMode({ [OFFICE_ENGINE_ENV]: 'yes' }, 'linux')).toThrow(/must be one of/iu)
    expect(() => officeEngineMode({ [OFFICE_ENGINE_ENV]: 'plugins' }, 'linux')).toThrow(/got "plugins"/u)
  })
})

describe('the prune removes the engine', () => {
  it('removes it, and reports the bytes it actually freed', () => {
    packageAt('some-other-package')
    adapter()
    linuxEngine()
    const before = statSync(join(root, 'node_modules', `${OFFICE_ENGINE_PREFIX}wasm`, 'assets', 'soffice.wasm')).size

    const result = pruneOfficeEngine({ runtimeDir: root })

    expect(result.removed.map((entry) => entry.name)).toEqual([`${OFFICE_ENGINE_PREFIX}wasm`])
    expect(result.bytes).toBeGreaterThanOrEqual(before)
    expect(existsSync(join(root, 'node_modules', `${OFFICE_ENGINE_PREFIX}wasm`))).toBe(false)
  })

  it('leaves the adapter, so the Office row can still load and report itself', () => {
    adapter()
    linuxEngine()

    pruneOfficeEngine({ runtimeDir: root })

    const kept = join(root, 'node_modules', OFFICE_ENGINE_PREFIX.slice(0, -1), 'lib', 'index.js')
    expect(existsSync(kept)).toBe(true)
  })

  it('leaves every other package alone', () => {
    const others = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-office-to-pdf', 'react', 'zod']
    for (const name of others) packageAt(name)
    linuxEngine()

    pruneOfficeEngine({ runtimeDir: root })

    for (const name of others) {
      expect(existsSync(join(root, 'node_modules', name, 'index.js')), `${name} was removed`).toBe(true)
    }
  })

  it('removes a foreign platform engine too, not just this platform’s', () => {
    // A tree holding another platform's engine holds dead weight. The rule is the prefix, not the
    // architecture, so a farm that shipped the wrong one is corrected by the same step.
    packageAt(`${OFFICE_ENGINE_PREFIX}win32-x64`, { files: { 'bin/engine.exe': 300 } })
    linuxEngine()

    const result = pruneOfficeEngine({ runtimeDir: root })

    expect(result.removed.map((entry) => entry.name).sort())
      .toEqual([`${OFFICE_ENGINE_PREFIX}wasm`, `${OFFICE_ENGINE_PREFIX}win32-x64`].sort())
  })

  it('is idempotent, so a second assembly pass cannot fail on a tree it already pruned', () => {
    linuxEngine()

    const first = pruneOfficeEngine({ runtimeDir: root })
    const second = pruneOfficeEngine({ runtimeDir: root })

    expect(first.removed).toHaveLength(1)
    expect(second.removed).toEqual([])
    expect(second.bytes).toBe(0)
  })

  it('finds an engine wherever it sits, not only at the tree root', () => {
    // The tree is hoisted today, so engines live at the root. The walk is what keeps this correct if
    // that ever changes, and a nested copy left behind would be the 145 MB the step exists to remove.
    place('node_modules/outer/node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json')
    writeFileSync(
      join(root, 'node_modules/outer/node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json'),
      JSON.stringify({ name: `${OFFICE_ENGINE_PREFIX}wasm` }),
    )
    place('node_modules/outer/node_modules/@deepseek-ai/libreoffice-kit-wasm/big.bin', 500)

    const result = pruneOfficeEngine({ runtimeDir: root })

    expect(result.removed).toHaveLength(1)
    expect(result.bytes).toBeGreaterThanOrEqual(500)
  })
})

describe('the prune refuses rather than guessing', () => {
  it('reads the name from the manifest, so a lookalike directory is not deleted', () => {
    // A directory name is not evidence of what is inside it. This one is named exactly like an
    // engine and holds something else; deleting it would be a prune that reached a package it was
    // never pointed at.
    place('node_modules/@deepseek-ai/libreoffice-kit-wasm/big.bin', 400)
    writeFileSync(
      join(root, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json'),
      JSON.stringify({ name: '@deepseek-ai/something-else' }),
    )

    const result = pruneOfficeEngine({ runtimeDir: root })

    expect(result.removed).toEqual([])
    expect(existsSync(join(root, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/big.bin'))).toBe(true)
  })

  it('leaves a manifest it cannot parse, rather than treating unreadable as removable', () => {
    place('node_modules/@deepseek-ai/libreoffice-kit-wasm/big.bin', 400)
    writeFileSync(join(root, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json'), '{ not json')

    const result = pruneOfficeEngine({ runtimeDir: root })

    expect(result.removed).toEqual([])
    expect(existsSync(join(root, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/big.bin'))).toBe(true)
  })

  it('cannot reach the adapter, because the prefix keeps its trailing dash', () => {
    // THE ONE INVARIANT THIS STEP DEPENDS ON, pinned here because nothing else can pin it.
    //
    // Candidates are collected only when their name starts with `OFFICE_ENGINE_PREFIX`, and the
    // adapter's name is that prefix minus the dash — so the adapter cannot enter the candidate set,
    // and the guard inside `pruneOfficeEngine` is unreachable while this holds. It is a tripwire for
    // the edit that removes the dash, not a live branch: without the trailing character, the prune
    // would delete the package the Office row mounts, and the application would fail to load a row
    // rather than lose a preview.
    //
    // So the assertion belongs on the constant, and it is the reason this test exists.
    expect(OFFICE_ENGINE_PREFIX.endsWith('-')).toBe(true)
    const adapterName = OFFICE_ENGINE_PREFIX.slice(0, -1)
    expect(adapterName).toBe('@deepseek-ai/libreoffice-kit')
    expect(adapterName.startsWith(OFFICE_ENGINE_PREFIX)).toBe(false)
  })
})

describe('the tree after the prune', () => {
  it('holds no directory whose name still suggests an engine', () => {
    linuxEngine()
    adapter()

    pruneOfficeEngine({ runtimeDir: root })

    const remaining = readdirSync(join(root, 'node_modules', '@deepseek-ai'))
    expect(remaining.filter((name) => name.startsWith('libreoffice-kit-'))).toEqual([])
    expect(remaining).toContain('libreoffice-kit')
  })
})

describe('where the Office row lives', () => {
  // A PLUGINS TAB, NOT A GENERAL ROW. The engine is not shipped with the application; it is
  // fetched on demand, which is the shape of a plugin rather than of a preference. The plugins
  // page is where "is it present, and can I install it" belongs, and General is a list of
  // settings a user adjusts — which is why this moved.
  //
  // This assertion exists because the move is otherwise invisible: the row renders the same
  // words either way, so nothing in the runtime probe would notice it drifting back.

  const bundle = readFileSync(join(ROOT, 'packages/qialike-desktop-office-engine/lib/client.js'), 'utf8')

  it('registers into the plugins tab slot, not the settings row slot', () => {
    expect(bundle).toContain("ctx.slots.inject('settings.plugins.tab'")
    expect(bundle).not.toContain("ctx.slots.inject('settings.general.item'")
  })

  it('keeps its id, and sorts after the tabs that ship', () => {
    // `plugins` is order 1 and `all` is 10 upstream; 20 keeps the catalogue first. The label is
    // a thunk so the tab follows the language without re-registering.
    expect(bundle).toMatch(/id: 'qialike-office-engine'/)
    expect(bundle).toMatch(/order: 20/)
    expect(bundle).toMatch(/label: \(\) => t\('title'\)/)
  })

  it('is pointed at by the sentence the preview shows, which is what makes the move reachable', () => {
    // THE ROW MOVING AND THE MESSAGE NAMING IT ARE TWO EDITS, AND ONLY ONE OF THEM WAS MADE.
    // 0.4.6 registered this row into `settings.plugins.tab` while the build patch still told users to
    // open "Settings → General → Office previews", so for one release the only guidance the preview
    // gave led nowhere. Nothing failed: a dictionary value is not type-checked against a slot tree.
    // These two assertions tie the sentence to the slot so the next move cannot repeat it.
    const moved = OFFICE_MESSAGE_REPLACEMENTS.map(({ to }) => to).join('\n')
    expect(moved, 'the Office message still sends readers to General, but the row is a plugins tab')
      .not.toMatch(/General|通用设置/u)
    expect(moved).toMatch(/Built-in plugins/u)
    expect(moved).toMatch(/内置插件/u)
  })
})
