import { createHash } from 'node:crypto';
import { isSubstantiveHumanTurn, normalizePreview, type CorrelationMessage } from './context';

const AGENT_HOST_PREFIX = 'You are an AI assistant using Copilot SDK';
const SESSION_FOLDER =
	/^Session folder: +(?:[a-z]:\/|\/)[^\r\n]*\/\.copilot\/session-state\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?\s*$/i;
const TURN_STAMP =
	/^\s*<current_datetime>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))<\/current_datetime>/;

/**
 * The observed Copilot SDK replays full history without previous_response_id.
 * Its system session_context contains the SDK session folder UUID; each human
 * input retains its original current_datetime. These are session/turn signals,
 * not prompt similarity or a wall-clock proximity heuristic. Only the caller's
 * already-classified main-agent requests may use this marker-free fallback.
 * Missing or ambiguous host fields deliberately yield no inferred identity.
 */
export function findAgentHostUsageIdentity(
	messages: readonly CorrelationMessage[],
	projectId: string,
): { chatId: string; taskId: string; nativeSessionId: string; preview: string } | undefined {
	const systems = messages.filter((message) => message.role === 'system');
	if (systems.length !== 1 || !systems[0].text.trimStart().startsWith(AGENT_HOST_PREFIX)) {
		return undefined;
	}
	const blocks = [
		...systems[0].text.matchAll(/<session_context>\s*([\s\S]*?)<\/session_context>/g),
	];
	if (blocks.length !== 1) {
		return undefined;
	}
	const folderLines = blocks[0][1]
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^Session folder:/i.test(line));
	if (folderLines.length !== 1) {
		return undefined;
	}
	const session = SESSION_FOLDER.exec(folderLines[0].replace(/\\/g, '/'))?.[1]?.toLowerCase();
	if (!session) {
		return undefined;
	}
	const turns = messages.filter(isSubstantiveHumanTurn);
	const latest = turns.at(-1);
	if (!latest) {
		return undefined;
	}
	const stamp = parseTurnStamp(latest.text);
	if (!stamp) {
		return undefined;
	}
	// Normally each host stamp is unique. Preserve distinct replay entries even
	// if two human turns share a stamp (e.g. imported history or coarse clocks).
	const occurrence = turns.filter((turn) => parseTurnStamp(turn.text) === stamp).length;
	const chatId = identityUuid(['agent-host-chat-v1', projectId, session]);
	return {
		chatId,
		taskId: identityUuid(['agent-host-task-v1', chatId, stamp, String(occurrence)]),
		nativeSessionId: session,
		preview: normalizePreview(latest.text),
	};
}

function parseTurnStamp(text: string): string | undefined {
	const raw = TURN_STAMP.exec(text)?.[1];
	if (!raw || !Number.isFinite(Date.parse(raw))) {
		return undefined;
	}
	return new Date(raw).toISOString();
}

/** Domain-separated, deterministic UUIDv8; no path or prompt is persisted. */
function identityUuid(parts: string[]): string {
	const bytes = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x80;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
