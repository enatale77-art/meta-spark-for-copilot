# DC-0004 — Agent Host Usage Classification

**Type:** Lightweight Direct Change (regression repair)

**Branch:** `fix/agent-host-usage-classification` (from `main` @ `0842831`, 2.2.2)

**Date:** 2026-10-01

**Target version:** 2.2.3 (first candidate installed by the user; second candidate packaged below, not installed)

**Status:** COMPLETE / ACCEPTED — Product Owner live verification passed on the installed second 2.2.3 candidate (2026-10-02); merged via PR #5.

The initial-candidate sections below are historical. The **2026-10-02 live regression investigation** at the end supersedes their assumed SDK marker round trip and records the two installed-candidate findings. Version remains 2.2.3.

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

## 2026-10-02 live regression investigation

### Scope and evidence identity

Investigated the installed first 2.2.3 candidate before making changes. Installed `out/provider/{stream,request,replay/markers}.js` and `out/usage/{recorder,status,statusSelection}.js` matched the pre-repair checkout byte-for-byte (SHA-256). VS Code is 1.140.0, commit `07f806f999227108933c2e30515b26eecc1fda74`. The existing VSIX is retained unchanged; no reinstall, new package, version increment, merge, tag, or publication is part of this repair.

Local evidence roots (read only; raw prompts, tool results, credentials, and full paths are not added to the repository):

- `%APPDATA%/Code/User/globalStorage/lukespine.meta-spark-for-copilot/request-dumps/`: seven `meta-provider-input-2026-10-02T05-48-28-320Z-0001` through `meta-provider-input-2026-10-02T05-51-11-353Z-0007` snapshots, matching resolved requests and `_request-observations.jsonl` entries.
- `%APPDATA%/Code/logs/20261001T224810/window1/exthost/LukeSpine.meta-spark-for-copilot/Meta Spark.log`: cache traces #1–#7 and marker outcomes.
- `%APPDATA%/Code/logs/20261001T224810/agenthost.log`: native SDK session creation, the single `hello` input, and tool calls/results.
- The same extension global-storage root, `usage-v1/{requests.jsonl,contexts.json,history-state.json}`: accounting, seven separate local chats/tasks, and the history cutoff.
- `test/fixtures/agent-host-seven-calls.json` retains all seven raw snapshot SHA-256 values and redacted message/part ordering. It replaces paths, session/call IDs, system text and tool contents with safe fixture values; it does not fabricate a replay marker.

### Defect A: seven requests, seven Local Chats

The first candidate fixed classification: all seven calls are `main-agent`, with `requestInitiator=core`, 380 offered tools, the same selected provider model, and non-null usage IDs. However, allocation had only a marker-based continuation path. When no marker came back, each request allocated fresh random chat/task IDs.

All times in this table are UTC on 2026-10-02. Every ledger row is `completed`, has project ID `project-0d59d8f93313448030f1b5dc19795465`, and project name `ENAX-Konnect-Testing`.

| Call | Provider snapshot time | Messages | Recorded completion | Original chatId | Original taskId |
| --- | --- | ---: | --- | --- | --- |
| 1 | 05:48:28.320 | 2 | 05:48:32.680 | 61aac33b-a863-46c5-9667-8a7462858c0d | 5d4841cd-2e95-440c-97e5-b303f97528fd |
| 2 | 05:48:32.801 | 4 | 05:48:35.239 | 7841a91c-cd7b-40a4-b151-cff3fdc1e1a8 | 029683d1-a975-4878-a6b9-4325dc7f1975 |
| 3 | 05:48:35.382 | 8 | 05:48:42.245 | 0e378d51-a4c4-44bf-9336-04a0538ac9d9 | e9dee7ee-77bf-4c32-8971-ab1ffa266664 |
| 4 | 05:48:42.909 | 10 | 05:48:59.288 | c3b19455-d72c-4b8b-9963-b8a937dcd4fc | e1a81b81-e625-479d-a7d4-83b811d556ed |
| 5 | 05:48:59.417 | 12 | 05:49:04.641 | 74f8f394-5886-4970-99ab-a5f051b7cfc0 | 29d57a96-f2c0-429f-b0b6-0b6efe32fc3a |
| 6 | 05:49:04.795 | 15 | 05:49:12.416 | aef372b8-eefa-4740-a9ef-1e79d178d01d | 218332f2-5c19-4542-898f-ad3d06d12a16 |
| 7 | 05:51:11.353 | 20 | 05:51:35.354 | e2ef5145-dee5-4e2d-a1a4-81d36c6afccb | 9926a2f9-8ef9-489e-b8f8-15195562ae86 |

**Marker emission:** each cache trace #1–#7 logs `replayMarker status=reported trigger=done markerBytes=236`, at `Meta Spark.log` lines 7, 15, 23, 31, 39, 47, and 55 respectively. None is skipped or failed. The installed emission path uses `prepared.vscodeModelId`, which is `muse-spark-1.3-contributor` in every snapshot. Ledger `vscodeModelId` and `apiModelId` are both that exact string; no effective API model override was applied. The verified installed encoder emits:

```text
muse-spark-1.3-contributor\json:<base64url-encoded JSON>
{"usage":{"version":1,"writer":"meta-spark-for-copilot","chatId":"<row chatId>","taskId":"<row taskId>"}}
```

The 236-byte payload size matches that usage-only encoding. Reconstructing all seven markers with the installed encoder and the original ledger IDs produced 236 bytes each; the installed decoder recovered both IDs correctly in every case. Full emitted marker bytes were not retained in the logs, so prefix/payload fields are reconstructed from the verified installed code plus each row's allocation, rather than presented as an independent response-wire capture.

The exact native session's `%USERPROFILE%/.copilot/session-state/9dfbd649-f026-4907-a20f-d8d02564a58b/events.jsonl` records selected model `meta/muse-spark-1.3-contributor` in `session.start`, and model `muse-spark-1.3-contributor` in subsequent assistant events. These are different identifiers: the picker key is vendor-qualified, while the installed bridge configures the SDK catalog with provider `meta`, raw model ID `muse-spark-1.3-contributor`, and proxy route `/v/meta/responses`. The Responses translator copies `body.model` into `request.modelId` without modification. That source mapping and the live assistant/provider values support the unqualified expected wire ID, matching the emitted prefix. However, the original SDK request body and bridge marker-acceptance acknowledgement were not captured: exact wire `request.modelId`/acceptance remain **source-inferred**, not independently observed. There is no affirmative evidence of a prefix mismatch, and the repair does not assume the round trip works.

**Return path:** every snapshot has zero data parts, begins with the role-3 system prompt, and has `segment.reason=markerMissing`. Each following input contains the entire earlier human and assistant/tool history. Thus `findLatestUsageMarker()` has no marker to parse; this is not a JSON/base64 parsing failure. In the installed renderer, a nonempty `previousResponseId` would unconditionally prepend a data-only assistant marker. Its absence in all six continuations establishes that this SDK path did not send a usable `previousResponseId` to the renderer.

Reviewed current Microsoft sources (2026-10-02):

- [`agentHostByokLmHandler.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostByokLmHandler.ts): `chat()` reads the response marker; `_decodeStatefulMarker()` accepts only `<request.modelId>\<responseId>` with exact prefix equality; `_toChatMessages()` prepends the pointer only when `previousResponseId` exists.
- [`byokResponsesTranslation.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/copilot/byokResponsesTranslation.ts): translates wire `previous_response_id` and `input` independently.
- [`copilotByokResponses.integrationTest.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/test/node/providerIntegration/copilotByokResponses.integrationTest.ts): the official SDK test makes a second send and asserts replay of a prior reasoning item; it does not assert `previous_response_id`. Our old `hostPointer()` fixture skipped that SDK boundary and therefore never proved real marker echo. Those checks remain as conditional pointer compatibility tests, explicitly labeled as such.

**Stable conversation signal:** all seven true system messages contain a single `<session_context>` block whose `Session folder:` ends in `.copilot/session-state/9dfbd649-f026-4907-a20f-d8d02564a58b`. The same UUID appears in `agenthost.log` when it prepares and attaches this SDK session and receives `hello`. The installed Agent Host passes this `sessionId` into `createSession()` and reuses it on resume. This is an explicit native session identifier, not a project/prompt/time similarity match. GitHub documents the [session-state directory convention](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices).

Other comparisons: all seven normalized system hashes are `f84cbd9e0f4edae0d07a14f42bea35af529a94ca243e30d58b56e5aabd5472fe`; the first human part hash is `8cbe9de34206df5dcbd4f6ce5143ec5c5df78f422866f4328ff0c4e3adb39c78`; every copy retains `<current_datetime>2026-10-01T22:48:28.182-07:00</current_datetime>`. Tool-call/result IDs reappear as paired entries in the growing history. Model options remain `max_tokens=131072`, reasoning effort `xhigh`, initiator `core`; the dumped option keys contain no separate session/conversation field. These generic options, system hash, tool population, and `hello` text are not used as chat identity.

The installed SDK prompt builder generates `current_datetime` once when constructing a new `user.message`'s `transformedContent`, then replays it through `getChatMessages()`. Consequently the timestamp is an immutable discriminator for a human turn **within the already identified native session**. It is not a request arrival time or a temporal grouping window.

### Exact correlation repair

- `src/usage/agentHostContext.ts`: accept only one true system message with the Agent Host identity prefix, one `<session_context>`, and one strictly valid session-folder UUID. Extract the latest substantive human's valid leading ISO turn timestamp. Ignore tool-only results, terminal/control messages and skill injections through the existing human-turn predicate. Missing/ambiguous fields produce no guessed match.
- Derive domain-separated deterministic UUIDs: chat from project ID plus native session UUID; task from that chat plus canonical turn stamp and its occurrence in replayed human history. A repeated identical prompt in another session cannot merge. Distinct human entries sharing a timestamp get separate tasks. Stable IDs also survive a provider/UsageService restart, without retaining full prompts or filesystem paths.
- `src/usage/recorder.ts`: use that narrow fallback only for already-classified `main-agent` requests without a valid usage marker. Existing markers retain priority, including classic Copilot Chat. Preserve the native UUID in the existing optional context metadata field; no new ledger schema or index is introduced.
- `src/usage/types.ts`: carry the optional native UUID through allocation into existing chat/task metadata. Tool virtualization, discovery, pricing and ledger totals are unchanged.

### Defect B: workspace-scoped absence presented as an empty ledger

The installed evidence does **not** show URI canonicalization drift. The visible window is `Muse Usage - Muse VS Code Extension (Workspace) - Visual Studio Code`. Its workspace file has a single `.` folder. The current window's workspaceStorage metadata and `window2/exthost/vscode.git/Git.log` identify the Muse Extension checkout. Window1's Git log identifies ENAX-Konnect-Testing. The workspace URI strings below are reconstructed from that persisted folder configuration using VS Code's URI serialization and verified against recorded project hashes; the installation did not have an extension-host API probe that independently dumped `workspaceFolders`.

| Window/project | workspaceFolders URI | deriveProjectId / recorded ID | Post-clear completed rows |
| --- | --- | --- | ---: |
| Current Muse Extension window | `file:///d%3A/Development/Muse%20VS%20Code%20Extension` | `project-2c5fb716d3260d30315108287079a0fd` | 0 |
| ENAX-Konnect-Testing window | `file:///d%3A/Development/ENAX-Konnect-Testing` | `project-0d59d8f93313448030f1b5dc19795465` | 7 |

History cutoff is exactly `1790917938220` (`2026-10-02T05:12:18.220Z`). The current project's four completed ledger rows end at `05:12:16.499Z`, 1.721 seconds before the cutoff. The distinct visible post-clear `(projectId, projectName)` set consists only of `(project-0d59d8f93313448030f1b5dc19795465, ENAX-Konnect-Testing)`. Its latest seven rows are listed above, all completed with non-null chat/task IDs.

The seven rows pass the cutoff, 30-day and completed-status checks. **The exact rejecting filter is `record.projectId === deriveProjectId(currentWorkspaceUris).projectId`.** They are from another workspace. The dashboard's Project=All intentionally includes them. Both recording (`UsageService.resolveProject()`) and status selection already call the same `deriveProjectId()` with `folder.uri.toString()`.

Repair `src/i18n.ts` in English and Chinese: `Muse: no recent workspace usage`, with tooltip explaining visible completed usage for this workspace in the last 30 days and the effect of cleared history. Preserve project isolation and existing canonicalization; do not compare display names or make status global. The observed defect is misleading empty-state wording, not missing accounting or mismatched URI encodings.

### Revised validation and residual risks

- Seven-call fixture and real-provider regression: full history, no manufactured pointer; expected rollup is one chat, one task, seven requests, zero unassigned main-agent overhead. Later human turns, their tool loops, identical prompts across distinct sessions, restart stability, missing/ambiguous signals, utility/sub-agent exclusion, marker priority and the <=128-function/discovery path are covered separately.
- Deterministic status regression uses the actual two workspace URIs through the production UsageService recording path and the shared selector, a controlled clock, the exact cutoff, and the seven captured completion timestamps. It proves the current project's pre-clear records disappear, the other project's seven rows stay isolated, ENAX selection finds its own usage, the 30-day window still applies, and the localized copy describes scope accurately.
- `npm test`: **PASS — 133 tests, 0 failures, 0 skipped** (123 retained plus 9 observed-shape integration cases and 1 deterministic status case). TypeScript clean build passes. Executed via `npm.cmd test` because this PowerShell session blocks the `npm.ps1` shim; no execution-policy changes were made.
- `npm run lint`: **PASS — 0 warnings, 0 errors**, via `npm.cmd run lint`.
- Additional read-only replay of all seven **original, unredacted snapshots**, after verifying all seven SHA-256 values: installed 2.2.3 UsageService reproduces **7 chats / 7 tasks / 7 requests**; repaired UsageService produces **1 chat / 1 task / 7 requests**, zero unassigned overhead. The repaired IDs are chat `c04879f2-09a7-8062-ab42-75528d26f2c4`, task `2436640e-fb77-81a5-86ad-6f784aa22dc6`. This replay uses in-memory stores and never changes the installed ledger.
- Read-only selection against the original live ledger confirms current Muse project `latest=null`; switching only workspace URI to ENAX selects the completed `2026-10-02T05:51:35.354Z` row. This independently reproduces the exact project-filter result.
- Corrected installed-candidate verification: **NOT RUN**. Automated replay is not a substitute for a second real installed live test. Existing seven split rows are retained as evidence; this repair does not rewrite historical ledger/chat IDs.
- Session-folder and human-timestamp fields are SDK prompt internals, not a documented VS Code provider contract. If a future SDK omits/changes them or compaction removes the latest human turn, marker-free correlation conservatively falls back to fresh allocation. It never merges solely by prompt, project, tool list or request proximity. Duplicate turn timestamps use an occurrence index; unusual compaction of duplicate-timestamp history can change that index.
- Because the live record never retained response-wire marker bytes or acceptance acknowledgements, marker emission success is distinct from bridge/SDK echo. The new observed-shape path does not depend on that round trip. Conditional pointer tests do not assert otherwise.
- Status stays workspace scoped. A global dashboard can show usage while the current workspace status is empty; the revised copy now says so.
- PR #5 must remain open. No merge/publication or version beyond 2.2.3. Automated validation alone did not establish installed live acceptance; the second candidate and its Product Owner installation gate are recorded below.

## Second Live-Test Candidate — 2026-10-02

Packaged only after refreshing `origin/main` and verifying `fix/agent-host-usage-classification` at `f97eeed72ce0e72a848f336193b6f6f9206a4c44`. At package time, current `main` was `08428315b1c4f7f06a269658f46954a12cb5dd4d`, also the merge base; the branch was four commits ahead with no main-only commits. The local and remote PR branch heads matched. The tracked worktree was clean; the unrelated local `.code-workspace` file remained untouched.

Manifest evidence before packaging: `package.json`, root `package-lock.json` and `package-lock.json` package entry were all `2.2.3`. `npm.cmd test` (including compile) passed **133/133**, zero failures/skips. `npm.cmd run lint` passed with zero warnings/errors. The `.cmd` forms invoke the requested npm scripts; this PowerShell host blocks the `npm.ps1` shim.

Fresh VSIX evidence:

- Source HEAD: `f97eeed72ce0e72a848f336193b6f6f9206a4c44`
- Filename: `meta-spark-for-copilot-2.2.3.vsix`
- Path: `dist/meta-spark-for-copilot-2.2.3.vsix`
- Size: **425,532 bytes**
- SHA-256: `009D486113BAC26B0521E77E6A0483898A122F08FD6DF1421F6288FA55C27CA6`
- Packaged file count: **85 VSIX archive entries**, matching the `vsce package` report.

Opened and checked the produced archive; package `version` is `2.2.3`. Compiled content confirms Agent Host `<session_context>`/session-folder parsing, deterministic chat/task IDs and recorder fallback; the Agent Host classifier prefix; English and Chinese workspace-scoped status copy; Restore History; `1D` and `This month`; and the existing compiled tool-search virtualization module. `npm run package` completed successfully via `npm.cmd run package` and its normal prepublish compile.

The first candidate's SHA-256 `D22C7FD4BD22FFE88736B68AD1A897EA8F35F0270748343B8AF4DAA0C616F2FF` is obsolete. The newly packaged bytes hash to the different SHA-256 above. No install was performed. The fresh VSIX is ready for Product Owner installation and live verification; PR #5 remains open and unmerged, and nothing was published.

## Final Live Verification — ACCEPTED 2026-10-02

**Date:** 2026-10-02 (Product Owner report; Engineering Manager acceptance to close PR #5).

**Installed candidate:** 2.2.3, second live-test candidate (`dist/meta-spark-for-copilot-2.2.3.vsix`, SHA-256 `009D486113BAC26B0521E77E6A0483898A122F08FD6DF1421F6288FA55C27CA6`, packaged from source HEAD `f97eeed72ce0e72a848f336193b6f6f9206a4c44` plus the docs-only candidate record `86d254d`). No new version bump; earlier ledger rows from the failed candidates are retained unchanged.

**Acceptance:** Product Owner completed the required real installed live verification and reports everything appears to be working correctly. No remaining blocking issue in the live test.

**Live behaviors verified:**

- Agent Host requests no longer land entirely in Unassigned overhead.
- One native Agent Host conversation now remains one Local Chat instead of splitting each provider call into a separate chat.
- Multiple human prompts in the same native chat create separate Tasks under the same Local Chat.
- Tool-loop/provider continuation stays associated with the active task.
- The >128-tool Muse/Copilot fix remains operational in real use.
- Usage dashboard/history features continue to work.
- Workspace-scoped status behavior is now understood/correctly communicated.

**Residual risks (non-blocking):** the standing notes above still apply — session-folder/human-timestamp fields are SDK prompt internals (fallback is fresh allocation, never merging by prompt/project/tool list/proximity); marker emission success is distinct from bridge/SDK echo and the repaired path does not depend on that round trip; status stays workspace scoped by design.
