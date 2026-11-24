/**
 * When the shell next asks the update feed.
 *
 * WHY JITTER, AND WHY BACKOFF. Every install of this application shares one feed.
 * A fixed interval makes them ask in lockstep — and worse, makes them ask in
 * lockstep *after a failure*, which is exactly when a feed is least able to
 * answer. The jitter spreads the requests; the backoff stops a client that cannot
 * reach the feed from retrying at full rate forever.
 *
 * The parameters are the harness's own (`update-schedule.ts` in its desktop app),
 * and they are read from the same environment variables so an operator who has
 * tuned one has tuned both: 10 minutes base, ±20% jitter, backoff capped at an
 * hour.
 *
 * The arithmetic is separated from the timer on purpose. A `setTimeout` chain is
 * untestable without waiting; deciding *what the next delay would be* is a pure
 * function of the previous outcome, and that is what this module exposes.
 *
 * @module @qialike/desktop/update-schedule
 */

/** Validated polling settings. */
export interface UpdateScheduleConfig {
  /** Base delay between successful checks, in milliseconds. */
  readonly intervalMs: number
  /** Ceiling for the backed-off delay, in milliseconds. */
  readonly maxBackoffMs: number
  /** Fractional spread applied to each delay, in `[0, 1]`. */
  readonly jitter: number
}

/** Milliseconds in the lower bound the harness enforces, and the upper `setTimeout` bound. */
const MIN_DURATION_MS = 1_000
const MAX_DURATION_MS = 2_147_483_647

/**
 * Read the polling settings from the environment.
 *
 * Out-of-range values throw rather than falling back: an operator who set
 * `DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS=10` meant something, and silently using
 * ten minutes would hide the mistake while looking like it worked.
 *
 * @param env - the process environment.
 * @returns the validated settings.
 * @throws Error when a value is out of range or inconsistent.
 */
export function resolveUpdateScheduleConfig(env: NodeJS.ProcessEnv): UpdateScheduleConfig {
  function duration(name: string, fallback: number): number {
    const raw = env[name]
    const value = raw === undefined || raw === '' ? fallback : Number(raw)
    if (!Number.isSafeInteger(value) || value < MIN_DURATION_MS || value > MAX_DURATION_MS) {
      throw new Error(`${name} must be an integer from ${String(MIN_DURATION_MS)} through ${String(MAX_DURATION_MS)}`)
    }
    return value
  }
  const intervalMs = duration('DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS', 600_000)
  const maxBackoffMs = duration(
    'DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS',
    Math.max(intervalMs, 3_600_000),
  )
  const rawJitter = env.DSH_DESKTOP_UPDATE_CHECK_JITTER
  const jitter = rawJitter === undefined || rawJitter === '' ? 0.2 : Number(rawJitter)
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1 || maxBackoffMs < intervalMs) {
    throw new Error(
      'desktop update: check jitter must be in [0, 1] and max backoff must cover the check interval',
    )
  }
  return { intervalMs, maxBackoffMs, jitter }
}

/** How many consecutive failures are worth remembering before the cap dominates. */
const MAX_TRACKED_FAILURES = 64

/**
 * The delay before the next automatic check.
 *
 * Stateful only in its failure count: {@link next} takes the *previous* outcome and
 * returns the wait that follows it, which is the smallest unit that can be tested
 * without a clock.
 */
export class UpdateSchedule {
  private failures = 0

  /**
   * @param config - validated polling settings.
   * @param random - uniform sample in `[0, 1)`; injected so tests are deterministic.
   */
  constructor(
    private readonly config: UpdateScheduleConfig = { intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0.2 },
    private readonly random: () => number = Math.random,
  ) {}

  /** Consecutive failures seen so far; reset by a success. */
  get consecutiveFailures(): number {
    return this.failures
  }

  /**
   * The delay to wait before the next check.
   *
   * @param outcome - how the previous check ended.
   * @returns the delay in milliseconds, jittered and never below one second.
   */
  next(outcome: 'ok' | 'failed'): number {
    if (outcome === 'ok') this.failures = 0
    else this.failures = Math.min(this.failures + 1, MAX_TRACKED_FAILURES)
    // `2 ** failures` overflows to Infinity long before the cap is reached, and
    // `Math.min` then returns the cap — which is the intended answer, so no guard
    // is needed beyond bounding the counter itself.
    const base = Math.min(this.config.intervalMs * 2 ** this.failures, this.config.maxBackoffMs)
    const factor = 1 + this.config.jitter * (this.random() * 2 - 1)
    // The cap binds the *jittered* result, not just the base. Applying the jitter
    // after the cap let a 20% spread push an hour-long delay to seventy-two
    // minutes — and at the timer's limit it produced a delay `setTimeout` cannot
    // represent, which it silently converts to 1ms: a tight retry loop exactly
    // where the code meant to be backing off hardest.
    const jittered = Math.min(base * factor, this.config.maxBackoffMs)
    return Math.max(MIN_DURATION_MS, Math.round(jittered))
  }

  /** Forget the failure history, as a fresh start does. */
  reset(): void {
    this.failures = 0
  }
}
