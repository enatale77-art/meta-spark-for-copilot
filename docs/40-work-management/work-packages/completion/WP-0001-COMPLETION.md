# WP-0001 Completion Report Ã¢â‚¬â€ Muse Per-Task Usage Monitor

**Work package:** `docs/40-work-management/work-packages/WP-0001-MUSE-USAGE-MONITOR.md`
**Branch:** `wp/0001-muse-usage-monitor`
**Date:** 2026-09-25
**Version:** 2.2.0 (additive minor release)
**Status:** ACCEPTED - READY FOR INTEGRATION

## Summary

Implemented a local-first Muse usage monitor inside the existing
`meta-spark-for-copilot` provider path. Every completed Muse request with a
returned `MetaUsage` object becomes one privacy-bounded ledger record; records
roll up deterministically Request Ã¢â€ â€™ Task Ã¢â€ â€™ Local Chat Ã¢â€ â€™ Project and are
surfaced in a local dashboard, CSV export, status bar, and clear-history flow.
No proxy, external service, database, telemetry, or Meta-dashboard scraper was
introduced.

## Final architecture / file list

New `src/usage/` subsystem (separation of concerns per the WP):

- `src/usage/types.ts` Ã¢â‚¬â€ `UsageRequestRecord`, chat/task metadata,
  allocation, pricing, and cost-breakdown types; `emptyContexts()`.
- `src/usage/context.ts` Ã¢â‚¬â€ pure chat/task allocation, marker payload
  build/parse/validate, project identity (`deriveProjectId`), preview
  normalization (160-char cap), substantive-turn detection, utility-kind list.
- `src/usage/marker.ts` Ã¢â‚¬â€ `LanguageModelDataPart` adapter
  (`USAGE_MARKER_MIME = 'meta-spark-usage-context'`), creation/parsing, and
  latest-valid-marker scan over assistant history.
- `src/usage/pricing.ts` Ã¢â‚¬â€ pure `splitUsageTokens`, `resolvePricing` from the
  extension `MODELS` catalog, and `calculateCost`
  (uncached + cached + output; reasoning never double-billed).
- `src/usage/storage.ts` Ã¢â‚¬â€ JSONL/context pure helpers
  (`serializeRecord`, `parseLedgerText` with truncated-tail tolerance,
  `parseContextsText`, `serializeContexts`), `UsageStore` interface,
  in-memory store for tests, and `usageClearTargets()` scope guard.
- `src/usage/fileStore.ts` Ã¢â‚¬â€ file-backed store under
  `<globalStorageUri>/usage-v1/` with a true-append JSONL ledger (Node `fs`
  `appendFile` on local paths; serialized queued write on virtual/remote
  filesystems that never truncates on failed opens), serialized write
  ordering, atomic temp-file + rename for `contexts.json` (plus stale-temp
  cleanup), missing-file-only empty states, and usage-v1-scoped clear.
- `src/usage/aggregate.ts` Ã¢â‚¬â€ single-pass O(n) `aggregateRequests`,
  `rollupTasks` (with per-kind breakdown), `rollupChats`, `rollupProjects`,
  `rollupUnassignedOverhead` (task-less records grouped by kind),
  `filterByTime` (7d/30d/90d/all).
- `src/usage/csv.ts` Ã¢â‚¬â€ request-granularity CSV (`CSV_COLUMNS`, `toCsvRows`,
  `toCsvText`, `escapeCsvField`); capped preview only.
- `src/usage/recorder.ts` Ã¢â‚¬â€ `UsageService` lifecycle integration:
  `beginRequest` (correlation before the Meta call), `recordCompleted`
  (authoritative `MetaUsage`), `recordAttempt` (null-usage attempts excluded
  from totals), `clearAll` (storage clear + contexts-cache invalidation on
  every clear path), context creation/touch, `toCorrelationMessages`.
- `src/usage/dashboard.ts` Ã¢â‚¬â€ local webview with restrictive CSP, no remote
  JS/CSS; summary cards, 7d/30d/90d/All + project/model/search filters, task
  table with start/last-activity, task drill-down (per-kind token/cost table,
  timeline, copyable IDs), unassigned-overhead-by-kind section, local-chat
  roll-up, local-chat limitation note, escaped HTML throughout.
- `src/usage/status.ts` Ã¢â‚¬â€ `UsageStatusBar`: compact most-recent-task summary
  scoped to the active workspace project, rich tooltip with IDs, click opens
  dashboard, configurable, never blocks model requests.
- `src/usage/statusSelection.ts` Ã¢â‚¬â€ VS Code-free `selectStatusTask` pure
  selection (project filter Ã¢â€ â€™ latest task) for deterministic tests.
- `src/usage/index.ts` Ã¢â‚¬â€ subsystem barrel exports.

Integration edits:

- `src/provider/index.ts` Ã¢â‚¬â€ begin usage tracking before the Meta request;
  attach authoritative-usage hooks; record non-billable attempts on
  prepare/stream failure or missing usage; preserve streaming/tool-call/replay/
  vision/diagnostics/cancellation behavior; existing Copilot `usage` reporting
  untouched.
- `src/provider/stream.ts` Ã¢â‚¬â€ feed the existing `onUsage` path into the
  recorder (non-blocking, warn-only on failure); emit the hidden usage marker
  on `onDone` independently of replay markers; main-agent responses only.
- `src/runtime/lifecycle.ts` Ã¢â‚¬â€ instantiate the file store, dashboard, usage
  service, and status bar; wire `onRecorded` refresh; inject the service into
  `MetaChatProvider`; avoid global mutable singletons.
- `src/runtime/provider.ts` Ã¢â‚¬â€ accept/inject the usage service.
- `src/runtime/commands.ts` Ã¢â‚¬â€ `meta-spark.openUsageDashboard`,
  `meta-spark.exportUsageCsv` (save dialog, request rows), and
  `meta-spark.clearUsageHistory` (modal confirmation, routes through
  `UsageService.clearAll()` so storage + cache invalidate together,
  usage-v1 only, UI refresh).
- `src/config.ts` Ã¢â‚¬â€ `getUsageStatusBarEnabled()` for
  `meta-spark-copilot.usageMonitor.statusBar` (default `true`).
- `src/i18n.ts` Ã¢â‚¬â€ English + Chinese strings for dashboard/export/clear/status.

Metadata/docs:

- `package.json` Ã¢â‚¬â€ version 2.2.0; three usage commands; status-bar setting;
  portable `vscode:prepublish` (`node scripts/prepare-marketplace-readme.cjs`);
  `test` runs compile + deterministic `node:test` suite.
- `package-lock.json` Ã¢â‚¬â€ root version synced 0.6.2 Ã¢â€ â€™ 2.2.0 (stale baseline).
- `package.nls.json`, `package.nls.zh-cn.json` Ã¢â‚¬â€ command/setting strings.
- `README.md`, `README.zh-cn.md` Ã¢â‚¬â€ Usage Monitor overview, open/export/clear,
  local storage schema, local chat/task ID semantics + no-native-deep-link
  limitation, status-bar setting, 160-char preview privacy statement.
- `CHANGELOG.md` Ã¢â‚¬â€ 2.2.0 feature entry.
- `scripts/prepare-marketplace-readme.cjs` Ã¢â‚¬â€ portable Marketplace README
  generator (strips `marketplace-readme:remove-*` sections; no bash needed).
- `.vscodeignore` Ã¢â‚¬â€ excludes `test/`, `scripts/`, `ACTIVE.md`,
  `*.code-workspace`, and other non-runtime files from the VSIX.
- `test/usage.test.cjs` Ã¢â‚¬â€ 39 deterministic `node:test` cases (CommonJS
  against compiled `out/`, `vscode` stubbed for store/service coverage only;
  no editor runtime).
- `test/vscode-stub.cjs` Ã¢â‚¬â€ minimal `vscode` module stub for deterministic
  tests (excluded from the VSIX via `test/**`).

## Correlation behavior and known limitations

- First substantive `main-agent` request with no valid marker Ã¢â€ â€™ new UUID
  `chat_id` + new UUID `task_id`. The correlation (`{version, writer, chatId,
  taskId}` only) is embedded in the single unified `stateful_marker`
  response part (prefixed with the exact VS Code selected model ID) so the
  Agent Host BYOK bridge carries it forward as conversation state.
- Same task retained across tool continuations and additional inference calls
  while the latest valid marker is current.
- New substantive human text turn after the latest marker Ã¢â€ â€™ same `chat_id`,
  new `task_id`. Turn detection and previews run on R8-sanitized prompt text
  (Copilot `<context>`/`<reminder>`/`<attachments>`/`<current_datetime>`/
  `<pr_metadata/>` blocks stripped; `<userRequest>`/`<user_query>` unwrapped),
  so scaffolding-only messages never create tasks and previews show the real
  human prompt.
- Tool-result-only messages, terminal notifications, customization/control
  updates, and utility/background requests never create a task by themselves.
- Every non-main request with a valid `chat_id` + `task_id` marker inherits
  that existing task, including known utility/background kinds (they still
  never create tasks). Without valid marker evidence they are recorded as
  unassigned Copilot overhead Ã¢â‚¬â€ never joined by timing/editor/process
  heuristics.
- Failed/cancelled calls without authoritative usage become `attempt` records
  with null tokens/cost, excluded from totals.
- Dashboard labels IDs as extension-owned Local Chat IDs and states that v1
  cannot deep-link to the exact native Copilot chat.
- Nullable `nativeSessionId` fields are preserved on chat/task metadata for a
  future VS Code API; no private Copilot storage is read.
- Repair scope R7Ã¢â‚¬â€œR10 is covered by deterministic tests plus the synthetic
  sequence. Live Copilot-agent confirmation of hidden-marker survival and
  the two-window sync observation remain for the live retest.

## Storage schema / version

Directory: `<globalStorageUri>/usage-v1/`

- `requests.jsonl` Ã¢â‚¬â€ append-only, one JSON object per line,
  `version: 1` per record. Fields: `id`, `timestamp`/`timestampMs`,
  `projectId`/`projectName`, `chatId`/`taskId` (nullable), `vscodeModelId`,
  `apiModelId`, `requestKind`, `requestInitiator` (nullable, Ã¢â€°Â¤200 chars),
  `reasoningEffort` (nullable), `promptTokens`, `cachedInputTokens`,
  `uncachedInputTokens` (`max(prompt - cached, 0)` unless Meta supplies an
  explicit miss count), `completionTokens`, `reasoningTokens` (breakdown of
  completion, never billed twice), `totalTokens`, `estimatedCostUsd`,
  `pricingInputRate`/`pricingCachedRate`/`pricingOutputRate`,
  `pricingModelId`/`pricingSource`, `costUncertain`, `durationMs`, `status`
  (`completed` | `attempt`), `error` (nullable), `taskPreview` (nullable,
  whitespace-normalized, Ã¢â€°Â¤160 chars). No full prompts, source, tool data,
  reasoning/response text, bodies, paths, or API keys.
- `contexts.json` Ã¢â‚¬â€ `{ version: 1, chats, tasks }` with chat display names
  (first preview default), per-task previews, created/updated timestamps, and
  nullable `nativeSessionId`. Written atomically (temp file + rename; stale
  temp cleanup on the Node-fs path).
- Crash safety: a truncated final JSONL line is counted as corruption and
  ignored while older history stays readable; only a genuine missing file
  reads as empty Ã¢â‚¬â€ any other read/open failure surfaces and never replaces
  prior history. Corrupted contexts text yields empty contexts plus a
  non-fatal dashboard state.
- No retention deletion in v1; clear-history deletes only the two usage-v1
  files.

## Test / check results (2026-09-25, Windows, this branch)

- `npm ci` Ã¢â‚¬â€ pass (322 packages; 11 pre-existing moderate/high advisories,
  no new deps added by this WP).
- `npm test` (`npm run compile` + `node --test test/usage.test.cjs`) Ã¢â‚¬â€ pass:
  29 tests, 8 suites, 29 pass, 0 fail. Covers: Contributor + Standard cost
  formulas; cached/uncached split + missing-cache behavior; reasoning not
  double-billed; new-chat first-task allocation; same-task tool continuation;
  new-turn Ã¢â€ â€™ new task/same chat; tool-result-only/terminal/background/control
  non-creation; utility-with-marker inheritance + utility-without-marker
  unassigned; missing-marker Ã¢â€ â€™ unassigned; marker round-trip + version/
  writer/payload rejection; multi-root project determinism; preview
  normalization + 160-char cap; JSONL truncated-tail tolerance; contexts
  round-trip; true-append sequential-append persistence; non-missing ledger
  read errors surfacing (no empty-ledger conversion); `clearAll` cache
  invalidation (no post-clear resurrection); aggregation totals + cache-hit %
  (attempts excluded); task/chat rollups; unassigned-overhead-by-kind rollup;
  time filters; status-bar active-project selection + empty-state; CSV escaping
  + row parity; clear-history scope; synthetic provider-level sequence (first
  prompt Ã¢â€ â€™ accumulation Ã¢â€ â€™ tool continuation Ã¢â€ â€™ second task Ã¢â€ â€™ unassigned
  overhead Ã¢â€ â€™ rollup/export parity).
- `npm run compile` Ã¢â‚¬â€ pass (`tsc -p ./`, strict).
- `npm run lint` (`oxlint`) Ã¢â‚¬â€ pass, 0 warnings / 0 errors (67 files).
- `npm run format:check` (`oxfmt --check src/`) Ã¢â‚¬â€ global check still fails on
  44 pre-existing untouched files (Windows CRLF baseline, per the WP caution;
  no mass reformat applied). All 20 WP-touched/new files verify clean:
  `npx oxfmt --check src/usage/ src/provider/index.ts src/provider/stream.ts
  src/runtime/commands.ts src/runtime/lifecycle.ts src/runtime/provider.ts
  src/config.ts src/i18n.ts` Ã¢â€ â€™ "All matched files use the correct format."
- `npm run package` Ã¢â‚¬â€ pass: `dist/meta-spark-for-copilot-2.2.0.vsix`
  (83 files, 390.81 KB; +1 runtime file `statusSelection.js` vs. the
  pre-review 82-file build).

Packaged VSIX:

- Filename: `dist/meta-spark-for-copilot-2.2.0.vsix`
- SHA256: `18E1CBD456ED251A0E5CFA354638C672FA40C7271D76296227AED8925B33BE21`
- Scope verified (`vsce ls`): runtime `out/` (incl. 13 `usage/` files),
  resources, manifest, license/changelog/readme/nls only Ã¢â‚¬â€ `test/`
  (incl. `vscode-stub.cjs`), `scripts/`, `src/`, `docs/`, `ACTIVE.md`, and
  `*.code-workspace` excluded.
- Note: `dist/` and `*.vsix` are git-ignored build outputs; the VSIX is a
  local distributable, not committed.

Functional acceptance (synthetic, deterministic): covered by the
"synthetic provider-level sequence" test Ã¢â‚¬â€ ledger Ã¢â€ â€™ rollups Ã¢â€ â€™ CSV parity and
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
3. `README.md` packaging note updated `.sh` Ã¢â€ â€™ `.cjs` to match (1).
4. `.vscodeignore` extended to exclude `test/`, `scripts/`, `ACTIVE.md`, and
   `*.code-workspace` so the first `npm run package` output (86 files,
   including tests and work-package locator) became the clean 82-file VSIX.
   This enforces the WP's "keep test artifacts out of the packaged VSIX".

No unrelated refactors were made; the global format baseline was left alone.

## Follow-up backlog recommendations

- Live-host smoke test: dashboard command, status item, export dialog, clear
  confirmation, hidden-marker survival in a real Copilot agent conversation,
  and the R10 two-window sync observation (record limitation closure).
- Consider pagination/virtualization if ledgers grow large.
- Optional: corrupted-ledger surfacing in the dashboard UI (currently logged,
  non-fatal) and a record-count guard for very large histories.
- Revisit `format` script scope (currently WP-file-scoped) vs. the
  repo-wide CRLF baseline before any future formatting pass.
- Upstreaming remains a later decision; the `src/usage/` module boundary was
  kept so the delta stays portable. No publication performed per scope-out.


## Engineering Manager Review 01 Ã¢â‚¬â€ 2026-09-25 (repaired same day)

**Disposition at review:** CHANGES REQUIRED Ã¢â‚¬â€ R1Ã¢â‚¬â€œR6 repaired on
`wp/0001-muse-usage-monitor` as documented below; branch returned to
`COMPLETE - PENDING REVIEW` after revalidation and push.

The implementation is structurally strong and the reported automated checks are useful, but review of the actual branch found the following acceptance issues that must be corrected before integration.

### R1 Ã¢â‚¬â€ Make `requests.jsonl` a true append ledger and remove destructive read-error behavior

**Current issue:** `src/usage/fileStore.ts::appendRequest` reads the entire ledger, concatenates one line in memory, and rewrites the whole file. It also treats any read failure as an empty ledger. This is not an append-only implementation: runtime cost grows with ledger size, a non-FileNotFound read error can cause history replacement, and a crash during whole-file rewrite can damage older history rather than only a final partial line.

**Required correction:**
- append each JSONL line using a true file append operation on the extension-host filesystem;
- retain serialized write ordering;
- create the usage directory as needed;
- treat only a genuine missing file as empty/new;
- never overwrite prior history because a read/open operation failed;
- retain truncated-final-line tolerance on reads;
- add a regression test proving existing records remain intact across multiple appends and that non-missing read/open errors are not converted into an empty ledger.

### R2 Ã¢â‚¬â€ Clear-history must invalidate the in-memory contexts cache on every clear path

**Current issue:** both dashboard and Command Palette clear paths delete storage, but `UsageService.contextsCache` remains populated. A later request can write stale chat/task metadata back to `contexts.json`, partially resurrecting data the user explicitly cleared.

**Required correction:**
- centralize or otherwise guarantee `UsageService.invalidateContextsCache()` runs after a successful clear;
- cover both dashboard and `Meta Spark: Clear Usage History` command paths;
- refresh dashboard/status after invalidation;
- add a testable seam/regression check demonstrating cleared contexts are not resurrected by a subsequent request.

### R3 Ã¢â‚¬â€ Status bar must be scoped to the active workspace/project

**Current issue:** `src/usage/status.ts` constructs a set of current workspace URIs but does not use it. The status item therefore displays the globally most recent tracked task, which can belong to another project.

**Required correction:**
- derive the current project ID with the same deterministic project-identity logic used by the recorder;
- filter candidate status records to that project before selecting the latest task;
- show the empty state when the active workspace has no usage even if another workspace does;
- add deterministic coverage for cross-project status selection logic by factoring the selection into pure/testable code.

### R4 Ã¢â‚¬â€ Valid marker evidence must allow safe utility/background attribution to the current task

**Current issue:** `allocateUsageContext` refuses task inheritance for known utility request kinds even when a valid usage-context marker is present. This loses exactly the Copilot orchestration overhead the monitor is intended to attribute per task.

**Required correction:**
- for every non-main request, a valid `chat_id` + `task_id` marker may inherit that existing task;
- utility/background requests must never create a task;
- without valid marker evidence they remain unassigned overhead;
- update tests to cover utility-with-marker = inherited, utility-without-marker = unassigned.

### R5 Ã¢â‚¬â€ Surface actual request-kind usage and unassigned overhead in the dashboard

**Current issue:** task detail currently renders request-kind counts only (for example `main-agent Ãƒâ€”N`). The underlying rollup contains token/cost totals but the dashboard does not show them. Unassigned overhead is included in top-level totals but has no dedicated breakdown. The task table also omits the required start/end or last-activity time.

**Required correction:**
- show per-kind request count, input, cached input/cache-hit %, output, reasoning, and estimated cost for a selected task;
- add an **Unassigned Copilot overhead** breakdown for records with no task ID, grouped by request kind, so unattributable overhead is visible rather than disappearing into the top-level cards;
- add task start/last-activity (or equivalent start/end) to the task table;
- keep all prompt-preview/privacy limits unchanged.

### R6 Ã¢â‚¬â€ Revalidate and refresh completion evidence

After R1Ã¢â‚¬â€œR5:
- run the targeted deterministic tests plus `npm test`, `npm run compile`, `npm run lint`, touched-file formatter check, and `npm run package`;
- update this Completion Report with the repair disposition, final test counts, and new VSIX SHA256;
- leave ACTIVE at `COMPLETE - PENDING REVIEW` only after repairs are complete and pushed.

The previously reported lack of a live Copilot host smoke test remains a known acceptance risk. It is not a separate code defect, but the final release should receive one real Copilot-agent smoke test before integration/release so hidden usage-marker survival is confirmed end to end.

## Review Repair 01 Ã¢â‚¬â€ disposition (2026-09-25, same branch)

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


## Engineering Manager Review 02 Ã¢â‚¬â€ 2026-09-25

**Disposition:** SOURCE REVIEW PASS Ã¢â‚¬â€ integration held only for the required live Copilot smoke test.

Review of repair commit `4efa98b1f15514fe00aaf623240c45c2695750e6` confirms R1Ã¢â‚¬â€œR5 from Review 01 are implemented in source:

- R1: local extension-host storage now uses queued Node `appendFile` for the JSONL ledger; non-missing read errors surface instead of becoming an empty ledger; regression coverage was added.
- R2: both dashboard and command clear paths route through `UsageService.clearAll()`, which clears storage and invalidates the in-memory contexts cache.
- R3: status selection is factored into `statusSelection.ts` and filters to the deterministic active-workspace project ID.
- R4: non-main/utility requests with a valid usage marker inherit the existing task; marker-less requests remain unassigned.
- R5: dashboard now exposes per-kind token/cache/output/reasoning/cost metrics, unassigned overhead by kind, and task start/last-activity times.

The reported repair validation is internally consistent: 29/29 deterministic tests, compile/lint pass, touched-file formatting pass, and rebuilt 2.2.0 VSIX SHA256 `18E1CBD456ED251A0E5CFA354638C672FA40C7271D76296227AED8925B33BE21`.

**Remaining acceptance gate:** one live GitHub Copilot agent smoke test using the packaged 2.2.0 VSIX. This is required before integration because the core correlation design depends on Copilot preserving the hidden `LanguageModelDataPart` marker across the real agent/tool loop, which deterministic source-level tests cannot prove.

Live smoke PASS criteria:

1. Install `dist/meta-spark-for-copilot-2.2.0.vsix` and reload VS Code.
2. In a real workspace, select Muse Spark 1.3 or Muse Spark 1.3 Contributor in GitHub Copilot Agent mode.
3. Send one substantive task that causes at least one tool/terminal continuation.
4. Confirm the usage status bar updates and `Meta Spark: Open Usage Dashboard` shows the task with non-zero authoritative usage.
5. Send a second substantive human prompt in the same Copilot chat.
6. Confirm the dashboard shows **one Local Chat** containing **two distinct Tasks**; tool-loop requests for the first prompt remain on the first task rather than becoming new tasks.
7. Confirm request drill-down and request-kind breakdown render without errors; any marker-less utility activity appears under Unassigned Copilot overhead rather than being falsely assigned.
8. Exercise CSV export once. Clear-history may be tested after recording evidence; if tested, confirm the dashboard/status reset and subsequent activity does not resurrect prior chat/task metadata.

No additional code repair is requested at this review stage. If the live smoke passes, Engineering Manager acceptance can proceed directly to routine integration under the project's delegated merge authority.


## Live Copilot Smoke 01 / Engineering Manager Review 03 Ã¢â‚¬â€ 2026-09-25

**Disposition:** FAIL Ã¢â‚¬â€ correlation transport is not surviving the real GitHub Copilot Agent Host BYOK bridge. Reopen same branch for in-scope repair.

### Observed live behavior

The live 2.2.0 dashboard successfully captured authoritative Muse usage (requests, input/cached/output/reasoning tokens, cache hit, and estimated cost), but correlation failed:

- 18 inference steps appeared as 18 Tasks;
- every row had exactly 1 request;
- every row received a different Local Chat ID;
- task/chat labels were dominated by Copilot-injected `<context>...` scaffolding instead of the user's prompt.

This proves the accounting path works, but the v1 chat/task correlation design does not work in the current Copilot Agent Host path.

### Root cause confirmed against current VS Code/Copilot source

The Agent Host BYOK bridge recognizes only special data-part MIME types for provider state. In `AgentHostByokLmHandler` it consumes:

- `stateful_marker` as the model continuation/response ID; and
- `usage` as token usage.

The custom MIME introduced by WP-0001, `meta-spark-usage-context`, is not carried forward as conversation state. Therefore our separate usage marker is discarded and every subsequent main-agent request appears marker-less, causing a new chat/task UUID.

The bridge also validates the outgoing `stateful_marker` prefix against the exact selected BYOK `request.modelId`. The extension's current replay marker writer uses the generic prefix `meta-spark`, so the Agent Host path will not accept that marker as its previous-response ID either.

Separately, Copilot injects prompt scaffolding such as `<context>...</context>`, reminders, attachments, current datetime metadata, and user-request wrappers. Our preview/substantive-turn logic currently treats that generated text as human prompt text, which explains the labels seen in the live dashboard and would create false new tasks even after marker persistence is repaired.

### R7 Ã¢â‚¬â€ Unify usage correlation with the supported `stateful_marker` transport

Replace the separate usage-context DataPart transport with one unified `stateful_marker` payload.

Required behavior:

1. Emit exactly one stateful marker for the main-agent response.
2. Prefix the marker bytes with the exact VS Code/Copilot selected model ID (`modelInfo.id` / Agent Host `request.modelId`), not the API model override and not the generic `meta-spark` writer prefix.
3. Extend the existing replay/stateful payload so it can carry:
   - existing vision replay metadata;
   - existing reasoning replay metadata;
   - usage correlation metadata: schema version, writer, `chatId`, `taskId`.
4. Preserve backward parsing of legacy `meta-spark`, known model-ID, raw UUID, and existing replay-marker payloads.
5. On the next Agent Host request, parse the reconstructed `stateful_marker` and recover the usage correlation IDs from that same payload.
6. Remove/retire the separate `meta-spark-usage-context` response marker so there is no second unsupported marker.
7. Ensure `hasReplayMarkerMetadata` / marker-emission logic treats valid usage context as sufficient reason to emit a stateful marker even if a response contains no replay vision/reasoning text.
8. Do not put usage totals, prompt text, source, or tool output into the stateful marker.

### R8 Ã¢â‚¬â€ Sanitize Copilot prompt scaffolding before task detection and preview generation

Add a pure sanitizer modeled on Copilot's own persisted-prompt sanitization behavior.

Before deciding whether a user message is a substantive human turn, and before generating the 160-character preview, remove generated blocks including at minimum:

- `<reminder>...</reminder>`
- `<system-reminder>...</system-reminder>` and `<system_reminder>...</system_reminder>`
- `<attachments>...</attachments>`
- `<context>...</context>`
- `<current_datetime>...</current_datetime>`
- self-closing `<pr_metadata .../>`

Handle `<userRequest>...</userRequest>` and `<user_query>...</user_query>` wrappers so that:
- when real leading prompt text remains after auxiliary blocks/wrappers are removed, use that text;
- when the wrapper contains the only real prompt, recover the wrapper's inner text;
- a message that reduces to generated scaffolding only is **not** a substantive human turn and must not create a new task.

The dashboard preview for a real user prompt must show the user's prompt text, not the injected `<context>` block seen in Smoke 01.

### Required regression tests for R7/R8

Add deterministic tests covering at least:

1. Agent Host round trip: emit `<modelId>\\<payload>` Ã¢â€ â€™ simulate bridge extracting responseId Ã¢â€ â€™ simulate next request rebuilding `<modelId>\\<responseId>` Ã¢â€ â€™ recover identical chat/task IDs.
2. Standard and Contributor model IDs are accepted as stateful-marker prefixes.
3. API model override does not incorrectly become the Agent Host prefix.
4. Legacy replay/stateful marker parsing remains compatible.
5. Unified marker preserves reasoning replay metadata and usage IDs together.
6. A context-only Copilot user message after a marker does not create a new task.
7. `<context>...</context><userRequest>Fix the tests</userRequest>` yields preview `Fix the tests`.
8. Two real user prompts in one reconstructed stateful-marker chain produce one Local Chat with two Tasks.
9. A multi-step tool loop between those prompts stays on the first task.
10. No `meta-spark-usage-context` marker is emitted by the repaired provider path.

### Revalidation / live retest

After repair:

- rerun the existing full deterministic suite plus new R7/R8 cases;
- compile/lint/touched-file format/package;
- rebuild 2.2.0 VSIX and record new SHA256;
- return ACTIVE to COMPLETE - PENDING REVIEW;
- repeat the live smoke from Review 02.

Live PASS remains: one real Copilot chat, first prompt with multiple agent/tool steps = one Task with multiple requests; second human prompt = second Task under the same Local Chat; previews show actual user prompt text.


### R9 Ã¢â‚¬â€ Redesign the dashboard around clean summary cards and progressive disclosure

**Product Owner direction:** present the primary information on clean summarized UI cards and hide diagnostic/detail chatter unless the user explicitly opens a card.

The current wide task/local-chat tables are too dense, expose IDs and timestamps continuously, and degrade badly as the editor narrows. Replace the primary table-first presentation with a responsive card-first dashboard.

#### Primary dashboard hierarchy

Keep the existing top summary metrics, but make the rest of the default view intentionally concise:

1. **Overall summary cards**
   - Requests
   - Input tokens
   - Cached tokens / cache hit
   - Output tokens
   - Estimated cost
   - Reasoning may be available in detail rather than requiring its own top-level card if space is constrained.

2. **Task cards**
   Each collapsed task card should show only the information a user is likely to care about at a glance:
   - cleaned human task title/preview as the dominant label;
   - project/workspace name;
   - request count;
   - compact total input tokens;
   - cache-hit percentage;
   - compact output tokens;
   - estimated cost;
   - optional compact last-activity time if it fits without clutter.

   Do **not** show UUIDs, full Local Chat IDs, full timestamps, request-by-request rows, reasoning totals, pricing internals, or request-kind chatter in the collapsed/default state.

3. **Local Chat cards**
   Present each local chat as a compact roll-up card, e.g.:
   - chat display title derived from the first cleaned task preview;
   - task count;
   - request count;
   - total estimated cost;
   - optional compact token/cache summary.

   Do not expose the local-chat UUID in the collapsed card.

4. **Unassigned Copilot overhead**
   Present one compact summary card/section in the default view showing total unassigned requests/tokens/cost. Individual request kinds and their metrics stay hidden until expanded.

#### Expanded task detail

Clicking/tapping a Task card expands or opens its detail view. Only then show:

- Local Chat ID and Task ID with copy actions;
- start + last-activity timestamps;
- complete token metrics (input, cached, uncached, output, reasoning, total);
- request-kind breakdown with requests/input/cached/cache-hit/output/reasoning/cost;
- individual request timeline;
- model / reasoning effort / status information where useful.

The detail view may be a collapsible inline panel, selected-card detail region, or dedicated webview subpanel; choose the simplest robust implementation. It must be easy to close/collapse back to the summary view.

#### Expanded Local Chat detail

Clicking/tapping a Local Chat card should reveal:

- Local Chat ID and copy action;
- all Task cards belonging to that chat;
- aggregate tokens/cache/cost;
- start/last activity.

This is where the user should be able to understand the hierarchy **Chat Ã¢â€ â€™ Tasks Ã¢â€ â€™ Requests** without seeing identifiers everywhere by default.

#### Responsive behavior

- No page-level horizontal scrolling in normal dashboard use.
- Task and chat cards must reflow as the editor width shrinks (single column on narrow widths; multi-column/grid when wider).
- Long cleaned task titles wrap/clamp cleanly and must not force the layout wider.
- Expanded request tables may use local horizontal scrolling if truly necessary, but the primary dashboard must not depend on a wide table.
- Maintain readable targets and spacing at narrow editor widths.

#### Interaction / usability

- Entire cards should have a clear clickable/tappable affordance.
- Preserve current period/project/model/search filters.
- Preserve CSV export and clear-history controls, but keep them visually secondary to usage summaries.
- Default dashboard refresh should keep the user at the summary level unless they intentionally select a card.
- Use VS Code theme variables and existing CSP/security constraints; no remote UI dependencies.
- Keep all existing privacy constraints and the 160-character cleaned preview cap.

#### Acceptance examples

At default view, the user should see something conceptually like:

```text
Overall
[ 18 requests ] [ 923k input ] [ 92.1% cached ] [ 8.5k output ] [ $0.0107 ]

Tasks
Ã¢â€Å’ Fix library import issue Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â
Ã¢â€â€š Library Builder                               Ã¢â€â€š
Ã¢â€â€š 18 req   923k in   92.1% cache   8.5k out   Ã¢â€â€š
Ã¢â€â€š                                      $0.0107  Ã¢â€â€š
Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ

Local chats
Ã¢â€Å’ Fix library import issue                      Ã¢â€Â
Ã¢â€â€š 2 tasks Ã‚Â· 25 requests Ã‚Â· $0.0138              Ã¢â€â€š
Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ

Unassigned Copilot overhead
Ã¢â€Å’ 3 requests Ã‚Â· 41k tokens Ã‚Â· $0.0004            Ã¢â€Â
Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ
```

Clicking the Task/Chat/Overhead card reveals the dense diagnostics. The dense diagnostics must not dominate the default screen.

#### R9 verification

Add/adjust deterministic rendering/aggregation tests where practical, then verify manually in a narrow and wide VS Code editor. The live smoke retest for R7/R8 should also confirm that:
- one multi-step user task renders as **one collapsed Task card** with aggregated usage;
- a second prompt in the same Copilot chat becomes a second Task card under the same Local Chat;
- the default screen remains readable without horizontal scrolling.


### R10 Ã¢â‚¬â€ Keep open dashboards synchronized across VS Code windows

**Live observation:** with the dashboard open in two VS Code workspaces, the stale window catches up immediately when **Refresh** is clicked, proving both extension hosts are reading the same shared usage ledger. It then stops updating while Muse work continues in the other window. This is because `onRecorded` refreshes only the dashboard owned by the extension host that recorded the request.

**Required behavior:**

1. An open Muse Usage dashboard must notice changes written by another VS Code extension host/window and refresh automatically.
2. With identical filters (for example Project = All), two simultaneously open dashboards should converge on the same ledger totals without manual Refresh.
3. Keep the current workspace-scoped status bar behavior unchanged; status bars are intentionally per-workspace and need not match.
4. Cross-window refresh must preserve the dashboard's current period/project/model/search filters and any intentionally selected/expanded Task/Local Chat/Overhead card. Do not reset the view to defaults merely because another window wrote usage.
5. Avoid continuous polling when no Muse Usage dashboard is open/visible. Start observation when the panel is visible; suspend/stop it when hidden or disposed.
6. Debounce/coalesce bursts of ledger writes so a fast Agent loop does not cause excessive webview rebuilds.
7. Watch both `requests.jsonl` and `contexts.json` (or an equivalent usage-v1 change signature) so usage totals and task/chat labels remain coherent.
8. The mechanism must tolerate the usage directory/files not existing yet and files being replaced/cleared.
9. Observation failures must be warn-only and must never interfere with model requests or usage recording.

**Preferred implementation:** because `globalStorageUri` is local for the primary desktop use case, use a lightweight file/directory change observer or low-frequency signature check scoped to the open dashboard. A ~1Ã¢â‚¬â€œ2 second visible-panel refresh latency is acceptable. Favor robustness on Windows over immediate sub-second UI churn.

**Verification:**

- deterministic/testable change-signature/debounce logic where practical;
- manual two-window test:
  1. open Muse Usage in Workspace A and Workspace B;
  2. set both to Project = All and the same filters;
  3. run a Muse Agent task in A;
  4. without clicking Refresh in B, confirm B catches up automatically within the designed refresh interval;
  5. confirm B retains its chosen filters/expanded-card state;
  6. hide/close B's dashboard and confirm its observer stops/suspends;
  7. reopen and confirm it immediately reconciles to current ledger state.


## Live Smoke Repair 01 â€” disposition (2026-09-25, same branch)

All four findings repaired in scope; revalidation complete.

- **R7 (unified stateful marker):** usage correlation now rides inside the single supported stateful_marker payload (src/provider/replay/markers.ts carries {vision, reasoning, usage:{version, writer, chatId, taskId}}; createReplayMarkerPart(metadata, prefix) prefixes bytes with the exact VS Code selected model ID). src/provider/request.ts threads usageCorrelation through PreparedChatRequest; src/provider/stream.ts merges it into the one emitted marker and no longer emits a second meta-spark-usage-context part. hasReplayMarkerMetadata treats valid usage IDs as sufficient emission reason. src/usage/marker.ts recovers IDs from the reconstructed stateful_marker on the next request (legacy standalone MIME still parsed, never emitted). Backward parsing of legacy meta-spark/model-ID/raw-UUID/replay payloads preserved. No totals, prompts, source, or tool output enter the marker.
- **R8 (prompt sanitizer):** src/usage/context.ts::sanitizePromptText strips <reminder>, <system-reminder>/<system_reminder>, <attachments>, <context>, <current_datetime>, and self-closing <pr_metadata/>, then unwraps <userRequest>/<user_query> (leading text preferred; wrapper inner text recovered when it holds the only real prompt). isSubstantiveHumanTurn and 
ormalizePreview operate on sanitized text, so scaffolding-only messages never create tasks and previews show the human prompt (still whitespace-collapsed, 160-char capped).
- **R9 (card-first dashboard):** src/usage/dashboard.ts renders overall summary cards, collapsed task cards (title, project, req/in/cache-hit/out, cost), collapsed local-chat roll-up cards, and one compact unassigned-overhead card; IDs, timestamps, per-kind tables, and request timelines appear only in expanded detail (task/chat/overhead). Responsive grid with no page-level horizontal scroll; expanded tables scroll locally. Filters, export, and clear preserved; refresh preserves filter/expansion state. New usage.dashboard.expand/collapse en/zh strings.
- **R10 (cross-window sync):** UsageDashboard starts a 1.5s signature poll only while the panel exists and is visible (stopped on hide/dispose); getChangeSignature() on the file stores (Node stat size+mtime for both usage-v1 files; VS Code stat fallback; in-memory signatureFromLedger for tests) detects writes from another extension host. Cross-window refresh routes through 
efreshPreservingState() (filters + selected task/chat + overhead expansion retained) and is debounced via shouldRefreshSignature (1.5s). Status bar stays workspace-scoped. Observation failures are warn-only.
- **Tests:** 
pm test 39/39 pass (10 suites): all 29 pre-existing cases plus R7 round-trip, Standard/Contributor prefixes, legacy parsing, reasoning+usage coexistence, no-legacy-marker-emitted source assertion, two-prompts-one-chat/tool-loop-stays, R8 strip/unwrap/context-only, and R10 signature/debounce cases.
- **Checks:** 
pm run compile pass; 
pm run lint 0/0 (67 files); touched-file oxfmt --check clean (11 files); 
pm run package rebuilt dist/meta-spark-for-copilot-2.2.0.vsix (83 files, 395.68 KB), SHA256 CAE4DD4FE491E57BE7CC543BE4B3BE485EDEFFEAA2A3CFFE66DFE97F235F20DF; sce ls confirms test artifacts stay out of the VSIX. Report updated, ACTIVE returned to COMPLETE - PENDING REVIEW, branch pushed and verified in sync with remote.



## Engineering Manager Review 04 â€” 2026-09-25

**Disposition:** CHANGES REQUIRED â€” R7â€“R10 are directionally correct, but source review found four final dashboard/state issues that should be repaired before installing the next smoke-test VSIX.

### R11A â€” Local writes must preserve dashboard filters/expanded state and be coalesced

**Current issue:** `src/runtime/lifecycle.ts` still calls `activeDashboard.refresh()` from `UsageService.onRecorded`. `UsageDashboard.refresh()` resets `viewState` to 30d / All projects / All models / empty search / collapsed detail. Therefore, while a Muse job is actively generating requests in the same VS Code window, any selected Project/Model filter or expanded Task/Chat card can be reset on every recorded request. It also rebuilds the webview on every request instead of coalescing a fast agent loop.

**Required correction:**
- expose/use a public preserving refresh/notification path for locally recorded usage; do not call the reset-to-default `refresh()` on each record;
- preserve period/project/model/search and selected Task/Chat/Overhead state during local live updates exactly as required for cross-window updates;
- debounce/coalesce local record bursts to roughly the same 1â€“2 second cadence as the cross-window watcher;
- when `open()` reveals an already-existing hidden panel, reconcile with current storage without unnecessarily resetting its saved view state;
- add deterministic coverage for state preservation/coalescing where practical.

### R11B â€” Do not swallow a cross-window change that arrives inside the debounce interval

**Current issue:** `pollSignature()` currently assigns `lastSignature = current` in the `else` branch whenever `shouldRefreshSignature(...)` returns false. If the signature changed but the minimum interval has not elapsed, this marks the new signature as already seen without rendering it. If no further write occurs, the next poll sees no change and the stale dashboard can remain stale indefinitely.

This can occur because the polling interval and refresh duration are both part of the timing; after one refresh completes, the next timer tick may occur less than 1500 ms later.

**Required correction:**
- never advance the acknowledged/rendered signature merely because a changed signature was observed during the debounce holdoff;
- retain the pending change until the minimum interval elapses, then refresh even if there are no additional writes;
- after a successful render, advance the acknowledged signature to the rendered storage state;
- add a regression test: change arrives inside debounce â†’ no new writes â†’ later poll still refreshes.

### R11C â€” Prompt sanitizer must not duplicate Copilot's userRequest echo

**Current issue:** `sanitizePromptText()` replaces `<userRequest>...</userRequest>` / `<user_query>...</user_query>` with their inner text unconditionally. In Copilot's common persisted form, the raw human prompt may already appear before the wrapper, with the wrapper repeating it. Example:

```text
Fix the tests
<context>...</context>
<userRequest>Fix the tests</userRequest>
```

Current output becomes effectively `Fix the tests Fix the tests`.

The current Copilot source uses different semantics: remove auxiliary blocks and wrappers first; if real leading text remains, use that. Only when the wrapper contains the only prompt should its inner text be recovered.

**Required correction:**
- align sanitizer behavior with that rule;
- preserve the existing context-only/non-substantive behavior;
- add tests for both:
  - leading raw prompt + echoed wrapper â†’ one copy only;
  - wrapper-only prompt â†’ wrapper inner text recovered.

### R11D â€” Dashboard clear must refresh the status bar immediately

**Current issue:** lifecycle first constructs `UsageDashboard` with an `onCleared` callback that refreshes the status bar, then replaces that callback via `setOnCleared(() => usageService.clearAll())`. The dashboard's Clear action therefore clears storage/cache and refreshes its own webview, but the status-bar callback is no longer invoked. The status bar only catches up on its later timer.

**Required correction:**
- wire one clear callback that performs `usageService.clearAll()` **and** refreshes the status bar;
- keep the Command Palette clear path equivalent;
- preserve the prior no-resurrection behavior.

### Revalidation

After R11Aâ€“R11D:
- rerun the full deterministic suite with the new cases;
- compile/lint/touched-file formatter/package;
- update this Completion Report with test count and new VSIX SHA256;
- return ACTIVE to COMPLETE - PENDING REVIEW;
- then repeat the live Copilot smoke. Do not merge before that live smoke passes.

No change is requested to the overall R7 stateful-marker architecture or the R9 card-first visual design in this review.


## Review Repair 02 — disposition (2026-09-25, same branch)

All four R11 findings repaired in scope; revalidation complete.

- **R11A (local live updates preserve state):** UsageService.onRecorded in src/runtime/lifecycle.ts now calls the new coalesced UsageDashboard.notifyRecorded() instead of the resetting 
efresh(). Local bursts share one 
efreshPreservingState() render on the same ~1.5s cadence as the cross-window watcher; period/project/model/search and selected Task/Chat/Overhead state are preserved. open() on an existing panel reconciles via 
efreshPreservingState() instead of resetting to defaults.
- **R11B (debounce retention):** added pure 
extRefreshDecision() in src/usage/dashboard.ts; pollSignature() retains a changed signature as pendingSignature during the holdoff instead of acknowledging it, then refreshes on a later poll even with no further writes. The acknowledged signature advances only on a successful render. Regression test covers change-inside-debounce followed by a quiet later poll.
- **R11C (sanitizer echo):** sanitizePromptText() now strips <userRequest>/<user_query> wrappers first and only recovers wrapper inner text when nothing real remains; Fix the tests <context/> <userRequest>Fix the tests</userRequest> yields one copy, wrapper-only prompts still recover inner text. Context-only behavior unchanged.
- **R11D (clear refreshes status):** the lifecycle setOnCleared callback now runs usageService.clearAll() **and** ctiveStatusBar.refresh() together, so dashboard Clear updates the status bar immediately; the Command Palette path already refreshes both. No-resurrection behavior preserved.
- **Tests:** 
pm test 42/42 pass (10 suites): 39 pre-existing plus R11B pending-refresh, R11C echo-dedup/wrapper-only, and R11A/R11D source-wiring cases.
- **Checks:** 
pm run compile pass; 
pm run lint 0/0 (67 files); touched-file oxfmt --check clean (src/usage/dashboard.ts, src/usage/context.ts, src/runtime/lifecycle.ts); 
pm run package rebuilt dist/meta-spark-for-copilot-2.2.0.vsix (83 files, 396.66 KB), SHA256 CA3256A8E6CD3B5A331583691FAA9E9F6B03B4C03410417E537BA4B7C89F4C6C; sce ls confirms test artifacts stay out of the VSIX. ACTIVE returned to COMPLETE - PENDING REVIEW; branch pushed and verified in sync with remote.



## Engineering Manager Review 05 — 2026-09-25

**Disposition:** SOURCE REVIEW PASS — ready for the second live Copilot smoke; do not merge until the live smoke passes.

Review of repair commit `b25e4b58937517889276d49590c3f6fc0ea2d587` confirms R11A–R11D are implemented in source:

- R11A: local `onRecorded` updates route through coalesced `UsageDashboard.notifyRecorded()` / state-preserving refresh; reopening an existing panel preserves view state.
- R11B: changed signatures observed inside the debounce holdoff remain pending until a later poll can render them; the acknowledged signature advances only through a successful state-preserving render.
- R11C: Copilot prompt scaffolding sanitization now drops echoed `userRequest` / `user_query` wrappers when leading human text exists, and recovers wrapper content only when it is the sole prompt.
- R11D: dashboard Clear routes through `UsageService.clearAll()` and immediately refreshes the workspace status bar.

The R7 unified `stateful_marker` correlation architecture and R9 card-first responsive UI remain intact.

Reported validation is internally consistent: 42/42 deterministic tests pass, compile/lint pass, touched-file formatting passes, and the rebuilt `2.2.0` VSIX SHA256 is `CA3256A8E6CD3B5A331583691FAA9E9F6B03B4C03410417E537BA4B7C89F4C6C`.

**Remaining gate:** repeat the real GitHub Copilot Agent smoke test with this exact VSIX. For an unambiguous result, export any test history worth keeping, then clear Usage History before the test so the earlier broken one-request-per-task records do not obscure the new behavior.

Live PASS criteria:

1. One substantive prompt that causes multiple Agent/tool steps appears as **one Task card with multiple requests**.
2. The task title is the cleaned human prompt, not Copilot `<context>` scaffolding and not a duplicated prompt.
3. A second substantive prompt in the same Copilot chat creates a **second Task card under the same Local Chat**.
4. Project/model/time filters remain selected while usage is actively increasing; an expanded card remains expanded through live updates.
5. With a second VS Code window open to the dashboard and matching filters, it catches up automatically without manual Refresh.
6. The default dashboard remains card-first/responsive; dense request-kind/timeline detail stays hidden until a card is opened.
7. Dashboard Clear, if exercised after evidence is captured, resets dashboard and status bar immediately and does not resurrect prior chat/task metadata.

If all seven pass, WP-0001 is technically accepted and may proceed directly to routine integration under delegated authority.


## Live Copilot Smoke 02 / Engineering Manager Review 06 — 2026-09-25

**Disposition:** PARTIAL PASS / CHANGES REQUIRED — correlation is now working, but human-facing chat/task labeling still leaks Copilot prompt scaffolding and the dashboard does not expose a true/native chat subject.

### Confirmed live improvements

The second live smoke shows the core R7 correlation repair working:

- 27 Muse requests are aggregated into **1 Task**;
- that Task belongs to **1 Local Chat**;
- the selected Project filter (`ENAX-Konnect`) is active while usage is displayed;
- the card-first dashboard is readable and no longer dominated by a wide request table.

This is a major pass for the core accounting/correlation architecture.

### R12A — Strip current Copilot `<reminderInstructions>` scaffolding

**Observed defect:** the Task card and Local Chat card are titled with:

`<reminderInstructions> When using the replace_string_in_file tool, include 3-5 lines of...`

That is Copilot-generated system/reminder content, not the user's prompt.

Current VS Code/Copilot source confirms `reminderInstructions` is a prompt tag rendered beside the user message. Our sanitizer currently removes `<reminder>`, `<system-reminder>`, etc., but not this camel-case tag.

**Required correction:**
- strip `<reminderInstructions>...</reminderInstructions>` case-insensitively before task detection/preview generation;
- support obvious hyphen/underscore variants defensively if they appear;
- preserve the current rule: prefer real leading human text when present; otherwise recover `<userRequest>` / `<user_query>` inner text;
- add regression tests proving a prompt composed of generated reminder/context blocks plus a userRequest wrapper yields only the actual human prompt;
- do not create a new task from a message that reduces to reminder/system scaffolding only.

### R12B — Make the Local Chat card explicitly represent a chat subject

**Current behavior:** `ChatMetadata.displayName` is derived from the first task preview. It is a local grouping title, not the native GitHub Copilot chat title. The current dashboard gives no explicit indication of that distinction.

Current VS Code/Copilot source shows native chat/session title generation is owned by VS Code/Copilot itself (for example `AgentHostSessionTitleController` / the Copilot title provider) and may use a separate utility model path. The Language Model provider API does not expose a stable native chat title/session title to this extension. Therefore do not claim an exact native Copilot subject unless it is actually observable and reliably correlated.

**Required UX:**
1. Give every Local Chat a clear **Subject** (or equivalent) in the card/detail UI.
2. For v1, derive that local subject from the **first cleaned human task preview** after R12A. This should be short, human-readable, and stable for the life of that Local Chat.
3. Label/document it as a **local chat subject** (extension-owned), not as the native Copilot title.
4. If a future/current `chat-title` request is actually observed by this provider **and can be correlated without guessing**, it may be used to improve the local subject. Do not use heuristic cross-chat matching and do not store arbitrary response text merely to chase the native title.
5. In expanded Local Chat detail, show:
   - Subject
   - Project
   - task count
   - request count
   - token/cache/cost rollup
   - Local Chat ID only in the expanded diagnostic area.
6. Task cards should continue to show the cleaned task prompt; the Local Chat card should visually identify itself as the chat-level grouping/subject.

### Smoke retest

After R12A/R12B:
- rebuild/package and record new SHA256;
- clear old smoke data;
- run one multi-step prompt and confirm the Task title is the user's prompt, not `reminderInstructions`;
- confirm the Local Chat card shows a clear local Subject derived from that cleaned first prompt;
- send a second prompt in the same chat and confirm 2 Tasks / 1 Local Chat while the Local Chat Subject remains stable;
- complete the remaining cross-window auto-sync/filter/expanded-card checks from Review 05.

Do not merge until this live retest passes.

## Review Repair 03 — R12 disposition (2026-09-25, same branch)

All R12 findings repaired in scope; revalidation complete.

- **R12A (reminderInstructions strip):** `sanitizePromptText()` in `src/usage/context.ts`
  now strips Copilot's camel-case `<reminderInstructions>...</reminderInstructions>`
  blocks case-insensitively (plus hyphen/underscore variants defensively, paired
  blocks first, then orphan/self-closing tags). Task detection and 160-char preview
  generation therefore see the real human prompt; a message reducing to reminder
  scaffolding only is never a substantive turn and never creates a task.
- **R12B (explicit local subject):** Local Chat cards now carry an explicit
  **Local subject** label in the collapsed card and a `Local subject: ...` heading
  plus `localSubjectNote` in expanded chat detail, clearly distinguished from the
  native Copilot session title. The subject derives from the first cleaned human
  task preview and stays stable for the chat lifetime (only an empty/placeholder
  subject is ever filled; later tasks never rewrite it). New en/zh strings
  `usage.dashboard.subject`, `usage.dashboard.localSubject`, and
  `usage.dashboard.localSubjectNote`; README en/zh document the local-subject
  semantics.
- **Tests:** `npm test` 44/44 pass (10 suites): 42 pre-existing plus R12A
  strip/reminder-only and R12B subject-wiring regression cases.
- **Checks:** `npm run compile` pass; `npm run lint` 0/0 (67 files); source
  formatter check clean (`src/usage/context.ts`, `src/usage/dashboard.ts`,
  `src/usage/recorder.ts`, `src/i18n.ts`). `test/usage.test.cjs` was already
  failing the repo formatter at baseline (verified via stash), so its churn is
  limited to the minimal R12 addition. `npm run package` rebuilt
  `dist/meta-spark-for-copilot-2.2.0.vsix` (83 files, 397.28 KB), SHA256
  `BCD93AAA4D47C0CBE877956FCA0898A32EEAEAD4AFEBE1B81BB81D27ACC3283B`;
  `vsce ls` confirms test artifacts stay out of the VSIX.
  ACTIVE returned to COMPLETE - PENDING REVIEW; branch pushed and verified in
  sync with remote. Live smoke retest still required before merge.


## Engineering Manager Review 07 — 2026-09-25

**Disposition:** SOURCE REVIEW PASS — ready for final live smoke; do not merge until the live smoke passes.

Review of repair commit `928cdd4f09d1ffe096d59ef6aca072aff30f5c93` confirms the user-visible R12 defects are repaired:

- R12A: `sanitizePromptText()` strips Copilot `<reminderInstructions>...</reminderInstructions>` case-insensitively, including defensive hyphen/underscore tag variants, before substantive-turn detection and task preview generation. Reminder-only messages remain non-substantive; mixed reminder/context + `userRequest` input resolves to the human prompt.
- R12B: collapsed Local Chat cards now explicitly label the extension-owned **Local subject** above the stable chat display name. Expanded chat detail repeats the Local subject and clearly states that it is derived from the first cleaned human task preview and is not the native Copilot session title.
- The subject remains stable for the Local Chat lifetime; later task previews do not overwrite it.
- The existing R7 correlation architecture remains intact.

Reported validation is internally consistent: 44/44 deterministic tests pass, compile/lint pass, relevant source formatting passes, and the rebuilt `2.2.0` VSIX SHA256 is `BCD93AAA4D47C0CBE877956FCA0898A32EEAEAD4AFEBE1B81BB81D27ACC3283B`.

**Remaining gate:** one final live smoke with this exact VSIX. Clear prior smoke data first. Pass requires:
1. first multi-step prompt → one Task / one Local Chat with multiple requests;
2. Task title = cleaned human prompt (no `reminderInstructions`);
3. Local Chat card visibly shows a Local subject derived from that prompt;
4. second human prompt in the same Copilot chat → two Tasks / one Local Chat while the Local subject stays unchanged;
5. selected filters/expanded-card state survive live updates;
6. second VS Code window auto-syncs without manual Refresh.

If these pass, WP-0001 may proceed directly to routine integration under delegated authority.


## Final Live Copilot Smoke / Engineering Manager Acceptance — 2026-09-25

**Disposition:** PASS — WP-0001 accepted for routine integration.

The Product Owner reported the final packaged 2.2.0 live smoke as **PASS** after the R12 repair. This closes the remaining end-to-end acceptance gate.

Accepted live behavior includes the final criteria carried forward from Reviews 05–07:

- multi-step GitHub Copilot Agent work remains correlated as one Task with multiple Muse requests;
- a second human prompt in the same Copilot chat becomes a second Task under the same Local Chat;
- Task titles use cleaned human prompt text rather than Copilot-generated prompt scaffolding;
- Local Chat cards expose a stable extension-owned Local subject;
- card-first summary UI remains the default with dense diagnostics behind expansion;
- project/model/time filtering and expanded-card state survive live updates;
- a second VS Code window automatically reconciles the shared usage ledger without manual Refresh.

The final accepted package remains `dist/meta-spark-for-copilot-2.2.0.vsix`, SHA256 `BCD93AAA4D47C0CBE877956FCA0898A32EEAEAD4AFEBE1B81BB81D27ACC3283B`.

WP-0001 is technically accepted. Routine integration to `main` is authorized under delegated project governance; no separate merge-approval ceremony is required.
