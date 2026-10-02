# DC-0002 — Billing-aligned Usage Periods and Persistent Accounting

**Type:** Lightweight Direct Change  
**Branch:** `ui/this-month-usage`  
**PR:** #3  
**Status:** IN REVIEW

## Intent
Align the Muse Usage dashboard with billing and make usage accounting durable.

## Scope
- Add a **1D** rolling 24-hour period.
- Add a **This month** calendar month-to-date period using local midnight on the first day of the current month.
- Preserve existing 7d / 30d / 90d / all options.
- Keep the append-only usage ledger and context metadata persistent through **Clear history**.
- Redefine **Clear history** as a UI visibility cutoff: old Local Chat/task/overhead detail is hidden, but summary totals continue to use the retained ledger.
- Add **Restore history**, which resets the visibility cutoff so all hidden history is shown again.
- Store the visibility cutoff in `usage-v1/history-state.json`.
- Keep all three files under VS Code `globalStorageUri`, so normal extension upgrades under the same extension identity retain them.
- Include the visibility marker in the cross-window change signature so clearing and restoring history synchronize across open VS Code windows.
- Add deterministic coverage for period filtering, retained accounting, and Clear/Restore semantics.

## Period filters
| Option | Meaning |
|---|---|
| `1D` | Rolling 24 hours (`now − 24h` inclusive), not the calendar day |
| `7d` / `30d` / `90d` | Rolling 7 / 30 / 90 days |
| `This month` | Local calendar month-to-date from local midnight on the 1st |
| `all` | Every retained record |

Period, project, model, and search filters apply equally to the summary cards and the visible chat/task/overhead detail.

## Persistence contract
The extension-owned usage data lives under `<globalStorageUri>/usage-v1/`:

- `requests.jsonl` — append-only accounting ledger.
- `contexts.json` — Local Chat / task metadata.
- `history-state.json` — visible-history cutoff only (`{ "version": 1, "hiddenBeforeMs": <epoch ms> }`; records at or before the cutoff are hidden, `0` hides nothing).

**Clear history and Restore history never delete, rewrite, copy, or rebuild `requests.jsonl` or `contexts.json`.** They only replace `history-state.json` atomically (temp file + rename).

Normal extension updates preserve `globalStorageUri` for the same extension identity, so retained accounting and the cutoff survive restarts and upgrades. Uninstall/reinstall or changing the extension identity is outside this guarantee.

## History visibility semantics
The store exposes an explicit visibility API: `readHistoryCutoff()` / `writeHistoryCutoff(cutoffMs)`. Clear and Restore are thin helpers over it (`clearVisibleHistory`, `restoreVisibleHistory` in `src/usage/storage.ts`).

- **Clear history** (dashboard button or `Meta Spark: Clear Usage History`): confirmation-gated. Advances the cutoff to now. The cutoff never moves backwards.
- **Restore history** (dashboard button or `Meta Spark: Restore Usage History`): no confirmation (non-destructive). Resets the cutoff to `0` and shows a success notification. Idempotent: if nothing is hidden, the marker is left untouched and an "already visible" notification is shown.
- **Summary totals** always aggregate the full retained ledger for the selected filters.
- **Local Chat / task / request / overhead detail** shows only records after the cutoff.
- **Status bar** only considers records after the cutoff. After Restore, the acting window refreshes it immediately, so the latest historical task can appear again. Other windows pick it up on their 30-second status-bar refresh.
- **Cross-window sync:** `history-state.json` is part of the change signature. Every open dashboard re-renders (preserving filters and selection) on its next poll after Clear or Restore.

## Review repairs (Restore History pass)
- Replaced the operation-style `UsageStore.clearHistory(ms)` with the explicit `writeHistoryCutoff` setter, so Restore is a reset of the cutoff and not a special-case deletion.
- Removed `UsageService.clearAll()` and its contexts-cache invalidation (contexts are no longer touched), the dashboard `setOnCleared` hook that replaced the store operation, and the state-resetting `UsageDashboard.refresh()`. Dashboard buttons and Command Palette commands now share one implementation.
- Dashboard refresh reads the change signature *before* the data, and a refresh requested while another render is in flight is queued instead of dropped. A Clear/Restore (local or from another window) that lands mid-render is therefore always rendered.
- History-state writes share the atomic replace helper with `contexts.json`. Temp names include a random suffix on both FS backends, and stale `history-state.json.*.tmp` files are cleaned up.
- Replaced source-text assertions with behavioral tests (`partitionDashboardRecords`, `filterByPeriod`, `filterVisibleHistory`, real-filesystem Clear/Restore).

## Dashboard polish
- Form controls inherit the VS Code UI font and size. Webview buttons, selects, and inputs otherwise fall back to the platform font, which caused the mismatched fonts.
- The header row holds the title and actions (Refresh, Export CSV, Clear history, Restore history). Filters sit in a bar with captions above each control.
- Secondary buttons get a theme-derived border so they stay visible in themes with transparent secondary button backgrounds. Copy buttons are compact outlined chips.
- Summary cards use caption labels and tabular numerals. Section headings show count badges. The cleared-history notice is an info banner.
- Chat and task details use label/value stat grids. Request-kind and request tables share one helper and right-align numeric columns. Request times use local time, with the ISO timestamp in the tooltip.
- Element IDs, `data-*` hooks, hydration, and all i18n keys are unchanged. Verified by rendering the compiled dashboard against Dark Modern theme variables at full and narrow widths.

## Validation
- `npm test` (TypeScript compile + `test/usage.test.cjs`): 64/64 pass.
- `npm run lint` (oxlint): 0 warnings, 0 errors.
- `oxfmt --check` on every `src/` file changed by DC-0002: clean. Pre-existing `origin/main` formatting drift in unrelated files is unchanged.

Deterministic coverage includes:
- Clear preserves ledger records and contexts (memory store and byte-identical files on disk).
- Pre-cutoff chat/task/overhead detail is hidden (including same-millisecond records), while accounting totals still include pre-cutoff records.
- Restore resets the cutoff, leaves ledger and contexts byte-identical, and makes all retained detail visible again.
- Restore is idempotent and creates no files when history was never cleared.
- Cutoff persists across a fresh store instance (restart/update) and is observed by a second store instance via the change signature (cross-window).
- A failed atomic replace keeps the previous cutoff and leaves no temp file.
- Status bar hides the pre-clear task and shows it again after Restore.
- 1D rolling-24h boundary, 7d/30d/90d/This month/all routing, and the local calendar-month boundary.

## Non-goals
- No pricing/cost formula change.
- No automatic pruning or retention limit.
- No cloud backup.
