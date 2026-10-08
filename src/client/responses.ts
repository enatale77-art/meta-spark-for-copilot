import { createHash } from 'node:crypto';
import type {
	MetaMessage,
	MetaReasoningItem,
	MetaRequest,
	MetaToolCall,
	MetaUsage,
	StreamCallbacks,
} from '../types';

/**
 * Meta Responses API (`POST /responses`) translation.
 *
 * The provider keeps building Chat Completions-shaped `MetaRequest`s; this module converts one into a
 * stateless Responses request (`store: false` + encrypted reasoning) and maps Responses stream
 * events back onto the same `StreamCallbacks`. Structure rules enforced by Meta (HTTP 400 otherwise):
 * - assistant text that precedes a `function_call` is `phase: "commentary"`;
 * - a `reasoning` item is followed by an assistant message or `function_call`;
 * - every `function_call_output.call_id` matches a `function_call.call_id` (1–64 chars).
 */

export const RESPONSES_REASONING_INCLUDE = 'reasoning.encrypted_content';
const MAX_CALL_ID_LENGTH = 64;
const MISSING_TOOL_OUTPUT = 'No result was recorded for this tool call.';

type ResponsesContentPart =
	| { type: 'input_text'; text: string }
	| { type: 'input_image'; image_url: string }
	| { type: 'output_text'; text: string };

export type ResponsesInputItem =
	| {
			type: 'message';
			role: 'developer' | 'system' | 'user' | 'assistant';
			content: ResponsesContentPart[];
			phase?: 'commentary';
	  }
	| MetaReasoningItem
	| { type: 'function_call'; call_id: string; name: string; arguments: string }
	| { type: 'function_call_output'; call_id: string; output: string };

export interface ResponsesRequestBody {
	model: string;
	input: ResponsesInputItem[];
	stream: true;
	store: false;
	include: string[];
	tools?: Array<{
		type: 'function';
		name: string;
		description?: string;
		parameters: Record<string, unknown>;
	}>;
	tool_choice?: 'auto';
	reasoning?: { effort?: string; summary?: 'auto' };
	max_output_tokens?: number;
	prompt_cache_key?: string;
}

export interface ResponsesRequestOptions {
	/** Request a short reasoning summary (streamed as thinking). */
	reasoningSummary?: boolean;
	/** Drop replayed reasoning items, e.g. after Meta rejected them. */
	omitReasoning?: boolean;
}

export function toResponsesRequest(
	request: MetaRequest,
	options: ResponsesRequestOptions = {},
): ResponsesRequestBody {
	const effort = request.reasoning_effort;
	const maxOutputTokens = request.max_completion_tokens ?? request.max_tokens;
	return {
		model: request.model,
		input: toResponsesInput(request.messages, options.omitReasoning === true),
		stream: true,
		store: false,
		include: [RESPONSES_REASONING_INCLUDE],
		...(request.tools && request.tools.length > 0
			? {
					tools: request.tools.map((tool) => ({
						type: 'function' as const,
						name: tool.function.name,
						...(tool.function.description ? { description: tool.function.description } : {}),
						parameters: tool.function.parameters ?? { type: 'object', properties: {} },
					})),
					tool_choice: 'auto' as const,
				}
			: {}),
		...(effort || options.reasoningSummary
			? {
					reasoning: {
						...(effort ? { effort } : {}),
						...(options.reasoningSummary ? { summary: 'auto' as const } : {}),
					},
				}
			: {}),
		...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
		...(request.prompt_cache_key ? { prompt_cache_key: request.prompt_cache_key } : {}),
	};
}

export function countReplayedReasoningItems(body: ResponsesRequestBody): number {
	return body.input.filter((item) => item.type === 'reasoning').length;
}

function toResponsesInput(messages: readonly MetaMessage[], omitReasoning: boolean): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];
	const seenReasoningIds = new Set<string>();

	for (const message of messages) {
		switch (message.role) {
			case 'assistant': {
				const text = contentText(message.content);
				const toolCalls = message.tool_calls ?? [];
				if (!text && toolCalls.length === 0) {
					// A reasoning item must be followed by output; nothing to anchor it to.
					break;
				}
				if (!omitReasoning) {
					for (const reasoning of message.reasoning_items ?? []) {
						if (!reasoning.encrypted_content) {
							continue;
						}
						if (reasoning.id) {
							if (seenReasoningIds.has(reasoning.id)) {
								continue;
							}
							seenReasoningIds.add(reasoning.id);
						}
						items.push({
							type: 'reasoning',
							...(reasoning.id ? { id: reasoning.id } : {}),
							summary: reasoning.summary ?? [],
							encrypted_content: reasoning.encrypted_content,
						});
					}
				}
				if (text) {
					items.push({
						type: 'message',
						role: 'assistant',
						content: [{ type: 'output_text', text }],
						...(toolCalls.length > 0 ? { phase: 'commentary' as const } : {}),
					});
				}
				for (const call of toolCalls) {
					items.push({
						type: 'function_call',
						call_id: normalizeCallId(call.id),
						name: call.function.name,
						arguments: call.function.arguments || '{}',
					});
				}
				break;
			}
			case 'tool':
				items.push({
					type: 'function_call_output',
					call_id: normalizeCallId(message.tool_call_id ?? ''),
					output: contentText(message.content),
				});
				break;
			default: {
				const content = toInputContent(message.content);
				if (content.length > 0) {
					items.push({ type: 'message', role: message.role, content });
				}
			}
		}
	}

	return repairToolPairing(items);
}

/**
 * Meta rejects outputs without a matching call. Unmatched outputs become user text so their content
 * is not lost; calls without an output get a placeholder output after their call group.
 */
function repairToolPairing(items: ResponsesInputItem[]): ResponsesInputItem[] {
	const callIds = new Set<string>();
	const outputIds = new Set<string>();
	for (const item of items) {
		if (item.type === 'function_call') {
			callIds.add(item.call_id);
		} else if (item.type === 'function_call_output') {
			outputIds.add(item.call_id);
		}
	}

	const repaired: ResponsesInputItem[] = [];
	let missing: string[] = [];
	const flushMissing = (): void => {
		for (const callId of missing) {
			repaired.push({ type: 'function_call_output', call_id: callId, output: MISSING_TOOL_OUTPUT });
		}
		missing = [];
	};
	for (const item of items) {
		const inCallGroup = item.type === 'function_call' || item.type === 'function_call_output';
		if (!inCallGroup) {
			flushMissing();
		}
		if (item.type === 'function_call_output' && !callIds.has(item.call_id)) {
			flushMissing();
			repaired.push({
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: `Tool result (${item.call_id}):\n${item.output}` }],
			});
			continue;
		}
		if (item.type === 'function_call' && !outputIds.has(item.call_id)) {
			missing.push(item.call_id);
		}
		repaired.push(item);
	}
	flushMissing();
	return repaired;
}

/** Keeps valid IDs unchanged; maps empty or over-length IDs to a stable short ID on both sides. */
export function normalizeCallId(callId: string): string {
	if (callId.length > 0 && callId.length <= MAX_CALL_ID_LENGTH) {
		return callId;
	}
	return `call_${createHash('sha256').update(callId).digest('hex').slice(0, 32)}`;
}

function contentText(content: MetaMessage['content']): string {
	if (typeof content === 'string') {
		return content;
	}
	return content
		.map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
		.join('');
}

function toInputContent(content: MetaMessage['content']): ResponsesContentPart[] {
	if (typeof content === 'string') {
		return content ? [{ type: 'input_text', text: content }] : [];
	}
	const parts: ResponsesContentPart[] = [];
	for (const part of content) {
		if (part.type === 'text') {
			if (part.text) {
				parts.push({ type: 'input_text', text: part.text });
			}
		} else if (part.type === 'image_url') {
			parts.push({ type: 'input_image', image_url: part.image_url.url });
		}
	}
	return parts;
}

interface ResponsesStreamEvent {
	type?: string;
	delta?: string;
	item_id?: string;
	output_index?: number;
	summary_index?: number;
	item?: ResponsesOutputItem;
	response?: {
		status?: string;
		output?: ResponsesOutputItem[];
		usage?: ResponsesUsage;
		error?: { code?: string; message?: string } | null;
		incomplete_details?: { reason?: string } | null;
	};
	code?: string;
	message?: string;
	error?: { code?: string; message?: string };
}

interface ResponsesOutputItem {
	type?: string;
	id?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	summary?: Array<{ type?: string; text?: string }>;
	encrypted_content?: string | null;
}

interface ResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
	output_tokens_details?: { reasoning_tokens?: number };
}

export class ResponsesStreamError extends Error {
	constructor(
		message: string,
		readonly code: string | undefined,
	) {
		super(message);
		this.name = 'ResponsesStreamError';
	}
}

export interface ResponsesTerminal {
	status: 'completed' | 'incomplete';
	incompleteReason?: string;
}

/**
 * Stateful mapper from Responses stream events to `StreamCallbacks`. `handle()` returns a terminal
 * result once the response completes; the caller then reports usage and `onDone`.
 */
export class ResponsesStreamMapper {
	private readonly pendingCalls = new Map<string, { callId: string; name: string; arguments: string }>();
	private readonly emittedCallIds = new Set<string>();
	private readonly emittedReasoning = new Set<string>();
	private usage: MetaUsage | undefined;

	constructor(private readonly callbacks: StreamCallbacks) {}

	get latestUsage(): MetaUsage | undefined {
		return this.usage;
	}

	handle(event: ResponsesStreamEvent): ResponsesTerminal | undefined {
		switch (event.type) {
			case 'response.output_text.delta':
				if (event.delta) {
					this.callbacks.onContent(event.delta);
				}
				return undefined;
			case 'response.reasoning_summary_text.delta':
				if (event.delta) {
					this.callbacks.onThinking(event.delta);
				}
				return undefined;
			case 'response.reasoning_summary_part.added':
				if ((event.summary_index ?? 0) > 0) {
					this.callbacks.onThinking('\n\n');
				}
				return undefined;
			case 'response.output_item.added':
				if (event.item?.type === 'function_call') {
					this.pendingCalls.set(itemKey(event), {
						callId: event.item.call_id ?? '',
						name: event.item.name ?? '',
						arguments: event.item.arguments ?? '',
					});
				}
				return undefined;
			case 'response.function_call_arguments.delta': {
				const pending = this.pendingCalls.get(itemKey(event));
				if (pending && event.delta) {
					pending.arguments += event.delta;
				}
				return undefined;
			}
			case 'response.output_item.done':
				if (event.item) {
					this.handleOutputItem(event.item, this.pendingCalls.get(itemKey(event)));
					this.pendingCalls.delete(itemKey(event));
				}
				return undefined;
			case 'response.completed':
			case 'response.incomplete': {
				for (const item of event.response?.output ?? []) {
					this.handleOutputItem(item);
				}
				for (const pending of this.pendingCalls.values()) {
					this.emitToolCall(pending.callId, pending.name, pending.arguments);
				}
				this.pendingCalls.clear();
				this.usage = toMetaUsage(event.response?.usage) ?? this.usage;
				return event.type === 'response.completed'
					? { status: 'completed' }
					: {
							status: 'incomplete',
							incompleteReason: event.response?.incomplete_details?.reason ?? undefined,
						};
			}
			case 'response.failed': {
				const error = event.response?.error;
				throw new ResponsesStreamError(
					error?.message || 'Meta response failed',
					error?.code ?? undefined,
				);
			}
			case 'error':
				throw new ResponsesStreamError(
					event.message || event.error?.message || 'Meta stream error',
					event.code ?? event.error?.code,
				);
			default:
				return undefined;
		}
	}

	private handleOutputItem(
		item: ResponsesOutputItem,
		pending?: { callId: string; name: string; arguments: string },
	): void {
		if (item.type === 'function_call') {
			this.emitToolCall(
				item.call_id || pending?.callId || '',
				item.name || pending?.name || '',
				item.arguments ?? pending?.arguments ?? '',
			);
			return;
		}
		if (item.type === 'reasoning' && item.encrypted_content) {
			const key = item.id ?? item.encrypted_content;
			if (this.emittedReasoning.has(key)) {
				return;
			}
			this.emittedReasoning.add(key);
			this.callbacks.onReasoningItem?.({
				type: 'reasoning',
				...(item.id ? { id: item.id } : {}),
				summary: (item.summary ?? [])
					.filter((part) => typeof part.text === 'string')
					.map((part) => ({ type: 'summary_text' as const, text: part.text as string })),
				encrypted_content: item.encrypted_content,
			});
		}
	}

	private emitToolCall(callId: string, name: string, args: string): void {
		if (!callId || !name || this.emittedCallIds.has(callId)) {
			return;
		}
		this.emittedCallIds.add(callId);
		const toolCall: MetaToolCall = {
			id: callId,
			type: 'function',
			function: { name, arguments: args },
		};
		this.callbacks.onToolCall(toolCall);
	}
}

/** `output_index` is on every item-scoped event; item IDs are the fallback. */
function itemKey(event: ResponsesStreamEvent): string {
	if (typeof event.output_index === 'number') {
		return `#${event.output_index}`;
	}
	return event.item_id ?? event.item?.id ?? '#unknown';
}

function toMetaUsage(usage: ResponsesUsage | undefined): MetaUsage | undefined {
	if (!usage) {
		return undefined;
	}
	const prompt = usage.input_tokens ?? 0;
	const completion = usage.output_tokens ?? 0;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: usage.total_tokens ?? prompt + completion,
		prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
		completion_tokens_details: {
			reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
		},
	};
}
