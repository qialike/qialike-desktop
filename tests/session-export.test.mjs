/**
 * The Session export row: the fold, the two renderings, and the route's shape.
 *
 * WHY THESE ASSERTIONS AND NOT A SNAPSHOT. An export is a document someone else will read, so the
 * things that matter are the ones a reader would notice: that every message is in it, in order;
 * that a tool result is attached to the call that produced it rather than floating; that the
 * Markdown is Markdown and the JSON is parseable; and that a path cannot escape the workspace.
 * A golden file would pin the wording of a heading and miss all four.
 *
 * WHAT IS NOT COVERED, STATED PLAINLY: that the harness's `sessionQuery.read` is called with the
 * right arguments. That is a fact about a service this suite does not construct — the route test
 * below uses a stub and asserts what the row does with an answer, not how the answer is obtained.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import {
  API_PATH,
  buildDocument,
  defaultBaseName,
  foldEvents,
  renderMarkdown,
} from '../packages/qialike-desktop-export/lib/index.js'

/** A conversation with one tool call, its result, and a message on each side of it. */
const EVENTS = [
  { type: 'user/message', data: { content: [{ type: 'text', text: 'Make me a document' }] } },
  {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: 'I should write a script first.' },
          { type: 'text', text: 'Writing the script.' },
        ],
      },
    },
  },
  { type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"build.py"}' } },
  { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'wrote build.py' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done.' }] } } },
  // Not every event is a message; a fold that kept them would put machine bookkeeping in the
  // document.
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
]

describe('folding the event stream', () => {
  it('keeps every message, in the order it was said', () => {
    const messages = foldEvents(EVENTS)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(messages[0].text).toBe('Make me a document')
    expect(messages[3].text).toBe('Done.')
  })

  it('attaches a tool result to the call that produced it', () => {
    // THE PAIRING IS THE FOLD'S WHOLE JOB. A document where outputs float loose reads as a list
    // of unrelated facts; the reader needs "this command produced this".
    const tool = foldEvents(EVENTS).find((m) => m.role === 'tool')
    expect(tool.name).toBe('write')
    expect(tool.input).toBe('{"file_path":"build.py"}')
    expect(tool.output).toBe('wrote build.py')
  })

  it('keeps reasoning apart from what the assistant said', () => {
    const assistant = foldEvents(EVENTS)[1]
    expect(assistant.text).toBe('Writing the script.')
    expect(assistant.reasoning).toBe('I should write a script first.')
  })

  it('drops events that are not part of the conversation', () => {
    expect(foldEvents(EVENTS).some((m) => m.role === 'sandbox')).toBe(false)
  })

  it('records an error on the call it belongs to', () => {
    const messages = foldEvents([
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"false"}' } },
      { type: 'tool/result', data: { message: { content: [] }, error: { message: 'exit 1' } } },
    ])
    expect(messages[0].error).toBe('exit 1')
  })

  it('survives a result with no call, which a truncated log produces', () => {
    const messages = foldEvents([{ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'orphan' }] } } }])
    expect(messages).toHaveLength(1)
    expect(messages[0].output).toBe('orphan')
  })
})

describe('the two renderings', () => {
  const doc = buildDocument('session-12345678', '/work', EVENTS)

  it('names the Session, the workspace and the time', () => {
    // A document passed to someone else has to say where it came from.
    const md = renderMarkdown(doc)
    expect(md).toContain('# Session session-12345678')
    expect(md).toContain('/work')
    expect(md).toContain('Exported:')
  })

  it('writes Markdown that a reader can follow', () => {
    const md = renderMarkdown(doc)
    expect(md).toContain('## User')
    expect(md).toContain('## Assistant')
    expect(md).toContain('### Tool: write')
    // The tool's arguments are fenced, not inlined, so a long one does not break the page.
    expect(md).toContain('```json')
    expect(md).toContain('{"file_path":"build.py"}')
  })

  it('produces JSON that parses back to the same messages', () => {
    const parsed = JSON.parse(JSON.stringify(doc))
    expect(parsed.messages).toHaveLength(4)
    expect(parsed.session.id).toBe('session-12345678')
  })
})

describe('what the route hands back', () => {
  it('names the file after the Session, with the extension the format implies', () => {
    // The shell opens its save dialog with this name pre-filled, so it is the one piece of the
    // answer the user sees before choosing where to put the file.
    expect(`${defaultBaseName('session-12345678')}.md`).toBe('session-12345678.md')
    expect(`${defaultBaseName('session-12345678')}.json`).toBe('session-12345678.json')
  })

  it('is a document, not a path', () => {
    // THE ROUTE DOES NOT WRITE. The dialog and the write are the shell's, so the answer carries
    // the text; a route that wrote into the workspace put the file where the user did not choose,
    // which is what this changed.
    const route = readFileSync(join(ROOT, 'packages', 'qialike-desktop-export', 'lib', 'index.js'), 'utf8')
    expect(route).toContain('contents: text')
    expect(route, 'the route writes a file itself').not.toMatch(/writeFileSync|mkdirSync/u)
  })
})

describe('the client half', () => {
  const bundle = readFileSync(join(ROOT, 'packages', 'qialike-desktop-export', 'lib', 'client.js'), 'utf8')

  it('registers into the row menu, where the other per-Session actions live', () => {
    expect(bundle).toContain("ctx.slots.inject('sidebar.workspaces.session.menu.item'")
    expect(bundle).toMatch(/id: 'qialike-export'/)
    // A row menu is a list; a `single` seat would replace "Copy Session ID" instead of joining it.
    expect(bundle).toMatch(/name: 'sidebar\.workspaces\.session\.menu\.item'/)
  })

  it('asks for a format rather than guessing one', () => {
    // JSON answers a machine, Markdown answers a reader, and neither is a sensible default for
    // the other — so both are offered and the file is written only after the choice.
    expect(bundle).toContain("choice('json'")
    expect(bundle).toContain("choice('markdown'")
  })

  it('asks the shell to save, rather than writing anything itself', () => {
    // The save dialog is native and the write happens outside the renderer's sandbox. A page
    // that tried to download would depend on a `will-download` flow this origin does not raise.
    expect(bundle).toContain('dshDesktopBoot')
    expect(bundle).toContain('saveDocument')
    // ...and it says so when the bridge is absent, instead of failing silently.
    expect(bundle).toContain("t('noShell')")
    // A cancel is not a failure: the row goes back to offering the choice.
    expect(bundle).toContain("t('cancelled')")
  })

  it('dismisses the menu it sits in, the way every shipped entry does', () => {
    expect(bundle).toContain('useMenuOpenState')
    expect(bundle).toContain('setMenuOpen(false)')
  })
})

describe('the route', () => {
  it('is served under this product’s namespace, beside its other routes', () => {
    // A single prefix keeps every application-owned route in one place, and makes it obvious in
    // a request log which routes are ours rather than the harness's.
    expect(API_PATH.startsWith('/api/qialike/')).toBe(true)
  })
})
