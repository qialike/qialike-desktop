/**
 * Host marker for the continuous voice-input row.
 *
 * The whole feature is browser behavior: recording, the silence detector and the draft
 * insertion all run in the page, and the transcription itself is the speech Remote the
 * Host already serves. So this half exists only so that something can be *mounted* —
 * a client bundle reaches the browser only through a mounted Loader row.
 *
 * @module @qialike/qialike-desktop-voice
 */

export function apply() {}
