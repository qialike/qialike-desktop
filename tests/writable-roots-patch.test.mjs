/**
 * The writable-roots patch.
 *
 * This is the one build-time patch authored in this repository, and the one
 * whose failure mode is quietest: a farm where it did not apply still builds,
 * still starts, and still lets the model read a policy sentence promising a
 * Windows temp directory the ACL does not grant. So the tests below care less
 * about the happy path than about the two ways it can silently not apply — a
 * moved anchor, and a farm missing the package entirely.
 *
 * The patch is Windows-only in effect but applied on every platform, because the
 * anchor is the thing being validated, not the branch.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WRITABLE_ROOTS_MARKER,
  patchWritableRootsWindows,
} from '../apps/desktop-bin/harness-patches/writable-roots-windows.mjs'

  /**
   * The two files the patch edits, with the exact text it anchors on.
   *
   * COPIED FROM HARNESS 0.2.1-rc.3, WHERE THE FUNCTION WAS REWRITTEN. Up to rc.2 it built the list
   * inline — `[policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath)` — and this fixture said so.
   * rc.3 delegates the workspace half to `workspaceWritableRoots(policy)` (which canonicalises and
   * honours extra roots itself) and canonicalises the two temp roots in place. The patch follows; the
   * fixture is what proves it follows the CURRENT shape rather than the one it was written against.
   */
  const FIXTURE = {
    '-deepseek-ai-dsh-sandbox/lib/index.js': [
      'function writableRoots(policy) {',
      '\tif (policy.mode !== "workspace-write") return [];',
      '\treturn [...new Set([',
      '\t\t...workspaceWritableRoots(policy),',
      '\t\tcanonicalPath("/tmp"),',
      '\t\tcanonicalPath(tmpdir())',
      '\t])];',
      '}',
      '',
    ].join('\n'),
    '-deepseek-ai-dsh-sandbox/lib/types/roots.js': [
      'export function writableRoots(policy) {',
      "    if (policy.mode !== 'workspace-write')",
      '        return [];',
      "    return [...new Set([...workspaceWritableRoots(policy), canonicalPath('/tmp'), canonicalPath(tmpdir())])];",
      '}',
      '',
    ].join('\n'),
  };

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-writable-roots-'))
  for (const [relativePath, text] of Object.entries(FIXTURE)) {
    mkdirSync(join(root, dirname(relativePath)), { recursive: true })
    writeFileSync(join(root, relativePath), text)
  }
})


afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('patchWritableRootsWindows', () => {
  it('patches both emitted forms of writableRoots', () => {
    const written = patchWritableRootsWindows({ root })
    expect(written).toHaveLength(2)
    for (const relativePath of Object.keys(FIXTURE)) {
      const text = readFileSync(join(root, relativePath), 'utf8')
      expect(text).toContain(WRITABLE_ROOTS_MARKER)
      // The narrowing is the whole point: Windows gets the workspace root alone.
      expect(text).toMatch(/win32/)
    }
  })

  it('leaves the non-Windows branch intact', () => {
    patchWritableRootsWindows({ root })
    const text = readFileSync(join(root, '-deepseek-ai-dsh-sandbox/lib/index.js'), 'utf8')
    // The POSIX grant must survive verbatim, or the patch would have narrowed Linux and macOS
    // confinement too. The workspace half is `workspaceWritableRoots(policy)` since harness
    // 0.2.1-rc.3 — checking for `policy.workspaceRoot` here would have been an assertion about the
    // old spelling and would now pass for the wrong reason (the string still appears in the file's
    // own doc comment), so it checks the call the patched line actually makes.
    expect(text).toContain('"/tmp"')
    expect(text).toContain('tmpdir()')
    expect(text).toContain('[...workspaceWritableRoots(policy), canonicalPath("/tmp"), canonicalPath(tmpdir())]')
  })

  it('is idempotent', () => {
    patchWritableRootsWindows({ root })
    const first = readFileSync(join(root, '-deepseek-ai-dsh-sandbox/lib/index.js'), 'utf8')
    patchWritableRootsWindows({ root })
    expect(readFileSync(join(root, '-deepseek-ai-dsh-sandbox/lib/index.js'), 'utf8')).toBe(first)
  })

  it('accepts the composite form 0.2.1-rc.3 shipped, as well as the inline one', () => {
    // BOTH SPELLINGS MUST PATCH. The function has moved twice, in opposite directions — inline up to
    // rc.2, composite in rc.3, inline again from rc.5 — and each move broke the build until the
    // anchor was edited. Accepting only the pinned spelling would repeat that; this file exists to
    // stop it, so it asserts the second form applies and narrows Windows the same way.
    const file = join(root, '-deepseek-ai-dsh-sandbox/lib/index.js')
    writeFileSync(file, [
      'function writableRoots(policy) {',
      '\tif (policy.mode !== "workspace-write") return [];',
      '\treturn [...new Set([',
      '\t\t...workspaceWritableRoots(policy),',
      '\t\tcanonicalPath("/tmp"),',
      '\t\tcanonicalPath(tmpdir())',
      '\t])];',
      '}',
      '',
    ].join('\n'))
    const rootsFile = join(root, '-deepseek-ai-dsh-sandbox/lib/types/roots.js')
    writeFileSync(rootsFile, [
      'export function writableRoots(policy) {',
      "    if (policy.mode !== 'workspace-write')",
      '        return [];',
      "    return [...new Set([...workspaceWritableRoots(policy), canonicalPath('/tmp'), canonicalPath(tmpdir())])];",
      '}',
      '',
    ].join('\n'))

    expect(patchWritableRootsWindows({ root })).toHaveLength(2)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(WRITABLE_ROOTS_MARKER)
    expect(text).toMatch(/win32/)
    expect(text).toContain('[...workspaceWritableRoots(policy)]')
  })

  it('throws when an anchor moved, naming the patch file to update', () => {
    // Simulate a harness release that reformatted the function.
    const file = join(root, '-deepseek-ai-dsh-sandbox/lib/index.js')
    writeFileSync(file, readFileSync(file, 'utf8').replace('tmpdir()', 'os.tmpdir()'))
    // The message changed when the patch learned a second upstream spelling: it now reports how many
    // forms it tried, because "this does not match" is no longer the same statement as "I know one
    // form and this is not it".
    expect(() => patchWritableRootsWindows({ root })).toThrow(/does not contain any writableRoots revision/)
    let message = ''
    try {
      patchWritableRootsWindows({ root })
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('writable-roots-windows.mjs')
    // The message must explain why deleting the patch is not an option.
    expect(message).toContain('policy-and-hygiene.mjs')
  })

  it('throws when the package is absent, rather than reporting success', () => {
    // The CLI's original only logged and continued here. A security-relevant
    // boundary that silently stays unpatched is the failure this refuses.
    rmSync(join(root, '-deepseek-ai-dsh-sandbox'), { recursive: true, force: true })
    expect(() => patchWritableRootsWindows({ root })).toThrow(/none of the writableRoots anchor files/)
  })

  it('accepts one anchor file being present when the other is not', () => {
    // A layout that emits only the bundled chunk is patchable; the build reports
    // success for what it could narrow rather than failing on a shape difference.
    rmSync(join(root, '-deepseek-ai-dsh-sandbox/lib/types'), { recursive: true, force: true })
    expect(patchWritableRootsWindows({ root })).toHaveLength(1)
  })
})
