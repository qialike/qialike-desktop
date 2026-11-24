/**
 * Which route a shared credential reference belongs to.
 *
 * WHY THIS EXISTS. The CLI's provider catalogue names a credential reference per route, and the
 * reference is often SHARED by routes that serve the same vendor in different regions:
 *
 *   moonshotai      https://api.moonshot.ai/v1   MOONSHOT_API_KEY
 *   moonshotai-cn   https://api.moonshot.cn/v1   MOONSHOT_API_KEY   ← same name
 *
 * Eight groups ship that way (`MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY`, `MINIMAX_API_KEY`,
 * `ZAI_API_KEY`, `STEPFUN_API_KEY`, `XIAOMI_API_KEY`, `ALIBABA_TOKEN_PLAN_API_KEY`,
 * `ALIBABA_CODING_PLAN_API_KEY`). The key itself is not shared: measured with a mainland
 * Moonshot key, `api.moonshot.cn` answers 200 with six models while `api.moonshot.ai` answers
 * 401. One key lights up a route that cannot use it.
 *
 * WHAT WENT WRONG WITHOUT IT. This page decided "is this route configured?" by asking the
 * credential store about the reference name alone, so adding `Moonshot AI (China)` made
 * `moonshotai` appear too — a row for a provider the user never added, which no request can
 * reach. Nothing was written to `qialike.json` (it still held only `moonshotai-cn`); the row
 * was merely misreported.
 *
 * THE RULE. A shared reference belongs to the route(s) the user EXPLICITLY configured, and only
 * those report a key. Explicit configuration is the only trustworthy disambiguator available: the
 * reference name cannot be used to guess, because `MOONSHOT_API_KEY` is derived from `moonshotai`,
 * which is the wrong side of the pair when the key is a mainland one.
 *
 * WHEN NOTHING IS EXPLICIT, EVERY ROUTE SHARING THE REFERENCE KEEPS REPORTING IT. That is the
 * pre-existing behaviour, kept deliberately: a key set outside this page (the TUI writes the same
 * store) leaves no explicit entry to attribute, and silently hiding it would send a user who has a
 * working key back to the first-run screen. This rule only narrows the case where the page itself
 * knows which route the user chose.
 *
 * @module @qialike/qialike-desktop-providers/credential-ownership
 */

/** The parts of a page row this decision needs. */
export interface CredentialRow {
  readonly route: string
  readonly apiKeyEnv: string | undefined
  /** `configured` means the user added this route, so `qialike.json` names it. */
  readonly source: 'builtin' | 'configured' | 'template' | 'unlisted'
}

/**
 * The explicitly configured routes behind each credential reference.
 *
 * @param rows - every row the page will show.
 * @returns reference name to the routes the user configured for it; references with no explicit
 *   configuration are absent rather than mapped to an empty list.
 */
export function credentialOwners(rows: readonly CredentialRow[]): Map<string, readonly string[]> {
  const owners = new Map<string, string[]>()
  for (const row of rows) {
    if (row.apiKeyEnv === undefined || row.source !== 'configured') continue
    const existing = owners.get(row.apiKeyEnv)
    if (existing === undefined) owners.set(row.apiKeyEnv, [row.route])
    else if (!existing.includes(row.route)) existing.push(row.route)
  }
  return owners
}

/**
 * Whether a row should report its key as set.
 *
 * @param row - the row being decided.
 * @param owners - the result of {@link credentialOwners} for the same rows.
 * @param stored - whether the credential store holds a value under the row's reference.
 * @returns true when the reference holds a value AND this route may claim it.
 */
export function reportsKeyConfigured(
  row: CredentialRow,
  owners: ReadonlyMap<string, readonly string[]>,
  stored: boolean,
): boolean {
  if (row.apiKeyEnv === undefined || !stored) return false
  const explicit = owners.get(row.apiKeyEnv)
  return explicit === undefined || explicit.includes(row.route)
}
