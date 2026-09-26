# WP-0001 — Muse Per-Task Usage Monitor for GitHub Copilot

**Status:** READY FOR EXECUTION  
**Source:** Product Owner request — 2026-09-25, per-task Muse API usage accounting for the GitHub Copilot integration  
**Priority:** N/A  
**Parent Program:** none  
**Branch:** `wp/0001-muse-usage-monitor`  
**Owner / Authority:** Engineering Manager  
**Execution Authorization:** READY FOR EXECUTION means Engineering Manager-authorized; no additional Product Owner approval is required unless a reserved gate is listed below.

## Objective

Add a local-first Muse usage monitor directly to this VS Code extension so GitHub Copilot users can see authoritative Meta token usage and estimated cost at request, task, local-chat, and project levels.

The feature shall work inside the existing `meta-spark-for-copilot` provider path. It shall not add an HTTP proxy, external service, second API-key path, or Meta-dashboard scraper.

The primary user outcome is: after running a Copilot task with Muse Spark, the user can open a VS Code dashboard and answer, with local data captured from Meta's returned usage object:

- how many Muse requests the task used;
- input, cached-input, uncached-input, output, reasoning, and total tokens;
- cache-hit percentage;
- estimated USD cost;
- which local Copilot chat/task/project the usage belongs to;
- how much usage came from main-agent versus Copilot/background request kinds.

## Scope In

1. Capture usage returned by Meta for every completed Muse request.
2. Introduce extension-owned `chat_id` and `task_id` correlation for Copilot agent conversations.
3. Persist correlation through Copilot history using a hidden, versioned `LanguageModelDataPart` marker.
4. Preserve a clear hierarchy: **Request → Task → Local Chat → Project**.
5. Continue using the existing request classifier so usage can be broken down by `main-agent`, `terminal-steering`, `todo-tracker`, `chat-title`, `git-commit-message`, other background kinds, etc.
6. Calculate estimated cost from the model pricing already carried by the extension's `MODELS` catalog.
7. Store usage locally under the extension's `globalStorageUri`; no cloud sync.
8. Add a VS Code usage dashboard with time/project/model filters, task rollups, local-chat context, and request-level drill-down.
9. Add request-level CSV export.
10. Add a configurable status-bar summary for the most recent/current tracked task in the active workspace.
11. Add a clear-history command with explicit confirmation.
12. Add deterministic tests for task/chat correlation, pricing math, persistence/aggregation helpers, and marker round-trip behavior.
13. Update extension documentation, localization strings, changelog, version, and packaging metadata needed for the feature.
14. Build a distributable VSIX after verification.

## Scope Out

- Reconstructing the historical requests already summarized on Meta's dashboard.
- Scraping or automating the Meta developer dashboard.
- Changing Meta authentication/API-key handling.
- Adding an HTTP proxy, local web service, tray process, or standalone Windows application.
- Uploading usage data to any remote service.
- Capturing or storing complete prompts, source files, system prompts, tool arguments/results, tool output, reasoning text, response text, request bodies, response bodies, or API keys.
- Claiming the extension-owned `chat_id` is GitHub Copilot's native session ID.
- Deep-linking to/opening the exact native Copilot chat in v1; the current LanguageModelChatProvider surface does not expose a stable native Copilot chat/session identifier to this provider.
- Heuristic cross-chat joining when correlation evidence is absent.
- Manual task merge/rename workflows in v1.
- Marketplace/Open VSX publication or upstream pull request submission. Packaging the local fork is in scope; publication is not.

## Authoritative References / Provenance

Repository implementation references at preparation time:

- `src/client/core.ts` — streams Meta chat completions and already requests `stream_options.include_usage=true`.
- `src/provider/stream.ts` — already receives `MetaUsage`, updates token diagnostics, and emits Copilot `usage` data.
- `src/provider/index.ts` — provider entry point for every Muse invocation.
- `src/provider/routing/classifier.ts` — current request-kind classification.
- `src/provider/replay/*` and `src/provider/segment.ts` — existing hidden `LanguageModelDataPart`/marker patterns that may be reused as implementation patterns.
- `src/consts.ts` — model pricing for Standard and Contributor tiers.
- `src/provider/pricing/costs.ts` — current model-cost presentation helper.
- `src/runtime/commands.ts`, `src/runtime/lifecycle.ts`, `package.json`, and localization files — command/UI integration points.
- Current VS Code provider contract: `ProvideLanguageModelChatResponseOptions` exposes request initiator/model configuration but not a stable native Copilot chat session ID. Treat this as a v1 design constraint; do not reverse-engineer Copilot private storage.

Baseline branch at WP preparation: `main` at `1938fef7342009b53c2189ada32ec07f1de9f946`.

## Requirements / Constraints

### A. Usage source of truth

1. Token accounting must use the `MetaUsage` object returned by Meta, not local token estimates.
2. Record at minimum:
   - timestamp;
   - local `project_id` and display name;
   - local `chat_id` when known;
   - local `task_id` when known;
   - VS Code model ID;
   - API model ID;
   - request kind;
   - request initiator when available;
   - reasoning effort;
   - prompt/input tokens;
   - cached input tokens;
   - uncached input tokens;
   - completion/output tokens;
   - reasoning tokens;
   - total tokens;
   - estimated USD cost;
   - pricing model/source;
   - request duration when available;
   - completion status.
3. `uncached_input_tokens = max(prompt_tokens - cached_tokens, 0)` unless Meta provides an authoritative miss count that can be used directly.
4. Reasoning tokens are a breakdown of completion/output tokens and must not be billed a second time.
5. Failed/cancelled calls that return no authoritative usage must not fabricate token counts or cost. They may be logged as attempts with null usage, but must be excluded from token/cost totals.

### B. Cost calculation

1. Use the selected extension model's USD rates already defined in `MODELS`:
   - uncached input rate;
   - cached input rate;
   - output rate.
2. Formula:
   - `uncached_input_cost = uncached_input_tokens / 1_000_000 * input_rate`
   - `cached_input_cost = cached_input_tokens / 1_000_000 * cached_input_rate`
   - `output_cost = completion_tokens / 1_000_000 * output_rate`
   - total = sum of the three.
3. Present cost as **estimated local cost** derived from the extension's catalog, not as a billing invoice.
4. Persist the pricing model/rates or pricing source necessary to explain historical calculations if catalog rates later change.
5. If a model override makes the actual API model materially different from the selected catalog model, flag the cost as estimated/uncertain rather than silently claiming exact billing.

### C. Local chat/task correlation

Create a dedicated, versioned usage-context marker. Reuse the existing replay-marker transport/encoding patterns where practical, but do not overload replay semantics or make usage tracking depend on vision/reasoning replay data.

The marker must contain only correlation metadata, conceptually:

```json
{
  "version": 1,
  "writer": "meta-spark-for-copilot",
  "chatId": "<uuid>",
  "taskId": "<uuid>"
}
```

It must not contain prompt text, source code, tool data, or usage totals.

Correlation rules:

1. On the first substantive `main-agent` request with no valid usage-context marker:
   - create a UUID `chat_id`;
   - create a UUID `task_id`;
   - associate the request with both.
2. Emit the current usage-context marker into the main-agent assistant response as a hidden `LanguageModelDataPart` so subsequent Copilot tool loops/history can return it to the provider.
3. On later calls where the most recent valid usage marker is still current:
   - retain both IDs for tool continuations and additional inference calls for the same task.
4. When a new substantive human text turn occurs after the latest valid marker in the same chat:
   - retain `chat_id`;
   - create a new `task_id`;
   - associate the new task with that chat.
5. Tool-result-only messages, terminal notifications, customizations/control updates, and known utility/background requests must not create a new task merely because they appear after a marker.
6. Non-main/utility requests may inherit a task when a valid correlation marker is actually present in their history. If correlation is absent, record them as **unassigned Copilot overhead** for the project rather than guessing.
7. Do not join requests to a chat/task solely by timing, active editor, process identity, or workspace when no marker evidence exists.
8. If a failed/cancelled first call prevents a marker from persisting, prefer a split/unassigned record over an unsafe cross-chat guess.
9. Dashboard terminology must say **Local Chat ID** (or equivalent) so it is not confused with a native Copilot session ID.
10. Preserve a nullable future field for native Copilot session identity/deep-link metadata if VS Code later exposes it, but do not reverse-engineer private Copilot storage in this WP.

### D. Project identity

1. Derive a stable local `project_id` from workspace identity using a one-way hash of canonical workspace folder/workspace URIs.
2. Store a human-readable workspace/project name for display.
3. Do not persist full local filesystem paths solely for usage tracking.
4. Multi-root workspaces must produce a deterministic identity independent of folder ordering.

### E. Prompt preview / recognizability

1. Store only a short preview of the substantive human task prompt so a dashboard row can be recognized later.
2. Normalize whitespace and cap the persisted preview at **160 characters**.
3. The first task preview becomes the default local chat display name unless a better local label already exists.
4. Do not store the full prompt or any additional conversation transcript.
5. CSV export may include the same capped preview and no more.

### F. Local persistence

Use file-backed storage under:

`<globalStorageUri>/usage-v1/`

Required files:

- `requests.jsonl` — append-only request/usage ledger.
- `contexts.json` — versioned chat/task metadata and local display information.

Constraints:

1. No native database dependency and no external service.
2. `contexts.json` updates must be atomic (temporary file + replace/rename or equivalent).
3. `requests.jsonl` records must be schema-versioned.
4. A malformed/truncated final JSONL line after a crash must not make older history unreadable; ignore/report the bad tail safely.
5. v1 has no automatic retention deletion. History remains until the user clears it.
6. Clearing history must remove only usage-monitor data, not API keys, diagnostics, or unrelated extension storage.

### G. Dashboard

Add command:

`Meta Spark: Open Usage Dashboard`

The dashboard shall be a local VS Code webview with no remote JS/CSS dependencies and a restrictive CSP.

Minimum dashboard content:

1. Summary cards for selected period:
   - requests;
   - input tokens;
   - cached tokens;
   - output tokens;
   - cache-hit percentage;
   - estimated cost.
2. Period filters: 7d, 30d, 90d, All.
3. Project and model filters.
4. Primary task table including:
   - task preview/title;
   - project;
   - local chat label/ID;
   - start/end or last-activity time;
   - request count;
   - input;
   - cached input;
   - cache-hit %;
   - output;
   - reasoning;
   - estimated cost.
5. Task detail/drill-down showing the individual request timeline and request-kind breakdown.
6. Local chat roll-up so all tasks belonging to one extension-owned chat can be viewed together.
7. Explicit display note that local chat IDs are extension-owned and v1 cannot deep-link to the exact native Copilot chat.
8. IDs shall be visible/copyable in task/chat details for troubleshooting.
9. Empty states and corrupted-record warnings shall be understandable and non-fatal.

### H. CSV export

Add command:

`Meta Spark: Export Usage CSV`

1. Export request-granularity rows from the local ledger.
2. Include project/chat/task IDs, capped task preview, timestamps, model/request kind, token fields, cache-hit data, and estimated cost.
3. Use a user-selected save location.
4. Never export API keys, prompts beyond the 160-character preview, source/tool/reasoning/response content, or full filesystem paths.

### I. Status bar

1. Add a setting to enable/disable usage status-bar display; default **enabled**.
2. For the active workspace, show a compact summary of the most recent tracked task, for example request/token/cost information without excessive width.
3. Tooltip should provide the richer current-task summary and local IDs.
4. Clicking the status item opens the Usage Dashboard.
5. Status-bar failures must never block model requests.

### J. Clear history

Add command:

`Meta Spark: Clear Usage History`

1. Require an explicit confirmation dialog.
2. Delete only `usage-v1` data.
3. Refresh dashboard/status bar after clearing.
4. This operation must not touch API keys, diagnostics, request dumps, model settings, or unrelated global storage.

### K. Performance / reliability

1. Usage recording must not materially delay streamed model output.
2. Ledger/context writes must be off the hot path where practical and must not convert a successful Muse response into a failed user request if persistence fails.
3. Persistence failures must be logged and surfaced non-disruptively.
4. Dashboard aggregation of the expected personal-use scale (thousands to low hundreds of thousands of records) must remain responsive; avoid O(n²) aggregation.
5. Do not add telemetry.

## Implementation Requirements

Create a cohesive `src/usage/` subsystem rather than scattering storage/UI/correlation logic through provider files.

Expected responsibilities:

- `context` — pure chat/task allocation and marker payload logic;
- `marker` — VS Code `LanguageModelDataPart` encoding/decoding adapter;
- `pricing` — pure usage cost calculation using model catalog rates;
- `storage` — JSONL/context persistence and safe read/clear/export support;
- `aggregate` — request/task/chat/project rollups;
- `recorder` — lifecycle integration around provider request/usage completion;
- `dashboard` — webview provider/panel and rendering;
- `status` — status-bar controller.

Exact filenames may vary, but maintain this separation of concerns and keep pure logic testable without loading VS Code.

Integration expectations:

1. Instantiate the usage service from extension lifecycle and inject/use it from `MetaChatProvider`; avoid global mutable singletons when practical.
2. Establish correlation before the Meta request so the returned usage is assigned correctly.
3. Feed authoritative usage from the existing `onUsage` path into the recorder.
4. Emit the hidden usage marker independently of existing replay markers so it persists even when there is no vision/reasoning replay payload.
5. Do not remove or regress existing Copilot `usage` data reporting.
6. Preserve current streaming, tool-call, replay, vision, diagnostics, and cancellation behavior.
7. Add localized strings for commands/settings/user-facing messages.
8. Keep dashboard HTML escaped; do not interpolate raw prompt preview or filesystem/user data unsafely.
9. Keep the feature compatible with Windows, macOS, and Linux extension hosts even though primary use is Windows.

## Required Documentation / Control Updates

1. Update `README.md` with:
   - Usage Monitor overview;
   - how to open/export/clear;
   - what is stored locally;
   - explanation of local chat/task IDs and the no-native-deep-link limitation;
   - status-bar setting;
   - privacy statement for the capped prompt preview.
2. Update `CHANGELOG.md`.
3. Bump the extension version from `2.1.0` to **`2.2.0`** as an additive feature release, consistent with current repository versioning guidance.
4. Update `package.json`, `package-lock.json`, and localization files for commands/settings.
5. Create completion report:
   `docs/40-work-management/work-packages/completion/WP-0001-COMPLETION.md`
6. Completion Report must include:
   - final architecture/file list;
   - correlation behavior and known limitations;
   - storage schema/version;
   - test/check results;
   - packaged VSIX filename/hash;
   - any deviations from this WP;
   - any follow-up backlog recommendations.

## Testing / Verification

### Automated

Use Node's built-in `node:test` for pure usage logic; do not add a heavy test framework solely for this feature.

Add deterministic coverage for at least:

1. Contributor and Standard cost formulas.
2. Cached/uncached token split and missing-cache-detail behavior.
3. Reasoning tokens not double billed.
4. New chat → first task allocation.
5. Same task across tool-continuation calls.
6. New substantive human turn → new task, same chat.
7. Tool-result-only continuation does not create a new task.
8. Terminal/background/control requests do not create a new task.
9. Missing marker on unrelated/background request → unassigned rather than guessed.
10. Marker encode/decode/version rejection/invalid payload handling.
11. Project identity determinism for reordered multi-root folders.
12. Prompt preview whitespace normalization and 160-character cap.
13. JSONL append/read with a truncated final line.
14. Aggregation totals and cache-hit percentage.
15. CSV field escaping.
16. Clear-history scope does not target unrelated extension storage.

Keep test artifacts out of the packaged VSIX.

### Repository checks

Run and report:

- `npm ci`
- `npm test`
- `npm run compile`
- `npm run lint`
- `npm run format:check`
- `npm run package`

Known baseline caution: this repository has previously exhibited Windows CRLF checkout state that can make repository-wide `format:check` fail without semantic source changes. Do not mass-reformat unrelated files merely to clear a line-ending-only baseline. If the global check still fails solely for the pre-existing CRLF condition, verify all touched files with the formatter, document the baseline condition in the Completion Report, and keep unrelated-file churn out of the WP.

### Functional acceptance

Exercise at least the following synthetic/provider-level sequence:

1. first main-agent prompt establishes a local chat/task;
2. multiple Meta usage callbacks accumulate into the same task;
3. a tool continuation retains the task;
4. a new human prompt creates a second task under the same local chat;
5. an uncorrelated utility/background request lands in unassigned overhead;
6. dashboard rollups equal the stored ledger totals;
7. export rows equal the ledger records;
8. clear history resets usage UI/storage without affecting API-key state.

If an Extension Development Host smoke test is available, additionally verify the dashboard command, status item, export dialog, clear confirmation, and hidden marker behavior in a real Copilot agent conversation. Absence of GUI automation is not by itself a stop condition if the deterministic provider-level correlation tests pass and the limitation is recorded.

## Acceptance Criteria

The WP is acceptable when all of the following are true:

1. Existing Muse/Copilot functionality still compiles and packages.
2. Every completed Meta request with a returned `MetaUsage` object can be represented as one local ledger record without prompt/response capture.
3. Request totals roll up deterministically to task, local chat, project, and selected time period.
4. Main-agent tool loops remain on one task; a new substantive human turn creates a new task under the same local chat.
5. Correlation never relies on timing-only guesses across chats.
6. Dashboard clearly distinguishes extension-owned Local Chat ID from native Copilot session identity.
7. Dashboard exposes per-task usage, cache rate, request-kind breakdown, request timeline, and estimated cost.
8. Contributor pricing correctly distinguishes cached and uncached input.
9. CSV export and clear-history commands work and respect privacy boundaries.
10. Status bar is useful, clickable, configurable, and non-blocking.
11. No external service/proxy/database/telemetry is introduced.
12. Full prompts, source/tool content, response content, reasoning content, full filesystem paths, and API keys are absent from usage storage and CSV.
13. Version/docs/changelog/localization are updated.
14. Tests/checks are reported and the VSIX is built.
15. Completion Report exists and ACTIVE is advanced to `COMPLETE - PENDING REVIEW` on the work branch.

## Upstream / Local Delta Disposition

This repository is a fork of `spinespine/meta-spark-for-copilot`.

This WP creates an **ENAX/local fork feature delta**. Do not publish upstream, open an upstream PR, or change upstream/publisher ownership metadata as part of this WP. Keep the implementation modular enough that a later upstreaming decision remains possible.

## Git / Completion Requirements

- implement only the authorized scope;
- keep unrelated refactors/format churn out of the branch;
- complete required documentation/evidence updates;
- create `WP-0001-COMPLETION.md`;
- review the full diff and working tree;
- update `ACTIVE.md` to `COMPLETE - PENDING REVIEW`;
- commit all authorized changes;
- push `wp/0001-muse-usage-monitor`;
- verify remote branch state;
- do not wait for a separate routine "merge approved" ceremony after Engineering Manager review unless a true reserved gate is introduced.

## Stop Conditions / Human Gates

Default: none.

Stop and report only for:

- a material contradiction in VS Code behavior that prevents hidden `LanguageModelDataPart` correlation from surviving the Copilot main-agent loop;
- a requirement that would force storage of full prompts/source/tool/reasoning/response content;
- a security/privacy issue outside the authorized design;
- an external dependency/API limitation that makes the core per-task accounting materially unreliable;
- a requested Marketplace/upstream publication action.

Routine implementation choices, test repairs, UI polish, packaging, local schema design within the constraints above, and branch integration preparation are delegated to the executor.

## Risks / Cautions

- Native Copilot session identity is not available to this provider in the current API; do not mislabel the local chat ID.
- Utility/background calls may not carry the main-agent correlation marker. Prefer explicit unassigned overhead over false attribution.
- Hidden marker behavior must coexist with the existing replay-marker mechanism without changing user-visible model text.
- Usage persistence must never break or delay a successful model response.
- Prompt previews can still contain sensitive text; keep them local, capped, escaped in UI/CSV, and easy to delete.
- Pricing is an estimate from the extension's catalog and can drift from Meta billing if prices or model overrides change.
- Avoid broad newline/formatting churn on Windows.
