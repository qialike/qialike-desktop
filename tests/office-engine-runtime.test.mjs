/**
 * The external runtime the bundled Office engine loads, and the startup check that reports it.
 *
 * WHY THIS SUITE EXISTS. This project does not ship the MSVC runtime DLLs the engine needs. The
 * consequence is a failure mode that is worse than a missing feature, because it is misleading:
 * the preview reports that conversion failed and suggests checking the document, sending the user
 * to inspect their own file while the real cause is a system component. The startup check exists to
 * name the real cause, and everything here is about that being true rather than approximately true.
 *
 * WHAT IS DELIBERATELY TESTED RATHER THAN ASSUMED:
 *
 *   · the required set is read from the engine binary, so an engine that starts importing something
 *     new is described correctly instead of by a list written for an older build;
 *   · Windows system imports are excluded, because reporting `kernel32.dll` as missing would be
 *     noise on a machine where the real cause is one MSVC file;
 *   · "could not ask the engine" and "the engine is broken" are different outcomes — a timeout must
 *     never produce a dialog telling a user to install something they have;
 *   · the probe's verdict is "did it say anything", not its exit code, because both outcomes exit
 *     non-zero;
 *   · the missing-file naming runs the loader's own search order, engine directory before System32.
 *
 * The PE fixtures are synthesized rather than borrowed from a real image, so these run on any
 * platform. The probe tests use a scripted process instead of the engine, because what is under
 * test is the decision made from its output.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIST_DIR } from '../apps/desktop-bin/lib/paths.mjs'
import {
  describeEngineRuntime,
  ENGINE_EXECUTABLE,
  engineBinDir,
  engineRuntimeRequirements,
  readPeImports,
} from '../apps/desktop-bin/lib/vc-runtime.mjs'
import { checkEngineRuntime } from '../apps/desktop-bin/gates/runtime-tree.mjs'
import {
  engineInstallRoot,
  enginePackageDir,
  installEngine as installEngineForReal,
} from '../packages/qialike-desktop-office-engine/lib/install.js'
import {
  VC_REDIST_URL,
  askEngineToStart,
  checkOfficeEngine,
  engineCandidates,
  recordedRuntimeRequirements,
  unresolvedRuntimeDlls,
} from '../packages/qialike-desktop-office-engine/lib/diagnose.js'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-engineruntime-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Build a minimal but structurally valid PE32+ image importing `dllNames`.
 *
 * A real import table is the thing under test, so a fixture that faked one would test the fixture.
 * The layout is DOS header, PE signature, COFF header, a full 16-entry optional-header directory
 * table, one `.rdata` section, then the import descriptors and the names they point at.
 */
function buildPe(dllNames) {
  const headersEnd = 0x200
  const sectionRva = 0x1000
  const sectionSize = 0x200
  const buf = Buffer.alloc(headersEnd + sectionSize)

  buf.writeUInt16LE(0x5a4d, 0)
  buf.writeUInt32LE(0x40, 0x3c)
  buf.writeUInt32LE(0x00004550, 0x40)
  const coff = 0x44
  buf.writeUInt16LE(0x8664, coff)
  buf.writeUInt16LE(1, coff + 2)
  buf.writeUInt16LE(240, coff + 16)
  buf.writeUInt16LE(0x22, coff + 18)

  const optional = coff + 20
  buf.writeUInt16LE(0x20b, optional)
  buf.writeUInt32LE(16, optional + 108)
  const directories = optional + 112

  const descriptorsRva = sectionRva
  let cursor = descriptorsRva + 0x100
  const nameRvas = []
  for (const name of dllNames) {
    nameRvas.push(cursor)
    cursor += Buffer.byteLength(name, 'ascii') + 1
    cursor = (cursor + 3) & ~3
  }
  buf.writeUInt32LE(descriptorsRva, directories + 8)
  buf.writeUInt32LE((dllNames.length + 1) * 20, directories + 12)

  const section = optional + 240
  buf.write('.rdata\0\0', section, 8, 'ascii')
  buf.writeUInt32LE(sectionSize, section + 8)
  buf.writeUInt32LE(sectionRva, section + 12)
  buf.writeUInt32LE(sectionSize, section + 16)
  buf.writeUInt32LE(headersEnd, section + 20)

  const toFile = (rva) => headersEnd + (rva - sectionRva)
  dllNames.forEach((name, index) => {
    const descriptor = toFile(descriptorsRva) + index * 20
    buf.writeUInt32LE(nameRvas[index], descriptor + 12)
    buf.writeUInt32LE(0x1100 + index * 8, descriptor + 16)
    buf.write(`${name}\0`, toFile(nameRvas[index]), 'ascii')
  })
  return buf
}

/** A runtime tree holding an engine, and optionally a descriptor. */
function makeTree(options = {}) {
  const runtimeDir = join(root, 'runtime', 'dsh')
  const binDir = engineBinDir(runtimeDir)
  mkdirSync(binDir, { recursive: true })
  const engine = options.engine === undefined
    ? buildPe(['MSVCP140.dll', 'KERNEL32.dll'])
    : options.engine
  if (engine !== false) writeFileSync(join(binDir, ENGINE_EXECUTABLE), engine)
  if (options.required !== undefined) {
    writeFileSync(join(runtimeDir, 'desktop-runtime.json'), `${JSON.stringify({
      engineRuntime: { present: true, engine: 'node_modules/x', required: options.required },
    })}\n`)
  }
  return runtimeDir
}

/**
 * The `$DSH_HOME` this suite uses, which no machine shares.
 *
 * The rule the fixtures here already follow: a result may not depend on what this host happens to
 * have installed. `unresolvedRuntimeDlls` refuses the real `System32` for the same reason, and a
 * check that read the developer's real `~/.dsh` would pass or fail by accident.
 *
 * @returns a path guaranteed to be empty until a test puts something in it.
 */
function isolatedHome() {
  return join(root, 'home')
}

/**
 * Write an engine where the on-demand installer puts one: `<home>/engines/libreoffice-kit/<version>`.
 *
 * The layout mirrors `engineInstallRoot` + `enginePackageDir` in the office-engine package. It is
 * written out here rather than imported from it deliberately: a test that borrowed the installer's
 * own path helpers could not notice that layout drifting away from the one the shell reads.
 *
 * @param home - the `$DSH_HOME` to install under.
 * @param version - the version directory to create.
 * @returns the `bin` directory the engine was written into.
 */
function installEngine(home, version) {
    // THE PATH COMES FROM THE MODULE THAT OWNS THE LAYOUT, NOT FROM A COPY OF IT HERE. This
    // fixture used to spell the layout out by hand, and it spelled it WRONG: it omitted the
    // `<target>` segment that `installEngine` writes, so the fixture and the reader agreed with
    // each other and both disagreed with the writer. Every test below passed while the checker
    // could never find an installed engine — the silent failure a duplicated path buys.
    const binDir = join(
      enginePackageDir(engineInstallRoot(home, version, 'win32-x64'), '@deepseek-ai/libreoffice-kit-win32-x64'),
      'bin',
    )
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, ENGINE_EXECUTABLE), buildPe(['MSVCP140.dll']))
    return binDir
}

describe('the requirement set is read from the binary', () => {
  const engine = join(engineBinDir(join(DIST_DIR, 'runtime', 'dsh')), ENGINE_EXECUTABLE)
  const assembled = existsSync(engine)

  it.skipIf(!assembled)('names the MSVC families the shipped engine imports', () => {
    const required = engineRuntimeRequirements(engine)
    // Every entry is an MSVC family member, and the Windows imports are absent: a machine cannot
    // be missing `kernel32.dll`, so listing it would only dilute a real report.
    expect(required.length).toBeGreaterThan(0)
    for (const name of required) expect(name).toMatch(/^(msvcp|vcruntime|concrt|vccorlib)/iu)
    expect(required.some((name) => /^kernel32/iu.test(name))).toBe(false)
  })

  it.skipIf(!assembled)('derives exactly what the engine imports, with nothing added or dropped', () => {
    // The check that keeps this honest without a hardcoded list: the recorded set IS the engine's
    // MSVC imports. A new import reaches the descriptor, and a stale entry cannot survive.
    const msvc = readPeImports(engine).filter((name) => /^(msvcp\d|vcruntime\d|concrt\d|vccorlib\d)/iu.test(name))
    expect(engineRuntimeRequirements(engine)).toEqual([...new Set(msvc)].sort())
  })

  it('excludes Windows system imports and keeps the MSVC ones', () => {
    const image = join(root, 'mixed.dll')
    writeFileSync(image, buildPe(['KERNEL32.dll', 'GDI32.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'MSVCP140.dll', 'VCRUNTIME140_1.dll']))
    expect(engineRuntimeRequirements(image)).toEqual(['MSVCP140.dll', 'VCRUNTIME140_1.dll'])
  })

  it('notices a family member this engine does not import yet', () => {
    // `msvcp140_atomic_wait.dll` is a real file in the same redistributable folder. If a later
    // engine imports it, the recorded set has to grow with it.
    const image = join(root, 'future.dll')
    writeFileSync(image, buildPe(['MSVCP140.dll', 'MSVCP140_ATOMIC_WAIT.dll']))
    expect(engineRuntimeRequirements(image)).toEqual(['MSVCP140.dll', 'MSVCP140_ATOMIC_WAIT.dll'])
  })

  it('reports nothing for a file that is not a PE image', () => {
    const plain = join(root, 'plain.txt')
    writeFileSync(plain, 'not a PE image\n')
    expect(engineRuntimeRequirements(plain)).toEqual([])
    expect(engineRuntimeRequirements(join(root, 'absent.dll'))).toEqual([])
  })

  it('de-duplicates a name the image imports twice', () => {
    const image = join(root, 'dupe.dll')
    writeFileSync(image, buildPe(['MSVCP140.dll', 'MSVCP140.dll']))
    expect(engineRuntimeRequirements(image)).toEqual(['MSVCP140.dll'])
  })
})

describe('readPeImports', () => {
  it('reports the DLLs an image imports, in the spelling the image uses', () => {
    const image = join(root, 'fixture.dll')
    writeFileSync(image, buildPe(['MSVCP140.dll', 'KERNEL32.dll']))
    expect(readPeImports(image)).toEqual(['MSVCP140.dll', 'KERNEL32.dll'])
  })
})

describe('recordedRuntimeRequirements', () => {
  it('reads the names the build recorded', () => {
    const descriptor = join(root, 'desktop-runtime.json')
    writeFileSync(descriptor, JSON.stringify({ engineRuntime: { present: true, required: ['MSVCP140.dll'] } }))
    expect(recordedRuntimeRequirements(descriptor)).toEqual(['MSVCP140.dll'])
  })

  it('yields an empty list rather than throwing on anything unusable', () => {
    // Losing the names costs the detail line, never the diagnosis, so none of these may throw.
    const descriptor = join(root, 'desktop-runtime.json')
    writeFileSync(descriptor, 'not json at all')
    expect(recordedRuntimeRequirements(descriptor)).toEqual([])
    writeFileSync(descriptor, JSON.stringify({ engineRuntime: { present: false } }))
    expect(recordedRuntimeRequirements(descriptor)).toEqual([])
    writeFileSync(descriptor, JSON.stringify({ engineRuntime: { required: 'MSVCP140.dll' } }))
    expect(recordedRuntimeRequirements(descriptor)).toEqual([])
    writeFileSync(descriptor, JSON.stringify({ engineRuntime: { required: ['ok.dll', 7, ''] } }))
    expect(recordedRuntimeRequirements(descriptor)).toEqual(['ok.dll'])
    expect(recordedRuntimeRequirements(join(root, 'absent.json'))).toEqual([])
  })
})

describe('unresolvedRuntimeDlls', () => {
  it('follows the loader order: the engine directory first, then System32', () => {
    const engineDir = join(root, 'bin')
    mkdirSync(engineDir, { recursive: true })
    const system32 = join(root, 'win', 'System32')
    mkdirSync(system32, { recursive: true })
    writeFileSync(join(engineDir, 'beside.dll'), 'x')
    writeFileSync(join(system32, 'system.dll'), 'x')

    const missing = unresolvedRuntimeDlls({
      engine: join(engineDir, ENGINE_EXECUTABLE),
      required: ['beside.dll', 'system.dll', 'nowhere.dll'],
      env: { SystemRoot: join(root, 'win') },
    })
    expect(missing).toEqual(['nowhere.dll'])
  })

  it('treats every name as missing when there is no SystemRoot to consult', () => {
    const engineDir = join(root, 'bin')
    mkdirSync(engineDir, { recursive: true })
    expect(unresolvedRuntimeDlls({
      engine: join(engineDir, ENGINE_EXECUTABLE),
      required: ['MSVCP140.dll'],
      env: {},
    })).toEqual(['MSVCP140.dll'])
  })
})

describe('askEngineToStart', () => {
  /** A scripted program, driven through the documented `args` seam instead of a real engine. */
  function scripted(body) {
    const script = join(root, `probe-${String(Math.random()).slice(2)}.mjs`)
    writeFileSync(script, body)
    return { program: process.execPath, args: [script] }
  }

  it('treats any output as able to start, whatever the exit code', async () => {
    // The branch that makes the whole check work: the real engine answers a bare invocation with a
    // JSON error and exits 1, so the exit code is non-zero in the healthy case too.
    const { program, args } = scripted('process.stdout.write(\'{"ok":false,"error":"Worker requires absolute paths"}\\n\');process.exit(1)\n')
    const result = await askEngineToStart(program, { args, timeoutMs: 15_000 })
    expect(result.spoke).toBe(true)
    expect(result.outcome).toBe('the engine answered')
  })

  it('treats a silent non-zero exit as unable to start — the case a missing runtime produces', async () => {
    // Measured on the real engine with its runtime remade unusable: no output at all, exit
    // 0xC000012F. Nothing but the absence of output distinguishes it from the case above.
    //
    // THE CODE IS EXPECTED IN THE FORM THE HOST CAN REPORT, not in the Windows spelling. `0xC000012F`
    // is a 32-bit Windows status and Windows preserves it, but a POSIX exit status carries the low
    // byte only — `wait(2)` masks it before anything in this process can see it — so the same
    // scripted exit arrives here as `0x2F`. Requiring the Windows spelling off Windows would assert
    // the host rather than the one thing this test is about, which is that the status reaches the
    // message in hex at all; the exact value is asserted, just against what the host reported.
    const FULL_CODE = 3221225775
    const reported = process.platform === 'win32' ? FULL_CODE : (FULL_CODE & 0xff)
    const { program, args } = scripted(`process.exit(${FULL_CODE})\n`)
    const result = await askEngineToStart(program, { args, timeoutMs: 15_000 })
    expect(result.spoke).toBe(false)
    expect(result.outcome).toContain('no output')
    expect(result.outcome).toMatch(/exit 0x[0-9A-F]+/)
    expect(result.outcome).toContain(`0x${(reported >>> 0).toString(16).toUpperCase()}`)
  })

  it('counts output on stderr as an answer', async () => {
    // The loader writes its own diagnostics there, and a process that reached its startup path has
    // resolved its imports either way.
    const { program, args } = scripted('process.stderr.write("something\\n")\n')
    const result = await askEngineToStart(program, { args, timeoutMs: 15_000 })
    expect(result.spoke).toBe(true)
  })

  it('reports a program that cannot be launched instead of throwing', async () => {
    const result = await askEngineToStart(join(root, 'does-not-exist.exe'), { timeoutMs: 5_000 })
    expect(result.spoke).toBe(false)
    expect(result.outcome).not.toBe('')
  })

  it('reports a program that never answers, rather than waiting forever', async () => {
    // Bounded by the timeout so a hung engine cannot hold the dialog decision open indefinitely.
    const { program, args } = scripted('setTimeout(() => {}, 60_000)\n')
    const started = Date.now()
    const result = await askEngineToStart(program, { args, timeoutMs: 700 })
    expect(result.spoke).toBe(false)
    expect(result.outcome).toContain('no answer within 700 ms')
    expect(Date.now() - started).toBeLessThan(30_000)
  })

  const engine = join(engineBinDir(join(DIST_DIR, 'runtime', 'dsh')), ENGINE_EXECUTABLE)
  it.skipIf(!existsSync(engine))('finds the real engine able to start', async () => {
    // The end-to-end positive case, against the shipped binary rather than a stand-in.
    const result = await askEngineToStart(engine, { timeoutMs: 30_000 })
    expect(result.spoke).toBe(true)
  })
})

describe('checkOfficeEngine', () => {
  it('is skipped, not broken, when neither the tree nor the install root has an engine', async () => {
    // A tree built with `plugin` mode has no engine package at all — every Windows and Linux build
    // does now — and a user must not be told to install a Windows runtime because of it.
    const runtimeDir = makeTree({ engine: false, required: [] })
    const status = await checkOfficeEngine({ runtimeDir, home: isolatedHome() })
    expect(status.kind).toBe('skipped')
    if (status.kind !== 'skipped') throw new Error('unreachable')
    // Both places it looked, so a later reader can tell "nowhere" from "somewhere unreadable".
    expect(status.reason).toContain('nor under')
  })

  it('is ready when the engine answers', async () => {
    const runtimeDir = makeTree({ required: ['MSVCP140.dll'] })
    const status = await checkOfficeEngine({
      runtimeDir,
      home: isolatedHome(),
      probe: async () => ({ spoke: true, outcome: 'the engine answered' }),
    })
    expect(status).toEqual({ kind: 'ready' })
  })

  it('is broken, and names what is absent, when the engine says nothing', async () => {
    const runtimeDir = makeTree({ required: ['MSVCP140.dll', 'VCRUNTIME140.dll'] })
    const status = await checkOfficeEngine({
      runtimeDir,
      home: isolatedHome(),
      // A SystemRoot with nothing in it, so the names are unresolved for a known reason. The real
      // one is deliberately not consulted here: this machine has the redistributable installed, and
      // a test whose result depends on that would pass for the wrong reason on this host and fail
      // on a clean one.
      env: { SystemRoot: join(root, 'no-such-windows') },
      probe: async () => ({ spoke: false, outcome: 'the engine produced no output (exit 0xC0000135)' }),
    })
    expect(status.kind).toBe('broken')
    if (status.kind !== 'broken') throw new Error('unreachable')
    expect(status.missing).toEqual(['MSVCP140.dll', 'VCRUNTIME140.dll'])
    expect(status.outcome).toContain('0xC0000135')
  })

  it('reports no missing names when the runtime is present but the engine still says nothing', async () => {
    // The honest answer when the files resolve and the engine fails anyway: an antivirus product
    // holding the executable, or a policy refusing to load it. Printing a name here would be a
    // guess, and the dialog already says what to install.
    const runtimeDir = makeTree({ required: ['MSVCP140.dll'] })
    const engineDir = engineBinDir(runtimeDir)
    writeFileSync(join(engineDir, 'MSVCP140.dll'), 'present\n')
    const status = await checkOfficeEngine({
      runtimeDir,
      home: isolatedHome(),
      env: { SystemRoot: join(root, 'no-such-windows') },
      probe: async () => ({ spoke: false, outcome: 'the engine produced no output' }),
    })
    expect(status).toEqual({ kind: 'broken', missing: [], outcome: 'the engine produced no output' })
  })

  it('is still broken with an empty name list when the descriptor cannot be read', async () => {
    // The diagnosis survives the loss of the detail; an empty list is what the notice has to
    // handle without claiming nothing is wrong.
    const runtimeDir = makeTree()
    const status = await checkOfficeEngine({
      runtimeDir,
      home: isolatedHome(),
      probe: async () => ({ spoke: false, outcome: 'the engine produced no output' }),
    })
    expect(status).toEqual({
      kind: 'broken',
      missing: [],
      outcome: 'the engine produced no output',
    })
  })

  it('probes an engine the on-demand installer wrote when the tree carries none', async () => {
    // THE PARITY THIS EXISTS FOR. Windows builds without the engine now, so a check that read the
    // tree alone would answer `skipped` on exactly the machine that can still hit the failure this
    // module reports: an installed engine loads the same MSVC runtime and dies the same way.
    const runtimeDir = makeTree({ engine: false, required: ['MSVCP140.dll'] })
    const engineDir = installEngine(isolatedHome(), '0.1.5')

    const probed = []
    const status = await checkOfficeEngine({
      runtimeDir,
      home: isolatedHome(),
      env: { SystemRoot: join(root, 'no-such-windows') },
      probe: async (engine) => {
        probed.push(engine)
        return { spoke: false, outcome: 'the engine produced no output' }
      },
    })
    // Probed, and named against its own directory rather than the tree's absent one.
    expect(probed).toEqual([join(engineDir, ENGINE_EXECUTABLE)])
    expect(status.kind).toBe('broken')
    if (status.kind !== 'broken') throw new Error('unreachable')
    expect(status.missing).toEqual(['MSVCP140.dll'])
  })

  it('prefers the tree engine over an installed one', async () => {
    // The kit searches its own directory before `NODE_PATH`, so a tree that still carries an engine
    // is the one whose failure the user sees. Naming the installed copy would describe a program
    // that was not the one loaded.
    const runtimeDir = makeTree({ required: ['MSVCP140.dll'] })
    installEngine(isolatedHome(), '0.1.5')

    const probed = []
    await checkOfficeEngine({
      runtimeDir,
      home: isolatedHome(),
      probe: async (engine) => {
        probed.push(engine)
        return { spoke: true, outcome: 'the engine answered' }
      },
    })
    expect(probed).toEqual([join(engineBinDir(runtimeDir), ENGINE_EXECUTABLE)])
  })
})

describe('engineCandidates', () => {
  it('lists the tree engine first, then installed versions newest first', () => {
    const runtimeDir = makeTree({ required: [] })
    const bins = new Map()
    for (const version of ['0.1.5', '0.1.10', '0.2.0']) bins.set(version, installEngine(isolatedHome(), version))

    // `0.1.10` above `0.1.5` is the point of using the numeric comparator rather than a string
    // sort, which would order them the other way and offer a downgrade as the newest engine.
    const expected = ['0.2.0', '0.1.10', '0.1.5'].map((version) => join(bins.get(version), ENGINE_EXECUTABLE))
    expect(engineCandidates({ runtimeDir, home: isolatedHome() })).toEqual([
      join(engineBinDir(runtimeDir), ENGINE_EXECUTABLE),
      ...expected,
    ])
  })

  it('ignores a directory that is not a version, and an absent install root', () => {
    // An absent root is the normal state of a machine that never installed an engine; a stray
    // directory is not a reason to report an engine that cannot be there.
    const runtimeDir = makeTree({ engine: false, required: [] })
    const only = [join(engineBinDir(runtimeDir), ENGINE_EXECUTABLE)]
    expect(engineCandidates({ runtimeDir, home: isolatedHome() })).toEqual(only)

    mkdirSync(join(isolatedHome(), 'engines', 'libreoffice-kit', 'not-a-version'), { recursive: true })
    expect(engineCandidates({ runtimeDir, home: isolatedHome() })).toEqual(only)
  })
})

describe('VC_REDIST_URL', () => {
  // The installer instead of the page about it. Until 0.4.7 this was
  // `learn.microsoft.com/.../latest-supported-vc-redist`, a documentation article, so a control
  // labelled "Download…" started a search. `aka.ms/vc14` is Microsoft's stable alias for the current
  // v14 x64 package (measured 2026-10-22: redirects to an 18,731,856-byte VC_redist.x64.exe).
  //
  // The wording that used to be asserted here moved to the browser bundle with the dialog it served
  // (`packages/qialike-desktop-office-engine/lib/client.js`, dictionary keys `runtimeMissing` /
  // `runtimeOutdated`). The module now reports facts — `kind`, `missing`, `outcome` — and the client
  // decides how to say them, which is the only way one sentence can be written in two languages.
  it('is the installer Microsoft publishes, not an article about it', () => {
    expect(VC_REDIST_URL).toBe('https://aka.ms/vc14/vc_redist.x64.exe')
  })
})

describe('checkEngineRuntime (the gate)', () => {
  function writeDescriptor(runtimeDir, engineRuntime) {
    writeFileSync(
      join(runtimeDir, 'desktop-runtime.json'),
      `${JSON.stringify({ platform: 'win32', arch: 'x64', engineRuntime }, null, 2)}\n`,
    )
  }

  it('is clean for a tree without the engine', () => {
    const runtimeDir = makeTree({ engine: false })
    writeDescriptor(runtimeDir, { present: false, reason: 'no engine' })
    expect(checkEngineRuntime(runtimeDir)).toEqual([])
  })

  it('is clean when the descriptor records what the engine imports', () => {
    const runtimeDir = makeTree({ engine: buildPe(['MSVCP140.dll', 'KERNEL32.dll']), required: ['MSVCP140.dll'] })
    writeDescriptor(runtimeDir, { present: true, required: ['MSVCP140.dll'] })
    expect(checkEngineRuntime(runtimeDir)).toEqual([])
  })

  it('compares names case-insensitively, so a spelling round-trip is not a gap', () => {
    const runtimeDir = makeTree({ engine: buildPe(['MSVCP140.dll']), required: ['msvcp140.dll'] })
    writeDescriptor(runtimeDir, { present: true, required: ['msvcp140.dll'] })
    expect(checkEngineRuntime(runtimeDir)).toEqual([])
  })

  it('reports a descriptor that records no requirement for a tree that has an engine', () => {
    const runtimeDir = makeTree({ engine: buildPe(['MSVCP140.dll']) })
    writeDescriptor(runtimeDir, { present: false, reason: 'stale' })
    const violations = checkEngineRuntime(runtimeDir)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.detail).toMatch(/records no external runtime requirement/u)
  })

  it('reports an engine whose import the descriptor omits', () => {
    // The case an engine swapped in after assembly produces: the shell would have no name to give.
    const runtimeDir = makeTree({ engine: buildPe(['MSVCP140.dll', 'MSVCP140_ATOMIC_WAIT.dll']) })
    writeDescriptor(runtimeDir, { present: true, required: ['MSVCP140.dll'] })
    const violations = checkEngineRuntime(runtimeDir)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.detail).toContain('MSVCP140_ATOMIC_WAIT.dll')
  })

  it('does not report a tree that has no descriptor yet', () => {
    const runtimeDir = makeTree({ engine: buildPe(['MSVCP140.dll']) })
    expect(checkEngineRuntime(runtimeDir)).toEqual([])
  })

  it('does not report an engine it cannot read, which is the build step\'s failure to raise', () => {
    // A truncated image has no import table to compare, and inventing a violation here would
    // report the gate's own parse as a defect in the tree. The build reads the same binary and
    // refuses on an unreadable one, which is where that belongs.
    const runtimeDir = makeTree({ engine: Buffer.from('not a PE image\n') })
    writeDescriptor(runtimeDir, { present: true, required: ['MSVCP140.dll'] })
    expect(checkEngineRuntime(runtimeDir)).toEqual([])
  })
})

describe('describeEngineRuntime', () => {
  it('records the requirements of a bundled Windows engine', () => {
    // The happy path, and the only one this machine can produce a real binary for: a PE image whose
    // MSVC imports are read out of the import table rather than written down.
    const runtimeDir = makeTree({ engine: buildPe(['MSVCP140.dll', 'KERNEL32.dll']) })
    const lines = []
    const result = describeEngineRuntime(runtimeDir, (line) => lines.push(line), {
      platform: 'win32',
      officeEngine: 'bundled',
    })
    expect(result.present).toBe(true)
    expect(result.required).toEqual(['MSVCP140.dll'])
    expect(lines.join('\n')).toMatch(/1 external runtime dll/u)
  })

  it('names the policy, not a targeting mistake, when a Windows build left it out', () => {
    // THE REASON THIS IS TESTABLE AT ALL. The wording used to be one string for every absence, which
    // read "not a win32-x64 runtime" — true for Linux, and a lie for a Windows tree that has no
    // engine because the build deliberately left it out. That case became the DEFAULT when Windows
    // began installing on demand, and no machine here can build a win32 tree to notice it.
    const runtimeDir = makeTree({ engine: false })
    const result = describeEngineRuntime(runtimeDir, () => {}, {
      platform: 'win32',
      officeEngine: 'plugin',
    })
    expect(result.present).toBe(false)
    expect(result.reason).toMatch(/leaves .* out/u)
    expect(result.reason).toMatch(/installed on demand/u)
    expect(result.reason).not.toMatch(/not a win32-x64 runtime/u)
  })

  it('still says "not a win32-x64 runtime" for a tree that is not one', () => {
    // A Linux or macOS tree never carries this engine, and the absence there means what the old
    // wording said. Keeping the two apart is the whole point of the branch.
    const runtimeDir = makeTree({ engine: false })
    for (const platform of ['linux', 'darwin']) {
      const result = describeEngineRuntime(runtimeDir, () => {}, { platform, officeEngine: 'bundled' })
      expect(result.present, platform).toBe(false)
      expect(result.reason, platform).toMatch(/not a win32-x64 runtime/u)
    }
  })

  it('refuses a Windows build that asked to bundle and has no engine', () => {
    // A DEFECT RATHER THAN A CONFIGURATION, and silent otherwise: the release would ship with an
    // Office preview that cannot work and a descriptor that does not say why. Same choice
    // `pruneNonRuntimeFiles` makes — stop and name it.
    const runtimeDir = makeTree({ engine: false })
    expect(() => describeEngineRuntime(runtimeDir, () => {}, {
      platform: 'win32',
      officeEngine: 'bundled',
    })).toThrow(/asked to bundle the Office engine for win32/u)
    // And it says what to do about it, because the cause is either a failed install or a wrong choice.
    expect(() => describeEngineRuntime(runtimeDir, () => {}, {
      platform: 'win32',
      officeEngine: 'bundled',
    })).toThrow(/QIALIKE_DESKTOP_OFFICE_ENGINE=plugin/u)
  })

  it('refuses rather than recording an empty requirement set for a Windows engine', () => {
    // The pre-existing guard: a Windows tree whose engine declares no MSVC import would defeat the
    // startup check silently, so zero is a build failure rather than an accepted answer.
    const runtimeDir = makeTree({ engine: buildPe(['KERNEL32.dll']) })
    expect(() => describeEngineRuntime(runtimeDir, () => {}, {
      platform: 'win32',
      officeEngine: 'bundled',
    })).toThrow(/read no external runtime requirement/u)
  })
})

describe('the install root layout, as the writer and the reader must agree on it', () => {
  /** A real tarball holding one engine, as npm publishes it. */
  function win32Tarball() {
    const dir = join(root, 'src-win32')
    mkdirSync(join(dir, 'package', 'bin'), { recursive: true })
    writeFileSync(
      join(dir, 'package', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-win32-x64', version: '0.1.5' }),
    )
    writeFileSync(join(dir, 'package', 'bin', ENGINE_EXECUTABLE), buildPe(['MSVCP140.dll']))
    const out = join(root, 'win32.tgz')
    execFileSync('tar', ['--format=ustar', '-czf', out, '-C', dir, 'package'])
    return readFileSync(out)
  }

  it('finds an engine that the installer really wrote', async () => {
    // WRITTEN AGAINST THE REAL WRITER, ON PURPOSE. This is the test that was missing, and its absence
    // cost a silent defect: `installedEnginePath` assembled the layout from an assumption and omitted
    // the `<target>` segment `installEngine` writes, so the reader looked in
    // `…/<version>/node_modules/…` while the engine sat in `…/<version>/<target>/node_modules/…`.
    //
    // WHAT MADE IT INVISIBLE. The check then answers `skipped` — "there is no engine", which is a
    // legitimate outcome that shows no dialog — so nothing failed anywhere; the redistributable
    // diagnosis, the entire reason this module consults the install root, had simply stopped firing.
    // And the unit tests could not see it either, because their fixture spelled the same wrong path
    // by hand: fixture and reader agreed with each other and both disagreed with the writer.
    //
    // A fixture built from the layout's own helpers cannot drift. This goes one step further and
    // asserts against bytes a real install actually placed, which is the only version of the claim
    // that cannot be satisfied by two mistakes matching.
    const tarball = win32Tarball()
    const body = tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    const engineHome = isolatedHome()
    const installed = await installEngineForReal({
      platform: 'win32',
      arch: 'x64',
      version: '0.1.5',
      home: engineHome,
      fetchImpl: async (url) => {
        if (url.endsWith('.tgz')) return { ok: true, arrayBuffer: async () => body }
        return { ok: true, json: async () => ({ versions: { '0.1.5': { dist: { integrity } } } }) }
      },
    })

    // The writer put it here…
    const written = join(
      enginePackageDir(engineInstallRoot(engineHome, '0.1.5', 'win32-x64'), '@deepseek-ai/libreoffice-kit-win32-x64'),
      'bin', ENGINE_EXECUTABLE,
    )
    expect(existsSync(written)).toBe(true)
    expect(installed.target).toBe('win32-x64')

    // …and the reader looks here. Both halves in one assertion, so a change on either side is caught.
    const candidates = engineCandidates({ runtimeDir: join(root, 'a-tree-with-no-engine'), home: engineHome })
    expect(candidates).toContain(written)

    // And the checker picks it rather than reporting `skipped`, which is what the defect looked like.
    const status = await checkOfficeEngine({
      runtimeDir: join(root, 'a-tree-with-no-engine'),
      home: engineHome,
      env: { SystemRoot: 'C:\\Windows' },
      probe: async () => ({ spoke: false, outcome: 'no output' }),
    })
    expect(status.kind).not.toBe('skipped')
  })
})
