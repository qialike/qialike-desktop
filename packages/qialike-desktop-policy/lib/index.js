/**
 * The qialike policy row: the CLI's tool fences, mounted on the host plane.
 *
 * WHAT IT GUARDS, AND WHY IT HAS TO EXIST HERE. The harness's `SandboxMode`
 * promises FILE EFFECTS only, and every backend grants the whole host root
 * read-only — so nothing below the tool layer stops a model, or an injected page
 * driving one, from reading the user's secrets. The CLI closes that with a
 * `tools/pre-execute` listener inside its app entry. This profile does not mount
 * that entry (it statically imports `ink` and `react`), so without this row the
 * product ships with **no** secrets guard at all while DESIGN §7.5 says it has one.
 * Two rules are mounted, in the CLI's own words:
 *
 *   · **the secrets read guard** — `.env`-family files, `.git` internals and the
 *     credential document are never readable. It is a *confidentiality* rule, not
 *     a file-effect boundary: it is mode-INDEPENDENT, so `danger-full-access` does
 *     not lift it and neither does any escalation.
 *   · **the shell fences** — `read-only` denies mutating shell commands with an
 *     actionable reason instead of an opaque OS failure, and a host whose shell
 *     executor applies no kernel confinement asks for approval on every shell call
 *     rather than letting it run with the user's full authority.
 *
 * WHY THE HOST PLANE IS THE CORRECT PLANE. The web surface moves the *agent* plane
 * behind per-session presets, so `read`/`write`/`bash` register into a preset's
 * layer. A registry of this shape is host+per-scope layered: a row outside any
 * preset registers into the **global** layer, and each agent reads the merged
 * catalog its scope chain selects. Registering here is therefore both what makes
 * the guard reach every session and what keeps it from colliding with a preset's
 * own rows — it adds a *listener*, not a tool name.
 *
 * WHAT IS NOT REIMPLEMENTED. The decisions are the CLI's own functions, compiled
 * from its sources by `apps/desktop-bin/lib/cli-policy.mjs`. There is no second
 * implementation to drift: if the CLI changes a rule, this row changes with it.
 *
 * @module @qialike/qialike-desktop-policy
 */

import { blockedReadDecision } from './read-policy.js'
import { isShellTool, readOnlyBashDecision, unconfinedShellAskDecision } from './bash-policy.js'

/** The row's id, and the name the profile patch inserts it under. */
export const name = 'qialike-policy'

/**
 * Services this row reads.
 *
 * `tools` is where the listener hangs from. `sandboxPolicy` is the harness's own
 * service for "which mode applies to this call" — it outranks a session's last
 * `sandbox/mode` event, which outranks the deployment default — and reading it
 * rather than a private copy is what keeps this fence consistent with the fs
 * sandbox that fences the same calls.
 */
export const inject = ['tools', 'sandboxPolicy']

/**
 * The effective sandbox mode for one call.
 *
 * Resolved per call through the harness's service and keyed by the calling
 * session, exactly as `dsh-tool-bash` resolves its own policy: a deployment
 * default, a session override, and an approved explicit override are three
 * different answers, and only the service knows which one this call gets.
 *
 * @param ctx - the plugin context.
 * @param exec - the tool execution under decision.
 * @returns the mode in effect for that call.
 */
function effectiveMode(ctx, exec) {
  const session = exec?.agent?.session
  return ctx.sandboxPolicy.resolve(session === undefined ? {} : { session }).mode
}

/**
 * Register the fences.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    // THE READ GUARD IS EVALUATED FIRST, and deliberately so. It is mode-independent
    // — a confidentiality rule no sandbox mode widens — so it must not depend on the
    // sandbox services answering. Nothing below this line runs for a blocked read;
    // on a host where the mode cannot be resolved, the credential document is still
    // refused. The CLI orders these the other way because its mode comes from a
    // store it already holds; here the order is also the independence.
    const blocked = blockedReadDecision(exec)
    if (blocked !== undefined) return blocked

    // The two shell fences both need the mode, and neither applies to a non-shell
    // tool, so the resolution is confined to the calls that consume it. A failure
    // here propagates rather than falling through: an unresolved boundary on a
    // shell call must not become an unguarded one.
    if (!isShellTool(exec?.name)) return next()
    const permission = effectiveMode(ctx, exec)
    const shellConfines = ctx.get('shell')?.sandboxMode !== undefined

    return readOnlyBashDecision(exec, permission)
      ?? unconfinedShellAskDecision(exec, { permission, shellConfines })
      ?? next()
  })
}
