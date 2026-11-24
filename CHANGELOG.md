# Changelog

Notable changes to Qialike Desktop, newest first. **This file starts at 0.9.0**, the first
release whose source is published in this repository.

Versioning is [SemVer](https://semver.org/). The embedded DeepSeek Harness is a developer preview, so
while that is true a minor bump may carry a breaking change — those are marked `!`.

**One line per change point.**

## [0.9.0] - 2026-11-23

### Changed

- **Harness `0.2.2-rc.5`, CLI `0.16.0`** — the auth method reverses, one base default moves.

### Fixed

- **Host boots on rc.5** — `connection.authenticatedUrl()` is back.
- **Web search pinned to the per-search API** — not the model route.
