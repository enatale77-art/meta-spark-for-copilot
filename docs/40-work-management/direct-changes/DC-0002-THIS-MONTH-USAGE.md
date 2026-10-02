# DC-0002 — Billing-aligned Usage Periods and Persistent Accounting

## Intent
Align the Muse Usage dashboard with billing and make usage accounting durable.

## Scope
- Add a **1D** rolling 24-hour period.
- Add a **This month** calendar month-to-date period using local midnight on the first day of the current month.
- Preserve existing 7d / 30d / 90d / all options.
- Keep the append-only usage ledger and context metadata persistent through **Clear history**.
- Redefine **Clear history** as a UI visibility cutoff: old Local Chat/task/overhead detail is hidden, but summary totals continue to use the retained ledger.
- Store the visibility cutoff in `usage-v1/history-state.json`.
- Keep all three files under VS Code `globalStorageUri`, so normal extension upgrades under the same extension identity retain them.
- Include the visibility marker in the cross-window change signature so clearing history synchronizes across open VS Code windows.
- Add deterministic coverage for month-to-date filtering and retained accounting.

## Persistence contract
The extension-owned usage data lives under `<globalStorageUri>/usage-v1/`:

- `requests.jsonl` — append-only accounting ledger.
- `contexts.json` — Local Chat / task metadata.
- `history-state.json` — visible-history cutoff only.

**Clear history never deletes `requests.jsonl` or `contexts.json`.** It only advances `history-state.json`.

Normal extension updates preserve `globalStorageUri` for the same extension identity, so retained accounting survives upgrades. Uninstall/reinstall or changing the extension identity is outside this guarantee.

## Non-goals
- No pricing/cost formula change.
- No automatic pruning or retention limit.
- No cloud backup.
