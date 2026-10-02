# DC-0002 — This Month Usage Period

## Intent
Add a **This month** period to the Muse Usage dashboard so usage can be viewed on the same calendar-month basis as Muse billing.

## Scope
- Add a `month` dashboard period.
- Filter month-to-date from local midnight on the first day of the current month.
- Preserve existing rolling 7d / 30d / 90d / all options.
- Add English and Simplified Chinese labels.
- Add deterministic coverage for the local calendar-month boundary.

## Persistence finding
Usage history is stored under VS Code extension global storage in `usage-v1/requests.jsonl` and `usage-v1/contexts.json`.

The current **Clear history** action deletes those two files directly. There is no separate archive in the extension, so clearing history removes the extension's retained source data and will make month-to-date totals incomplete for the cleared portion of the month.

## Non-goals
- No change to clear-history behavior.
- No backup/archive policy change.
- No pricing/cost logic change.
