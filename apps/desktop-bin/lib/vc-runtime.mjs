/**
 * The external runtime the bundled Office engine loads, derived from the engine binary itself.
 *
 * WHY THIS IS DERIVED AND NOT LISTED. The engine is a 170 MB statically linked LibreOffice build
 * that imports no LibreOffice library, which is what lets the document preview work on a machine
 * with no LibreOffice installed. What it does import is a set of MSVC runtime DLLs that Windows
 * does not supply: `api-ms-win-crt-*` and `ucrtbase` come from the operating system, but
 * `msvcp140.dll`, `msvcp140_1.dll`, `msvcp140_2.dll`, `vcruntime140.dll` and
 * `vcruntime140_1.dll` come from the Visual C++ Redistributable. A machine without it cannot start
 * the engine at all.
 *
 * This project does not ship those files. They are read out of the engine's import table at build
 * time and recorded in the runtime descriptor, so the shell can tell the user which ones the
 * loader could not resolve. Deriving the set from the binary rather than hardcoding it is the
 * point: an engine that starts importing something new is reported, instead of being described by
 * a list that was written for an older build.
 *
 * The Windows loader resolves the whole import table before an image's first instruction runs, so
 * this set is exactly "what must be present for the process to start" — not a superset, and not a
 * matter of which code path happens to execute.
 *
 * @module qialike-desktop-bin/vc-runtime
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The engine executable's name, as its `prebuilds.json` declares it. */
export const ENGINE_EXECUTABLE = 'libreoffice-kit.exe'

/**
 * The import-name pattern identifying the runtime a machine may not have.
 *
 * Wider than the current engine's imports on purpose. Windows supplies `kernel32`, `gdi32` and the
 * `api-ms-win-crt-*` set on every supported release, so those can never be the reason an engine
 * fails to start and reporting them would be noise. The MSVC families are the ones that come from
 * a separate installation, and `msvcp140_atomic_wait.dll` — a real file in the same redistributable
 * folder that this engine does not currently import — is the example of why the pattern is not
 * narrowed to the names seen today.
 */
export const MSVC_RUNTIME_PATTERN = /^(msvcp\d|vcruntime\d|concrt\d|vccorlib\d)/i

/**
 * The directory the engine executable lives in, inside the runtime tree.
 *
 * Also the directory the loader searches first for the runtime DLLs, which is why it is worth
 * naming here: a copy placed beside the engine wins over the system one, with no version
 * comparison involved.
 *
 * @param runtimeDir - the assembled runtime tree.
 * @returns the engine's `bin` directory, whether or not it exists.
 */
export function engineBinDir(runtimeDir) {
  return join(runtimeDir, 'node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64', 'bin')
}

/**
 * Parse the parts of a PE image that both readers need: the bytes, an RVA mapper, and the data
 * directories.
 *
 * @param path - the image to read.
 * @returns the parsed view, or undefined when the file is absent or not a PE image.
 */
function readPeImage(path) {
  let buf
  try {
    buf = readFileSync(path)
  } catch {
    return undefined
  }
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return undefined
  const peOffset = buf.readUInt32LE(0x3c)
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) return undefined

  const coff = peOffset + 4
  const sectionCount = buf.readUInt16LE(coff + 2)
  const optionalSize = buf.readUInt16LE(coff + 16)
  const optional = coff + 20
  const pe32Plus = buf.readUInt16LE(optional) === 0x20b
  const directories = optional + (pe32Plus ? 112 : 96)

  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = optional + optionalSize + index * 40
    if (entry + 40 > buf.length) break
    sections.push({
      virtualAddress: buf.readUInt32LE(entry + 12),
      rawSize: buf.readUInt32LE(entry + 16),
      rawPointer: buf.readUInt32LE(entry + 20),
    })
  }
  const toOffset = (rva) => {
    for (const section of sections) {
      if (rva >= section.virtualAddress && rva < section.virtualAddress + Math.max(section.rawSize, 1)) {
        return section.rawPointer + (rva - section.virtualAddress)
      }
    }
    return undefined
  }
  const directoryRva = (index) => {
    const at = directories + index * 8
    return at + 8 > buf.length ? 0 : buf.readUInt32LE(at)
  }
  return { buf, toOffset, directoryRva }
}

/**
 * Read the DLL names a PE image imports statically.
 *
 * Names come back as the image spells them, which is upper-case for the MSVC runtime. The
 * comparison against {@link MSVC_RUNTIME_PATTERN} is case-insensitive for that reason, and the
 * returned spelling is kept verbatim so a diagnostic quotes the loader's own name rather than a
 * normalised one.
 *
 * @param path - the PE image to read.
 * @returns the imported DLL names, or an empty list when the file is not a readable PE image.
 */
export function readPeImports(path) {
  const image = readPeImage(path)
  if (image === undefined) return []
  const { buf, toOffset, directoryRva } = image
  const importsRva = directoryRva(1)
  if (importsRva === 0) return []

  const names = []
  const descriptors = toOffset(importsRva)
  if (descriptors === undefined) return []
  // Bounded: the descriptor list is terminated by an all-zero entry, and a malformed image that
  // omits it must not walk the whole file.
  for (let index = 0; index < 512; index += 1) {
    const descriptor = descriptors + index * 20
    if (descriptor + 20 > buf.length) break
    const nameRva = buf.readUInt32LE(descriptor + 12)
    const firstThunk = buf.readUInt32LE(descriptor + 16)
    if (nameRva === 0 && firstThunk === 0) break
    const nameOffset = toOffset(nameRva)
    if (nameOffset === undefined) break
    const end = buf.indexOf(0, nameOffset)
    if (end < 0) break
    names.push(buf.toString('ascii', nameOffset, end))
  }
  return names
}

/**
 * The DLLs an engine needs that the operating system does not provide.
 *
 * @param enginePath - the engine executable.
 * @returns the runtime DLL names, de-duplicated and sorted; empty when the file is unreadable.
 */
export function engineRuntimeRequirements(enginePath) {
  const names = readPeImports(enginePath).filter((name) => MSVC_RUNTIME_PATTERN.test(name))
  return [...new Set(names)].sort()
}

/**
 * Record the external runtime the Office engine loads, and say which absence this is.
 *
 * The engine is a statically linked LibreOffice build that imports no LibreOffice library, so it
 * runs without LibreOffice installed; what it does import is a set of MSVC runtime DLLs that come
 * from the Visual C++ Redistributable rather than from Windows. Those are not shipped — an
 * application-local copy never receives Microsoft's updates — so the machine's own
 * redistributable stays authoritative and the shell reports it at startup when it is absent.
 *
 * The list is read out of the engine binary, never written down for it: an engine that begins
 * importing something new is then described correctly without this file being edited.
 *
 * A tree without the engine is recorded as such rather than as an empty requirement — an empty list
 * would say "this engine needs nothing" instead of "there is no engine". There are THREE reasons a
 * tree can lack it, and they are not interchangeable:
 *
 *   · the tree is not a Windows one, where the engine package is a `win32-x64` optional dependency
 *     and is simply never installed;
 *   · the build deliberately left it out (`QIALIKE_DESKTOP_OFFICE_ENGINE=plugin`, the Windows
 *     default), which is a policy and not a fault;
 *   · a Windows build ASKED to bundle it and does not have it. That is a defect, and it throws,
 *     because the alternative is a release whose Office preview cannot work and whose descriptor
 *     does not say why.
 *
 * @param runtimeDir - the assembled runtime tree.
 * @param log - receives one line when the tree carries an engine.
 * @param options.platform - the platform this tree targets, which separates the first reason from
 *   the other two.
 * @param options.officeEngine - the policy this build ran under.
 * @returns the descriptor's `engineRuntime` value.
 * @throws Error when a Windows build asked to bundle the engine and the tree has none, or when a
 *   present engine's import table could not be read.
 */
export function describeEngineRuntime(runtimeDir, log, { platform, officeEngine }) {
  const binDir = engineBinDir(runtimeDir)
  const relative = join('node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64', 'bin', ENGINE_EXECUTABLE)
  const enginePath = join(binDir, ENGINE_EXECUTABLE)
  if (!existsSync(enginePath)) {
    // TWO DIFFERENT ABSENCES, AND NAMING THE WRONG ONE MISLEADS. The original wording assumed the
    // only reason a tree lacks this engine is that the tree is not a Windows one. That stopped being
    // the whole truth when Windows began shipping without it: a `win32-x64` tree built in `plugin`
    // mode IS a win32-x64 runtime, and a descriptor claiming otherwise sends whoever reads it — or
    // quotes it in a bug report — looking for a targeting mistake that never happened.
    if (platform === 'win32' && officeEngine === 'plugin') {
      return {
        present: false,
        reason: `this build leaves ${relative} out (QIALIKE_DESKTOP_OFFICE_ENGINE=plugin); `
          + 'the engine is installed on demand',
      }
    }
    // A Windows build that ASKED to bundle and has no engine is a defect, not a configuration, and
    // it is silent otherwise: the release would go out with an Office preview that cannot work and
    // no recorded reason. Refusing here is the same choice `pruneNonRuntimeFiles` makes — stop and
    // name it rather than ship a tree that contradicts what it was asked to be.
    if (platform === 'win32') {
      throw new Error(
        `qialike-desktop: this build asked to bundle the Office engine for win32 but ${relative} is `
        + 'absent from the tree, so the release would ship without one. Check that the engine package '
        + 'installed (it is an optionalDependency of the kit), or build with '
        + `QIALIKE_DESKTOP_OFFICE_ENGINE=plugin to install it on demand instead.`,
      )
    }
    return { present: false, reason: `no ${relative} in this tree (not a win32-x64 runtime)` }
  }
  const required = engineRuntimeRequirements(enginePath)
  // A Windows tree whose engine declares no such import would defeat the startup check silently,
  // so it is stated rather than accepted: every engine build measured needs five, and zero means
  // the import table was not read.
  if (required.length === 0) {
    throw new Error(
      `qialike-desktop: read no external runtime requirement from ${relative}. The engine's import `
      + 'table was not parsed, so the shell would have nothing to report when the Microsoft runtime '
      + 'is missing on a user machine.',
    )
  }
  log(`engine: ${required.length} external runtime dll(s) required by ${relative}: ${required.join(', ')}`)
  return { present: true, engine: relative.split('\\').join('/'), required }
}
