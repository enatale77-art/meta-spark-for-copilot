import { randomUUID } from 'node:crypto';
import vscode from 'vscode';
import { MODELS } from '../consts';
import type { MetaUsage } from '../types';
import { logger } from '../logger';
import { formatRequestLogLine, type RequestKind } from '../provider/routing';
import {
	allocateUsageContext,
	deriveProjectId,
	isControlUpdateText,
	isTerminalNotificationText,
	normalizePreview,
	type CorrelationMessage,
	type UsageMarkerParseResult,
} from './context';
import { findLatestUsageMarker, parseStatefulUsageMarkerPart } from './marker';
import { calculateCost, resolvePricing, splitUsageTokens } from './pricing';
import type { UsageAllocation, UsageRequestRecord } from './types';
import { emptyContexts, type ContextsFile } from './types';
import type { UsageStore } from './storage';

export interface UsageServiceOptions {
	store: UsageStore;
	onRecorded?: (record: UsageRequestRecord) => void;
	getWorkspaceUris?: () => string[];
	getWorkspaceName?: () => string;
}

export interface PendingUsageRequest {
	allocation: UsageAllocation;
	vscodeModelId: string;
	apiModelId: string;
	requestKind: RequestKind;
	requestInitiator: string | null;
	reasoningEffort: string | null;
	startedAtMs: number;
}

export interface CompletedUsage {
	usage: MetaUsage;
	durationMs?: number | null;
	status?: 'completed';
}

/**
 * Lifecycle integration around provider requests. Correlation is established
 * before the Meta request so returned usage is assigned correctly; the
 * authoritative `MetaUsage` object is recorded after streaming completes.
 * Failures in persistence never fail the model response.
 */
export class UsageService {
	private readonly store: UsageStore;
	private readonly onRecorded?: (record: UsageRequestRecord) => void;
	private readonly getWorkspaceUris: () => string[];
	private readonly getWorkspaceName: () => string;
	private contextsCache: ContextsFile | null = null;
	private contextsLoaded = false;

	constructor(options: UsageServiceOptions) {
		this.store = options.store;
		this.onRecorded = options.onRecorded;
		this.getWorkspaceUris = options.getWorkspaceUris ?? defaultWorkspaceUris;
		this.getWorkspaceName = options.getWorkspaceName ?? defaultWorkspaceName;
	}

	/**
	 * Delete all usage-monitor storage and drop the in-memory contexts cache
	 * so a later request cannot write stale chat/task metadata back to disk.
	 * Every clear path (dashboard + Command Palette) must go through here.
	 */
	async clearAll(): Promise<void> {
		await this.store.clear();
		this.invalidateContextsCache();
	}

	resolveProject(): { projectId: string; projectName: string } {
		const uris = this.getWorkspaceUris();
		const derived = deriveProjectId(uris);
		const configuredName = this.getWorkspaceName().trim();
		const projectName = configuredName || derived.candidateName || 'No workspace';
		return { projectId: derived.projectId, projectName };
	}

	async beginRequest(input: {
		messages: readonly vscode.LanguageModelChatRequestMessage[];
		requestKind: RequestKind;
		vscodeModelId: string;
		apiModelId: string;
		requestInitiator?: unknown;
		reasoningEffort?: string | null;
		startedAtMs?: number;
	}): Promise<PendingUsageRequest> {
		const project = this.resolveProject();
		const marker = safeFindMarker(input.messages);
		const correlationMessages = toCorrelationMessages(input.messages);
		const allocation = allocateUsageContext({
			messages: correlationMessages,
			requestKind: input.requestKind,
			marker,
			projectId: project.projectId,
			projectName: project.projectName,
		});
		await this.ensureContextsForAllocation(allocation).catch((error) => {
			logger.warn(
				formatRequestLogLine(input.requestKind, 'Failed to update usage contexts'),
				error,
			);
		});
		return {
			allocation,
			vscodeModelId: input.vscodeModelId,
			apiModelId: input.apiModelId,
			requestKind: input.requestKind,
			requestInitiator: formatInitiator(input.requestInitiator),
			reasoningEffort: input.reasoningEffort ?? null,
			startedAtMs: input.startedAtMs ?? Date.now(),
		};
	}

	async recordCompleted(
		pending: PendingUsageRequest,
		completed: CompletedUsage,
	): Promise<UsageRequestRecord | undefined> {
		try {
			const tokens = splitUsageTokens(completed.usage);
			const pricing = resolvePricing({
				vscodeModelId: pending.vscodeModelId,
				apiModelId: pending.apiModelId,
				models: MODELS,
			});
			const cost = calculateCost(tokens, pricing);
			const timestampMs = Date.now();
			const record: UsageRequestRecord = {
				version: 1,
				id: randomUUID(),
				timestamp: new Date(timestampMs).toISOString(),
				timestampMs,
				projectId: pending.allocation.projectId,
				projectName: pending.allocation.projectName,
				chatId: pending.allocation.chatId,
				taskId: pending.allocation.taskId,
				vscodeModelId: pending.vscodeModelId,
				apiModelId: pending.apiModelId,
				requestKind: pending.requestKind,
				requestInitiator: pending.requestInitiator,
				reasoningEffort: pending.reasoningEffort,
				promptTokens: tokens.promptTokens,
				cachedInputTokens: tokens.cachedTokens,
				uncachedInputTokens: tokens.uncachedTokens,
				completionTokens: tokens.completionTokens,
				reasoningTokens: tokens.reasoningTokens,
				totalTokens: tokens.totalTokens,
				estimatedCostUsd: cost.total,
				pricingInputRate: pricing.inputRate,
				pricingCachedRate: pricing.cachedRate,
				pricingOutputRate: pricing.outputRate,
				pricingModelId: pricing.pricingModelId,
				pricingSource: pricing.source,
				costUncertain: pricing.uncertain,
				durationMs:
					typeof completed.durationMs === 'number'
						? completed.durationMs
						: Math.max(timestampMs - pending.startedAtMs, 0),
				status: 'completed',
				error: null,
				taskPreview: pending.allocation.preview
					? normalizePreview(pending.allocation.preview)
					: null,
			};
			await this.store.appendRequest(record);
			await this.touchContexts(record).catch((error) => {
				logger.warn(
					formatRequestLogLine(pending.requestKind, 'Failed to touch usage contexts'),
					error,
				);
			});
			this.onRecorded?.(record);
			return record;
		} catch (error) {
			logger.warn(formatRequestLogLine(pending.requestKind, 'Failed to record Muse usage'), error);
			return undefined;
		}
	}

	async recordAttempt(
		pending: PendingUsageRequest,
		errorMessage?: string,
	): Promise<UsageRequestRecord | undefined> {
		try {
			const timestampMs = Date.now();
			const record: UsageRequestRecord = {
				version: 1,
				id: randomUUID(),
				timestamp: new Date(timestampMs).toISOString(),
				timestampMs,
				projectId: pending.allocation.projectId,
				projectName: pending.allocation.projectName,
				chatId: pending.allocation.chatId,
				taskId: pending.allocation.taskId,
				vscodeModelId: pending.vscodeModelId,
				apiModelId: pending.apiModelId,
				requestKind: pending.requestKind,
				requestInitiator: pending.requestInitiator,
				reasoningEffort: pending.reasoningEffort,
				promptTokens: null,
				cachedInputTokens: null,
				uncachedInputTokens: null,
				completionTokens: null,
				reasoningTokens: null,
				totalTokens: null,
				estimatedCostUsd: null,
				pricingInputRate: null,
				pricingCachedRate: null,
				pricingOutputRate: null,
				pricingModelId: null,
				pricingSource: null,
				costUncertain: false,
				durationMs: Math.max(timestampMs - pending.startedAtMs, 0),
				status: 'attempt',
				error: errorMessage ?? null,
				taskPreview: pending.allocation.preview
					? normalizePreview(pending.allocation.preview)
					: null,
			};
			await this.store.appendRequest(record);
			this.onRecorded?.(record);
			return record;
		} catch (error) {
			logger.warn(
				formatRequestLogLine(pending.requestKind, 'Failed to record usage attempt'),
				error,
			);
			return undefined;
		}
	}

	private async ensureContextsForAllocation(allocation: UsageAllocation): Promise<void> {
		const contexts = await this.loadContexts();
		let changed = false;
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		if (allocation.chatId && !contexts.chats[allocation.chatId]) {
			const preview = allocation.preview ? normalizePreview(allocation.preview) : '';
			contexts.chats[allocation.chatId] = {
				chatId: allocation.chatId,
				projectId: allocation.projectId,
				projectName: allocation.projectName,
				createdAt: nowIso,
				createdAtMs: nowMs,
				updatedAt: nowIso,
				updatedAtMs: nowMs,
				displayName: preview || `Local chat ${allocation.chatId.slice(0, 8)}`,
				firstTaskPreview: preview || undefined,
				nativeSessionId: null,
			};
			changed = true;
		} else if (allocation.chatId && contexts.chats[allocation.chatId]) {
			const chat = contexts.chats[allocation.chatId];
			chat.updatedAt = nowIso;
			chat.updatedAtMs = nowMs;
			// R12B: the local chat subject is the first cleaned human task
			// preview and stays stable for the chat lifetime. Only fill an
			// empty/placeholder subject; never rewrite it from later tasks.
			if ((!chat.displayName || chat.displayName.startsWith('Local chat ')) && allocation.preview) {
				chat.displayName = normalizePreview(allocation.preview);
			}
			if (!chat.firstTaskPreview && allocation.preview) {
				chat.firstTaskPreview = normalizePreview(allocation.preview);
			}
			changed = true;
		}
		if (allocation.taskId && allocation.chatId && !contexts.tasks[allocation.taskId]) {
			const preview = allocation.preview ? normalizePreview(allocation.preview) : '';
			contexts.tasks[allocation.taskId] = {
				taskId: allocation.taskId,
				chatId: allocation.chatId,
				projectId: allocation.projectId,
				projectName: allocation.projectName,
				createdAt: nowIso,
				createdAtMs: nowMs,
				updatedAt: nowIso,
				updatedAtMs: nowMs,
				preview: preview || `Task ${allocation.taskId.slice(0, 8)}`,
				nativeSessionId: null,
			};
			changed = true;
		} else if (allocation.taskId && contexts.tasks[allocation.taskId]) {
			const task = contexts.tasks[allocation.taskId];
			task.updatedAt = nowIso;
			task.updatedAtMs = nowMs;
			changed = true;
		}
		if (changed) {
			await this.store.writeContexts(contexts);
			this.contextsCache = contexts;
		}
	}

	private async touchContexts(record: UsageRequestRecord): Promise<void> {
		const contexts = await this.loadContexts();
		let changed = false;
		const nowIso = new Date(record.timestampMs).toISOString();
		if (record.chatId && contexts.chats[record.chatId]) {
			contexts.chats[record.chatId].updatedAt = nowIso;
			contexts.chats[record.chatId].updatedAtMs = record.timestampMs;
			changed = true;
		}
		if (record.taskId && contexts.tasks[record.taskId]) {
			contexts.tasks[record.taskId].updatedAt = nowIso;
			contexts.tasks[record.taskId].updatedAtMs = record.timestampMs;
			changed = true;
		}
		if (changed) {
			await this.store.writeContexts(contexts);
			this.contextsCache = contexts;
		}
	}

	private async loadContexts(): Promise<ContextsFile> {
		if (this.contextsLoaded && this.contextsCache) {
			return this.contextsCache;
		}
		try {
			const contexts = await this.store.readContexts();
			this.contextsCache = contexts ?? emptyContexts();
		} catch (error) {
			logger.warn('[usage] Failed to read usage contexts, starting fresh', error);
			this.contextsCache = emptyContexts();
		}
		this.contextsLoaded = true;
		return this.contextsCache ?? emptyContexts();
	}

	invalidateContextsCache(): void {
		this.contextsLoaded = false;
		this.contextsCache = null;
	}
}

function safeFindMarker(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): UsageMarkerParseResult | undefined {
	try {
		return findLatestUsageMarker(messages);
	} catch (error) {
		logger.warn('[usage] Failed to scan usage marker', error);
		return undefined;
	}
}

export function toCorrelationMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): CorrelationMessage[] {
	return messages.map((message) => toCorrelationMessage(message));
}

function toCorrelationMessage(message: vscode.LanguageModelChatRequestMessage): CorrelationMessage {
	const role = toCorrelationRole(message.role);
	const texts: string[] = [];
	let hasToolResultOnly = true;
	let hasText = false;
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			hasText = true;
			hasToolResultOnly = false;
			texts.push(part.value);
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			for (const item of part.content) {
				if (item instanceof vscode.LanguageModelTextPart) {
					texts.push(item.value);
				}
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			hasToolResultOnly = false;
		} else if (part instanceof vscode.LanguageModelDataPart) {
			// Data parts (images, markers) are not tool results but also not
			// human text. Usage marker presence is tracked separately below.
			if (part.mimeType.startsWith('image/')) {
				hasToolResultOnly = false;
			}
		} else {
			hasToolResultOnly = false;
		}
	}
	const text = texts.join('');
	const isUser = role === 'user';
	const marker = scanMessageMarker(message);
	const hasValidMarker = marker?.valid === true;
	return {
		role,
		isHumanUserText: isUser && hasText,
		text,
		hasTerminalNotification: isUser && isTerminalNotificationText(text),
		hasControlUpdate: text ? isControlUpdateText(text) : false,
		hasValidMarker,
		latestValidMarker: marker?.valid === true ? marker : undefined,
		hasToolResultOnly: message.content.length > 0 && hasToolResultOnly && !hasText,
		partCount: message.content.length,
	};
}

function scanMessageMarker(
	message: vscode.LanguageModelChatRequestMessage,
): UsageMarkerParseResult | undefined {
	if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
		return undefined;
	}
	for (const part of message.content) {
		const parsed = parseStatefulUsageMarkerPart(part);
		if (parsed?.valid) {
			return parsed;
		}
	}
	return undefined;
}

function toCorrelationRole(role: vscode.LanguageModelChatMessageRole): CorrelationMessage['role'] {
	if (role === vscode.LanguageModelChatMessageRole.User) {
		return 'user';
	}
	if (role === vscode.LanguageModelChatMessageRole.Assistant) {
		return 'assistant';
	}
	return 'other';
}

function formatInitiator(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === 'string') {
		return value.slice(0, 200);
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	try {
		return JSON.stringify(value)?.slice(0, 200) ?? null;
	} catch {
		return null;
	}
}

function defaultWorkspaceUris(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString());
}

function defaultWorkspaceName(): string {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 1) {
		return folders[0].name;
	}
	if (vscode.workspace.name) {
		return vscode.workspace.name;
	}
	return folders.map((folder) => folder.name).join(', ');
}
