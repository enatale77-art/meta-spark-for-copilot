# Muse Spark 1.3 for Copilot Chat

<p align="center">
  <!-- marketplace-readme:remove-start -->
  <a href="https://marketplace.visualstudio.com/items?itemName=LukeSpine.meta-spark-for-copilot"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="从 VS Code Marketplace 安装"></a>
  <a href="https://open-vsx.org/extension/LukeSpine/meta-spark-for-copilot"><img src="https://img.shields.io/badge/Open%20VSX-Install-6A4FB6?style=for-the-badge" alt="从 Open VSX 安装"></a>
  <br/>
  <!-- marketplace-readme:remove-end -->
  <img src="https://img.shields.io/github/v/release/spinespine/meta-spark-for-copilot?style=for-the-badge&label=Version" alt="版本" />
</p>

<p align="center">
  <a href="https://github.com/spinespine/meta-spark-for-copilot/blob/main/README.md">English</a> |
  简体中文
</p>

**在 Copilot Chat 模型选择器中直接使用 Muse Spark 1.3（以及 1.2、1.1 与折扣贡献者档位）——原生视觉、推理强度控制与 Agent 工具。**

<p align="center">
  <img src="resources/screenshots/01-picker.png" alt="Muse Spark 出现在 Copilot Chat 模型选择器中" width="800">
</p>

## 为什么选这个扩展？

- **不是替换 Copilot，而是增强它。** 没有新的侧边栏，没有新的聊天界面。只是在你已经在用的模型选择器中多了一个选项。
- **Agent 模式、工具调用、Instructions、MCP、Skills——全部正常运作。** Copilot 的完整能力栈，现在跑在 Meta Spark 上。
- **原生视觉。** 把截图、图表、照片拖进聊天，Muse Spark 可直接理解（单次最多 50 张图，无需代理）。
- **需自行提供 API Key，直接向 Meta 付费。** 你的 API Key（`LLM...`），你的账单，你的速率限制。密钥通过 SecretStorage 存入系统密钥链。

## 功能特性

### 模型选择器中的 Muse Spark 1.3
- `muse-spark-1.3` —— 最新检查点，针对 Agentic 工作流调优，编程能力较 1.2 提升
- `muse-spark-1.3-contributor` —— 同一检查点的贡献者档位，价格大幅优惠（提示词可能用于训练）
- `muse-spark-1.2` / `muse-spark-1.1` —— 更早检查点，继续支持

全部支持 1,048,576 上下文、131,072 最大输出，多模态输入（文本/图片/视频/PDF），文本输出。音频输入请使用 1.2（1.3 音频支持尚未完全就绪）。可在对话中途切换模型，不丢失聊天历史。

### 原生视觉
将图片拖入聊天后，会以 base64 data URL 形式作为 `image_url` 内容发送。无需代理，无需额外配置。

<p align="center">
  <img src="resources/screenshots/03-vision.png" alt="在 Copilot Chat 中使用 Muse Spark 原生视觉" width="800">
</p>

### 推理强度控制
完整支持 `reasoning_effort`：`minimal`（最快）、`low`、`medium`（均衡，默认）、`high`（深度）、`xhigh`，以及 `max`（仅 `muse-spark-1.3` 标准档）。通过 Copilot Chat 模型选择器菜单设置。注意：Meta API 不支持 `none`，会映射为 `minimal`。

### 继承全部 Copilot 能力
Agent 模式、工具调用（文件编辑、终端等）、自定义 Instructions、MCP、Skills——因为本扩展实现了 `vscode.LanguageModelChatProvider`。

<p align="center">
  <img src="resources/screenshots/04-agent.png" alt="Muse Spark 运行 Copilot Agent 模式" width="800">
</p>

## 快速开始

### 前置条件

- VS Code 1.116 及以上版本
- GitHub Copilot 订阅（Free / Pro / Enterprise）
- Meta API Key，从 [dev.meta.ai](https://dev.meta.ai/) 获取，格式为 `LLM|...`

### 安装方式

1. **Microsoft VS Code** — 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=LukeSpine.meta-spark-for-copilot) 安装
2. **使用 Open VSX 的编辑器** — 从 [Open VSX](https://open-vsx.org/extension/LukeSpine/meta-spark-for-copilot) 安装

### 使用步骤

1. 命令面板（`Cmd/Ctrl+Shift+P`）运行 **Meta Spark: 设置 API Key**
2. 粘贴你的 Meta API Key（`LLM...`）
3. 打开 Copilot Chat，选择 **Muse Spark 1.3**

## 设置项

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `meta-spark-copilot.baseUrl` | `https://api.meta.ai/v1` | Meta API 端点 |
| `meta-spark-copilot.maxCompletionTokens` | `0` | 最大输出 Token 数（`0` = API 默认） |
| `meta-spark-copilot.modelIdOverrides` | 官方 ID | 兼容第三方 API 时覆盖模型 ID |
| `meta-spark-copilot.debugMode` | `minimal` | 诊断模式：`minimal` / `metadata` / `verbose` |
| `meta-spark-copilot.experimental.stabilizeToolList` | `false` | 实验性：稳定工具列表以提升缓存命中率 |
| `meta-spark-copilot.usageMonitor.statusBar` | `true` | 在状态栏显示 Muse 用量摘要 |

## 用量监控

本地优先的按任务 Muse 用量统计，直接取自 Meta 返回的 usage 对象——无代理、无云同步、无遥测。

- 命令面板 → **Meta Spark: 打开用量看板**——汇总卡片（请求数、输入、缓存、输出、缓存命中率、预估费用）、7d/30d/90d/全部 + 项目/模型过滤、任务聚合与请求时间线及请求类型分解、本地会话聚合、可复制 ID。
- 命令面板 → **Meta Spark: 导出用量 CSV**——按请求粒度导出到你选择的位置。
- 命令面板 → **Meta Spark: 清除用量历史**——需二次确认，仅删除用量监控数据。
- 状态栏显示当前工作区最近跟踪任务的摘要（请求/token/费用），点击打开看板。可通过 `meta-spark-copilot.usageMonitor.statusBar` 关闭。

本地存储（`<globalStorageUri>/usage-v1/` 下的 `requests.jsonl` + `contexts.json`）：时间戳、项目/会话/任务 ID、模型 ID、请求类型/发起方、推理强度、token 数（prompt、缓存、未缓存、补全、推理、总计）、预估 USD 费用与定价来源、耗时、状态，以及最多 160 字符的任务预览。完整提示词、源文件、工具参数/结果、推理/响应文本、请求/响应体、文件系统路径、API Key 永不存储。费用为基于扩展 `MODELS` 目录的估算，不是账单。

本地会话 ID 与任务 ID 由本扩展生成用于归组（层级：请求 → 任务 → 本地会话 → 项目）。本地会话 ID 不是 GitHub Copilot 原生会话 ID，v1 无法深链到原生 Copilot 会话。每个本地会话卡片显示明确的本地主题（取自该会话首个已清理的人类任务预览，在会话生命周期内保持稳定），它不是原生 Copilot 会话标题。无关联的工具/后台请求记为未归属的 Copilot 开销，不会猜测归入某个会话。

## 定价

**标准档位**（`muse-spark-1.1`、`muse-spark-1.2`、`muse-spark-1.3`）

- 输入 $1.25 / 1M，缓存输入 $0.15 / 1M，输出 $4.25 / 1M。无长上下文溢价。
- 速率限制：3000 RPM / 4M TPM（按团队）
- `max` 推理强度仅限 `muse-spark-1.3`（标准档）

**贡献者档位**（`muse-spark-1.2-contributor`、`muse-spark-1.3-contributor`）

- 输入 $0.10 / 1M，缓存输入 $0.002 / 1M，输出 $0.20 / 1M
- 速率限制：100 RPM / 3M TPM（按团队）
- 你的提示词与补全内容可能被用于训练未来的 Meta 模型

详见 [Meta 定价](https://dev.meta.ai/docs/getting-started/pricing-rate-limits)。

## 错误处理

- `401 invalid_api_key`：检查 `LLM...` 格式
- `429 rate_limit_exceeded`：等待 `Retry-After`
- `400 content_policy_violation`：内容策略
- `503 server_shutting_down`：可重试
- `504 gateway_timeout`：优先使用流式请求

## 开发

```bash
npm install
npm run compile
# 然后按 F5 启动 Extension Host
```

构建可分发的 `.vsix` 包：

```bash
npm run package
```

输出位于 `dist/`。

### 构建与版本管理

- **编译：** `npm run compile`（clean + `tsc`）。监听模式：`npm run watch`。
- **检查 / 格式化：** `npm run lint`（oxlint）与 `npm run format`（oxfmt）。
- **打包：** `npm run package` 使用 `@vscode/vsce` 生成 `dist/meta-spark-for-copilot-<版本>.vsix`。会先运行 `vscode:prepublish` 准备 Marketplace README。
- **本地安装：** 在 Extension Host 中运行 `Extensions: Install from VSIX...` 并选择 `.vsix`。
- **市场发布：** `npm exec -- vsce publish --packagePath dist/<文件>.vsix`（需要 `VSCE_PAT`），或 `npm exec -- ovsx publish <文件>.vsix` 发布到 Open VSX。

**版本管理（SemVer）：**

- 版本为手动管理。扩展版本号位于 `package.json`（`version`）。完整指南见 `docs/RELEASE.md`。
- 新增模型检查点 / 档位 / 能力等（相当于 `feat:`）提升**次版本**；设置或模型 ID 的破坏性变更提升**主版本**；小修复（相当于 `fix:`）提升**修订版本**。
- 本次为 **2.2.0**（次版本）：新增本地优先的 Muse 按任务用量监控（看板、CSV 导出、状态栏、清除历史），不破坏既有模型或设置。
- 发布流程：提升 `package.json` 中的 `version`，在 `CHANGELOG.md` 添加条目，运行 `npm run package` 构建并测试，再用 `vsce` / `ovsx` 发布并在 GitHub 打上发布标签。

## 许可证

[MIT](LICENSE)
