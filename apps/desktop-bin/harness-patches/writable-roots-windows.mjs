/**
 * Build-time patch: make Windows grant the workspace root alone.
 *
 * WHY THIS EXISTS HERE AND NOT IN THE QIALIKE CLI. The CLI has the same edit,
 * but inlined in `apps/tui-bin/build.mjs` (`patchWritableRootsWindows`) rather
 * than in its `harness-patches/` directory, and that repository is a read-only
 * input to this build (DESIGN §3 D11/D12). So this repository carries its own
 * copy. It is Windows-only, so on the macOS and Linux targets this build also
 * produces the patch is inert — which is why duplicating it costs nothing and
 * blocks nothing. Contributing the change upstream to the CLI is a separate,
 * optional cleanup.
 *
 * WHY IT MUST BE APPLIED TOGETHER WITH `policy-and-hygiene.mjs`. That patch's
 * P1-B half replaces the hardcoded `workspace-write` policy sentence with one
 * **derived from `writableRoots(policy)`** — the same allow-list the file fence
 * enforces — so the text a model reads can no longer promise an area the
 * enforcement layer denies. This patch is the other half of that agreement: on
 * Windows the confined shell is granted the workspace root alone, because the
 * ACL restricted token has no equivalent of the POSIX `/tmp` grant. Applying
 * P1-B without this one would make the derived sentence advertise `tmpdir()` on
 * Windows — reintroducing exactly the drift P1-B was written to remove.
 *
 * WHY WINDOWS IS DIFFERENT. The confined token is a `WRITE_RESTRICTED`
 * restricted token whose ACL grant covers the workspace root. `os.tmpdir()` on
 * Windows is a per-user path outside that grant, so listing it as writable would
 * be a claim the kernel refuses.
 *
 * FAIL CLOSED. Every anchor is literal and asserted. A re-vendored harness that
 * moved one fails this build rather than shipping a profile whose policy text
 * and enforcement boundary disagree — a disagreement whose only symptom is a
 * model planning a write the sandbox then rejects. The CLI's original logs and
 * continues when the file is absent; this version does not, because a silently
 * unpatched security-relevant boundary is worse than a failed build.
 *
 * @module qialike-desktop/harness-patches/writable-roots-windows
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Idempotency marker; also the anchor for "has this patch already run". */
export const WRITABLE_ROOTS_MARKER = 'qialike: Windows grants the workspace root alone'

/**
 * The two emitted files of one function, each with EVERY form upstream has shipped it in.
 *
 * The harness publishes `writableRoots` in a bundled `lib/index.js` and in a per-module
 * `lib/types/roots.js`; the build patches both so the two cannot disagree depending on which one a
 * caller reaches.
 *
 * WHY MORE THAN ONE FORM PER FILE. This function has now changed shape twice, in opposite
 * directions, and each move broke the build until the anchor was edited:
 *
 *   · up to 0.2.1-rc.2 — INLINE: `[policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath)`
 *   · 0.2.1-rc.3        — COMPOSITE: spreads `workspaceWritableRoots(policy)` and canonicalises the
 *                          two temp roots itself
 *   · 0.2.1-rc.5        — INLINE again, and `workspaceWritableRoots` no longer exists at all
 *
 * The third move is the one that made this worth fixing properly. The qialike CLI hit the same
 * break and settled on accepting both spellings in its own patch — its 0.13.0 changelog records
 * "按 rc 标签构建不再卡在 writableRoots 补丁上 … 而 rc 系列一直内联那三个根". This file now does the
 * same, so a checkout sitting on an `rc` tag or on `master`/`0.2.2-alpha` both build.
 *
 * The Windows rule itself never changed, and it is still why this patch exists: the ACL restricted
 * token's grant covers the workspace only, so listing `tmpdir()` there would be a claim the kernel
 * refuses. Only the Windows branch is narrowed; the POSIX branch keeps every root upstream lists.
 */
const ANCHORS = [
  {
    file: '-deepseek-ai-dsh-sandbox/lib/index.js',
    forms: [
      {
        // INLINE — the form shipped up to rc.2 and again from rc.5.
        from: '\treturn [...new Set([\n'
          + '\t\tpolicy.workspaceRoot,\n'
          + '\t\t"/tmp",\n'
          + '\t\ttmpdir()\n'
          + '\t].map(canonicalPath))];',
        to: '\tconst roots = /* ' + WRITABLE_ROOTS_MARKER + ' */ '
          + 'process.platform === "win32" ? [policy.workspaceRoot] : [policy.workspaceRoot, "/tmp", tmpdir()];\n'
          + '\treturn [...new Set(roots.map(canonicalPath))];',
      },
      {
        // COMPOSITE — the form 0.2.1-rc.3 shipped, still present on master / 0.2.2-alpha.
        from: '\treturn [...new Set([\n'
          + '\t\t...workspaceWritableRoots(policy),\n'
          + '\t\tcanonicalPath("/tmp"),\n'
          + '\t\tcanonicalPath(tmpdir())\n'
          + '\t])];',
        to: '\tconst roots = /* ' + WRITABLE_ROOTS_MARKER + ' */ process.platform === "win32"\n'
          + '\t\t? [...workspaceWritableRoots(policy)]\n'
          + '\t\t: [...workspaceWritableRoots(policy), canonicalPath("/tmp"), canonicalPath(tmpdir())];\n'
          + '\treturn [...new Set(roots)];',
      },
    ],
  },
  {
    file: '-deepseek-ai-dsh-sandbox/lib/types/roots.js',
    forms: [
      {
        from: "    return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))];",
        to: '    const roots = /* ' + WRITABLE_ROOTS_MARKER + ' */\n'
          + "        process.platform === 'win32' ? [policy.workspaceRoot] : [policy.workspaceRoot, '/tmp', tmpdir()];\n"
          + '    return [...new Set(roots.map(canonicalPath))];',
      },
      {
        from: "    return [...new Set([...workspaceWritableRoots(policy), canonicalPath('/tmp'), canonicalPath(tmpdir())])];",
        to: '    const roots = /* ' + WRITABLE_ROOTS_MARKER + ' */\n'
          + "        process.platform === 'win32'\n"
          + "            ? [...workspaceWritableRoots(policy)]\n"
          + "            : [...workspaceWritableRoots(policy), canonicalPath('/tmp'), canonicalPath(tmpdir())];\n"
          + '    return [...new Set(roots)];',
      },
    ],
  },
]

/**
 * Apply the patch to a farm.
 *
 * @param root - the farm root (never the harness checkout).
 * @param log - progress sink.
 * @returns the files written.
 * @throws Error when a file exists but its anchor does not match, or when
 *   neither anchor file is present at all.
 */
export function patchWritableRootsWindows({ root, log = () => {} }) {
  const written = []
  const absent = []
  for (const { file, forms } of ANCHORS) {
    const path = join(root, file)
    if (!existsSync(path)) {
      absent.push(file)
      continue
    }
    const text = readFileSync(path, 'utf8')
    if (text.includes(WRITABLE_ROOTS_MARKER)) {
      log(`writable-roots-windows: already applied (${file})`)
      written.push(file)
      continue
    }
    // THE FIRST FORM THAT MATCHES WINS. A file carries exactly one of them, so "which form is this"
    // is answered by the checkout rather than by a configuration flag the caller could get wrong.
    const matched = forms.find((form) => text.includes(form.from))
    if (matched === undefined) {
      throw new Error(
        `qialike-desktop: the vendored ${file} does not contain any writableRoots revision this patch `
        + `knows (tried ${String(forms.length)}: inline and composite). The harness changed the `
        + 'function again, so the Windows write boundary can no longer be narrowed to the workspace '
        + 'root.\n'
        + '  · Re-read the current writableRoots in the harness checkout and add its form to ANCHORS '
        + 'in apps/desktop-bin/harness-patches/writable-roots-windows.mjs.\n'
        + '  · Do not delete this patch: policy-and-hygiene.mjs derives the workspace-write prompt '
        + 'sentence from writableRoots(), so without it the text promises a temp directory the '
        + 'Windows ACL does not grant.',
      )
    }
    writeFileSync(path, text.replace(matched.from, matched.to))
    log(`writable-roots-windows: patched ${file}`)
    written.push(file)
  }
  if (written.length === 0) {
    throw new Error(
      `qialike-desktop: none of the writableRoots anchor files is in the farm (looked for `
      + `${absent.join(', ')}). Either the harness moved @deepseek-ai/dsh-sandbox, or the farm is `
      + 'incomplete. This patch is required on every platform so the module is validated even when '
      + 'the Windows branch is never taken.',
    )
  }
  return written
}
