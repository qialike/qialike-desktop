# The paused-parser assertion: what it is, and the fix for `forwardWebRequest`

English | [中文](UNDICI-PAUSED-PARSER.zh.md)

**Status**: **implemented in 0.6.1** — `forwardWebRequest` drains the bodies it can and cancels the ones it cannot. The shell-side stopgap that shipped first as a hotfix, and then in 0.6.0, is described in §9.

> **The plan in §3.1 was wrong about one thing, and the measurement is the reason it is recorded
> here rather than quietly edited out.** It said only JSON may be buffered, on the assumption that
> the crash was a JSON bug. It is not: `tests/undici-response-policies.mjs` part 1 drives the
> original passthrough policy with six content types and 32 KiB bodies, and **every one of them
> crashes 5/5** — json, octet-stream, event-stream, html, png, docx alike. The parser does not know
> what it is carrying. A JSON allow-list would have left Office previews, exports, downloads and the
> app's own images on the crashing side of the fence, while every test that only ever fetched
> `/api/…` JSON passed. The shipped rule is therefore a **size** budget with one type excluded, not
> a type allow-list; §3.1 and §3.2 below now describe what the code actually does.

**Symptom**. A modal in the main process:

```
A JavaScript error occurred in the main process
Uncaught Exception:
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

  assert(!this.paused)

    at Parser.finish (node:internal/deps/undici/undici:7388:9)
    at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)
    at Socket.emit (node:events:521:24)
    at endReadableNT (node:internal/streams/readable:1729:12)
```

The window keeps working, so the dialog is the only trace. It is reported as "a popup after
every task", which is the correct reaction: nothing the user did caused it and nothing they can
do fixes it.

---

## 1. What is actually wrong

`forwardWebRequest` (`apps/desktop/src/web-document.ts`) forwards every application request to
the Host through Node's global `fetch`, which is undici, and hands undici's response body to
Chromium unchanged:

```ts
return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
```

Two properties of that line, both deliberate elsewhere in the file, together arm the crash:

| Ingredient | Where it comes from |
| --- | --- |
| The connection ends after every response | `headers.set('connection', 'close')` — added on purpose, see the comment at web-document.ts:242 |
| The body can be abandoned unread | Chromium decides whether to read; a navigation, an `AbortController`, a caller that only wanted the status, or a superseded request all drop it |

When a body is abandoned past undici's pause threshold, its HTTP parser **pauses** for
backpressure. The `connection: close` then delivers a FIN. undici's socket `end` handler calls
`parser.finish()`, whose first statement asserts the parser is **not** paused:

```js
// node:internal/deps/undici/undici
function finish() { assert(!this.paused); ... }
```

The assertion throws from an event callback, so no `try`/`catch` in this repository can reach
it. That is the whole bug — it is undici's, [nodejs/undici#5360][issue], fixed upstream in
[#5474][pr] but not in the undici that Node 24 and Electron 44 ship.

[issue]: https://github.com/nodejs/undici/issues/5360
[pr]: https://github.com/nodejs/undici/pull/5474

## 2. The window is not "large responses"

The published analysis of this bug places it above 64 KiB. **On this machine it is below 64 KiB**,
and that difference is the reason a size threshold is the wrong fix.

Measured by `tests/undici-window.mjs`, which ships with this repository so the numbers can be
re-taken on the machine in question: a loopback server sends `n` bytes of `application/json`
with `connection: close`; the client fetches and never reads the body; five runs per size, each
in its own child process because the assertion is fatal.

Node **v24.22.0 / undici 7.29.1**, one `res.end(body)` per response:

| body | 4 KiB | 8 KiB | 12 KiB | 16 KiB | 24–63.5 KiB | 64 KiB | 65–512 KiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| crashes | 0/5 | 0/5 | 0/5 | **5/5** | **5/5** | 0/5 | 0/5 |

The same sweep with the body split across two writes with a 20 ms gap:

| body | 4–12 KiB | 16 KiB | 24 KiB | 32 KiB and above |
| --- | --- | --- | --- | --- |
| crashes | 0/5 | **5/5** | **5/5** | 0/5 |

So the trigger is not a size. It is a coincidence of three things:

1. the body is large enough to exceed undici's pause threshold (~16 KiB here, 64 KiB on the
   reporter's Node 24.21),
2. the whole body still arrives in **one socket read**, so the FIN lands in the same read as the
   paused data, and
3. that read is processed while the parser is paused.

Boundary 1 moves with the undici version; boundary 2 moves with the write pattern, the socket
buffer, and the MTU. **Every one of them is outside this repository's control.** A guard written
as `if (size > 64 * 1024) buffer()` would therefore be guarding the empty half of the window on
this machine and missing the half that actually fires.

## 3. The fix

Buffer the bodies we are allowed to buffer, cancel the ones we are not, and stream the rest.

### 3.1 What may be buffered

The rule as shipped: **a body is read to the end when it declares a `content-length` inside its
budget, unless it is an event stream.** Type decides only which budget applies.

| Response | Read to the end? | Why |
| --- | --- | --- |
| `application/json`, `content-length` ≤ 8 MiB | **yes** | A finite document. 8 MiB is above every JSON response this product produces — session transcripts are the largest — and the cap exists so one handler cannot grow the process without bound. |
| anything else, `content-length` ≤ 256 KiB | **yes** | **Measured, not assumed**: the crash is content-type independent (§ above), and the window that crashes needs the whole body in ONE socket read, which on loopback tops out in the tens of kibibytes. 256 KiB is above every dangerous size and below every size worth streaming. |
| `text/event-stream` | **no** | The only type that must never be drained: it has no end, so reading it here turns a live connection into a request that never resolves. The Host's own gzip filter already special-cases it (`packages/host/webserver/src/index.ts:227`), which is independent evidence it must not be touched mid-flight. |
| no `content-length` (chunked) | **no** | Nothing bounds the buffer, so streaming is the only safe choice. Measured safe: a body written in four chunks with the client reading one and leaving did not crash 0/5 on any policy. |
| bodies over budget | **no** | They arrive across several reads, and the multi-read case was measured not to crash even when abandoned (0/5 at 64 KiB and above). |
| `content-range` present | **yes, under the same budget** | A range response declares its own length, so the same rule applies; the client asked for a slice and receives that slice. |

`application/octet-stream`, `multipart/form-data` and `image/*` are **not** excluded: that was the
draft's rule and it was measured to be wrong. They are simply buffered only while they are small.

### 3.2 The change

Constants added beside the other header constants in `web-document.ts`:

```ts
/** The one content type whose body must never be read to the end here. */
const STREAMED_CONTENT_TYPE = /^text\/event-stream\b/iu

/** Content types whose body is a finite JSON document; see MAX_BUFFERED_JSON_BYTES. */
const JSON_CONTENT_TYPE = /^(?:application|text)\/(?:[\w.+-]+\+)?json\b/iu

const MAX_BUFFERED_JSON_BYTES = 8 * 1024 * 1024    // session transcripts are the largest JSON
const MAX_BUFFERED_OTHER_BYTES = 256 * 1024        // above every size that can arrive in one read
```

And the tail of `forwardWebRequest`:

```ts
  const contentType = response.headers.get('content-type') ?? ''
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  const budget = JSON_CONTENT_TYPE.test(contentType) ? MAX_BUFFERED_JSON_BYTES : MAX_BUFFERED_OTHER_BYTES
  const drain = response.body !== null
    && !STREAMED_CONTENT_TYPE.test(contentType)
    && Number.isFinite(declared)
    && declared <= budget

  if (!drain) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
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

  outgoing.set('content-length', String(body.byteLength))
  return new Response(body, { status: response.status, statusText: response.statusText, headers: outgoing })
```

The restored `content-length` is the length Chromium will read, not the encoded length the Host
sent — which is why the withheld `content-length` is replaced rather than forwarded.

`authenticateWebHost` in the same file already did this the other way, and is the precedent that was
followed — it keeps no body at all and says so:

```ts
await response.body?.cancel()   // web-document.ts:179
```

### 3.3 The error path that already exists

`installProtocolHandler` (`main.ts`) wraps `forwardWebRequest` in `try`/`catch` and returns a
502 JSON response. Nothing needs to change there: with the body drained before the `Response` is
built, the only way to reach the `catch` is a `fetch` that never produced a body.

## 4. What this costs

| | Before | After |
| --- | --- | --- |
| JSON responses | streamed to Chromium | one extra copy in the main process |
| Time to first byte for JSON | immediate | after the body is read (~1 ms on loopback for a 32 KiB body) |
| Event streams, downloads, uploads | streamed | unchanged |
| Peak memory | one body per in-flight request | the same, but bounded by the body budget and released as soon as the `Response` is collected |

The copy is the point: a `Response` built from an `ArrayBuffer` has no socket behind it, so
there is nothing left to pause.

## 5. Why not the other two options

**Keep-alive instead of `connection: close`.** This would remove the FIN-after-every-response
that makes the crash reachable — and reintroduce the 60-second hangs the current comment
measures in detail (web-document.ts:242). The FIN is not the bug; abandoning a body is.

**A newer undici / Node.** Correct, and worth doing on its own schedule, but it does not fix
today's install: Electron 44 bundles Node 24.18.1 / undici 7.29.0, and pinning a different
Electron patch release is exactly the reasoning [#5360][issue] warns against for Node.

**A global `uncaughtException` handler.** Necessary as a stopgap (§9) and insufficient as a
fix: it stops the dialog, not the dropped request. Both should exist — the handler for the next
unknown, the drain for this one.

## 6. How to prove it

### 6.1 Unit level (`tests/shell-web-document.test.mjs`, 7 cases added)

These drive `forwardWebRequest` against a fake `fetch`, which is the right level for "which bodies
does the shell read". They cannot assert the crash itself, because passing means not dying.

| Case | Assertion |
| --- | --- |
| JSON, 32 KiB | the body reads back byte-for-byte **and the response can be cloned and read again** — the property an `ArrayBuffer` body has and a live stream does not |
| `content-length` after a drain | equals the decoded byte length, not the upstream's encoded one |
| `application/octet-stream`, 64 KiB | drained under its smaller budget; content-type does not exempt a body |
| `text/event-stream` | not drained: the length stays withheld and the first chunk arrives before the upstream closes |
| chunked JSON (no `content-length`) | not drained; the body still reads correctly |
| JSON declaring `8 MiB + 1` | not drained |
| a route that rejects mid-body | `forwardWebRequest` rejects with the upstream error, not with a cleanup error |

### 6.2 Process level (`tests/undici-response-policies.mjs`)

Each policy runs in its own Node child: it serves the body, fetches it, forwards it the way
`forwardWebRequest` does, and lets the forwarded `Response` be abandoned. Measured on this machine
(Node 24.22.0 / undici 7.29.1, 32 KiB body, five runs each) — this is the run that overturned the
JSON allow-list:

**Part 1: the crash does not depend on the content type** (passthrough policy)

| type | crashes |
| --- | --- |
| `application/json` | 5/5 |
| `application/octet-stream` | 5/5 |
| `text/event-stream` | 5/5 |
| `text/html` | 5/5 |
| `image/png` | 5/5 |
| `…wordprocessingml.document` | 5/5 |

**Part 2: what fixes it, on a NON-JSON body the allow-list would have skipped**

| policy | crashes | survived |
| --- | --- | --- |
| `new Response(response.body, …)` — what the shell did | **5/5** | 0/5 |
| `await response.body.cancel()`, then `new Response(null, …)` | 0/5 | 5/5 |
| `await response.arrayBuffer()`, then `new Response(bytes, …)` | 0/5 | 5/5 |
| build the passthrough, then cancel the forwarded body | 0/5 | 5/5 |
| hand over a `ReadableStream` we own, whose `cancel` releases upstream | 0/5 | 5/5 |

Three of those five are safe, so draining is **not** the only way out — but it is the one that also
removes the socket, which is why it is what shipped.

The script fails if the passthrough control *stops* crashing, because a control that no longer
reproduces the bug is a harness that has stopped testing anything. The first measurement attempt
here used an 80 KiB body and survived — a wrong size looks exactly like a fix, which is why the
control is asserted rather than assumed.

### 6.3 The window, measured a third way

A body written in four 8 KiB chunks, with the client reading one chunk and then abandoning:
**passthrough 0/5, owned-stream 0/5, buffered 0/5**. The crash needs the whole body in one read, so
the multi-read path is not at risk — which is what makes the 256 KiB budget for non-JSON safe
rather than merely convenient.

### 6.4 What to watch afterwards

The main-process log (`$DSH_HOME/qialike-desktop.log`) kept receiving
`main process: uncaught exception (undici-paused-parser)` entries from the §9 handler — six of them
between 2026-11-02 and 2026-11-07, which is how the gap this fix closes was found in the first
place. After this fix those entries should stop. If one appears for a **drained** route, the budget is
wrong and the log line is the evidence — though it will not name the route, which is the one
diagnostic gap this change does not close: the guard sees a stack, not a URL. A second occurrence
should therefore be attributed by adding the path to the entry rather than by widening the budget
on a guess.


## 7. Risks

- **A JSON route that is secretly a stream.** The allow-list assumes this does not exist. It was
  checked (`x-ndjson` and `jsonl` appear nowhere in the runtime), but a future route could add
  one, and the symptom would be a request that never returns. Mitigation: the unit case for
  `text/event-stream` documents the intended contract, and a new streamed route must not be
  served as `application/json`.
- **Memory.** Bounded by `MAX_BUFFERED_JSON_BYTES` / `MAX_BUFFERED_OTHER_BYTES` per in-flight request. With N concurrent requests
  the worst case is N × 8 MiB. The Host already serialises most of this work, so N is small; if
  that stops being true, lower the cap rather than removing it.
- **Latency.** One full body read before the renderer sees a byte. On loopback this is
  sub-millisecond for the sizes involved; it is not free for a very large transcript, which is
  what the cap is for.

## 8. Checklist

- [x] `STREAMED_CONTENT_TYPE`, `JSON_CONTENT_TYPE`, `MAX_BUFFERED_JSON_BYTES`, `MAX_BUFFERED_OTHER_BYTES` added with their comments — **replacing** the draft's single JSON allow-list, because the sweep in §6.2 showed the crash is type-independent
- [x] `forwardWebRequest` drains what it may, cancels on failure, restores `content-length`
- [x] unit cases in §6.1, including the ones that must *not* be drained
- [x] `undici-response-policies.mjs` extended: the content-type sweep and four non-passthrough policies are permanent controls
- [x] `typecheck` and `vitest run` clean (the four pre-existing suites in §10 aside)
- [ ] one packaged build exercised by hand: open a session, run a task, navigate away mid-stream — and then `Select-String -Path ~\.dsh\qialike-desktop.log -Pattern 'undici-paused-parser'` returns nothing

## 9. What shipped ahead of the fix

`apps/desktop/src/main-crash-guard.ts` plus 20 lines in `main.ts`. It adds **one**
`uncaughtException` listener, which is precisely the condition Electron's own handler tests
(`listenerCount('uncaughtException') > 1`) before showing its dialog, so the dialog stops
appearing; the failure goes to `qialike-desktop.log` with the runtime versions and a sentence
saying what it means.

It shipped first as a **hotfix that replaced the installed `app.asar`** — the two compiled files
(`lib/main.js`, `lib/main-crash-guard.js`) grafted into the archive by a PowerShell script that
kept a backup and could roll back. That was the right instrument for 6 firings in 5 days and the
wrong place to leave it: an upgrade overwrites it, it cannot be reviewed, and it left three copies
of 0.6.0 in circulation. It is ordinary source as of 0.6.0, so the hotfix pack is retired.

It does not fix the dropped request — that is §3, and the log is what proved it was still needed:
**six `undici-paused-parser` entries between 2026-11-02 and 2026-11-07** while the guard was
installed and no dialog appeared. Silencing a symptom is measurable as a symptom that is still
happening.

Verified in a real Electron 44 process (`tests/crash-guard-probe.mjs`): 1 listener without,
2 with, dialog in the first case and not in the second, and the log entry names
`undici-paused-parser`.

The three harnesses this document relies on, all runnable as they are:

```powershell
node tests/undici-response-policies.mjs   # the A/B and the type sweep, ~2 min
node tests/undici-window.mjs              # the size sweep, ~2 min
node tests/crash-guard-probe.mjs          # the Electron A/B, needs an Electron binary
```

## 10. Failures that predate this plan

Four suites fail on a clean `e3daddb` checkout, before any of the above:

```
tests/office-engine-install.test.mjs   3 failures
tests/release-config.test.mjs          1 failure
tests/running-instance.test.mjs        3 failures
tests/shell-packaging.test.mjs         5 failures   (EPERM on symlink creation under Windows)
```

They were confirmed unchanged by stashing the crash-guard work and re-running. They are not
caused by this plan and should not be confused with it when checking the checklist above.
