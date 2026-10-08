# DC-0005 — Responses API Reasoning Replay

**Type:** Lightweight Direct Change (defect repair)

**Branch:** `fix/responses-api-reasoning-replay` (from `main` @ `a75d42f`, 2.2.3)

**Date:** 2026-10-08

**Target version:** next release (no version bump yet; no candidate packaged)

**Status:** IMPLEMENTED — automated validation passed; Product Owner live verification pending.

## Symptom

On long Copilot agent tasks Muse loops: each step emits a one-line status message ("I've confirmed the normal start route — now I'll check the current runtime state", "Your restart request is clear — I'm verifying the blockers…") and another read-only tool call, re-deriving the same conclusions instead of acting. First suspected to be MCP-specific, it reproduced on a simple "restart the app" task with no MCP calls (`Evidence/muse_loop.md`).

## Root cause

Muse Spark always reasons privately before answering. The extension called Meta's **Chat Completions** endpoint, which (per Meta's [reasoning](https://dev.meta.ai/docs/reasoning) and [Responses API](https://dev.meta.ai/docs/protocols/responses) docs) redacts `reasoning_content` to empty for external callers and does not carry reasoning between requests. Every step of a tool loop is a separate request, so every step reasoned from scratch with only its own terse status lines as memory. This was already noted as a known limitation in `docs/meta-spark-port-plan.md`; the Responses API was deferred as "phase 2".

Evidence from the captured session (local only, structure and counts; no prompt content added here):

- `Meta Spark.log` (`%APPDATA%/Code/logs/20261007T175828/window1/exthost/LukeSpine.meta-spark-for-copilot/`), cache traces #1–#28: `stream done reasoningTextChars=0` on all 28 requests; `toolReasoning(... nonEmpty=0, empty=N)` for every prior assistant turn.
- Completion tokens up to 2,129 per step against one sentence plus one tool call of visible output, so ~1.5–2K tokens of reasoning per step were produced and discarded.
- Request dump for request #28 (66 messages, `muse-spark-1.3-contributor`, `reasoning_effort=xhigh`): all 27 prior assistant messages sent with `reasoning_content: ""`.
- Each turn re-decided authorization and re-found the same blockers, which matches the model having no access to its earlier reasoning.

Contributing factor that shapes the repair: the Agent Host (Copilot SDK) strips provider data parts and thinking parts from history. All 28 provider inputs have `segment.reason=markerMissing` and no data parts, consistent with DC-0004. Reasoning therefore cannot travel through `stateful_marker`. Tool-call IDs do survive in every host.

Not the cause: tool virtualization. 128 functions were sent, and no `meta_spark_load_tools` call occurred in the session.

## Repair

Transport (`src/client/responses.ts`, `src/client/core.ts`):

- When the protocol is `responses`, `MetaClient` posts to `/responses` with `store: false`, `stream: true`, `include: ["reasoning.encrypted_content"]`, `reasoning: { effort, summary: "auto" (main agent only) }`, `max_output_tokens`, `prompt_cache_key`, and flat function tools with `tool_choice: "auto"`. `previous_response_id` is never sent; Meta rejects it combined with encrypted replay.
- The provider still builds the Chat Completions-shaped `MetaRequest` internally, so dumps, diagnostics, classification, vision and tool virtualization are unchanged. The translator converts it to typed input items while enforcing Meta's structure rules (HTTP 400 otherwise):
  - assistant text followed by tool calls is sent as `phase: "commentary"`; final answers have no phase;
  - `reasoning` items are placed before the assistant message or `function_call` they belong to and never left unanchored; duplicate reasoning IDs are dropped;
  - every `function_call_output` matches a `function_call`: orphan outputs become user text, calls without outputs get a placeholder output, and call IDs outside 1–64 characters map to a stable short hash on both sides.
- Responses stream events map onto the existing callbacks: `output_text.delta` → content, `reasoning_summary_text.delta` → thinking, streamed `function_call` items → tool calls, `reasoning` items with `encrypted_content` → a new `onReasoningItem` callback, terminal `usage` → the existing `MetaUsage` shape. `response.failed` / `error` events become user-facing errors; `response.incomplete` is logged.
- If Meta returns HTTP 400 mentioning reasoning/encrypted content (for example an expired item) on a request that replayed reasoning, the request is retried once without replay. Other 400s are not retried.

Reasoning store (`src/provider/reasoning/`):

- `ReasoningReplayStore` keeps each response's encrypted reasoning items keyed by the tool-call IDs that response emitted to the host, bound to the API model ID. On the next request, assistant tool-call turns are matched by call ID and their items re-attached. Persisted to `<globalStorageUri>/reasoning-replay-v1.json` (atomic write, debounced), 7-day expiry, 400-entry cap. Only encrypted content, IDs, model and timestamp are stored; readable summaries are stripped before storage.
- Tool-discovery rounds (>128 tools) replay their reasoning inside the internal continuation, and all rounds' items are stored under the final host-visible calls.

Configuration (`package.json`, `src/config.ts`, NLS en/zh-cn): new `meta-spark-copilot.apiProtocol` = `auto` (default) | `responses` | `chatCompletions`. `auto` uses Responses on `api.meta.ai` and Chat Completions on custom base URLs, which may be proxies without `/responses`.

Diagnostics: one `[reasoning-replay] protocol=responses toolTurns=… replayedTurns=… replayedItems=… storedItems=… storedForCalls=…` info line per Responses request. Reasoning content is never logged.

No change to: usage correlation/classification, pricing, dashboard, marker format, tool virtualization planning.

## Validation

- `npm test`: **151 / 151 pass** (133 existing + 18 new in `test/responses.test.cjs`). Existing Chat Completions loopback tests still pass unchanged, because `auto` keeps Chat Completions on a loopback base URL.
- `npm run lint`: 0 warnings, 0 errors.
- New tests cover: exact Responses input for a tool turn (reasoning → commentary → call → output); final answers without phase; flat tools and default schema; omit/dedupe/anchoring of reasoning; pairing repair and call ID normalization; images as `input_image`; stream mapping of summaries, streamed arguments, reasoning items, usage, incomplete and failed responses; store lookup by any call ID, model binding, persistence, expiry, corrupt file.
- Loopback provider integration with the real `MetaChatProvider` and an Agent Host-shaped history **with no data or thinking parts**: step 2 replays step 1's encrypted reasoning before its commentary and call; a restarted provider replays the whole loop from disk; readable summaries are absent from the persisted file; one retry without replay on a reasoning rejection, none on unrelated 400s; 379-tool virtualization stays ≤128 functions, the loader stays hidden, the discovery round's reasoning precedes the loader call in round 2, and both rounds replay on the next host step; `chatCompletions` still routes to `/chat/completions`.
- Read-only replay of the translator over all **192 captured real request dumps** (177 with tool loops, Agent Host and classic): 0 orphan outputs, 0 missing commentary phases, and no pairing repair needed.

## Live verification (required before release)

Not done here: needs a real Meta API key and an installed build.

1. Agent Host chat on the official endpoint, multi-step tool task (for example the ECI restart): `Meta Spark.log` shows `[reasoning-replay] ... replayedTurns` equal to `toolTurns` after the first step, and `storedItems > 0`.
2. The agent progresses instead of re-verifying; thinking summaries appear in agent mode.
3. No HTTP 400 for structure (`phase`, `call_id`, reasoning ordering). If any appear, capture the `serverMessage` from the log.
4. Usage dashboard still records input, cached, output and reasoning tokens.
5. Reload VS Code mid-task, continue: replay still reported (persisted store).
6. Classic Copilot agent: same checks.
7. Fallback: `apiProtocol: chatCompletions` restores the old behavior.

## Residual risks

- The Responses wire format is implemented from Meta's public docs and tested against a loopback fake, not the live API. Live verification is the gate.
- Reasoning is replayed only where the store has it: chats from before this change, another machine, or history rewritten by Copilot compaction run without it (the old behavior, never worse).
- The retry-without-replay heuristic matches `reasoning|encrypted` in a 400 body. A structure error that happens to mention reasoning would be retried once without replay and would then fail normally.
- Custom base URLs stay on Chat Completions under `auto`; proxies that implement `/responses` need `apiProtocol: responses`.
