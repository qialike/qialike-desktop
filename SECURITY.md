# Security Policy

English | [中文](SECURITY.zh.md)

qialike desktop runs an AI agent that reads your files, edits them and executes shell commands on your
machine — inside an Electron shell that also renders a document preview and a terminal. Its security
properties are therefore part of the product rather than an afterthought: the renderer boundary, the
application scheme, the credential store, the sandbox rungs and the approval boundary are all
described in the [README](README.md), and a report that one of them can be crossed is exactly the kind
of report this file is about.

## Supported versions

Fixes ship as a **new release artifact**. There is no patch branch and no back-porting: the product is
distributed as an AppImage and a deb, so a fix reaches you by installing the new version.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Previous minor release | ✅ (security fixes only) |
| Anything older | ❌ |

Upgrading replaces the application and does not touch your sessions, credentials or settings — those
live in the shared home, `~/.dsh`, not inside the application.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

1. **Preferred** — open a private report through GitHub Security Advisories on this repository
   ("Security" → "Report a vulnerability"). The report, the discussion and the fix stay private until
   an advisory is published.
2. If you cannot use advisories, contact the maintainers through the address published on the
   project's website and say plainly that the message is a security report.

A useful report contains:

- the version — whatever the interface reports, or the artifact filename — and the platform and OS
  build;
- **which half misbehaved.** The window is a renderer; the agent runs in a separate Host process the
  shell boots and supervises. A report that says which one it was is much easier to act on, and both
  the standard output and the crash reports say which;
- the sandbox rung in force — `bubblewrap`, `landlock`, `seatbelt`, the Windows ACL runner, or
  `danger-full-access` if you deliberately switched to it — and the approval setting for the session;
- what you expected the boundary to do, what it did instead, and the smallest reproduction you have.
  Command lines, the relevant log lines and a transcript beat a description;
- for a credential or prompt-injection issue: whether the model, a tool result, a skill, a plugin or a
  local file was the vector.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement | 3 business days |
| Initial assessment (severity, affected versions, whether we can reproduce) | 10 business days |
| Fix or documented mitigation | Depends on severity; we will tell you the plan and keep you updated |

This is a volunteer community project: there is **no bug bounty**, and the timelines above are
best-effort commitments, not a contract. We will credit you in the advisory unless you ask us not to.

## Scope

**In scope** — anything in this repository and in the artifacts it publishes:

- the **Electron shell**: the private application scheme the interface is served over, the preload
  bridge the renderer is confined to, the sender validation every IPC channel performs, and the
  window's own configuration — `nodeIntegration` off, `contextIsolation` on, `sandbox` on,
  `webSecurity` on;
- the **Host process** and the shell's supervision of it: how it is started, what it inherits, what it
  is told, and what happens when it dies;
- the sandbox and approval boundary this application exposes: bubblewrap and the embedded Landlock
  launcher on Linux, Seatbelt on macOS, the ACL restricted-token runner on Windows, and the
  `workspace-write` / `read-only` / `danger-full-access` policy ladder;
- the credential path: how API keys are stored in the shared home, resolved, logged, or leaked into a
  transcript, a session file, a crash report or an export;
- the **crash reports** — where they are written, with what permissions, and whether they can carry
  more than they should;
- the installer and the update path: signature and checksum handling, what the **window** is told
  about a feed (the phase, version and progress only — never the address), and what the application is
  able to install on its own;
- the **build-time patch layer**. Two of the seven patches are security-relevant — the confined
  token's reach on Windows, and the `workspace-write` prompt sentence derived from the function
  another patch narrows — and a patch that silently stopped applying would ship an altered boundary.
  It fails the build instead, and a report that it does not is in scope.

**Out of scope:**

- Vulnerabilities in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), in the
  qialike CLI, or in any third-party dependency. Report them upstream; we will still act on anything
  that reaches this application's users through this repository — a version bump, a mitigation, a
  documented workaround. Note that the **sandbox implementation itself is the harness's**: what is
  this repository's is exposing it, and not weakening it on the way.
- Vulnerabilities in a **model provider's** API or in a gateway you configured. This application is a
  client; your prompts, code and keys go to whichever provider you selected, under that provider's
  terms.
- The website or any hosted service in a different repository — report those to the address published
  there, and say which project you mean.

## Behaviour that is by design, not a vulnerability

These are documented product decisions. A report about one of them will be answered with a pointer to
the docs, not a fix — unless you can show that the documentation and the behaviour disagree:

- **`danger-full-access` reaches outside the workspace.** That is the point of the rung; it is
  opt-in, and the README says what it costs.
- **The interface is not reachable from a second display or a screenshot tool.** It is served over a
  private application scheme rather than a local HTTP port, deliberately, so that nothing else on the
  machine can talk to the backend.
- **A second launch is refused while the first is running.** The profile is locked, and the
  application logs which instance holds the lock instead of starting twice.
- **The model sees your code, and the provider receives it.** That is what a coding agent does.
- **A shell command you approve can do what you approved.** The approval prompt is the boundary;
  approving a command that writes outside the workspace is a decision, not a bypass.
- **Where no kernel confinement exists**, every shell call is approved one at a time instead of being
  silently allowed — the degraded mode is deliberate and announced.
- **A plugin runs in-process with full privileges**, which is why the trust ledger exists. This
  application adds no plugin surface of its own: it uses the same shared home and the same trust
  decisions as the CLI.

## Safe harbour

We will not pursue or support legal action against anyone who, in good faith, reports a
vulnerability, tests it against **their own** installation and data, and gives us a reasonable window
to fix it before publishing. Please do not test against other people's systems, do not exfiltrate
data that is not yours, and do not degrade anyone's service.
