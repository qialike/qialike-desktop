/**
 * The session-list-parity patch.
 *
 * WHY THIS SUITE EXISTS. The defect it fixes is invisible to every other check in this repository: a farm where
 * the patch did not apply still builds, still starts, still renders a sidebar — it simply lists fewer Sessions
 * than the CLI lists for the same directory, and the difference reads as "the user has fewer Sessions" rather
 * than as a broken build. Measured before the patch (2026-10-12): for Workspace `/home/pipo/deepseek/qialike`
 * the CLI listed 6 Sessions and the sidebar 3.
 *
 * So the assertions are about the two ways it can silently not apply — a moved anchor, and a farm missing the
 * package — plus the property that makes a farm rebuild safe: idempotency.
 *
 * The fixtures are built from the patch's own exported {@link ANCHORS}, not from a restatement of them. A test
 * that spelled the anchor differently would pass while the real patch threw on the real farm.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ANCHORS,
  CLIENT_TARGET,
  CONVERSATION_EVENT_TYPES,
  HOST_TARGET,
  SESSION_LIST_PARITY_MARKER,
  patchSessionListParityClient,
  patchSessionListParityHost,
} from '../apps/desktop-bin/harness-patches/session-list-parity.mjs'

/**
 * The first accepted spelling of an anchor.
 *
 * ANCHORS carries a LIST per name since harness 0.2.2-rc.3 began minifying client bundles: the pretty
 * form this fixture is written in, plus the minified one the shipped bundle now uses. The fixture is
 * the pretty form, so it takes the first entry — and the patch then has to find that spelling inside
 * it, which is exactly the behaviour these tests exist to pin.
 */
const pretty = (anchor) => (Array.isArray(anchor) ? anchor[0] : anchor)


/** The client bundle's relevant region, with every anchor the client half needs. */
const CLIENT_FIXTURE = [
  '\t\tfunction sessionVisible(session, current, archived, archivedFilter) {',
  pretty(ANCHORS.subagent).trimEnd(),
  '\t\t\tif (session.blank && session.id !== current) return false;',
  '\t\t\treturn true;',
  '\t\t}',
  '\t\tfunction pinOrderSource(workspaces, list, rowState) {',
  '\t\t\tconst accounted = new Set(workspaces.flatMap((workspace) => workspace.sessionIds));',
  '\t\t\treturn {',
  '\t\t\t\tmembers: Object.fromEntries([',
  '\t\t\t\t\t...workspaces.map((workspace) => [workspace.workspaceId, workspace.sessionIds]),',
  '\t\t\t\t\t["", list.ids.filter((id) => list.byId[id] !== void 0 && !accounted.has(id))],',
  '\t\t\t\t])',
  '\t\t\t};',
  '\t\t}',
  '\t\tfunction render() {',
  '\t\t\tconst ungroupedMemberIds = (0, react.useMemo)(() => {',
  '\t\t\t\tconst accounted = new Set(workspaces.flatMap((workspace) => workspace.sessionIds));',
  '\t\t\t\treturn list.ids.filter((id) => list.byId[id] !== void 0 && !accounted.has(id));',
  '\t\t\t}, [list, workspaces]);',
  '\t\t\treturn null;',
  '\t\t}',
  pretty(ANCHORS.groupFunction).trimEnd(),
  '\t\t\tconst members = [];',
  pretty(ANCHORS.renderLoop).trimEnd(),
  '\t\t\t\tconst summary = list.byId[id];',
  '\t\t\t\tif (summary === void 0) continue;',
  '\t\t\t\tmembers.push(summary);',
  '\t\t\t}',
  '\t\t\treturn members;',
  '\t\t}',
  '',
].join('\n')

/** The Host bundle's fold, with both anchors. */
const HOST_FIXTURE = [
  ANCHORS.foldFunction,
  pretty(ANCHORS.blank).trimEnd(),
  '\tconst lastPromptAt = state.lastPromptAt;',
  '\treturn { blank, lastPromptAt };',
  '}',
  '',
].join('\n')

let root
const clientPath = () => join(root, CLIENT_TARGET)
const hostPath = () => join(root, HOST_TARGET)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-session-parity-'))
  for (const [relative, text] of [[CLIENT_TARGET, CLIENT_FIXTURE], [HOST_TARGET, HOST_FIXTURE]]) {
    const file = join(root, relative)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('patchSessionListParityClient', () => {
  it('stops hiding subagent children', () => {
    patchSessionListParityClient({ root })
    const text = readFileSync(clientPath(), 'utf8')
    expect(text).not.toContain('if (session.origin === "subagent") return false;')
    expect(text).toContain(SESSION_LIST_PARITY_MARKER)
  })

  it('takes group membership from cwd as well as the registry', () => {
    patchSessionListParityClient({ root })
    const text = readFileSync(clientPath(), 'utf8')
    expect(text).toContain('function qialikeWorkspaceMemberIds(workspace, list)')
    expect(text).toContain('summary.cwd === workspace.path')
    // The render loop, which is what the sidebar actually iterates, must use it.
    expect(text).not.toContain('for (const id of workspace.sessionIds) {')
    expect(text).toContain('for (const id of qialikeWorkspaceMemberIds(workspace, list)) {')
  })

  it('derives Ungrouped and the pin path from the same membership rule', () => {
    // The failure this prevents: Ungrouped keeping the registry-only complement while the group lists the
    // wider set, which would show one Session twice.
    patchSessionListParityClient({ root })
    const text = readFileSync(clientPath(), 'utf8')
    expect(text).not.toContain('new Set(workspaces.flatMap((workspace) => workspace.sessionIds))')
    // Two call sites — Ungrouped and the pin path — plus the definition itself. Counted by assignment so the
    // definition cannot satisfy the assertion on its own.
    expect(text.split('= qialikeAccountedSessionIds(workspaces, list)').length - 1).toBe(2)
    expect(text).toContain('[workspace.workspaceId, qialikeWorkspaceMemberIds(workspace, list)]')
  })

  it('is idempotent', () => {
    patchSessionListParityClient({ root })
    const once = readFileSync(clientPath(), 'utf8')
    patchSessionListParityClient({ root })
    expect(readFileSync(clientPath(), 'utf8')).toEqual(once)
    // One marker per target: a second helper insertion would be a second marker.
    expect(once.split('function qialikeWorkspaceMemberIds').length - 1).toBe(1)
  })

  it('throws when an anchor moved, naming the constant to update', () => {
    for (const name of ['subagent', 'renderLoop', 'ungrouped', 'pinAccounted', 'pinMembers', 'groupFunction']) {
      writeFileSync(clientPath(), CLIENT_FIXTURE.replace(pretty(ANCHORS[name]), '// moved by upstream\n'))
      expect(() => patchSessionListParityClient({ root }), `anchor ${name}`).toThrow(
        new RegExp(`anchor '${name}'.*ANCHORS\\.${name}`, 'su'),
      )
    }
  })

  it('writes nothing when an anchor moved', () => {
    // A half-patched bundle is worse than an unpatched one: the marker would make the next run skip it.
    writeFileSync(clientPath(), CLIENT_FIXTURE.replace(pretty(ANCHORS.renderLoop), '// moved\n'))
    expect(() => patchSessionListParityClient({ root })).toThrow()
    expect(readFileSync(clientPath(), 'utf8')).toEqual(CLIENT_FIXTURE.replace(pretty(ANCHORS.renderLoop), '// moved\n'))
  })

  it('throws when the package is absent, rather than reporting success', () => {
    rmSync(join(root, '-deepseek-ai-dsh-client-ui-workspace'), { recursive: true, force: true })
    expect(() => patchSessionListParityClient({ root })).toThrow(/CLIENT_TARGET/u)
  })
})

describe('patchSessionListParityHost', () => {
  it('clears the blank bit on the CLI\u2019s conversation events', () => {
    patchSessionListParityHost({ root })
    const text = readFileSync(hostPath(), 'utf8')
    expect(text).toContain('QIALIKE_CONVERSATION_EVENT_TYPES.has(event.type)')
    for (const type of CONVERSATION_EVENT_TYPES) expect(text).toContain(`"${type}"`)
    expect(SESSION_LIST_PARITY_MARKER).toBeTruthy()
  })

  it('keeps the turn/start rule it is aligning with, rather than replacing it', () => {
    patchSessionListParityHost({ root })
    expect(readFileSync(hostPath(), 'utf8')).toContain('event.type !== "turn/start"')
  })

  it('is idempotent', () => {
    patchSessionListParityHost({ root })
    const once = readFileSync(hostPath(), 'utf8')
    patchSessionListParityHost({ root })
    expect(readFileSync(hostPath(), 'utf8')).toEqual(once)
    expect(once.split('const QIALIKE_CONVERSATION_EVENT_TYPES').length - 1).toBe(1)
  })

  it('throws when an anchor moved', () => {
    for (const name of ['blank', 'foldFunction']) {
      writeFileSync(hostPath(), HOST_FIXTURE.replace(ANCHORS[name], '// moved by upstream\n'))
      expect(() => patchSessionListParityHost({ root }), `anchor ${name}`).toThrow(
        new RegExp(`anchor '${name}'.*ANCHORS\\.${name}`, 'su'),
      )
    }
  })

  it('throws when the package is absent', () => {
    rmSync(join(root, '-deepseek-ai-dsh-api-session-controller'), { recursive: true, force: true })
    expect(() => patchSessionListParityHost({ root })).toThrow(/HOST_TARGET/u)
  })
})

describe('the two halves together', () => {
  it('marks both files, so a rebuild skips both', () => {
    const client = patchSessionListParityClient({ root })
    const host = patchSessionListParityHost({ root })
    expect(client).toEqual([CLIENT_TARGET])
    expect(host).toEqual([HOST_TARGET])
    expect(readFileSync(clientPath(), 'utf8')).toContain(SESSION_LIST_PARITY_MARKER)
    expect(readFileSync(hostPath(), 'utf8')).toContain(SESSION_LIST_PARITY_MARKER)
  })
})
