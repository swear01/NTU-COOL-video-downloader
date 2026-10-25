# BEGIN agents_rule-base
# Agent Rules

## Core Rules

- Default to autonomous execution: make and carry out the least-risky reasonable decisions for routine, reversible, in-scope work without asking.
- Own the requested outcome end to end. Do not stop after discovery, planning, partial implementation, or a progress update; continue through verification and safe in-scope fixes until complete or genuinely blocked.
- Necessary supporting changes to code, tests, fixtures, configuration, generated artifacts, and documentation are in scope. Unrelated refactors, cleanup, and features are not.
- Ask only for a concrete, material problem—missing input, a user-owned decision, or an unrequested destructive, irreversible, paid, or external action; never skip a required step for lack of approval—ask instead.
- Before asking, diagnose the issue and complete all safe, reversible, equivalent, in-scope work. If no concrete material problem exists, choose a reasonable default and continue.
- Do not ask merely because the work crosses files, functions, tests, fixtures, configuration, dependencies, or tools. Do not ask again for an action the user already explicitly requested or authorized.
- For substantive tasks, inspect relevant local files and instructions before modifying them; use authoritative docs or web sources when current or external facts matter. Explicit, trivial, unambiguous edits may proceed directly.
- If authoritative guidance is unavailable, use verified local evidence when sufficient; never invent code, paths, functions, APIs, behavior, or verification results.
- Equivalent tools and implementation methods may be substituted without asking when they preserve behavior, security, data safety, verification strength, target, and material cost. Otherwise report the issue and the decision needed.
- Never return dummy results, skip required verification, hide failures, or silently downgrade the requested scope.
- Retry an operation once when the failure appears transient; otherwise diagnose it and continue with safe, equivalent, in-scope alternatives when available.
- Match existing style, names, and patterns; keep changes minimal and add no dependencies or comments unless necessary for the requested result.
- Change requested behavior directly; do not add unrequested compatibility options.
- Before merging a PR, trigger a GitHub bot review with `github-pr-review-loop`; merge once it passes on the latest head. Local review is supplementary.

## Completion

- Run the smallest relevant verification that can prove the outcome, including live behavior when applicable; fix safe failures caused by the change.
- Never claim an unrun check passed. Report the concrete problem, safe alternatives tried, and exact decision needed when genuinely blocked.

## Memory and Documentation

- After substantive work, check for new durable, verified knowledge; use `shared-memory` only when there is useful knowledge to record.
- Update active docs only when durable behavior, API, CLI, or configuration changes; scan only affected documentation.
- Refresh and query-check QMD only when memory changes. Use `agents_rule archive` for intentional documentation archiving and `git mv` for tracked moves.
- Report files changed, documentation status, verification performed, and remaining risks or blockers.
# END agents_rule-base

## Project: NTU COOL Video Downloader

Chromium extension (MV3) that saves NTU COOL DASH videos as MP4.
Canonical repo: `swear01/NTU-COOL-video-downloader`. Upstream
`willychen0146/...` is a divergent legacy — never target it for PRs.

### Absolute rules

- `background/background.js` must keep the `onDeterminingFilename` listener
  scoped to our own in-flight MP4s only (see its comment block). An
  always-registered listener overrides every other downloader's filenames
  (Chrome: most recently installed extension wins; bare `suggest()` still
  counts as an empty override). See `docs/notes.md`.
- Releases go through the tag workflow: bump version (manifest.json,
  package.json, package-lock.json, README examples) → PR → merge → push
  `v<version>` tag. Never push a tag whose name differs from the manifest
  version.
- Chrome Web Store credentials live ONLY in the `cws-publish` GitHub
  environment; the store job is gated on the `CWS_ENABLED` repository
  variable. `scripts/publish-cws.mjs` must stay idempotent: same or newer
  store version = no-op.
- Every behavior change updates the relevant doc in the same change
  (per the managed rules above).

### Docs

- Store publishing setup & pipeline: `store/publishing.md`
- Agent handbook: `docs/overview.md`, `docs/structure.md`, `docs/notes.md`,
  `docs/commands.md`, `docs/plan.md`, `docs/roadmap.md`
