/**
 * Turning the shell's update state into what the renderer may see.
 *
 * The filtering is the point. `UpdateState` carries a raw diagnostic and a failed
 * operation; `UpdatePresentation` carries neither — only a phase, a version, a
 * whole-number percentage, and a failure *kind* the client can localize. Two
 * consequences worth stating, because both are deliberate:
 *
 *   · **The percent is floored.** A progress bar that shows 99.7% and then sits
 *     there while the download finishes reads as a hang. Rounding down means 100%
 *     appears only when it is true.
 *   · **`failure` is present only in the `error` phase.** A kind attached to a
 *     healthy phase would leave the client with two sources of truth for "is
 *     something wrong", and the badge would have to decide which one wins.
 *
 * @module @qialike/desktop/update-presentation
 */

import type { UpdateFailureKind, UpdatePresentation, UpdateState } from './update-contract.ts'

/**
 * Transport failures, as Node and Chromium spell them.
 *
 * Classified rather than reported verbatim because the user-facing difference is
 * whether *they* can do something: an unreachable feed is worth a different
 * message from an artifact that failed to install.
 */
const NETWORK_FAILURE = /\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN)\b/u

/**
 * Which failure kind a state describes.
 *
 * @param state - the shell's current state.
 * @returns the kind, defaulting to the install operation when none was recorded.
 */
export function updateFailureKind(state: UpdateState): UpdateFailureKind {
  const operation = state.failedOperation ?? 'install'
  if (state.failure !== undefined) return state.failure
  return NETWORK_FAILURE.test(state.message ?? '') ? `${operation}-network` : operation
}

/**
 * Project the shell's state onto what the renderer may know.
 *
 * @param state - the shell's current state.
 * @returns the presentation, carrying no diagnostics and no controls.
 */
export function presentUpdate(state: UpdateState): UpdatePresentation {
  return {
    phase: state.phase,
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.percent === undefined ? {} : { percent: Math.floor(state.percent) }),
    ...(state.phase === 'error' ? { failure: updateFailureKind(state) } : {}),
  }
}
