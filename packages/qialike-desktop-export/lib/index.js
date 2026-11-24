/**
 * Export one Session as a document — the host half of `@qialike/qialike-desktop-export`.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE SHIPPED EXPORT. The harness already ships
 * `@deepseek-ai/dsh-session-log-export`: a `/export` command and a header button that hand back
 * the Session's raw `.jsonl` log inside a ZIP. That is a backup of the log, not a document — a
 * person who wants to read, paste or hand a conversation to someone else cannot use it, and the
 * question was asked with the CLI's `/export` as the reference, which writes JSON and Markdown.
 *
 * WHAT IS BORROWED AND WHAT IS WRITTEN HERE. The reading is the harness's: `sessionQuery` owns
 * the durable event stream and the same call the ZIP export makes is what this uses, so a live
 * Session is flushed before it is read rather than exported half-written. The folding and the
 * two renderings are this file's, because the CLI's implementation lives inside an Ink module
 * (`packages/qialike-app/lib/export.js` imports `ink` and `react` at the top) and cannot be
 * imported by anything that is not a terminal — the same reason `qialike-desktop-providers`
 * consumes the CLI's *built* modules rather than its sources.
 *
 * WHERE THE FILE GOES. The Session's own workspace, as `session-<last eight of the id>.json`
 * or `.md`. That matches the CLI — a `/export` in the terminal and a menu item here put the
 * file in the same place with the same name — and it keeps the product's rule that nothing is
 * written outside the workspace the user is working in. The path is returned to the browser so
 * the row can say where it went; the file is never sent through the response.
 *
 * @module @qialike/qialike-desktop-export
 */

import { isAbsolute, join, relative, resolve } from 'node:path'

/** The one route this row serves. */
export const API_PATH = '/api/qialike/export'

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'qialike-export'

/** JSON, so a response body is never mistaken for a document. */
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** Read a JSON request body, or describe why it could not be read. */
async function readBody(request) {
  try {
    return await request.json()
  } catch (error) {
    return error instanceof Error ? `invalid JSON body: ${error.message}` : 'invalid JSON body'
  }
}

/**
 * Flatten one message's content into text.
 *
 * The event stream carries content as parts. Only text parts are readable as a document; an
 * image becomes a marker rather than a broken link, because a path to an attachment means
 * nothing outside the machine that holds it.
 *
 * @param content - the `content` array of a message, or anything else.
 * @returns plain text, newline-joined.
 */
function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') out.push(part.text)
    else if (part.type === 'image') out.push('[image]')
  }
  return out.join('\n')
}

/** Reasoning parts, kept apart from the answer so a document reads as a conversation. */
function flattenReasoning(content) {
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'reasoning' && typeof part.text === 'string') out.push(part.text)
  }
  return out.join('\n')
}

/** A tool result's output, which is itself a content array on most events. */
function flattenToolResult(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (typeof part.text === 'string') out.push(part.text)
    else if (part.type === 'text' && typeof part.text === 'string') out.push(part.text)
  }
  return out.join('\n')
}

/**
 * Fold the event stream into an ordered list of messages.
 *
 * THE SHAPE IS THE CLI'S, because the answer should not depend on which front end exported it:
 * `user` and `assistant` messages with their text, and `tool` entries whose output is attached
 * to the call that produced it. A tool call opens an entry and the matching result closes it —
 * that pairing is why this is a fold and not a filter.
 *
 * @param events - the Session's events, in order.
 * @returns `{ role, text, reasoning?, name?, input?, output?, error? }[]`.
 */
export function foldEvents(events) {
  const out = []
  const open = []
  for (const event of events) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'user/message':
        out.push({ role: 'user', text: flattenText(data.content) })
        break
      case 'assistant/message': {
        const message = data.message ?? {}
        out.push({
          role: 'assistant',
          text: flattenText(message.content),
          ...(flattenReasoning(message.content) === '' ? {} : { reasoning: flattenReasoning(message.content) }),
        })
        break
      }
      case 'tool/call': {
        const entry = { role: 'tool', name: String(data.name ?? ''), input: String(data.arguments ?? '') }
        out.push(entry)
        open.push(entry)
        break
      }
      case 'tool/result': {
        const output = flattenToolResult(data.message?.content)
        const entry = open.pop()
        if (entry === undefined) out.push({ role: 'tool', output })
        else entry.output = output
        if (data.error !== undefined) {
          const target = entry ?? out[out.length - 1]
          if (target !== undefined) target.error = String(data.error?.message ?? 'error')
        }
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * Render the folded document as Markdown.
 *
 * A heading with the provenance, then one section per message. Tool calls are written as a
 * collapsed detail — a document is for reading what was said, and a thousand-line tool output
 * in the middle of it makes the conversation unfindable. The full input and output are still
 * there, fenced, because the record is the point of an export.
 *
 * @param doc - `{ session, messages }` from {@link buildDocument}.
 * @returns the Markdown text.
 */
export function renderMarkdown(doc) {
  const lines = []
  lines.push(`# Session ${doc.session.id}`, '')
  lines.push(`- Exported: ${doc.session.exportedAt}`)
  lines.push(`- Workspace: \`${doc.session.cwd}\``)
  lines.push(`- Messages: ${doc.messages.length}`, '')
  for (const message of doc.messages) {
    if (message.role === 'tool') {
      lines.push(`### Tool: ${message.name === '' ? '(unnamed)' : message.name}`, '')
      if (message.input !== undefined && message.input !== '') {
        lines.push('```json', message.input, '```', '')
      }
      if (message.output !== undefined && message.output !== '') {
        lines.push('```', message.output, '```', '')
      }
      if (message.error !== undefined) lines.push(`**Error:** ${message.error}`, '')
      continue
    }
    lines.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}`, '')
    if (message.reasoning !== undefined && message.reasoning !== '') {
      lines.push('<details><summary>Reasoning</summary>', '', message.reasoning, '', '</details>', '')
    }
    lines.push(message.text ?? '', '')
  }
  return lines.join('\n')
}

/**
 * Assemble the exported document, unfiltered.
 *
 * `exportedAt` and `cwd` are recorded because a document that has been passed around needs to
 * say where it came from and when — the same two facts the CLI records.
 *
 * @param sessionId - the Session's id.
 * @param cwd - its workspace root.
 * @param events - its events.
 * @returns `{ session: {id, cwd, exportedAt}, messages }`.
 */
export function buildDocument(sessionId, cwd, events) {
  return {
    session: { id: sessionId, cwd, exportedAt: new Date().toISOString() },
    messages: foldEvents(events),
  }
}

/** The default file name, matching the CLI's: `session-<last eight of the id>`. */
export function defaultBaseName(sessionId) {
  return `session-${String(sessionId).slice(-8)}`
}

/**
 * Read one Session's events, through the persistence service.
 *
 * WHY NOT `sessionQuery`. That service has two implementations in this tree: the in-memory one
 * exposes `read(sessionId)`, and the SQLite one — which is what `dsh-base` mounts, and therefore
 * what runs here — exposes only `searchSessions`/`searchEvents`. Measured: `sessionQuery.read is
 * not a function`, after the route had already reported "missing session-query" for a service
 * that was present. Reading through `sessionPersistence` is what the shipped ZIP export does and
 * it is the interface both backends share.
 *
 * A LIVE SESSION IS FLUSHED FIRST, which is the other half of what that export does: its events
 * are in memory until the log is written, so exporting without the flush produces a document
 * that stops at the last turn boundary instead of at the last message.
 *
 * @param scope - the row's context, for `sessions` and `sessionPersistence`.
 * @param sessionId - which Session.
 * @param signal - cancellation.
 * @returns `{ events, header }`, or undefined when the Session has no stored log.
 */
async function readEvents(scope, sessionId, signal) {
  const options = signal === undefined ? {} : { signal }
  const sessions = scope.get('sessions')
  const persistence = scope.get('sessionPersistence')
  if (persistence === undefined) return undefined
  // Flush, because a running Session's tail is only in memory. Guarded: a Session this process
  // is not running has nothing to flush, which is the common case for a closed row.
  try {
    const live = sessions?.get?.(sessionId)
    if (live !== undefined) await sessions.flush(live)
  } catch {
    // A Session that cannot be flushed is still readable from what is stored.
  }
  let handle
  try {
    handle = await persistence.open(sessionId, 'read', options)
  } catch {
    return undefined
  }
  try {
    const { events } = await handle.read(0, undefined, options)
    return { events: events ?? [], header: handle.header }
  } finally {
    await handle.close()
  }
}

/** Describe why the export could not run, in terms a person can act on. */
function unavailable(services) {
  return `session export is unavailable: missing ${services}`
}

export function apply(ctx) {
  // BOTH SERVICES ARE DECLARED HERE, not read out of the connection's scope. A scope only
  // resolves what its own `inject` list named, so `scope.get('sessionQuery')` answered
  // `undefined` while `ctx.get('sessionQuery')` answered an object — measured, and the reason
  // the route replied "missing session-query" against a profile that had it mounted.
  ctx.inject(['connection', 'sessions', 'sessionPersistence'], (scope) => {
    const connection = scope.get('connection')
    scope.effect(() => connection.fetch.register({
      path: API_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readBody(request)
          if (typeof body === 'string') return json({ ok: false, message: body }, 400)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const format = body.format === 'json' ? 'json' : body.format === 'markdown' ? 'markdown' : ''
          if (sessionId === '') return json({ ok: false, message: 'sessionId is required' }, 400)
          if (format === '') return json({ ok: false, message: 'format must be "json" or "markdown"' }, 400)

          if (scope.get('sessionPersistence') === undefined) {
            return json({ ok: false, message: unavailable('session-persistence') }, 500)
          }

          const read = await readEvents(scope, sessionId, request.signal)
          if (read === undefined) return json({ ok: false, message: 'session not found' }, 404)

          // THE WORKSPACE COMES FROM THE SESSION'S OWN HEADER, not from the live-session table.
          // `sessions.get(id)` answers only for a Session this process is running, and the whole
          // point of the menu item is that it works on any row — including one that has been
          // closed for a week. The header is what the log itself records, so it is also the right
          // answer for a Session resumed elsewhere. Measured: the live table answered nothing for
          // an on-disk Session and the route returned 404 "no workspace is recorded".
          const workspace = read.header?.cwd
          if (typeof workspace !== 'string' || workspace === '') {
            return json({ ok: false, message: `no workspace is recorded for ${sessionId}` }, 404)
          }

          const doc = buildDocument(sessionId, workspace, read.events)
          const ext = format === 'markdown' ? 'md' : 'json'
          const text = format === 'markdown' ? renderMarkdown(doc) : JSON.stringify(doc, null, 2)

          // THE ROUTE RETURNS THE DOCUMENT; IT DOES NOT WRITE IT. The save dialog is a native
          // window and only the shell can open one, so the file lands where the user chooses
          // rather than inside the workspace. What this route owns is the part that needs the
          // Host's data: reading the Session and folding it into a document.
          return json({
            ok: true,
            suggestedName: `${defaultBaseName(sessionId)}.${ext}`,
            mimeType: format === 'markdown' ? 'text/markdown' : 'application/json',
            contents: text,
            messages: doc.messages.length,
            bytes: Buffer.byteLength(text, 'utf8'),
          })
        } catch (error) {
          return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'qialike-export: session export route')
  })
}
