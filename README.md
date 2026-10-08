# Muse Spark 1.3 for Copilot Chat

<!-- marketplace-readme:remove-start -->
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=LukeSpine.meta-spark-for-copilot) · [Open VSX](https://open-vsx.org/extension/LukeSpine/meta-spark-for-copilot) · [Releases](https://github.com/spinespine/meta-spark-for-copilot/releases)
<!-- marketplace-readme:remove-end -->

Adds **Muse Spark 1.3** (plus 1.2, 1.1, and discounted Contributor variants) to the Copilot Chat model picker. Uses your Meta API key (BYOK).

## Features

- Model `muse-spark-1.3` (1,048,576 context, 131,072 max output) — the latest checkpoint, tuned for agentic workflows with improved coding
- Model `muse-spark-1.3-contributor` — same checkpoint, heavily discounted Contributor tier
- Model `muse-spark-1.2` / `muse-spark-1.1` — earlier checkpoints, still supported
- Multimodal input: text, image, video, PDF (for audio input, use 1.2 — 1.3 audio support is not fully ready)
- Native vision via base64 `image_url` content parts (no proxy)
- Reasoning effort: `minimal`, `low`, `medium` (default), `high`, `xhigh`, and `max` (Standard-tier `muse-spark-1.3` only)
- Reasoning kept across agent tool calls: requests use Meta's Responses API with stateless encrypted reasoning replay, so each step of a tool loop continues from the model's earlier reasoning instead of starting over. A short reasoning summary is shown as thinking in agent mode
- Works with Copilot agent mode, tools, instructions, MCP, and skills via `LanguageModelChatProvider`

## Requirements

- VS Code 1.116+
- GitHub Copilot (Free, Pro, or Enterprise)
- Meta API key from [dev.meta.ai](https://dev.meta.ai/) (`LLM|...`)

## Install

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=LukeSpine.meta-spark-for-copilot) or [Open VSX](https://open-vsx.org/extension/LukeSpine/meta-spark-for-copilot)
2. Command Palette → **Meta Spark: Set API Key**
3. Open Copilot Chat and select **Muse Spark 1.3**

## Configuration

| Setting | Default | Description |
|---|---|---|
| `meta-spark-copilot.baseUrl` | `https://api.meta.ai/v1` | API base URL |
| `meta-spark-copilot.apiProtocol` | `auto` | `auto` (Responses API on `api.meta.ai`, Chat Completions on a custom base URL) / `responses` / `chatCompletions`. Chat Completions does not keep reasoning between tool calls |
| `meta-spark-copilot.maxCompletionTokens` | `0` | Max output tokens (`0` = API default) |
| `meta-spark-copilot.modelIdOverrides` | official IDs | Override model IDs for proxies |
| `meta-spark-copilot.debugMode` | `minimal` | `minimal` / `metadata` / `verbose` |
| `meta-spark-copilot.experimental.stabilizeToolList` | `false` | Experimental tool-list stabilization |
| `meta-spark-copilot.usageMonitor.statusBar` | `true` | Show Muse usage summary in the status bar |

## Usage Monitor

Local-first per-task Muse usage accounting, captured from Meta's returned usage object — no proxy, no cloud sync, no telemetry.

- Command Palette → **Meta Spark: Open Usage Dashboard** — summary cards (requests, input, cached, output, cache-hit %, estimated cost), 1D (rolling 24 hours)/7d/30d/90d/This month (local calendar month-to-date)/All + project/model filters, and a chat-first hierarchy (Project → Local Chat → Task → Request): Local Chat cards are the default view, Tasks open inside their chat, and request timelines with request-kind breakdowns and copyable IDs render inside the selected task.
- Command Palette → **Meta Spark: Export Usage CSV** — request-granularity rows saved to a location you choose.
- **Clear history** (dashboard button or **Meta Spark: Clear Usage History**) — confirmation-gated; hides older Local Chat/task/overhead detail from the dashboard and status bar. Nothing is deleted: summary totals keep using the full retained ledger.
- **Restore history** (dashboard button or **Meta Spark: Restore Usage History**) — shows all hidden history again. Non-destructive, so no confirmation; safe to run when nothing is hidden.
- Status bar shows the most recent tracked task in the active workspace (request/token/cost); click opens the dashboard. Disable with `meta-spark-copilot.usageMonitor.statusBar`.

What is stored locally (under `<globalStorageUri>/usage-v1/`: the append-only `requests.jsonl` ledger, `contexts.json` chat/task metadata, and `history-state.json`, which only holds the Clear history cutoff; all three survive restarts and normal extension updates): timestamps, project/chat/task IDs, model IDs, request kind/initiator, reasoning effort, token counts (prompt, cached, uncached, completion, reasoning, total), estimated USD cost + pricing source, duration, status, and a capped 160-character task preview. Full prompts, source files, tool arguments/results, reasoning/response text, request/response bodies, filesystem paths, and API keys are never stored. Costs are estimates from the extension's `MODELS` catalog, not billing invoices.

Local Chat IDs and Task IDs are owned by this extension for grouping (hierarchy: Project → Local Chat → Task → Request). A Local Chat ID is not GitHub Copilot's native session ID, and v1 cannot deep-link to the exact native Copilot chat. Each Local Chat card shows an explicit local Subject derived from the first cleaned human task preview (stable for the chat lifetime); it is not the native Copilot session title. Uncorrelated utility/background requests are recorded as unassigned Copilot overhead rather than guessed into a chat.

## Reasoning replay

Muse Spark reasons privately before every answer. Meta returns that reasoning only as opaque encrypted content on the Responses API, and it must be sent back on the next request for the model to keep its train of thought. Copilot does not return provider data to the extension reliably (the Agent Host drops it), so the extension keeps each response's encrypted reasoning in `<globalStorageUri>/reasoning-replay-v1.json`, keyed by the tool-call IDs it produced, and re-attaches it when that turn is replayed. Requests are sent with `store: false`, so Meta keeps no conversation state.

The file holds only Meta's encrypted reasoning blobs, tool-call IDs, model IDs, and timestamps: no prompts, responses, or readable reasoning. Entries expire after 7 days (at most 400 responses are kept). Reasoning is replayed only to the model that produced it; if it cannot be found (another machine, an old chat, a compacted conversation) the request is simply sent without it. If Meta rejects a replayed item, the request is retried once without replay.

## Pricing and limits

Standard tier (`muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.3`):

- Pricing: $1.25 / 1M input, $0.15 / 1M cached input, $4.25 / 1M output
- Rate limits: 3,000 RPM / 4M TPM per team
- The `max` reasoning effort is available on `muse-spark-1.3` (Standard) only
  See [Meta pricing](https://dev.meta.ai/docs/getting-started/pricing-rate-limits)

Contributor tier (`muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`):

- Pricing: $0.10 / 1M input, $0.002 / 1M cached input, $0.20 / 1M output
- Rate limits: 100 RPM / 3M TPM per team
- Your prompts and completions may be used to train future Meta models

## Common errors

| Code | Meaning |
|---|---|
| `401 invalid_api_key` | Check key format (`LLM\|...`) |
| `429 rate_limit_exceeded` | Wait for `Retry-After` |
| `400 content_policy_violation` | Content blocked by policy |
| `503` / `504` | Transient server/gateway issue; retry |

## Development

```bash
npm install
npm run compile
```

Press `F5` to launch the Extension Host.

To build a distributable `.vsix` package:

```bash
npm run package
```

The output lands in `dist/`.

### Building and versioning

- **Compile:** `npm run compile` (clean + `tsc`). Watch mode: `npm run watch`.
- **Lint / format:** `npm run lint` (oxlint) and `npm run format` (oxfmt).
- **Package:** `npm run package` produces `dist/meta-spark-for-copilot-<version>.vsix` using `@vscode/vsce`. It runs `vscode:prepublish` first, which prepares the marketplace README (`scripts/prepare-marketplace-readme.cjs`).
- **Local install:** from the Extension Host, run `Extensions: Install from VSIX...` and pick the `.vsix`.
- **Marketplace publish:** `npm exec -- vsce publish --packagePath dist/<file>.vsix` (requires `VSCE_PAT`), or `npm exec -- ovsx publish <file>.vsix` for Open VSX.

**Versioning (SemVer):**

- Versioning is manual. The extension version lives in `package.json` (`version`). See `docs/RELEASE.md` for the full guide.
- `feat:`-sized additions (new model checkpoints, new tiers, new capabilities) bump the **minor** version. Breaking changes to settings or model IDs bump the **major** version. `fix:`-sized changes bump the **patch** version.
- This release is **2.2.1** (patch): chat-first usage dashboard presentation (Local Chat as the primary unit, Tasks inside their chat). The **2.2.0** (minor) release added the local-first Muse per-task usage monitor (dashboard, CSV export, status bar, clear-history) without breaking existing models or settings.
- To release: bump `version` in `package.json`, add a `CHANGELOG.md` entry, build and test (`npm run package`), then publish with `vsce` / `ovsx` and tag the release on GitHub.

## License

[MIT](LICENSE)
