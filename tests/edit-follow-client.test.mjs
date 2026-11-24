/**
 * The edit-follow bundle's browser half, executed against a stub loader.
 *
 * WHY A STUB AND NOT A WINDOW. `ctx.sidebarRight`, `chat` view targets and the
 * `settings.general.item` slot exist only in a browser, and this environment cannot render
 * one — so the bundle is lifted out of its file and run against a fake `__ModuleLoader__`,
 * a fake `require`, a minimal React, a controllable clock and a recording client context.
 * That covers what the bundle *does* while leaving the pixels to a real desktop, the same
 * division `tests/theme-client.test.mjs` uses.
 *
 * WHAT THIS FILE IS REALLY FOR. Following is ON by default, and that is only defensible
 * because three rules hold: it must not move a COLLAPSED column, it must stop when the
 * user opens something else, and it must not act on subagent work. Those are the
 * assertions that matter here, and they are written as behaviour — drive a snapshot, read
 * where `openResource` was asked to go — rather than as greps for the code that implements
 * them.
 *
 * WHAT IS NOT COVERED, STATED PLAINLY: nothing here proves the preview actually moves in a
 * window, nor that a subagent really is invisible from the parent Session's snapshot. The
 * first is `edit-follow-probe`'s and a desktop's job; the second is a fact about the
 * harness's Session topology, which is why the bundle relies on it structurally rather
 * than by checking.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const BUNDLE = join(ROOT, 'packages', 'qialike-desktop-edit-follow', 'lib', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')

/** The module id the bundle registers itself under; also the row's package name. */
const PLUGIN_ID = '@qialike/qialike-desktop-edit-follow'

/** The workspace every test's Session runs in. */
const CWD = '/work/project'

/**
 * A React that is enough for a component function to be *called*.
 *
 * `useState` returns the initial value and a setter that does nothing, `useEffect` runs
 * nothing, and `createElement` builds a plain object tree. Deliberately not a renderer:
 * the assertions are about what the bundle asks the platform to do, and a real render
 * would add a dependency this repository does not carry.
 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

/**
 * Load the bundle and return its registered factory.
 *
 * The clock is injected into the vm realm rather than swapped on the host's `globalThis`:
 * the bundle executes inside its own context and resolves `setTimeout` there, so replacing
 * the host's would leave the bundle on the real timer and make every debounce assertion
 * depend on wall-clock time.
 *
 * @param globals - the extra globals the bundle will see.
 * @returns the factory the bundle handed to `__ModuleLoader__`.
 */
function loadFactory(globals) {
  let captured
  const context = createContext({
    window: { __ModuleLoader__: { load: (entry) => { captured = entry } } },
    console: { error: () => {}, warn: () => {} },
    ...globals,
  })
  new Script(SOURCE, { filename: BUNDLE }).runInContext(context)
  expect(captured?.id, 'the bundle did not register itself').toBe(PLUGIN_ID)
  return captured.factory
}

/**
 * A clock the test advances by hand.
 *
 * The bundle's debounce is the one piece of timing behaviour worth asserting, and a real
 * timer would make the suite slow and flaky in equal measure.
 */
function makeClock() {
  let nextId = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    /** Run every timer that has not been cleared, as the host would after `ms`. */
    run: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const timer of pending) timer.fn()
    },
    /** How many timers are outstanding, for asserting that a restart cancelled one. */
    pending: () => timers.size,
  }
}

/**
 * A chat node wrapping one tool call, shaped as the bundle reads it.
 *
 * Built the way the harness builds one — `{ kind: 'tool-call', data: { root } }` — rather
 * than as a loose stub, so a change to that access path fails here rather than in a window.
 */
function toolCallNode({ callId, name, args, turn = 1, phase = 'start', parentCallId }) {
  const root = { callId, name, turn, step: 1, time: 0, subCalls: [], phase }
  if (phase === 'start') root.argsRaw = typeof args === 'string' ? args : JSON.stringify(args)
  if (parentCallId !== undefined) root.parentCallId = parentCallId
  return { kind: 'tool-call', data: { root } }
}

/**
 * A recording client context whose services the test drives directly.
 *
 * @param options.enabled - what the host route answers for the stored switch.
 * @param options.routeFails - make every fetch reject, as an unreachable host would.
 * @param options.saveFails - make the POST answer with a refusal.
 * @returns the context, the clock, and the records and drivers the assertions use.
 */
function makeContext({ enabled = true, routeFails = false, saveFails = false } = {}) {
  const clock = makeClock()
  const slots = []
  const dictionaries = []
  const opened = []
  /** Set by the returned `failNextOpen`, consumed by the next `openResource`. */
  let failNext = false
  /** Opens that threw, kept apart from `opened` so "nothing opened" stays assertable. */
  const attempts = []
  const posts = []
  const fetches = []
  const mountedListeners = new Set()
  /** Everything the bundle has asked to be told about, so teardown can be checked. */
  const disposals = []
  /** The teardowns of the effects the bundle registered. */
  const effects = []

  let mounted = 'session-1'
  let chatSnapshot = { nodes: { values: () => [] } }
  /** Whether the right column is showing its panel. */
  let expanded = true
  /** The tab the column considers active; `contentId` is the resource address. */
  let active

  const sidebarRight = {
    openResource: (address, options) => {
      // A THROW IS HOW THE SIDEBAR REPORTS "NO TAB TYPE TAKES THIS ADDRESS", which is the shape
      // the row has to survive and the shape the blocked-declaration tests drive. Recorded
      // before throwing so an assertion can still see what was attempted.
      if (failNext) {
        failNext = false
        // NOT pushed to `opened`: a throw means nothing was placed, and every assertion in this
        // file means "where did the preview actually move". The attempt is its own record.
        attempts.push({ address, options })
        throw new Error('no tab type accepts ' + address)
      }
      opened.push({ address, options })
      // `openResource` places the tab and reveals the column in one step, so the tab it
      // just opened becomes the active one. Modelled because "the user took over" is
      // detected by comparing against exactly this.
      active = { id: 'tab-' + String(opened.length), kind: 'text', contentId: address, title: 'file' }
    },
    active: () => active,
    isExpanded: () => expanded,
    mounted: {
      getSnapshot: () => mounted,
      subscribe: (listener) => {
        mountedListeners.add(listener)
        return () => {
          mountedListeners.delete(listener)
          disposals.push('mounted')
        }
      },
    },
  }

  /**
   * One chat source per Session, parent and children alike.
   *
   * A single shared source would let a subagent test pass by reading the parent's
   * conversation, and would hide the very thing the child channel exists for — that a
   * subagent's calls arrive on a DIFFERENT session's stream.
   */
  const sessionSnapshots = new Map()
  const sessionListeners = new Map()
  const sessionChatSources = new Map()
  const chatSource = (sessionId) => {
    let source = sessionChatSources.get(sessionId)
    if (source !== undefined) return source
    source = {
      getSnapshot: () => sessionSnapshots.get(sessionId) ?? { nodes: { values: () => [] } },
      subscribe: (listener) => {
        const set = sessionListeners.get(sessionId) ?? new Set()
        set.add(listener)
        sessionListeners.set(sessionId, set)
        return () => {
          set.delete(listener)
          disposals.push(`chat:${sessionId}`)
        }
      },
    }
    sessionChatSources.set(sessionId, source)
    return source
  }

  /** The catalog each Session's projection reports. */
  const catalogs = new Map()
  const catalogListeners = new Set()
  const refreshed = []

  const ctx = {
    get: (service) => {
      if (service === 'sidebarRight') return sidebarRight
      if (service === 'uiConversation') {
        return { binding: (binding) => ({ target: () => chatSource(binding.sessionId) }) }
      }
      if (service === 'sessions') {
        return {
          binding: (sessionId) => (sessionId === undefined ? undefined : { sessionId }),
          list: {
            getSnapshot: () => ({
              byId: { 'session-1': { cwd: CWD }, 'session-2': { cwd: '/other' } },
              projectionsBySession: Object.fromEntries(
                [...catalogs].map(([id, entries]) => [id, { state: 'ready', error: null, values: { subagentCatalog: entries } }]),
              ),
            }),
            subscribe: (listener) => {
              catalogListeners.add(listener)
              return () => { catalogListeners.delete(listener) }
            },
          },
          refreshProjections: (sessionId) => { refreshed.push(sessionId); return Promise.resolve() },
        }
      }
      return undefined
    },
    locale: {
      register: (namespace, values) => { dictionaries.push({ namespace, values }) },
      // The real `t` does two things, and the fake must do both or it tests neither: it
      // resolves the key against the registered dictionary, then substitutes its parameters.
      // A fake that only interpolated would substitute into the KEY — which has no
      // placeholders — and every sentence assertion below would silently be checking a key.
      // Resolving means a missing key shows up here as the key itself, exactly as it does in
      // a window.
      bind: (namespace) => (key, params) => {
        const values = dictionaries.find((entry) => entry.namespace === namespace)?.values
        let text = values?.en?.[key] ?? key
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value))
          }
        }
        return text
      },
    },
    slots: {
      inject: (name, callback) => { callback() },
      register: (options, component) => {
        // The injected face is called here, as the real renderer calls it: a `hooks`
        // compartment only exists if the seat resolves it, and a test that skipped this
        // would render the notice against no data and pass for the wrong reason.
        const injected = typeof options.inject === 'function' ? options.inject() : undefined
        slots.push({ options, component, injected })
        return () => { disposals.push('slot') }
      },
    },
    effect: (callback) => {
      const dispose = callback()
      const teardown = () => { if (typeof dispose === 'function') dispose() }
      effects.push(teardown)
      return teardown
    },
  }

  const fetchImpl = async (url, options) => {
    fetches.push(url)
    if (routeFails) throw new Error('unreachable')
    if (options?.method === 'POST') {
      posts.push(JSON.parse(options.body))
      if (saveFails) return { ok: false, json: async () => ({ ok: false, message: 'read-only home' }) }
      const body = JSON.parse(options.body)
      return { ok: true, json: async () => ({ ok: true, enabled: body.enabled }) }
    }
    return { ok: true, json: async () => ({ ok: true, enabled, default: true }) }
  }

  /**
   * Render the subagent notice row, as the renderer would.
   *
   * The seat supplies the `hooks` compartment bound as `use<Name>`; this builds that from
   * whatever the registration's inject face returned, so the assertion runs against the
   * bundle's real source rather than a stand-in.
   *
   * @returns the element tree, or undefined when the row is not registered.
   */
  function renderNotice() {
    const row = slots.find((entry) => entry.options.id === 'qialike-edit-follow-notice')
    if (row === undefined) return undefined
    const source = row.injected?.hooks?.subagentEdits
    const props = {
      useSubagentEdits: () => (source === undefined ? [] : source.getSnapshot()),
    }
    return row.component(props)
  }

  /**
   * Publish one Session's chat snapshot and notify its listeners.
   *
   * A closure rather than a method: the tests destructure these helpers, and a method using
   * `this` throws the moment it is detached.
   *
   * @param sessionId - whose conversation moved.
   * @param nodes - the tool-call nodes the snapshot holds.
   * @param options.settle - whether to advance the clock past the debounce.
   */
  function drive(sessionId, nodes, { settle = true } = {}) {
    sessionSnapshots.set(sessionId, { nodes: { values: () => nodes } })
    for (const listener of [...(sessionListeners.get(sessionId) ?? [])]) listener()
    if (settle) clock.run()
  }

  return {
    ctx, fetchImpl, clock,
    renderNotice,
    records: {
      attempts,
      slots, dictionaries, opened, posts, fetches, disposals, effects, mountedListeners,
      refreshed, sessionListeners, catalogListeners,
      /** The live chat listeners of one Session, for teardown assertions. */
      listenersOf: (sessionId) => sessionListeners.get(sessionId) ?? new Set(),
      /** The notice row's rendered text, or an empty string when it renders nothing. */
      notices: () => (renderNotice() === null || renderNotice() === undefined
        ? ''
        : collectText(renderNotice()).join(' ')),
      /**
       * Press one of the notice's buttons, found by the copy the bundle registers.
       *
       * The label is resolved from the dictionary rather than compared to the key, because
       * that is what a user clicks: matching on `notice.jump` would pass while the button
       * read as an untranslated key in the window.
       *
       * @param key - the dictionary key of the button.
       */
      press: (key) => {
        const values = dictionaries.find((entry) => entry.namespace === 'qialike-edit-follow')?.values
        const wanted = values?.en?.[key] ?? key
        const button = find(renderNotice(), (node) => node.type === 'button'
          && collectText(node).join(' ').includes(wanted))
        button?.props.onClick()
      },
    },
    /**
     * Publish one Session's chat snapshot and let the bundle react.
     *
     * @param sessionId - whose conversation moved.
     * @param nodes - the tool-call nodes the snapshot holds.
     * @param options.settle - whether to advance the clock past the debounce.
     */
    drive,
    /** Publish the on-screen Session's snapshot: the common case, and what most tests mean. */
    driveChat: (nodes, { settle = true } = {}) => drive(mounted, nodes, { settle }),
    /** Seed the on-screen Session WITHOUT notifying, as an already-loaded Session looks. */
    seedChat(nodes) { sessionSnapshots.set(mounted, { nodes: { values: () => nodes } }) },
    setExpanded: (value) => { expanded = value },
      /** Make the NEXT `openResource` throw, as one whose address no tab type accepts does. */
      failNextOpen: () => { failNext = true },
    setActive: (tab) => { active = tab },
    setMounted: (sessionId) => {
      mounted = sessionId
      for (const listener of [...mountedListeners]) listener()
    },
    /** Publish a Session's child catalog and notify, as the Host's projection would. */
    setChildren(parentId, entries) {
      catalogs.set(parentId, entries)
      for (const listener of [...catalogListeners]) listener()
    },
    /** Publish one child Session's snapshot. Named for what the test is about. */
    driveChild: (childId, nodes) => drive(childId, nodes),
    activeTab: () => active,
  }
}

/**
 * Run `apply` and let the initial settings fetch settle.
 *
 * @param options - passed to {@link makeContext}.
 * @returns the harness, the exports, and the row component.
 */
async function applied(options) {
  const harness = makeContext(options)
  const factory = loadFactory({ fetch: harness.fetchImpl, ...harness.clock })
  const exported = factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })
  expect(exported.apply, 'the bundle exports no apply').toBeTypeOf('function')
  expect(exported.inject, 'the bundle exports no inject').toEqual(
    expect.arrayContaining(['slots', 'locale', 'sessions', 'uiConversation', 'sidebarRight']),
  )
  exported.apply(harness.ctx)
  // Two microtask turns: the fetch, then the `then` chained onto it.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  const row = harness.records.slots.find((entry) => entry.options.id === 'qialike-edit-follow')
  return { ...harness, exported, row }
}

/** The address the bundle should build for a workspace-relative path. */
const addressFor = (path) => `dsh-resource://file/session/session-1/${path}`

describe('the bundle itself', () => {
  it('is self-contained: no relative require, which upstream never uses either', () => {
    // The loader's `require` resolves against its module table, so a relative specifier
    // would fail at materialization — inside a window, where nothing here could see it.
    expect(SOURCE).not.toMatch(/require\(\s*['"]\./u)
  })

  it('asks for only the modules the loader provides', () => {
    const requested = [...SOURCE.matchAll(/require\(\s*'([^']+)'\s*\)/gu)].map((match) => match[1])
    expect(new Set(requested)).toEqual(new Set(['react']))
  })

  it('fetchs the document-relative route, not a root-absolute one', () => {
    const path = /const API = '([^']+)'/u.exec(SOURCE)
    expect(path, 'the bundle declares no API path').not.toBeNull()
    expect(path[1].startsWith('/')).toBe(false)
    expect(path[1]).toBe('api/qialike/edit-follow')
  })
})

describe('the settings row', () => {
  it('registers into settings.general.item, after the theme row and before developer tools', async () => {
    const { row, records } = await applied()
    expect(records.slots.map((entry) => entry.options.name)).toContain('settings.general.item')
    expect(row.options.order).toBeGreaterThan(12)
    expect(row.options.order).toBeLessThan(15)
  })

  it('declares its locale namespace, so the row has a `t` seat', async () => {
    const { row, records } = await applied()
    expect(row.options.locale).toBe('qialike-edit-follow')
    expect(records.dictionaries.map((entry) => entry.namespace)).toContain('qialike-edit-follow')
  })

  it('reads the switch from the host, and shows the host’s answer', async () => {
    const { row } = await applied({ enabled: false })
    // `component()` takes no props: the harness's slot contract passes no arbitrary props
    // into a registered component, so everything the row renders comes from the closure.
    const texts = collectText(row.component())
    expect(texts).toContain('Off')
  })

  it('turns following off when the host cannot be reached, and says so', async () => {
    // The default is what the host answers when the document does not say — a real answer.
    // A failed request is no answer at all, and following a user who turned the feature off
    // is the worse of the two ways to be wrong.
    const { row, statements } = await applied({ routeFails: true })
    const texts = collectText(row.component())
    expect(texts).toContain('Could not read the setting from the host.')
    expect(texts).toContain('Until the setting can be read, following stays off.')
    void statements
  })

  it('opens nothing while the switch is unknown', async () => {
    const { driveChat, records } = await applied({ routeFails: true })
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened).toEqual([])
  })
})

describe('opening a declared deliverable', () => {
  it('opens a declared file, as a session-scoped address', async () => {
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('a.txt')])
  })

  it('resolves an absolute path inside the workspace to a workspace-relative one', async () => {
    // The file resource is keyed by the workspace-relative path, which is what makes a
    // session-scoped address resolvable by the Host at all.
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: CWD + '/src/a.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('src/a.txt')])
  })

  it('leaves an absolute path outside the workspace absolute', async () => {
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: '/elsewhere/a.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('/elsewhere/a.txt')])
  })

  it('normalises Windows separators', async () => {
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: CWD + '\\src\\a.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('src/a.txt')])
  })

  it('sends no placement options, so an already-open file is revealed rather than duplicated', async () => {
    // `openResource` reveals an existing `(kind, contentId)` by default. Passing
    // `revealIfOpened: false` would stack a tab per edit; passing nothing keeps the
    // default behaviour as the only one this row can have.
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened[0].options).toBeUndefined()
  })

  it('opens the files a present call declares as the turn’s deliverables', async () => {
    // THE CASE THAT MOTIVATED THIS. A script written by `write` renders a file when it RUNS,
    // so the output is named by no argument of any tool call — the follow loop saw the
    // script and stopped there. `present` is the harness's own declaration for exactly that
    // ("including files created through shell commands"), so it is the only signal the final
    // file leaves behind.
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({
      callId: 'c1',
      name: 'present',
      args: { files: [{ path: 'out/report.pdf', description: 'the report' }] },
    })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('out/report.pdf')])
  })

  it('opens every declared deliverable, in the order declared', async () => {
    // The tool documents `files` as "the 1-2 most important deliverables", so both are
    // wanted; the last one ends up on top, matching the debounce rule that the last target
    // of a run wins.
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({
      callId: 'c1',
      name: 'present',
      args: { files: [{ path: 'a.png' }, { path: 'b.png' }] },
    })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('a.png'), addressFor('b.png')])
  })

  it('opens a declaration even when the window holds more edits than the multi rule allows', async () => {
    // A run that writes ten files must not follow — there is no single "file being edited".
    // A DECLARATION is not that: the model named these. Letting the multi rule veto it is
    // the exact failure this change exists to remove.
    const { driveChat, records } = await applied()
    const writes = Array.from({ length: 6 }, (_, i) => toolCallNode({
      callId: `w${i}`, name: 'present', args: { files: [{ path: `step-${i}.txt` }] },
    }))
    driveChat([...writes, toolCallNode({
      callId: 'p1', name: 'present', args: { files: [{ path: 'final.pdf' }] },
    })])
    expect(records.opened.map((entry) => entry.address).at(-1)).toBe(addressFor('final.pdf'))
  })

  it('ignores a present call that declares no usable path', async () => {
    // A rejected call declares nothing; moving the preview would be navigation with no cause.
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [] } })])
    driveChat([toolCallNode({ callId: 'c2', name: 'present', args: { files: [{ description: 'no path' }] } })])
    driveChat([toolCallNode({ callId: 'c3', name: 'present', args: 'not json' })])
    expect(records.opened).toEqual([])
  })

    it('ignores a declaration whose path names no file', async () => {
      // A blank path names nothing, so opening it would be navigation with no cause.
      const { driveChat, records } = await applied()
      driveChat([
        toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: '   ' }] } }),
        toolCallNode({ callId: 'c2', name: 'present', args: { files: [{ path: '' }] } }),
      ])
      expect(records.opened).toEqual([])
    })

  it('ignores a call whose arguments are not JSON at all', async () => {
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: 'not json' })])
    expect(records.opened).toEqual([])
  })

  it('ignores a call still preparing, whose arguments are incomplete by definition', async () => {
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', phase: 'preparing' })])
    expect(records.opened).toEqual([])
  })

  it('ignores a PTC dispatch child, whose work belongs to its parent call', async () => {
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({
      callId: 'c1', name: 'present', parentCallId: 'root',
      args: { file_path: 'a.txt', content: 'x' },
    })])
    expect(records.opened).toEqual([])
  })

  it('acts once per call, however often the snapshot is republished', async () => {
    const { driveChat, records } = await applied()
    const node = toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })
    driveChat([node])
    driveChat([node])
    driveChat([node])
    expect(records.opened).toHaveLength(1)
  })

  it('seeds a Session already on screen instead of opening its last declaration', async () => {
    // Following what the agent did BEFORE the user arrived would be a navigation they did
    // not ask for and cannot predict.
    const { seedChat, clock, records } = await applied()
    seedChat([toolCallNode({ callId: 'old', name: 'present', args: { files: [{ path: 'old.txt' }] } })])
    clock.run()
    expect(records.opened).toEqual([])
  })
})

describe('process files are never opened', () => {
  // THE RULE THIS FILE EXISTS FOR, stated as the user stated it: the files an agent touches
  // while working must not move the preview. A "make me a Word document" turn writes a build
  // script, runs it for tens of seconds, and only then has a .docx — and the script opening
  // first is exactly what was reported.

  it('opens nothing for a write, an edit or a str_replace_editor mutation', async () => {
    const { driveChat, clock, records } = await applied()
    driveChat([
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'build_doc.py', content: 'x' } }),
      toolCallNode({ callId: 'c2', name: 'edit', args: { file_path: 'a.txt', old_string: 'a', new_string: 'b' } }),
      toolCallNode({ callId: 'c3', name: 'str_replace_editor', args: { command: 'create', path: 'b.txt', file_text: 'x' } }),
    ])
    // The clock is advanced past every window that used to exist: the point is that no window
    // is armed at all, not that one expired quietly.
    clock.run()
    expect(records.opened).toEqual([])
  })

  it('opens the deliverable even when the script that produced it is in a later window', async () => {
    // THE REPORTED SHAPE, end to end. The script is written in one publish, the document is
    // declared several seconds later; the script must never appear.
    const { driveChat, clock, records } = await applied()
    driveChat([toolCallNode({ callId: 'w1', name: 'write', args: { file_path: 'build_doc.py', content: 'x' } })])
    clock.run()
    expect(records.opened).toEqual([])
    driveChat([toolCallNode({ callId: 'p1', name: 'present', args: { files: [{ path: 'qialike.docx' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('qialike.docx')])
  })

  it('does not open a file the preview cannot render', async () => {
    // THE "only if it can be opened" HALF. `present` may name an archive or an executable, and
    // `openResource` throws when no registered tab type takes the address. Opening it anyway
    // would put an error tab in front of the user; the row reports instead of insisting.
    const { driveChat, records, failNextOpen } = await applied()
    failNextOpen()
    driveChat([toolCallNode({ callId: 'p1', name: 'present', args: { files: [{ path: 'bundle.zip' }] } })])
    expect(records.opened).toEqual([])
  })

  it('keeps opening later declarations after one that could not be opened', async () => {
    // A blocked declaration must not poison the takeover baseline: `lastOpened` is assigned
    // only after a successful open, so the next declaration is compared against the tab that
    // actually exists rather than one that never did.
    const { driveChat, records, failNextOpen } = await applied()
    failNextOpen()
    driveChat([toolCallNode({ callId: 'p1', name: 'present', args: { files: [{ path: 'bundle.zip' }] } })])
    expect(records.opened).toEqual([])
    driveChat([toolCallNode({ callId: 'p2', name: 'present', args: { files: [{ path: 'report.docx' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('report.docx')])
  })

  it('caps a single declaration past the limit, keeping the last', async () => {
    // The cap survives the change, but as a cap rather than a veto: a declaration is a named
    // deliverable, so refusing to open anything would be the wrong answer for a long list.
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({
      callId: 'p1',
      name: 'present',
      args: { files: ['a', 'b', 'c', 'd'].map((name) => ({ path: name + '.txt' })) },
    })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('d.txt')])
  })
})

describe('the three quieting rules', () => {
  it('never moves a collapsed column, because opening expands it', async () => {
    // Rule 1. `openResource` reveals the column in the same step, so following a collapsed
    // column would rearrange the window of a user who is not looking at it.
    const { driveChat, setExpanded, records } = await applied()
    setExpanded(false)
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened).toEqual([])
  })

  it('opens again once the column is expanded', async () => {
    const { driveChat, setExpanded, records } = await applied()
    setExpanded(false)
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    setExpanded(true)
    driveChat([toolCallNode({ callId: 'c2', name: 'present', args: { files: [{ path: 'b.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('b.txt')])
  })

  it('stops once the user opens something else', async () => {
    // Rule 2. This is the rule that makes an on-by-default navigation defensible at all.
    const { driveChat, setActive, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened).toHaveLength(1)
    // The user looks at a different tab.
    setActive({ id: 'other', kind: 'text', contentId: addressFor('something-else.txt'), title: 'other' })
    driveChat([toolCallNode({ callId: 'c2', name: 'present', args: { files: [{ path: 'b.txt' }] } })])
    expect(records.opened).toHaveLength(1)
  })

  it('resumes on the next turn, so one click does not disable it for the Session', async () => {
    const { driveChat, setActive, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] }, turn: 1 })])
    setActive({ id: 'other', kind: 'text', contentId: addressFor('elsewhere.txt'), title: 'other' })
    driveChat([toolCallNode({ callId: 'c2', name: 'present', args: { files: [{ path: 'b.txt' }] }, turn: 1 })])
    expect(records.opened).toHaveLength(1)
    // Turn 2 is a fresh start.
    driveChat([toolCallNode({ callId: 'c3', name: 'present', args: { files: [{ path: 'c.txt' }] }, turn: 2 })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('a.txt'), addressFor('c.txt')])
  })

  it('keeps opening while the active tab is the one it opened', async () => {
    // The rule must not fire on our own navigation, which is the failure that would make
    // the feature stop after a single edit.
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    driveChat([toolCallNode({ callId: 'c2', name: 'present', args: { files: [{ path: 'b.txt' }] } })])
    driveChat([toolCallNode({ callId: 'c3', name: 'present', args: { files: [{ path: 'c.txt' }] } })])
    expect(records.opened.map((entry) => entry.address))
      .toEqual([addressFor('a.txt'), addressFor('b.txt'), addressFor('c.txt')])
  })

  it('opens nothing from a subagent, because its calls are in another Session', async () => {
    // Rule 3 is structural rather than a check: a subagent runs in its own Session, so its
    // tool calls never reach this Session's chat snapshot. What this asserts is the
    // consequence — the parent follows only what its own snapshot carries.
    const { driveChat, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'own.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('own.txt')])
  })
})

describe('the subagent channel', () => {
  /** A catalog entry, shaped as the projection reports one. */
  const child = (id, label) => ({ id, label, mode: 'continuable' })

  it('subscribes to each child and reports its edit instead of following it', async () => {
    // THE RULE THIS WHOLE CHANNEL EXISTS FOR. A subagent works behind whatever the user is
    // looking at, so moving the preview for it would take the window from someone who did
    // not ask and cannot see why. The edit is reported; nothing navigates.
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'sub.txt', content: 'x' } }),
    ])
    expect(records.opened, 'a subagent edit must not move the preview').toEqual([])
    expect(records.notices()).toContain('sub.txt')
  })

  it('asks the Host for the catalog, so children spawned earlier are seen', async () => {
    const { records } = await applied()
    expect(records.refreshed).toContain('session-1')
  })

  it('opens for the parent while reporting the child, and keeps the two apart', async () => {
    const { driveChat, setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    driveChat([toolCallNode({ callId: 'p1', name: 'present', args: { files: [{ path: 'own.txt' }] } })])
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'sub.txt', content: 'x' } }),
    ])
    // The parent's edit moved the preview; the child's did not, and it is named in the notice.
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('own.txt')])
    expect(records.notices()).toContain('sub.txt')
  })

  it('scopes a child’s address to the child Session', async () => {
    // A session-scoped path is what lets the Host resolve a relative one, and the child's
    // workspace root is what its `file_path` was relative to — not the parent's.
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'src/sub.txt', content: 'x' } }),
    ])
    records.press('notice.jump')
    expect(records.opened.map((entry) => entry.address))
      .toEqual(['dsh-resource://file/session/session-child-1/src/sub.txt'])
  })

  it('names the child’s label in the notice, falling back to its id', async () => {
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-9', 'researcher')])
    driveChild('session-child-9', [
      toolCallNode({ callId: 'c1', name: 'edit', args: { file_path: 'a.txt', old_string: 'x', new_string: 'y' } }),
    ])
    // Both the file and the child are named: the row has to say who has something to look at.
    expect(records.notices()).toContain('researcher')
    expect(records.notices()).toContain('a.txt')
  })

  it('keeps one entry per child, naming its latest file', async () => {
    // A subagent that rewrites thirty files leaves one row, not thirty: the notice answers
    // "which subagent has something to look at".
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    for (const [index, name] of ['a', 'b', 'c', 'd'].entries()) {
      driveChild('session-child-1', [
        toolCallNode({ callId: `c${String(index)}`, name: 'write', args: { file_path: `${name}.txt`, content: 'x' } }),
      ])
    }
    const text = records.notices()
    expect(text).toContain('d.txt')
    expect(text).not.toContain('a.txt')
  })

  it('caps how many children it names at once', async () => {
    // A notice that grows without bound is the preemption it exists to avoid, moved from the
    // preview to the header.
    const { setChildren, driveChild, records } = await applied()
    const children = ['1', '2', '3', '4', '5'].map((n) => child(`session-child-${n}`, `child-${n}`))
    setChildren('session-1', children)
    for (const entry of children) {
      driveChild(entry.id, [
        toolCallNode({ callId: 'c1', name: 'write', args: { file_path: `${entry.id}.txt`, content: 'x' } }),
      ])
    }
    const text = records.notices()
    expect(text).toContain('and 4 more')
    expect(text).toContain('child-1.txt')
    expect(text).not.toContain('child-5.txt')
  })

  it('forgets a child’s report once the user acts on it', async () => {
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'sub.txt', content: 'x' } }),
    ])
    expect(records.notices()).toContain('sub.txt')
    records.press('notice.jump')
    expect(records.notices()).toBe('')
    // And the jump is what moved the preview, on the click rather than on the edit.
    expect(records.opened).toHaveLength(1)
  })

  it('forgets a child’s report when the user dismisses it instead', async () => {
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'sub.txt', content: 'x' } }),
    ])
    records.press('notice.dismiss')
    expect(records.notices()).toBe('')
    expect(records.opened, 'dismissing must not navigate').toEqual([])
  })

  it('releases a child that finished, and its report with it', async () => {
    // Both directions matter: a long Session must not accumulate a materialized snapshot per
    // child that ever ran.
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'sub.txt', content: 'x' } }),
    ])
    expect(records.listenersOf('session-child-1').size).toBe(1)
    setChildren('session-1', [])
    expect(records.listenersOf('session-child-1').size).toBe(0)
    expect(records.notices()).toBe('')
  })

  it('releases the children of a Session it leaves', async () => {
    const { setChildren, setMounted, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    expect(records.listenersOf('session-child-1').size).toBe(1)
    setMounted('session-2')
    expect(records.listenersOf('session-child-1').size).toBe(0)
  })

  it('reports nothing for a child that was already working when it bound', async () => {
    // Seeded, exactly as the parent's first read is: work that happened before the user
    // arrived is not news, and a row that appeared for it would be unexplained.
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'sub.txt', content: 'x' } }),
    ])
    records.press('notice.dismiss')
    // A second edit by the same child is new, and reported.
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'write', args: { file_path: 'sub.txt', content: 'x' } }),
      toolCallNode({ callId: 'c2', name: 'write', args: { file_path: 'later.txt', content: 'x' } }),
    ])
    expect(records.notices()).toContain('later.txt')
  })

  it('ignores a child call that cannot have changed a file', async () => {
    const { setChildren, driveChild, records } = await applied()
    setChildren('session-1', [child('session-child-1', 'scout')])
    driveChild('session-child-1', [
      toolCallNode({ callId: 'c1', name: 'read', args: { file_path: 'a.txt' } }),
      toolCallNode({ callId: 'c2', name: 'write', phase: 'preparing' }),
    ])
    expect(records.notices()).toBe('')
  })
})

describe('Session changes', () => {
  it('binds to the Session on screen and stops opening for the previous one', async () => {
    const { driveChat, setMounted, records } = await applied()
    setMounted('session-2')
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened.map((entry) => entry.address))
      .toEqual(['dsh-resource://file/session/session-2/a.txt'])
  })

  it('opens nothing for the Session it just left', async () => {
    const { driveChat, drive, setMounted, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    setMounted('session-2')
    // The Session it left still publishes on its own stream, and the bundle no longer holds
    // a subscription to it — so nothing follows from it.
    drive('session-1', [toolCallNode({ callId: 'c2', name: 'present', args: { files: [{ path: 'b.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('a.txt')])
  })

  it('survives a re-notification of the same Session', async () => {
    // `mounted` is an observable snapshot and may notify without the value moving. A
    // re-bind that dropped the live subscription would make following silently stop.
    const { driveChat, setMounted, records } = await applied()
    setMounted('session-1')
    setMounted('session-1')
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('a.txt')])
  })

  it('reports rather than throwing when there is no Session on screen', async () => {
    const { driveChat, setMounted, row, records } = await applied()
    setMounted(undefined)
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened).toEqual([])
    expect(collectText(row.component())).toContain('Waiting for a session to be on screen.')
  })
})

describe('the switch', () => {
  it('posts the requested value and nothing else', async () => {
    const { row, records } = await applied()
    pressSwitch(row)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(records.posts).toEqual([{ op: 'setEnabled', enabled: false }])
  })

  it('stops opening once it is turned off', async () => {
    const { row, driveChat, records } = await applied()
    pressSwitch(row)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened).toEqual([])
  })

  it('opens again when it is turned back on, clearing a previous takeover', async () => {
    // Turning the switch on is the explicit "start following" action, so it is one of the
    // two ways out of a takeover.
    const { row, driveChat, setActive, records } = await applied()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    setActive({ id: 'other', kind: 'text', contentId: addressFor('elsewhere.txt'), title: 'other' })
    pressSwitch(row)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    pressSwitch(row)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    driveChat([toolCallNode({ callId: 'c2', name: 'present', args: { files: [{ path: 'b.txt' }] } })])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('a.txt'), addressFor('b.txt')])
  })

  it('reports a failed save, because the control would otherwise lie', async () => {
    // A switch that stays where it was put while the write failed is the one outcome a
    // user cannot detect.
    const { row, records } = await applied({ saveFails: true })
    pressSwitch(row)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(records.posts).toHaveLength(1)
    expect(collectText(row.component())).toContain('The change was not saved and will not survive a restart.')
    expect(switchOf(row).props['aria-checked']).toBe(true)
  })

  it('retries the read from its failure state', async () => {
    const { row, records } = await applied({ routeFails: true })
    expect(collectText(row.component())).toContain('Could not read the setting from the host.')
    pressRetry(row)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(records.fetches.length).toBeGreaterThan(1)
  })
})

describe('teardown', () => {
  it('releases the Session and chat subscriptions when its effects are disposed', async () => {
    // Registry contributions prove disposal. A bundle that left a chat subscription behind
    // would keep opening previews after its own row was gone — and the mounted listener
    // would keep re-binding on every Session change.
    const { records } = await applied()
    expect(records.mountedListeners.size).toBe(1)
    expect(records.listenersOf('session-1').size).toBe(1)

    for (const teardown of records.effects) teardown()

    expect(records.mountedListeners.size).toBe(0)
    expect(records.listenersOf('session-1').size).toBe(0)
  })

  it('opens nothing after teardown', async () => {
    const { records, driveChat } = await applied()
    for (const teardown of records.effects) teardown()
    driveChat([toolCallNode({ callId: 'c1', name: 'present', args: { files: [{ path: 'a.txt' }] } })])
    expect(records.opened).toEqual([])
  })
})

/** The switch control in a rendered row. */
function switchOf(row) {
  const found = find(row.component(), (node) => node.props?.role === 'switch')
  expect(found, 'the row rendered no switch').toBeDefined()
  return found
}

/** Press the switch, as a click would. */
function pressSwitch(row) {
  const control = switchOf(row)
  expect(control.props.disabled, 'the switch was disabled').toBeFalsy()
  control.props.onClick()
}

/** Press the retry button in the failed state. */
function pressRetry(row) {
  const button = find(row.component(), (node) => node.type === 'button' && node.props?.onClick !== undefined)
  expect(button, 'the failure state rendered no retry').toBeDefined()
  button.props.onClick()
}

/** Find the first node satisfying a predicate. */
function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = find(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/** Every string in an element tree, for asserting on rendered copy. */
function collectText(node) {
  if (typeof node === 'string') return [node]
  if (node === null || typeof node !== 'object') return []
  const out = []
  for (const child of node.children ?? []) out.push(...collectText(child))
  return out
}

void DIST_DIR

describe('a declared document is not raced by the script that produced it', () => {
  // THE SHAPE OF A REAL "MAKE ME A WORD DOCUMENT" TURN, reconstructed from a session log:
  //
  //     write  build_doc.py        ← recorded as an edit
  //     bash   python3 build_doc.py  ← tens of seconds, the .docx appears here
  //     present qialike.docx        ← the deliverable, declared
  //
  // The script and the declaration are more than 400 ms apart, so they landed in DIFFERENT
  // debounce windows: the script's window expired and opened it, and the declaration opened
  // the document second. The user saw the process file first — which is the complaint.

  it('opens the deliverable immediately, without waiting for the debounce', async () => {
    const { driveChat, records } = await applied()
    // `settle: false` IS THE POINT OF THIS TEST. The helper advances the clock past the
    // debounce by default, which made the assertion pass even when the bundle went back to a
    // delayed flush — a green test that proved nothing. Measured: reverting the immediate
    // flush left all 59 tests passing before this was fixed.
    driveChat([toolCallNode({
      callId: 'p1', name: 'present', args: { files: [{ path: 'qialike 智能体.docx' }] },
    })], { settle: false })
    // No timer advance: a declaration is the end of a run, so there is nothing left to wait for.
    // The address is percent-encoded because a document named in Chinese has to be — asserting
    // the encoded form is what pins that, rather than hiding it behind a helper that does not
    // encode.
    expect(records.opened.map((entry) => entry.address))
      .toEqual(['dsh-resource://file/session/session-1/qialike%20%E6%99%BA%E8%83%BD%E4%BD%93.docx'])
  })

  it('does not open the script in the same window as the document it declares', async () => {
    // Both in one window is the case the debounce does cover, and the rule there is the same
    // one: what the model declared is the answer, what it touched on the way is not.
    const { driveChat, records } = await applied()
    driveChat([
      toolCallNode({ callId: 'w1', name: 'write', args: { file_path: 'build_doc.py', content: 'x' } }),
      toolCallNode({ callId: 'p1', name: 'present', args: { files: [{ path: 'report.docx' }] } }),
    ])
    expect(records.opened.map((entry) => entry.address)).toEqual([addressFor('report.docx')])
    expect(records.opened.map((entry) => entry.address)).not.toContain(addressFor('build_doc.py'))
  })
})
