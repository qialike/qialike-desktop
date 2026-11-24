# qialike desktop

English | [中文](README.zh.md)

A desktop application for [qialike](https://github.com/qialike/qialike), built on
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

**It shares one home with the qialike CLI.** Sessions, credentials, provider configuration and colour
schemes are the same files, so a session you start in the terminal appears here and a provider you
configure here is the one the terminal uses.

## Install

**Linux x86-64 and Windows x86-64 are the supported targets.** Each one is built on its own platform —
the native components cannot be cross-produced — so a release carries one installer per platform.

```sh
# Linux
chmod +x qialike-desktop-linux-*.AppImage
./qialike-desktop-linux-*.AppImage

sudo dpkg -i qialike-desktop-linux-*.deb     # or the Debian package

# Windows
qialike-desktop-win-x64.exe                  # per-user installer, no admin rights needed
```

| | |
|---|---|
| **AppImage** | Self-contained, ~232 MB. Needs **libfuse2**; without it, run `./qialike-desktop-linux-*.AppImage --appimage-extract-and-run`. |
| **deb** | ~173 MB, for **Debian-family** distributions. The executable is `qialike`. |
| **Windows installer** | NSIS, ~204 MB, installs per user. The executable is `qialike-desktop`. Unsigned unless the release notes say otherwise, so SmartScreen warns on first run. |
| **glibc** | **≥ 2.28** (Ubuntu 20.04 or newer). A musl-based distribution is not supported. |
| **Architecture** | **x86-64 only.** arm64 is not a target, so it is refused rather than attempted. |
| **macOS** | **Not built.** The native components cannot be cross-produced, so each target has to be built on its own platform. |

Verify a download against the `SHA256SUMS` published beside it:

```sh
sha256sum -c SHA256SUMS
```

Download the newest artifact from the [releases page](https://github.com/qialike/qialike-desktop/releases/latest)
or from its GitCode mirror. Each release carries the installers, the `SHA256SUMS` above and the
`latest*.yml` update manifests.

## First run

The application opens on a welcome page that asks for a model provider and an API key. The key is
stored in `~/.dsh/.credentials.yaml` — **the same file the CLI reads**, so configuring either one
configures both.

The welcome page is driven by that credential store rather than by a "seen it" flag:

- configure a key in the CLI first and the page **does not appear** here;
- clear the store and it **comes back**, because as far as the application is concerned nothing is
  configured.

You can also reach all of this later under **Settings → Providers**, where routes can be added,
disabled, re-enabled and removed, and new models can be discovered from the provider itself.

## What it shares with the CLI

| Path | Shared? | Notes |
|---|---|---|
| `~/.dsh/sessions/` | **Yes** | The session corpus. A session started in either product is openable in the other. |
| `~/.dsh/storages/` | **Yes** | Workspace registry and session projections. |
| `~/.dsh/.credentials.yaml` | **Yes** | API keys and authorization. |
| `~/.dsh/qialike.json`, `~/.dsh/themes/` | **Yes** | Provider routes, the colour scheme, your own schemes. |
| `~/.dsh/profiles/qialike-desktop/` | No | Only executable state: the package set, lockfile and patch layer. |
| Harness settings, per profile | No | **Not shared.** A setting changed here does not appear in the CLI, and vice versa. |

`$DSH_HOME` moves the shared home; it defaults to `~/.dsh`.

## Using it

**Right sidebar.** A file tree for the session's workspace, a document preview (Markdown, code, text,
PDF, images, spreadsheets, Word and PowerPoint) and a terminal. Previews reload by themselves when the
file changes — including when something outside the application changes it.

**Follow edited files** (on by default, under **Settings → General**) moves that preview to whatever
file the agent is editing. Three rules keep it from taking the window over, and they are not optional:

- it **never moves while the right sidebar is collapsed** — opening a preview expands the sidebar,
  which would rearrange a window you are not looking at;
- it **stops as soon as you open a different file yourself**, and resumes at the next turn, or when
  you switch it off and on again;
- **subagents are reported, never followed.** A subagent works in its own session, behind whatever you
  are looking at, so the session header names the subagent and its most recent file, with **Show it**
  to go there and **Dismiss** to ignore it. A subagent that rewrites thirty files still leaves one
  row, and at most three rows appear at once.

A step that touches more than three files at once does not move the preview either: there is no single
file being edited, and picking one would be a guess. The switch turns all of this off.

**Colour schemes.** **Settings → General → Theme** offers the CLI's fifteen schemes — thirteen classic
skins plus Atom One Light and One Dark — alongside the two the harness ships. Drop your own
`{ "name": …, "palette": … }` file into `~/.dsh/themes/` and it appears in the list. The choice is
written to `qialike.json`, so `/theme dracula` in the terminal and a click here are the same act.

**Language.** **Settings → General → Language** switches the interface between English and 中文, and
the rows this application adds are translated with it.

**Permissions.** New sessions start in **Workspace Write** with approvals **asked for**. Both are
changeable per session from the composer; an approval prompt names what is being asked for and by
whom.

**Session log upload.** **Settings → General → "Upload Session Log when using the official model
API"** is on by default and was on before it was a switch — it exists so it can be turned off. Nothing
is uploaded during ordinary use; the log is released only when you send feedback from within the
application.

**Updates.** The application checks for updates if a feed was configured when it was built, and shows
a status badge. With no feed — the normal case for a build you made yourself — it logs one line at
startup and the badge stays out of the way. The window is told only the phase, the version and the
progress; it is never given the feed address and cannot start an install by itself.

## Troubleshooting

**The window is still there but nothing works.** The backend is a child process, and if it dies the
window can outlive it. A crash writes a report to `~/.config/@qialike/desktop/crashes/host-<time>.txt`
— mode 0600, because it carries paths and whatever the backend printed — and shows a dialog naming
that path, offering quit or restart. The file is written **before** the dialog, so it is there even if
you click straight through. Normal quits do not produce one. (The directory is named after the
package, so it really is `@qialike/desktop` — that is the package name, not a typo.)

**Seeing the logs.** There is no log file: the application writes to standard output. To read it, run
it from a terminal:

```sh
./qialike-desktop-linux-*.AppImage               # or: qialike
```

`qialike desktop: no update feed configured; update checks are disabled` is expected for a build
without a feed. A line about a **declined WebSocket handshake** means the shell refused to
authenticate a connection and names the origin it came from; that line exists because the failure is
otherwise invisible from every direction.

**It will not start a second time.** The profile is locked while the application runs. If a previous
instance was killed rather than quit, that lock is what refuses the next launch — quit it properly, or
remove the stale lock under `~/.dsh/profiles/qialike-desktop/`. The log names the instance holding the
lock.

**The window cannot be reached from a second display or a screenshot tool.** The interface is served
over a private application scheme rather than a local HTTP port, which is deliberate: nothing else on
the machine can talk to the backend.

## What is not verified

Stated plainly, because a user guide that only lists successes is a worse guide:

- **Appearance.** Contrast ratios are computed and asserted. Whether the result *looks* good is not,
  and this project does not claim it.
- **Applying an update.** Downloading and verifying an update is verified end to end. *Installing*
  one replaces the running file and restarts it, which destroys the observer and cannot be undone;
  treat it as untested.
- **The crash dialog in a real crash.** The report format and the observer are tested against a real
  child process; the dialog has not been seen produced by an actual backend death.
- **macOS.** Not built. Configuration is complete, and the build policy refuses to produce it
  anywhere but its own platform.
- **A signed Windows build.** The Windows installer is produced unsigned unless signing material is
  supplied, so SmartScreen has to be clicked through.
- **arm64.** Not a target.

## Issues and contributing

- **Report a problem or request a feature**: [GitHub Issues](https://github.com/qialike/qialike-desktop/issues).
- **Report a vulnerability**: **not** through a public issue — see [SECURITY.md](SECURITY.md) for the
  private channel, the scope, and what counts as working as designed.
- **Contribute**: see [CONTRIBUTING.md](CONTRIBUTING.md) — the two read-only upstream checkouts, the
  build order, the tests CI runs on a fresh clone, and the patch layer.
- **See what changed**: [CHANGELOG.md](CHANGELOG.md); older releases are on the
  [releases page](https://github.com/qialike/qialike-desktop/releases).
- **Conduct**: participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Documents

| Document | What it is |
|---|---|
| `README.md` / [`README.zh.md`](README.zh.md) | **This file** — the user guide, in English and Chinese |
| `CHANGELOG.md` / [`CHANGELOG.zh.md`](CHANGELOG.zh.md) | What changed in each release, newest first |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability, and which behaviours are deliberate |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Building from source, the test and release tooling, and the patch layer |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | The expectations for participation |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | The third-party packages this application adds directly |

## Acknowledgements

qialike desktop is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), and
composes the [qialike CLI](https://github.com/qialike/qialike) rather than reimplementing what it
already does. qialike is an independent community project, not affiliated with, cooperating with,
authorized by or endorsed by DeepSeek. "DeepSeek Harness" is a registered trademark of DeepSeek; it is
used here only to describe the technical origin and the relationship to the upstream software
accurately.

## License

[MIT](LICENSE)

**The name and wordmark are outside the license grant**: the rights MIT grants — to use, modify and
redistribute — cover the **software itself**, not the `qialike` name or its wordmark. They identify
this project only; do not imply endorsement or partnership.

Third-party dependencies and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
