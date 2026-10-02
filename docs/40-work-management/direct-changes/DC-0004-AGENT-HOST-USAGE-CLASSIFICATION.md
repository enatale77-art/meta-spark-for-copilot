# DC-0004 — Agent Host Usage Classification

**Type:** Lightweight Direct Change (regression repair)  
**Branch:** `fix/agent-host-usage-classification` (from `main` @ `0842831`, 2.2.2)  
**Date:** 2026-10-01  
**Target version:** 2.2.3 (local test candidate built; not installed or published)  
**Status:** 2.2.3 TEST CANDIDATE PACKAGED — AWAITING LIVE VERIFICATION

## Symptom

On 2.2.2 the Agent Host (Copilot SDK) works, including >128-tool virtualization, and usage totals are recorded, but the Usage dashboard shows **Local chats: 0** and every request under **Unassigned Copilot overhead**.

## Root cause

`classifyProviderRequest()` recognized the main agent from the legacy Copilot Chat system-prompt prefix (`You are an expert AI programming assistant`), `<skills>`, or `<agents>`. The Agent Host system prompt begins `You are an AI assistant using Copilot SDK in VS Code.`, so every Agent Host request fell through to `background`.

That one misclassification disables the whole correlation chain:

1. `allocateUsageContext()` only creates chat/task IDs for `main-agent`; a `background` request with no marker becomes unassigned.
2. `resolveUsageCorrelation()` (`src/provider/index.ts`) emits correlation only for `main-agent`, so no usage marker is written.
3. With no marker in history, no later turn can inherit a chat/task.

Evidence from the local install (structure only, no conversation content):

- All 29 captured Agent Host provider-input dumps (3 conversations) were logged `requestKind=background`. Every one has a role-3 system prompt starting with the identity line above, `requestInitiator: "core"`, and 341–380 tools.
- The ledger held 70 records, all `background | chatId=null | taskId=null`.
- Every replay-marker report was `skipped reason=no-replay-data`; no history message contained a data part, so no `previousResponseId` was ever sent back.

## Further defects found while tracing the repaired path

Fixing the prefix alone would have made the first turn correct and later turns wrong. Items 2 and 3 are covered by tests that fail when only `src/usage/context.ts` is reverted; item 1 by the pointer classification test, which fails on the original source.

1. **Leading pointer hides the system prompt.** When the host has a response id, `AgentHostByokLmHandler._toChatMessages` (VS Code 1.140 `workbench.desktop.main.js`) *prepends* an assistant message containing only `stateful_marker` = `${modelId}\${previousResponseId}` **before** the system prompt. The classifier read `messages[0]`, which is that data-only message, so the request was `background` again on every continuation.
2. **Marker position treated as history position.** `hasNewSubstantiveTurnAfterMarker` counted any human turn *after the marker*. With the pointer at index 0, every earlier human prompt is "after" it, so a plain tool-loop continuation would have started a new task (when the host replays full history).
3. **`<skill-context …>` messages.** The host injects these as text-only user messages mid-history (14 in the captured dumps). They were treated as human turns and would have started spurious tasks.

## Repair

`src/provider/routing/classifier.ts`

- New `AGENT_HOST_MAIN_AGENT_PREFIX = 'You are an AI assistant using Copilot SDK'`; `main-agent` if the identifying prompt starts with it. Only the stable identity lead-in is matched, not the full prompt.
- The identifying prompt is now the **first message that has text** (was `messages[0]`), for both VS Code and Meta message shapes. This is identical to the old behaviour whenever `messages[0]` has text.
- Signals considered and deliberately **not** used to create `main-agent`: `requestInitiator` (`"core"` in every captured request, so it cannot separate main from sub-agent/utility), tool population (utility calls also carry tools), and the `<current_datetime>` user preamble (present on every human turn). Utility prefixes and `terminal-steering` are still evaluated first, so they stay non-main even under the Agent Host prompt.

`src/usage/context.ts`

- `<skill-context …>` (anchored at message start) is a control update, never a human turn.
- When the latest marker is the leading `previousResponseId` pointer (message index 0), a turn is new only if the latest substantive human message has no assistant message after it. Correct for both full-history and delta-input hosts. Classic in-history markers use the existing rule unchanged.

No change to: tool virtualization, request conversion, marker format, pricing, storage, or dashboard.

## Validation

- `npm test`: **123 / 123 pass** (98 existing + 21 in the new `test/agent-host-usage.integration.test.cjs` + 4 new unit tests in `test/usage.test.cjs`).
- `npm run lint`: 0 warnings, 0 errors.
- `format:check` fails on 65 files identically on untouched `main` (pre-existing drift; not changed here).
- **New end-to-end test** drives the real `MetaChatProvider` with the real classifier, a real `UsageService` over the in-memory store, and real marker emission against a loopback Meta endpoint, using the captured Agent Host shape (379 tools, role-3 system prompt, `<current_datetime>` human turns, `previousResponseId` pointer built exactly as the host builds it). It proves, in order:
  1. first human request → `main-agent`;
  2. non-null chat and task IDs;
  3. the recorded usage row carries both;
  4. the emitted `stateful_marker` carries matching usage correlation, prefixed with the VS Code model id;
  5. tool-result continuation inherits the task (full history + pointer, delta + pointer, with an injected `<skill-context>`, and classic in-history marker);
  6. a later substantive prompt creates a new task under the same chat (full history and delta);
  7. the dashboard rollup shows 1 Local Chat / 3 tasks / 8 requests, and only the 4 utility/background fixtures are overhead;
  8. chat-title, todo-tracker, git-commit-message, and an Agent-Host-style sub-agent with tools stay non-main, get null IDs, create no chat/task and emit no usage correlation (plus prompt-categorizer, terminal-steering, and an unknown helper prompt at classification level);
  9. 379 tools still virtualize: every outbound request ≤ 128 functions, loader hidden, one discovery round, usage summed once (2000 prompt tokens), same `[tool-virtualization]` log lines.
- **Fails on the original source** (12 of 21 fail, including the exact production symptom). Reverting only `context.ts` fails the full-history continuation, `<skill-context>`, later-prompt, and rollup tests, so each secondary fix is independently covered.

## Live verification (required before release)

Not done here: needs a real Agent Host session with the installed build.

1. New Agent Host chat, one prompt that uses tools: Local chats ≥ 1, no `main-agent` rows under Unassigned.
2. Send a second prompt in the same chat: same chat, **new** task. Tool-loop steps within a prompt: same task.
3. **Key unverified link:** the SDK must echo the returned response id back as `previous_response_id`. Before this fix no marker was ever emitted, so this has never been exercised live. If it is not echoed, history carries no marker and each request would allocate a new chat. Check with the ledger: distinct `chatId` count vs. `main-agent` request count, and a provider-input dump whose first message is an assistant message with one `stateful_marker` data part.
4. Sub-agent (`task` tool) and title/utility calls should stay unassigned overhead and must not create chats.

## Residual risks

- If a future SDK rewords its identity line, the repair degrades back to unassigned (never to fake chats). The classifier is the single place to update.
- Agent Host sub-agent calls run under a different system prompt and, having no marker, remain unassigned overhead rather than being attributed to the parent task.

## Test Candidate Packaging — 2026-10-01

Local live-test candidate only. PR #5 is not merged; nothing is installed or published to Marketplace/Open VSX.

- Version `2.2.3` in `package.json` and both root version fields of `package-lock.json`; no dependency versions changed. `CHANGELOG.md` `Unreleased` section renamed to `2.2.3`.
- Source commit packaged: `caeea7b906d670f7dd896fc28d4a3afbcccde3d4` (`chore(release): bump to 2.2.3 test candidate`), clean working tree apart from the untracked local `.code-workspace` file. Later commits on this branch are documentation only.
- `npm test`: 123 / 123 pass. `npm run lint` (oxlint): 0 warnings, 0 errors.
- `npm run package`: `dist/meta-spark-for-copilot-2.2.3.vsix`, 84 files, 423,289 bytes (413.37 KB).
- VSIX SHA-256: `D22C7FD4BD22FFE88736B68AD1A897EA8F35F0270748343B8AF4DAA0C616F2FF`
- Verified inside the VSIX: `package.json` version 2.2.3; Agent Host identity prefix in `out/provider/routing/classifier.js`; `<skill-context>` pattern and `hasUnansweredHumanTurn` in `out/usage/context.js`; `out/provider/tools/virtual.js` present; changelog top section `2.2.3`; no `src/`, `test/`, `docs/`, `.ts`, or source-map files.
- `dist/` is gitignored, so the VSIX is not committed.
- Live verification checklist: see "Live verification (required before release)" above.
