/**
 * Shared types for the local-first Muse usage monitor.
 * All persisted records are privacy-bounded: no prompts beyond a capped
 * preview, no source/tool/reasoning/response content, no filesystem paths,
 * and no API keys.
 */

export type UsageRecordStatus = 'completed' | 'attempt';

export interface UsageRequestRecord {
	version: 1;
	id: string;
	timestamp: string;
	timestampMs: number;
	projectId: string;
	projectName: string;
	chatId: string | null;
	taskId: string | null;
	vscodeModelId: string;
	apiModelId: string;
	requestKind: string;
	requestInitiator: string | null;
	reasoningEffort: string | null;
	promptTokens: number | null;
	cachedInputTokens: number | null;
	uncachedInputTokens: number | null;
	completionTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number | null;
	estimatedCostUsd: number | null;
	pricingInputRate: number | null;
	pricingCachedRate: number | null;
	pricingOutputRate: number | null;
	pricingModelId: string | null;
	pricingSource: string | null;
	costUncertain: boolean;
	durationMs: number | null;
	status: UsageRecordStatus;
	error?: string | null;
	taskPreview?: string | null;
}

export interface ChatMetadata {
	chatId: string;
	projectId: string;
	projectName: string;
	createdAt: string;
	createdAtMs: number;
	updatedAt: string;
	updatedAtMs: number;
	displayName: string;
	firstTaskPreview?: string;
	nativeSessionId?: string | null;
}

export interface TaskMetadata {
	taskId: string;
	chatId: string;
	projectId: string;
	projectName: string;
	createdAt: string;
	createdAtMs: number;
	updatedAt: string;
	updatedAtMs: number;
	preview: string;
	nativeSessionId?: string | null;
}

export interface ContextsFile {
	version: 1;
	chats: Record<string, ChatMetadata>;
	tasks: Record<string, TaskMetadata>;
}

export interface UsageAllocation {
	chatId: string | null;
	taskId: string | null;
	projectId: string;
	projectName: string;
	isNewChat: boolean;
	isNewTask: boolean;
	inherited: boolean;
	unassigned: boolean;
	preview: string;
}

export interface ResolvedPricing {
	inputRate: number;
	cachedRate: number;
	outputRate: number;
	pricingModelId: string | null;
	source: string;
	uncertain: boolean;
}

export interface CostBreakdown {
	uncachedTokens: number;
	cachedTokens: number;
	completionTokens: number;
	uncachedCost: number;
	cachedCost: number;
	outputCost: number;
	total: number;
}

export function emptyContexts(): ContextsFile {
	return { version: 1, chats: {}, tasks: {} };
}
