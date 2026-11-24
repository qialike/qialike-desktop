/**
 * The end-to-end chain: one command, one verdict, against the shipped artifact.
 *
 * WHY THIS EXISTS WHEN THE PROBES ALREADY DO. Each probe answers one question and
 * prints what it found — that is what makes them good instruments, and it is also why
 * none of them is a release gate. A person has to run five of them, read five outputs,
 * and decide. That review is exactly where a regression survives, because "ran the
 * probe, looked plausible" is not a judgement anyone can make reliably at the end of a
 * long session.
 *
 * So this runs the same measurements as assertions, in the order a user meets them,
 * against the **packaged** artifact rather than the development tree — because the
 * defects this project has actually shipped were packaging defects: a boot chain with
 * one link missing, a shell importing a package only the runtime tree carries,
 * `extraResources` silently dropping `node_modules`, and hand-written files arriving at
 * mode 0600 so that a `dpkg` install made them unreadable. None of those is visible in
 * a checkout, and all of them are visible here.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not measure appearance, and it does not
 * assert anything a human has to judge. Every check below is arithmetic or a structural
 * fact, so a red result is a defect and a green one is not an opinion. The screenshot
 * probes remain the instrument for the parts that need eyes.
 *
 * IT REPORTS EVERY CHECK, NOT THE FIRST FAILURE. A run that stops at the first problem
 * makes the next one invisible and costs another launch cycle to find. Each check
 * therefore records pass/fail and continues where it can, and the exit code is the
 * verdict: 0 only when all of them passed.
 *
 * Usage: `node apps/desktop-bin/e2e.mjs <appBinary|AppImage> [--keep]`
 *
 * @module qialike-desktop/e2e
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, removeDir, sleep, stopApp } from './lib/app-launch.mjs'
import { startPrivateDisplay } from './lib/private-display.mjs'

const { contrastRatio } = await import(new URL('../../packages/qialike-desktop-theme/lib/tokens.js', import.meta.url))
const { SCHEME_PALETTES } = await import(new URL('../../packages/qialike-desktop-theme/lib/palettes.js', import.meta.url))

const app = process.argv[2]
const keep = process.argv.includes('--keep')
if (app === undefined) {
  console.error('usage: e2e.mjs <appBinary|AppImage> [--keep]')
  process.exit(2)
}
const outDir = join(process.env.HOME ?? '/tmp', 'qialike', 'screens', 'e2e')

/** Every check's outcome, in the order they ran. */
const results = []
/**
 * Record one check.
 *
 * @param name - what was checked, phrased so a bare `FAIL` line is actionable.
 * @param passed - the verdict.
 * @param detail - the measurement behind it, which is what makes a failure diagnosable
 *   without re-running.
 */
const check = (name, passed, detail) => {
  results.push({ name, passed: Boolean(passed), detail })
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `\n          ${detail}`}`)
  return Boolean(passed)
}

/**
 * A free loopback port.
 *
 * The probes learned this the hard way: a hardcoded debugging port held by a leaked
 * instance makes the *next* run connect to the old window and report its state as
 * fact. A port the OS hands out cannot be held.
 */
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    server.close(() => { resolve(port) })
  })
})

mkdirSync(outDir, { recursive: true })
const port = await freePort()
const userData = mkdtempSync(join(tmpdir(), 'qialike-e2e-'))
const home = mkdtempSync(join(tmpdir(), 'qialike-e2e-home-'))
const probeTmp = mkdtempSync(join(tmpdir(), 'qialike-e2e-tmp-'))

// Its own display, so the application renders where nobody is looking. This used to inherit DISPLAY, which
// meant every end-to-end run opened a real window on whoever ran it — and a run that left a modal dialog
// open was indistinguishable from the application failing to start.
const display = startPrivateDisplay({ log: (line) => { process.stdout.write(`  ${line}\n`) } })

let launched
let stopped = false
let exitCode = 1

try {
  // ── 1. It launches, and nothing was listening on that port before ──────────────
  launched = launchApp({
    binary: app,
    args: [
      ...(app.endsWith('.AppImage') ? ['--appimage-extract-and-run'] : []),
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${userData}`,
      '--no-sandbox', '--disable-gpu',
      '--window-size=1440,900',
    ],
    env: {
      DSH_HOME: home,
      QIALIKE_DESKTOP_USER_DATA_DIR: userData,
      TMPDIR: probeTmp,
      ...(display.display === undefined ? {} : { DISPLAY: display.display }),
    },
  })

  const page = await (async () => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
        const found = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (found !== undefined) return found
      } catch { /* not up yet */ }
      await sleep(1000)
    }
    return undefined
  })()

  if (page === undefined) {
    check('the packaged application opens a window', false, launched.log().slice(-1200))
  } else {
    check('the packaged application opens a window', true, `debugger target at ${String(port)}`)

    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let nextId = 0
    const pending = new Map()
    /**
     * Everything the page said, as it said it.
     *
     * WHY THE CONSOLE IS CAPTURED RATHER THAN ONLY ASSERTED AGAINST. The client reports
     * its own transport failures here and nowhere else — the shell never sees them, and
     * a reconnect loop is otherwise indistinguishable from a slow start. Without this,
     * a failing check can only say "still reconnecting", which is the symptom and not
     * the cause.
     */
    const console_ = []
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params?.args ?? [])
          .map((arg) => (arg.value === undefined ? (arg.description ?? arg.type) : String(arg.value)))
          .join(' ')
        console_.push({ level: message.params?.type, text })
      }
      if (message.method === 'Log.entryAdded') {
        console_.push({ level: message.params?.entry?.level, text: String(message.params?.entry?.text ?? '') })
      }
      if (message.method === 'Runtime.exceptionThrown') {
        console_.push({ level: 'exception', text: String(message.params?.exceptionDetails?.text ?? '') })
      }
    }
    const send = (method, params) => {
      const id = ++nextId
      return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
    }
    await send('Runtime.enable', {})
    await send('Log.enable', {})
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      const thrown = result.result?.exceptionDetails
      if (thrown !== undefined) throw new Error(thrown.exception?.description ?? 'evaluate threw')
      return result.result?.result?.value
    }
    const shoot = async (name) => {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const data = shot.result?.data
      if (data === undefined) return undefined
      const file = join(outDir, `${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      return file
    }
    const clickAt = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(900)
    }
    /**
     * The centre of the smallest clickable thing whose text is exactly `text`.
     *
     * SMALLEST, BUT PREFER THE CONTROL. Taking the smallest match alone was silently wrong once
     * the settings entry gained an inner span: the span is 28x22 and sits inside a button, so
     * the point landed on the span — which is not the click target the panel listens on — and
     * the panel never opened. Measured: the span at (56, 762) was chosen over the button around
     * it, and clicking there did nothing.
     *
     * A real interactable wins ties against a plain element, and the smallest still wins within
     * each kind, so an icon inside a button is not preferred over the button itself.
     *
     * @param text - the exact `textContent` a control is labelled with.
     * @returns its centre, or null when nothing matches.
     */
    const centreOf = (text) => evaluate(`(() => {
      const INTERACTIVE = new Set(['BUTTON', 'A', 'LI', 'INPUT'])
      const hits = [...document.querySelectorAll('button,[role="button"],a,li,div,span')]
        .filter((el) => (el.textContent || '').trim() === ${JSON.stringify(text)})
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter((c) => c.r.width > 0 && c.r.height > 0)
        .sort((a, b) => {
          const ai = INTERACTIVE.has(a.el.tagName) || a.el.getAttribute('role') === 'button' ? 0 : 1
          const bi = INTERACTIVE.has(b.el.tagName) || b.el.getAttribute('role') === 'button' ? 0 : 1
          if (ai !== bi) return ai - bi
          return a.r.width * a.r.height - b.r.width * b.r.height
        })
      if (hits.length === 0) return null
      const r = hits[0].r
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)

    // ── 2. The client booted, which is the link the first packaging run lost ──────
    //
    // THE GATE IS OURS, THE ROWS ARE THE HARNESS'S. This shell injects one line — the
    // `__DSH_BOOT_READY__` deferred — and the harness's own browser entry does the rest:
    // it finds the bridge named `dshDesktopBoot`, fetches the boot rows over IPC, applies
    // them through `applyIndexInjections`, sets `__DSH_TRANSPORT__` and resolves the gate.
    //
    // The readiness wait is on the GATE SETTLING, which is the actual contract, rather than
    // on a property of the bridge. The previous version waited on `bridge.pending`, which
    // has never existed on either side — so `!undefined` was `true` and the wait was a
    // no-op that always reported ready. It is asserted here because a boot that never
    // settles shows the loading page forever with nothing logged.
    const BRIDGE = 'dshDesktopBoot'
    const gateSettled = async () => evaluate(`(async () => {
      const gate = globalThis.__DSH_BOOT_READY__
      if (gate === undefined || typeof gate.promise?.then !== 'function') return 'missing'
      return await Promise.race([
        gate.promise.then(() => 'fulfilled', (error) => 'rejected: ' + String(error?.message ?? error)),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 2000)),
      ])
    })()`)
    let gateOutcome = 'missing'
    for (let attempt = 0; attempt < 120; attempt += 1) {
      gateOutcome = await gateSettled()
      if (gateOutcome !== 'pending' && gateOutcome !== 'missing') break
      await sleep(1000)
    }
    // The bridge must be present before the gate can settle: it is what the entry calls.
    const hasBridge = await evaluate(`globalThis.${BRIDGE} !== undefined`)
    check(
      'the preload exposed the boot bridge under the name the harness’s entry looks for',
      hasBridge === true,
      `globalThis.${BRIDGE} is ${hasBridge ? 'present' : 'MISSING'}`,
    )
    await sleep(2500)

    const boot = await evaluate(`(() => {
      const loader = globalThis.__ModuleLoader__
      return {
        // The gate's presence proves the injected line ran, rather than merely being
        // present in the head as text.
        hasGate: typeof globalThis.__DSH_BOOT_READY__?.promise?.then === 'function',
        // Whatever the module loader calls its collecting state: the entry only hands over
        // to it after the rows are applied, so anything else means the rows landed.
        loaderMode: loader === undefined ? null : (loader.mode ?? 'live'),
        stuckOnLoading: /Loading plugins/i.test(document.body.innerText || ''),
        renderedElements: document.querySelectorAll('*').length,
        bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 70),
      }
    })()`)
    check(
      'the boot gate settled and the client mounted',
      gateOutcome === 'fulfilled' && boot.hasGate && !boot.stuckOnLoading && boot.renderedElements > 300,
      `gate=${gateOutcome} loader.mode=${String(boot.loaderMode)}`
        + ` elements=${String(boot.renderedElements)} text="${boot.bodyText}"`,
    )
    await shoot('01-booted')

    // ── 2b. Our own client bundles reached the page ───────────────────────────────
    //
    // The brand plugin's wordmark is the cheapest proof that a bundle of ours loaded:
    // it renders an `<svg>` into a sidebar seat that the harness leaves empty, so its
    // presence cannot come from upstream.
    const brand = await evaluate(`(() => {
      const svgs = [...document.querySelectorAll('svg')]
      const named = svgs.filter((el) => /qialike|wordmark/i.test(el.getAttribute('class') || el.id || ''))
      // HOW MANY CLIENT BUNDLES LOADED IS NOT MEASURABLE FROM THE PAGE, and recording that
      // here is cheaper than someone rediscovering it. The resource-timing list is EMPTY
      // in this document — Chromium does not record resource timing for responses that
      // came through a custom scheme handler, which is every request this shell serves.
      // Two attempts to count bundles that way returned zero on a page with sixty-odd
      // loaded. The count in the boot graph is asserted where it can be:
      // tests/provider-catalogue.test.mjs reads the served document and counts the qialike
      // client ids in it, and the boot check above fails if the client did not mount.
      //
      // NO BACKTICKS IN A COMMENT INSIDE THIS TEMPLATE LITERAL. Four separate times now, a
      // quoted identifier here has closed the string mid-expression and turned a comment
      // into a syntax error reported at a line far below. tests/script-syntax.test.mjs
      // catches it before the script runs, which is the only reason it is a moment's
      // annoyance rather than a wasted launch.
      return {
        svgCount: svgs.length,
        // The wordmark is a filled path with a viewBox, not an icon set glyph.
        viewBoxes: svgs.slice(0, 6).map((el) => el.getAttribute('viewBox')).filter(Boolean),
        namedCount: named.length,
      }
    })()`)
    check(
      'a client bundle of ours rendered into the page',
      brand.svgCount > 0 && brand.viewBoxes.length > 0,
      `svg elements=${String(brand.svgCount)} viewBoxes=${JSON.stringify(brand.viewBoxes)}`,
    )

    // ── 3. The window says the product's name, not the fallback ──────────────────
    //
    // The defect this guards is specific and shipped once: `AppFrame` used a
    // build-time constant that could not be recomputed, so the fallback won and the
    // window title read "DSH Local Build" in every build.
    const titled = await evaluate(`({ documentTitle: document.title })`)
    check(
      'the window is titled with the product name',
      titled.documentTitle === 'Qialike',
      `document.title = ${JSON.stringify(titled.documentTitle)}`,
    )

    // ── 4. The preload exposed the desktop carrier, and only the safe half ───────
    //
    // THE LAST ASSERTION IS THE DECISIVE ONE. `dshDesktop` switches a whole branch in
    // upstream's client — providing it activates the desktop surfaces, withholding it
    // silently selects the browser ones — so its presence is checked rather than
    // assumed. But the half worth asserting is the *shape of what the updater returns*:
    // the renderer may learn the phase and a version, and must not be able to learn a
    // feed URL, an artifact path or a list of installable versions, because a renderer
    // that can read those can be talked into installing something.
    const carrier = await evaluate(`(async () => {
      const d = globalThis.dshDesktop
      if (d === undefined) return { present: false }
      const updates = d.updates
      const keys = updates === undefined ? [] : Object.keys(updates).sort()
      let stateKeys = null
      let threw = null
      try {
        const state = await updates.status()
        stateKeys = state === null || typeof state !== 'object' ? null : Object.keys(state).sort()
      } catch (error) { threw = String(error === null || error === undefined ? error : (error.message ?? error)) }
      return { present: true, protocolVersion: d.protocolVersion, keys, stateKeys, threw }
    })()`)
    /** The keys the renderer may see, taken from the update contract. */
    const SAFE_STATE_KEYS = ['failure', 'percent', 'phase', 'version']
    check(
      'the preload exposed the desktop carrier the client branches on',
      carrier.present === true && carrier.protocolVersion === 1,
      JSON.stringify({ present: carrier.present, protocolVersion: carrier.protocolVersion }),
    )
    // The list is exact rather than a subset: an extra verb is a reach the renderer did not have before, so
    // adding one has to be a deliberate edit here. `check` and `download` are this product's, for the manual
    // row in Settings — upstream calls only `status`, `open` and `subscribe`. Neither takes an argument and
    // neither returns anything, so the assertion below on what `status()` may expose is unaffected: these
    // two let the renderer ACT, not LEARN.
    check(
      'the updater exposes the three upstream verbs plus this product\u2019s two',
      JSON.stringify(carrier.keys) === JSON.stringify(['check', 'download', 'open', 'status', 'subscribe']),
      `updates keys = ${JSON.stringify(carrier.keys)}`,
    )
    check(
      'the updater’s state carries no feed URL, artifact path or version list',
      carrier.threw === null
        && Array.isArray(carrier.stateKeys)
        && carrier.stateKeys.every((key) => SAFE_STATE_KEYS.includes(key)),
      carrier.threw === null
        ? `state keys = ${JSON.stringify(carrier.stateKeys)} (allowed: ${JSON.stringify(SAFE_STATE_KEYS)})`
        : `status() threw: ${carrier.threw}`,
    )

    /**
     * Whether the settings panel is up.
     *
     * IT CANNOT BE DETECTED BY OUR SELECT ANY MORE, and that is the change 0.4.6 made. The
     * colour-scheme select used to live in General, which the panel opens on — so its presence
     * was a reliable signal. It now lives in the Appearance section, and a section without tabs
     * is rendered only while it is the selected one, so the select does not exist until someone
     * navigates there. Measured on the packaged build: the panel was plainly up, with its nav
     * column showing General and Appearance, while this predicate returned false — which failed
     * "the settings page opens" and took three later checks with it.
     *
     * The nav entry is the honest signal now: the settings shell draws one row per
     * `settings.section` registration, and `通用设置` / `General` is its first. Both languages,
     * for the reason {@link SETTINGS_LABELS} records.
     */
    // ONLY SECTION NAMES. `Settings`/`设置` are the sidebar ENTRY, which is on screen whether or
    // not the panel is — including them made this predicate true before anything was opened, so
    // `openSettings()` returned immediately and every later check ran against a closed panel.
    const SECTION_LABELS = ['通用设置', 'General']
    const settingsOpen = () => evaluate(`(() => {
      const rows = [...document.querySelectorAll('button,[role="button"],a,li')]
        .map((el) => (el.textContent || '').trim())
      return rows.some((text) => ${JSON.stringify(SECTION_LABELS)}.includes(text))
    })()`)

    /**
     * The labels the settings entry answers to.
     *
     * BOTH LANGUAGES, for the same reason the welcome overlay above tries both: this
     * application follows the host's locale, so on a Chinese-locale machine — the one
     * this was first run on — the entry reads 设置 and an English-only lookup finds
     * nothing. That is a test defect, not a product one: the application is correct in
     * either language, and the checks that follow are written against the surface
     * rather than against its translation.
     */
    const SETTINGS_LABELS = ['Settings', '设置']

    /** Open the settings panel and wait for it to settle. */
    const openSettings = async () => {
      if (await settingsOpen()) return true
      for (const label of SETTINGS_LABELS) {
        const point = await centreOf(label)
        if (point === null) continue
        await clickAt(point.x, point.y)
        // POLLED, NOT FIXED. The panel mounts six sections and their rows, which is slower than
        // the 600 ms this used to wait — and a check that reads the page sooner than it settles
        // fails for a timing reason while looking like a product defect.
        for (let attempt = 0; attempt < 16; attempt += 1) {
          await sleep(250)
          if (await settingsOpen()) return true
        }
      }
      return false
    }

    // ── 5. The Host answers through the shell, which is the whole architecture ───
    //
    // THE STRONGEST END-TO-END CHECK IN THE FILE, and it replaces a weak one that only
    // counted `performance` entries. A request from the renderer goes through the
    // shell's protocol handler, its Host proxy and the connection's authentication, and
    // ends in a route that reads `qialike.json` off disk — so one `fetch` here exercises
    // the document origin, the proxy, the credential and the settings API together. A
    // count of loaded resources would have proved none of that, and a packaging defect
    // that broke only the proxy would have passed it.
    //
    // POLLED, NOT ASKED ONCE, and the reason is measured rather than defensive. The shell sets
    // `hostOrigin` as soon as the Host reports its port, which is before that port accepts
    // connections; between those two moments the proxy answers 502 "the desktop Host is
    // unreachable: fetch failed". Measured on this packaged build, from first paint: 503 at 0.5 s
    // (origin not set), 200 at 1.6 s. A single fetch that lands in the gap fails for a reason that
    // has nothing to do with the architecture this check exists to prove — the same "POLLED, NOT
    // FIXED" rule `openSettings` above already follows.
    //
    // The failure body is reported, because "status=502" alone cost an hour of bisecting when this
    // first appeared: the JSON says whether the origin was missing (503), the Host refused (502) or
    // the route itself errored (500).
    let api
    for (let attempt = 0; attempt < 24; attempt += 1) {
      api = await evaluate(`fetch('api/qialike/providers')
        .then(async (response) => ({ status: response.status, body: await response.json() }))
        .catch((error) => ({ failed: String(error === null || error === undefined ? error : (error.message ?? error)) }))`)
      if (api.status === 200) break
      await sleep(250)
    }
    const routeCount = Array.isArray(api.body?.routes) ? api.body.routes.length : null
    check(
      'the renderer reaches the Host through the shell’s proxy, and the settings API answers',
      api.status === 200 && api.body?.ok !== false && routeCount !== null && routeCount >= 60,
      api.failed !== undefined
        ? `fetch failed: ${api.failed}`
        : `status=${String(api.status)} routes=${String(routeCount)} body=${JSON.stringify(api.body).slice(0, 220)}`,
    )

    // ── 5b. The first-run overlay is up, and can be dismissed ────────────────────
    //
    // CHECKED RATHER THAN WORKED AROUND, because the first version of this chain did
    // not dismiss it at all and four later checks failed for that one reason: the
    // overlay is a modal with a scrim, so it swallowed the click meant for Settings and
    // every hover meant for a tooltip, and the chain reported four product defects that
    // were one test defect. Dismissing it is therefore a step with its own verdict.
    const welcome = await (async () => {
      for (const label of ['Skip for now', '暂时跳过']) {
        const point = await centreOf(label)
        if (point !== null) {
          await clickAt(point.x, point.y)
          return label
        }
      }
      return undefined
    })()
    const overlayGone = await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      return { stillUp: dialog !== null, text: (dialog?.textContent ?? '').slice(0, 40) }
    })()`)
    check(
      'the first-run overlay appears on a fresh profile and dismisses',
      welcome !== undefined && overlayGone.stillUp === false,
      welcome === undefined
        ? `no dismiss control found; a modal is still up: ${String(overlayGone.stillUp)} "${overlayGone.text}"`
        : `dismissed via "${welcome}"; modal still up = ${String(overlayGone.stillUp)}`,
    )

    /**
     * Open the Appearance section, where the colour-scheme picker lives since 0.4.6.
     *
     * THE PICKER MOVED, and every check about it has to follow. It used to be a row in General,
     * which the panel opens on; it is now a row in the Appearance section, and a section without
     * tabs renders only while it is selected. Navigating first is what a person does, and it is
     * also the only state in which the select exists.
     *
     * @returns whether the section could be reached.
     */
    const APPEARANCE_LABELS = ['外观', 'Appearance']
    const openAppearance = async () => {
      if (await settingsOpen() !== true) return false
      for (const label of APPEARANCE_LABELS) {
        const point = await centreOf(label)
        if (point === null) continue
        await clickAt(point.x, point.y)
        await sleep(800)
        const reached = await evaluate(`[...document.querySelectorAll('select')]
          .some((el) => [...el.options].some((o) => (o.value || '').startsWith('qialike-')))`)
        if (reached) return true
      }
      return false
    }

    // ── 6. Our own settings row mounted, which is what the client bundle is for ──
    if (!(await openSettings()) || !(await openAppearance())) {
      check('the settings page opens', false, `no element whose text is exactly one of ${SETTINGS_LABELS.map((l) => `"${l}"`).join(' or ')}`)
    } else {
      const row = await evaluate(`(() => {
        const select = [...document.querySelectorAll('select')]
          .find((el) => [...el.options].some((o) => (o.value || '').startsWith('qialike-')))
        const panel = document.querySelector('[role="dialog"]')
        if (select === undefined) {
          return { present: false, panelText: (panel?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 120) }
        }
        const schemes = [...select.options].filter((o) => (o.value || '').startsWith('qialike-')).length
        const style = getComputedStyle(select)
        return { present: true, schemes, appearance: style.appearance, background: style.backgroundColor }
      })()`)
      check(
        'our theme row mounted with the CLI’s schemes',
        row.present === true && row.schemes >= 15,
        row.present === true ? `${String(row.schemes)} schemes` : `settings panel says: "${String(row.panelText)}"`,
      )
      // The picker is painted by the design system's field, not by the user agent.
      // `appearance: none` is the observable difference between the two, and the defect
      // it guards was measured in a real window: a native widget byte-identical in the
      // dark theme and in dracula.
      check(
        'the theme picker is themed rather than a native widget',
        row.present === true && row.appearance === 'none',
        `computed appearance = ${String(row.appearance)}, background = ${String(row.background)}`,
      )
      await shoot('02-settings')

      // ── 6b. Switching language reaches our own rows ────────────────────────────
      //
      // THE HALF OF i18n NO UNIT TEST CAN SEE. `tests/plugin-i18n.test.mjs` proves the
      // dictionaries are complete, symmetric and reachable from the bundle; it cannot
      // prove that the harness's Language row rebinds OUR rows when it changes, which is
      // the claim a user actually experiences. The failure it guards is specific: a
      // dictionary registered under a namespace no slot declares is never read, so every
      // string in the row renders as its own key while both halves look right alone.
      //
      // The measurement is a before/after on a sentence only our dictionary contains, in
      // both languages, so it fails if the dictionary is missing, misnamed, or simply not
      // re-read on change.
      const OUR_EN = 'Colour schemes are shared with the qialike CLI'
      const OUR_ZH = '配色方案与 qialike 命令行共享'
      // BACK TO GENERAL FIRST. The Language row lives there, and the answer this check reads is
      // our colour-scheme copy — which is in Appearance, where the checks above navigated to.
      // Both sections have to be visited, so this returns to General rather than assuming the
      // panel is where it was left. Declared before its users: an arrow called earlier than its
      // `const` definition throws on the temporal dead zone, which fails the check for a reason
      // that has nothing to do with the product.
      const backToGeneral = async () => {
        for (const label of ['通用设置', 'General']) {
          const point = await centreOf(label)
          if (point === null) continue
          await clickAt(point.x, point.y)
          await sleep(600)
          return true
        }
        return false
      }

      /**
       * Which language our own rows are rendering in.
       *
       * READ FROM APPEARANCE, because that is where the colour-scheme copy lives now. The nav
       * labels are also ours, but they are short enough to collide with other text; the
       * scheme description is a full sentence only this dictionary contains, which is why the
       * check has always used it.
       */
      const languageState = async () => {
        await openAppearance()
        return evaluate(`(() => {
          const text = document.body.innerText || ''
          return { en: text.includes(${JSON.stringify(OUR_EN)}), zh: text.includes(${JSON.stringify(OUR_ZH)}) }
        })()`)
      }
      // The harness's Language row is a pill that opens a menu rather than a native
      // select, so it is driven by clicking the active locale's label and then the label
      // of the locale to switch to. Both labels are their own language's word for itself,
      // so they need no translation of their own.
      const pickLanguage = async (label) => {
        // THE PILL IS IN GENERAL, so this has to start there: `languageState` leaves the panel
        // on Appearance to read our colour-scheme copy, and clicking at coordinates that belong
        // to another section is how this check silently stopped switching anything.
        await backToGeneral()
        for (const current of ['English', '中文']) {
          const pill = await centreOf(current)
          if (pill !== null) { await clickAt(pill.x, pill.y); break }
        }
        const item = await centreOf(label)
        if (item !== null) await clickAt(item.x, item.y)
        await sleep(1200)
        return item !== null
      }
      // NORMALISE TO ENGLISH FIRST, THEN MAKE BOTH TRANSITIONS REAL ONES.
      //
      // The fragility this removes: the Language row is a pill that opens a menu, and
      // `pickLanguage` drives it by clicking the pill and then clicking the label of the
      // locale wanted. When the locale wanted is the one already shown, those two clicks
      // land on the same element — so the menu opens and is immediately toggled shut, and
      // when the second click lands on the settings trigger instead the whole panel closes.
      // The check then read an absent row and reported a product defect that was not one:
      // measured as 3 consecutive runs failing from a Chinese start (where the first step
      // was a no-op) and 20/20 passing when the same build started in English.
      //
      // Which locale the interface opens in is the HOST's, not this application's: it
      // follows the machine. Normalising first makes the starting locale irrelevant, gives
      // both directions a real transition to observe, and leaves the interface in English
      // for the checks that follow, whose expectations are written in it.
      await backToGeneral()

      const beforeLanguage = await languageState()
      if (beforeLanguage.zh === true) await pickLanguage('English')
      const englishFirst = await languageState()
      const switchedToZh = await pickLanguage('中文')
      const afterChinese = await languageState()
      const switchedBack = await pickLanguage('English')
      const afterEnglish = await languageState()
      check(
        'switching the interface language rebinds our own rows',
        switchedToZh && switchedBack
          && englishFirst.en === true && englishFirst.zh === false
          && afterChinese.zh === true && afterChinese.en === false
          && afterEnglish.en === true && afterEnglish.zh === false,
        `started ${JSON.stringify(beforeLanguage)} -> en:${JSON.stringify(englishFirst)}`
          + ` -> zh:${JSON.stringify(afterChinese)} -> en:${JSON.stringify(afterEnglish)}`,
      )
    }

    // ── 6. A colour scheme reaches CSS variables, which is the theme's whole job ──
    const applied = await evaluate(`(() => {
      const select = [...document.querySelectorAll('select')]
        .find((el) => [...el.options].some((o) => (o.value || '').startsWith('qialike-')))
      if (select === undefined) return null
      select.value = 'qialike-dracula'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return select.value
    })()`)
    await sleep(1200)
    const themeReadback = await evaluate(`(() => {
      const body = getComputedStyle(document.body)
      return {
        bgBase: body.getPropertyValue('--dsw-alias-bg-base').trim(),
        brand: body.getPropertyValue('--dsw-alias-brand-primary').trim(),
        computedBg: body.backgroundColor,
        dark: document.body.hasAttribute('data-ds-dark-theme'),
      }
    })()`)
    const dracula = SCHEME_PALETTES.dracula
    check(
      'a chosen scheme reaches the document’s CSS variables',
      applied !== null && themeReadback.bgBase === dracula.bg && themeReadback.dark === true,
      `--dsw-alias-bg-base=${themeReadback.bgBase} (palette ${dracula.bg}), body[data-ds-dark-theme]=${String(themeReadback.dark)}`,
    )
    await shoot('03-dracula')

    // ── 7. The tooltip pair is legible, measured from the rendered colours ───────
    //
    // This is the check the whole file was worth writing for: the defect it guards
    // existed only behind a hover, in two of sixteen schemes, and no screenshot,
    // static scan or unit test could see it.
    const lightPick = await evaluate(`(() => {
      const select = [...document.querySelectorAll('select')]
        .find((el) => [...el.options].some((o) => (o.value || '').startsWith('qialike-')))
      if (select === undefined) return null
      select.value = 'qialike-light'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return select.value
    })()`)
    await sleep(1200)

    /** Dismiss the settings mask: it covers every tooltip anchor in the window. */
    const closeSettings = async () => {
      const open = await evaluate(`[...document.querySelectorAll('select')]
        .some((el) => [...el.options].some((o) => (o.value || '').startsWith('qialike-')))`)
      if (!open) return
      const viewport = await evaluate(`({ w: innerWidth, h: innerHeight })`)
      await clickAt(viewport.w - 40, Math.round(viewport.h / 2))
    }
    await closeSettings()

    /** Hover a point, after moving away so a fresh `pointerover` is guaranteed. */
    const hover = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
      await sleep(120)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await sleep(900)
    }
    /**
     * Hover each interactive element until one of them opens a tooltip.
     *
     * A SEARCH, NOT A SELECTOR, and the reason is a mistake worth not repeating: the
     * obvious anchor is the element whose text is "New Session", and hovering it opens
     * a *hover card* — a different component, with different colours, which the first
     * version of the legibility probe then reported as the tooltip. Nothing in the DOM
     * distinguishes them from outside: `Tooltip` sets `role="tooltip"` only while
     * shown, and its anchor carries no `aria-describedby`. So the candidates are
     * enumerated, each is hovered, and the first that mounts a bubble is the one
     * measured. Deterministic order, so a failure names the same control every run.
     */
    const findTooltip = async () => {
      const candidates = await evaluate(`(() => {
        const out = []
        for (const el of document.querySelectorAll('button,[role="button"],a,[tabindex]')) {
          const r = el.getBoundingClientRect()
          if (r.width < 8 || r.height < 8) continue
          if (r.x < 1 || r.y < 1 || r.x + r.width > innerWidth - 1 || r.y + r.height > innerHeight - 1) continue
          out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                     label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) })
        }
        return out
      })()`)
      for (const candidate of candidates) {
        await hover(candidate)
        if (await evaluate(`document.querySelector('[role="tooltip"]') !== null`)) {
          return {
            candidate,
            bubble: await evaluate(`(() => {
              const el = document.querySelector('[role="tooltip"]')
              const own = getComputedStyle(el)
              const label = el.querySelector('span') ?? el
              return { bg: own.backgroundColor, color: getComputedStyle(label).color,
                       text: (el.textContent || '').trim().slice(0, 40) }
            })()`),
          }
        }
      }
      return null
    }

    const found = await findTooltip()
    if (found === null) {
      check('a tooltip opens on hover', false, 'no [role="tooltip"] appeared for any interactive element')
    } else {
      const hex = (value) => {
        const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(value)
        return match === null ? undefined : `#${[1, 2, 3].map((i) => Number(match[i]).toString(16).padStart(2, '0')).join('')}`
      }
      const ratio = contrastRatio(hex(found.bubble.color), hex(found.bubble.bg))
      check(
        'the tooltip’s text is legible against its own surface',
        ratio >= 4.5,
        `on "${found.candidate.label}": "${found.bubble.text}" ${found.bubble.color} on`
          + ` ${found.bubble.bg} = ${ratio.toFixed(2)}:1`,
      )
      await shoot('04-tooltip')
    }

    // ── 8. The shell logged no client failure ────────────────────────────────────
    //
    // The gate's own settlement is asserted at boot (check 2) and deliberately NOT repeated
    // here: it cannot change once it settles, and reading the same value twice is coverage
    // in appearance only. What this adds is the other failure channel — the shell's log —
    // which the page cannot see. A rejected gate calls the bridge's `failed()`, which sends
    // an IPC message written by the main process, and a page-side check would miss a failure
    // that happened before the page could observe anything.
    const log = launched.log()
    check(
      'the shell logged no client start failure',
      !/boot-failed|client start failure|the shell bridge is missing/u.test(log),
      log.trim() === '' ? '(the application logged nothing)' : `${String(log.split('\n').length)} log lines, none matching`,
    )
    // ── 9. The client's own connection settles, because a chat window is useless
    //       without it ────────────────────────────────────────────────────────────
    //
    // WHY THIS IS SEPARATE FROM THE HTTP CHECK. The settings API above travels over
    // `fetch`, through the shell's protocol handler and its Host proxy. The client's
    // live connection is a **WebSocket**, and it does not go through that proxy: the
    // shell has to attach the Host's credential to the handshake itself
    // (`onBeforeSendHeaders` in `main.ts`), which is the one request the proxy never
    // sees. So a build could pass every HTTP check in this file and still open a window
    // that never connects — the client's own indicator says "Reconnecting" and nothing
    // else in this chain would notice.
    const connectDeadline = Date.now() + 45_000
    let connection = { settled: false, text: '' }
    for (;;) {
      connection = await evaluate(`(() => {
        const text = (document.body.innerText || '')
        const line = text.split('\\n').map((s) => s.trim()).find((s) => /reconnect|connecting|offline/i.test(s))
        return { settled: line === undefined, text: line ?? '' }
      })()`)
      if (connection.settled || Date.now() > connectDeadline) break
      await sleep(2000)
    }
    check(
      'the client’s own connection settles rather than retrying forever',
      connection.settled === true,
      connection.settled ? 'no reconnect indicator in the document' : `still showing "${connection.text}" after 45s`,
    )
    if (connection.settled !== true) {
      // The diagnosis, not just the symptom. A direct handshake to the same URL the
      // carrier dials separates "the Host refuses this socket" from "the carrier never
      // dials", and the close code names the reason when it refuses. The shell rewrites
      // this handshake's origin and attaches the Host's credential (see
      // `websocketHandshakeHeaders`), so an unrewritten direct attempt is *expected* to
      // fail in a specific way — which is why the code and reason are reported rather
      // than turned into a verdict.
      const direct = await evaluate(`(async () => {
        const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl
        if (base === undefined) return { skipped: 'no transport base' }
        const url = new URL('api/remote.mux', base)
        url.protocol = 'ws:'
        return await new Promise((resolve) => {
          let socket
          try { socket = new WebSocket(url.href) } catch (error) {
            resolve({ url: url.href, threw: String(error === null || error === undefined ? error : (error.message ?? error)) })
            return
          }
          const done = (outcome) => resolve({ url: url.href, ...outcome })
          const timer = setTimeout(() => { try { socket.close() } catch (ignored) {} ; done({ outcome: 'timeout' }) }, 8000)
          socket.onopen = () => { clearTimeout(timer); done({ outcome: 'open' }) }
          socket.onerror = () => { /* a close always follows */ }
          socket.onclose = (event) => { clearTimeout(timer); done({ outcome: 'closed', code: event.code, reason: event.reason }) }
        })
      })()`)
      console.log(`          diagnosis: direct handshake -> ${JSON.stringify(direct)}`)
      const transportEntries = console_.filter((entry) => /connection|socket|stream|mux|transport/i.test(entry.text))
      console.log(`          diagnosis: ${String(console_.length)} console entries,`
        + ` ${String(transportEntries.length)} mentioning the transport`)
      for (const entry of transportEntries.slice(-12)) console.log(`            [${String(entry.level)}] ${entry.text.slice(0, 160)}`)
      if (transportEntries.length === 0) {
        for (const entry of console_.slice(-12)) console.log(`            [${String(entry.level)}] ${entry.text.slice(0, 160)}`)
      }
    }

    // ── 10. The transport global is set, which the connection check above rests on
    //       ────────────────────────────────────────────────────────────────────────
    //
    // WHY THIS IS SEPARATE FROM THE CONNECTION CHECK RATHER THAN A COMMENT ON IT. The
    // carrier resolves its WebSocket against `__DSH_TRANSPORT__.streamBaseUrl` and
    // falls back to `document.baseURI` — which for this document is the `qialike-app:`
    // origin, an origin no socket can reach. So "unset" and "set to something
    // unreachable" look identical from the connection's side; naming the value is what
    // makes a failure say which happened, and what it should have been.
    const transport = await evaluate(`(() => {
      const t = globalThis.__DSH_TRANSPORT__
      return {
        present: t !== undefined,
        ownsHost: t === undefined ? undefined : t.ownsHost,
        streamBaseUrl: t === undefined ? null : (t.streamBaseUrl ?? null),
        documentBase: document.baseURI,
      }
    })()`)
    check(
      'the transport global points the client’s socket at the Host, not at the page origin',
      transport.present === true
        && transport.ownsHost === true
        && typeof transport.streamBaseUrl === 'string'
        && transport.streamBaseUrl.startsWith('http://127.0.0.1:'),
      `__DSH_TRANSPORT__ = ${JSON.stringify({
        ownsHost: transport.ownsHost,
        streamBaseUrl: transport.streamBaseUrl,
      })}; the document’s own base is ${transport.documentBase}`,
    )

    // ── 11. No runaway repetition in the application's own output ───────────────
    //
    // A LOOP IS THE SILENT COUSIN OF A CRASH. This run produced 40 000 lines of log on
    // a *healthy* window, and none of the checks above reads the log for volume — so a
    // retry loop printing the same line forever, or a warning emitted per frame, would
    // go unnoticed here and be found by someone wondering why their disk filled.
    //
    // THE APPIMAGE'S OWN FILE LISTING IS EXCLUDED, and that is not a convenience:
    // `--appimage-extract-and-run` makes the runtime print every path it unpacks, which
    // is tens of thousands of lines naming the extraction directory. It says nothing
    // about the application and it swamps the count, so leaving it in would make this
    // check fail on every run until someone deleted it — and a deleted check is how a
    // real loop goes unnoticed.
    const shapes = new Map()
    for (const line of log.split('\n')) {
      if (line.includes('appimage_extracted_')) continue
      // Comparing the *shape* rather than the text: volatile parts (ports, timestamps,
      // paths, byte counts) differ between otherwise identical lines, so digits are
      // folded before counting. Without that, a loop that logs a counter would look
      // like thousands of distinct messages.
      const shape = line.trim().replace(/\d+/gu, '#').slice(0, 120)
      if (shape === '') continue
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1)
    }
    const worst = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0]
    check(
      'the application is not looping on one message',
      worst === undefined || worst[1] < 200,
      worst === undefined
        ? '(the application logged nothing of its own)'
        : `${String(shapes.size)} distinct lines, worst repeated ${String(worst[1])}x:`
          + ` ${JSON.stringify(worst[0].slice(0, 80))}`,
    )
    // ── 12. The density and type scale, recorded rather than judged ─────────────
    //
    // NOT AN ASSERTION, AND DELIBERATELY SO. Whether a 16px body with 50px rows is right
    // is an aesthetic call — the one thing this chain refuses to decide. But the
    // *numbers* are mechanical, and "the UI could be denser" is not a review comment
    // unless someone can say by how much. So they are measured and written to
    // `density.json`, and the thresholds below are only the outer bounds at which
    // something is certainly broken (a 0px row, an unreadable 8px body) rather than a
    // target.
    //
    // MEASURED WITH SETTINGS OPEN, because that is the surface the question is about:
    // the screenshot audit measured 77px rows on the settings page and 57px on the
    // providers page, and a chat view's spacing is not comparable to either.
    await openSettings()
    const density = await evaluate(`(() => {
      const round = (value) => Math.round(value * 10) / 10
      const panel = document.querySelector('[role="dialog"]')
      // The section's content column: everything right of the settings nav, which is the
      // region a density change would move.
      const nav = panel === null ? null : panel.querySelector('nav')
      const navRight = nav === null ? 0 : nav.getBoundingClientRect().right
      const content = panel === null ? null : [...panel.querySelectorAll('*')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.x >= navRight - 2 && r.width > 200 && r.height > 200)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0]
      // The type scale actually rendered, inside the panel only.
      const sizes = new Map()
      for (const el of (panel ?? document).querySelectorAll('*')) {
        if (el.children.length > 0) continue
        const text = (el.textContent || '').trim()
        if (text === '') continue
        const size = Number.parseFloat(getComputedStyle(el).fontSize)
        if (Number.isFinite(size)) sizes.set(size, (sizes.get(size) ?? 0) + 1)
      }
      // Row pitch: the vertical distance between consecutive sibling rows that share a
      // parent and are tall enough to be a settings row rather than a line of text.
      const pitches = []
      for (const parent of (panel ?? document).querySelectorAll('*')) {
        const rows = [...parent.children]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height >= 16 && r.width > 120)
          .sort((a, b) => a.y - b.y)
        for (let index = 1; index < rows.length; index += 1) {
          const gap = rows[index].y - rows[index - 1].y
          if (gap > 8 && gap < 200) pitches.push(gap)
        }
      }
      pitches.sort((a, b) => a - b)
      const body = getComputedStyle(document.body)
      return {
        viewport: { w: innerWidth, h: innerHeight },
        baseFontSize: round(Number.parseFloat(body.fontSize)),
        baseLineHeight: body.lineHeight,
        scale: [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([size, count]) => ({ size, count })),
        rowPitchMedian: pitches.length === 0 ? null : round(pitches[Math.floor(pitches.length / 2)]),
        rowPitchSamples: pitches.length,
        panel: panel === null ? null : { w: Math.round(panel.getBoundingClientRect().width), h: Math.round(panel.getBoundingClientRect().height) },
        navWidth: Math.round(navRight),
        // NOTE: no backticks in this comment. It sits inside a template literal, so a
        // backtick here would close the string and the whole file would fail to parse.
        // (Writing that mistake is how this note got here.)
        //
        // content is null when there is no panel, so testing only for undefined let the
        // null through and threw inside the page — aborting the chain and reporting one
        // unreadable error instead of a measurement. Reachable as soon as the settings
        // panel fails to open, which is a failure this file already has its own verdict for.
        contentColumn: content == null ? null : { w: Math.round(content.width), x: Math.round(content.x) },
      }
    })()`)
    const sizeList = density.scale.map((entry) => `${String(entry.size)}px×${String(entry.count)}`).join(' ')
    writeFileSync(join(outDir, 'density.json'), `${JSON.stringify(density, null, 2)}\n`)
    console.log('\n  density and type scale (recorded, not judged):')
    console.log(`    viewport           ${String(density.viewport.w)}×${String(density.viewport.h)}`)
    console.log(`    base font          ${String(density.baseFontSize)}px, line-height ${String(density.baseLineHeight)}`)
    console.log(`    type scale         ${sizeList}`)
    console.log(`    settings row pitch ${String(density.rowPitchMedian)}px (median of ${String(density.rowPitchSamples)})`)
    console.log(`    panel              ${JSON.stringify(density.panel)}, nav ${String(density.navWidth)}px,`
      + ` content column ${JSON.stringify(density.contentColumn)}`)
    console.log(`    -> ${join(outDir, 'density.json')}`)
    check(
      'the type scale and row pitch are within readable bounds',
      // Outer bounds, not a target: a body below 11px or above 20px, or a row pitch under
      // 24px, is a layout that has gone wrong rather than a style preference.
      density.baseFontSize >= 11 && density.baseFontSize <= 20
        && density.rowPitchMedian !== null && density.rowPitchMedian >= 24
        && density.contentColumn !== null,
      `base ${String(density.baseFontSize)}px, row pitch ${String(density.rowPitchMedian)}px,`
        + ` content column ${JSON.stringify(density.contentColumn)}, ${String(density.scale.length)} distinct sizes`,
    )

    // The application's output always lands in a file, whatever the verdict. It is the
    // only artefact that outlives the window, and one of the checks is *about* it.
    writeFileSync(join(outDir, 'application.log'), log)
  }
  exitCode = results.every((result) => result.passed) ? 0 : 1
} catch (error) {
  check('the chain ran to the end', false, error instanceof Error ? `${error.message}` : String(error))
  exitCode = 1
} finally {
  // The stop is part of the verdict, not housekeeping after it: a leaked application
  // holds its port and its user-data directory, and the *next* run measures the
  // previous one. `stopApp` reports whether the whole process group is gone.
  if (launched !== undefined) stopped = await stopApp(launched.child)
  // After the application, never before: stopping the display out from under a live window is its own
  // failure, and the application is the thing whose verdict matters here.
  display.stop()
  if (!stopped) {
    check('the application stopped, leaving no process behind', false,
      'the process group survived SIGTERM and SIGKILL; directories left in place')
    exitCode = 1
  } else if (!keep) {
    removeDir(userData); removeDir(home); removeDir(probeTmp)
  }
  const passed = results.filter((result) => result.passed).length
  console.log(`\n${String(passed)}/${String(results.length)} checks passed — ${exitCode === 0 ? 'OK' : 'FAILED'}`)
  if (results.some((result) => !result.passed)) {
    console.log('failed:')
    for (const result of results.filter((r) => !r.passed)) console.log(`  · ${result.name}`)
  }
  console.log(`screenshots in ${outDir}`)
  process.exitCode = exitCode
}
