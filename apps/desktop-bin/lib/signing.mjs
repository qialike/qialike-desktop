/**
 * The packaging policy: which platform, and whether it may ship unsigned.
 *
 * WHY THIS IS A MODULE AND NOT A FEW `if`s IN THE SCRIPT. Every rule here is one
 * somebody could get wrong in a way that produces a working-looking artifact, and
 * the platform check runs before the signing check — so on any given host, half of
 * this is unreachable by running the packager. As a pure function of
 * `(target, host, env)` it is exercised on every host, and the security-relevant
 * half is no longer the half nobody can try.
 *
 * @module qialike-desktop/signing
 */

/**
 * The `DSH_DESKTOP_UNSIGNED` escape hatch, as the harness's own desktop spells it.
 *
 * Reusing that name is deliberate: an operator who has learned how to produce an
 * unsigned build of one application should not have to learn a second spelling for
 * the same decision.
 */
export const UNSIGNED_ENV = 'DSH_DESKTOP_UNSIGNED'

/** Whether an environment value is present and non-empty. */
export function hasEnv(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Whether the unsigned opt-out is actually turned on.
 *
 * `0` is a falsey spelling of "no", not a present variable, and treating it as
 * consent would fail *open* — the direction that ships an artifact nobody meant to
 * ship. Any other non-empty value is consent: `1`, `true`, `yes`, and anything
 * else an operator typed meaning it.
 *
 * @param env - the process environment.
 * @returns whether unsigned builds are permitted.
 */
export function unsignedAllowed(env) {
  return hasEnv(env[UNSIGNED_ENV]) && env[UNSIGNED_ENV].trim() !== '0'
}

/**
 * What each target platform asks electron-builder for, and how it is signed.
 *
 * `requiresSignature` is the load-bearing field. Linux is `false` not because
 * unsigned Linux packages are good but because there is no Linux code-signing
 * story worth the name — requiring a certificate would make the one platform that
 * builds anywhere the one that never builds, and the checksum is what a downloader
 * can actually verify.
 */
export const TARGETS = {
  linux: { platform: 'linux', args: ['--linux', 'AppImage', 'deb'], requiresSignature: false, checksums: true },
  mac: { platform: 'darwin', args: ['--mac', 'dmg', 'zip'], requiresSignature: true, checksums: true },
  win: { platform: 'win32', args: ['--win', 'nsis'], requiresSignature: true, checksums: true },
}

/**
 * Whether the environment carries signing material electron-builder will find.
 *
 * Only presence is checked. Whether a certificate is *valid* is electron-builder's
 * question, and it answers it loudly; a guess here would either block a good build
 * or wave through a bad one.
 *
 * @param targetName - `linux`, `mac` or `win`.
 * @param env - the process environment.
 * @returns whether signing material appears to be configured.
 */
export function hasSigningMaterial(targetName, env) {
  if (targetName === 'mac') return hasEnv(env.CSC_LINK) || hasEnv(env.CSC_NAME)
  if (targetName === 'win') return hasEnv(env.CSC_LINK) || hasEnv(env.WIN_CSC_LINK) || hasEnv(env.CSC_NAME)
  return false
}

/**
 * Decide whether a packaging run may proceed.
 *
 * Three outcomes, in the order they are checked:
 *
 *   1. an unknown target is an error;
 *   2. a target that is not the host's is refused, because native prebuilds cannot
 *      be cross-produced (DESIGN §3 D13);
 *   3. a target that requires a signature is refused when none is configured,
 *      unless the opt-out is set.
 *
 * The failure is deliberately returned rather than thrown: the caller's job is to
 * print the remedy, and a policy function that also formats console output is a
 * policy function entangled with a terminal.
 *
 * @param options.targetName - the requested platform.
 * @param options.hostPlatform - `process.platform`.
 * @param options.env - the process environment.
 * @returns the decision; `unsigned` and `checksums` are what the caller acts on.
 */
export function signingDecision({ targetName, hostPlatform, env }) {
  const target = TARGETS[targetName]
  if (target === undefined) {
    return {
      ok: false,
      reason: `unknown target ${JSON.stringify(targetName)}; expected one of ${Object.keys(TARGETS).join(', ')}`,
    }
  }
  if (hostPlatform !== target.platform) {
    return {
      ok: false,
      reason: `cannot package for ${targetName} on ${hostPlatform}. A release target's native prebuilds cannot `
        + 'be cross-produced (DESIGN §3 D13), so the artifact would install and then fail to keep a session '
        + `lock. Build on ${target.platform}, or in CI with a per-platform job.`,
    }
  }
  const signed = hasSigningMaterial(targetName, env)
  if (target.requiresSignature && !signed && !unsignedAllowed(env)) {
    return {
      ok: false,
      reason: `refusing to build an unsigned ${targetName} package.\n`
        + '  · To sign it: set CSC_LINK and CSC_KEY_PASSWORD (and for macOS notarization also\n'
        + '    APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID).\n'
        + `  · To build it unsigned on purpose: set ${UNSIGNED_ENV}=1. That writes an UNSIGNED\n`
        + '    notice beside the artifacts, so nobody mistakes them for a release.',
    }
  }
  // Everything the caller needs, so it never has to consult a raw field and get
  // the combination wrong. It did once: the script wrote an UNSIGNED notice for a
  // Linux build by testing `!signed`, while this function — the only part under
  // test — correctly reported `unsigned: false`. The two disagreed and nothing
  // noticed.
  return { ok: true, target, signed, unsigned: target.requiresSignature && !signed, checksums: target.checksums }
}
