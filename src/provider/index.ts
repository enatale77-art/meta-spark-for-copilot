import vscode from 'vscode';
import { AuthManager } from '../auth';
import { getApiModelId, getDebugLoggingEnabled, getStabilizeToolListEnabled } from '../config';
import { MODELS } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import type { MetaUsage } from '../types';
import type { UsageService, PendingUsageRequest } from '../usage';
import { sumMetaUsage } from '../usage/pricing';
import { getConfiguredThinkingEffort } from './models';
import { createCacheDiagnosticsRecorder, dumpProviderInput } from './debug';
import { toChatInfo } from './models';
import { BalanceCurrencyResolver } from './pricing/currency';
import { prepareChatRequest } from './request';
import { findLatestLoadedTools } from './replay';
import { classifyProviderRequest, formatRequestLogLine } from './routing';
import { resolveConversationSegment } from './segment';
import { streamChatCompletion } from './stream';
import { estimateTokenCount } from './tokens';
import { processToolFlow } from './tools/flow';
import { getToolCallingLimit } from './tools/request';
import {
	collectUsedToolNames,
	formatToolDiscoveryDiagnostics,
	ToolDiscoverySession,
} from './tools/virtual';
import { createVisionService } from './vision';

export class MetaChatProvider implements vscode.LanguageModelChatProvider {
	private readonly authManager: AuthManager;
	private readonly globalStorageUri: vscode.Uri;
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	private isActive = true;
	private usageService: UsageService | undefined;

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	private readonly cacheDiagnostics = createCacheDiagnosticsRecorder();
	private readonly vision: ReturnType<typeof createVisionService>;
	private readonly balanceCurrencyResolver: BalanceCurrencyResolver;
	private charsPerToken = 4.0;

	constructor(context: vscode.ExtensionContext) {
		this.authManager = new AuthManager(context);
		this.globalStorageUri = context.globalStorageUri;
		this.vision = createVisionService(context);
		this.balanceCurrencyResolver = new BalanceCurrencyResolver(context, this.authManager, () =>
			this.onDidChangeLanguageModelChatInformationEmitter.fire(),
		);

		context.subscriptions.push(
			this.onDidChangeLanguageModelChatInformationEmitter,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration('meta-spark-copilot.apiKey') ||
					e.affectsConfiguration('meta-spark-copilot.baseUrl')
				) {
					this.invalidateCurrencyAndRefreshModels();
				}
			}),
			context.secrets.onDidChange((e) => {
				if (e.key === 'meta-spark.apiKey') {
					this.invalidateCurrencyAndRefreshModels();
				}
			}),
		);
	}

	async configureApiKey(): Promise<void> {
		const saved = await this.authManager.promptForApiKey();
		if (saved) {
			this.invalidateCurrencyAndRefreshModels();
		}
	}

	async clearApiKey(): Promise<void> {
		await this.authManager.deleteApiKey();
		this.invalidateCurrencyAndRefreshModels();
		vscode.window.showInformationMessage(t('auth.removed'));
	}

	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasApiKey();
	}

	refreshModelPicker(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	private invalidateCurrencyAndRefreshModels(): void {
		void this.balanceCurrencyResolver
			.invalidate()
			.catch((error) => logger.warn('Failed to invalidate Meta balance currency', error))
			.finally(() => this.onDidChangeLanguageModelChatInformationEmitter.fire());
	}

	async prepareForDeactivate(): Promise<void> {
		this.isActive = false;
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
		try {
			await vscode.lm.selectChatModels({ vendor: 'meta' });
		} catch (error) {
			logger.warn('Failed to refresh Meta models during deactivate', error);
		}
	}

	async setVisionModel(): Promise<void> {
		await this.vision.openConfiguration();
	}

	setUsageService(usageService: UsageService | undefined): void {
		this.usageService = usageService;
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isActive) {
			return [];
		}
		const hasKey = await this.authManager.hasApiKey();
		const pricingCurrency = this.balanceCurrencyResolver.getDisplayCurrency();
		if (hasKey) {
			this.balanceCurrencyResolver.refreshInBackground();
		}
		return MODELS.map((model) => toChatInfo(model, hasKey, pricingCurrency));
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const segment = resolveConversationSegment(messages);
		const requestKind = classifyProviderRequest({
			messages,
			tools: options.tools,
		});

		dumpProviderInput({
			globalStorageUri: this.globalStorageUri,
			segment,
			modelInfo,
			messages,
			requestOptions: options,
			requestKind,
		});

		const toolFlow = processToolFlow({
			stabilizeToolList: getStabilizeToolListEnabled(),
			messages,
			tools: options.tools,
			progress,
			requestKind,
		});
		if (toolFlow.preflightHandled) {
			return;
		}

		const modelDef = MODELS.find((model) => model.id === modelInfo.id);
		const toolCalling = modelDef?.capabilities.toolCalling;
		const toolDiscovery = new ToolDiscoverySession(
			toolCalling ? options.tools : undefined,
			getToolCallingLimit(toolCalling),
			findLatestLoadedTools(toolFlow.messages),
			collectUsedToolNames(toolFlow.messages),
		);
		logToolDiscovery(requestKind, toolDiscovery);

		const usagePending = await this.beginUsageTracking({
			messages: toolFlow.messages,
			options,
			modelInfo,
			requestKind,
		});
		const usage = this.createUsageAccumulator(usagePending);

		let prepared;
		try {
			prepared = await prepareChatRequest({
				authManager: this.authManager,
				globalStorageUri: this.globalStorageUri,
				modelInfo,
				segment,
				messages: toolFlow.messages,
				options,
				tools: toolDiscovery.tools,
				token,
				cacheDiagnostics: this.cacheDiagnostics,
				getVisionDescriber: () => this.vision.get(),
				usageCorrelation: resolveUsageCorrelation(usagePending),
			});
		} catch (error) {
			await this.recordUsageAttempt(usagePending, error);
			throw error;
		}

		let pendingNotice = joinInitialResponseNotices(
			toolFlow.initialResponseNotice,
			prepared.initialResponseNotice,
		);
		let seedReasoning = '';
		try {
			for (;;) {
				const outcome = await streamChatCompletion({
					prepared,
					progress,
					token,
					initialResponseNotice: pendingNotice,
					getCharsPerToken: () => this.charsPerToken,
					setCharsPerToken: (charsPerToken) => {
						this.charsPerToken = charsPerToken;
					},
					usageHooks: usage.hooks,
					seedReasoning,
					toolCallInterceptor: toolDiscovery.virtualized
						? (toolCall) => toolDiscovery.captureToolCall(toolCall)
						: undefined,
					deferReplayMarker: toolDiscovery.virtualized
						? (emittedToolCalls) => toolDiscovery.willContinue(emittedToolCalls)
						: undefined,
					loadedToolNames: () => toolDiscovery.loadedToolNames(),
				});
				const followUp = toolDiscovery.finishRound({
					...outcome,
					isThinkingModel: prepared.isThinkingModel,
				});
				if (toolDiscovery.diagnostics().loaderCalls !== undefined) {
					logToolDiscovery(requestKind, toolDiscovery);
				}
				if (!followUp || token.isCancellationRequested) {
					break;
				}
				if (outcome.content || outcome.reasoning || outcome.emittedToolCalls > 0) {
					pendingNotice = undefined;
				}
				seedReasoning += outcome.reasoning;
				prepared = prepared.continueWith({ tools: toolDiscovery.tools, messages: followUp });
			}
		} catch (error) {
			// Completed discovery rounds were billed; keep them instead of a non-billable attempt.
			if (!usage.flush()) {
				await this.recordUsageAttempt(usagePending, error);
			}
			throw error;
		}
		usage.flush();
		if (usagePending && !usagePending.settled && !token.isCancellationRequested) {
			// No authoritative usage arrived (should be rare since
			// stream_options.include_usage=true); record a non-billable
			// attempt rather than fabricating tokens.
			await this.recordUsageAttempt(usagePending, 'no-usage-returned');
		} else if (usagePending && !usagePending.settled && token.isCancellationRequested) {
			await this.recordUsageAttempt(usagePending, 'cancelled');
		}
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokenCount(text, this.charsPerToken);
	}

	private async beginUsageTracking(input: {
		messages: readonly vscode.LanguageModelChatRequestMessage[];
		options: vscode.ProvideLanguageModelChatResponseOptions;
		modelInfo: vscode.LanguageModelChatInformation;
		requestKind: ReturnType<typeof classifyProviderRequest>;
	}): Promise<{ pending: PendingUsageRequest; settled: boolean } | undefined> {
		if (!this.usageService) {
			return undefined;
		}
		try {
			const pending = await this.usageService.beginRequest({
				messages: input.messages,
				requestKind: input.requestKind,
				vscodeModelId: input.modelInfo.id,
				apiModelId: getApiModelId(input.modelInfo.id),
				requestInitiator: (input.options as { requestInitiator?: unknown }).requestInitiator,
				reasoningEffort: getConfiguredThinkingEffort(
					input.options as Parameters<typeof getConfiguredThinkingEffort>[0],
				),
			});
			return { pending, settled: false };
		} catch (error) {
			logger.warn('[usage] Failed to begin usage tracking', error);
			return undefined;
		}
	}

	/**
	 * One provider call can make several Meta requests (tool discovery rounds). Usage is summed
	 * and recorded once per call, keeping the request → task correlation unchanged.
	 */
	private createUsageAccumulator(
		usagePending: { pending: PendingUsageRequest; settled: boolean } | undefined,
	): {
		hooks: { onUsage: (usage: MetaUsage, info: { durationMs?: number }) => void } | undefined;
		flush: () => boolean;
	} {
		const service = this.usageService;
		if (!usagePending || !service) {
			return { hooks: undefined, flush: () => false };
		}
		let total: MetaUsage | undefined;
		let durationMs = 0;
		return {
			hooks: {
				onUsage: (usage, info) => {
					total = total ? sumMetaUsage(total, usage) : usage;
					durationMs += info.durationMs ?? 0;
				},
			},
			flush: () => {
				if (!total || usagePending.settled) {
					return false;
				}
				usagePending.settled = true;
				void service
					.recordCompleted(usagePending.pending, { usage: total, durationMs })
					.catch((error) => logger.warn('[usage] Failed to record Muse usage', error));
				return true;
			},
		};
	}

	private async recordUsageAttempt(
		usagePending: { pending: PendingUsageRequest; settled: boolean } | undefined,
		error: unknown,
	): Promise<void> {
		if (!usagePending || usagePending.settled || !this.usageService) {
			return;
		}
		usagePending.settled = true;
		try {
			await this.usageService.recordAttempt(
				usagePending.pending,
				error instanceof Error ? error.message : String(error ?? 'unknown'),
			);
		} catch (recordError) {
			logger.warn('[usage] Failed to record usage attempt', recordError);
		}
	}
}

function logToolDiscovery(
	requestKind: ReturnType<typeof classifyProviderRequest>,
	toolDiscovery: ToolDiscoverySession,
): void {
	const diagnostics = toolDiscovery.diagnostics();
	// Always visible when virtualizing; passthrough counts only with debug logging.
	if (toolDiscovery.virtualized) {
		logger.info(formatRequestLogLine(requestKind, formatToolDiscoveryDiagnostics(diagnostics)));
	} else if (getDebugLoggingEnabled() && diagnostics.supplied > 0) {
		logger.debug(formatRequestLogLine(requestKind, formatToolDiscoveryDiagnostics(diagnostics)));
	}
}

function joinInitialResponseNotices(...notices: (string | undefined)[]): string | undefined {
	const joined = notices.filter((notice) => notice && notice.trim().length > 0).join('\n');
	return joined || undefined;
}

/**
 * R7: exactly one stateful marker per main-agent response carries usage
 * correlation. Non-main responses stay unmarked; unassigned requests carry
 * no IDs. Uses the VS Code selected model ID as the Agent Host prefix —
 * never the API model override.
 */
function resolveUsageCorrelation(
	usagePending: { pending: PendingUsageRequest; settled: boolean } | undefined,
): { chatId: string; taskId: string } | undefined {
	const allocation = usagePending?.pending.allocation;
	if (!allocation?.chatId || !allocation?.taskId) {
		return undefined;
	}
	if (usagePending?.pending.requestKind !== 'main-agent') {
		return undefined;
	}
	return { chatId: allocation.chatId, taskId: allocation.taskId };
}
