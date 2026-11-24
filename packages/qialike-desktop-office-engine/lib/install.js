/**
 * Fetching and unpacking the LibreOffice engine, on demand.
 *
 * WHY THIS MODULE EXISTS. The engine is a separate npm package — 145.3 MiB unpacked on Linux,
 * 182.0 MiB on Windows — that every installation used to carry whether or not anyone opens a
 * `.docx`. Moving it out of the package means something has to fetch it back, and that something
 * is this file. The design record is `~/qialike/docs/desktop/office-engine-plugin.md`.
 *
 * WHY IT IMPORTS NOTHING FROM THE HARNESS. `@deepseek-ai/*` resolves in the assembled runtime tree
 * and not in this repository's `node_modules`, so a module that imported one could not be unit
 * tested here at all. Everything worth testing therefore lives in this file, and the row that
 * mounts it holds nothing but wiring — the same split `qialike-desktop-edit-follow` uses, for the
 * same reason.
 *
 * WHY NOT `npm install`, AND WHY THAT IS NOT A SHORTCUT. The engine's version is pinned by the
 * `libreoffice-kit` already in the tree: the kit refuses an engine whose manifest version differs,
 * and `ENGINE_VERSIONS` names exactly one acceptable version per target. So there is no dependency
 * to resolve and no tree to build — the whole job is one artifact, fetched, checked against a
 * published digest, and unpacked. A package manager would add a lockfile, a resolution algorithm
 * and a supply-chain surface to do what forty lines of verified download do here.
 *
 * @module @qialike/qialike-desktop-office-engine/install
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** The npm scope and name prefix the kit's engine packages share. */
export const ENGINE_PREFIX = '@deepseek-ai/libreoffice-kit-'

/** The target name the kit uses for its WebAssembly engine. */
export const WASM_TARGET = 'wasm'

/**
 * The registries to try, in order, and the order is the point.
 *
 * npmmirror first because this product's users are the reason it exists: npmjs.org is not reliably
 * reachable from mainland China, which is also why the release hosts are GitHub *and* GitCode
 * (`qialike-desktop-update.md`). The public registry stays as the second source rather than being
 * dropped, because a mirror can be unreachable in the other direction — a machine outside China,
 * or one whose network blocks the mirror.
 *
 * Both serve byte-identical tarballs, which is what makes the order a preference rather than a
 * decision with consequences: the digest verified below is the same either way.
 */
export const DEFAULT_REGISTRIES = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org',
]

/** A path inside a tar archive, as the archive spells it. */
const TAR_BLOCK = 512

/**
 * The kit's target id for a host, mirroring `platformTarget` in `libreoffice-kit`.
 *
 * MIRRORED RATHER THAN CALLED: the kit is in the runtime tree, which this module cannot import.
 * The rule it applies is short enough to state: `darwin` and `win32` use `<platform>-<arch>`, and
 * `linux` uses `<platform>-<arch>-glibc` **only when the host has glibc** — musl Linux gets
 * nothing, which is why the kit's own Linux path falls through to WebAssembly.
 *
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @param options.glibc - whether the host reports a glibc runtime version.
 * @returns the target, or undefined when the kit has no native engine for this host.
 */
export function engineTarget(platform, arch, { glibc = true } = {}) {
  // The kit accepts exactly these two, on every platform. armv7 or ia32 has no engine at all.
  if (arch !== 'arm64' && arch !== 'x64') return undefined
  if (platform === 'darwin' || platform === 'win32') return `${platform}-${arch}`
  if (platform === 'linux') return glibc ? `linux-${arch}-glibc` : undefined
  return undefined
}

/**
 * Every engine package this host could run, best first.
 *
 * WHY A LIST RATHER THAN ONE NAME, AND WHY IT IS A MEASURED DISTINCTION. The kit prefers a native
 * engine and falls back to WebAssembly, but only on Linux — reading `resolveEngine`: when the native
 * package is missing it continues to the wasm engine **only if `platform === 'linux'`**, and throws
 * `Required LibreOfficeKit native package is missing` otherwise.
 *
 * The list matters because a *declared* target is not a *published* package. On Linux with glibc the
 * kit's target table names `linux-x64-glibc`, and MEASURED, that package does not exist:
 *
 *     registry.npmmirror.com/@deepseek-ai/libreoffice-kit-linux-x64-glibc   404
 *     registry.npmmirror.com/@deepseek-ai/libreoffice-kit-wasm              200
 *
 * So a caller that took the native name and tried to install it would fail on a 404 for a host the
 * kit can serve perfectly well. The first entry is therefore a preference, not an answer: the caller
 * walks the list until one of them exists, which is the same fallback the kit performs at runtime.
 *
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @param options.glibc - whether the host reports a glibc runtime version.
 * @returns `{ name, target }` per candidate, most specific first.
 * @throws Error when this host has no engine the kit would accept.
 */
export function enginePackageCandidates(platform, arch, { glibc = true } = {}) {
  const native = engineTarget(platform, arch, { glibc })
  const candidates = []
  if (native !== undefined) candidates.push({ name: `${ENGINE_PREFIX}${native}`, target: native })
  // The WebAssembly engine is a Linux fallback only. Elsewhere the kit never looks at it, so
  // installing it would be 145 MiB of download for a file nothing opens.
  if (platform === 'linux') {
    candidates.push({ name: `${ENGINE_PREFIX}${WASM_TARGET}`, target: WASM_TARGET })
  }
  if (candidates.length === 0) {
    throw new Error(
      `qialike-desktop: no LibreOffice engine exists for ${platform}-${arch}. The kit has no native `
      + 'package for it and falls back to WebAssembly on Linux only, so there is nothing to install.',
    )
  }
  return candidates
}

/**
 * The package holding the engine for this host, when only one name can be given.
 *
 * The first candidate, which is the kit's own preference and not necessarily a package that exists
 * — see {@link enginePackageCandidates}. Callers that can try more than one should not use this.
 *
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @param options.glibc - whether the host reports a glibc runtime version.
 * @returns the preferred package name.
 * @throws Error when this host has no installable engine.
 */
export function enginePackageName(platform, arch, { glibc = true } = {}) {
  return enginePackageCandidates(platform, arch, { glibc })[0].name
}

/** The one engine version the kit in this tree accepts, read rather than assumed. */
export function engineVersion(kitDir) {
  const source = readFileSync(join(kitDir, 'lib', 'index.js'), 'utf8')
  const match = /ENGINE_VERSION\s*=\s*"([^"]+)"/u.exec(source)
  if (match?.[1] === undefined) {
    throw new Error(
      `qialike-desktop: read no ENGINE_VERSION from ${join(kitDir, 'lib', 'index.js')}. The kit's `
      + 'version table is not a public API, so this parse is how we learn which engine it accepts.',
    )
  }
  return match[1]
}

/**
 * Where one engine's files live under a root.
 *
 * `node_modules/<name>` because that is what a Node resolver looks for, and the root is put on
 * `NODE_PATH` — see `engineSearchPath`.
 *
 * @param root - the directory holding one installed engine.
 * @param name - the package name.
 * @returns the package directory.
 */
export function enginePackageDir(root, name) {
  return join(root, 'node_modules', ...name.split('/'))
}

/**
 * The directory to put on `NODE_PATH` for one engine.
 *
 * VERSION-KEYED, AND THE KIT IS WHY. `readEngine` refuses an engine whose `pkg.version` differs
 * from its own `ENGINE_VERSIONS[target]`, and refuses a manifest whose version, schema or status
 * disagree. Keying the directory by version means a kit upgrade makes the old engine inapplicable
 * rather than confusing — the failure is "not installed", which the interface can offer to fix,
 * instead of "incompatible manifest", which it cannot.
 *
 * @param home - `$DSH_HOME`.
 * @param version - the engine version the kit accepts.
 * @param target - the kit's target id.
 * @returns the root directory for that engine.
 */
export function engineInstallRoot(home, version, target) {
  return join(home, 'engines', 'libreoffice-kit', version, target)
}

/**
 * The tarball URL for one package version.
 *
 * The scope stays literal in the path and the file name is the unscoped one — that is the shape
 * both registries serve, measured against npmmirror and npmjs for this very package.
 *
 * @param registry - the registry base URL.
 * @param name - the package name.
 * @param version - the version.
 * @returns the tarball URL.
 */
export function tarballUrl(registry, name, version) {
  const base = registry.replace(/\/+$/u, '')
  const bare = name.startsWith('@') ? name.split('/')[1] : name
  return `${base}/${name}/-/${bare}-${version}.tgz`
}

/**
 * Read the published digest for one version out of registry metadata.
 *
 * A MISSING DIGEST IS A REFUSAL, NOT A MISSING CHECK. The digest is the only thing standing between
 * a download and 145 MiB of executable content placed on a user's disk, so metadata without one is
 * uninstallable rather than installable-without-verification.
 *
 * @param metadata - the registry's packument.
 * @param version - the version to look up.
 * @returns the SRI integrity string.
 * @throws Error when the version or its digest is absent.
 */
export function integrityOf(metadata, version) {
  const entry = metadata?.versions?.[version]
  if (entry === undefined) {
    throw new Error(`qialike-desktop: registry metadata has no version ${JSON.stringify(version)}.`)
  }
  const integrity = entry?.dist?.integrity
  if (typeof integrity !== 'string' || integrity === '') {
    throw new Error(
      `qialike-desktop: registry metadata for ${JSON.stringify(version)} carries no dist.integrity. `
      + 'Refusing to install an engine that cannot be checked.',
    )
  }
  return integrity
}

/**
 * Whether a buffer matches an SRI integrity string.
 *
 * sha512 only. That is what npm publishes in `dist.integrity`, and accepting a weaker algorithm
 * because some other string arrived would quietly lower the guarantee this check exists to give.
 *
 * @param buffer - the bytes to check.
 * @param integrity - an SRI string, `sha512-<base64>`.
 * @returns whether they match.
 * @throws Error when the string is malformed or names another algorithm.
 */
export function verifyIntegrity(buffer, integrity) {
  const match = /^(sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(String(integrity))
  if (match === null) {
    throw new Error(
      `qialike-desktop: integrity ${JSON.stringify(String(integrity).slice(0, 40))} is not a `
      + 'sha512 SRI string, so it cannot be checked.',
    )
  }
  const actual = createHash('sha512').update(buffer).digest('base64')
  return actual === match[2]
}

/** Read a NUL-terminated string out of a tar header field. */
function field(block, start, length) {
  const end = block.indexOf(0, start)
  const stop = end === -1 || end > start + length ? start + length : end
  return block.toString('utf8', start, stop)
}

/**
 * Read a numeric tar field, octal or GNU base-256.
 *
 * Base-256 is how tar stores a value too large for the field's octal digits, and detecting it is
 * five lines against a silent misparse of a size — which would misread every following entry.
 */
function number(block, start, length) {
  if ((block[start] & 0x80) !== 0) {
    let value = 0
    for (let index = start + 1; index < start + length; index += 1) value = value * 256 + block[index]
    return value
  }
  const text = field(block, start, length).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

/** Whether a header block is all zeroes, which ends the archive. */
function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false
  return true
}

/**
 * Verify a tar header's own checksum.
 *
 * Cheap, and it turns a corrupted or misaligned stream into a named failure at the entry it happens
 * on rather than into a plausible-looking extraction of the wrong bytes.
 *
 * @param block - the 512-byte header.
 * @returns whether the stored checksum matches.
 */
function headerChecksumOk(block) {
  let sum = 0
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    // The checksum field itself counts as spaces.
    sum += index >= 148 && index < 156 ? 32 : block[index]
  }
  return sum === number(block, 148, 8)
}

/**
 * Parse one pax record sequence (`<len> <key>=<value>\n`) into a map.
 *
 * TAKES THE BUFFER, NOT ITS TEXT, AND THAT IS NOT A STYLE CHOICE. A pax record is length-prefixed
 * in BYTES, so slicing it needs byte offsets; `String.prototype` has no `toString(encoding, start,
 * end)` and silently ignores those arguments, which yields the whole body as one record and a map
 * whose only key is the length prefix. That failure is invisible — `path` is simply absent, and the
 * caller then falls back to the header's truncated placeholder — so it is normalised here rather
 * than left to every caller to remember.
 *
 * @param body - the extended header's bytes.
 * @returns the key/value pairs it declares.
 */
function parsePax(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const out = {}
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(bytes.toString('utf8', offset, space), 10)
    if (!Number.isSafeInteger(length) || length <= 0) break
    const record = bytes.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return out
}

/**
 * Refuse any entry that would land outside the extraction root.
 *
 * THE TAR EQUIVALENT OF ZIP-SLIP, AND THE REASON THIS MODULE PARSES TAR ITSELF. A member named
 * `../../.bashrc`, or one that is a symlink to `/etc`, writes wherever it likes when a naive
 * extractor joins the names. Nothing about the archive says it is trustworthy — an SRI digest
 * proves the bytes are the ones the registry published, not that the published package is benign,
 * and a compromised or typosquatted package is exactly the case this must survive.
 *
 * @param entryPath - the archive's path for the entry.
 * @param linkTarget - the target, for a symlink or hard link.
 * @throws Error naming the entry when either escapes.
 */
function assertContained(entryPath, linkTarget) {
  if (posix.isAbsolute(entryPath) || /^[A-Za-z]:/u.test(entryPath)) {
    throw new Error(`qialike-desktop: tar entry ${JSON.stringify(entryPath)} has an absolute path.`)
  }
  const normalized = posix.normalize(entryPath)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(
      `qialike-desktop: tar entry ${JSON.stringify(entryPath)} escapes the extraction root.`,
    )
  }
  if (linkTarget === undefined || linkTarget === '') return
  if (posix.isAbsolute(linkTarget) || /^[A-Za-z]:/u.test(linkTarget)) {
    throw new Error(
      `qialike-desktop: tar entry ${JSON.stringify(entryPath)} links to the absolute path `
      + `${JSON.stringify(linkTarget)}, which would leave the extraction root.`,
    )
  }
  // The link is read relative to the entry's own directory, which is what makes `../../../x` escape
  // from a nested entry rather than only from the root.
  const from = posix.dirname(normalized)
  const linked = posix.normalize(posix.join(from, linkTarget))
  if (linked === '..' || linked.startsWith('../')) {
    throw new Error(
      `qialike-desktop: tar entry ${JSON.stringify(entryPath)} links to ${JSON.stringify(linkTarget)}, `
      + 'which escapes the extraction root.',
    )
  }
}

/**
 * Unpack a gzipped tar archive into memory.
 *
 * IN MEMORY, NOT STRAIGHT TO DISK, and the size is why it is acceptable: the largest engine is
 * 68 MiB compressed, and holding it costs less than the bookkeeping that streaming would add to a
 * function whose whole job is to be checked before anything is written.
 *
 * @param buffer - the gzipped tar bytes.
 * @returns `{ path, mode, bytes }` per regular file, and `{ path, mode, link }` per symlink, in
 *   archive order. Directories are reported too, so a caller can create an empty one.
 * @throws Error on a malformed archive, an unsupported pax global header, or an escaping entry.
 */
export function extractTarGz(buffer) {
  const tar = gunzipSync(buffer)
  const entries = []
  /** pax overrides and GNU long names apply to the entry that follows them. */
  let pending = {}
  let pendingName
  let pendingLink
  let offset = 0

  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    offset += TAR_BLOCK
    if (isZeroBlock(header)) break
    if (!headerChecksumOk(header)) {
      throw new Error(`qialike-desktop: tar header at offset ${String(offset - TAR_BLOCK)} is corrupt.`)
    }
    const size = number(header, 124, 12)
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])

    if (type === 'x') {
      // The overrides belong to the next real entry, not to this pseudo-entry.
      pending = parsePax(body)
      continue
    }
    if (type === 'g') {
      // A global pax header changes how every later entry is read. Refusing is honest: silently
      // ignoring it would extract the archive as if it were written differently than it is.
      throw new Error('qialike-desktop: this tar archive uses a global pax header, which is not supported.')
    }
    if (type === 'L') { pendingName = body.toString('utf8').replace(/\0+$/u, ''); continue }
    if (type === 'K') { pendingLink = body.toString('utf8').replace(/\0+$/u, ''); continue }

    // The name has three possible sources and the order matters: a GNU long name, then a pax
    // `path` record, then the header's own name plus its ustar `prefix`. The header is last
    // because a pax archive also fills the header's fields with a truncated placeholder, so
    // reading it first would silently cut every long path at 100 bytes.
    const prefix = field(header, 345, 155)
    const rawName = field(header, 0, 100)
    const name = pendingName ?? pending.path ?? (prefix === '' ? rawName : `${prefix}/${rawName}`)
    const link = pendingLink ?? pending.linkpath ?? field(header, 157, 100)
    const mode = number(header, 100, 8) & 0o777
    pendingName = undefined
    pendingLink = undefined
    const declaredSize = pending.size === undefined ? size : Number.parseInt(pending.size, 10)
    pending = {}

    if (name === '') throw new Error('qialike-desktop: a tar entry has no name.')

    if (type === '0') {
      assertContained(name, undefined)
      entries.push({ kind: 'file', path: name, mode, bytes: body.subarray(0, declaredSize) })
      continue
    }
    if (type === '5') {
      // tar stores a directory's name with a trailing slash. Normalised here so every entry's path
      // means the same thing to a caller: without this, `package/` and `package` are two spellings
      // of one directory and only one of them is what a caller would write.
      const directory = name.replace(/\/+$/u, '')
      if (directory === '') continue
      assertContained(directory, undefined)
      entries.push({ kind: 'directory', path: directory, mode })
      continue
    }
    if (type === '2') {
      assertContained(name, link)
      entries.push({ kind: 'symlink', path: name, link })
      continue
    }
    if (type === '1') {
      // A hard link names another member of the same archive, so containment is checked the same way.
      assertContained(name, link)
      entries.push({ kind: 'hardlink', path: name, link })
      continue
    }
    throw new Error(
      `qialike-desktop: tar entry ${JSON.stringify(name)} has unsupported type ${JSON.stringify(type)}.`,
    )
  }
  return entries
}

/**
 * Write extracted entries under a directory.
 *
 * Directories are created before the files that need them rather than trusting the archive to list
 * a directory before its contents, which tar does not guarantee.
 *
 * @param entries - as returned by {@link extractTarGz}.
 * @param root - where to write.
 * @returns the number of files written.
 */
export function writeEntries(entries, root) {
  let files = 0
  for (const entry of entries) {
    const target = join(root, ...entry.path.split('/'))
    if (entry.kind === 'directory') {
      mkdirSync(target, { recursive: true, mode: entry.mode })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    if (entry.kind === 'symlink') {
      symlinkSync(entry.link, target)
      continue
    }
    if (entry.kind === 'hardlink') {
      // Materialised as a copy: a hard link's value is that it shares bytes, and none of these
      // entries is written twice, so a copy costs nothing here and removes a way to escape.
      writeFileSync(target, readFileSync(join(root, ...entry.link.split('/'))), { mode: entry.mode })
      files += 1
      continue
    }
    writeFileSync(target, entry.bytes, { mode: entry.mode })
    files += 1
  }
  return files
}

/**
 * Strip the one leading `package/` segment npm wraps every tarball in.
 *
 * ONE SEGMENT, NOT EVERY MATCHING PREFIX: a member genuinely named `package/x` inside the package
 * would otherwise be flattened into `x`. npm's wrapper is always exactly one level, so removing
 * exactly one is the correct reading of the archive rather than a heuristic.
 *
 * @param entries - as returned by {@link extractTarGz}.
 * @returns the entries, re-rooted.
 */
export function stripPackagePrefix(entries) {
  const out = []
  for (const entry of entries) {
    const parts = entry.path.split('/')
    if (parts[0] !== 'package') continue
    const rest = parts.slice(1).join('/')
    if (rest === '') continue
    out.push({ ...entry, path: rest })
  }
  return out
}

/**
 * Fetch a URL as a Buffer, with a non-2xx answer raised rather than returned.
 *
 * STREAMED WHEN ANYONE IS LISTENING, because the engine is 46-68 MiB and an interface that shows
 * nothing for a minute looks like one that did nothing. The digest is still checked over the whole
 * buffer before anything is written, so streaming changes when progress is reported and nothing
 * about when bytes are trusted.
 *
 * `total` comes from `content-length` and is left undefined when the server does not send it —
 * reported as absent rather than guessed, so a progress bar cannot claim a percentage it invented.
 *
 * @param url - what to fetch.
 * @param fetchImpl - the fetch to use, injectable for tests.
 * @param signal - aborts the request.
 * @param onProgress - called with `{ received, total }` per chunk, when supplied.
 * @returns the whole body.
 */
async function fetchBuffer(url, fetchImpl, signal, onProgress) {
  const response = await fetchImpl(url, signal === undefined ? {} : { signal })
  if (!response.ok) {
    throw new Error(`qialike-desktop: GET ${url} answered ${String(response.status)}.`)
  }
  if (onProgress === undefined || response.body === null || response.body === undefined) {
    return Buffer.from(await response.arrayBuffer())
  }
  const header = response.headers?.get?.('content-length')
  const total = header === null || header === undefined || header === '' ? undefined : Number(header)
  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    chunks.push(buffer)
    received += buffer.length
    onProgress({ received, total })
  }
  return Buffer.concat(chunks)
}

/**
 * Download, verify and install one engine.
 *
 * THE ORDER IS THE CONTRACT: fetch, verify the digest, then write. Nothing touches `destination`
 * before the bytes are known to be the ones the registry published, and a failure at any point
 * removes the temporary directory it was working in, so an interrupted install leaves the previous
 * state rather than half of the new one.
 *
 * @param options.platform - `process.platform`.
 * @param options.arch - `process.arch`.
 * @param options.glibc - whether the host reports a glibc runtime version.
 * @param options.version - the engine version the kit accepts.
 * @param options.packageName - the candidate to install. Defaults to the host's preferred one; a
 *   caller that has discovered the preferred package is unpublished passes the next candidate.
 * @param options.home - `$DSH_HOME`; the engine lands under `engines/libreoffice-kit/...`.
 * @param options.registry - one registry base URL. Defaults to the first of
 *   {@link DEFAULT_REGISTRIES}; the row is what tries the rest, so a failure here names one host.
 * @param options.integrity - an SRI string. Fetched from the registry when absent.
 * @param options.fetchImpl - injectable for tests.
 * @param options.signal - aborts the download.
 * @param options.onProgress - called with `{ phase, received?, total?, files? }`; phases are
 *   `resolving`, `downloading`, `verifying`, `unpacking`, `done`. Absent is the same as a no-op,
 *   so the interface can be the only caller that cares.
 * @param options.log - progress sink.
 * @returns `{ root, name, target, version, bytes, files }`.
 * @throws Error when the host has no engine, the download fails, the digest disagrees, or the
 *   archive escapes its root.
 */
export async function installEngine({
  platform,
  arch,
  glibc = true,
  version,
  home,
  packageName,
  registry = DEFAULT_REGISTRIES[0],
  integrity,
  fetchImpl = fetch,
  signal,
  onProgress,
  log = () => {},
}) {
  /** Report a phase, and the download's bytes while there is a download to count. */
  const progress = (phase, extra) => {
    onProgress?.({ phase, ...extra })
  }
  // AN EXPLICIT CHOICE WINS; WITHOUT ONE THIS RESOLVES ITS OWN. The row plans and passes both, so
  // through the interface this branch is not taken — but a caller that passes only `home` and
  // `version` must still work, and on Linux the preferred candidate is unpublished. See
  // {@link resolveEngineSource}.
  //
  // The target follows the candidate actually chosen, not the host's preferred one. Keying the
  // directory by the wrong target is how the wasm engine once landed under `linux-x64-glibc/`, where
  // the path the caller wired — the chosen target's — pointed at nothing.
  const candidates = enginePackageCandidates(platform, arch, { glibc })

  // ALREADY INSTALLED IS CHECKED FIRST, OVER EVERY CANDIDATE, AND BEFORE ANY NETWORK CALL.
  //
  // Two reasons, and they are separate. The obvious one: re-downloading 46-68 MiB to replace a
  // working copy is the one outcome a user would notice, and this is the check that stops a retry
  // from doing it. The second is ordering — resolving the source to learn *which* package to look
  // for would put a registry round trip on the path that has nothing to do, so the check walks the
  // candidates instead. It also makes the answer independent of which engine a registry currently
  // prefers: whichever one is installed at the right version is the one that counts.
  for (const candidate of candidates) {
    const candidateRoot = engineInstallRoot(home, version, candidate.target)
    const candidateDir = enginePackageDir(candidateRoot, candidate.name)
    if (readInstalledVersion(candidateDir) === version) {
      log(`office-engine: ${candidate.name}@${version} is already installed`)
      return {
        root: candidateRoot,
        name: candidate.name,
        target: candidate.target,
        version,
        bytes: 0,
        files: 0,
        alreadyInstalled: true,
      }
    }
  }

  // Nothing installed, so now it is worth asking a registry what to fetch.
  const resolved = packageName === undefined
    ? await resolveEngineSource({
      platform,
      arch,
      glibc,
      version,
      fetchImpl,
      signal,
      // A caller that named a registry gets that one, not that one plus the defaults.
      registries: registry === undefined ? DEFAULT_REGISTRIES : [registry],
    })
    : undefined
  const chosen = resolved?.candidate
    ?? candidates.find((candidate) => candidate.name === packageName)
    ?? candidates[0]
  const name = chosen.name
  const target = chosen.target
  const root = engineInstallRoot(home, version, target)
  const destination = enginePackageDir(root, name)

  progress('resolving')
  const metadataUrl = `${registry.replace(/\/+$/u, '')}/${name}`
  // The digest `resolveEngineSource` already read counts as given. Without this the metadata is
  // fetched a second time on the path where the library resolved its own source — a wasted round
  // trip whose only effect would be to prove the registry had not changed its mind in between.
  const digest = integrity ?? resolved?.integrity
    ?? integrityOf(JSON.parse((await fetchBuffer(metadataUrl, fetchImpl, signal)).toString('utf8')), version)
  const url = tarballUrl(registry ?? resolved?.registry ?? DEFAULT_REGISTRIES[0], name, version)
  log(`office-engine: fetching ${name}@${version} from ${registry}`)
  progress('downloading', { received: 0 })
  const tarball = await fetchBuffer(url, fetchImpl, signal, (update) => {
    progress('downloading', update)
  })

  progress('verifying', { received: tarball.length, total: tarball.length })

  if (!verifyIntegrity(tarball, digest)) {
    throw new Error(
      `qialike-desktop: ${name}@${version} does not match the published digest. Refusing to install `
      + `it; nothing was written. Expected ${digest}.`,
    )
  }

  progress('unpacking')
  const entries = stripPackagePrefix(extractTarGz(tarball))
  if (entries.length === 0) {
    throw new Error(`qialike-desktop: ${name}@${version} unpacked to no files.`)
  }

  // A sibling of `destination` rather than a system temporary directory: the rename below has to
  // stay on one filesystem to be atomic, and `/tmp` is often a different one.
  mkdirSync(dirname(destination), { recursive: true })
  const staging = mkdtempSync(join(dirname(destination), '.staging-'))
  try {
    const files = writeEntries(entries, staging)
    // WHATEVER IS THERE IS MOVED ASIDE, NOT REMOVED, AND `readInstalledVersion` DOES NOT DECIDE
    // THIS. Keying the directory by version means a readable install at this exact path is the
    // version being installed — which the short-circuit above already returned on. So anything
    // still here is either unreadable or foreign: a directory left by an interrupted swap, or a
    // manifest this code cannot parse. Testing for a readable version would skip the move for
    // exactly those cases and then fail on `renameSync`, because a rename onto an existing
    // non-empty directory is refused — a reinstall that can never succeed, for any input.
    const previous = `${destination}.replaced-${String(process.pid)}`
    const hadPrevious = existsSync(destination)
    if (hadPrevious) {
      rmSync(previous, { recursive: true, force: true })
      renameSync(destination, previous)
    }
    try {
      renameSync(staging, destination)
    } catch (error) {
      // Put the old engine back if the swap failed midway, so a failed upgrade is not also a
      // removal — the user would otherwise lose a working preview to a network hiccup.
      if (hadPrevious && !existsSync(destination)) {
        try { renameSync(previous, destination) } catch { /* nothing further to try */ }
      }
      throw error
    }
    if (hadPrevious) rmSync(previous, { recursive: true, force: true })
    const bytes = entries.reduce((sum, entry) => sum + (entry.bytes?.length ?? 0), 0)
    log(`office-engine: installed ${name}@${version} into ${root} (${files} files)`)
    progress('done', { received: tarball.length, total: tarball.length, files })
    return { root, name, target, version, bytes, files }
  } finally {
    // Every path out of here, including the error one, leaves no staging directory behind.
    rmSync(staging, { recursive: true, force: true })
  }
}

/** The name without its scope, which is what a sibling lookup needs. */
export function bareName(packageName) {
  const slash = packageName.indexOf('/')
  return slash === -1 ? packageName : packageName.slice(slash + 1)
}

/**
 * The engine version sitting beside the adapter, when this tree ships one.
 *
 * A SIBLING LOOKUP, NOT A RESOLUTION, AND THE DIFFERENCE IS THE WHOLE POINT. Resolving would find an
 * installed engine too — the row puts one on `NODE_PATH` — and the two must be told apart: a bundled
 * engine is a reason to do nothing, an installed one a reason to wire a path. The adapter and the
 * engines are siblings under `node_modules/@deepseek-ai/`, so the sibling is
 * `dirname(kitDir)/<bareName>` — ONLY the bare name, because the directory above the adapter is
 * already the scope.
 *
 * MEASURED, AND IT WAS WRONG FIRST: joining the full scoped name onto that directory produces
 * `@deepseek-ai/@deepseek-ai/libreoffice-kit-wasm`, which never exists. The consequence was not a
 * crash — a bundled tree reported `missing`, so the interface offered to install an engine that was
 * already there, and accepting would have downloaded 46 MiB to shadow it. Only running the row
 * against a tree that actually carried an engine showed it.
 *
 * @param kitDir - the adapter's directory.
 * @param packageName - the engine package's full name.
 * @returns the version, or undefined when this tree carries no such engine.
 */
export function bundledEngineVersion(kitDir, packageName) {
  const sibling = join(dirname(kitDir), bareName(packageName))
  return existsSync(sibling) ? readInstalledVersion(sibling) : undefined
}

/**
 * Decide which candidate to install, and from where.
 *
 * WALKS THE CANDIDATES AND THE REGISTRIES, AND THE LIBRARY NEEDS THIS ON ITS OWN. A caller that
 * passes only `home` and `version` has not discovered anything yet, and on Linux the host's
 * preferred engine is a package that was never published:
 *
 *     registry.npmmirror.com/@deepseek-ai/libreoffice-kit-linux-x64-glibc   404
 *     registry.npmmirror.com/@deepseek-ai/libreoffice-kit-wasm              200
 *
 * Taking the preferred name every time would make `installEngine` fail on Linux for every caller
 * that had not planned first — which is what happened the first time it was called without the row
 * in front of it. The row plans and then passes an explicit choice, so the failure was invisible
 * from the interface; that is exactly why the walk belongs here rather than only there.
 *
 * A CANDIDATE IS TRIED ON EVERY REGISTRY BEFORE THE NEXT CANDIDATE, which is deliberate: the
 * candidate order encodes a preference about *engines* (native before WebAssembly), and a registry
 * being unreachable should not silently downgrade it. The cost is one extra request when the
 * preferred engine is unpublished — measured at 0.17–0.44 s each.
 *
 * AN EXPLICIT REGISTRY IS THE ONLY ONE TRIED, because a caller that names a source means it. That
 * distinction is not decoration: the first version of this function always walked the defaults, so
 * a caller passing its own registry — a local server in a test, a corporate mirror in a deployment —
 * had that choice silently ignored and the public registry consulted instead. The suite caught it
 * as a digest mismatch, which is the good outcome; a network that answered with the same bytes would
 * have hidden it.
 *
 * @param options - `{ platform, arch, glibc, version, fetchImpl, signal, registries }`.
 * @returns `{ candidate, registry, integrity, downloadBytes, unpackedBytes }`.
 * @throws Error when no candidate exists on any registry tried.
 */
export async function resolveEngineSource({
  platform, arch, glibc = true, version, fetchImpl = fetch, signal, registries = DEFAULT_REGISTRIES,
}) {
  const failures = []
  for (const candidate of enginePackageCandidates(platform, arch, { glibc })) {
    for (const registry of registries) {
      const url = `${registry.replace(/\/+$/u, '')}/${candidate.name}`
      try {
        const response = await fetchImpl(url, signal === undefined ? {} : { signal })
        if (!response.ok) {
          failures.push(`${candidate.name} on ${registry}: HTTP ${String(response.status)}`)
          continue
        }
        const metadata = await response.json()
        const entry = metadata?.versions?.[version]
        if (entry === undefined) {
          failures.push(`${candidate.name} on ${registry}: no version ${version}`)
          continue
        }
        // Read here rather than later, so a registry that cannot vouch for the bytes is skipped
        // like any other unusable source instead of failing after the caller committed to it.
        return {
          candidate,
          registry,
          integrity: integrityOf(metadata, version),
          downloadBytes: typeof entry.dist?.size === 'number' ? entry.dist.size : undefined,
          unpackedBytes: typeof entry.dist?.unpackedSize === 'number' ? entry.dist.unpackedSize : undefined,
        }
      } catch (error) {
        failures.push(`${candidate.name} on ${registry}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  throw new Error(
    `qialike-desktop: no registry publishes an engine for ${platform}-${arch}: ${failures.join('; ')}`,
  )
}


/**
 * The version of an installed engine, or undefined when there is none.
 *
 * Reads the manifest rather than trusting the directory's existence: an install interrupted
 * between the two renames leaves a directory that is there and incomplete, and treating that as
 * installed is how a user ends up with a preview that fails for a reason nothing explains.
 *
 * @param packageDir - the package directory.
 * @returns the version string, or undefined.
 */
export function readInstalledVersion(packageDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * The directory to put on `NODE_PATH` for one installed engine.
 *
 * IT IS THE `node_modules` DIRECTORY, NOT ITS PARENT, AND THAT COST A ROUND OF DEBUGGING. A
 * `NODE_PATH` entry is searched as though it *were* a `node_modules` directory — Node looks for
 * `<entry>/<packageName>` — so pointing it at the root above `node_modules` finds nothing at all,
 * silently, while every other part of the install reports success. MEASURED, with the package at
 * `root/node_modules/@deepseek-ai/thing`:
 *
 *     NODE_PATH=root                  -> MISS
 *     NODE_PATH=root/node_modules     -> root/node_modules/@deepseek-ai/thing/package.json
 *
 * The caller that wires the path has to use this rather than the install root, and the test suite
 * pins the distinction because the failure is invisible from anywhere else.
 *
 * @param root - an engine's install root, as {@link engineInstallRoot} returns it.
 * @returns the directory to add to `NODE_PATH`.
 */
export function engineSearchDir(root) {
  return join(root, 'node_modules')
}

/**
 * The `NODE_PATH` entries that make installed engines resolvable.
 *
 * WHY THIS IS A PATH LIST AND NOT A LINK INTO THE TREE. The kit resolves its engine with
 * `require.resolve.paths()` from its own location, so the engine has to be on that list. The tree
 * cannot hold it: `/opt/Qialike` is root-owned under a deb and a read-only squashfs under an
 * AppImage, and neither can be written by the user who is installing. `NODE_PATH` is appended to
 * `require.resolve.paths()` and sits *below* the tree's own `node_modules`, which is the order
 * wanted — a bundled engine still wins, and the installed one is used when there is none.
 *
 * MEASURED: a runtime assignment to `process.env.NODE_PATH` has no effect on its own. Node builds
 * its global path list once at bootstrap, so the assignment only takes effect after
 * `Module._initPaths()` runs again. The row does that, which is what makes an install usable
 * without restarting the application.
 *
 * @param home - `$DSH_HOME`.
 * @param version - the engine version the kit accepts.
 * @param targets - target ids to include, most specific first.
 * @returns directories to join with the platform's path separator.
 */
export function engineSearchPath(home, version, targets) {
  return targets.map((target) => engineSearchDir(engineInstallRoot(home, version, target)))
}

/** The path separator `NODE_PATH` uses, which is not `path.delimiter` on every platform. */
export const NODE_PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':'
