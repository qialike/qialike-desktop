/**
 * The harness surface this application consumes, declared explicitly.
 *
 * Why this file exists instead of importing the real declarations. Every type
 * below belongs to a `@deepseek-ai/*` package this repository does not depend on
 * at build time and cannot: those packages live in a read-only checkout, they
 * are only resolvable after the farm has been composed, and pointing
 * `tsconfig.paths` at either would make `tsc` require a completed build — so
 * `pnpm test` on a fresh clone would fail before it could say why.
 *
 * What that buys, beyond decoupling. This file is the **complete** list of
 * harness APIs this application depends on, in one reviewable place. When the
 * harness moves, a changed signature surfaces here as a mismatch against a
 * declaration someone must intentionally update, rather than as a runtime
 * `undefined is not a function` deep inside a boot. The build-time patches
 * achieve the same for the files they edit by asserting their anchors; this
 * achieves it for the API surface.
 *
 * Keep each declaration to what is actually called. A speculative member is a
 * claim about the harness that nothing verifies.
 *
 * Verified against deepseek-harness 0.2.0-rc.2.
 */

declare module '@deepseek-ai/cordis' {
  /**
   * A Cordis context.
   *
   * Deliberately wider than the real declaration. The harness augments
   * `Context` from a dozen packages this repository does not import, and
   * reproducing that augmentation would be a large, fast-rotting copy. Services
   * are therefore read through `unknown` and narrowed by a checked accessor
   * (see `harness-context.ts`), which also turns a missing service into a
   * named error instead of a property access on `undefined`.
   */
  export interface Context {
    readonly [service: string]: unknown

    /**
     * Read a service by name.
     *
     * Declared here rather than left to the index signature because the index
     * signature types it `unknown`, which cannot be called. This is Cordis's own
     * API, not a harness augmentation, so declaring the three members this
     * application calls is a statement about the framework rather than a copy
     * that rots with each harness release.
     */
    get(name: string): unknown

    /**
     * Emit an event, with an optional receiver (the first argument).
     *
     * Cordis supports two spellings: `ctx.emit(name, ...args)` and
     * `ctx.emit(ctx.webServer, name, ...args)`, the second narrowing delivery to one fiber. The
     * harness's `webserver/entry-url` handshake — how this application now obtains its authenticated
     * URL — is collected through the narrowed form, so both are declared. The event name and the
     * arguments are `unknown` because the event catalogue belongs to the harness, not to this file.
     */
    emit(nameOrTarget: unknown, ...args: readonly unknown[]): void

    /**
     * Run a callback once every named service is available, and again if the
     * providing fiber is replaced. A registration made inside is disposed with
     * the scope, which is what makes it the right place to register a route.
     */
    inject(names: readonly string[], callback: (scope: Context) => void): void

    /**
     * Register a side effect tied to the calling fiber. The callback's return
     * value, when it is a function, is its disposer.
     */
    effect(callback: () => void | (() => void), label?: string): void
  }
}

declare module '@deepseek-ai/dsh-app-boot' {
  /** One bundle layer a profile composes. */
  export interface ProfileLayer {
    readonly name: string
    readonly dir: string
  }

  /** A profile's resolved bundle layers, in application order. */
  export interface Profile {
    readonly bundles: readonly ProfileLayer[]
    readonly dir: string
  }

  /** A bundle the profile names but cannot resolve. */
  export interface SkippedBundle {
    readonly packageName: string
    readonly reason: string
  }

  /**
   * Create a profile's manifest, patch layer, and package-manager settings.
   * Never overwrites a file that exists, so repeated calls are no-ops — which is
   * what lets the shell and this process both ensure the profile.
   */
  export function initProfile(dir: string, bundles: readonly string[]): void

  /**
   * Read a profile's manifest and resolve its bundle layers.
   * @param binName - name used in diagnostics (`dsh`).
   * @param dir - the profile directory.
   * @param installAnchor - manifest of the installation bundles resolve from.
   */
  export function loadProfileDirectory(binName: string, dir: string, installAnchor: string): Profile

  /** Report the bundles a profile names but cannot resolve. */
  export function reportSkippedBundles(binName: string, profile: Profile): readonly SkippedBundle[]

  /** Read the layered environment (home `.env`, process env, profile env). */
  export function loadLayeredEnv(binName: string): Record<string, string | undefined>

  /**
   * Bring a profile back to its template bundle list, moving the user's patch
   * layer aside. Returns the backup path, or undefined when there was no layer.
   */
  export function sanitizeProfile(binName: string, profileDir: string, bundles: readonly string[]): string | undefined
}

/**
 * Where `PROFILE_TEMPLATES` is declared in harness 0.2.2-rc.1.
 *
 * THIS SPECIFIER HAS NOW MOVED THREE TIMES, and the declaration has to follow the RUNTIME import
 * rather than the definition:
 *
 *   - up to 0.2.1-rc.2 - exported by `dsh-app-boot`
 *   - 0.2.1-rc.3       - moved to `@deepseek-ai/dsh-official-bundles`
 *   - 0.2.1-rc.5       - back in `dsh-app-boot`, and the official-bundles package was DELETED
 *   - 0.2.2-rc.1       - the package returns and `app-boot` stops exporting it again
 *
 * Keeping the declaration on the wrong specifier makes TypeScript happy while the process fails at
 * load with `Cannot find package ...` or `does not provide an export named 'PROFILE_TEMPLATES'`,
 * which is a boot failure rather than a compile error. 0.2.1-rc.5 taught that the hard way.
 */
declare module '@deepseek-ai/dsh-official-bundles' {
  /** Shipped bundle tuples, keyed by profile name. */
  export const PROFILE_TEMPLATES: Record<string, { readonly bundles: readonly string[] } | undefined>
}

/**
 * The Peer a document speaks for, and the one class this application constructs directly.
 *
 * Required again at the boot handshake in 0.2.2-rc.1: `collectIndexInjections(peer)` reads
 * `peer.principal`. Only construction, `principal` and `dispose` are used here.
 */
declare module '@deepseek-ai/dsh-client-connection' {
  /** One connection's identity: the principal fixed for its lifetime. */
  export class Peer {
    /**
     * @param owner - Context the peer's scope fiber hangs under.
     * @param options - the principal this peer answers as.
     */
    constructor(owner: unknown, options: { readonly principal: { readonly kind: string } })
    /** The principal this peer answers as. */
    readonly principal: { readonly kind: string }
    /** Release the child scope. */
    dispose(): Promise<void>
  }
}

declare module '@deepseek-ai/dsh/profile-boot' {
  import type { Profile } from '@deepseek-ai/dsh-app-boot'
  import type { Context } from '@deepseek-ai/cordis'

  /** Shutdown handle for a booted profile. */
  export interface ProfileShutdown {
    shutdown(exitCode: number): Promise<void>
  }

  /** A booted profile: its root context and its shutdown handle. */
  export interface BootedProfile {
    readonly ctx: Context
    readonly shutdown: ProfileShutdown
  }

  /**
   * Compose and mount a profile's Cordis tree.
   * @returns a promise for the booted profile; rejects on a startup failure.
   */
  export function runProfile(options: {
    environment: Record<string, string | undefined>
    profile: string
    resolvedProfile: { profile: Profile; installAnchor: string }
    patchFiles: readonly string[]
    args: readonly string[]
  }): Promise<BootedProfile>
}

declare module '@deepseek-ai/dsh-home-paths' {
  /**
   * Resolve a path inside the Harness home (`$DSH_HOME`, default `~/.dsh`).
   *
   * The one fact this application needs from the package: the CLI stores
   * `qialike.json` there, and the desktop has to read and write the same file
   * rather than re-deriving the location (DESIGN §12.2 R12).
   */
  export function dshHomePath(...segments: readonly string[]): string
}

declare module '@deepseek-ai/dsh-credentials' {
  /**
   * A credential reference.
   *
   * Declared as an opaque branded string rather than the real shape: the tokens
   * are produced by `credentialRef()` and consumed by the credentials service,
   * so nothing here inspects one.
   */
  export type CredentialRef = string & { readonly __credentialRef?: unique symbol }

  /** Name one credential by reference, validating it is a usable identifier. */
  export function credentialRef(value: string): CredentialRef
}
