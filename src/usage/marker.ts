import vscode from 'vscode';
import {
	buildMarkerPayload,
	parseMarkerPayload,
	serializeMarkerPayload,
	USAGE_CONTEXT_WRITER,
	type UsageMarkerParseResult,
} from './context';

/**
 * VS Code `LanguageModelDataPart` adapter for the usage-context marker.
 * Independent of the replay-marker transport: it always carries only
 * correlation metadata ({version, writer, chatId, taskId}).
 */
export const USAGE_MARKER_MIME = 'meta-spark-usage-context';

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
 * Scan history oldest→newest and return the most recent valid marker.
 * Invalid markers are ignored (never treated as correlation evidence).
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
			const parsed = parseUsageMarkerPart(part);
			if (parsed?.valid) {
				latest = parsed;
			}
		}
	}
	return latest;
}
