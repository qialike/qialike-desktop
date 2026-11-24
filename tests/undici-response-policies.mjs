/**
 * A/B the response policies `forwardWebRequest` could use, against the real crash.
 *
 * THE MEASUREMENT THAT DECIDES THE FIX, in two parts.
 *
 * Part 1 sweeps content types through the policy the shell used to use. It exists because the
 * public analysis of this bug, and the first draft of `docs/UNDICI-PAUSED-PARSER.md`, both assumed
 * the trigger was a large JSON body. It is not: the parser does not know what it is carrying. A
 * fix written as "buffer `application/json`" therefore leaves Office previews, exports, downloads
 * and the app's own images on the crashing side — which is what this sweep measures.
 *
 * Part 2 compares the policies themselves on a NON-JSON body, because that is the case a JSON
 * allow-list would miss:
 *
 *   passthrough        new Response(response.body, …)      what the shell did
 *   discard            await response.body?.cancel()       "I do not want this body at all"
 *   buffered           await response.arrayBuffer()        drain it, then answer from the bytes
 *   cancel-forwarded   build the passthrough, then cancel the forwarded body
 *   owned-stream       hand over a ReadableStream we own, whose cancel releases upstream
 *
 * The forwarded `Response` is then abandoned without being read, which is what Chromium does when
 * a caller only wanted the status, when a navigation supersedes a request, and when an
 * `AbortController` fires. That abandonment is the whole trigger.
 *
 * A `passthrough` row that stops crashing means this harness has stopped testing anything, so the
 * script fails rather than reporting a comfortable green. That matters: the first version of this
 * measurement used 80 KiB and survived, because 80 KiB is outside the window on this runtime - the
 * bug is narrow enough that a wrong size looks like a fix.
 *
 * Run:  node tests/undici-response-policies.mjs
 * Env:  RUNS=5 to change the sample size, SIZE=32768 to change the body.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)

/** Inside the measured window on Node 24.22 / Electron 44, and on the reporter's Node 24.21. */
const SIZE = Number(process.env.SIZE ?? 32 * 1024)
const RUNS = Number(process.env.RUNS ?? 5)

/** Every content type the product can answer with, plus two it cannot. */
const TYPES = [
  'application/json',
  'application/octet-stream',
  'text/event-stream',
  'text/html',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

if (process.argv.includes('--child')) {
  const [type, policy] = process.argv.slice(-2)

  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': type, 'content-length': String(SIZE), connection: 'close' })
    response.end('x'.repeat(SIZE))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const upstream = await fetch(`http://127.0.0.1:${server.address().port}/api/session/list`, {
    redirect: 'manual',
  })

  let forwarded
  if (policy === 'passthrough') {
    forwarded = new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  } else if (policy === 'discard') {
    await upstream.body?.cancel()
    forwarded = new Response(null, { status: upstream.status, headers: upstream.headers })
  } else if (policy === 'cancel-forwarded') {
    forwarded = new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
    await forwarded.body?.cancel()
  } else if (policy === 'owned-stream') {
    const reader = upstream.body.getReader()
    forwarded = new Response(new ReadableStream({
      async pull(controller) {
        const chunk = await reader.read()
        if (chunk.done) controller.close()
        else controller.enqueue(chunk.value)
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
    }), { status: upstream.status, headers: upstream.headers })
  } else {
    const bytes = await upstream.arrayBuffer()
    forwarded = new Response(bytes, { status: upstream.status, headers: upstream.headers })
  }

  // The renderer's half: it received a Response and abandoned it.
  void forwarded

  setTimeout(() => {
    console.log(`SURVIVED policy=${policy}`)
    server.close()
    process.exit(0)
  }, 400)
}

function runOnce(type, policy) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, '--child', type, policy], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve({ survived: stdout.includes('SURVIVED'), crashed: stderr.includes('assert(!this.paused)') })
    })
  })
}

async function measure(type, policy) {
  const results = []
  for (let run = 0; run < RUNS; run += 1) results.push(await runOnce(type, policy))
  return {
    crashes: results.filter((r) => r.crashed).length,
    survived: results.filter((r) => r.survived).length,
  }
}

const count = (n) => `${String(n)}/${String(RUNS)}`

console.log(`node ${process.version}  undici ${process.versions.undici ?? '?'}  body ${String(SIZE / 1024)}KiB  runs ${String(RUNS)}\n`)

console.log('PART 1 - the crash does not depend on the content type (policy: passthrough)')
const sweep = []
let anyTypeCrash = false
for (const type of TYPES) {
  const r = await measure(type, 'passthrough')
  if (r.crashes > 0) anyTypeCrash = true
  sweep.push({ type: type.length > 46 ? `${type.slice(0, 43)}...` : type, crashes: count(r.crashes) })
}
console.table(sweep)

console.log('\nPART 2 - what fixes it, measured on a NON-JSON body the allow-list would skip')
const policies = ['passthrough', 'discard', 'buffered', 'cancel-forwarded', 'owned-stream']
const rows = []
for (const policy of policies) {
  const r = await measure('application/octet-stream', policy)
  rows.push({ policy, crashes: count(r.crashes), survived: count(r.survived) })
}
console.table(rows)

const control = rows[0].crashes
const fixes = rows.slice(1).every((row) => row.crashes === count(0))

if (control === count(0)) {
  console.error('\nthe passthrough control did not crash, so this run proves nothing')
  process.exit(1)
}
if (!anyTypeCrash) {
  console.error('\nno content type crashed, which contradicts the sweep this fix is sized against')
  process.exit(1)
}
if (!fixes) {
  console.error('\na proposed policy still crashed')
  process.exit(1)
}

console.log('\nOK: the crash is content-type independent, and draining or cancelling the body prevents it.')
