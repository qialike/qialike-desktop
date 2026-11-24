<!--
  Thanks for the pull request. A few things that make review fast:

  - One change per PR. If you found something else on the way, send it separately.
  - Say what you verified, and how. "Tests pass" is weaker than "this test failed before and passes
    now" — a new test that would have caught the bug is the most persuasive thing in a PR.
  - If the change is user-visible, update the README (both languages) and CHANGELOG.md.
  - Do not open a PR that fixes a security vulnerability. Report it privately first: SECURITY.md.
-->

## What this changes

<!-- One paragraph. What was wrong or missing, and what it does now. -->

## Why

<!-- The problem, not the patch. If it fixes an issue, link it: "Fixes #123". -->

## How it was verified

<!--
  Be concrete. Which commands did you run, and what did they print?

  `pnpm run typecheck` and `pnpm run test:hygiene` need no upstream checkouts — the same two commands
  CI runs. The full `pnpm test` additionally needs a built deepseek-harness checkout and a built
  qialike CLI checkout at the version `apps/desktop-bin/lib/harness-version.mjs` names; say if you
  could not run it.
-->

## Checklist

- [ ] One logical change; the title follows Conventional Commits (`fix(scope): …`).
- [ ] A test covers the change, and it fails without the fix (or I explain why a test is not possible).
- [ ] `pnpm run typecheck` passes.
- [ ] `pnpm run test:hygiene` passes (this is what CI runs).
- [ ] I have said which of the checks that need the upstream checkouts I could run.
- [ ] User-visible changes are reflected in `README.md` / `README.zh.md`.
- [ ] User-visible changes are reflected in `CHANGELOG.md` / `CHANGELOG.zh.md`.
- [ ] A new dependency is added to `THIRD_PARTY_NOTICES.md` in this same change.
- [ ] This is **not** a security fix (those are reported privately, per SECURITY.md).
- [ ] I have read CONTRIBUTING.md, including the read-only rule for both upstream checkouts.
