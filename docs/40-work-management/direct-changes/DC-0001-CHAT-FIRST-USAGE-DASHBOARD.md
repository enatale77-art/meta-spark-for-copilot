# DC-0001 — Chat-First Muse Usage Dashboard

**Type:** Lightweight Direct Change  
**Branch:** `ui/chat-first-usage-dashboard`  
**Date:** 2026-09-25  
**Target version:** 2.2.1  
**Status:** COMPLETE - PENDING REVIEW
## Intent

The Muse Usage dashboard currently shows Tasks and Local Chats as separate top-level sections. When a Local Chat contains only one Task, both cards show nearly identical metrics and feel redundant.

Make **Local Chat the single primary unit in the default dashboard**. Tasks should only appear after the user opens a Local Chat.

The hierarchy must read naturally as:

`Project → Local Chat → Task → Request`

## Required UX

### Default dashboard

Keep:
- Period / Project / Model / Search filters
- Apply / Refresh / Export CSV / Clear history
- top summary cards
- Unassigned Copilot overhead summary

Replace the current separate top-level **Tasks** and **Local chats** sections with a single top-level **Local chats** section.

Each collapsed Local Chat card should show:
- Local subject as the dominant title
- project/workspace name
- task count
- request count
- compact input tokens
- cache-hit percentage
- compact output tokens
- estimated cost

Do not show any Task cards in the default view.

### Expanded Local Chat

Clicking a Local Chat card expands its detail and reveals:
- Local subject
- project/workspace
- task count
- request count
- aggregate input / cached / uncached / output / reasoning / cost
- start and last activity
- Local Chat ID only in the expanded diagnostic area
- the list/grid of Tasks belonging to that Local Chat

The chat-level subject and aggregate metrics must remain visually distinct from the child Task cards.

### Tasks inside a chat

Task cards appear **only inside the expanded Local Chat**.

Each collapsed Task card should show:
- cleaned human task preview
- request count
- input
- cache-hit %
- output
- estimated cost

Clicking a Task card reveals the existing task diagnostic detail:
- Task ID / Local Chat ID copy controls
- timestamps
- full token metrics
- request-kind breakdown
- individual request timeline
- model / reasoning information where already available

The selected Task detail should render in the context of the selected Local Chat, not as a separate top-level section.

### Interaction rules

- Opening another Local Chat should clear any Task selection from the previously opened chat.
- Collapsing a Local Chat should also collapse/clear its selected Task.
- Live local updates and cross-window synchronization must preserve the currently selected filters and currently expanded Local Chat / Task when those objects still exist.
- No page-level horizontal scrolling in the normal dashboard.
- Expanded request tables may scroll locally.
- Search/filter behavior must continue to work.
- CSV export and storage behavior are unchanged.
- No change to Request → Task → Local Chat correlation, pricing, persistence, or privacy rules.

## Acceptance criteria

1. With one chat containing one task, the default dashboard shows **one Local Chat card**, not a duplicate Task card.
2. With one chat containing three tasks, the default dashboard still shows one Local Chat card with `3 tasks`; the three Tasks appear only after opening that chat.
3. Clicking a Task inside the opened chat reveals request-level diagnostics.
4. Switching to another Local Chat clears stale Task detail from the previous chat.
5. Project / Model / Period filters remain selected through live updates.
6. Second-window auto-sync remains functional.
7. Existing usage aggregation totals remain unchanged.
8. `npm test`, compile, lint, relevant formatter checks, and package build pass.
9. Bump package version from 2.2.0 to **2.2.1**, update changelog/readme text as needed, and build `dist/meta-spark-for-copilot-2.2.1.vsix`.
10. Do not publish to Marketplace/Open VSX.

## Execution / closeout

Use the repository's lightweight Direct Change lane. Commit and push all work on this branch. Return a concise completion summary with:
- changed files
- tests/checks
- package path
- VSIX SHA256
- any residual caveats


## Engineering Manager Review 01 — 2026-09-25

**Disposition:** CHANGES REQUIRED — the chat-first layout is implemented correctly at source level, but one interaction defect prevents Task drill-down after a Local Chat is opened, and release metadata is incomplete.

### DC-R1 — Rehydrate webview selection state after every HTML render

**Current issue:** the webview event handlers use `window.__selectedChat`, `window.__selectedTask`, and `window.__overheadExpanded`, but a full `webview.html` replacement creates a new document and those variables are not initialized from the server-rendered state.

Live interaction consequence:

1. User clicks a Local Chat card.
2. Host renders the expanded Local Chat and replaces `webview.html`.
3. The new document starts with `window.__selectedChat === undefined` even though the server view state still has the chat selected.
4. User clicks a nested Task card.
5. The Task handler posts `selectedTaskId` but `selectedChatId: null`.
6. `sanitizeDashboardSelection()` correctly rejects a Task without its parent chat, so the chat collapses instead of opening Task detail.

The same missing hydration can make an already-expanded overhead card toggle incorrectly after a refresh.

**Required correction:**
- emit/init the client-side selection variables from the effective server-rendered state on every render:
  - selected Local Chat ID;
  - selected Task ID;
  - overhead expanded state;
- JSON-encode/escape values safely; do not interpolate untrusted text into executable JS;
- after opening a Local Chat, clicking one of its Tasks must keep that chat selected and open the Task detail;
- after a live/cross-window refresh, the next user click must behave consistently with what is visibly expanded;
- add deterministic/source-level coverage for the hydration contract and, if practical, a small interaction test seam.

### DC-R2 — Keep release metadata and closeout evidence internally consistent

**Current issue:** `package.json` is `2.2.1`, but `package-lock.json` still declares `2.2.0` at both the lockfile root and root-package entry. The Direct Change record also remains at execution status and does not contain the requested package/check/hash completion evidence.

**Required correction:**
- update the top-level and root-package `package-lock.json` version fields to `2.2.1` without changing dependency versions;
- after the interaction repair, rerun tests/compile/lint/relevant format/package;
- rebuild `dist/meta-spark-for-copilot-2.2.1.vsix`;
- append a Direct Change completion section with test/check results, VSIX path, SHA256, changed files, and residual caveats;
- set this record to `COMPLETE - PENDING REVIEW`;
- keep PR #2 as draft until Engineering Manager source review passes.

No change is requested to the chat-first hierarchy itself. The default-view design (one Local Chat card, Tasks nested only after expansion) is accepted.

## Completion — 2026-09-25 (Review Repair)

Both findings are repaired on `ui/chat-first-usage-dashboard`; PR #2 stays draft pending Engineering Manager source review.

### DC-R1 — Webview selection rehydration

- `src/usage/dashboard.ts` adds `encodeWebviewSelection()` / `applyHydratedSelection()` (pure, unit-tested). Every render emits `window.__hydrated=<JSON>` built from the effective sanitized server selection plus `overheadExpanded`, then initializes `window.__selectedChat`, `window.__selectedTask`, and `window.__overheadExpanded` from it — so the next click after any `webview.html` replacement posts IDs consistent with what is visibly expanded.
- The encoder JSON-serializes and additionally escapes `<`, `>`, `&`, U+2028, U+2029 (all valid JSON string escapes; `JSON.parse` reverses them), so hostile IDs cannot emit a literal `</script>` — a determinism test caught and pinned this (`JSON.stringify` alone does not escape `</script>`).
- Post-repair interaction: opening a Local Chat then clicking a nested Task keeps the chat selected and opens Task detail through the existing `sanitizeDashboardSelection()` path; overhead toggle state survives refresh.

### DC-R2 — Release metadata and closeout evidence

- `package-lock.json` root and root-package `version` fields updated `2.2.0` → `2.2.1`; no dependency versions changed (`npm install` not rerun, so no lockfile churn).
- This record set to `COMPLETE - PENDING REVIEW`.

### Checks (post-repair, 2026-09-25)

- `npm test`: 51 pass, 0 fail (48 prior + 3 new DC-R1 hydration tests)
- `npm run compile` (`tsc`): pass
- `npm run lint` (`oxlint`): 0 warnings, 0 errors
- `npm run format:check`: pre-existing failures (51 files incl. untouched files on clean tree); no new formatting introduced — repair code follows the repo's tab style
- `npm run package`: `dist/meta-spark-for-copilot-2.2.1.vsix` (83 files, 409,330 bytes)
- VSIX SHA256: `124646E86349A71FEB5F4907BBEE6A42CDC1ED044F38747487A0278C25BF5265`

### Changed files (this repair)

- `src/usage/dashboard.ts` — hydration helpers + inline `window.__hydrated` init
- `test/usage.test.cjs` — 3 DC-R1 tests (round-trip, no-raw-interpolation, every-render-hydrates)
- `package-lock.json` — version fields 2.2.1
- `docs/40-work-management/direct-changes/DC-0001-CHAT-FIRST-USAGE-DASHBOARD.md` — completion section + status

### Residual caveats

- No live-webview click-through performed (headless environment); hydration verified via deterministic unit + source-level contract tests.
- `format:check` debt is pre-existing and untouched by this change.
- Not published to Marketplace/Open VSX.
