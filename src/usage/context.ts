import { createHash, randomUUID } from 'node:crypto';
import type { UsageAllocation } from './types';

export const USAGE_CONTEXT_VERSION = 1;
export const USAGE_CONTEXT_WRITER = 'meta-spark-for-copilot';
export const PROMPT_PREVIEW_MAX_CHARS = 160;
export const UNASSIGNED_CHAT_ID: null = null;
export const UNASSIGNED_TASK_ID: null = null;

export interface UsageContextMarkerPayload {
	version: 1;
	writer: string;
	chatId: string;
	taskId: string;
}

export interface UsageMarkerParseResult {
	valid: boolean;
	chatId?: string;
	taskId?: string;
	version?: number;
	writer?: string;
	error?: string;
}

export interface CorrelationMessagePart {
	text?: string;
	isToolResult?: boolean;
	hasMarker?: boolean;
	marker?: UsageMarkerParseResult;
}

export interface CorrelationMessage {
	role: 'user' | 'assistant' | 'system' | 'tool' | 'other';
	isHumanUserText: boolean;
	text: string;
	hasTerminalNotification: boolean;
	hasControlUpdate: boolean;
	hasValidMarker: boolean;
	latestValidMarker?: UsageMarkerParseResult;
	hasToolResultOnly: boolean;
	partCount: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;
const CONTROL_UPDATE_PATTERNS = [/<customizationsUpdate>/, /\[meta-spark-/];

/**
 * Pure allocation logic: decides chat/task identity for an incoming request.
 * No VS Code dependency; operates on normalized message summaries so it can
 * be tested deterministically.
 */
export function allocateUsageContext(input: {
	messages: readonly CorrelationMessage[];
	requestKind: string;
	marker: UsageMarkerParseResult | undefined;
	projectId: string;
	projectName: string;
}): UsageAllocation {
	const base = { projectId: input.projectId, projectName: input.projectName };
	const latestMarker = input.marker;
	const latestValid = latestMarker?.valid === true ? latestMarker : undefined;
	const newSubstantiveTurn = hasNewSubstantiveTurnAfterMarker(input.messages);
	const isMainAgent = input.requestKind === 'main-agent';

	if (isMainAgent) {
		if (!latestValid?.chatId || !latestValid?.taskId) {
			const chatId = randomUUID();
			const taskId = randomUUID();
			return {
				...base,
				chatId,
				taskId,
				isNewChat: true,
				isNewTask: true,
				inherited: false,
				unassigned: false,
				preview: firstTaskPreview(input.messages),
			};
		}
		if (newSubstantiveTurn) {
			return {
				...base,
				chatId: latestValid.chatId ?? null,
				taskId: randomUUID(),
				isNewChat: false,
				isNewTask: true,
				inherited: false,
				unassigned: false,
				preview: latestHumanPreview(input.messages),
			};
		}
		return {
			...base,
			chatId: latestValid.chatId ?? null,
			taskId: latestValid.taskId ?? null,
			isNewChat: false,
			isNewTask: false,
			inherited: false,
			unassigned: false,
			preview: latestHumanPreview(input.messages),
		};
	}

	// Every non-main request with a valid marker inherits that existing task,
	// including known utility/background kinds — that is the Copilot
	// orchestration overhead the monitor is meant to attribute per task.
	// Utilities never create tasks; without valid marker evidence they remain
	// unassigned overhead rather than guessed into a chat.
	if (latestValid?.chatId && latestValid?.taskId) {
		return {
			...base,
			chatId: latestValid.chatId,
			taskId: latestValid.taskId,
			isNewChat: false,
			isNewTask: false,
			inherited: true,
			unassigned: false,
			preview: latestHumanPreview(input.messages),
		};
	}
	// Some utility requests still carry the marker; inherit the *chat* context
	// without claiming task membership? No — utilities inherit the full
	// task above when marker evidence exists, and land here only when it is
	// absent. Never guess across chats.
	return {
		...base,
		chatId: UNASSIGNED_CHAT_ID,
		taskId: UNASSIGNED_TASK_ID,
		isNewChat: false,
		isNewTask: false,
		inherited: false,
		unassigned: true,
		preview: latestHumanPreview(input.messages),
	};
}

export function isUtilityRequestKind(requestKind: string): boolean {
	return (
		requestKind === 'terminal-steering' ||
		requestKind === 'todo-tracker' ||
		requestKind === 'prompt-categorizer' ||
		requestKind === 'settings-resolver' ||
		requestKind === 'chat-title' ||
		requestKind === 'inline-progress-message' ||
		requestKind === 'git-branch-name' ||
		requestKind === 'git-commit-message' ||
		requestKind === 'rename-suggestions'
	);
}

/**
 * A substantive human turn is a user message with real text that is not a
 * terminal notification, control/customization update, or tool-result-only
 * echo. The caller passes whether each message falls after the latest valid
 * marker by ordering messages oldest→newest and slicing; here we recompute
 * by scanning for: latest valid marker position then any later substantive
 * human text.
 */
export function hasNewSubstantiveTurnAfterMarker(messages: readonly CorrelationMessage[]): boolean {
	let markerIndex = -1;
	for (let i = 0; i < messages.length; i += 1) {
		if (messages[i].hasValidMarker) {
			markerIndex = i;
		}
	}
	for (let i = markerIndex + 1; i < messages.length; i += 1) {
		const msg = messages[i];
		if (isSubstantiveHumanTurn(msg)) {
			return true;
		}
	}
	return false;
}

export function isSubstantiveHumanTurn(msg: CorrelationMessage): boolean {
	if (!msg.isHumanUserText) {
		return false;
	}
	if (msg.hasToolResultOnly) {
		return false;
	}
	if (msg.hasTerminalNotification || msg.hasControlUpdate) {
		return false;
	}
	return msg.text.trim().length > 0;
}

export function isTerminalNotificationText(text: string): boolean {
	return TERMINAL_NOTIFICATION_PATTERN.test(text.trimStart());
}

export function isControlUpdateText(text: string): boolean {
	return CONTROL_UPDATE_PATTERNS.some((pattern) => pattern.test(text));
}

export function normalizePreview(text: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= PROMPT_PREVIEW_MAX_CHARS) {
		return collapsed;
	}
	return collapsed.slice(0, PROMPT_PREVIEW_MAX_CHARS);
}

function firstTaskPreview(messages: readonly CorrelationMessage[]): string {
	return normalizePreview(latestHumanPreview(messages));
}

function latestHumanPreview(messages: readonly CorrelationMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (isSubstantiveHumanTurn(msg)) {
			return normalizePreview(msg.text);
		}
	}
	return '';
}

export function buildMarkerPayload(chatId: string, taskId: string): UsageContextMarkerPayload {
	return { version: USAGE_CONTEXT_VERSION, writer: USAGE_CONTEXT_WRITER, chatId, taskId };
}

export function serializeMarkerPayload(payload: UsageContextMarkerPayload): string {
	return JSON.stringify(payload);
}

export function parseMarkerPayload(raw: string): UsageMarkerParseResult {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { valid: false, error: 'marker-json-invalid' };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { valid: false, error: 'marker-payload-not-object' };
	}
	const record = value as Record<string, unknown>;
	if (record.version !== USAGE_CONTEXT_VERSION) {
		return { valid: false, error: 'marker-version-mismatch' };
	}
	if (record.writer !== USAGE_CONTEXT_WRITER) {
		return { valid: false, error: 'marker-writer-mismatch' };
	}
	const chatId = record.chatId;
	const taskId = record.taskId;
	if (typeof chatId !== 'string' || !UUID_PATTERN.test(chatId)) {
		return { valid: false, error: 'marker-chat-id-invalid' };
	}
	if (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) {
		return { valid: false, error: 'marker-task-id-invalid' };
	}
	return {
		valid: true,
		chatId: chatId.toLowerCase(),
		taskId: taskId.toLowerCase(),
		version: USAGE_CONTEXT_VERSION,
		writer: USAGE_CONTEXT_WRITER,
	};
}

/**
 * Deterministic local project identity from workspace URIs. One-way hash,
 * order-independent for multi-root workspaces, no filesystem paths retained.
 */
export function deriveProjectId(workspaceUris: readonly string[]): {
	projectId: string;
	candidateName: string;
} {
	const canonical = [...workspaceUris]
		.map((uri) => uri.trim())
		.filter(Boolean)
		.sort();
	const hash = createHash('sha256').update(canonical.join('\n')).digest('hex').slice(0, 32);
	const candidateName = canonical.length > 0 ? displayNameFromUri(canonical[0]) : 'No workspace';
	return { projectId: `project-${hash}`, candidateName };
}

function displayNameFromUri(uri: string): string {
	try {
		const withoutScheme = uri.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
		const cleaned = withoutScheme.replace(/\/+$/, '');
		const segments = cleaned.split('/').filter(Boolean);
		const last = segments[segments.length - 1] ?? cleaned;
		return decodeURIComponent(last) || 'Workspace';
	} catch {
		return 'Workspace';
	}
}

export function isValidUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}
