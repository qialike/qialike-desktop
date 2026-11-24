/**
 * The continuous voice-input bundle, executed against a stub loader and a fake clock.
 *
 * WHY A STUB AND NOT A WINDOW. A microphone, an `AudioContext` and the speech Remote exist
 * only in a browser, and this environment has no audio device at all — `pactl` reports one
 * HDMI monitor loopback on the machine this was written on. So the bundle is lifted out of
 * its file and run against a fake `__ModuleLoader__`, a minimal React and a recording context,
 * the way the theme and edit-follow suites do. What that covers is the part with logic in it:
 * where the sentence boundaries fall, what a segment's bytes are, and where the control
 * registers. The pixels and the recognizable words are a real desktop's business.
 *
 * WHAT IS DELIBERATELY PINNED HERE, and why each one would be a defect if it regressed:
 *
 *   · THE BOUNDARY RULE. One pause, one transcription. A test that only asserted "a segment
 *     was produced" would pass for an implementation that emitted a segment per frame.
 *   · THE MINIMUM LENGTH. A cough must not become a transcription; the recognizer answers
 *     noise with punctuation, and punctuation in the draft is worse than nothing.
 *   · THE PRE-ROLL. The audio just BEFORE the first loud frame is what carries the opening
 *     consonant of a sentence. Dropping it truncates every sentence's first phoneme.
 *   · THE WAV HEADER. Measured against the Host: it rejects raw PCM with `Invalid speech
 *     WAV`, so the container is not cosmetic — a wrong field means every sentence fails.
 *   · THE SLOT. `conversation.input.activity` is a `single` slot the harness's own microphone
 *     occupies; registering there would conflict and take that control down. The list slot is
 *     the decision, so it is asserted rather than assumed.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const BUNDLE = join(ROOT, 'packages', 'qialike-desktop-voice', 'lib', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')
const PLUGIN_ID = '@qialike/qialike-desktop-voice'

/** A React that is enough for a component to be *called*, never rendered. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

/**
 * Load the bundle and hand back its module object.
 *
 * The fake clock is mutable on purpose: the segmenter decides boundaries with
 * `performance.now()`, so a test that could not move time could not test a boundary at all.
 *
 * @returns the module, the loader entry, and the clock.
 */
function load() {
  let captured
  const clock = { now: 0 }
  const context = createContext({
    console: { error: () => {}, warn: () => {} },
    React,
    window: {
      __ModuleLoader__: { load: (entry) => { captured = entry } },
      localStorage: {
        store: new Map(),
        getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
        setItem(key, value) { this.store.set(key, value) },
      },
    },
    performance: { now: () => clock.now },
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    navigator: { mediaDevices: undefined },
    document: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
  })
  new Script(SOURCE, { filename: BUNDLE }).runInContext(context)
  expect(captured?.id, 'the bundle did not register itself').toBe(PLUGIN_ID)
  const module = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return { module, entry: captured, clock, context }
}

/** The module-level constants, read through the bundle's own test export. */
function helpers() {
  return load().module.__test
}

// ── the artifact contract ───────────────────────────────────────────────────

describe('the continuous voice bundle as a client module', () => {
  it('registers under its package name, with the two halves the loader expects', () => {
    const { module, entry } = load()
    expect(entry.id).toBe(PLUGIN_ID)
    expect(typeof module.apply).toBe('function')
    // Services, not packages. `remote` is the namespace root and is load-bearing: declaring
    // only `remote.speech` leaves `ctx.remote` guarded, which fails at the first transcription
    // rather than at load — measured.
    expect(module.inject).toEqual(['remote', 'slots', 'locale'])
  })

  it('registers its dictionary under its own namespace', () => {
    const { module } = load()
    const registered = []
    const ctx = {
      effect: (fn) => { fn(); return () => {} },
      locale: { register: (ns, dict) => { registered.push({ ns, dict }); return () => {} }, bind: () => (key) => key },
      inject: () => Promise.resolve(() => {}),
    }
    module.apply(ctx)
    expect(registered).toHaveLength(1)
    expect(registered[0].ns).toBe('qialike-voice')
    // Both languages, and the same key set, so neither falls back mid-panel.
    expect(Object.keys(registered[0].dict).sort()).toEqual(['en', 'zh'])
    expect(Object.keys(registered[0].dict.en).sort()).toEqual(Object.keys(registered[0].dict.zh).sort())
  })

  it('offers a way into its own settings, because the button already toggles dictation', () => {
    // The microphone button's click is spoken for. On a machine with more than one input —
    // this one has a Bluetooth headset beside an HDMI monitor loopback — the device selector
    // is the difference between working and recording silence, so it needs an entrance that
    // is not a conflict dialog.
    const bundle = readFileSync(BUNDLE, 'utf8')
    expect(bundle).toContain("'aria-expanded': open")
    expect(bundle).toContain("setOpen(!open)")
    expect(bundle).toMatch(/'settings': 'Voice input settings'/)
  })

  it('registers into a LIST slot, never the single one the shipped microphone owns', () => {
    // `conversation.input.activity` is `single`, so a second occupant is a conflict that takes
    // the harness's own microphone down with it. This is the whole reason the feature is a
    // separate control rather than a switch on that one.
    const { module } = load()
    const registered = []
    const ctx = {
      effect: (fn) => { fn(); return () => {} },
      locale: { register: () => () => {}, bind: () => (key) => key },
      inject: (_services, callback) => {
        callback({
          remote: { speech: { catalog: async () => ({ ok: true, value: {} }), transcribe: async () => ({ ok: true, value: {} }) } },
          slots: {
            inject: (name, register) => { register() },
            register: (options, component) => { registered.push({ options, component }) },
          },
        })
        return Promise.resolve(() => {})
      },
    }
    module.apply(ctx)
    expect(registered).toHaveLength(1)
    expect(registered[0].options.name).toBe('conversation.input.right')
    expect(registered[0].options.id).toBe('qialike-voice')
    // The Remote is handed over through `inject`, because the component calls it and the
    // slot's standard props do not include it.
    expect(typeof registered[0].options.inject().speech.transcribe).toBe('function')
  })
})

// ── the audio helpers ──────────────────────────────────────────────────────

describe('the WAV container the transcriber validates', () => {
  it('writes a canonical 16 kHz mono 16-bit header', () => {
    // MEASURED: the Host answers `Invalid speech WAV` for raw PCM, so every field here is
    // load-bearing rather than decorative.
    const { encodeWave } = helpers()
    const samples = new Float32Array(800) // 50 ms at 16 kHz
    const bytes = encodeWave(samples)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const text = (at, length) => String.fromCharCode(...bytes.subarray(at, at + length))

    expect(bytes.byteLength).toBe(44 + samples.length * 2)
    expect(text(0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8)
    expect(text(8, 4)).toBe('WAVE')
    expect(text(12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)   // PCM chunk size
    expect(view.getUint16(20, true)).toBe(1)    // uncompressed
    expect(view.getUint16(22, true)).toBe(1)    // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000) // byte rate = rate * block align
    expect(view.getUint16(32, true)).toBe(2)     // block align
    expect(view.getUint16(34, true)).toBe(16)    // bits per sample
    expect(text(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
  })

  it('clamps out-of-range samples instead of wrapping them', () => {
    // A wrapped sample is a full-scale click in the middle of a sentence, which a recognizer
    // hears as a consonant. Clamping keeps it a loud version of the same waveform.
    const { encodeWave } = helpers()
    const bytes = encodeWave(Float32Array.from([2, -2, 0]))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
    expect(view.getInt16(48, true)).toBe(0)
  })
})

describe('resampling to the rate the header claims', () => {
  it('returns the input untouched at the target rate', () => {
    const { resample } = helpers()
    const input = Float32Array.from([0.1, 0.2, 0.3])
    expect(resample(input, 16000)).toBe(input)
  })

  it('produces the length the target rate implies', () => {
    // 48 kHz is what this machine's device negotiated, so it is not a hypothetical.
    const { resample } = helpers()
    const input = new Float32Array(4800) // 100 ms at 48 kHz
    expect(resample(input, 48000)).toHaveLength(1600)
  })

  it('preserves a constant level, which is what makes the samples the same signal', () => {
    const { resample } = helpers()
    const input = new Float32Array(4800).fill(0.5)
    const out = resample(input, 48000)
    for (const sample of out) expect(sample).toBeCloseTo(0.5, 6)
  })
})

describe('level measurement', () => {
  it('is the root mean square of the frame', () => {
    const { levelOf } = helpers()
    expect(levelOf(Float32Array.from([0, 0, 0, 0]))).toBe(0)
    // A square wave of amplitude a has RMS a.
    expect(levelOf(Float32Array.from([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 6)
  })
})

// ── the boundary rule ──────────────────────────────────────────────────────

/**
 * Build a segmenter over a fake audio graph.
 *
 * The graph is stubbed down to what the segmenter touches: a context whose rate the test
 * chooses (48 kHz, the measured device rate), a source, a processor that never fires on its
 * own — the test drives `frame()` directly, which is the only way to control a boundary.
 *
 * @returns the segmenter, the segments it emitted, and a helper that feeds a stretch of audio.
 */
function rig(options = {}) {
  // ONE load per rig. Calling `helpers()` and then `load()` would build two realms, and the
  // segmenter would be constructed in the one whose `AudioContext` nobody installed.
  const { module, clock, context } = load()
  const { Segmenter, SENSITIVITY, PAUSES } = module.__test
  const segments = []
  const graph = {
    sampleRate: options.sampleRate ?? 48000,
    state: 'running',
    createMediaStreamSource: () => ({ connect: () => {} }),
    createScriptProcessor: () => ({ connect: () => {}, disconnect: () => {}, onaudioprocess: undefined }),
    createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} }),
    destination: {},
    resume: async () => {},
    close: async () => { graph.state = 'closed' },
  }
  context.window.AudioContext = function FakeAudioContext() { return graph }
  context.navigator.mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [{ label: 'Fake mic' }] }),
  }

  const segmenter = new Segmenter({
    deviceId: '',
    threshold: SENSITIVITY.normal,
    pauseMs: PAUSES.medium,
    onLevel: () => {},
    onSegment: (bytes, reason) => { segments.push({ bytes, reason, at: clock.now }) },
    onError: () => {},
  })

  /**
   * Push `count` frames of a given amplitude, advancing the clock one frame each.
   *
   * @param count - how many frames.
   * @param amplitude - sample value for every channel slot.
   */
  const feed = (count, amplitude) => {
    const frame = new Float32Array(4800).fill(amplitude) // 100 ms at 48 kHz
    for (let index = 0; index < count; index += 1) {
      clock.now += 100
      segmenter.frame(frame)
    }
  }

  return { segmenter, segments, feed, clock, graph }
}

describe('where one sentence ends and the next begins', () => {
  it('emits one segment per spoken stretch, not one per frame', async () => {
    // THE POINT OF THE WHOLE FEATURE. An implementation that called back per frame would pass
    // a weaker test and produce a transcription every 100 ms.
    const { segmenter, segments, feed } = rig()
    await segmenter.start()

    feed(10, 0.001)  // 1 s of quiet: nothing to transcribe
    expect(segments).toHaveLength(0)

    feed(10, 0.2)    // 1 s of speech
    expect(segments, 'a segment was emitted before the pause').toHaveLength(0)

    feed(10, 0.001)  // 1 s of quiet — past the 800 ms pause
    expect(segments, 'the pause did not end the sentence').toHaveLength(1)
    expect(segments[0].reason).toBe('pause')
  })

  it('keeps the quiet leading up to the onset, so the first consonant survives', async () => {
    // Dropping the pre-roll truncates every sentence's opening phoneme — the defect is
    // inaudible in a level meter and obvious in the transcript.
    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    feed(6, 0.001)   // 600 ms of quiet held as pre-roll
    feed(4, 0.2)     // 400 ms of speech
    feed(10, 0.001)  // the pause

    expect(segments).toHaveLength(1)
    const samples = (segments[0].bytes.byteLength - 44) / 2
    // The clip is 300 ms of pre-roll + 400 ms of speech + 300 ms of bounded tail = 1000 ms,
    // which is 16000 samples at 16 kHz. The lower bound is what proves the pre-roll is there
    // — 400 ms of speech alone is 6400 — and the upper bound is what proves it is bounded
    // rather than carrying the entire 600 ms of quiet that preceded the onset.
    expect(samples).toBeGreaterThan(6400)
    expect(samples).toBeLessThanOrEqual(16000)
  })

  it('drops a stretch too short to be a sentence', async () => {
    // A cough, a keyboard click, a door. The recognizer answers noise with punctuation, and
    // punctuation in the draft is worse than nothing at all.
    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    feed(1, 0.2)     // 100 ms, below the 400 ms minimum
    feed(10, 0.001)
    expect(segments).toHaveLength(0)
  })

  it('cuts a monologue at the ceiling rather than growing without bound', async () => {
    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    feed(320, 0.2)   // 32 s of unbroken speech, past the 30 s ceiling
    expect(segments.length).toBeGreaterThanOrEqual(1)
    expect(segments[0].reason).toBe('length')
  })

  it('separates two sentences that are spoken back to back', async () => {
    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    feed(10, 0.2)    // sentence one
    feed(10, 0.001)  // the pause between them
    feed(10, 0.2)    // sentence two
    feed(10, 0.001)
    expect(segments).toHaveLength(2)
  })

  it('stops emitting once disposed', async () => {
    // The microphone is released on unmount and when the page is hidden; a callback that
    // still fired afterwards would transcribe audio nobody is listening to.
    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    await segmenter.dispose()
    feed(10, 0.2)
    feed(10, 0.001)
    expect(segments).toHaveLength(0)
  })
})

describe('the recording graph', () => {
  it('mutes the processor so nothing is played back', async () => {
    // A ScriptProcessorNode only runs while connected to the destination, so the connection is
    // required — and its gain is what keeps the microphone from being audible through the
    // speakers.
    const { segmenter, graph } = rig()
    const gains = []
    const original = graph.createGain
    graph.createGain = () => { const node = original(); gains.push(node); return node }
    await segmenter.start()
    expect(gains).toHaveLength(1)
    expect(gains[0].gain.value).toBe(0)
  })

  it('releases the stream and closes the context on dispose', async () => {
    const { segmenter, graph } = rig()
    await segmenter.start()
    await segmenter.dispose()
    expect(graph.state).toBe('closed')
  })
})

describe('"one sentence, one transcription" must not lose speech', () => {
  // THE REQUIREMENT THIS SECTION PINS: transcribe on a pause, keep listening, and never drop
  // what was said. Each of these is a way the first implementation could lose a sentence, and
  // every one of them was reachable by a person using the feature normally.

  it('keeps a one-syllable answer, which the old 400 ms floor dropped', async () => {
    // "好", "是", "OK" are all under 400 ms. Dropping them is the failure the feature exists to
    // prevent, and it is silent: the user sees the panel say nothing was recognised.
    const { MIN_SPEECH_MS } = helpers()
    expect(MIN_SPEECH_MS).toBeLessThanOrEqual(200)

    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    feed(3, 0.2)     // 300 ms, above 200 and far below the old floor
    feed(10, 0.001)
    expect(segments, 'a short answer produced no segment').toHaveLength(1)
  })

  it('still drops a click, so lowering the floor did not make noise into a sentence', async () => {
    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    feed(1, 0.2)     // 100 ms
    feed(10, 0.001)
    expect(segments).toHaveLength(0)
  })

  it('transcribes the sentence still being spoken when the user presses stop', async () => {
    // `dispose()` drops the buffer, which is right for teardown — but Stop pressed mid-sentence
    // used to go through it, so the last words existed nowhere. `finish()` flushes first.
    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    feed(8, 0.2)     // 800 ms of speech, no pause yet
    expect(segments, 'something was emitted before the stop').toHaveLength(0)

    await segmenter.finish()
    expect(segments, 'the open sentence was discarded').toHaveLength(1)
    expect(segments[0].reason).toBe('stop')
  })

  it('emits nothing extra when stop arrives on silence', async () => {
    const { segmenter, segments, feed } = rig()
    await segmenter.start()
    feed(10, 0.001)
    await segmenter.finish()
    expect(segments).toHaveLength(0)
  })
})

describe('transcriptions keep the order the sentences were spoken in', () => {
  it('runs one at a time, in queue order, even when an earlier task is slower', async () => {
    // MEASURED REASON: the microphone keeps recording while a sentence is transcribed, so two
    // stretches can be in flight. Two requests do not return in the order they were sent, and
    // parallel delivery occasionally inserts the second sentence before the first — which reads
    // as the product scrambling what someone said.
    const { serialQueue } = helpers()
    const enqueue = serialQueue()
    const done = []
    const slow = () => new Promise((resolve) => setTimeout(() => { done.push('first'); resolve() }, 40))
    const fast = () => { done.push('second'); return Promise.resolve() }

    await Promise.all([enqueue(slow), enqueue(fast)])
    expect(done).toEqual(['first', 'second'])
  })

  it('survives a task that throws, so one failure does not stall the queue', async () => {
    const { serialQueue } = helpers()
    const enqueue = serialQueue()
    const done = []
    await enqueue(() => { done.push('a') })
    const failed = enqueue(() => { throw new Error('transcription failed') })
    // The rejection reaches the caller, as a promise would.
    await expect(failed).rejects.toThrow('transcription failed')
    await enqueue(() => { done.push('b') })
    expect(done).toEqual(['a', 'b'])
  })
})
