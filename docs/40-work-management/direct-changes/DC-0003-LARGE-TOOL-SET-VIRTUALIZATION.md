# DC-0003 — Provider-side Tool Virtualization for Large Tool Sets

**Type:** Lightweight Direct Change (compatibility repair)  
**Branch:** `fix/large-tool-sets` (from `main` @ `88180ff`)  
**PR:** #4  
**Date:** 2026-10-01  
**Target version:** 2.2.2  
**Status:** COMPLETE - INTEGRATED WITH PR #3 FOR 2.2.2

## Intent

Muse Spark fails in current VS Code / Copilot sessions with:

```
Failed to get response from the AI model; retried 5 times ... Last error:
502 Meta supports at most 128 functions per tools request, got 379. Disable unused tools via Configure Tools.
```

Disabling MCP servers, reloading the window, and restarting VS Code do not help. Repair the extension so large tool environments (Konnect, ELI, ECI, FreeCAD MCP, built-in Copilot tools, extension tools) work without truncating tools or requiring the user to disable them, while every outbound Meta request stays at or below 128 function definitions.

## Diagnosis

### Evidence (local install: VS Code 1.140.0, built-in Copilot Chat 0.68.0)

- `logs/20261001T170603/agenthost.log`: every failure is an **Agent Host** session (`producer: copilot-agent`, `selectedModel: meta/muse-spark-1.3-contributor`) using the BYOK loopback proxy (`Wired 5 BYOK model(s) across 1 provider(s) via loopback proxy http://127.0.0.1:…`). Tool counts were 383, 379, and 332. 332 is the count with MCP servers disabled, so the remaining tools come from the SDK, the client, the extensions, and the built-in GitHub MCP.
- The error text is the extension's own `request.toolsLimitExceeded`, thrown in `prepareRequestTools` before any HTTP call. The loopback proxy reports the provider error as HTTP 502, and the Copilot SDK then retries a deterministic local failure five times.

### Current API contract (verified against shipped sources, not assumed)

| Question | Finding |
|---|---|
| `ProvideLanguageModelChatResponseOptions.tools` semantics | Unchanged: "tools that are *available* to the language model". The 1.140 `vscode.d.ts` matches `@types/vscode` 1.116 for the whole LM provider surface (the full-file diff is doc comments only). |
| `LanguageModelChatCapabilities.toolCalling: number` | Still documented as the per-request maximum, but **advisory**: VS Code core does not enforce it, and the Agent Host BYOK bridge (`AgentHostByokLmHandler.listModels`) does **not** forward it. The bridge forwards tokens, vision, and reasoning efforts only. |
| `activate_*` virtual tools | A Copilot Chat extension feature (`VirtualToolGrouping`, `chat.virtualTools.threshold`, default 128). The classic agent loop groups when `!endpoint.supportsToolSearch`. Extension-contributed endpoints never set `supportsToolSearch`, so the classic loop still groups and trims to ≤128. **The existing `activate_*` / `stabilizeToolList` support is correct for that path.** |
| Agent Host (Copilot SDK) | It does not use virtual-tool grouping. Its own deferred loading (`toolSearch` / `tool_search_tool`) is enabled only for model families allowlisted by `f9()` (GPT-5.4+, Claude 4.5+). Muse is not on that list, so the SDK sends its whole inventory through `AgentHostByokLmHandler.chat()` → `sendChatRequest` → our provider. |
| Do third-party providers get a first-class deferral mechanism? | **No.** There is no stable or proposed API through which a provider can declare deferred tools or tool-search support, and Marketplace extensions cannot use proposed APIs anyway (this extension declares none). |
| Engine / `@types/vscode` update needed? | **No.** No new API is used, and 1.116 → 1.140 has no LM-provider change. Engine `^1.116.0` and `@types/vscode ^1.116.0` stay as they are. |

**Conclusion:** the API contract did not change. A new consumer (the Agent Host) passes the full available-tool set and ignores the declared limit. The provider must treat 128 as the cap on function definitions per Meta request, not as the cap on tools Copilot may offer, and it must virtualize the tool set itself.

## Repair

Provider-side tool virtualization, active only when more than 128 tools are supplied. With 128 or fewer tools, requests are byte-for-byte unchanged.

- **`src/provider/tools/virtual.ts`** (new, pure)
  - `planToolSet` builds a deterministic subset of at most 127 concrete tools plus one provider-owned loader function, `meta_spark_load_tools`, renamed if a supplied tool already uses that name. Selection priority:
    1. tools loaded earlier (persisted);
    2. tools already called in this conversation;
    3. ungrouped tools (built-ins, `activate_*` activators);
    4. whole namespace groups, smallest first, only if the whole group fits.
  - Groups follow the MCP naming conventions `mcp_<server>_*`, `a__b__*`, and the Copilot SDK's `<server>-*`, plus large (≥8) shared `prefix_` families. Groups are never split arbitrarily.
  - The loader's description carries the deferred catalog: every deferred name when it fits in 8000 characters, otherwise a per-group summary with exact counts.
  - `resolveToolLoad` loads by exact name, by group (an oversized group returns a listing instead of a truncation), or by keyword query.
  - `ToolDiscoverySession` captures loader calls, applies loads, and produces the follow-up messages for an internal round.
- **`src/provider/index.ts`**
  - Runs the session. When Meta's response contains *only* loader calls, the provider resolves them internally and issues a follow-up Meta request with the expanded tool set, all inside the same `provideLanguageModelChatResponse` call. This happens at most 3 rounds per call, and the final round doesn't offer the loader.
  - The loader call never reaches Copilot, so no host has to know the tool exists. If Meta emits loader calls alongside real tool calls, the real calls go to the host and the loads persist for the next call.
- **`src/provider/stream.ts`**: tool-call interceptor, reasoning carried across rounds, replay marker deferred to the final round. Loads are resolved at capture time, so the end-of-stream marker already includes them.
- **`src/provider/replay/*`**: the replay marker gains an optional `tools.loaded` list. It is validated, capped at 256 entries, and read by `findLatestLoadedTools`. The marker already survives both the classic history and the Agent Host `previousResponseId` round-trip, as the usage marker relies on today, so loaded tools persist across turns without another discovery round.
- **`src/provider/request.ts` / `tools/request.ts`**
  - The planned tool list is passed explicitly.
  - The `toolsLimitExceeded` guard is kept as an **invariant**: an over-limit list is refused, never sliced.
  - `continueWith` builds discovery rounds from the already-resolved messages, so vision runs once per call.
- **Usage**: `sumMetaUsage` (in `src/usage/pricing.ts`) sums every round, so a provider call with discovery rounds is recorded once with complete billed tokens. If a later round fails, the billed earlier rounds are recorded rather than a non-billable attempt.
- **Diagnostics**: a new `[tool-virtualization]` output line, always shown when virtualizing and debug-only for passthrough. It reports:
  - `mode` and `supplied` (tools Copilot supplied);
  - `activators` (`activate_*` count);
  - `sentFunctions=N/128` and `concrete`;
  - `deferred` and `loaded`;
  - `round`, and for each discovery round `loaderCalls`, `newlyLoaded`, `toolSetChanged`, `continued`.

  Tool arguments and loader queries are never logged. The existing cache tracer additionally reports `tool schema changed` when a round changes the prefix.
- **Related diagnostics fix** (`src/provider/debug/dump.ts`): provider-input request dumps always failed with `getMetaContentString(...).map is not a function` (a port bug: `.map` was called on a string). They now serialize `message.content`. This was observed in the same failing sessions.

Unchanged: model catalog and `toolCalling: 128` advertisement; Muse Spark 1.1/1.2/1.3 and Contributor variants; reasoning-effort controls; vision; `stabilizeToolList` preflight; drift notice; request classification; tool-call replay; usage dashboard, history, and persistence formats.

### Rejected alternatives

- `slice(0, 128)`, dropping tools, disabling MCP or extension tools, or raising the limit: these hide tools and break agent capability, and they're out of bounds per the request.
- Contributing the loader as a real `vscode.lm` tool: it would appear in every model's tool picker and be subject to user tool configuration and confirmation UI, and it can't be scoped to Muse.
- Emitting loader calls to the host for it to "execute": the host doesn't know the tool, so it errors and pollutes chat history.

## Validation

- `npm test` (on this branch before integration with PR #3): **85 / 85 pass**, made up of:
  - 51 existing tests;
  - 31 new unit tests in `test/tools.test.cjs`;
  - 3 new loopback integration tests in `test/provider-tools.integration.test.cjs`.
- `npm run lint` (oxlint): 0 warnings, 0 errors.
- `oxfmt --check` on every changed `src/` file: clean except `src/provider/debug/diagnostics.ts` and `dump.ts`, which already failed on `origin/main`. No new drift; one incidental import-indent reflow was reverted to keep the diff minimal.

Regression coverage (requested matrix):

| Case | Test |
|---|---|
| < 128 tools | passthrough, same array, no loader |
| exactly 128 | passthrough (unit + integration: names sent unchanged) |
| 129 and 379 (simulated Agent Host population) | virtualized; every tool is exactly one of sent/deferred |
| sizes 0…1000 × loaded sets × final round | outbound functions ≤ 128 and `prepareRequestTools` never throws for planned sets |
| `activate_*` virtual tools | counted, never grouped or deferred, passthrough unchanged |
| group expansion | whole group that fits is loaded; oversized group returns a listing |
| no MCP tools | 200 standalone tools; deferred ones loadable by name |
| one MCP group | built-ins eager, 250-tool group deferred as a unit, loadable by query |
| large mixed environment | discovery session end to end; integration test through the real provider |
| no silent truncation | guard throws on unplanned >128 lists; catalog accounts for every deferred tool |
| persistence | marker round-trip; the next turn needs no discovery round |
| diagnostics | counts present, loader arguments absent |
| usage | rounds summed and recorded once |

## Qualification

- **Original condition reproduced:** the integration harness against the unmodified `main` build fails with `Meta supports at most 128 functions per tools request, got 379.`, the exact production error.
- **Fixed build, real `MetaChatProvider`, loopback Meta endpoint, 379 tools:**
  - outbound function counts were 91 → 111;
  - one internal discovery round loaded 20 tools;
  - the host received only the real `konnect-add_schematic_wire_0` call;
  - one replay marker carried the loaded set and the full reasoning;
  - usage was recorded once with 2000 prompt tokens summed;
  - the next turn sent the loaded tool directly in a single request.
- **Verbose debug mode:** provider-input and Meta-request dumps write successfully (11 files) with no `providerInputDump write failed`.
- **Not performed:** a live Copilot Agent Host session against the real Meta API. It requires installing the build and an interactive session with the Product Owner's API key, and installation was explicitly deferred.

## Residual caveats

- Grouping is name-based because `LanguageModelChatTool` carries no origin metadata. Unusual naming falls back to ungrouped, so tools are deferred individually and stay discoverable.
- A discovery round changes the tool prefix, which costs one prompt-cache miss for that round. Loaded tools then persist, so later turns are stable.
- If the model calls the loader on the final allowed round (it is not offered there), the call is dropped and the response ends. This is logged as `continued=false`.
- Agent Host deferral would become native if Copilot added Muse to its tool-search allowlist or forwarded `toolCalling`. The provider-side path would then simply go unused, because Copilot would supply 128 or fewer tools.
- Packaged as 2.2.2 (see Release Packaging) but not installed or published to Marketplace/Open VSX.

## Changed files

- `src/provider/tools/virtual.ts` (new), `src/provider/tools/consts.ts`, `src/provider/tools/request.ts`
- `src/provider/index.ts`, `src/provider/request.ts`, `src/provider/stream.ts`
- `src/provider/replay/consts.ts`, `index.ts`, `markers.ts`, `types.ts`
- `src/provider/debug/diagnostics.ts` (marker-report reason), `src/provider/debug/dump.ts` (dump fix)
- `src/usage/pricing.ts` (`sumMetaUsage`)
- `test/tools.test.cjs`, `test/provider-tools.integration.test.cjs`, `test/vscode-lm-stub.cjs` (new); `package.json` (test script; version 2.2.2), `package-lock.json` (root version fields only)
- `CHANGELOG.md` (2.2.2), `docs/notices/tool-drift.en.md`, `docs/notices/tool-drift.zh.md`

## Release Packaging — 2026-10-01 (integrated with PR #3)

The first 2.2.2 package built on this branch predated PR #3 (usage periods, persistent accounting, Restore History) and was discarded, including its SHA-256. The artifact below was built from the integrated tree after PR #3 was merged into `main` (merge commit `09bcdfa`) and `main` was merged into this branch (`ebd1b28`).

- Version `2.2.2` in `package.json` and both root version fields of `package-lock.json`; no dependency versions changed.
- `CHANGELOG.md`: one combined `2.2.2` section (usage/UI/history changes plus this fix); no `Unreleased` section.
- Integration conflicts: `CHANGELOG.md` only (resolved by combining). `package.json` merged cleanly and keeps the `meta-spark.restoreUsageHistory` command and the expanded test script (`usage`, `tools`, `provider-tools.integration`).
- `npm test`: 98 / 98 pass (usage 64, tool virtualization 31, provider integration 3).
- `npm run lint` (oxlint): 0 warnings, 0 errors.
- `npm run format:check`: reports every `src/` file under the Windows `core.autocrlf=true` CRLF checkout (64 on `main`, 65 here because `virtual.ts` is new); not a regression and the repo does not gate on it.
- Request dumps re-verified on the integrated tree with `debugMode=verbose` against the loopback provider test: 15 dump files written, no `write failed` entries.
- Source commit packaged: `ebd1b289eb294db9d057dc9b97d44cf2a965307e` (clean working tree). Later commits on this branch are documentation only.
- `npm run package`: `dist/meta-spark-for-copilot-2.2.2.vsix`, 84 files, 422,228 bytes.
- VSIX SHA-256: `E2D98621864BD57A713F679126D3F422FDC80986533FA4366A29DD4CF994C618`
- Verified inside the VSIX: `package.json` version 2.2.2; `meta-spark.restoreUsageHistory` in `package.json`, `package.nls.json`, and `out/runtime/commands.js`; Restore History and `1d`/month period code in `out/usage/`; `out/provider/tools/virtual.js` present; combined 2.2.2 changelog; no `src/`, `test/`, `docs/`, `.ts`, or source-map files.
- `dist/` is gitignored, so the VSIX itself is not committed.
- Not installed. Not published to Marketplace or Open VSX.
