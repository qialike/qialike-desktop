/**
 * The app-scheme patch: this shell's origin, adopted by the shipped client code.
 *
 * The failure this guards against is the quietest in the build. If the patch does
 * not apply, nothing throws, nothing logs, and nothing looks broken: the markdown
 * renderer simply refuses every local image and the image is replaced by its alt
 * text. A farm where it applied and a farm where it did not are indistinguishable
 * without opening a conversation containing a local image path.
 *
 * So these tests care about the two ways it can silently not apply — a moved
 * anchor, and an artifact this build never looked at — and about the one way it
 * could silently apply *wrongly*: rewriting a file into an origin that disagrees
 * with the scheme the shell actually registers.
 *
 * The consistency guard at the bottom is a source-text check, because the scheme
 * reaches the shell as TypeScript, the preload as hand-written CommonJS that
 * cannot import anything, and this patch as ESM. Three files, one value.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APP_ORIGIN,
  APP_SCHEME,
  UPSTREAM_ORIGIN,
  patchAppSchemeFarm,
  stageWebFrontendSchemed,
} from '../apps/desktop-bin/harness-patches/app-scheme.mjs'

// `fileURLToPath`, not `new URL(...).pathname`: on Windows `pathname` is
// `/C:/qialike/...`, and `join` then makes that drive-relative (`C:\C:\qialike\...`).
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The top-level keys of the preload's `DESKTOP_MARKER` object.
 *
 * Brace-matched rather than regexed: the marker holds a nested object (the update
 * carrier), so a `\{([^}]*)\}` capture stops at the inner closing brace and reads
 * the wrong thing — which is exactly how the assertion that guarded this went
 * stale the moment `updates` was added.
 *
 * @param preload - the preload source.
 * @returns the keys, in source order.
 */
function markerKeys(preload) {
  const start = preload.indexOf('const DESKTOP_MARKER = Object.freeze({')
  expect(start, 'the preload declares no DESKTOP_MARKER').toBeGreaterThan(-1)
  let depth = 0
  let end = start
  for (let index = preload.indexOf('{', start); index < preload.length; index += 1) {
    if (preload[index] === '{') depth += 1
    else if (preload[index] === '}') {
      depth -= 1
      if (depth === 0) { end = index; break }
    }
  }
  const body = preload.slice(preload.indexOf('{', start) + 1, end)
  // Depth-zero keys only: a name inside the nested carrier is not a marker key.
  const keys = []
  let level = 0
  for (const line of body.split('\n')) {
    if (level === 0) {
      const match = /^\s*([A-Za-z_$][\w$]*)\s*:/u.exec(line)
      if (match !== null) keys.push(match[1])
    }
    level += (line.match(/[{([]/gu) ?? []).length - (line.match(/[})\]]/gu) ?? []).length
  }
  return keys
}

/**
 * The two farm files the browser fetches, with the text the patch anchors on.
 *
 * The anchor is the bare origin, so these fixtures reproduce the shape that
 * matters: the literal appears inside a minifier-sensitive expression, and the
 * patch must not need to match the expression to rewrite it.
 */
const REQUIRED_FIXTURE = {
  '-deepseek-ai-dsh-client-ui-chat/lib/client.js': [
    '\t\t/**',
    '\t\t * @param base - HTTP(S) application base, including its deployment prefix, or `dsh-app://app/`.',
    '\t\t */',
    '\t\tfunction fileMediaUrl(base, path) {',
    '\t\t\tif (!/^https?:/u.test(base) && !base.startsWith("dsh-app://app/") || !isAbsoluteWorkspacePath(path)) return void 0;',
    '\t\t\treturn new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;',
    '\t\t}',
    '',
  ].join('\n'),
  '-deepseek-ai-dsh-client-ui-sidebar-documentpreview/lib/client.js': [
    '\t\tfunction fileMediaUrl(base, path) {',
    '\t\t\tif (!base.startsWith("dsh-app://app/")) return void 0;',
    '\t\t\treturn new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;',
    '\t\t}',
    '',
  ].join('\n'),
}

/** A third farm file that is patched only when it happens to be present. */
const OPTIONAL_FIXTURE = {
  '-deepseek-ai-dsh-client-ui-primitives/lib/index.js': [
    'function vocabularyImageUrl(url) {',
    '\treturn url.startsWith("dsh-app://app/api/file?") ? url : void 0;',
    '}',
    '',
  ].join('\n'),
}

/**
 * One built Web dist, shaped like the real one.
 *
 * The JavaScript chunk carries a content hash in its name, which is why the patch
 * scans the directory instead of naming a file: the name changes on every
 * upstream rebuild, and which chunk inlines the renderer has already moved once.
 */
const DIST_FIXTURE = {
  'index.html': '<!doctype html><script type="module" src="/assets/index-AAAA1111.js"></script>\n',
  'assets/index-AAAA1111.js': 'function mb(e){return e.startsWith("dsh-app://app/api/file?")?e:void 0}\n',
  'assets/index-AAAA1111.js.map': '{"sourcesContent":["e.startsWith(\'dsh-app://app/api/file?\')"]}\n',
  'assets/vendor-BBBB2222.js': 'export const unrelated = 1\n',
}

let root

/** Write a fixture map into a directory, creating parents. */
function writeFixture(base, files) {
  for (const [relativePath, text] of Object.entries(files)) {
    const file = join(base, relativePath)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-app-scheme-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('patchAppSchemeFarm', () => {
  it("adopts this shell's origin in every required bundle", () => {
    writeFixture(root, REQUIRED_FIXTURE)
    patchAppSchemeFarm({ root })
    for (const relativePath of Object.keys(REQUIRED_FIXTURE)) {
      const text = readFileSync(join(root, relativePath), 'utf8')
      expect(text).toContain(APP_ORIGIN)
      // The upstream spelling has to be gone, or the guard still rejects our base.
      expect(text).not.toContain(UPSTREAM_ORIGIN)
    }
  })

  it('rewrites every occurrence, not just the first', () => {
    // The real files carry the literal twice: once in a JSDoc line and once in the
    // guard. Leaving the guard behind is the failure that matters.
    writeFixture(root, REQUIRED_FIXTURE)
    patchAppSchemeFarm({ root })
    const text = readFileSync(join(root, '-deepseek-ai-dsh-client-ui-chat/lib/client.js'), 'utf8')
    expect(text.match(/qialike-app:\/\/app\//gu)).toHaveLength(2)
  })

  it('leaves the surrounding expression intact', () => {
    writeFixture(root, REQUIRED_FIXTURE)
    patchAppSchemeFarm({ root })
    const text = readFileSync(join(root, '-deepseek-ai-dsh-client-ui-chat/lib/client.js'), 'utf8')
    // A minifier-shaped anchor is what makes this patch brittle; the rewrite must
    // not need one, so the expression it sits in survives verbatim.
    expect(text).toContain(`!base.startsWith("${APP_ORIGIN}/") || !isAbsoluteWorkspacePath(path)`)
    expect(text).toContain('return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;')
  })

  it('is idempotent', () => {
    writeFixture(root, REQUIRED_FIXTURE)
    patchAppSchemeFarm({ root })
    const first = readFileSync(join(root, '-deepseek-ai-dsh-client-ui-chat/lib/client.js'), 'utf8')
    patchAppSchemeFarm({ root })
    expect(readFileSync(join(root, '-deepseek-ai-dsh-client-ui-chat/lib/client.js'), 'utf8')).toBe(first)
  })

  it('patches an optional library copy when it is there', () => {
    writeFixture(root, { ...REQUIRED_FIXTURE, ...OPTIONAL_FIXTURE })
    const written = patchAppSchemeFarm({ root })
    const text = readFileSync(join(root, '-deepseek-ai-dsh-client-ui-primitives/lib/index.js'), 'utf8')
    expect(text).toContain(APP_ORIGIN)
    expect(written).toContain('-deepseek-ai-dsh-client-ui-primitives/lib/index.js')
  })

  it('succeeds without the optional library copies', () => {
    // They ship no `dsh.client`, so the browser never fetches them. Their absence
    // costs nothing and must not fail a build.
    writeFixture(root, REQUIRED_FIXTURE)
    expect(() => patchAppSchemeFarm({ root })).not.toThrow()
  })

  it('throws when a required bundle is missing, rather than reporting success', () => {
    writeFixture(root, REQUIRED_FIXTURE)
    rmSync(join(root, '-deepseek-ai-dsh-client-ui-chat'), { recursive: true, force: true })
    expect(() => patchAppSchemeFarm({ root })).toThrow(/required app-scheme anchor/)
  })

  it('throws when a required bundle carries neither spelling, naming what to update', () => {
    // A harness release that renamed the origin. The file is present and looks
    // fine, which is exactly why this has to fail rather than pass quietly.
    writeFixture(root, REQUIRED_FIXTURE)
    const file = join(root, '-deepseek-ai-dsh-client-ui-chat/lib/client.js')
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll(UPSTREAM_ORIGIN, 'dsh-desktop://app'))
    expect(() => patchAppSchemeFarm({ root })).toThrow(/contains neither/)
    let message = ''
    try {
      patchAppSchemeFarm({ root })
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('app-scheme.mjs')
    // The message must say why deleting the patch is not an option.
    expect(message).toContain('R10')
    expect(message).toContain('silently')
  })
})

describe('stageWebFrontendSchemed', () => {
  it('copies the dist and rewrites the hash-named chunk', () => {
    const source = join(root, 'source')
    const target = join(root, 'staged')
    writeFixture(source, DIST_FIXTURE)
    const staged = stageWebFrontendSchemed({ sourceDist: source, targetDir: target })
    expect(staged).toBe(target)
    const text = readFileSync(join(target, 'assets/index-AAAA1111.js'), 'utf8')
    expect(text).toContain(APP_ORIGIN)
    expect(text).not.toContain(UPSTREAM_ORIGIN)
  })

  it('carries the whole dist, not only the patched chunk', () => {
    const source = join(root, 'source')
    const target = join(root, 'staged')
    writeFixture(source, DIST_FIXTURE)
    stageWebFrontendSchemed({ sourceDist: source, targetDir: target })
    expect(readFileSync(join(target, 'index.html'), 'utf8')).toContain('index-AAAA1111.js')
    expect(readFileSync(join(target, 'assets/vendor-BBBB2222.js'), 'utf8')).toContain('unrelated')
  })

  it('leaves the source dist untouched', () => {
    // The dist lives in the harness checkout, which this build treats as read-only
    // (DESIGN §3 D12). Staging exists precisely so that stays true.
    const source = join(root, 'source')
    writeFixture(source, DIST_FIXTURE)
    stageWebFrontendSchemed({ sourceDist: source, targetDir: join(root, 'staged') })
    expect(readFileSync(join(source, 'assets/index-AAAA1111.js'), 'utf8')).toContain(UPSTREAM_ORIGIN)
  })

  it('discards a previous staging so a changed scheme cannot leave a stale copy', () => {
    const source = join(root, 'source')
    const target = join(root, 'staged')
    writeFixture(source, DIST_FIXTURE)
    mkdirSync(join(target, 'assets'), { recursive: true })
    writeFileSync(join(target, 'assets/stale-OLD.js'), 'stale\n')
    stageWebFrontendSchemed({ sourceDist: source, targetDir: target })
    expect(() => readFileSync(join(target, 'assets/stale-OLD.js'), 'utf8')).toThrow()
  })

  it('refuses a dist that was never built', () => {
    const source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    expect(() => stageWebFrontendSchemed({ sourceDist: source, targetDir: join(root, 'staged') }))
      .toThrow(/no built Web frontend/)
  })

  it('throws when no chunk carries either spelling', () => {
    // The chunk directory exists and holds JavaScript, so a build that only checked
    // for files would sail past this and ship a frontend that drops local images.
    const source = join(root, 'source')
    writeFixture(source, {
      'index.html': '<!doctype html>\n',
      'assets/index-AAAA1111.js': 'export const unrelated = 1\n',
    })
    expect(() => stageWebFrontendSchemed({ sourceDist: source, targetDir: join(root, 'staged') }))
      .toThrow(/none of the \d+ JavaScript chunk/u)
  })
})

describe('the scheme has one value across three languages', () => {
  /**
   * The scheme reaches the product three ways: as Electron's registered scheme in
   * TypeScript, as a literal in a sandboxed CommonJS preload that cannot import
   * anything, and as this patch's constant. Nothing links them at compile time, so
   * drift would show up only as a window that never loads the product document.
   */
  it('matches the scheme the shell registers', () => {
    const main = readFileSync(join(REPO_ROOT, 'apps/desktop/src/main.ts'), 'utf8')
    const declared = /const SCHEME = '([^']+)'/u.exec(main)
    expect(declared, 'main.ts declares no SCHEME').not.toBeNull()
    expect(declared[1]).toBe(APP_SCHEME)
  })

  it('matches the origin the shell serves and proxies under', () => {
    const document = readFileSync(join(REPO_ROOT, 'apps/desktop/src/web-document.ts'), 'utf8')
    expect(document).toContain(`export const APP_ORIGIN = '${APP_ORIGIN}'`)
  })

  it('matches the origin the preload gates the bridges on', () => {
    const preload = readFileSync(join(REPO_ROOT, 'apps/desktop/preload/preload.cjs'), 'utf8')
    expect(preload).toContain(`location.protocol === '${APP_SCHEME}:'`)
    expect(preload).toContain("location.hostname === 'app'")
    // The marker is what selects the desktop posture; see DESIGN §12.2 R11.
    expect(preload).toContain("exposeInMainWorld('dshDesktop'")
  })

  it('declares exactly the marker keys this shell implements', () => {
    // The invariant is not "keep the marker small" — it is "every key has a bridge
    // behind it". A key added here without one would be read as a capability by
    // whichever upstream plugin checks for it, and the feature would appear to
    // exist and do nothing.
    //
    // `protocolVersion` is the marker itself. `updates` is implemented: the
    // coordinator owns a real updater, and `updates-settings-general` renders a
    // status badge from whatever it reports.
    const preload = readFileSync(join(REPO_ROOT, 'apps/desktop/preload/preload.cjs'), 'utf8')
    const keys = markerKeys(preload)
    expect(keys.sort()).toEqual(['protocolVersion', 'updates'])
  })

  it('names only channels the IPC contract declares', () => {
    // The other half of the same invariant: a bridge member whose channel has no
    // contract entry is a call that rejects, or worse, one nothing answers at all.
    //
    // Compared as *strings*, not identifiers. A sandboxed preload cannot import
    // `DESKTOP_IPC`, so it re-declares every channel name as a local constant — the
    // duplication is unavoidable, and a name-based comparison would pass while the
    // two spellings disagreed.
    const preload = readFileSync(join(REPO_ROOT, 'apps/desktop/preload/preload.cjs'), 'utf8')
    const ipc = readFileSync(join(REPO_ROOT, 'apps/desktop/src/ipc.ts'), 'utf8')
    const declared = new Set(
      [...ipc.matchAll(/'qialike-desktop:[a-z-]+'/gu)].map((match) => match[0].slice(1, -1)),
    )
    const used = [...preload.matchAll(/'(qialike-desktop:[a-z-]+)'/gu)].map((match) => match[1])
    expect(used.length).toBeGreaterThan(0)
    for (const channel of new Set(used)) {
      expect(declared.has(channel), `${channel} is used by the preload but absent from DESKTOP_IPC`).toBe(true)
    }
  })
})
