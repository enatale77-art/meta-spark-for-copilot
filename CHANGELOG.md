# Changelog

## 2.2.0

### Features

- **Muse per-task usage monitor** — local-first accounting from Meta's returned `MetaUsage` object: requests, input/cached/uncached/output/reasoning/total tokens, cache-hit %, and estimated USD cost at request, task, local-chat, and project levels
- **Usage Dashboard** (`Meta Spark: Open Usage Dashboard`) — local webview with 7d/30d/90d/All + project/model filters, task rollups, request timeline drill-down, local-chat roll-up, and copyable IDs; no remote JS/CSS
- **CSV export** (`Meta Spark: Export Usage CSV`) — request-granularity rows with IDs, capped 160-char preview, token fields, and cost; no prompts beyond the preview, no paths, no keys
- **Status bar** — compact most-recent-task summary for the active workspace (configurable via `meta-spark-copilot.usageMonitor.statusBar`), tooltip with IDs, click opens the dashboard
- **Clear history** (`Meta Spark: Clear Usage History`) — confirmation-gated, deletes only `usage-v1` data
- Extension-owned `chat_id`/`task_id` correlation via a hidden versioned `LanguageModelDataPart` marker; uncorrelated utility/background calls land in unassigned Copilot overhead rather than guessed chats

### Notes

- **Minor release (2.2.0)**: additive usage-monitor feature; existing models and settings are unchanged.
- Usage data stays local under `<globalStorageUri>/usage-v1/` (`requests.jsonl` + `contexts.json`). Costs are estimates from the extension's `MODELS` catalog, not billing invoices. Local Chat IDs are extension-owned; v1 cannot deep-link to the exact native Copilot chat.

## 2.1.0

### Features

- **Muse Spark 1.3** added to the Copilot Chat model picker — the latest checkpoint, tuned for agentic workflows (multi-step tool, browser, and long-horizon tasks) with improved coding over 1.2
- **Muse Spark 1.3 (Contributor)** added — same 1.3 checkpoint at heavily discounted Contributor-tier pricing ($0.10 / 1M input, $0.002 / 1M cached, $0.20 / 1M output)
- **`max` reasoning effort** added to the model picker for Standard-tier `muse-spark-1.3` (extended reasoning beyond `xhigh`). Safely clamped to `xhigh` on models that do not support it
- Muse Spark 1.1 and 1.2 (Standard and Contributor) remain available
- Model ID overrides now cover all five model IDs (`muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.3`, `muse-spark-1.3-contributor`)
- Contributor-tier rate limits updated (100 RPM / 3M TPM per team)

### Notes

- **Minor release (2.1.0)**: additive model checkpoints and a new reasoning level; existing models and settings are unchanged.
- All models share 1,048,576 context, 131,072 max output, and native text/image/video/PDF input. Audio input: use Muse Spark 1.2 (1.3 audio support is not fully ready).

## 2.0.0

### Features

- **Muse Spark 1.2** added to the Copilot Chat model picker — the current Meta default checkpoint with slightly higher performance
- **Muse Spark 1.2 (Contributor)** added — same 1.2 checkpoint at heavily discounted Contributor-tier pricing ($0.10 / 1M input, $0.002 / 1M cached, $0.20 / 1M output)
- Muse Spark 1.1 remains available for existing users
- Model ID overrides now cover all three model IDs (`muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.2-contributor`)
- Pricing and rate-limit documentation updated for Standard and Contributor tiers

### Notes

- **Major release (2.0.0)**: new model checkpoint plus a new tier. Existing chats that reference `muse-spark-1.1` continue to work.
- All models share 1,048,576 context, 131,072 max output, and native text/image/video/PDF input.

## 1.0.1

### Changes

- Cleaner, more professional README for Marketplace and GitHub
- Removed DeepSeek-era screenshots from the README

## 1.0.0

### Features

- Muse Spark 1.1 in the Copilot Chat model picker
- Native vision via base64 `image_url` content parts
- Reasoning effort control: `minimal`, `low`, `medium`, `high`, `xhigh`
- Agent tools, BYOK Meta API key storage, and request diagnostics

### Notes

- First stable Marketplace release
- Marketplace publisher: `LukeSpine`
- Repository: `spinespine/meta-spark-for-copilot`

## 0.6.2

### Features

- Muse Spark 1.1 in the Copilot Chat model picker
- Native vision via base64 `image_url` content parts
- Reasoning effort control: `minimal`, `low`, `medium`, `high`, `xhigh`
- Agent tools, BYOK Meta API key storage, and request diagnostics

### Notes

- Ported from the DeepSeek V4 for Copilot architecture to Meta Muse Spark 1.1
- Marketplace publisher: `LukeSpine`
- Repository: `spinespine/meta-spark-for-copilot`
