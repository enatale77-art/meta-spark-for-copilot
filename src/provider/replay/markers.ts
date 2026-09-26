import vscode from 'vscode';
import { safeStringify } from '../../json';
import {
	BASE64URL_PATTERN,
	ENCODED_JSON_MARKER_PREFIX,
	LEGACY_SEGMENT_ID_PATTERN,
	REPLAY_MARKER_MIME,
	REPLAY_MARKER_PREFIXES,
	REPLAY_MARKER_WRITER_ID,
} from './consts';
import type {
	LocatedReplayMarker,
	ReasoningMarkerTextIgnoredReason,
	ReplayMarkerMetadata,
	ReplayMarkerParseResult,
	ReplayMarkerPayloadFormat,
	UsageCorrelationMetadata,
	UsageMarkerTextIgnoredReason,
	VisionMarkerTextIgnoredReason,
} from './types';

export function findFirstReplayMarker(
	message: vscode.LanguageModelChatRequestMessage,
): LocatedReplayMarker | undefined {
	for (const [partIndex, part] of message.content.entries()) {
		const marker = parseReplayMarkerPart(part);
		if (marker) {
			return { partIndex, marker };
		}
	}
	return undefined;
}

export function parseFirstReplayMarker(
	message: vscode.LanguageModelChatRequestMessage,
): ReplayMarkerParseResult | undefined {
	return findFirstReplayMarker(message)?.marker;
}

function parseReplayMarkerPart(part: unknown): ReplayMarkerParseResult | undefined {
	if (!(part instanceof vscode.LanguageModelDataPart)) {
		return undefined;
	}
	if (part.mimeType !== REPLAY_MARKER_MIME) {
		return undefined;
	}
	return parseReplayMarkerData(part.data);
}

export function hasReplayMarkerMetadata(metadata: ReplayMarkerMetadata): boolean {
	return Boolean(
		metadata.visionText ||
		metadata.reasoningText ||
		metadata.usage?.chatId ||
		metadata.usage?.taskId,
	);
}

export function createReplayMarkerPart(
	metadata: ReplayMarkerMetadata,
	prefix?: string,
): vscode.LanguageModelDataPart {
	const payload = encodeReplayMarkerJson({
		...createVisionMarkerPayload(metadata.visionText),
		...createReasoningMarkerPayload(metadata.reasoningText),
		...createUsageMarkerPayload(metadata.usage),
	});
	const writerPrefix = prefix && prefix.length > 0 ? prefix : REPLAY_MARKER_WRITER_ID;
	return new vscode.LanguageModelDataPart(
		new TextEncoder().encode(`${writerPrefix}\\${payload}`),
		REPLAY_MARKER_MIME,
	);
}

export function parseReplayMarkerData(data: Uint8Array): ReplayMarkerParseResult {
	const decoded = new TextDecoder().decode(data);
	const separatorIndex = decoded.indexOf('\\');
	if (separatorIndex < 0) {
		return { valid: false, error: 'marker-prefix-missing' };
	}

	const markerPrefix = decoded.slice(0, separatorIndex);
	if (!REPLAY_MARKER_PREFIXES.has(markerPrefix)) {
		return { valid: false, error: 'marker-prefix-mismatch' };
	}

	const markerPayload = decoded.slice(separatorIndex + 1);
	const decodedPayload = decodeReplayMarkerPayload(markerPayload);
	if (!decodedPayload.valid) {
		return { valid: false, error: decodedPayload.error };
	}
	const payload = decodedPayload.value;

	if (isValidLegacySegmentId(payload)) {
		return {
			valid: true,
			segmentId: payload.toLowerCase(),
			legacySegmentOnly: true,
			payloadFormat: decodedPayload.format,
		};
	}

	try {
		const value = JSON.parse(payload) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { valid: false, error: 'marker-payload-not-object' };
		}

		const segmentId = parseOptionalSegmentId(value);
		if (segmentId.error) {
			return { valid: false, error: segmentId.error };
		}

		const vision = parseVisionMarkerMetadata(value);
		const reasoning = parseReasoningMarkerMetadata(value);
		const usage = parseUsageMarkerMetadata(value);
		return {
			valid: true,
			segmentId: segmentId.value,
			...vision,
			...reasoning,
			...(usage.usageChatId || usage.usageTaskId
				? { usageChatId: usage.usageChatId, usageTaskId: usage.usageTaskId }
				: {}),
			...(usage.usageIgnoredReason ? { usageIgnoredReason: usage.usageIgnoredReason } : {}),
			legacySegmentOnly: Boolean(
				segmentId.value && !vision.visionText && !reasoning.reasoningText && !usage.usageChatId,
			),
			payloadFormat: decodedPayload.format,
		};
	} catch {
		return { valid: false, error: 'marker-json-invalid' };
	}
}

function parseOptionalSegmentId(value: object): {
	value?: string;
	error?: 'segment-id-not-string' | 'segment-id-not-uuid';
} {
	const segmentId = (value as { segmentId?: unknown }).segmentId;
	if (segmentId === undefined) {
		return {};
	}
	if (typeof segmentId !== 'string') {
		return { error: 'segment-id-not-string' };
	}
	if (!isValidLegacySegmentId(segmentId)) {
		return { error: 'segment-id-not-uuid' };
	}
	return { value: segmentId.toLowerCase() };
}

function createVisionMarkerPayload(visionText: string | undefined): object {
	return visionText ? { vision: { text: visionText } } : {};
}

function parseVisionMarkerMetadata(value: object): {
	visionText?: string;
	visionTextIgnoredReason?: VisionMarkerTextIgnoredReason;
} {
	const vision = (value as { vision?: unknown }).vision;
	if (vision === undefined) {
		return {};
	}
	if (!vision || typeof vision !== 'object' || Array.isArray(vision)) {
		return { visionTextIgnoredReason: 'vision-not-object' };
	}

	const text = (vision as { text?: unknown }).text;
	if (typeof text !== 'string') {
		return { visionTextIgnoredReason: 'vision-text-not-string' };
	}
	if (text.length === 0) {
		return { visionTextIgnoredReason: 'vision-text-empty' };
	}

	return { visionText: text };
}

function createReasoningMarkerPayload(reasoningText: string | undefined): object {
	return reasoningText ? { reasoning: { text: reasoningText } } : {};
}

function createUsageMarkerPayload(usage: UsageCorrelationMetadata | undefined): object {
	if (!usage?.chatId || !usage?.taskId) {
		return {};
	}
	return {
		usage: {
			version: 1,
			writer: 'meta-spark-for-copilot',
			chatId: usage.chatId,
			taskId: usage.taskId,
		},
	};
}

function parseUsageMarkerMetadata(value: object): {
	usageChatId?: string;
	usageTaskId?: string;
	usageIgnoredReason?: UsageMarkerTextIgnoredReason;
} {
	const usage = (value as { usage?: unknown }).usage;
	if (usage === undefined) {
		return {};
	}
	if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
		return { usageIgnoredReason: 'usage-not-object' };
	}
	const record = usage as Record<string, unknown>;
	if (record.version !== 1) {
		return { usageIgnoredReason: 'usage-version-mismatch' };
	}
	if (record.writer !== 'meta-spark-for-copilot') {
		return { usageIgnoredReason: 'usage-writer-mismatch' };
	}
	if (typeof record.chatId !== 'string' || !LEGACY_SEGMENT_ID_PATTERN.test(record.chatId)) {
		return { usageIgnoredReason: 'usage-chat-id-invalid' };
	}
	if (typeof record.taskId !== 'string' || !LEGACY_SEGMENT_ID_PATTERN.test(record.taskId)) {
		return { usageIgnoredReason: 'usage-task-id-invalid' };
	}
	return {
		usageChatId: (record.chatId as string).toLowerCase(),
		usageTaskId: (record.taskId as string).toLowerCase(),
	};
}

function parseReasoningMarkerMetadata(value: object): {
	reasoningText?: string;
	reasoningTextIgnoredReason?: ReasoningMarkerTextIgnoredReason;
} {
	const reasoning = (value as { reasoning?: unknown }).reasoning;
	if (reasoning === undefined) {
		return {};
	}
	if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
		return { reasoningTextIgnoredReason: 'reasoning-not-object' };
	}

	const text = (reasoning as { text?: unknown }).text;
	if (typeof text !== 'string') {
		return { reasoningTextIgnoredReason: 'reasoning-text-not-string' };
	}
	if (text.length === 0) {
		return { reasoningTextIgnoredReason: 'reasoning-text-empty' };
	}

	return { reasoningText: text };
}

function encodeReplayMarkerJson(value: object): string {
	const json = safeStringify(value);
	return `${ENCODED_JSON_MARKER_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

function decodeReplayMarkerPayload(
	markerPayload: string,
):
	| { valid: true; value: string; format: ReplayMarkerPayloadFormat }
	| { valid: false; error: string } {
	if (!markerPayload.startsWith(ENCODED_JSON_MARKER_PREFIX)) {
		return {
			valid: true,
			value: markerPayload,
			format: isValidLegacySegmentId(markerPayload) ? 'raw-uuid' : 'raw-json',
		};
	}

	const encodedPayload = markerPayload.slice(ENCODED_JSON_MARKER_PREFIX.length);
	if (!encodedPayload || !BASE64URL_PATTERN.test(encodedPayload)) {
		return { valid: false, error: 'marker-json-base64-invalid' };
	}

	try {
		return {
			valid: true,
			value: Buffer.from(encodedPayload, 'base64url').toString('utf8'),
			format: 'json-base64url',
		};
	} catch {
		return { valid: false, error: 'marker-json-base64-invalid' };
	}
}

function isValidLegacySegmentId(value: string): boolean {
	return LEGACY_SEGMENT_ID_PATTERN.test(value);
}
