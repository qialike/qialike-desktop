/**
 * Checked accessors for the harness services this application reads.
 *
 * The booted context arrives as `Context` with `unknown` services (see
 * `types/harness.d.ts` for why the real augmentations are not imported). These
 * accessors narrow that to the shapes this application uses, and — because they
 * check at runtime — turn "the harness renamed a service" or "a row was disabled
 * by a patch this build applied" into a named error at the point of use, instead
 * of a property read on `undefined` somewhere further along the boot.
 *
 * @module @qialike/qialike-desktop-host/harness-context
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * `@deepseek-ai/dsh-host-webserver`: the bound HTTP server.
 *
 * `port` is read back rather than assumed: the profile may be configured to bind
 * port 0, and the shell's proxy has to forward to whatever was actually bound.
 */
export interface WebServerService {
  readonly port: number
  readonly host: string
  /**
   * The index-injection rows the browser client needs in order to start.
   *
   * THE PEER IS REQUIRED AGAIN IN 0.2.2-rc.1, and this signature has now changed three times: rc.3
   * required it, rc.5 dropped it, 0.2.2-rc.1 restored it. `dsh-api-remote-access` reads
   * `peer.principal` to choose which access snapshot to inject, so calling with no argument is not a
   * missing row — it is a boot crash.
   *
   * @param peer - the Peer the document speaks for; this application's own window is the owner.
   * @returns rows in subscriber activation order.
   */
  collectIndexInjections(peer: PeerScope): readonly unknown[]
}

/**
 * The subset of `PeerScope` this file needs.
 *
 * Declared structurally rather than imported so this type does not depend on how upstream factors
 * the class. Only `principal` is read by the injection collector, and only its `kind` decides which
 * access snapshot goes into the page — this application's own window is the owner.
 */
export interface PeerScope {
  readonly principal: { readonly kind: string }
}

/**

/**
 * `@deepseek-ai/dsh-client-connection`: the authenticated transport.
 *
 * `authenticatedUrl` mints a URL carrying this process's access token. The shell exchanges it for a
 * cookie exactly once, at startup, and never forwards the token to a renderer.
 *
 * THIS METHOD HAS MOVED FOUR TIMES AND THE COMMENT IS THE MAP. It was a method here up to 0.2.1-rc.2;
 * 0.2.1-rc.3 moved token minting behind a `webserver/entry-url` event that `dsh-authentication-token`
 * subscribed to; 0.2.2-rc.3 still used that event, with the package renamed; 0.2.2-rc.5 deletes the
 * package outright and calls this method again — `packages/bundle/web-app` announces with
 * `connection.authenticatedUrl(webUrl)`, exactly as it did before rc.3. Each move fails at BOOT and
 * not at compile time, so the accessor and the declaration travel together.
 */
export interface ConnectionService {
  authenticatedUrl(url: string): string
}

/** Read a service, or fail with a message naming it and the likely causes. */
function service<T>(ctx: Context, name: string, check: (value: unknown) => value is T): T {
  const value = ctx[name]
  if (value === undefined) {
    throw new Error(
      `qialike-desktop-host: the profile provides no ${JSON.stringify(name)} service. `
      + 'The bundle row that provides it is missing or disabled — check the composed layers '
      + '(dsh-base, dsh-web-app, @qialike/qialike-desktop-app) and any patch row that disables it.',
    )
  }
  if (!check(value)) {
    throw new Error(
      `qialike-desktop-host: the ${JSON.stringify(name)} service does not have the shape this build `
      + 'expects. The harness changed it; update the accessor in apps/desktop-host/src/harness-context.ts '
      + 'and the declaration in apps/desktop-host/types/harness.d.ts to match.',
    )
  }
  return value
}

/** The bound HTTP server. */
export function webServerOf(ctx: Context): WebServerService {
  return service(ctx, 'webServer', (value): value is WebServerService => (
    typeof (value as WebServerService).collectIndexInjections === 'function'
    && typeof (value as WebServerService).port === 'number'
  ))
}

/**
 * The authenticated client transport.
 *
 * @param ctx - the host context.
 * @returns the `connection` service, whose `authenticatedUrl` mints a URL carrying this process's
 *   access token.
 * @throws Error when the profile provides no `connection` service, or one without that method.
 */
export function connectionOf(ctx: Context): ConnectionService {
  return service(ctx, 'connection', (value): value is ConnectionService => (
    typeof (value as ConnectionService).authenticatedUrl === 'function'
  ))
}
