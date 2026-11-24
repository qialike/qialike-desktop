/**
 * The three brand seats, rendered.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER STRING COMPARISON. The bundle is hand-written and has no
 * compiler and no type checker pointed at it, so a name it calls but no longer defines is not an error
 * anywhere: the module loads, the test suite passes, and the seat the component belongs to is simply
 * blank. That is exactly what happened — a helper was deleted while the wordmark still called it, the
 * `qialike` text next to the mark disappeared from the running application, and every existing
 * assertion still passed because they all compared strings in files rather than calling the code.
 *
 * So these tests LOAD THE BUNDLE and RENDER EACH COMPONENT against a stub React. The stub is enough:
 * what has to hold is that calling a seat produces an element tree, that the wordmark produces its
 * glyphs, and that the two mark seats produce markup — none of which needs a real renderer, and all of
 * which a missing identifier fails immediately.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const CLIENT_BUNDLE = join(ROOT, 'packages', 'qialike-desktop-brand', 'lib', 'client.js')

/** The three seats this bundle claims, and the two that carry the mark. */
const SEATS = ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark']

/**
 * A React stub that records the tree instead of rendering it.
 * @returns the `createElement` the bundle's `require('react')` resolves to.
 */
function stubReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false),
  })
  return { createElement }
}

/**
 * Load the bundle and call every seat it registers.
 *
 * The bundle is a Cordis module: it hands a factory to `window.__ModuleLoader__`, and its `apply` mounts
 * components through `ctx.slots`. Both halves are stubbed here, which is the point — the seats are
 * reached the way the application reaches them, rather than by reading the file.
 *
 * @returns the mounted component per seat.
 */
function mountSeats() {
  const mounted = new Map()
  const exports = {}
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => { Object.assign(exports, factory(() => stubReact())) },
      },
    },
  }
  new Script(readFileSync(CLIENT_BUNDLE, 'utf8')).runInContext(createContext(sandbox))
  expect(typeof exports.apply, 'the bundle exports no apply, so nothing would mount').toBe('function')
  exports.apply({
    slots: {
      // `inject` is called with a callback that registers and returns the component; calling it here is
      // what mounts the seat, so a callback that throws fails this rather than failing silently in the app.
      inject: (name, register) => { mounted.set(name, register()) },
      register: (_share, component) => component,
    },
  })
  return mounted
}

/** Every string in an element tree, for assertions about what would be painted. */
function textOf(node) {
  if (typeof node === 'string') return [node]
  if (node === null || node === undefined || typeof node !== 'object') return []
  return [
    ...(typeof node.props.dangerouslySetInnerHTML?.__html === 'string' ? [node.props.dangerouslySetInnerHTML.__html] : []),
    ...(Array.isArray(node.children) ? node.children.flatMap(textOf) : []),
  ]
}

describe('the brand seats', () => {
  it('mounts all three, so none is silently missing from the sidebar or the hero', () => {
    const mounted = mountSeats()
    for (const seat of SEATS) {
      expect(mounted.has(seat), `${seat} was never registered`).toBe(true)
      expect(typeof mounted.get(seat), `${seat} registered no component`).toBe('function')
    }
  })

  it('renders the wordmark, which is the text beside the mark', () => {
    // THE REGRESSION. This component called a helper that had been deleted, so it threw on render and the
    // `qialike` beside the bee vanished. Nothing else in the suite called it, so nothing else noticed.
    const BrandName = mountSeats().get('sidebar.brand.name')
    const tree = BrandName()
    expect(tree.type, 'the wordmark is not an svg').toBe('svg')
    // Seven glyphs: `q`, `i`, `a` in one tone and `l`, `i`, `k`, `e` in the other. Counted rather than
    // described, because a wordmark that renders four letters is as broken as one that renders none.
    expect(tree.children, 'the wordmark lost its glyphs').toHaveLength(7)
    for (const glyph of tree.children) {
      expect(['path', 'rect'], `a wordmark glyph is a <${String(glyph.type)}>`).toContain(glyph.type)
      expect(glyph.props.fill, 'a wordmark glyph has no fill').toMatch(/^#[0-9a-f]{6}$/u)
    }
  })

  it('renders the mark in both seats, from the artwork', () => {
    const mounted = mountSeats()
    for (const seat of ['sidebar.brand.mark', 'conversation.hero.brand.mark']) {
      const tree = mounted.get(seat)({ size: 24, className: 'x' })
      expect(tree.type, `${seat} is not an svg`).toBe('svg')
      const html = textOf(tree).join('')
      expect(html.length, `${seat} renders no drawing`).toBeGreaterThan(1000)
      // The artwork's own plate and body, so this is that drawing and not something older.
      expect(html, `${seat} is not the artwork`).toContain('#0E1428')
      expect(html, `${seat} has no golden body`).toContain('#FFC93C')
    }
  })

  it('leaves the plate out of both seats, so the theme paints what is behind the mark', () => {
    // THE PLATE IS A FIXED DARK ROUNDED SQUARE, which is right for an application icon and wrong in a seat
    // whose surface the theme already paints: it stayed dark on a light scheme. It is removed from the
    // verbatim markup by a transform rather than by keeping an edited copy, so this test is what notices if
    // that transform stops matching — a plate that reappears would otherwise look like a deliberate change.
    const mounted = mountSeats()
    for (const seat of ['sidebar.brand.mark', 'conversation.hero.brand.mark']) {
      const html = textOf(mounted.get(seat)({ size: 24 })).join('')
      // The plate's own rectangles, its grid, and the shadow it cast.
      expect(html, `${seat} still draws the plate`).not.toContain('<rect x="48"')
      expect(html, `${seat} still draws the plate's grid`).not.toContain('#7FB8FF')
      expect(html, `${seat} still draws the plate's shadow`).not.toContain('cx="512" cy="920"')
      // And the bee itself is still there, so removing the plate did not remove the mark.
      expect(html, `${seat} lost the bee`).toContain('#FFC93C')
      expect(html, `${seat} lost its wings`).toContain('#9FD8FF')
    }
  })

  it('namespaces the ids per seat, so two seats cannot collide in one document', () => {
    const mounted = mountSeats()
    const htmlOf = (seat) => textOf(mounted.get(seat)({ size: 24 })).join('')
    const sidebar = htmlOf('sidebar.brand.mark')
    const hero = htmlOf('conversation.hero.brand.mark')
    expect(sidebar).not.toBe(hero)
    // Every id and every reference must carry the seat's own prefix.
    for (const [seat, html, prefix] of [['sidebar', sidebar, 'qk-sidebar-'], ['hero', hero, 'qk-hero-']]) {
      for (const [, id] of html.matchAll(/id="([^"]+)"/gu)) {
        expect(id.startsWith(prefix), `${seat}'s id ${id} is not namespaced`).toBe(true)
      }
      for (const [, ref] of html.matchAll(/url\(#([^)]+)\)/gu)) {
        expect(ref.startsWith(prefix), `${seat}'s reference ${ref} is not namespaced`).toBe(true)
      }
    }
  })
})
