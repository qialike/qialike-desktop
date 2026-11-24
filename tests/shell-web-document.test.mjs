/**
 * The shell's request handling: what it serves, what it refuses, and what it
 * does not forward.
 *
 * These are the assertions that matter for the boundary the shell owns. Most of
 * them are about *refusal*: the interesting failures in a proxy are the requests
 * it forwards that it should not have, and the headers it passes that leak the
 * credential it holds.
 *
 * The module under test imports `electron` for only one function
 * (`resolvePaths`), which these tests do not call, so it loads under plain Node.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APP_ORIGIN, authenticateWebHost, forwardWebRequest, isStaticDocument,
  serveStatic, websocketHandshakeHeaders,
} from '../apps/desktop/src/web-document.ts'

let root

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-dist-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>')
  writeFileSync(join(root, 'assets', 'app.js'), 'export const a = 1\n')
  writeFileSync(join(root, 'favicon.svg'), '<svg/>')
  // A file outside the dist, to prove containment is enforced on the real path.
  writeFileSync(join(root, '..', 'outside-secret.txt'), 'do not serve')
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('isStaticDocument', () => {
  it('claims the document, its assets and its icon set', () => {
    for (const path of ['/', '/index.html', '/assets/app.js', '/favicon.svg', '/manifest.webmanifest']) {
      expect(isStaticDocument(path), path).toBe(true)
    }
  })

  it('leaves API and plugin routes to the Host', () => {
    for (const path of ['/api/session/list', '/plugins/??a/client.js', '/healthz']) {
      expect(isStaticDocument(path), path).toBe(false)
    }
  })
})

describe('serveStatic', () => {
  const request = (url, method = 'GET') => new Request(url, { method })

  it('serves the index for the root', async () => {
    const response = await serveStatic(request(`${APP_ORIGIN}/`), root)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('id="root"')
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('splices the boot gate into the index only when asked', async () => {
    // The product document waits for the Host's rows; the shell's own pages have
    // no client to wait for anything and must not be given the gate.
    const gated = await (await serveStatic(request(`${APP_ORIGIN}/`), root, { gateBoot: true })).text()
    expect(gated).toContain('__DSH_BOOT_READY__')
    const plain = await (await serveStatic(request(`${APP_ORIGIN}/`), root)).text()
    expect(plain).not.toContain('__DSH_BOOT_READY__')
  })

  it('serves assets with their content type', async () => {
    const response = await serveStatic(request(`${APP_ORIGIN}/assets/app.js`), root)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
  })

  it('serves a bundled font with the font content type', async () => {
    // The self-hosted typefaces reach the browser through this route and no other:
    // `/assets/` is inside the static whitelist, so the shell answers it itself and
    // the request never reaches the Host. The MIME entry is therefore the only thing
    // that decides the `Content-Type` the browser sees — and a wrong one is not a
    // visible error, which is why it is asserted rather than trusted to the table.
    mkdirSync(join(root, 'assets', 'fonts'), { recursive: true })
    // The signature, so the assertion is about a real woff2 rather than any bytes.
    writeFileSync(join(root, 'assets', 'fonts', 'probe.woff2'), Buffer.from('wOF2\u0000\u0001\u0000\u0000'))
    const response = await serveStatic(request(`${APP_ORIGIN}/assets/fonts/probe.woff2`), root)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('font/woff2')
  })

  it('answers HEAD without a body', async () => {
    const response = await serveStatic(request(`${APP_ORIGIN}/assets/app.js`, 'HEAD'), root)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it('refuses a method that is not GET or HEAD', async () => {
    const response = await serveStatic(request(`${APP_ORIGIN}/`, 'POST'), root)
    expect(response.status).toBe(405)
  })

  it('refuses a path that escapes the dist', async () => {
    // Encoded traversal, on a file that really exists one level up: a check that
    // only stripped `..` would miss the encoded form, and one that did not
    // resolve first would miss a symlinked parent.
    const response = await serveStatic(request(`${APP_ORIGIN}/..%2Foutside-secret.txt`), root)
    expect([403, 404]).toContain(response.status)
    const body = response.status === 200 ? await response.text() : ''
    expect(body).not.toContain('do not serve')
  })

  it('does not treat a sibling directory as a child', async () => {
    // `/dist-x` must not pass a `startsWith(dist)` containment check.
    const sibling = `${root}-x`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'probe.txt'), 'sibling')
    try {
      const response = await serveStatic(request(`${APP_ORIGIN}/../${sibling.slice(1)}/probe.txt`), root)
      expect([403, 404]).toContain(response.status)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('reports a missing file as 404, not as an error', async () => {
    const response = await serveStatic(request(`${APP_ORIGIN}/assets/nope.js`), root)
    expect(response.status).toBe(404)
  })
})

describe('forwardWebRequest', () => {
  /** A Host stand-in that records what it received. */
  function fakeHost(respond) {
    const seen = []
    const server = {
      seen,
      fetch: async (input, init) => {
        seen.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers) })
        return respond()
      },
    }
    return server
  }

  it('refuses a request whose Origin is not this application', async () => {
    const request = new Request(`${APP_ORIGIN}/api/x`, { headers: { origin: 'https://evil.example' } })
    const response = await forwardWebRequest(request, 'http://127.0.0.1:1', 'cookie')
    expect(response.status).toBe(403)
  })

  it('accepts a request carrying this application origin', async () => {
    const real = globalThis.fetch
    let received
    globalThis.fetch = async (input, init) => { received = { url: String(input), init }; return new Response('ok') }
    try {
      const request = new Request(`${APP_ORIGIN}/api/x`, { headers: { origin: APP_ORIGIN } })
      const response = await forwardWebRequest(request, 'http://127.0.0.1:9', 'dsh-auth=abc')
      expect(response.status).toBe(200)
      expect(received.url).toBe('http://127.0.0.1:9/api/x')
    } finally {
      globalThis.fetch = real
    }
  })

  it('replaces the credential rather than forwarding the page\'s', async () => {
    const real = globalThis.fetch
    let headers
    globalThis.fetch = async (_input, init) => { headers = new Headers(init?.headers); return new Response('ok') }
    try {
      const request = new Request(`${APP_ORIGIN}/api/x`, {
        headers: { origin: APP_ORIGIN, cookie: 'attacker=1', host: 'qialike-app', 'sec-fetch-site': 'cross-site', referer: 'https://elsewhere' },
      })
      await forwardWebRequest(request, 'http://127.0.0.1:9', 'dsh-auth=real')
      expect(headers.get('cookie')).toBe('dsh-auth=real')
      // Each of these describes the page's relationship to an origin the Host
      // has never spoken to, and its trust fence would read them literally.
      for (const name of ['host', 'origin', 'sec-fetch-site', 'referer']) expect(headers.get(name), name).toBeNull()
    } finally {
      globalThis.fetch = real
    }
  })

  it('withholds the credential and the hop headers from the response', async () => {
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response('body', {
      headers: {
        'set-cookie': 'dsh-auth=leak',
        'content-encoding': 'gzip', 'content-length': '4', 'transfer-encoding': 'chunked',
        connection: 'keep-alive', 'keep-alive': 'timeout=5', te: 'trailers', trailer: 'x', upgrade: 'h2c',
        'x-kept': 'yes',
      },
    })
    try {
      const response = await forwardWebRequest(new Request(`${APP_ORIGIN}/api/x`), 'http://127.0.0.1:9', 'c')
      // A page that could read `set-cookie` could replace the shell's credential.
      expect(response.headers.get('set-cookie')).toBeNull()
      for (const name of ['content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']) {
        expect(response.headers.get(name), name).toBeNull()
      }
      // `content-length` IS RESTORED FOR A DRAINED BODY, and it is deliberately not in that list.
      // The upstream value describes the encoded hop; the value here describes the bytes Chromium
      // receives. Asserting it is present and correct is stronger than asserting it is absent, so
      // this case states the new contract rather than dropping the check.
      expect(response.headers.get('content-length')).toBe('4')
      expect(response.headers.get('x-kept')).toBe('yes')
    } finally {
      globalThis.fetch = real
    }
  })

  it('forces plugin bundles to be uncached', async () => {
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response('//', { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
    try {
      const plugin = await forwardWebRequest(new Request(`${APP_ORIGIN}/plugins/??a/client.js&rev=1`), 'http://127.0.0.1:9', 'c')
      // The Host versions bundles by a per-launch revision, so an immutable
      // marker would only fill Chromium's disk cache with entries no later launch
      // can reuse.
      expect(plugin.headers.get('cache-control')).toBe('no-store')
      const api = await forwardWebRequest(new Request(`${APP_ORIGIN}/api/x`), 'http://127.0.0.1:9', 'c')
      expect(api.headers.get('cache-control')).toContain('immutable')
    } finally {
      globalThis.fetch = real
    }
  })

  it('preserves the query string the route keys on', async () => {
    const real = globalThis.fetch
    let url
    globalThis.fetch = async (input) => { url = String(input); return new Response('ok') }
    try {
      await forwardWebRequest(new Request(`${APP_ORIGIN}/plugins/??a/client.js&rev=abc123`), 'http://127.0.0.1:9', 'c')
      expect(url).toBe('http://127.0.0.1:9/plugins/??a/client.js&rev=abc123')
    } finally {
      globalThis.fetch = real
    }
  })

  /**
   * The body-draining half.
   *
   * WHY THESE ASSERTIONS EXIST AT ALL. `forwardWebRequest` used to hand undici's response body to
   * Chromium unchanged. When a body like that is abandoned unread, undici's parser is left paused
   * and the FIN that `connection: close` guarantees makes `parser.finish()` assert from a socket
   * callback — `assert(!this.paused)` — which killed the main process from a place no `try`/`catch`
   * in this repository can reach (nodejs/undici#5360). A packaged build produced that dialog six
   * times in five days.
   *
   * These are unit tests over a fake `fetch`, which is the right level for "which bodies does the
   * shell read": the crash itself cannot be asserted here, because passing means not dying. The
   * process-level proof is `tests/undici-response-policies.mjs`.
   */
  describe('draining the body before handing it to the renderer', () => {
    /** Run `forwardWebRequest` against a fixed upstream response. */
    async function forward(upstream, path = '/api/x') {
      const real = globalThis.fetch
      globalThis.fetch = async () => upstream
      try {
        return await forwardWebRequest(new Request(`${APP_ORIGIN}${path}`), 'http://127.0.0.1:9', 'c')
      } finally {
        globalThis.fetch = real
      }
    }

    /** A Response whose body is a stream carrying `payload`, with an explicit content length. */
    function streamed(contentType, payload) {
      const bytes = new TextEncoder().encode(payload)
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close() },
      }), { headers: { 'content-type': contentType, 'content-length': String(bytes.length) } })
    }

    it('reads a JSON body to the end, so nothing is left for undici to abandon', async () => {
      const payload = JSON.stringify({ sessions: 'x'.repeat(32 * 1024) })
      const response = await forward(streamed('application/json', payload))
      // The proof that it was buffered rather than passed through: a `Response` built from an
      // `ArrayBuffer` can be cloned and both halves read in full, which a stream body cannot —
      // cloning a live stream tees it, and the upstream here would have to be read twice.
      const copy = response.clone()
      expect(await response.text()).toBe(payload)
      expect(await copy.text()).toBe(payload)
    })

    it('restores content-length to the length Chromium will read', async () => {
      // The withheld `content-length` described the *encoded* hop; leaving it off would make every
      // JSON reply look chunked, and restoring the upstream value would describe bytes the renderer
      // never receives.
      const payload = '{"a":1}'
      const response = await forward(streamed('application/json', payload))
      expect(response.headers.get('content-length')).toBe(String(payload.length))
    })

    it('drains a non-JSON body under its smaller budget', async () => {
      // MEASURED, AND THE REASON THE FIX PLAN'S FIRST DRAFT WAS WRONG: the crash is not a JSON
      // bug. A 32 KiB body abandoned unread crashes 5/5 as `application/octet-stream` too, so an
      // allow-list of JSON content types would leave Office previews and exports exposed.
      const payload = 'x'.repeat(64 * 1024)
      const response = await forward(streamed('application/octet-stream', payload))
      expect(await response.text()).toBe(payload)
      expect(response.headers.get('content-length')).toBe(String(payload.length))
    })

    it('streams an event stream, because it has no end to read to', async () => {
      // The one type the shell must never drain: reading it here turns a live connection into a
      // request that never resolves. Streamed bodies are recognisable by the withheld length and by
      // yielding a chunk while the upstream is still open.
      const response = await forward(streamed('text/event-stream', 'data: hi\n\n'))
      expect(response.headers.get('content-length')).toBeNull()
      const reader = response.body.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(new TextDecoder().decode(first.value)).toBe('data: hi\n\n')
      await reader.cancel()
    })

    it('streams a body with no content-length, because nothing bounds the buffer', async () => {
      const real = globalThis.fetch
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"a":1}')); controller.close() },
      }), { headers: { 'content-type': 'application/json' } })
      try {
        const response = await forwardWebRequest(new Request(`${APP_ORIGIN}/api/x`), 'http://127.0.0.1:9', 'c')
        expect(response.headers.get('content-length')).toBeNull()
        expect(await response.text()).toBe('{"a":1}')
      } finally {
        globalThis.fetch = real
      }
    })

    it('streams a JSON body larger than the JSON budget rather than holding it', async () => {
      const huge = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(1024)); controller.close() },
      }), { headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } })
      const response = await forward(huge)
      // Not buffered: the content-length is withheld rather than replaced, and the body is the
      // upstream stream.
      expect(response.headers.get('content-length')).toBeNull()
      await response.body.cancel()
    })

    it('cancels the upstream when the read fails, rather than leaving it paused', async () => {
      // A failed read is the same crash by another route: the upstream stream can be left paused on
      // a socket that is being closed. The cancellation in the catch is best effort — a stream that
      // has already errored will not run its `cancel` hook — so what this case pins is that the
      // original failure still reaches the caller instead of being replaced by a cleanup error.
      const failing = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(16)) },
        pull() { throw new Error('the Host went away mid-body') },
      }), { headers: { 'content-type': 'application/json', 'content-length': '1024' } })
      await expect(forward(failing)).rejects.toThrow(/went away mid-body/)
    })
  })
})

describe('websocketHandshakeHeaders', () => {
  it('attaches the credential and rewrites the origin for our documents', () => {
    const headers = websocketHandshakeHeaders('dsh-auth=abc', 'http://127.0.0.1:19388', APP_ORIGIN)
    expect(headers).toEqual({ origin: 'http://127.0.0.1:19388', cookie: 'dsh-auth=abc', 'sec-fetch-site': 'same-origin' })
  })

  it('treats an absent origin as ours, because Chromium never sends one on this scheme', () => {
    // THE ASSERTION THAT STANDS BETWEEN THE PRODUCT AND A DEAD LIVE CONNECTION. A
    // packaged build was measured doing exactly this: the handler fired, `origin`
    // arrived as the empty string, the old guard declined, the credential was never
    // attached, the Host answered 403, and the client retried forever behind a window
    // that rendered correctly and said "Reconnecting...".
    //
    // A custom-scheme document gets no Origin on a WebSocket handshake, so requiring
    // one is requiring something the browser does not have. The rewrite supplies the
    // Host's own authority, which is the value the Host's fence wants anyway.
    expect(websocketHandshakeHeaders('dsh-auth=abc', 'http://127.0.0.1:19388', ''))
      .toEqual({ origin: 'http://127.0.0.1:19388', cookie: 'dsh-auth=abc', 'sec-fetch-site': 'same-origin' })
  })

  it('still refuses a handshake that names an origin other than ours', () => {
    // The fence is about what the browser *does* say. A page that states an origin it
    // does not have is not one of ours, and the socket goes straight to the Host's own
    // loopback address — so the shell is the only thing standing between such a page
    // and the Host.
    expect(websocketHandshakeHeaders('c', 'http://127.0.0.1:1', 'https://evil.example')).toBeUndefined()
    // The literal "null" is what a sandboxed or opaque origin sends *when it sends
    // something*, and it is not ours either.
    expect(websocketHandshakeHeaders('c', 'http://127.0.0.1:1', 'null')).toBeUndefined()
  })
})

describe('authenticateWebHost', () => {
  it('extracts the cookie from a 303', async () => {
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth=xyz; Path=/; HttpOnly' } })
    try {
      expect(await authenticateWebHost('http://127.0.0.1:1/?token=t')).toBe('dsh-auth=xyz')
    } finally {
      globalThis.fetch = real
    }
  })

  it('refuses a 200 that carries no credential', async () => {
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response('hello', { status: 200 })
    try {
      await expect(authenticateWebHost('http://127.0.0.1:1/?token=t')).rejects.toThrow(/expected 303/)
    } finally {
      globalThis.fetch = real
    }
  })

  it('refuses a redirect that carries no cookie', async () => {
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 303 })
    try {
      await expect(authenticateWebHost('http://127.0.0.1:1/?token=t')).rejects.toThrow(/no cookie/)
    } finally {
      globalThis.fetch = real
    }
  })
})
