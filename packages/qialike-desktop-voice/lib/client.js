/**
 * Continuous voice input — the browser half of `@qialike/qialike-desktop-voice`.
 *
 * HAND-WRITTEN, NOT BUILT, for the reason the theme, providers, voice and edit-follow halves
 * spell out: the harness's client-bundle preset is unpublished, and the artifact contract is
 * small enough to write directly —
 *
 *     window.__ModuleLoader__.load({ id, factory })
 *     factory(require) -> module.exports   // exports.apply, exports.inject
 *
 * — so this is plain JavaScript with `React.createElement`, and it requires nothing but
 * `react`. It imports no harness module.
 *
 * WHY IT EXISTS. The harness ships a voice-input plugin (the `voice-input` bundle), and it
 * records ONE clip and transcribes it when you press Stop. The question that produced this
 * file was "can it turn each sentence into text as I finish saying it?" — and the answer for
 * that plugin is no, structurally: `stop()` is the only path to `transcribe()`, and nothing
 * in it segments a recording. Its own `vad` is the Silero onset model used to TRIM silence
 * around a clip, not to find sentence boundaries.
 *
 * COULD THIS HAVE EXTENDED THE EXISTING PLUGIN INSTEAD? No, and the reason is worth
 * recording because it is not obvious. The plugin registers into
 * `conversation.input.activity`, which is a `single` slot — exactly one occupant — and it
 * hands its `createRecording`/`transcribe` actions ONLY to the component it registers. There
 * is no published handle by which one plugin can tell another "stop now". So a feature that
 * presses Stop on the user's behalf has to own the microphone itself. That is why this is a
 * second control standing beside the first rather than a switch on it.
 *
 * WHAT IT DOES. One press starts listening. The microphone stays open. Each time the level
 * has stayed below the speech threshold for the configured pause, the stretch of audio since
 * the previous boundary is encoded as canonical WAV, transcribed through the speech Remote,
 * and inserted into the draft. Recording does not stop while that happens, so the next
 * sentence is not lost.
 *
 * THE THREE RULES THAT MAKE AN ALWAYS-ON MICROPHONE DEFENSIBLE:
 *
 *   1. IT NEVER STARTS ITSELF. No auto-start on mount, on focus or on a new Session. A
 *      microphone the user did not open is a defect, not a feature.
 *   2. IT STOPS WHEN THE PAGE IS HIDDEN. `visibilitychange` ends the take, so a window left
 *      in the background is not still listening.
 *   3. IT STOPS WHEN THE SESSION CHANGES. Dictation is addressed to one draft; carrying the
 *      microphone into another Session would insert text into a box the user is no longer
 *      looking at.
 *
 * WHY IT KEEPS ITS OWN AUDIO PIPELINE RATHER THAN REUSING `MediaRecorder`. Segments have to
 * be cut at silence boundaries, and `MediaRecorder` can only hand over a decodable stream by
 * stopping — which drops the audio recorded between the stop and the next start. Sampling
 * float frames directly through a `ScriptProcessorNode` gives the boundaries for free, and
 * the buffers are already the shape the WAV encoder wants, so there is no decode round-trip
 * either. The documented alternative, `AudioWorklet`, needs a module URL this bundle cannot
 * point at without a blob, which buys nothing here.
 *
 * @module @qialike/qialike-desktop-voice/client
 */

window.__ModuleLoader__.load({
  id: '@qialike/qialike-desktop-voice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** This plugin's dictionary namespace. */
    const NS = 'qialike-voice'

    /** Where the browser remembers the choices; per device, per profile, like the shipped picker. */
    const STORAGE = 'qialike-voice'

    /** The rate the transcriber expects; `encodeWave` writes this into the header. */
    const RATE = 16000

    /**
     * How long the level must stay under the threshold before a sentence is considered over.
     *
     * THE ONE NUMBER THAT DECIDES WHETHER THIS FEELS RIGHT. Too short and a normal breath
     * splits one sentence into two transcriptions; too long and the text arrives after the
     * user has started the next thought. 800 ms sits between the two for ordinary speech, and
     * the control exposes three settings because "ordinary" differs by person and by room.
     */
    const PAUSES = { short: 500, medium: 800, long: 1400 }

    /**
     * Level thresholds, as RMS of a frame in [-1, 1].
     *
     * Calibrated rather than guessed: the Bluetooth headset measured RMS ≈ 0.14 while
     * speaking and ≈ 0.002 in a quiet room, so every value here sits well below speech and
     * well above a silent room. `quiet` is for a headset close to the mouth, `loud` for a
     * laptop microphone across a room.
     */
    const SENSITIVITY = { quiet: 0.010, normal: 0.020, loud: 0.045 }

    /** Audio kept before the first frame that crosses the threshold, so the onset is not clipped. */
    const PRE_ROLL_MS = 300

    /**
     * Audio kept after the last frame above the threshold.
     *
     * A decoder does better with a little boundary than with a hard cut, but the whole pause
     * would only pad the clip: at an 800 ms pause that is more silence than speech, and the
     * provider trims it again with its own VAD. Bounded rather than absent.
     */
    const TRAIL_MS = 300

    /**
     * Stretches shorter than this are a cough or a door, not a sentence.
     *
     * LOWERED FROM 400 ms, because 400 ms was dropping words. "好", "是", "OK" and "no" are
     * comfortably under it, so an utterance a person clearly made produced nothing at all —
     * the failure this feature exists to avoid. A click or a door is tens of milliseconds;
     * 200 ms is above those and below a one-syllable answer.
     */
    const MIN_SPEECH_MS = 200

    /**
     * How many times one stretch is retried after a transient failure.
     *
     * ONE. A local recognizer that fails twice on the same audio is failing for a reason a
     * third attempt will not change, and a queue that keeps retrying blocks every sentence
     * behind it. A failure that survives the retry is kept as text the user can re-insert,
     * not discarded.
     */
    const RETRIES = 1

    /** A hard ceiling per segment; a monologue is cut here rather than growing without bound. */
    const MAX_SEGMENT_MS = 30000

    /** How often a transcript may be inserted, to keep the level meter from re-rendering per frame. */
    const LEVEL_INTERVAL_MS = 60

    const dictionaries = {
      en: {
        'label': 'Continuous voice input',
        'settings': 'Voice input settings',
        'idle': 'Click to start dictating',
        'listening': 'Listening — say a sentence, then pause',
        'stop': 'Stop dictating',
        'starting': 'Opening the microphone…',
        'transcribing': 'Transcribing…',
        'inserted': (n) => `${n} sentence${n === 1 ? '' : 's'} inserted`,
        'device': 'Microphone',
        'deviceDefault': 'System default',
        'sensitivity': 'Sensitivity',
        'sensQuiet': 'Close microphone',
        'sensNormal': 'Normal',
        'sensLoud': 'Across the room',
        'pause': 'Pause that ends a sentence',
        'pauseShort': 'Short (0.5 s)',
        'pauseMedium': 'Medium (0.8 s)',
        'pauseLong': 'Long (1.4 s)',
        'notReady': 'The speech model is not ready. Prepare it under Settings → Plugins → voice input.',
        'noMedia': 'This browser cannot record audio.',
        'denied': 'Microphone access was refused.',
        'noDevice': 'No microphone was found. With a Bluetooth headset, switch it to its call/headset mode in the system — A2DP (high-fidelity playback) carries no microphone.',
        'failed': (message) => `Transcription failed: ${message}`,
        'tooLarge': 'That sentence exceeded the service limit and was skipped.',
        'conflict': (text) => `Draft changed — kept: “${text}”`,
        'pendingTitle': 'Not inserted (the draft changed)',
        'insert': 'Insert',
        'discard': 'Discard',
        'hint': 'Each pause ends a sentence and inserts it into the draft. Nothing is sent.',
        'empty': 'That stretch held no recognizable speech.',
      },
      zh: {
        'label': '连续语音输入',
        'settings': '语音输入设置',
        'idle': '点击开始连续听写',
        'listening': '正在听 —— 说一句，然后停顿',
        'stop': '停止听写',
        'starting': '正在打开麦克风…',
        'transcribing': '正在转写…',
        'inserted': (n) => `已插入 ${n} 句`,
        'device': '麦克风',
        'deviceDefault': '系统默认',
        'sensitivity': '灵敏度',
        'sensQuiet': '近讲麦克风',
        'sensNormal': '一般',
        'sensLoud': '远距离',
        'pause': '断句停顿',
        'pauseShort': '短（0.5 秒）',
        'pauseMedium': '中（0.8 秒）',
        'pauseLong': '长（1.4 秒）',
        'notReady': '语音模型尚未就绪。请先在 设置 → 插件 → voice input 里准备它。',
        'noMedia': '此浏览器无法录音。',
        'denied': '麦克风访问被拒绝。',
        'noDevice': '没有找到麦克风。若使用蓝牙耳机，请在系统里切到「通话/耳麦」模式——A2DP（高音质播放）模式不提供麦克风。',
        'failed': (message) => `转写失败：${message}`,
        'tooLarge': '这一句超出服务限制，已跳过。',
        'conflict': (text) => `草稿已修改 —— 已保留：“${text}”`,
        'pendingTitle': '未能插入（草稿已修改）',
        'insert': '插入',
        'discard': '丢弃',
        'hint': '每次停顿结束一句并插入草稿。不会自动发送。',
        'empty': '这一段没有可识别的语音。',
      },
    }

    // ── audio: the exact container the transcriber validates ─────────────────

    /**
     * Encode mono float samples as 16 kHz 16-bit PCM WAV.
     *
     * The Host rejects anything else — measured: handing it raw PCM answers `Invalid speech
     * WAV` — so this writes the canonical 44-byte header and is the only format that leaves
     * this module.
     *
     * @param samples - mono samples in [-1, 1].
     * @returns the WAV file's bytes.
     */
    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => {
        for (let index = 0; index < value.length; index += 1) bytes[at + index] = value.charCodeAt(index)
      }
      text(0, 'RIFF')
      view.setUint32(4, bytes.length - 8, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, RATE, true)
      view.setUint32(28, RATE * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let index = 0; index < samples.length; index += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      }
      return bytes
    }

    /**
     * Resample by linear interpolation.
     *
     * The context's own rate is whatever the device negotiated — measured 48 kHz on this
     * machine — and the encoder header claims 16 kHz, so the samples have to match it. Doing
     * this here rather than asking for `new AudioContext({ sampleRate: 16000 })` keeps the
     * result independent of whether a browser honours that request.
     *
     * @param input - source samples.
     * @param from - source rate.
     * @returns samples at {@link RATE}.
     */
    function resample(input, from) {
      if (from === RATE) return input
      const step = from / RATE
      const length = Math.max(1, Math.floor(input.length / step))
      const out = new Float32Array(length)
      for (let index = 0; index < length; index += 1) {
        const at = index * step
        const lower = Math.floor(at)
        const upper = Math.min(input.length - 1, lower + 1)
        const fraction = at - lower
        out[index] = input[lower] * (1 - fraction) + input[upper] * fraction
      }
      return out
    }

    /**
     * A one-at-a-time runner that never rejects.
     *
     * Two properties matter and both are why this exists as its own function: tasks run in the
     * order they were queued (a transcription that finishes early must still be inserted in
     * its turn), and a task that throws does not stall the ones behind it. `then(fn, fn)` is
     * the second property — the rejection handler is the same function, so the chain stays
     * alive whichever way the previous task settled.
     *
     * @returns a function that queues a task and resolves with its result.
     */
    function serialQueue() {
      let tail = Promise.resolve()
      return (task) => {
        tail = tail.then(task, task)
        return tail
      }
    }

    /** Root-mean-square of a frame, which is the level the threshold compares against. */
    function levelOf(frame) {
      let sum = 0
      for (let index = 0; index < frame.length; index += 1) sum += frame[index] * frame[index]
      return Math.sqrt(sum / frame.length)
    }

    /** Base64 of a byte array, chunked so a long clip does not blow the argument limit. */
    function base64Of(bytes) {
      let text = ''
      for (let index = 0; index < bytes.length; index += 8192) {
        text += String.fromCharCode(...bytes.subarray(index, index + 8192))
      }
      return btoa(text)
    }

    // ── the segmenter: one open microphone, many sentences ──────────────────

    /**
     * Holds one microphone stream and emits one WAV buffer per spoken stretch.
     *
     * A stretch begins at the first frame above the threshold (preceded by up to
     * {@link PRE_ROLL_MS} of quiet, so the first consonant survives) and ends after the level
     * has stayed below it for the configured pause. The caller keeps owning the stream; this
     * class only decides where sentences end.
     */
    class Segmenter {
      constructor(options) {
        this.deviceId = options.deviceId
        this.threshold = options.threshold
        this.pauseMs = options.pauseMs
        this.onLevel = options.onLevel
        this.onSegment = options.onSegment
        this.onError = options.onError
        this.stream = undefined
        this.audio = undefined
        this.processor = undefined
        this.mute = undefined
        this.held = []
        this.preRoll = []
        this.speaking = false
        this.quietRun = 0
        this.voicedSamples = 0
        this.lastVoiceAt = 0
        this.segmentStart = 0
        this.lastLevelAt = 0
        this.disposed = false
      }

      /** Open the microphone and start watching the level. */
      async start() {
        const media = navigator.mediaDevices
        if (media === undefined || typeof media.getUserMedia !== 'function') throw new Error('no-media')
        this.stream = await media.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            ...(this.deviceId === '' ? {} : { deviceId: { exact: this.deviceId } }),
          },
          video: false,
        })
        if (this.disposed) {
          this.stream.getTracks().forEach((track) => { track.stop() })
          return
        }
        const AudioContext = window.AudioContext ?? window.webkitAudioContext
        this.audio = new AudioContext()
        if (typeof this.audio.resume === 'function') await this.audio.resume()
        const source = this.audio.createMediaStreamSource(this.stream)
        const processor = this.audio.createScriptProcessor(4096, 1, 1)
        this.processor = processor
        processor.onaudioprocess = (event) => { this.frame(event.inputBuffer.getChannelData(0)) }
        // A processor only runs while connected to the destination. The gain is zero, so
        // nothing is played back — what is wanted is the callback, not the sound.
        const mute = this.audio.createGain()
        mute.gain.value = 0
        source.connect(processor)
        processor.connect(mute)
        mute.connect(this.audio.destination)
        this.mute = mute
        this.segmentStart = performance.now()
      }

      /** The name of the device actually acquired, or undefined outside a stream. */
      deviceLabel() {
        const track = this.stream?.getAudioTracks?.()[0]
        return track?.label
      }

      /** One analysis frame, plus the boundary decision it implies. */
      frame(data) {
        if (this.disposed) return
        const copy = Float32Array.from(data)
        const level = levelOf(copy)
        const now = performance.now()
        const frameMs = (copy.length / this.audio.sampleRate) * 1000

        if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
          this.lastLevelAt = now
          this.onLevel(Math.min(1, level / (this.threshold * 4)))
        }

        if (level >= this.threshold) {
          if (!this.speaking) {
            this.speaking = true
            // The quiet held back for the pre-roll belongs to this sentence.
            this.held = this.preRoll
            this.preRoll = []
            this.segmentStart = now
          }
          this.lastVoiceAt = now
          this.quietRun = 0
          this.voicedSamples += copy.length
          this.held.push(copy)
          if (now - this.segmentStart >= MAX_SEGMENT_MS) this.flush('length')
          return
        }

        if (!this.speaking) {
          // Keep a bounded tail of quiet so an onset is never clipped.
          this.preRoll.push(copy)
          const keep = Math.max(1, Math.ceil(PRE_ROLL_MS / frameMs))
          while (this.preRoll.length > keep) this.preRoll.shift()
          return
        }

        // A bounded tail of quiet rides along, for the reason TRAIL_MS records.
        const trailFrames = Math.max(1, Math.ceil(TRAIL_MS / frameMs))
        if (this.quietRun < trailFrames) {
          this.held.push(copy)
          this.quietRun += 1
        }
        if (now - this.lastVoiceAt >= this.pauseMs) this.flush('pause')
      }

      /**
       * Close the current stretch and hand it over, or drop it when it was too short to be
       * speech.
       *
       * @param reason - `pause` for a silence boundary, `length` for the ceiling.
       */
      flush(reason) {
        if (!this.speaking) return
        const parts = this.held
        const voiced = this.voicedSamples
        this.held = []
        this.speaking = false
        this.quietRun = 0
        this.voicedSamples = 0
        this.segmentStart = performance.now()
        const rate = this.audio.sampleRate
        let total = 0
        for (const part of parts) total += part.length
        // A cough, a keyboard click, a door. Worth nothing to the transcriber and everything
        // to the user's patience if it lands in the draft as noise.
        //
        // JUDGED ON THE VOICED TIME, NOT ON THE CLIP. The pre-roll and the trailing tail are
        // padding, and counting them would push a 100 ms click past a 400 ms threshold — which
        // is precisely the case this gate exists to drop.
        if ((voiced / rate) * 1000 < MIN_SPEECH_MS) return
        const merged = new Float32Array(total)
        let at = 0
        for (const part of parts) {
          merged.set(part, at)
          at += part.length
        }
        this.onSegment(encodeWave(resample(merged, rate)), reason)
      }

      /**
       * Close the stretch in progress, then release the microphone.
       *
       * PRESSING STOP MID-SENTENCE MUST NOT SWALLOW THE SENTENCE. `dispose()` drops `held`,
       * which is right for tearing down — but when the user stops while still speaking, the
       * last words are in that buffer and nowhere else. So the segmenter flushes first: the
       * pause rule is what ends a sentence when nobody is watching, and Stop is a second,
       * explicit way to say "that is a sentence".
       */
      async finish() {
        if (this.speaking) this.flush('stop')
        await this.dispose()
      }

      /** Release the microphone and the audio graph. Safe to call twice. */
      async dispose() {
        this.disposed = true
        this.speaking = false
        this.held = []
        this.preRoll = []
        try {
          this.processor?.disconnect()
          this.mute?.disconnect()
          this.stream?.getTracks().forEach((track) => { track.stop() })
          if (this.audio !== undefined && this.audio.state !== 'closed') await this.audio.close()
        } catch (error) {
          // Nothing to do about a graph that is already gone, and throwing here would turn a
          // clean stop into an error the user cannot act on.
          void error
        }
        this.audio = undefined
        this.processor = undefined
        this.stream = undefined
      }
    }

    // ── the control ──────────────────────────────────────────────────────────

    const muted = { color: 'var(--dsw-alias-label-secondary)' }
    const styles = {
      wrap: { position: 'relative', display: 'inline-flex' },
      button: {
        font: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
        gap: '5px', padding: '4px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      },
      buttonOn: {
        font: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
        gap: '5px', padding: '4px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)',
        color: 'var(--dsw-alias-label-primary)',
      },
      caret: {
        font: 'inherit', cursor: 'pointer', padding: '4px 4px', marginLeft: '-4px',
        borderRadius: '6px', lineHeight: 1, fontSize: '9px',
        border: '1px solid transparent', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: (on) => ({
        width: '7px', height: '7px', borderRadius: '999px', flex: 'none',
        background: on ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l2)',
      }),
      panel: {
        position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, zIndex: 40,
        width: '292px', display: 'flex', flexDirection: 'column', gap: '10px',
        padding: '12px', borderRadius: '8px', fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        // Opaque on purpose: a panel over a photograph is unreadable when it is not, which
        // this application has already been reported for once.
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 8px 24px rgb(0 0 0 / 45%)',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '3px' },
      label: { fontWeight: 600, fontSize: '11px' },
      hint: { ...muted, fontSize: '11px', lineHeight: '1.5', margin: 0 },
      select: {
        font: 'inherit', padding: '4px 6px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      meterTrack: {
        height: '4px', borderRadius: '999px', overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      meterFill: (share) => ({
        height: '100%', width: `${Math.round(share * 100)}%`,
        background: 'var(--dsw-alias-state-success-primary)',
        transition: 'width 60ms linear',
      }),
      note: { ...muted, fontSize: '11px', lineHeight: '1.5', margin: 0, wordBreak: 'break-word' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '11px', margin: 0, wordBreak: 'break-word' },
      pending: {
        display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 8px',
        borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      small: {
        font: 'inherit', cursor: 'pointer', padding: '2px 8px', borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      row: { display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'flex-end' },
    }

    /** The microphone mark; outlined while idle, filled while listening. */
    function MicrophoneMark({ active }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true,
        fill: active ? 'currentColor' : 'none', stroke: 'currentColor',
        strokeWidth: active ? 0 : 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M12 3.2a3 3 0 0 1 3 3v5.6a3 3 0 0 1-6 0V6.2a3 3 0 0 1 3-3z' }),
        h('path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0' }),
        h('path', { d: 'M12 17.5V21' }))
    }

    function read(key, fallback) {
      try {
        return window.localStorage.getItem(`${STORAGE}.${key}`) ?? fallback
      } catch (error) {
        return fallback
      }
    }

    function write(key, value) {
      try {
        window.localStorage.setItem(`${STORAGE}.${key}`, value)
      } catch (error) {
        // A profile that refuses storage still gets the setting for this page's lifetime.
        void error
      }
    }

    /**
     * The composer control and its panel.
     *
     * `inputActions` arrives as a standard prop: this registers into a `session`-scope list
     * slot, and the slot runtime injects the Session's input face into every occupant.
     */
    function VoiceControl({ sessionId, inputActions, t, speech }) {
      const [listening, setListening] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [level, setLevel] = React.useState(0)
      const [count, setCount] = React.useState(0)
      const [note, setNote] = React.useState('')
      const [failure, setFailure] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [devices, setDevices] = React.useState([])
      const [pending, setPending] = React.useState([])
      const [deviceId, setDeviceIdState] = React.useState(() => read('device', ''))
      const [sensitivity, setSensitivityState] = React.useState(() => read('sensitivity', 'normal'))
      const [pause, setPauseState] = React.useState(() => read('pause', 'medium'))

      const run = React.useRef(undefined)
      const abort = React.useRef(undefined)
      const live = React.useRef(true)
      /**
       * The chain every stretch is transcribed through.
       *
       * WHY A QUEUE AND NOT PARALLEL CALLS. The microphone deliberately keeps recording while
       * a sentence is transcribed, so two stretches can be in flight at once — and two
       * requests do not come back in the order they were sent. Firing them in parallel would
       * occasionally insert the second sentence before the first, which reads as the product
       * scrambling what someone said. One at a time costs nothing measurable: a local
       * recognizer answers a five-second clip in about a tenth of a second (measured).
       *
       * `then(fn, fn)` rather than `then(fn)`: a rejected link must not break the chain for
       * every sentence after it.
       */
      const queued = React.useRef(undefined)
      if (queued.current === undefined) queued.current = serialQueue()

      const setDeviceId = (value) => { setDeviceIdState(value); write('device', value) }
      const setSensitivity = (value) => { setSensitivityState(value); write('sensitivity', value) }
      const setPause = (value) => { setPauseState(value); write('pause', value) }

      // UNMOUNT IS THE ONE PLACE A TRANSCRIPTION IS CANCELLED: the row is gone, so there is no
      // draft to insert into, and leaving a request running would write into a component that
      // no longer exists. Stopping the microphone is a different thing and does not cancel.
      React.useEffect(() => () => {
        live.current = false
        abort.current?.abort()
        abort.current = undefined
      }, [])

      // The device list is read while the panel is open, and refreshed when the set changes,
      // because a headset that connects after the page loaded must appear without a reload.
      React.useEffect(() => {
        if (!open) return undefined
        const media = navigator.mediaDevices
        if (media === undefined) return undefined
        let alive = true
        const read2 = async () => {
          try {
            const all = await media.enumerateDevices()
            if (!alive) return
            setDevices(all.filter((device) => device.kind === 'audioinput'))
          } catch (error) {
            if (alive) setFailure(String(error?.message ?? error))
          }
        }
        void read2()
        media.addEventListener('devicechange', read2)
        return () => {
          alive = false
          media.removeEventListener('devicechange', read2)
        }
      }, [open])

      /**
       * Stop listening.
       *
       * TWO THINGS IT DELIBERATELY DOES NOT DO, both of which used to lose speech:
       *
       *   1. It does not abort the transcription in flight. Pressing Stop a second after
       *      finishing a sentence cancelled the request that sentence was waiting on, so the
       *      words never arrived — the most likely way for a person to see this feature drop
       *      something they said.
       *   2. It does not discard the stretch being spoken. `finish()` flushes it as a final
       *      segment, so stopping mid-sentence transcribes what had been said so far.
       *
       * Then it waits for the queue, so "stopped" means the words are in the draft rather than
       * on their way.
       */
      const stop = React.useCallback(async (noteText) => {
        const segmenter = run.current
        run.current = undefined
        if (segmenter !== undefined) await segmenter.finish()
        if (live.current) {
          setListening(false)
          setLevel(0)
          if (noteText !== undefined) setNote(noteText)
        }
        await queued.current(() => Promise.resolve())
        if (live.current) setBusy(false)
      }, [])

      // Rule 2 and rule 3 from the module note: hiding the page, or a new Session, ends it.
      React.useEffect(() => {
        if (!listening) return undefined
        const hidden = () => {
          if (document.hidden) void stop(t('idle'))
        }
        document.addEventListener('visibilitychange', hidden)
        return () => { document.removeEventListener('visibilitychange', hidden) }
      }, [listening, stop, t])

      const previousSession = React.useRef(sessionId)
      React.useEffect(() => {
        if (previousSession.current !== sessionId) {
          previousSession.current = sessionId
          if (listening) void stop(t('idle'))
        }
      }, [sessionId, listening, stop, t])

      /**
       * Send one stretch and put the result in the draft.
       *
       * THE SPAN IS CAPTURED WHEN THE SENTENCE ENDS, not when it started and not when the
       * text arrives. That is what the contract's revision guard is for: text dictated during
       * a pause must not land in a draft the user edited while it was in flight. Capturing
       * per segment is also what makes the second sentence work at all — `insertText` refuses
       * a span whose revision has moved, and the first insertion moves it.
       */
      /**
       * Transcribe one stretch, retrying once, and put the words in the draft.
       *
       * Returns rather than throwing: this runs inside the queue, and a rejected link would
       * have to be caught again by the next `then`.
       */
      const transcribeOnce = React.useCallback(async (bytes, providerId, language) => {
        for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
          const controller = new AbortController()
          abort.current = controller
          try {
            const result = await speech.transcribe({
              audioBase64: base64Of(bytes),
              ...(providerId === undefined ? {} : { providerId }),
              ...(language === undefined ? {} : { language }),
            }, controller.signal)
            return { result, aborted: controller.signal.aborted === true }
          } catch (error) {
            // The last attempt reports; earlier ones are history the user does not need.
            if (attempt === RETRIES) return { error, aborted: controller.signal.aborted === true }
          } finally {
            if (abort.current === controller) abort.current = undefined
          }
        }
        return { error: new Error('no attempt was made') }
      }, [speech])

      const deliver = React.useCallback(async (bytes, providerId, language) => {
        if (bytes.byteLength === 0) return
        // The span is captured HERE, when the sentence is queued — the revision it guards is
        // the draft as the user left it at that moment. Re-capturing at insert time would
        // accept edits made while the audio was in flight, which is what the guard exists to
        // refuse; capturing later also cannot help, because the queue is in speech order.
        const span = inputActions?.captureInsertion?.()
        if (span === undefined) return
        if (live.current) { setBusy(true); setLevel(0) }
        try {
          const { result, error, aborted } = await transcribeOnce(bytes, providerId, language)
          if (!live.current) return
          if (error !== undefined) {
            if (!aborted) setFailure(t('failed')(String(error?.message ?? error)))
            return
          }
          if (result.ok !== true) {
            const message = String(result.error?.message ?? 'error')
            if (/size|large|limit/iu.test(message)) setFailure(t('tooLarge'))
            else setFailure(t('failed')(message))
            return
          }
          const text = String(result.value?.text ?? '').trim()
          // A lone "." is what the recognizer returns for a stretch with no words in it —
          // measured. Inserting it would add punctuation the user never said.
          if (!/[\p{L}\p{N}]/u.test(text)) { setNote(t('empty')); return }
          // Latin words need a separator to read as separate sentences; CJK does not.
          const body = /[A-Za-z0-9]$/u.test(text) ? `${text} ` : text
          if (inputActions?.insertText?.(body, span) === true) {
            setCount((value) => value + 1)
            setNote('')
          } else {
            // The draft moved under us. Keep the words rather than dropping them.
            setPending((items) => [...items, text])
            setNote(t('conflict')(text))
            setOpen(true)
          }
        } finally {
          if (live.current) setBusy(false)
        }
      }, [inputActions, transcribeOnce, t])

      /** Put one stretch on the queue. The chain never rejects, so it cannot stall. */
      const enqueue = React.useCallback((bytes, providerId, language) => (
        queued.current(() => deliver(bytes, providerId, language))
      ), [deliver])

      const start = async () => {
        setFailure('')
        setNote('')
        setCount(0)
        let catalog
        try {
          const result = await speech.catalog()
          if (result.ok !== true) throw result.error ?? new Error('catalog')
          catalog = result.value
        } catch (error) {
          setFailure(t('failed')(String(error?.message ?? error)))
          return
        }
        const provider = catalog.providers?.find((item) => item.id === catalog.selection?.providerId)
        const phase = provider?.preparation?.phase
        if (phase !== 'ready' && phase !== 'standby' && phase !== 'waking') {
          setFailure(t('notReady'))
          return
        }
        const segmenter = new Segmenter({
          deviceId,
          threshold: SENSITIVITY[sensitivity] ?? SENSITIVITY.normal,
          pauseMs: PAUSES[pause] ?? PAUSES.medium,
          onLevel: (value) => { if (live.current) setLevel(value) },
          onSegment: (bytes, reason) => {
            // Queued, not awaited: the microphone keeps filling the next stretch while this one
            // is transcribed, which is the whole point of a continuous mode.
            void enqueue(bytes, catalog.selection?.providerId, catalog.selection?.language)
            void reason
          },
          onError: (error) => { setFailure(String(error?.message ?? error)) },
        })
        try {
          setBusy(true)
          await segmenter.start()
        } catch (error) {
          const message = String(error?.message ?? error)
          setBusy(false)
          if (error?.name === 'NotAllowedError' || /permission|denied/iu.test(message)) setFailure(t('denied'))
          else if (error?.name === 'NotFoundError') setFailure(t('noDevice'))
          else if (message === 'no-media') setFailure(t('noMedia'))
          else setFailure(t('failed')(message))
          await segmenter.dispose()
          return
        }
        if (!live.current) { await segmenter.dispose(); return }
        run.current = segmenter
        setListening(true)
        setBusy(false)
      }

      const toggle = () => {
        if (listening) void stop(t('idle'))
        else void start()
      }

      const insertPending = (text) => {
        const span = inputActions?.captureInsertion?.()
        if (span !== undefined && inputActions?.insertText?.(text, span) === true) {
          setPending((items) => items.filter((item) => item !== text))
          setCount((value) => value + 1)
        }
      }

      const busyLabel = busy && !listening ? t('starting') : busy ? t('transcribing') : ''

      return h('div', { style: styles.wrap },
        h('button', {
          type: 'button',
          style: listening ? styles.buttonOn : styles.button,
          'aria-label': t('label'),
          'aria-pressed': listening,
          title: listening ? t('stop') : t('idle'),
          onClick: toggle,
        },
          h(MicrophoneMark, { active: listening }),
          h('span', { style: styles.dot(listening) })),
        // A SEPARATE AFFORDANCE FOR THE PANEL, because the microphone button's click is
        // already spoken for: it starts and stops dictation. Without this the panel was
        // reachable only by being forced open on a conflict, which left the device and
        // sensitivity settings — the two things this needs to be usable on a machine with
        // more than one input — with no way in at all.
        h('button', {
          type: 'button',
          style: styles.caret,
          'aria-label': t('settings'),
          'aria-expanded': open,
          title: t('settings'),
          onClick: () => { setOpen(!open) },
        }, '\u25be'),

        open
          ? h('div', { style: styles.panel, role: 'dialog', 'aria-label': t('label') },
            h('div', { style: styles.field },
              h('span', { style: styles.label }, t('device')),
              h('select', {
                style: styles.select,
                value: deviceId,
                onChange: (event) => { setDeviceId(event.target.value) },
              },
                h('option', { value: '' }, t('deviceDefault')),
                ...devices.map((device, index) => h('option', {
                  key: device.deviceId === '' ? `d${index}` : device.deviceId,
                  value: device.deviceId,
                }, device.label === '' ? `${t('device')} ${index + 1}` : device.label)))),

            h('div', { style: styles.field },
              h('span', { style: styles.label }, t('sensitivity')),
              h('select', {
                style: styles.select, value: sensitivity,
                onChange: (event) => { setSensitivity(event.target.value) },
              },
                h('option', { value: 'quiet' }, t('sensQuiet')),
                h('option', { value: 'normal' }, t('sensNormal')),
                h('option', { value: 'loud' }, t('sensLoud')))),

            h('div', { style: styles.field },
              h('span', { style: styles.label }, t('pause')),
              h('select', {
                style: styles.select, value: pause,
                onChange: (event) => { setPause(event.target.value) },
              },
                h('option', { value: 'short' }, t('pauseShort')),
                h('option', { value: 'medium' }, t('pauseMedium')),
                h('option', { value: 'long' }, t('pauseLong')))),

            h('div', { style: styles.meterTrack }, h('div', { style: styles.meterFill(listening ? level : 0) })),

            h('p', { style: styles.note },
              busyLabel !== '' ? busyLabel : listening ? t('listening') : t('idle'),
              count > 0 ? ` · ${t('inserted')(count)}` : ''),

            failure !== '' ? h('p', { style: styles.error }, failure) : null,
            failure === '' && note !== '' ? h('p', { style: styles.note }, note) : null,

            pending.length === 0
              ? null
              : h('div', { style: styles.pending },
                h('span', { style: styles.label }, t('pendingTitle')),
                ...pending.map((text, index) => h('div', { key: `${index}-${text.slice(0, 8)}`, style: styles.row },
                  h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, text),
                  h('button', { type: 'button', style: styles.small, onClick: () => { insertPending(text) } }, t('insert')),
                  h('button', {
                    type: 'button', style: styles.small,
                    onClick: () => { setPending((items) => items.filter((item) => item !== text)) },
                  }, t('discard'))))),

            h('p', { style: styles.hint }, t('hint')),
            h('div', { style: styles.row },
              h('button', {
                type: 'button', style: styles.small,
                onClick: () => { setOpen(false) },
              }, listening ? t('stop') : t('idle'))))
          : null)
    }

    /**
     * Re-exported for the tests: the encoder and the segmenter are the parts with logic worth
     * pinning, and the test bundle loads this module the same way the browser does.
     */
    exports.__test = { encodeWave, resample, levelOf, Segmenter, serialQueue, PAUSES, SENSITIVITY, MIN_SPEECH_MS }

    /**
     * The services this bundle reads.
     *
     * `remote` IS THE NAMESPACE ROOT, AND IT IS LOAD-BEARING. Cordis resolves service access
     * per declared name and guards the rest: declaring `remote.speech` alone leaves
     * `scope.remote` unreachable and throws `cannot get property "remote" without inject` at
     * the first call — which is how the first live run failed, the control having rendered
     * and filled its device list correctly up to the moment the microphone was pressed. The
     * shipped voice plugin declares `remote` for the same reason, and that is where this list
     * was copied from rather than guessed.
     */
    const inject = ['remote', 'slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'qialike-voice: dictionaries')

      /**
       * Mount only when the speech Remote exists.
       *
       * The transcriber comes from the `voice-input` bundle, which the user enables under
       * Plugins. Without it there is nothing to transcribe with, so a microphone here would
       * record audio and discard it — worse than no control at all. `ctx.inject` waits for
       * the service instead of failing, which is exactly the wanted behavior: turning the
       * bundle on makes this control appear.
       */
      const mounted = ctx.inject(['remote.speech', 'slots', 'locale'], (scope) => {
        const speech = {
          catalog: () => scope.remote.speech.catalog(),
          transcribe: (request, signal) => scope.remote.speech.transcribe(request, signal),
        }
        // `conversation.input.right` is a LIST slot in the Session scope, so this adds a
        // control beside the model selector instead of replacing anything — and the slot
        // runtime hands every occupant the Session's `inputActions`, which is how the
        // transcript reaches the draft.
        scope.slots.inject('conversation.input.right', () => scope.slots.register({
          name: 'conversation.input.right',
          id: 'qialike-voice',
          // After the shipped entries, immediately before the model selector.
          order: 40,
          locale: NS,
          inject: () => ({ speech }),
        }, VoiceControl))
      })

      ctx.effect(
        () => () => { void Promise.resolve(mounted).then((dispose) => dispose?.()).catch(() => undefined) },
        'qialike-voice: mount',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
