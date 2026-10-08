import type { CancellationToken } from 'vscode';
import { t } from '../i18n';
import { safeStringify } from '../json';
import { logger } from '../logger';
import type {
    MetaApiProtocol,
    MetaRequest,
    MetaStreamChunk,
    MetaToolCall,
    MetaUsage,
    StreamCallbacks,
} from '../types';
import {
    createHttpError,
    formatRequestError,
    MetaRequestError,
    normalizeRequestError,
} from './error';
import {
    countReplayedReasoningItems,
    ResponsesStreamError,
    ResponsesStreamMapper,
    toResponsesRequest,
    type ResponsesRequestOptions,
    type ResponsesTerminal,
} from './responses';

/** Matches Meta's rejection of a replayed reasoning item (expired, foreign or corrupt). */
const REASONING_REJECTION_PATTERN = /reasoning|encrypted/i;

export class MetaClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		readonly protocol: MetaApiProtocol = 'chat-completions',
	) {}

	async streamChatCompletion(
		request: MetaRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
		responsesOptions?: ResponsesRequestOptions,
	): Promise<void> {
		const controller = new AbortController();
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});
		if (cancellationToken?.isCancellationRequested) {
			controller.abort();
		}

		try {
			if (this.protocol === 'responses') {
				await this.streamResponses(
					request,
					callbacks,
					controller,
					cancellationToken,
					responsesOptions,
				);
			} else {
				await this.streamChat(request, callbacks, controller, cancellationToken);
			}
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			const normalizedError = normalizeRequestError(toRequestError(error, this.baseUrl), {
				baseUrl: this.baseUrl,
				request,
			});
			logger.error('Meta request failed:', formatRequestError(normalizedError));
			callbacks.onError(normalizedError);
		} finally {
			cancelListener?.dispose();
		}
	}

	private async streamChat(
		request: MetaRequest,
		callbacks: StreamCallbacks,
		controller: AbortController,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const response = await this.post(
			'/chat/completions',
			{ ...request, stream_options: { include_usage: true } },
			controller,
		);
		if (!response.ok) {
			throw await createHttpError(response, { baseUrl: this.baseUrl, request });
		}

		let latestUsage: MetaUsage | undefined;
		const pendingToolCalls = new Map<number, MetaToolCall>();
		const flushToolCalls = (): void => {
			for (const tc of pendingToolCalls.values()) {
				callbacks.onToolCall(tc);
			}
			pendingToolCalls.clear();
		};

		const finished = await readServerSentEvents(response, controller, cancellationToken, (data) => {
			if (data === '[DONE]') {
				flushToolCalls();
				return true;
			}
			try {
				const chunk: MetaStreamChunk = JSON.parse(data);
				const choice = chunk.choices?.[0];

				if (chunk.usage) {
					latestUsage = chunk.usage;
				}

				if (!choice) {
					return false;
				}

				const reasoning = choice.delta.reasoning_content;
				if (reasoning) {
					callbacks.onThinking(reasoning);
				}

				if (choice.delta.content) {
					callbacks.onContent(choice.delta.content);
				}

				if (choice.delta.tool_calls) {
					for (const tc of choice.delta.tool_calls) {
						let pending = pendingToolCalls.get(tc.index);
						if (!pending && tc.id) {
							pending = {
								id: tc.id,
								type: 'function',
								function: { name: '', arguments: '' },
							};
							pendingToolCalls.set(tc.index, pending);
						}
						if (pending) {
							if (tc.function?.name) {
								pending.function.name += tc.function.name;
							}
							if (tc.function?.arguments) {
								pending.function.arguments += tc.function.arguments;
							}
						}
					}
				}

				if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
					flushToolCalls();
				}
			} catch (e) {
				logger.error('Failed to parse SSE chunk:', data.slice(0, 200), e);
			}
			return false;
		});
		if (finished === 'cancelled') {
			return;
		}

		reportFinalUsage(callbacks, latestUsage);
		callbacks.onDone();
	}

	private async streamResponses(
		request: MetaRequest,
		callbacks: StreamCallbacks,
		controller: AbortController,
		cancellationToken?: CancellationToken,
		options: ResponsesRequestOptions = {},
	): Promise<void> {
		let body = toResponsesRequest(request, options);
		let response = await this.post('/responses', body, controller);
		const replayedItems = countReplayedReasoningItems(body);
		if (!response.ok && response.status === 400 && replayedItems > 0) {
			const errorText = await response.clone().text();
			if (REASONING_REJECTION_PATTERN.test(errorText)) {
				logger.warn(
					`[reasoning-replay] Meta rejected ${replayedItems} replayed reasoning item(s); retrying once without them.`,
					errorText.slice(0, 300),
				);
				body = toResponsesRequest(request, { ...options, omitReasoning: true });
				response = await this.post('/responses', body, controller);
			}
		}
		if (!response.ok) {
			throw await createHttpError(response, { baseUrl: this.baseUrl, request });
		}

		const mapper = new ResponsesStreamMapper(callbacks);
		let terminal: ResponsesTerminal | undefined;
		const finished = await readServerSentEvents(response, controller, cancellationToken, (data) => {
			if (data === '[DONE]') {
				return true;
			}
			let event: unknown;
			try {
				event = JSON.parse(data);
			} catch (e) {
				logger.error('Failed to parse Responses SSE event:', data.slice(0, 200), e);
				return false;
			}
			terminal = mapper.handle(event as Parameters<ResponsesStreamMapper['handle']>[0]) ?? terminal;
			return false;
		});
		if (finished === 'cancelled') {
			return;
		}
		if (terminal?.status === 'incomplete') {
			logger.warn(
				`Meta response incomplete: reason=${terminal.incompleteReason ?? 'unknown'}`,
			);
		}

		reportFinalUsage(callbacks, mapper.latestUsage);
		callbacks.onDone();
	}

	private post(path: string, body: unknown, controller: AbortController): Promise<Response> {
		return fetch(`${this.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: safeStringify(body),
			signal: controller.signal,
		});
	}
}

/**
 * Reads `data:` lines until `onData` returns true, the body ends, or cancellation. Returns
 * `'cancelled'` when cancellation stopped the read.
 */
async function readServerSentEvents(
	response: Response,
	controller: AbortController,
	cancellationToken: CancellationToken | undefined,
	onData: (data: string) => boolean,
): Promise<'done' | 'ended' | 'cancelled'> {
	if (!response.body) {
		throw new Error('No response body received');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		if (cancellationToken?.isCancellationRequested) {
			controller.abort();
			return 'cancelled';
		}

		const { done, value } = await reader.read();
		if (done) {
			return 'ended';
		}

		buffer += decoder.decode(value, { stream: true });

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) {
				continue;
			}
			if (onData(trimmed.slice(5).trimStart())) {
				return 'done';
			}
		}
	}
}

function toRequestError(error: unknown, baseUrl: string): unknown {
	if (!(error instanceof ResponsesStreamError)) {
		return error;
	}
	const detail = error.code ? `${error.code}: ${error.message}` : error.message;
	return new MetaRequestError({
		message: `Meta response failed during streaming (${error.code ?? 'unknown'})`,
		userSummary: t('error.unknown', detail),
		kind: 'unknown',
		baseUrl,
		code: error.code,
		diagnosticMessage: `kind=stream code=${safeStringify(error.code ?? 'unknown')} message=${safeStringify(error.message)}`,
	});
}

function reportFinalUsage(callbacks: StreamCallbacks, usage: MetaUsage | undefined): void {
	if (!usage || !callbacks.onUsage) {
		return;
	}
	callbacks.onUsage(usage);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}
