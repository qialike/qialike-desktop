/**
 * Answer the shell's "what would quitting now interrupt?" question.
 *
 * The shell asks this before every ordinary quit and shows a confirmation
 * naming what would be lost. Two facts are needed, and they come from different
 * places:
 *
 *   · **Running agents** — a whole-context fact. Any live agent fiber, including
 *     a subagent, counts; so does a session waiting on an approval, because that
 *     session is mid-turn even though nothing is executing.
 *   · **Armed scheduled reminders** — a per-session fact. Upstream derives it
 *     from the `schedule` family over the sessions loaded during this run, and
 *     only for sessions that are actually loaded: an unloaded session's
 *     reminders will not fire either way, so counting them would produce a
 *     confirmation about work that is already not happening.
 *
 * WHAT THIS DOES NOT DO YET. Scheduled reminders are not yet inspected, so this
 * reports `scheduledTasks: false` unconditionally and the shell will not mention
 * them. That is the safe direction for the *prompt* — the failure mode is a
 * missing sentence, not a lost reminder — and it is also correct today, because
 * this profile mounts no `schedule` row: the packages ship in the runtime tree
 * and nothing composes them in. It becomes wrong the moment one is mounted, and
 * nothing would report that. Running agents are reported honestly, which is the
 * case that actually loses work.
 *
 * @module @qialike/qialike-desktop-host/quit-inspection
 */

import type { Context } from '@deepseek-ai/cordis'

/** What quitting now would interrupt. */
export interface QuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/**
 * The agent registry, as far as this module reads it.
 *
 * A count of live agents is all that is needed, and reading it structurally
 * keeps this module from depending on the agent package's full surface.
 */
interface AgentRegistry {
  readonly agents?: readonly unknown[]
  readonly [key: string]: unknown
}

/**
 * Report whether any agent is currently running.
 *
 * The check is deliberately structural and total: any collection the service
 * exposes that holds at least one entry counts as active work. A service whose
 * shape this build does not recognise reports *active*, because the two
 * mistakes are not symmetric — a spurious confirmation costs a click, and a
 * missed one silently discards a running task.
 */
function hasActiveAgents(ctx: Context): boolean {
  const agents = ctx.agents as AgentRegistry | undefined
  if (agents === undefined) return false
  if (Array.isArray(agents.agents)) return agents.agents.length > 0
  // Some revisions expose the collection under a method rather than a property.
  const list = (agents as { list?: () => unknown }).list
  if (typeof list === 'function') {
    const value = list.call(agents)
    if (Array.isArray(value)) return value.length > 0
  }
  return false
}

/**
 * Build the inspection function the shell calls.
 *
 * @param ctx - the booted profile's root context.
 * @returns a function answering one quit-inspection request.
 */
export function installQuitInspection(ctx: Context): () => Promise<QuitInspection> {
  return async () => ({
    activeTasks: hasActiveAgents(ctx),
    // Not yet inspected; see the module note. Reported false rather than
    // guessed at, so the shell's message stays truthful about what was checked.
    scheduledTasks: false,
  })
}
