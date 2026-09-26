# DC-0001 — Chat-First Muse Usage Dashboard

**Type:** Lightweight Direct Change  
**Branch:** `ui/chat-first-usage-dashboard`  
**Date:** 2026-09-25  
**Target version:** 2.2.1  
**Status:** READY FOR EXECUTION

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
