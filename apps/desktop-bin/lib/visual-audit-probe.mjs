/**
 * Measure the rendered interface, so UI work starts from numbers rather than taste.
 *
 * WHY THIS EXISTS. I cannot see the window — this environment has no display and no
 * image tooling — so "the UI could be denser" or "the type scale is off" would be
 * opinion dressed as judgement. Every design statement in a plan should be a
 * measurement instead: this reads the live document over the DevTools protocol and
 * reports the geometry, the type scale actually in use, the colour roles of the main
 * surfaces, and which of our own plugin bundles reached the page.
 *
 * It is deliberately read-only: it evaluates expressions and returns values, and it
 * changes no style. Its output is the evidence a proposal cites.
 *
 * Usage: `node visual-audit-probe.mjs <appBinary|AppImage>`
 *
 * @module qialike-desktop/visual-audit-probe
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, removeDir, sleep, stopApp } from './app-launch.mjs'

/**
 * A free TCP port, chosen by the OS.
 *
 * WHY NOT A CONSTANT. Every probe used to hardcode its DevTools port, and a probe
 * that leaked its application left that port held — so the *next* run's
 * `fetch('/json/list')` answered from the **stale instance**, and the measurements
 * silently described an application someone had already navigated. That is a
 * measurement corrupted by the thing it was measuring, with no error anywhere: the
 * second run reported a light theme, no welcome overlay and 89 KB frames, all of
 * which were true of the leaked window and false of a fresh launch.
 *
 * A port the OS hands out cannot be held by an older run, which removes the class.
 *
 * @returns a port number that was free a moment ago.
 */
async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolve(port) })
    })
  })
}


const app = process.argv[2]
if (app === undefined) {
  console.error('usage: visual-audit-probe.mjs <appBinary|AppImage>')
  process.exit(2)
}

const port = await freePort()
const userData = mkdtempSync(join(tmpdir(), 'qialike-visual-'))
const home = mkdtempSync(join(tmpdir(), 'qialike-visual-home-'))
const probeTmp = mkdtempSync(join(tmpdir(), 'qialike-visual-tmp-'))

let launched
let stopped = false

try {
  launched = launchApp({
    binary: app,
    args: [
      ...(app.endsWith('.AppImage') ? ['--appimage-extract-and-run'] : []),
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${userData}`,
      '--no-sandbox', '--disable-gpu',
      // A deterministic window, so measurements are comparable between runs.
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

    // Wait for the client to finish mounting, not merely to render: the boot page is
    // itself a child of #root, so a child count is true before anything has loaded.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const ready = await evaluate(
        `typeof globalThis.__DSH_BOOT__ !== 'undefined' && !/Loading plugins/i.test(document.body.innerText)`,
      )
      if (ready === true) break
      await sleep(1000)
    }
    // Layout settles after mount (fonts, scrollbars, a reflow from the plugin rows).
    await sleep(2500)

    const report = await evaluate(`(() => {
  const px = (value) => Math.round(Number.parseFloat(value) * 10) / 10
  const box = (el) => {
    if (el === undefined || el === null) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
  }
  const css = (el, ...props) => {
    if (el === undefined || el === null) return null
    const s = getComputedStyle(el)
    return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p).trim()]))
  }
  // Match by accessible text, because the class names are hashed per build.
  const byText = (text) => [...document.querySelectorAll('button,a,[role="button"],div,span')]
    .find((el) => el.textContent?.trim() === text)
  const body = getComputedStyle(document.body)

  // The type scale: every distinct font-size actually rendered, with a sample.
  const sizes = new Map()
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length > 0) continue
    const text = el.textContent?.trim()
    if (text === undefined || text === '') continue
    const size = getComputedStyle(el).fontSize
    if (!sizes.has(size)) sizes.set(size, text.slice(0, 28))
  }

  // Radii and shadows in use: the shape language.
  const radii = new Map()
  for (const el of document.querySelectorAll('*')) {
    const r = getComputedStyle(el).borderRadius
    if (r !== '0px' && r !== '') radii.set(r, (radii.get(r) ?? 0) + 1)
  }

  // Which of our own bundles are present, and whether the theme row mounted.
  const extras = [...document.querySelectorAll('*')]
    .map((el) => el.className)
    .filter((c) => typeof c === 'string' && /qialike/i.test(c))
    .slice(0, 10)

  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    bodyFont: body.fontFamily,
    bodyFontSize: body.fontSize,
    // The main regions, by the text they contain.
    regions: {
      newSessionButton: box(byText('New Session')),
      plugins: box(byText('Plugins')),
      workspaces: box(byText('Workspaces')),
      settings: box(byText('Settings')),
      hero: box(document.querySelector('[class*="hero" i]')),
    },
    // The sidebar is the first child of the frame; its width is a headline number.
    sidebar: (() => {
      const candidate = document.querySelector('aside,[class*="sidebar" i]')
      return { box: box(candidate), css: css(candidate, 'background-color', 'border-right-width', 'width') }
    })(),
    composer: (() => {
      const candidate = document.querySelector('textarea')?.closest('div[class]')
      return { box: box(candidate), css: css(candidate, 'background-color', 'border-radius', 'border-width') }
    })(),
    typeScale: [...sizes.entries()].sort((a, b) => Number.parseFloat(a[0]) - Number.parseFloat(b[0]))
      .map(([size, sample]) => ({ size, sample })),
    radii: [...radii.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count })),
    // Read from several elements: the tokens are not on :root here, and an empty
    // read from the wrong element would look like "no tokens are defined".
    tokenHosts: Object.fromEntries(
      ['html', 'body'].map((tag) => {
        const el = document.querySelector(tag)
        const s = getComputedStyle(el)
        return [tag, {
          bgBase: s.getPropertyValue('--dsw-alias-bg-base').trim(),
          labelPrimary: s.getPropertyValue('--dsw-alias-label-primary').trim(),
          brandPrimary: s.getPropertyValue('--dsw-alias-brand-primary').trim(),
        }]
      }),
    ),
    // The theme mechanism keys off this attribute, so its exact value matters.
    darkThemeAttr: {
      present: document.body.hasAttribute('data-ds-dark-theme'),
      value: document.body.getAttribute('data-ds-dark-theme'),
      htmlPresent: document.documentElement.hasAttribute('data-ds-dark-theme'),
    },
    // What the body text actually resolves to, which a stack alone does not say.
    resolvedFont: (() => {
      const el = [...document.querySelectorAll('button,a,div,span')]
        .find((n) => n.textContent?.trim() === 'New Session')
      return el === undefined ? null : getComputedStyle(el).fontFamily
    })(),
    // The header band and the main content area, to see the frame's proportions.
    header: (() => {
      const el = [...document.querySelectorAll('*')].find((n) =>
        n.getBoundingClientRect().height > 30 && n.getBoundingClientRect().height < 70
        && n.getBoundingClientRect().width > innerWidth * 0.5
        && n.getBoundingClientRect().y < 120)
      return box(el)
    })(),
    // Every font family the document actually uses, with a sample: a Linux window
    // rendering a macOS-first stack is worth seeing rather than assuming.
    fontFamilies: [...new Set([...document.querySelectorAll('*')]
      .map((el) => getComputedStyle(el).fontFamily))]
      .filter((f) => f !== '')
      .slice(0, 8),
    qialikeClasses: extras,
  }
})()`)

    console.log(`__REPORT__${JSON.stringify(report)}\n`)
  }
} finally {
  if (launched !== undefined) stopped = await stopApp(launched.child)
  if (!stopped) {
    console.error('qialike-desktop: the application did not stop; leaving its directories in place')
    // Non-zero, so a caller that pipes the output somewhere cannot lose the fact.
    // The run that leaked the window this comment was written for printed its
    // warning to a stream that was being cut off by `tail`.
    process.exitCode = 1
  } else {
    removeDir(userData); removeDir(home); removeDir(probeTmp)
  }
}
