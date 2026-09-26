import vscode from 'vscode';
import { AuthManager } from '../auth';
import { getApiModelId, getStabilizeToolListEnabled } from '../config';
import { MODELS } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import type { UsageService, PendingUsageRequest } from '../usage';
import { getConfiguredThinkingEffort } from './models';
import { createCacheDiagnosticsRecorder, dumpProviderInput } from './debug';
import { toChatInfo } from './models';
import { BalanceCurrencyResolver } from './pricing/currency';
import { prepareChatRequest } from './request';
import { classifyProviderRequest } from './routing';
import { resolveConversationSegment } from './segment';
import { streamChatCompletion } from './stream';
import { estimateTokenCount } from './tokens';
import { processToolFlow } from './tools/flow';
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

		const usagePending = await this.beginUsageTracking({
			messages: toolFlow.messages,
			options,
			modelInfo,
			requestKind,
		});

		let prepared;
		try {
			prepared = await prepareChatRequest({
				authManager: this.authManager,
				globalStorageUri: this.globalStorageUri,
				modelInfo,
				segment,
				messages: toolFlow.messages,
				options,
				token,
				cacheDiagnostics: this.cacheDiagnostics,
				getVisionDescriber: () => this.vision.get(),
				usageCorrelation: resolveUsageCorrelation(usagePending),
			});
		} catch (error) {
			await this.recordUsageAttempt(usagePending, error);
			throw error;
		}

		try {
			await streamChatCompletion({
				prepared,
				progress,
				token,
				initialResponseNotice: joinInitialResponseNotices(
					toolFlow.initialResponseNotice,
					prepared.initialResponseNotice,
				),
				getCharsPerToken: () => this.charsPerToken,
				setCharsPerToken: (charsPerToken) => {
					this.charsPerToken = charsPerToken;
				},
				usageHooks: this.createUsageHooks(usagePending),
			});
		} catch (error) {
			if (usagePending && !usagePending.settled) {
				await this.recordUsageAttempt(usagePending, error);
				usagePending.settled = true;
			}
			throw error;
		}
		if (usagePending && !usagePending.settled && !token.isCancellationRequested) {
			// No authoritative usage arrived (should be rare since
			// stream_options.include_usage=true); record a non-billable
			// attempt rather than fabricating tokens.
			await this.recordUsageAttempt(
				usagePending,
				token.isCancellationRequested ? 'cancelled' : 'no-usage-returned',
			);
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

	private createUsageHooks(
		usagePending: { pending: PendingUsageRequest; settled: boolean } | undefined,
	):
		| {
				onUsage: (usage: import('../types').MetaUsage, info: { durationMs?: number }) => void;
		  }
		| undefined {
		if (!usagePending || !this.usageService) {
			return undefined;
		}
		const service = this.usageService;
		const state = usagePending;
		return {
			onUsage: (usage, info) => {
				if (state.settled) {
					return;
				}
				state.settled = true;
				void service
					.recordCompleted(state.pending, { usage, durationMs: info.durationMs })
					.catch((error) => logger.warn('[usage] Failed to record Muse usage', error));
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
