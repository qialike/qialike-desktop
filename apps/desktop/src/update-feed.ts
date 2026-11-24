/**
 * Where an update feed comes from, if anywhere.
 *
 * TWO SOURCES, ONE ORDER. The environment wins over the packaged configuration so
 * that a developer or a fork can point a build at a test feed without rebuilding
 * it; the packaged `app-update.yml` is what a released artifact uses, and it is
 * written by electron-builder from the build's `publish` configuration.
 *
 * A MISSING FEED IS NORMAL, NOT AN ERROR. This application can be built and
 * shipped by anyone (`DSH_QIALIKE` and a public harness checkout are all it
 * needs), and most such builds have no update server behind them. So "no feed" is
 * a state the shell reports once and then leaves alone — not a failure to log on
 * every poll, and not something that makes the update badge show an error.
 *
 * @module @qialike/desktop/update-feed
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateFeed } from './update-contract.ts'

/** The environment variable that overrides the packaged feed. */
export const UPDATE_URL_ENV = 'QIALIKE_DESKTOP_UPDATE_URL'

/**
 * Resolve the feed for this run.
 *
 * @param options.env - the process environment.
 * @param options.packaged - `app.isPackaged`; a development run has no
 *   `app-update.yml` and no business checking a release feed.
 * @param options.resourcesPath - `process.resourcesPath`, where electron-builder
 *   writes `app-update.yml`.
 * @returns the feed, or undefined when this build has none.
 * @throws Error when the override is set but is not an http(s) URL — a typo'd URL
 *   would otherwise present as "the update server is unreachable" forever.
 */
export function resolveUpdateFeed(options: {
  env: NodeJS.ProcessEnv
  packaged: boolean
  resourcesPath: string
}): UpdateFeed | undefined {
  const override = (options.env[UPDATE_URL_ENV] ?? '').trim()
  if (override.length > 0) {
    let parsed: URL
    try {
      parsed = new URL(override)
    } catch {
      throw new Error(`${UPDATE_URL_ENV} must be an absolute URL, got ${JSON.stringify(override)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${UPDATE_URL_ENV} must be an http(s) URL, got ${JSON.stringify(override)}`)
    }
    // Trailing slashes would produce `…//latest.yml`, which some servers 404.
    return {
      kind: 'url',
      url: override.replace(/\/+$/u, ''),
      packagedConfig: existsSync(join(options.resourcesPath, 'app-update.yml')),
    }
  }
  if (options.packaged && existsSync(join(options.resourcesPath, 'app-update.yml'))) {
    return { kind: 'bundled' }
  }
  return undefined
}

/**
 * Whether a resolved feed can actually complete a download.
 *
 * Kept separate from {@link resolveUpdateFeed} because it is a diagnostic about
 * the *combination* of build and environment, and the caller is what knows where
 * to report it. It exists because the failure it describes is genuinely confusing:
 * an overridden URL makes the update check work perfectly — the feed is read, the
 * version is compared, the badge lights up — and then the download fails, because
 * `electron-updater` reads the packaged `app-update.yml` unconditionally while
 * preparing it. Nothing in that sequence points at the missing file.
 *
 * @param feed - the resolved feed.
 * @returns a warning to log, or undefined when the feed is complete.
 */
export function updateFeedWarning(feed: UpdateFeed | undefined): string | undefined {
  if (feed === undefined || feed.kind !== 'url' || feed.packagedConfig) return undefined
  return `the runtime feed (${UPDATE_URL_ENV}) is set but this package carries no app-update.yml, so an `
    + 'update check will succeed and the download that follows will fail. Set the variable when '
    + '*building* so electron-builder writes the file, and use it at run time only to retarget a build '
    + 'that already has one.'
}
