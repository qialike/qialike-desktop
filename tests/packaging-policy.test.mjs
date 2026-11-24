/**
 * The packaging policy: which platform may be built where, and whether it may
 * ship unsigned.
 *
 * This suite exists because half of the policy is unreachable by running the
 * packager. The platform check runs first, so on a Linux host a macOS build is
 * refused before the signing rule is ever consulted — meaning the rule that
 * matters most (never produce an unsigned release artifact by accident) is exactly
 * the one a developer here cannot try. As a pure function of
 * `(target, host, env)` it is exercised on every host.
 *
 * The property under test is fail-closed: the dangerous outcome is not a build
 * that fails, it is one that quietly succeeds and produces artifacts
 * indistinguishable from signed ones until users install them.
 */

import { describe, expect, it } from 'vitest'
import { TARGETS, UNSIGNED_ENV, hasSigningMaterial, signingDecision } from '../apps/desktop-bin/lib/signing.mjs'

/** A certificate, in the form electron-builder reads. */
const CERT = { CSC_LINK: 'file:///tmp/cert.pfx', CSC_KEY_PASSWORD: 'hunter2' }

describe('targets', () => {
  it('names the three platforms this application ships for', () => {
    expect(Object.keys(TARGETS).sort()).toEqual(['linux', 'mac', 'win'])
  })

  it('requires a signature on the two platforms that have a trust story', () => {
    // Linux is false not because unsigned Linux packages are good, but because
    // there is no Linux code-signing story worth the name; requiring a certificate
    // would make the one platform that builds anywhere the one that never builds.
    expect(TARGETS.mac.requiresSignature).toBe(true)
    expect(TARGETS.win.requiresSignature).toBe(true)
    expect(TARGETS.linux.requiresSignature).toBe(false)
  })
})

describe('hasSigningMaterial', () => {
  it('accepts the variables electron-builder itself reads', () => {
    expect(hasSigningMaterial('mac', CERT)).toBe(true)
    expect(hasSigningMaterial('win', CERT)).toBe(true)
    expect(hasSigningMaterial('win', { WIN_CSC_LINK: 'file:///tmp/cert.pfx' })).toBe(true)
    expect(hasSigningMaterial('mac', { CSC_NAME: 'Developer ID Application: Someone' })).toBe(true)
  })

  it('does not mistake an empty or blank variable for a certificate', () => {
    // The failure this prevents: a CI job that exports `CSC_LINK=` from an unset
    // secret and gets an unsigned artifact that the policy believed was signed.
    expect(hasSigningMaterial('mac', { CSC_LINK: '' })).toBe(false)
    expect(hasSigningMaterial('mac', { CSC_LINK: '   ' })).toBe(false)
    expect(hasSigningMaterial('win', {})).toBe(false)
  })

  it('reports none for Linux, which has nothing to look for', () => {
    expect(hasSigningMaterial('linux', CERT)).toBe(false)
  })
})

describe('signingDecision', () => {
  it('refuses an unknown target', () => {
    const decision = signingDecision({ targetName: 'freebsd', hostPlatform: 'freebsd', env: {} })
    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('unknown target')
  })

  it('refuses a target that is not the host', () => {
    // Native prebuilds cannot be cross-produced (DESIGN §3 D13): the artifact would
    // install and then fail to keep a session lock. A warning would ship it.
    for (const [targetName, host] of [['mac', 'linux'], ['win', 'linux'], ['linux', 'darwin'], ['mac', 'win32']]) {
      const decision = signingDecision({ targetName, hostPlatform: host, env: CERT })
      expect(decision.ok, `${targetName} on ${host}`).toBe(false)
      expect(decision.reason).toContain('cannot be cross-produced')
    }
  })

  it('builds Linux from Linux with nothing configured', () => {
    const decision = signingDecision({ targetName: 'linux', hostPlatform: 'linux', env: {} })
    expect(decision.ok).toBe(true)
    expect(decision.signed).toBe(false)
    // Not "unsigned" in the sense that needs a notice: Linux artifacts are
    // checksummed, and there was never a signature to lose.
    expect(decision.unsigned).toBe(false)
  })

  it('refuses macOS and Windows without signing material', () => {
    for (const targetName of ['mac', 'win']) {
      const host = TARGETS[targetName].platform
      const decision = signingDecision({ targetName, hostPlatform: host, env: {} })
      expect(decision.ok, targetName).toBe(false)
      expect(decision.reason).toContain('refusing to build an unsigned')
      // The refusal has to carry the remedy, or the next person works it out from
      // the source.
      expect(decision.reason).toContain('CSC_LINK')
      expect(decision.reason).toContain(UNSIGNED_ENV)
    }
  })

  it('builds macOS and Windows when a certificate is configured', () => {
    for (const targetName of ['mac', 'win']) {
      const decision = signingDecision({ targetName, hostPlatform: TARGETS[targetName].platform, env: CERT })
      expect(decision.ok, targetName).toBe(true)
      expect(decision.signed).toBe(true)
      expect(decision.unsigned).toBe(false)
    }
  })

  it('builds them unsigned only when the opt-out says so, and records that it is', () => {
    for (const targetName of ['mac', 'win']) {
      const decision = signingDecision({
        targetName,
        hostPlatform: TARGETS[targetName].platform,
        env: { [UNSIGNED_ENV]: '1' },
      })
      expect(decision.ok, targetName).toBe(true)
      expect(decision.signed).toBe(false)
      // The caller writes an UNSIGNED notice for exactly this case.
      expect(decision.unsigned).toBe(true)
    }
  })

  it('does not treat a falsy opt-out as consent', () => {
    // `DSH_DESKTOP_UNSIGNED=0` is an explicit "no", not a present variable.
    for (const value of ['0', '', '   ']) {
      const decision = signingDecision({ targetName: 'mac', hostPlatform: 'darwin', env: { [UNSIGNED_ENV]: value } })
      expect(decision.ok, JSON.stringify(value)).toBe(false)
    }
  })

  it('never claims an unsigned Linux build needs a notice', () => {
    // The notice is about a lost signature. Writing one for a platform that is
    // never signed would train people to ignore it.
    const decision = signingDecision({ targetName: 'linux', hostPlatform: 'linux', env: { [UNSIGNED_ENV]: '1' } })
    expect(decision.unsigned).toBe(false)
  })

  it('carries every action the caller must take', () => {
    // The caller acts on the decision and nothing else. It used to re-derive part
    // of it — `!signed` for the unsigned notice — which is true on Linux, where no
    // signature was ever expected, so every Linux build wrote an UNSIGNED file. The
    // policy was right and the caller was wrong, and only the policy was tested.
    const linux = signingDecision({ targetName: 'linux', hostPlatform: 'linux', env: {} })
    expect({ unsigned: linux.unsigned, checksums: linux.checksums }).toEqual({ unsigned: false, checksums: true })

    const unsignedMac = signingDecision({ targetName: 'mac', hostPlatform: 'darwin', env: { [UNSIGNED_ENV]: '1' } })
    expect({ unsigned: unsignedMac.unsigned, checksums: unsignedMac.checksums }).toEqual({ unsigned: true, checksums: true })

    const signedMac = signingDecision({ targetName: 'mac', hostPlatform: 'darwin', env: CERT })
    expect({ unsigned: signedMac.unsigned, checksums: signedMac.checksums }).toEqual({ unsigned: false, checksums: true })
  })

  it('checks the host before the signature', () => {
    // Order matters for the message a user gets: told to set a certificate on a
    // platform that cannot build the target, they would set one and be refused
    // again for a different reason.
    const decision = signingDecision({ targetName: 'mac', hostPlatform: 'linux', env: {} })
    expect(decision.reason).toContain('cannot be cross-produced')
    expect(decision.reason).not.toContain('CSC_LINK')
  })
})
