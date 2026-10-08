import vscode from 'vscode';
import { createUserFacingError } from '../client';
import { logger } from '../logger';
import type { MetaReasoningItem, MetaToolCall, MetaUsage } from '../types';
import {
	observeCancellationToken,
	type CacheDiagnosticsRun,
	type ReplayMarkerReportTrigger,
} from './debug';
import { formatRequestLogLine, type RequestKind } from './routing';
import {
	createReplayMarkerPart,
	hasReplayMarkerMetadata,
	type ReplayMarkerMetadata,
} from './replay';
import type { PreparedChatRequest } from './request';

interface ResponseStreamState {
	accumulatedReasoning: string;
	roundReasoning: string;
	roundContent: string;
	emittedToolCallIds: string[];
	reasoningItems: MetaReasoningItem[];
	initialResponseNoticeReported: boolean;
	replayMarkerReported: boolean;
	loadedToolNames?: () => readonly string[] | undefined;
}

export interface StreamRoundOutcome {
	content: string;
	reasoning: string;
	emittedToolCalls: number;
	/** Host-visible tool call IDs of this round. */
	emittedToolCallIds: string[];
	/** Responses API encrypted reasoning produced in this round. */
	reasoningItems: MetaReasoningItem[];
}

const COPILOT_USAGE_DATA_PART_MIME = 'usage';

export interface StreamChatCompletionOptions {
	prepared: PreparedChatRequest;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
	initialResponseNotice?: string;
	getCharsPerToken: () => number;
	setCharsPerToken: (charsPerToken: number) => void;
	usageHooks?: {
		onUsage?: (usage: MetaUsage, info: { durationMs: number }) => void;
	};
	/** Reasoning already streamed by earlier rounds of this provider call. */
	seedReasoning?: string;
	/** Returns true when a tool call is provider-internal and must not reach the host. */
	toolCallInterceptor?: (toolCall: MetaToolCall) => boolean;
	/** Returns true when this round continues internally, so the replay marker waits for the final round. */
	deferReplayMarker?: (emittedToolCalls: number) => boolean;
	loadedToolNames?: () => readonly string[] | undefined;
}

export function streamChatCompletion({
	prepared,
	progress,
	token,
	initialResponseNotice,
	getCharsPerToken,
	setCharsPerToken,
	usageHooks,
	seedReasoning,
	toolCallInterceptor,
	deferReplayMarker,
	loadedToolNames,
}: StreamChatCompletionOptions): Promise<StreamRoundOutcome> {
	const state: ResponseStreamState = {
		accumulatedReasoning: seedReasoning ?? '',
		roundReasoning: '',
		roundContent: '',
		emittedToolCallIds: [],
		reasoningItems: [],
		initialResponseNoticeReported: false,
		replayMarkerReported: false,
		loadedToolNames,
	};
	const streamStartedAtMs = Date.now();
	const cancelListener = observeCancellationToken(token, prepared.cacheDiagnostics);

	return prepared.client
		.streamChatCompletion(
			prepared.request,
			{
				onContent: (content: string) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					state.roundContent += content;
					progress.report(new vscode.LanguageModelTextPart(content));
				},

				onThinking: (text: string) => {
					if (!text) return;
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					handleThinking(text, state, progress);
				},

				onToolCall: (toolCall: MetaToolCall) => {
					if (toolCallInterceptor?.(toolCall)) {
						return;
					}
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					handleToolCall(toolCall, state, progress);
				},

				onError: (error: Error) => {
					throw createUserFacingError(error);
				},

				onDone: () => {
					if (deferReplayMarker?.(state.emittedToolCallIds.length)) {
						state.replayMarkerReported = true;
						prepared.cacheDiagnostics.onReplayMarkerReport({
							status: 'skipped',
							trigger: 'done',
							reason: 'tool-discovery-round',
						});
					} else {
						reportReplayMarkerOnce(prepared, progress, state, 'done');
					}
					finalizeReplayDiagnostics(
						prepared.trailingToolResultIds,
						state,
						prepared.cacheDiagnostics,
					);
				},

				onReasoningItem: (item) => {
					state.reasoningItems.push(item);
				},

				onUsage: (usage) => {
					const charsPerToken = updateCharsPerToken(
						prepared.totalRequestChars,
						usage,
						getCharsPerToken(),
					);
					setCharsPerToken(charsPerToken);
					prepared.cacheDiagnostics.onUsage(usage, charsPerToken);
					reportCopilotContextUsage(progress, usage, prepared.requestKind);
					try {
						usageHooks?.onUsage?.(usage, { durationMs: Date.now() - streamStartedAtMs });
					} catch (error) {
						logger.warn(
							formatRequestLogLine(prepared.requestKind, 'Failed to record Muse usage'),
							error,
						);
					}
				},
			},
			token,
			prepared.responsesOptions,
		)
		.then(undefined, (error) => {
			reportSkippedReplayMarkerIfNeeded(
				prepared,
				state,
				token.isCancellationRequested ? 'cancelled' : 'stream-error',
				error,
			);
			throw error;
		})
		.then((): StreamRoundOutcome => {
			if (token.isCancellationRequested) {
				reportSkippedReplayMarkerIfNeeded(prepared, state, 'cancelled');
			}
			return {
				content: state.roundContent,
				reasoning: state.roundReasoning,
				emittedToolCalls: state.emittedToolCallIds.length,
				emittedToolCallIds: [...state.emittedToolCallIds],
				reasoningItems: state.reasoningItems,
			};
		})
		.finally(() => {
			cancelListener.dispose();
		});
}

function reportInitialResponseNoticeOnce(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	initialResponseNotice: string | undefined,
): void {
	if (!initialResponseNotice || state.initialResponseNoticeReported) {
		return;
	}
	state.initialResponseNoticeReported = true;
	progress.report(new vscode.LanguageModelTextPart(initialResponseNotice));
}

function reportReplayMarkerOnce(
	prepared: PreparedChatRequest,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	trigger: ReplayMarkerReportTrigger,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	reportReplayMarker(prepared, progress, state, trigger);
}

function reportSkippedReplayMarkerIfNeeded(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
	reason: 'cancelled' | 'stream-error',
	error?: unknown,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	prepared.cacheDiagnostics.onReplayMarkerReport({
		status: 'skipped',
		reason,
		visionTextChars: prepared.visionMarkerTextChars,
		reasoningTextChars: state.accumulatedReasoning.length || undefined,
		error,
	});
}

function reportReplayMarker(
	prepared: PreparedChatRequest,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	trigger: ReplayMarkerReportTrigger,
): void {
	const metadata = getReplayMarkerMetadata(prepared, state);
	if (!hasReplayMarkerMetadata(metadata)) {
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'skipped',
			trigger,
			reason: 'no-replay-data',
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
		});
		return;
	}

	try {
		const markerPart = createReplayMarkerPart(metadata, prepared.vscodeModelId);
		progress.report(markerPart);
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'reported',
			trigger,
			markerBytes: markerPart.data.byteLength,
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
		});
	} catch (error) {
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'failed',
			trigger,
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
			error,
		});
		logger.warn(
			formatRequestLogLine(prepared.requestKind, 'Failed to report replay marker'),
			error,
		);
	}
}

function getReplayMarkerMetadata(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
): ReplayMarkerMetadata {
	return {
		...prepared.replayMarkerMetadata,
		reasoningText: state.accumulatedReasoning || undefined,
		...(prepared.usageCorrelation?.chatId && prepared.usageCorrelation?.taskId
			? {
					usage: {
						chatId: prepared.usageCorrelation.chatId,
						taskId: prepared.usageCorrelation.taskId,
					},
				}
			: {}),
		loadedTools: state.loadedToolNames?.(),
	};
}

function handleThinking(
	text: string,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	state.accumulatedReasoning += text;
	state.roundReasoning += text;
	progress.report(
		new vscode.LanguageModelThinkingPart(text) as unknown as vscode.LanguageModelResponsePart,
	);
}

function handleToolCall(
	toolCall: MetaToolCall,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	state.emittedToolCallIds.push(toolCall.id);

	try {
		const args = JSON.parse(toolCall.function.arguments);
		progress.report(
			new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, args),
		);
	} catch {
		progress.report(new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {}));
	}
}

function finalizeReplayDiagnostics(
	trailingToolResultIds: readonly string[],
	state: ResponseStreamState,
	cacheDiagnostics: CacheDiagnosticsRun,
): void {
	cacheDiagnostics.onDone({
		reasoningTextChars: state.accumulatedReasoning.length,
		emittedToolCalls: state.emittedToolCallIds.length,
		trailingToolResults: trailingToolResultIds.length,
	});
}

function updateCharsPerToken(
	totalRequestChars: number,
	usage: MetaUsage,
	charsPerToken: number,
): number {
	if (totalRequestChars > 0 && usage.prompt_tokens > 0) {
		const observedRatio = totalRequestChars / usage.prompt_tokens;
		return charsPerToken * 0.7 + observedRatio * 0.3;
	}
	return charsPerToken;
}

function reportCopilotContextUsage(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	usage: MetaUsage,
	requestKind: RequestKind,
): void {
	const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
	const data = {
		prompt_tokens: usage.prompt_tokens,
		completion_tokens: usage.completion_tokens,
		total_tokens: usage.total_tokens,
		prompt_tokens_details: {
			cached_tokens: cached,
		},
		completion_tokens_details: {
			reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
		},
	};

	try {
		progress.report(
			new vscode.LanguageModelDataPart(
				new TextEncoder().encode(JSON.stringify(data)),
				COPILOT_USAGE_DATA_PART_MIME,
			),
		);
	} catch (error) {
		logger.warn(formatRequestLogLine(requestKind, 'Failed to report usage data'), error);
	}
}
