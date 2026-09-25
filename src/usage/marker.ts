import vscode from 'vscode';
import {
	buildMarkerPayload,
	parseMarkerPayload,
	serializeMarkerPayload,
	USAGE_CONTEXT_WRITER,
	type UsageMarkerParseResult,
} from './context';

/**
 * Usage-correlation marker adapter.
 *
 * R7 unified transport: correlation rides inside the supported
 * `stateful_marker` payload (replay marker) so the Agent Host BYOK bridge
 * carries it forward as conversation state. The legacy standalone
 * `meta-spark-usage-context` MIME is still parsed for backward compatibility
 * with ledgers/markers written before the repair, but it is never emitted.
 */
export const USAGE_MARKER_MIME = 'meta-spark-usage-context';

/**
 * Legacy emitter retained only so existing tests can prove it is no longer
 * used by the provider path. New code must use the unified stateful marker.
 */
export function createUsageMarkerPart(chatId: string, taskId: string): unknown {
	const payload = serializeMarkerPayload(buildMarkerPayload(chatId, taskId));
	const data = new TextEncoder().encode(`${USAGE_CONTEXT_WRITER}\\${payload}`);
	return new vscode.LanguageModelDataPart(data, USAGE_MARKER_MIME);
}

export function isUsageMarkerPart(part: unknown): boolean {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType === USAGE_MARKER_MIME;
}

export function parseUsageMarkerData(data: Uint8Array): UsageMarkerParseResult {
	const decoded = new TextDecoder().decode(data);
	const separatorIndex = decoded.indexOf('\\');
	if (separatorIndex < 0) {
		return { valid: false, error: 'marker-prefix-missing' };
	}
	const prefix = decoded.slice(0, separatorIndex);
	if (prefix !== USAGE_CONTEXT_WRITER) {
		return { valid: false, error: 'marker-prefix-mismatch' };
	}
	return parseMarkerPayload(decoded.slice(separatorIndex + 1));
}

export function parseUsageMarkerPart(part: unknown): UsageMarkerParseResult | undefined {
	if (!isUsageMarkerPart(part)) {
		return undefined;
	}
	const dataPart = part as vscode.LanguageModelDataPart;
	return parseUsageMarkerData(dataPart.data);
}

/**
 * Parse the unified `stateful_marker` transport for usage correlation.
 * Returns the embedded chat/task IDs when present and valid, undefined when
 * the part is not a stateful marker at all, and an invalid result when the
 * marker parses but carries unusable usage metadata.
 */
export function parseStatefulUsageMarkerPart(part: unknown): UsageMarkerParseResult | undefined {
	let data: Uint8Array | undefined;
	try {
		const vscodeApi = vscode as unknown as {
			LanguageModelDataPart?: new (data: Uint8Array, mimeType: string) => unknown;
		};
		if (
			typeof vscodeApi.LanguageModelDataPart === 'function' &&
			part instanceof vscodeApi.LanguageModelDataPart
		) {
			const dataPart = part as { mimeType?: unknown; data?: unknown };
			if (dataPart.mimeType !== 'stateful_marker' || !(dataPart.data instanceof Uint8Array)) {
				return undefined;
			}
			data = dataPart.data;
		} else {
			const candidate = part as { mimeType?: unknown; data?: unknown };
			if (candidate?.mimeType !== 'stateful_marker' || !(candidate?.data instanceof Uint8Array)) {
				return undefined;
			}
			data = candidate.data;
		}
	} catch {
		return undefined;
	}
	if (!data) {
		return undefined;
	}
	const decoded = new TextDecoder().decode(data);
	const separatorIndex = decoded.indexOf('\\');
	if (separatorIndex < 0) {
		return undefined;
	}
	const payloadText = decoded.slice(separatorIndex + 1);
	const usage = extractUsageFromStatefulPayload(payloadText);
	if (!usage) {
		return undefined;
	}
	return usage;
}

function extractUsageFromStatefulPayload(payloadText: string): UsageMarkerParseResult | undefined {
	const stripped = payloadText.startsWith('json:') ? decodeJsonPrefix(payloadText) : payloadText;
	if (stripped === undefined) {
		return { valid: false, error: 'marker-json-base64-invalid' };
	}
	let value: unknown;
	try {
		value = JSON.parse(stripped);
	} catch {
		// Raw UUID / non-JSON stateful payloads carry no usage correlation.
		return undefined;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const usage = (value as { usage?: unknown }).usage;
	if (usage === undefined) {
		return undefined;
	}
	if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
		return { valid: false, error: 'marker-payload-not-object' };
	}
	const record = usage as Record<string, unknown>;
	if (record.version !== 1) {
		return { valid: false, error: 'marker-version-mismatch' };
	}
	if (record.writer !== USAGE_CONTEXT_WRITER) {
		return { valid: false, error: 'marker-writer-mismatch' };
	}
	const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (typeof record.chatId !== 'string' || !uuidPattern.test(record.chatId)) {
		return { valid: false, error: 'marker-chat-id-invalid' };
	}
	if (typeof record.taskId !== 'string' || !uuidPattern.test(record.taskId)) {
		return { valid: false, error: 'marker-task-id-invalid' };
	}
	return {
		valid: true,
		chatId: (record.chatId as string).toLowerCase(),
		taskId: (record.taskId as string).toLowerCase(),
		version: 1,
		writer: USAGE_CONTEXT_WRITER,
	};
}

function decodeJsonPrefix(payloadText: string): string | undefined {
	const encoded = payloadText.slice('json:'.length);
	if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
		return undefined;
	}
	try {
		const binary = base64UrlToBinary(encoded);
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

function base64UrlToBinary(encoded: string): string {
	const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const lookup = new Map<string, number>([...chars].map((c, i) => [c, i]));
	let bits = 0;
	let bitCount = 0;
	let out = '';
	for (const ch of padded) {
		if (ch === '=') {
			break;
		}
		const value = lookup.get(ch);
		if (value === undefined) {
			throw new Error('invalid-base64');
		}
		bits = (bits << 6) | value;
		bitCount += 6;
		if (bitCount >= 8) {
			bitCount -= 8;
			out += String.fromCharCode((bits >> bitCount) & 0xff);
		}
	}
	return out;
}

/**
 * Scan history oldest→newest and return the most recent valid marker.
 * Invalid markers are ignored (never treated as correlation evidence).
 * The unified `stateful_marker` transport is preferred; the legacy
 * standalone MIME is accepted only for backward compatibility.
 */
export function findLatestUsageMarker(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): UsageMarkerParseResult | undefined {
	let latest: UsageMarkerParseResult | undefined;
	for (const message of messages) {
		if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of message.content) {
			const parsed = parseStatefulUsageMarkerPart(part) ?? parseUsageMarkerPart(part);
			if (parsed?.valid) {
				latest = parsed;
			}
		}
	}
	return latest;
}
