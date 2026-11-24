/**
 * Measure whether the text in the running interface can be read.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE OTHER PROBE. `ui-screenshot-probe.mjs`
 * photographs the window and reads tokens; `visual-audit-probe.mjs` measures geometry
 * and the type scale. Both are read-only, and neither can answer the question this
 * file exists for: *the two light schemes turned the tooltip into a near-white
 * rectangle carrying white text, and no test noticed for a week.*
 *
 * The reason they could not is that the failure is behind a hover. A tooltip is
 * mounted by a pointer event and unmounted a moment later, so it appears in no
 * screenshot, in no static scan, and in no assertion that does not first move a
 * pointer. This probe does move one, then measures the *worst* foreground/background
 * pair inside the bubble — including the shortcut keycaps, which are a second,
 * nested surface whose glyph colour is inherited rather than declared.
 *
 * THE CONTRAST ARITHMETIC IS NOT REIMPLEMENTED HERE. It is imported from the theme
 * package (`contrastRatio`), so the number this probe prints and the number the unit
 * test asserts are the same function of the same two hex values. A probe with its own
 * copy of the formula can disagree with the test, and then neither is evidence.
 *
 * IT ALSO REPRODUCES THE DEFECT ON DEMAND. With the fix in place the broken state no
 * longer exists to photograph, so the probe re-creates it in the live document by
 * setting the two custom properties back to the values the mapping used to produce
 * (the scheme's `panel` and `element` roles, read from the generated palettes). That
 * turns "before" and "after" into two frames of the same build, which is a stronger
 * comparison than two builds — nothing else differs between them, not even a version.
 *
 * WHAT IT DOES NOT DO: judge whether the result looks good. It reports numbers and
 * writes PNGs; the appearance call belongs to a human, and this file should never
 * grow an assertion about taste.
 *
 * Usage: `node ui-legibility-probe.mjs <appBinary|AppImage> [outDir]`
 *
 * The application is launched outside this shell's sandbox in practice (it needs
 * `$HOME`-adjacent state, `/dev/shm` and a writable X socket), which is why every run
 * is a separate, deliberate act rather than something a test triggers.
 *
 * @module qialike-desktop/ui-legibility-probe
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, removeDir, sleep, stopApp } from './app-launch.mjs'

// Resolved against this file, not the shell's working directory, so the probe can be
// run from anywhere — including from `pnpm` scripts, which do not promise a cwd.
const { contrastRatio } = await import(new URL('../../../packages/qialike-desktop-theme/lib/tokens.js', import.meta.url))
const { SCHEME_PALETTES } = await import(new URL('../../../packages/qialike-desktop-theme/lib/palettes.js', import.meta.url))

const app = process.argv[2]
const outDir = process.argv[3] ?? join(process.env.HOME ?? '/tmp', 'qialike', 'screens', 'ui-round2')
if (app === undefined) {
  console.error('usage: ui-legibility-probe.mjs <appBinary|AppImage> [outDir]')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

/** A free port, for the reason `visual-audit-probe.mjs` documents at length. */
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    server.close(() => { resolve(port) })
  })
})

/**
 * The page-side function that finds the worst-reading pair under a root.
 *
 * IT WALKS UP FOR THE BACKGROUND rather than reading the element's own, because the
 * common shape is a `<span>` with a colour and no background inside a bubble that has
 * one. Reading the span's own (transparent) background would report the page behind
 * it and overstate the contrast in one direction or the other depending on the theme.
 *
 * `rgb()` is parsed here rather than sent across the wire, because the two colours
 * must be compared, not transported.
 */
const WORST_PAIR = `(root) => {
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value)
    if (m === null) return null
    const parts = m[1].split(',').map((v) => Number.parseFloat(v))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const opaqueBackgroundOf = (el) => {
    for (let node = el; node !== null; node = node.parentElement) {
      const parsed = parse(getComputedStyle(node).backgroundColor)
      if (parsed !== null && parsed.a === 1) {
        return { rgb: parsed, node: node.tagName.toLowerCase() + '.' + String(node.className).slice(0, 24) }
      }
    }
    return null
  }
  const rows = []
  for (const el of root.querySelectorAll('*')) {
    if (el.children.length > 0) continue
    const text = (el.textContent || '').trim()
    if (text === '') continue
    const fg = parse(getComputedStyle(el).color)
    const bg = opaqueBackgroundOf(el)
    if (fg === null || bg === null || fg.a !== 1) continue
    rows.push({
      text: text.slice(0, 24),
      fg: 'rgb(' + fg.r + ', ' + fg.g + ', ' + fg.b + ')',
      bg: 'rgb(' + bg.rgb.r + ', ' + bg.rgb.g + ', ' + bg.rgb.b + ')',
      bgFrom: bg.node,
      // The ratio itself is computed in node, where the one implementation lives.
      fontSize: getComputedStyle(el).fontSize,
    })
  }
  return rows
}`

/** `rgb(44, 44, 46)` or `#2c2c2e` to a hex string the shared ratio function accepts. */
const toHex = (value) => {
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(value)
  if (rgb === null) return null
  return `#${[1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('')}`
}

/** The worst pair in a row set, as a number plus the row that produced it. */
const worstOf = (rows) => {
  let worst
  for (const row of rows) {
    const fg = toHex(row.fg)
    const bg = toHex(row.bg)
    if (fg === null || bg === null) continue
    const ratio = contrastRatio(fg, bg)
    if (worst === undefined || ratio < worst.ratio) worst = { ...row, ratio: Math.round(ratio * 100) / 100 }
  }
  return worst
}

const port = await freePort()
const userData = mkdtempSync(join(tmpdir(), 'qialike-legible-'))
const home = mkdtempSync(join(tmpdir(), 'qialike-legible-home-'))
const probeTmp = mkdtempSync(join(tmpdir(), 'qialike-legible-tmp-'))

let launched
let stopped = false
const report = []

try {
  launched = launchApp({
    binary: app,
    args: [
      ...(app.endsWith('.AppImage') ? ['--appimage-extract-and-run'] : []),
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${userData}`,
      '--no-sandbox', '--disable-gpu',
      '--window-size=1440,900',
    ],
    env: { DSH_HOME: home, QIALIKE_DESKTOP_USER_DATA_DIR: userData, TMPDIR: probeTmp },
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
    console.log('NO_DEBUGGER_TARGET')
    console.log(launched.log().slice(-2000))
    process.exitCode = 1
  } else {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let nextId = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
    const send = (method, params) => {
      const id = ++nextId
      return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
    }
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

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const ready = await evaluate(
        `typeof globalThis.__DSH_BOOT__ !== 'undefined' && !/Loading plugins/i.test(document.body.innerText)`,
      )
      if (ready === true) break
      await sleep(1000)
    }
    await sleep(2500)

    /** The centre of the smallest element whose trimmed text matches. */
    const centreOf = async (text) => evaluate(`(() => {
      const hits = [...document.querySelectorAll('button,[role="button"],a,div,span')]
        .filter((el) => (el.textContent || '').trim() === ${JSON.stringify(text)})
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter((c) => c.r.width > 0 && c.r.height > 0)
        .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)
      if (hits.length === 0) return null
      const r = hits[0].r
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: hits[0].el.tagName }
    })()`)

    /**
     * Hover a point and wait past the tooltip's own delay.
     *
     * The delay is 500 ms at the call sites (`delayMs={500}` in `ui-workspace`), so
     * waiting less than that measures nothing and reports it as "no tooltip", which is
     * the wrong conclusion. A first move to a far corner guarantees a fresh
     * `pointerover` on the target afterwards: moving to a point the pointer is already
     * at fires no event at all.
     */
    const hover = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
      await sleep(120)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await sleep(900)
    }

    /** Switch the active scheme through the picker, by option value. */
    const chooseScheme = async (id) => {
      // The picker lives in Appearance since 0.4.6; navigating is part of choosing.
      await openAppearance()
      return evaluate(`(() => {
      const select = [...document.querySelectorAll('select')]
        .find((el) => [...el.options].some((o) => (o.value || '').startsWith('qialike-')))
      if (select === undefined) return null
      select.value = ${JSON.stringify(id)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return select.value
    })()`)
    }

    /** A left click at a viewport point, as the two press/release events a click is. */
    const clickAt = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(900)
    }

    /**
     * Whether the settings panel is up.
     *
     * Detected by the theme row's own select rather than by a class name: the panel's
     * classes are content-hashed per upstream build, and the select is the one element
     * the panel carries that the rest of the window does not.
     */
    /**
     * Whether the panel is up.
     *
     * BY ITS NAV COLUMN, not by our colour-scheme select. The select used to sit in General,
     * which the panel opens on; since 0.4.6 it sits in the Appearance section, and a section
     * without tabs is rendered only while it is the selected one — so the select does not exist
     * until someone navigates there. Measured: this returned false with the panel plainly open.
     *
     * The section names only: `Settings`/`设置` are the sidebar entry and are on screen either
     * way, which is how a predicate like this reports "open" to a closed panel.
     */
    const SECTION_LABELS = ['通用设置', 'General']
    const settingsOpen = async () => evaluate(`(() => {
      const rows = [...document.querySelectorAll('button,[role="button"],a,li')]
        .map((el) => (el.textContent || '').trim())
      return rows.some((text) => ${JSON.stringify(SECTION_LABELS)}.includes(text))
    })()`)

    /** Open the settings page, where the theme row lives. */
    const openSettings = async () => {
      if (await settingsOpen()) return true
      for (const label of ['Settings', '设置']) {
        const point = await centreOf(label)
        if (point === null) continue
        await clickAt(point.x, point.y)
        for (let attempt = 0; attempt < 16; attempt += 1) {
          await sleep(250)
          if (await settingsOpen()) return true
        }
      }
      return false
    }

    /**
     * Open the Appearance section, where the colour-scheme picker lives.
     *
     * The picker moved there in 0.4.6, and every place this probe switches a scheme has to
     * follow: a select that is not rendered cannot be driven.
     */
    const openAppearance = async () => {
      if (await settingsOpen() !== true) return false
      for (const label of ['外观', 'Appearance']) {
        const point = await centreOf(label)
        if (point === null) continue
        await clickAt(point.x, point.y)
        await sleep(700)
        const reached = await evaluate(`[...document.querySelectorAll('select')]
          .some((el) => [...el.options].some((o) => (o.value || '').startsWith('qialike-')))`)
        if (reached) return true
      }
      return false
    }

    /**
     * Dismiss the settings panel, because IT COVERS THE TOOLTIP ANCHORS.
     *
     * THIS IS THE BUG THE FIRST RUN HAD, and it is invisible from the outside: the
     * panel is modal, its mask spans the window, and an element behind a mask still
     * has a bounding rectangle. So a candidate list built from `getBoundingClientRect`
     * happily offers the sidebar's buttons, the pointer events land on the mask, no
     * tooltip ever opens, and the probe reports "no anchor" — or, worse, reports the
     * worst pair it found *somewhere else*. The mask itself closes the panel on click
     * (`SettingsRoot.tsx:69`), so clicking beside the panel is both the fix and what a
     * user would do.
     */
    const closeSettings = async () => {
      if (!(await settingsOpen())) return true
      const viewport = await evaluate(`({ w: innerWidth, h: innerHeight })`)
      // Right of the panel, which is capped well short of the window width.
      await clickAt(viewport.w - 40, Math.round(viewport.h / 2))
      if (await settingsOpen()) {
        // The header's close button is the other way out; try Escape before giving up.
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await sleep(900)
      }
      return !(await settingsOpen())
    }

    /**
     * Dismiss the first-run welcome overlay if it is up.
     *
     * It is a `shell.overlay` modal with a scrim of its own, so it blocks the same
     * pointer events the settings mask does — and it is up on a fresh profile, which
     * is exactly what this probe uses. Both the English and the Chinese label are
     * tried, because the probe must not depend on the locale it happens to get.
     */
    const dismissWelcome = async () => {
      for (const label of ['Skip for now', '暂时跳过']) {
        const point = await centreOf(label)
        if (point !== null) {
          await clickAt(point.x, point.y)
          return label
        }
      }
      return undefined
    }

    /**
     * Find a control that actually opens a tooltip, by trying them.
     *
     * WHY THIS IS A SEARCH AND NOT A SELECTOR. The first version of this probe hovered
     * the element whose text is "New Session" — the obvious anchor — and measured a
     * *hover card* instead: `bubble=NO` in all three schemes, while the numbers it
     * reported came from the workspace preview. Two different components answer a
     * hover, both are ours to get right, and nothing in the DOM says which is which:
     * `Tooltip` sets `role="tooltip"` only *while shown*, and the anchor carries no
     * `aria-describedby`. So the probe enumerates the interactive elements, hovers
     * each, and keeps the first that mounts a bubble. That is the honest way to find
     * an anchor from outside the application.
     *
     * The failure is worth recording because the first run still printed plausible
     * numbers — a worst pair of 3.76:1 with a plausible-looking label. A probe that
     * reports a measurement it did not take is worse than one that reports nothing.
     */
    const findTooltipAnchor = async () => {
      const candidates = await evaluate(`(() => {
        const out = []
        for (const el of document.querySelectorAll('button,[role="button"],a,[tabindex]')) {
          const r = el.getBoundingClientRect()
          if (r.width < 8 || r.height < 8) continue
          if (r.x < 1 || r.y < 1 || r.x + r.width > innerWidth - 1 || r.y + r.height > innerHeight - 1) continue
          out.push({
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30),
          })
        }
        // Deterministic order: the same anchor must be chosen on every run, or the
        // before/after pair would compare two different controls.
        return out
      })()`)
      for (const candidate of candidates) {
        await hover(candidate)
        const shown = await evaluate(`document.querySelector('[role="tooltip"]') !== null`)
        if (shown) return candidate
      }
      return undefined
    }

    /**
     * Measure one surface: the tooltip pair as shipped, then with the defect
     * re-applied, so "before" and "after" are two frames of the *same* build.
     *
     * `read()` takes the *worst* pair inside the bubble rather than the bubble's own
     * two colours, because a keycap inside it is a second surface whose glyph colour
     * is inherited rather than declared — and a good-looking parent would hide it.
     */
    const measure = async (schemeId, anchor) => {
      const palette = SCHEME_PALETTES[schemeId.replace(/^qialike-/u, '')]
      await hover(anchor)

      const read = async (state) => {
        const hasBubble = await evaluate(`document.querySelector('[role="tooltip"]') !== null`)
        const bubble = await evaluate(`(() => {
          const el = document.querySelector('[role="tooltip"]')
          if (el === null) return null
          const s = getComputedStyle(el)
          return { bg: s.backgroundColor, color: s.color, font: s.fontFamily.slice(0, 40), fontSize: s.fontSize,
            label: (el.textContent || '').trim().slice(0, 40),
            keycaps: [...el.querySelectorAll('*')].filter((n) => {
              const b = getComputedStyle(n).backgroundColor
              return b !== 'rgba(0, 0, 0, 0)' && b !== s.backgroundColor
            }).map((n) => ({ bg: getComputedStyle(n).backgroundColor, color: getComputedStyle(n).color })) }
        })()`)
        const worst = hasBubble
          ? worstOf(await evaluate(`(${WORST_PAIR})(document.querySelector('[role="tooltip"]'))`))
          : undefined
        report.push({ scheme: schemeId, state, anchor: anchor.label, tooltip: bubble, worst })
        console.log(`  ${schemeId} ${state.padEnd(9)} bubble=${hasBubble ? 'yes' : 'NO '} `
          + `bg=${String(bubble?.bg)} color=${String(bubble?.color)} `
          + `keycaps=${JSON.stringify(bubble?.keycaps ?? [])} worst=${String(worst?.ratio)} `
          + `("${String(worst?.text)}" ${String(worst?.fg)} on ${String(worst?.bg)})`)
      }

      await read('fixed')
      await shoot(`${schemeId}.tooltip-fixed`)
      if (palette !== undefined) {
        // Re-apply the defect, in the live document: the two tokens as the mapping
        // used to set them. The broken state no longer exists to photograph, so it is
        // reconstructed — which is why the two frames are comparable.
        //
        // SET ON `body`, NOT ON `html`, and the first attempt got this wrong in a way
        // worth keeping: the harness declares the whole token sheet on `body`
        // (`design-platform.css` has `body { … }` and `body[data-ds-dark-theme] { … }`),
        // so a value set on `documentElement` is simply shadowed by the nearer
        // declaration and the sabotage silently measured the *fixed* state twice. The
        // two frames came out byte-identical, which is at least a visible symptom; an
        // override that half-worked would have been worse. Inline style on `body` beats
        // both of the harness's rules on specificity, which is what a reconstruction of
        // "the mapping set this to the scheme's panel" needs.
        await evaluate(`(() => {
          document.body.style.setProperty('--dsw-alias-tooltip-bg', ${JSON.stringify(palette.panel)})
          document.body.style.setProperty('--dsw-alias-tooltip-key-bg', ${JSON.stringify(palette.element)})
          return true
        })()`)
        await hover(anchor)
        await read('before')
        await shoot(`${schemeId}.tooltip-before`)
        await evaluate(`(() => {
          document.body.style.removeProperty('--dsw-alias-tooltip-bg')
          document.body.style.removeProperty('--dsw-alias-tooltip-key-bg')
          return true
        })()`)
      }
    }

    // The settings page is where the theme row lives, so the palette is switched
    // there — and then the panel is dismissed, because its mask covers every tooltip
    // anchor in the window.
    const welcomeDismissed = await dismissWelcome()
    console.log(`  welcome overlay: ${welcomeDismissed === undefined ? 'not shown' : `dismissed via "${welcomeDismissed}"`}`)

    if (!(await openSettings())) {
      console.log('  could not open Settings — the schemes are switched through its row, so this run cannot measure')
      process.exitCode = 1
    }
    await chooseScheme('qialike-light')
    await sleep(900)
    if (!(await closeSettings())) {
      console.log('  could not dismiss the settings panel; its mask would swallow every hover')
      process.exitCode = 1
    }

    // Found once, while nothing covers the window, and reused: the before/after pair
    // must be the same control, and a fresh search per scheme would also make the run
    // take minutes.
    const anchor = await findTooltipAnchor()
    if (anchor === undefined) {
      console.log('  NO TOOLTIP ANCHOR FOUND — the run measured nothing, and says so rather than')
      console.log('  reporting the worst pair on the page as if it were the tooltip.')
      process.exitCode = 1
    } else {
      console.log(`  tooltip anchor: "${anchor.label}" at ${String(anchor.x)},${String(anchor.y)}`)
      for (const scheme of ['qialike-light', 'qialike-solarized-light', 'qialike-dracula']) {
        if (!(await openSettings())) { console.log(`  ${scheme}: could not open Settings`); continue }
        await chooseScheme(scheme)
        await sleep(900)
        await closeSettings()
        await measure(scheme, anchor)
      }
    }

    console.log(`\n__REPORT__${JSON.stringify(report)}\n`)
    console.log(`screenshots in ${outDir}`)
  }
} finally {
  if (launched !== undefined) stopped = await stopApp(launched.child)
  if (!stopped) {
    console.error('qialike-desktop: the application did not stop; leaving its directories in place')
    process.exitCode = 1
  } else {
    removeDir(userData); removeDir(home); removeDir(probeTmp)
  }
}
