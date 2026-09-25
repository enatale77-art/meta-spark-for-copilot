# WP-0001 Completion Report — Muse Per-Task Usage Monitor

**Work package:** `docs/40-work-management/work-packages/WP-0001-MUSE-USAGE-MONITOR.md`
**Branch:** `wp/0001-muse-usage-monitor`
**Date:** 2026-09-25
**Version:** 2.2.0 (additive minor release)
**Status:** COMPLETE - PENDING REVIEW

## Summary

Implemented a local-first Muse usage monitor inside the existing
`meta-spark-for-copilot` provider path. Every completed Muse request with a
returned `MetaUsage` object becomes one privacy-bounded ledger record; records
roll up deterministically Request → Task → Local Chat → Project and are
surfaced in a local dashboard, CSV export, status bar, and clear-history flow.
No proxy, external service, database, telemetry, or Meta-dashboard scraper was
introduced.

## Final architecture / file list

New `src/usage/` subsystem (separation of concerns per the WP):

- `src/usage/types.ts` — `UsageRequestRecord`, chat/task metadata,
  allocation, pricing, and cost-breakdown types; `emptyContexts()`.
- `src/usage/context.ts` — pure chat/task allocation, marker payload
  build/parse/validate, project identity (`deriveProjectId`), preview
  normalization (160-char cap), substantive-turn detection, utility-kind list.
- `src/usage/marker.ts` — `LanguageModelDataPart` adapter
  (`USAGE_MARKER_MIME = 'meta-spark-usage-context'`), creation/parsing, and
  latest-valid-marker scan over assistant history.
- `src/usage/pricing.ts` — pure `splitUsageTokens`, `resolvePricing` from the
  extension `MODELS` catalog, and `calculateCost`
  (uncached + cached + output; reasoning never double-billed).
- `src/usage/storage.ts` — JSONL/context pure helpers
  (`serializeRecord`, `parseLedgerText` with truncated-tail tolerance,
  `parseContextsText`, `serializeContexts`), `UsageStore` interface,
  in-memory store for tests, and `usageClearTargets()` scope guard.
- `src/usage/fileStore.ts` — file-backed store under
  `<globalStorageUri>/usage-v1/` with a true-append JSONL ledger (Node `fs`
  `appendFile` on local paths; serialized queued write on virtual/remote
  filesystems that never truncates on failed opens), serialized write
  ordering, atomic temp-file + rename for `contexts.json` (plus stale-temp
  cleanup), missing-file-only empty states, and usage-v1-scoped clear.
- `src/usage/aggregate.ts` — single-pass O(n) `aggregateRequests`,
  `rollupTasks` (with per-kind breakdown), `rollupChats`, `rollupProjects`,
  `rollupUnassignedOverhead` (task-less records grouped by kind),
  `filterByTime` (7d/30d/90d/all).
- `src/usage/csv.ts` — request-granularity CSV (`CSV_COLUMNS`, `toCsvRows`,
  `toCsvText`, `escapeCsvField`); capped preview only.
- `src/usage/recorder.ts` — `UsageService` lifecycle integration:
  `beginRequest` (correlation before the Meta call), `recordCompleted`
  (authoritative `MetaUsage`), `recordAttempt` (null-usage attempts excluded
  from totals), `clearAll` (storage clear + contexts-cache invalidation on
  every clear path), context creation/touch, `toCorrelationMessages`.
- `src/usage/dashboard.ts` — local webview with restrictive CSP, no remote
  JS/CSS; summary cards, 7d/30d/90d/All + project/model/search filters, task
  table with start/last-activity, task drill-down (per-kind token/cost table,
  timeline, copyable IDs), unassigned-overhead-by-kind section, local-chat
  roll-up, local-chat limitation note, escaped HTML throughout.
- `src/usage/status.ts` — `UsageStatusBar`: compact most-recent-task summary
  scoped to the active workspace project, rich tooltip with IDs, click opens
  dashboard, configurable, never blocks model requests.
- `src/usage/statusSelection.ts` — VS Code-free `selectStatusTask` pure
  selection (project filter → latest task) for deterministic tests.
- `src/usage/index.ts` — subsystem barrel exports.

Integration edits:

- `src/provider/index.ts` — begin usage tracking before the Meta request;
  attach authoritative-usage hooks; record non-billable attempts on
  prepare/stream failure or missing usage; preserve streaming/tool-call/replay/
  vision/diagnostics/cancellation behavior; existing Copilot `usage` reporting
  untouched.
- `src/provider/stream.ts` — feed the existing `onUsage` path into the
  recorder (non-blocking, warn-only on failure); emit the hidden usage marker
  on `onDone` independently of replay markers; main-agent responses only.
- `src/runtime/lifecycle.ts` — instantiate the file store, dashboard, usage
  service, and status bar; wire `onRecorded` refresh; inject the service into
  `MetaChatProvider`; avoid global mutable singletons.
- `src/runtime/provider.ts` — accept/inject the usage service.
- `src/runtime/commands.ts` — `meta-spark.openUsageDashboard`,
  `meta-spark.exportUsageCsv` (save dialog, request rows), and
  `meta-spark.clearUsageHistory` (modal confirmation, routes through
  `UsageService.clearAll()` so storage + cache invalidate together,
  usage-v1 only, UI refresh).
- `src/config.ts` — `getUsageStatusBarEnabled()` for
  `meta-spark-copilot.usageMonitor.statusBar` (default `true`).
- `src/i18n.ts` — English + Chinese strings for dashboard/export/clear/status.

Metadata/docs:

- `package.json` — version 2.2.0; three usage commands; status-bar setting;
  portable `vscode:prepublish` (`node scripts/prepare-marketplace-readme.cjs`);
  `test` runs compile + deterministic `node:test` suite.
- `package-lock.json` — root version synced 0.6.2 → 2.2.0 (stale baseline).
- `package.nls.json`, `package.nls.zh-cn.json` — command/setting strings.
- `README.md`, `README.zh-cn.md` — Usage Monitor overview, open/export/clear,
  local storage schema, local chat/task ID semantics + no-native-deep-link
  limitation, status-bar setting, 160-char preview privacy statement.
- `CHANGELOG.md` — 2.2.0 feature entry.
- `scripts/prepare-marketplace-readme.cjs` — portable Marketplace README
  generator (strips `marketplace-readme:remove-*` sections; no bash needed).
- `.vscodeignore` — excludes `test/`, `scripts/`, `ACTIVE.md`,
  `*.code-workspace`, and other non-runtime files from the VSIX.
- `test/usage.test.cjs` — 29 deterministic `node:test` cases (CommonJS
  against compiled `out/`, `vscode` stubbed for store/service coverage only;
  no editor runtime).
- `test/vscode-stub.cjs` — minimal `vscode` module stub for deterministic
  tests (excluded from the VSIX via `test/**`).

## Correlation behavior and known limitations

- First substantive `main-agent` request with no valid marker → new UUID
  `chat_id` + new UUID `task_id`. The marker (`{version, writer, chatId,
  taskId}` only) is emitted as a hidden `LanguageModelDataPart` in the
  main-agent assistant response so Copilot tool loops/history return it.
- Same task retained across tool continuations and additional inference calls
  while the latest valid marker is current.
- New substantive human text turn after the latest marker → same `chat_id`,
  new `task_id`.
- Tool-result-only messages, terminal notifications, customization/control
  updates, and utility/background requests never create a task by themselves.
- Every non-main request with a valid `chat_id` + `task_id` marker inherits
  that existing task, including known utility/background kinds (they still
  never create tasks). Without valid marker evidence they are recorded as
  unassigned Copilot overhead — never joined by timing/editor/process
  heuristics.
- Failed/cancelled calls without authoritative usage become `attempt` records
  with null tokens/cost, excluded from totals.
- Dashboard labels IDs as extension-owned Local Chat IDs and states that v1
  cannot deep-link to the exact native Copilot chat.
- Nullable `nativeSessionId` fields are preserved on chat/task metadata for a
  future VS Code API; no private Copilot storage is read.
- Limitation: no Extension Development Host smoke test was run in this
  session; correlation is covered by deterministic provider-level tests and
  the synthetic sequence below. Hidden-marker survival across the real
  Copilot loop remains to be confirmed in a live agent conversation.

## Storage schema / version

Directory: `<globalStorageUri>/usage-v1/`

- `requests.jsonl` — append-only, one JSON object per line,
  `version: 1` per record. Fields: `id`, `timestamp`/`timestampMs`,
  `projectId`/`projectName`, `chatId`/`taskId` (nullable), `vscodeModelId`,
  `apiModelId`, `requestKind`, `requestInitiator` (nullable, ≤200 chars),
  `reasoningEffort` (nullable), `promptTokens`, `cachedInputTokens`,
  `uncachedInputTokens` (`max(prompt - cached, 0)` unless Meta supplies an
  explicit miss count), `completionTokens`, `reasoningTokens` (breakdown of
  completion, never billed twice), `totalTokens`, `estimatedCostUsd`,
  `pricingInputRate`/`pricingCachedRate`/`pricingOutputRate`,
  `pricingModelId`/`pricingSource`, `costUncertain`, `durationMs`, `status`
  (`completed` | `attempt`), `error` (nullable), `taskPreview` (nullable,
  whitespace-normalized, ≤160 chars). No full prompts, source, tool data,
  reasoning/response text, bodies, paths, or API keys.
- `contexts.json` — `{ version: 1, chats, tasks }` with chat display names
  (first preview default), per-task previews, created/updated timestamps, and
  nullable `nativeSessionId`. Written atomically (temp file + rename; stale
  temp cleanup on the Node-fs path).
- Crash safety: a truncated final JSONL line is counted as corruption and
  ignored while older history stays readable; only a genuine missing file
  reads as empty — any other read/open failure surfaces and never replaces
  prior history. Corrupted contexts text yields empty contexts plus a
  non-fatal dashboard state.
- No retention deletion in v1; clear-history deletes only the two usage-v1
  files.

## Test / check results (2026-09-25, Windows, this branch)

- `npm ci` — pass (322 packages; 11 pre-existing moderate/high advisories,
  no new deps added by this WP).
- `npm test` (`npm run compile` + `node --test test/usage.test.cjs`) — pass:
  29 tests, 8 suites, 29 pass, 0 fail. Covers: Contributor + Standard cost
  formulas; cached/uncached split + missing-cache behavior; reasoning not
  double-billed; new-chat first-task allocation; same-task tool continuation;
  new-turn → new task/same chat; tool-result-only/terminal/background/control
  non-creation; utility-with-marker inheritance + utility-without-marker
  unassigned; missing-marker → unassigned; marker round-trip + version/
  writer/payload rejection; multi-root project determinism; preview
  normalization + 160-char cap; JSONL truncated-tail tolerance; contexts
  round-trip; true-append sequential-append persistence; non-missing ledger
  read errors surfacing (no empty-ledger conversion); `clearAll` cache
  invalidation (no post-clear resurrection); aggregation totals + cache-hit %
  (attempts excluded); task/chat rollups; unassigned-overhead-by-kind rollup;
  time filters; status-bar active-project selection + empty-state; CSV escaping
  + row parity; clear-history scope; synthetic provider-level sequence (first
  prompt → accumulation → tool continuation → second task → unassigned
  overhead → rollup/export parity).
- `npm run compile` — pass (`tsc -p ./`, strict).
- `npm run lint` (`oxlint`) — pass, 0 warnings / 0 errors (67 files).
- `npm run format:check` (`oxfmt --check src/`) — global check still fails on
  44 pre-existing untouched files (Windows CRLF baseline, per the WP caution;
  no mass reformat applied). All 20 WP-touched/new files verify clean:
  `npx oxfmt --check src/usage/ src/provider/index.ts src/provider/stream.ts
  src/runtime/commands.ts src/runtime/lifecycle.ts src/runtime/provider.ts
  src/config.ts src/i18n.ts` → "All matched files use the correct format."
- `npm run package` — pass: `dist/meta-spark-for-copilot-2.2.0.vsix`
  (83 files, 390.81 KB; +1 runtime file `statusSelection.js` vs. the
  pre-review 82-file build).

Packaged VSIX:

- Filename: `dist/meta-spark-for-copilot-2.2.0.vsix`
- SHA256: `18E1CBD456ED251A0E5CFA354638C672FA40C7271D76296227AED8925B33BE21`
- Scope verified (`vsce ls`): runtime `out/` (incl. 13 `usage/` files),
  resources, manifest, license/changelog/readme/nls only — `test/`
  (incl. `vscode-stub.cjs`), `scripts/`, `src/`, `docs/`, `ACTIVE.md`, and
  `*.code-workspace` excluded.
- Note: `dist/` and `*.vsix` are git-ignored build outputs; the VSIX is a
  local distributable, not committed.

Functional acceptance (synthetic, deterministic): covered by the
"synthetic provider-level sequence" test — ledger → rollups → CSV parity and
clear-scope assertions hold; clear-history resets usage storage/UI without
touching API-key state by construction (store scope guard + secrets untouched).
No live Copilot session was exercised.

## Deviations from the WP

None in product scope. Two minimal packaging/metadata repairs were required
because the baseline could not package as specified; both pre-date this branch
(verified against `main`):

1. `vscode:prepublish` invoked `bash scripts/prepare-marketplace-readme.sh`,
   but no `scripts/` directory exists at baseline and the Windows host has no
   usable `bash` for that path. Added portable
   `scripts/prepare-marketplace-readme.cjs` (Node builtins only; same
   marker-stripping semantics) and pointed `vscode:prepublish` at it.
   `scripts/` is excluded from the VSIX via `.vscodeignore`.
2. `package-lock.json` root version was stale at `0.6.2` (untouched since the
   initial port) while `package.json` is `2.2.0`. Synced the two root
   `version` fields to `2.2.0`; no dependency changes. (`npm ci` passes.)
3. `README.md` packaging note updated `.sh` → `.cjs` to match (1).
4. `.vscodeignore` extended to exclude `test/`, `scripts/`, `ACTIVE.md`, and
   `*.code-workspace` so the first `npm run package` output (86 files,
   including tests and work-package locator) became the clean 82-file VSIX.
   This enforces the WP's "keep test artifacts out of the packaged VSIX".

No unrelated refactors were made; the global format baseline was left alone.

## Follow-up backlog recommendations

- Live-host smoke test: dashboard command, status item, export dialog, clear
  confirmation, and hidden-marker survival in a real Copilot agent
  conversation (record limitation closure).
- Consider a dashboard state-preserving refresh (currently resets filters to
  30d/all on refresh) and pagination/virtualization if ledgers grow large.
- Optional: corrupted-ledger surfacing in the dashboard UI (currently logged,
  non-fatal) and a record-count guard for very large histories.
- Revisit `format` script scope (currently WP-file-scoped) vs. the
  repo-wide CRLF baseline before any future formatting pass.
- Upstreaming remains a later decision; the `src/usage/` module boundary was
  kept so the delta stays portable. No publication performed per scope-out.


## Engineering Manager Review 01 — 2026-09-25 (repaired same day)

**Disposition at review:** CHANGES REQUIRED — R1–R6 repaired on
`wp/0001-muse-usage-monitor` as documented below; branch returned to
`COMPLETE - PENDING REVIEW` after revalidation and push.

The implementation is structurally strong and the reported automated checks are useful, but review of the actual branch found the following acceptance issues that must be corrected before integration.

### R1 — Make `requests.jsonl` a true append ledger and remove destructive read-error behavior

**Current issue:** `src/usage/fileStore.ts::appendRequest` reads the entire ledger, concatenates one line in memory, and rewrites the whole file. It also treats any read failure as an empty ledger. This is not an append-only implementation: runtime cost grows with ledger size, a non-FileNotFound read error can cause history replacement, and a crash during whole-file rewrite can damage older history rather than only a final partial line.

**Required correction:**
- append each JSONL line using a true file append operation on the extension-host filesystem;
- retain serialized write ordering;
- create the usage directory as needed;
- treat only a genuine missing file as empty/new;
- never overwrite prior history because a read/open operation failed;
- retain truncated-final-line tolerance on reads;
- add a regression test proving existing records remain intact across multiple appends and that non-missing read/open errors are not converted into an empty ledger.

### R2 — Clear-history must invalidate the in-memory contexts cache on every clear path

**Current issue:** both dashboard and Command Palette clear paths delete storage, but `UsageService.contextsCache` remains populated. A later request can write stale chat/task metadata back to `contexts.json`, partially resurrecting data the user explicitly cleared.

**Required correction:**
- centralize or otherwise guarantee `UsageService.invalidateContextsCache()` runs after a successful clear;
- cover both dashboard and `Meta Spark: Clear Usage History` command paths;
- refresh dashboard/status after invalidation;
- add a testable seam/regression check demonstrating cleared contexts are not resurrected by a subsequent request.

### R3 — Status bar must be scoped to the active workspace/project

**Current issue:** `src/usage/status.ts` constructs a set of current workspace URIs but does not use it. The status item therefore displays the globally most recent tracked task, which can belong to another project.

**Required correction:**
- derive the current project ID with the same deterministic project-identity logic used by the recorder;
- filter candidate status records to that project before selecting the latest task;
- show the empty state when the active workspace has no usage even if another workspace does;
- add deterministic coverage for cross-project status selection logic by factoring the selection into pure/testable code.

### R4 — Valid marker evidence must allow safe utility/background attribution to the current task

**Current issue:** `allocateUsageContext` refuses task inheritance for known utility request kinds even when a valid usage-context marker is present. This loses exactly the Copilot orchestration overhead the monitor is intended to attribute per task.

**Required correction:**
- for every non-main request, a valid `chat_id` + `task_id` marker may inherit that existing task;
- utility/background requests must never create a task;
- without valid marker evidence they remain unassigned overhead;
- update tests to cover utility-with-marker = inherited, utility-without-marker = unassigned.

### R5 — Surface actual request-kind usage and unassigned overhead in the dashboard

**Current issue:** task detail currently renders request-kind counts only (for example `main-agent ×N`). The underlying rollup contains token/cost totals but the dashboard does not show them. Unassigned overhead is included in top-level totals but has no dedicated breakdown. The task table also omits the required start/end or last-activity time.

**Required correction:**
- show per-kind request count, input, cached input/cache-hit %, output, reasoning, and estimated cost for a selected task;
- add an **Unassigned Copilot overhead** breakdown for records with no task ID, grouped by request kind, so unattributable overhead is visible rather than disappearing into the top-level cards;
- add task start/last-activity (or equivalent start/end) to the task table;
- keep all prompt-preview/privacy limits unchanged.

### R6 — Revalidate and refresh completion evidence

After R1–R5:
- run the targeted deterministic tests plus `npm test`, `npm run compile`, `npm run lint`, touched-file formatter check, and `npm run package`;
- update this Completion Report with the repair disposition, final test counts, and new VSIX SHA256;
- leave ACTIVE at `COMPLETE - PENDING REVIEW` only after repairs are complete and pushed.

The previously reported lack of a live Copilot host smoke test remains a known acceptance risk. It is not a separate code defect, but the final release should receive one real Copilot-agent smoke test before integration/release so hidden usage-marker survival is confirmed end to end.

## Review Repair 01 — disposition (2026-09-25, same branch)

All five findings repaired in scope; R6 revalidation complete:

- **R1 (true-append ledger):** `src/usage/fileStore.ts::appendRequest` now
  uses Node `fs` `appendFile` on local global-storage paths (constant cost
  per record; no whole-file rewrite, so a crash can only affect the final
  partial line). A serialized queue retains write ordering and creates the
  usage directory as needed. Only a genuine missing file (`ENOENT` /
  `FileNotFound`) reads as empty; every other read/open failure surfaces and
  never replaces prior history. Truncated-final-line tolerance retained.
  Regression tests: sequential multi-append persistence +
  non-missing-read-error surfacing.
- **R2 (clear invalidates cache):** added `UsageService.clearAll()` (storage
  clear + `invalidateContextsCache()` together). Both the dashboard clear
  action (via lifecycle `setOnCleared`) and the `Meta Spark: Clear Usage
  History` command (via injected service getter) route through it, then
  refresh dashboard/status. Regression test proves a post-clear request
  cannot resurrect cleared chat/task metadata.
- **R3 (project-scoped status bar):** status selection factored into
  VS Code-free `src/usage/statusSelection.ts::selectStatusTask`, which
  derives the active project ID with the recorder's `deriveProjectId` and
  filters to that project before choosing the latest task; empty state when
  the workspace has no usage. Deterministic cross-project tests added.
- **R4 (utility attribution):** `allocateUsageContext` now lets every
  non-main request with a valid `chat_id` + `task_id` marker inherit that
  task (utilities included, never creating tasks); marker-less utilities
  remain unassigned overhead. Tests updated to utility-with-marker =
  inherited / utility-without-marker = unassigned.
- **R5 (dashboard surfacing):** task detail shows a per-kind
  requests/input/cached/cache-hit/output/reasoning/cost table plus the
  timeline; a dedicated **Unassigned Copilot overhead** section groups
  task-less records by kind (`rollupUnassignedOverhead`); the task table
  gained Start and Last activity columns. New en/zh strings added; privacy
  limits unchanged.
- **R6 (revalidate):** `npm ci` pass; `npm test` 29/29 pass (8 suites);
  `npm run compile` pass; `npm run lint` 0/0 (67 files); touched-file
  formatter check clean (20 files); `npm run package` rebuilt
  `dist/meta-spark-for-copilot-2.2.0.vsix` (83 files, 390.81 KB), SHA256
  `18E1CBD456ED251A0E5CFA354638C672FA40C7271D76296227AED8925B33BE21`;
  `vsce ls` confirms test artifacts stay out of the VSIX. Report updated,
  ACTIVE returned to `COMPLETE - PENDING REVIEW`, branch pushed and verified
  in sync with remote.
