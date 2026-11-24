/**
 * Serve the browser surface's own documents, and proxy everything else to the Host.
 *
 * The window loads a single custom-origin document (`qialike-app://app/`). Three
 * kinds of request arrive on it, and each is answered by a different owner:
 *
 *   · **Static assets** — `index.html`, `/assets/*`, the favicon. Served straight
 *     from the packaged Web dist, so the window can paint before the Host is up.
 *   · **Everything else** — forwarded to the Host over an authenticated loopback
 *     connection, with the shell's cookie attached.
 *   · **The shell's own documents** (`qialike-app://shell/…`) — the loading and
 *     error pages, served without contacting the Host at all, because they have
 *     to work precisely when the Host does not.
 *
 * WHY A CUSTOM SCHEME AND A PROXY, rather than `file://` plus `fetch`. A page on
 * `file://` has an opaque origin: no service worker, no `localStorage` worth the
 * name, and every request needing an IPC hop anyway. A registered standard
 * scheme behaves like a real origin, so the client's own transport —
 * `fetch('/api/…')`, `WebSocket`, `EventSource` — works unmodified, and the shell
 * stays out of the request path except to attach a credential.
 *
 * SECURITY POSTURE. The renderer never receives the Host's token: the shell
 * redeems the tokenized URL once for a cookie it holds itself, and injects that
 * cookie on the way out. Response headers that describe the *hop* rather than the
 * resource are dropped, and `set-cookie` is withheld so the page cannot replace
 * the credential the shell owns. The origin check on the way in is the same one
 * the IPC layer applies: a request that did not come from this application's own
 * document is refused rather than forwarded.
 *
 * @module @qialike/desktop/web-document
 */

import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

/** Content types for the static document set. Deliberately small: the dist holds only these. */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/**
 * The origin every application document is served from.
 *
 * One origin for the shell's own pages and the product's, so the product page
 * can be served from `/` rather than a subdirectory — a base path would have to
 * be threaded through the client's routing and asset URLs, which the harness
 * builds for a root mount.
 */
export const APP_ORIGIN = 'qialike-app://app'

/** The origin for the shell's own documents, which never reach the Host. */
export const SHELL_ORIGIN = 'qialike-app://shell'

/**
 * The boot gate, spliced into `<head>` before any page script runs.
 *
 * SIXTY LINES BECAME ONE, AND THAT IS THE POINT. This used to be a hand-written
 * interpreter of the Host's boot rows, mirroring `applyIndexInjections`
 * (`@deepseek-ai/dsh-client-web`) row for row because an inline classic script cannot
 * import it. All of that was necessary only because this shell exposed its preload bridge
 * under a name the harness's browser entry does not look for: the entry contains a
 * desktop branch that fetches the rows, applies them through the real interpreter, sets
 * `__DSH_TRANSPORT__` and resolves this gate — and it runs when it finds a global named
 * `dshDesktopBoot`, which is now what {@link BRIDGE_GLOBAL} is.
 *
 * What is left is the one thing the entry cannot do for itself: create the gate, because
 * it *reads* it. The harness's own desktop does exactly this, with exactly this line
 * (`apps/desktop/src/web-document.ts` upstream), which is the shape to keep.
 *
 * WHY THE REJECTION IS PRE-HANDLED. Rejecting a promise nobody is awaiting yet is
 * reported as an unhandled rejection. The client does await this one, but only once its
 * own bundle has loaded — strictly later than a failure while fetching the rows.
 * Attaching a no-op catch marks it handled for the reporting machinery without consuming
 * the rejection the client still sees. This is the one deliberate difference from
 * upstream's version of the line, and it is an addition rather than a substitute: the
 * rejection itself is untouched.
 */
const BOOT_GATE = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()'
  + ';globalThis.__DSH_BOOT_READY__.promise.catch(function () {})</script>'


/** Static paths the shell answers from the packaged dist, before the Host is consulted. */
const STATIC_DOCUMENT_PATHS = new Set(['/', '/index.html', '/favicon.svg', '/favicon-dark.svg', '/manifest.webmanifest'])

/** Whether a path is a static document this shell serves itself. */
export function isStaticDocument(pathname: string): boolean {
  return STATIC_DOCUMENT_PATHS.has(pathname) || pathname.startsWith('/assets/')
}

/**
 * Read one static asset from the packaged Web dist.
 *
 * @param request - the incoming request.
 * @param root - the dist directory.
 * @param options.gateBoot - splice the boot bootstrap into the HTML. False for
 *   the shell's own documents, which have no client to wait for anything and no
 *   Host to fetch boot rows from.
 * @returns the response, or a status for a method/path the dist cannot answer.
 */
export async function serveStatic(request: Request, root: string, options: { gateBoot?: boolean } = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })

  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    // A malformed escape is a client error, not a path traversal.
    return new Response(null, { status: 400 })
  }

  const directory = resolve(root)
  const target = resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`)
  // Containment is checked on the *resolved* path so `..` segments and encoded
  // separators cannot escape, and the trailing separator keeps `/dist-x` from
  // passing as a child of `/dist`.
  if (target !== directory && !target.startsWith(directory + sep)) {
    return new Response(null, { status: 403 })
  }

  let body: Buffer
  try {
    body = await readFile(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return new Response(null, { status: 404 })
    throw error
  }

  const isIndex = pathname === '/' || pathname === '/index.html'
  // The gate goes in immediately after `<head>`, which is where the harness's own desktop
  // puts it. Its position within the head is not load-bearing — the page's entry is a
  // module script, so it is deferred and cannot run before the document is parsed — but
  // matching upstream keeps the two documents comparable.
  const content = isIndex && options.gateBoot === true
    ? body.toString('utf8').replace('<head>', `<head>${BOOT_GATE}`)
    : body

  return new Response(request.method === 'HEAD' ? null : content, {
    headers: {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      // The dist is versioned with the application, and this origin is not
      // reachable by anything else, so revalidation would only add latency.
      'cache-control': 'no-store',
    },
  })
}

/**
 * Exchange the Host's tokenized URL for an authority-bound cookie.
 *
 * Called once per Host start. The token never leaves this process: the shell
 * keeps the cookie and attaches it on the way out, so a renderer cannot read or
 * replay the credential.
 *
 * @param url - the authenticated URL from the Host's ready message.
 * @returns the cookie header value.
 * @throws Error when the exchange does not answer with a redirect and a cookie.
 */
export async function authenticateWebHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) {
    throw new Error(
      `qialike desktop: the Host authentication exchange failed: expected 303 with a Set-Cookie, `
      + `received ${String(response.status)}${cookie === null ? ' and no cookie' : ''}`,
    )
  }
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * Response headers describing the Node `fetch` hop rather than the resource.
 *
 * `content-encoding` and `content-length` describe the compressed byte stream
 * Node received; Chromium sees the decoded body and would mis-frame it.
 * `transfer-encoding`, `connection`, `keep-alive`, `te`, `trailer` and `upgrade`
 * are hop-by-hop by definition. `set-cookie` is withheld because the cookie is
 * the shell's credential, not the page's.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
  'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses are versioned by a per-launch revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * The one content type whose body must never be read to the end here.
 *
 * An event stream is read incrementally for as long as the page is open, so draining it would turn
 * a live connection into a request that never resolves. Every other type is a document with an end,
 * which is what makes the budget below applicable to it.
 */
const STREAMED_CONTENT_TYPE = /^text\/event-stream\b/iu

/** Content types whose body is a finite JSON document; see {@link MAX_BUFFERED_JSON_BYTES}. */
const JSON_CONTENT_TYPE = /^(?:application|text)\/(?:[\w.+-]+\+)?json\b/iu

/**
 * The largest JSON body this process will hold: 8 MiB.
 *
 * Sized against what the product actually answers. Session transcripts are the largest JSON the
 * Host produces, and they are far below this; the cap exists so that a route returning something
 * unexpected cannot grow the main process without bound, one request at a time.
 */
const MAX_BUFFERED_JSON_BYTES = 8 * 1024 * 1024

/**
 * The largest NON-JSON body this process will hold: 256 KiB.
 *
 * WHY NOT THE SAME BUDGET AS JSON, AND WHY NOT ZERO. Reading a body here costs one copy and one
 * round of latency, both of which are worth paying for the sizes that can actually crash the
 * process — and not worth paying for a download. The window that crashes is narrow and measured
 * (`docs/UNDICI-PAUSED-PARSER.md` §2): the whole body has to arrive in ONE socket read, which on a
 * loopback socket tops out in the tens of kibibytes, so 256 KiB is above every dangerous size and
 * below every size worth streaming. Larger bodies arrive across several reads and were measured
 * not to crash even when abandoned (0/5 at 64 KiB and above, and 0/5 for a body written in four
 * chunks with the client reading one and leaving).
 */
const MAX_BUFFERED_OTHER_BYTES = 256 * 1024

/**
 * Request headers the shell replaces or drops before forwarding.
 *
 * `origin` and `sec-fetch-site` describe the renderer's relationship to a Host it
 * has never spoken to; the Host's own trust fence would read them as a
 * cross-origin request. `host` would name the application origin rather than the
 * Host's. `cookie` is replaced with the shell's own.
 */
const REPLACED_REQUEST_HEADERS = ['host', 'origin', 'cookie', 'sec-fetch-site', 'referer']

/**
 * Forward one application request to the owned Host.
 *
 * @param request - the request from the application document.
 * @param host - the Host's origin.
 * @param cookie - the shell's Host cookie.
 * @returns the Host's response, with hop-level headers removed.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string): Promise<Response> {
  const origin = request.headers.get('origin')
  // A browser sends `Origin` on cross-origin requests and on same-origin
  // non-GET ones. When it is present it must name this application: a page that
  // somehow obtained the origin would otherwise reach the Host through the shell.
  if (origin !== null && origin !== APP_ORIGIN) return new Response(null, { status: 403 })

  const source = new URL(request.url)
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search

  const headers = new Headers(request.headers)
  for (const name of REPLACED_REQUEST_HEADERS) headers.delete(name)
  headers.set('cookie', cookie)
  // NO CONNECTION REUSE, AND THAT IS A CORRECTNESS REQUIREMENT RATHER THAN A TUNING KNOB.
  //
  // The Host runs a Node `http.Server` with its DEFAULT timeouts — no `keepAliveTimeout` is set
  // anywhere in the runtime tree, so it closes an idle connection after 5 s. The shell forwards
  // through the global `fetch` (undici), which pools connections and keeps them far longer. When
  // the pool hands back a socket the Host has already closed, the request is written into a
  // connection that will never answer: the server sends no RST, so nobody learns until the
  // client's `headersTimeout` expires — 60 s by default — and the shell then reports a 502
  // "the desktop Host is unreachable".
  //
  // MEASURED before this line existed, on a packaged build: the same URL answered in 61,526 ms
  // with a 502, then in 28 ms with a 200 on the very next call. A 9-byte 404 hung identically, so
  // it was not payload size or any one route; and every hung call landed between 60 and 92 s,
  // which is the `headersTimeout` fingerprint rather than network variance. That is the whole of
  // the "Plugins takes forever" report, and of an Office probe that failed only after idling.
  //
  // `connection: close` asks the server to end the connection after this response, and undici
  // honours it by not returning the socket to the pool. The cost is a TCP handshake per request
  // against a loopback Host — microseconds — against a failure mode measured in minutes.
  headers.set('connection', 'close')

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    duplex: 'half',
    redirect: 'manual',
  } as RequestInit & { duplex: 'half' })

  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  // Plugin bundles are served under a revision that changes every launch, so the
  // Host's immutable marker would only accumulate entries Chromium can never
  // reuse. Everything else keeps the Host's caching decision.
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')

  // DRAINING THE BODY HERE IS WHAT KEEPS THIS PROCESS ALIVE, and nothing in this function's
  // signature says so: it is undici's parser, not ours, that asserts when a body is abandoned.
  // `connection: close` above guarantees a FIN after every response, so a body left unread past
  // undici's pause threshold kills the main process from a socket callback that no `try`/`catch`
  // here can reach (nodejs/undici#5360, fixed upstream in #5474). Reading it to the end leaves
  // undici nothing to abandon.
  //
  // WHY THE CONDITION IS A SIZE AND NOT A TYPE. The published analysis of that bug, and the first
  // draft of the doc for this fix, both assumed JSON. Measured on this runtime instead: a 32 KiB
  // body abandoned unread crashes 5/5 as `application/json`, `application/octet-stream`,
  // `text/event-stream`, `text/html`, `image/png` and a docx content type alike — the parser does
  // not know what it is carrying. A JSON-only allow-list therefore leaves Office previews,
  // exports, attachments and the app's own icons on the crashing side of the fence.
  //
  // So the budget follows `content-length`, with a small one for everything that is not JSON, and
  // exactly one type is excluded outright: an event stream, which has no end to read to.
  const contentType = response.headers.get('content-type') ?? ''
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  const budget = JSON_CONTENT_TYPE.test(contentType) ? MAX_BUFFERED_JSON_BYTES : MAX_BUFFERED_OTHER_BYTES
  const drain = response.body !== null
    && !STREAMED_CONTENT_TYPE.test(contentType)
    && Number.isFinite(declared)
    && declared <= budget

  if (!drain) {
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers: outgoing,
    })
  }

  let body: ArrayBuffer
  try {
    body = await response.arrayBuffer()
  } catch (error) {
    // A failed read can leave the upstream stream paused on a socket that is being closed, which
    // is the same crash by another route. Cancelling releases it before the error propagates.
    await response.body?.cancel().catch(() => {})
    throw error
  }

  // The withheld `content-length` was the *encoded* length Node received; this one is the length
  // Chromium will actually read, so it is correct here and worth restoring — a buffered response
  // without it would make every JSON reply look chunked to the renderer.
  outgoing.set('content-length', String(body.byteLength))
  return new Response(body, { status: response.status, statusText: response.statusText, headers: outgoing })
}

/**
 * Headers for the WebSocket handshake the client opens to the Host.
 *
 * The renderer connects to `ws://127.0.0.1:<port>/…` directly — the Host's own
 * address, not the application origin — so the shell has to attach the cookie
 * and rewrite `Origin` on the handshake, or the Host's trust fence refuses it.
 * This is the one place the shell edits a request it did not route.
 *
 * AN ABSENT ORIGIN IS THE NORMAL CASE HERE, NOT A SUSPICIOUS ONE, and assuming
 * otherwise cost the product its live connection. The fence below used to require
 * `Origin` to be one of this application's two origins, on the reasoning that a
 * handshake from anywhere else is not one this application started. That reasoning
 * holds for a page served over `http(s)`, where the browser always sends `Origin` on
 * a WebSocket handshake — but **Chromium sends no Origin at all for a handshake
 * initiated from a custom-scheme document**, and every document this shell loads is
 * `qialike-app:`. Measured on a packaged build: the handler fired (so Electron does
 * intercept WebSocket handshakes), the origin arrived as the empty string, the guard
 * declined, no credential was attached, the Host answered 403, and the client
 * retried forever behind a window that rendered perfectly and showed
 * "Reconnecting...".
 *
 * The fence is therefore about what the browser *does* tell us: when an `Origin` is
 * present it must be one of ours, and when it is absent we supply the Host's own
 * authority — which is the value the Host's fence requires anyway. Nothing is
 * weakened for a page that states an origin, and a page cannot state an origin it
 * does not have.
 *
 * @param cookie - the Host credential the shell redeemed.
 * @param hostOrigin - the Host's own origin, which `Origin` must equal.
 * @param requestOrigin - the origin the renderer sent, or an empty string.
 * @returns the header overrides to apply, or undefined to let the request pass.
 */
export function websocketHandshakeHeaders(cookie: string, hostOrigin: string, requestOrigin: string): Record<string, string> | undefined {
  if (requestOrigin === '' || requestOrigin === APP_ORIGIN || requestOrigin === SHELL_ORIGIN) {
    return { origin: hostOrigin, cookie, 'sec-fetch-site': 'same-origin' }
  }
  // A handshake that names an origin other than this application's is not one this
  // application started.
  return undefined
}
