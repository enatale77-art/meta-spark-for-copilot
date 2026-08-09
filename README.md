# Muse Spark 1.2 for Copilot Chat

<!-- marketplace-readme:remove-start -->
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=LukeSpine.meta-spark-for-copilot) · [Open VSX](https://open-vsx.org/extension/LukeSpine/meta-spark-for-copilot) · [Releases](https://github.com/spinespine/meta-spark-for-copilot/releases)
<!-- marketplace-readme:remove-end -->

Adds **Muse Spark 1.2** (plus 1.1 and the discounted Contributor tier) to the Copilot Chat model picker. Uses your Meta API key (BYOK).

## Features

- Model `muse-spark-1.2` (1,048,576 context, 131,072 max output) — the current Meta default
- Model `muse-spark-1.2-contributor` — same checkpoint, heavily discounted Contributor tier
- Model `muse-spark-1.1` — the earlier checkpoint, still supported
- Multimodal input: text, image, video, PDF
- Native vision via base64 `image_url` content parts (no proxy)
- Reasoning effort: `minimal`, `low`, `medium` (default), `high`, `xhigh`
- Works with Copilot agent mode, tools, instructions, MCP, and skills via `LanguageModelChatProvider`

## Requirements

- VS Code 1.116+
- GitHub Copilot (Free, Pro, or Enterprise)
- Meta API key from [dev.meta.ai](https://dev.meta.ai/) (`LLM|...`)

## Install

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=LukeSpine.meta-spark-for-copilot) or [Open VSX](https://open-vsx.org/extension/LukeSpine/meta-spark-for-copilot)
2. Command Palette → **Meta Spark: Set API Key**
3. Open Copilot Chat and select **Muse Spark 1.2**

## Configuration

| Setting | Default | Description |
|---|---|---|
| `meta-spark-copilot.baseUrl` | `https://api.meta.ai/v1` | API base URL |
| `meta-spark-copilot.maxCompletionTokens` | `0` | Max output tokens (`0` = API default) |
| `meta-spark-copilot.modelIdOverrides` | official IDs | Override model IDs for proxies |
| `meta-spark-copilot.debugMode` | `minimal` | `minimal` / `metadata` / `verbose` |
| `meta-spark-copilot.experimental.stabilizeToolList` | `false` | Experimental tool-list stabilization |

## Pricing and limits

Standard tier (`muse-spark-1.1`, `muse-spark-1.2`):

- Pricing: $1.25 / 1M input, $0.15 / 1M cached input, $4.25 / 1M output
- Rate limits: 3,000 RPM / 4M TPM per team
  See [Meta pricing](https://dev.meta.ai/docs/getting-started/pricing-rate-limits)

Contributor tier (`muse-spark-1.2-contributor`):

- Pricing: $0.10 / 1M input, $0.002 / 1M cached input, $0.20 / 1M output
- Rate limits: 60 RPM / 2.1M TPM per team
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
- **Package:** `npm run package` produces `dist/meta-spark-for-copilot-<version>.vsix` using `@vscode/vsce`. It runs `vscode:prepublish` first, which prepares the marketplace README.
- **Local install:** from the Extension Host, run `Extensions: Install from VSIX...` and pick the `.vsix`.
- **Marketplace publish:** `npm exec -- vsce publish --packagePath dist/<file>.vsix` (requires `VSCE_PAT`), or `npm exec -- ovsx publish <file>.vsix` for Open VSX.

**Versioning (SemVer):**

- This is a **major release** (`2.0.0`). Major bumps signal new model checkpoints or breaking changes to settings/model IDs.
- The repository uses [release-please](https://github.com/googleapis/release-please) on `main`. It derives the next version from conventional commits:
  - `feat!:` or `fix!:` (breaking) → major bump
  - `feat:` → minor bump
  - `fix:` / `perf:` → patch bump
- To trigger the next release: merge conventional commits to `main`. Release Please opens a release PR; merging it tags `v<version>` and the [Release workflow](.github/workflows/release.yml) builds and publishes the VSIX to the VS Code Marketplace, Open VSX, and GitHub Releases automatically.
- The extension version lives in `package.json` (`version`) and is mirrored in `.github/release-please-manifest.json`. Keep them in sync when bumping manually.
- CHANGELOG entries are generated from commit messages; add release notes under the `## <version>` heading produced by Release Please.

## License

[MIT](LICENSE)
