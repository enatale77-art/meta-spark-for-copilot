import type { UsageRequestRecord } from './types';

export interface RequestTotals {
	requests: number;
	billableRequests: number;
	attempts: number;
	inputTokens: number;
	cachedTokens: number;
	uncachedTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	estimatedCostUsd: number;
	cacheHitPct: number;
}

export interface TaskRollup extends RequestTotals {
	taskId: string;
	chatId: string | null;
	projectId: string;
	projectName: string;
	preview: string;
	vscodeModelId: string;
	firstSeenMs: number;
	lastSeenMs: number;
	byKind: Record<string, RequestTotals>;
}

export interface ChatRollup extends RequestTotals {
	chatId: string;
	projectId: string;
	projectName: string;
	displayName: string;
	taskCount: number;
	firstSeenMs: number;
	lastSeenMs: number;
}

export interface ProjectRollup extends RequestTotals {
	projectId: string;
	projectName: string;
}

const EMPTY: RequestTotals = {
	requests: 0,
	billableRequests: 0,
	attempts: 0,
	inputTokens: 0,
	cachedTokens: 0,
	uncachedTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
	totalTokens: 0,
	estimatedCostUsd: 0,
	cacheHitPct: 0,
};

export function emptyTotals(): RequestTotals {
	return { ...EMPTY };
}

function addRecord(totals: RequestTotals, record: UsageRequestRecord): void {
	totals.requests += 1;
	if (record.status !== 'completed' || record.promptTokens === null) {
		totals.attempts += 1;
		return;
	}
	totals.billableRequests += 1;
	totals.inputTokens += record.promptTokens ?? 0;
	totals.cachedTokens += record.cachedInputTokens ?? 0;
	totals.uncachedTokens += record.uncachedInputTokens ?? 0;
	totals.outputTokens += record.completionTokens ?? 0;
	totals.reasoningTokens += record.reasoningTokens ?? 0;
	totals.totalTokens += record.totalTokens ?? 0;
	totals.estimatedCostUsd += record.estimatedCostUsd ?? 0;
}

function finalize(totals: RequestTotals): RequestTotals {
	const next = { ...totals };
	next.cacheHitPct = next.inputTokens > 0 ? (next.cachedTokens / next.inputTokens) * 100 : 0;
	return next;
}

/** Single-pass O(n) aggregation over the ledger. */
export function aggregateRequests(records: readonly UsageRequestRecord[]): RequestTotals {
	const totals = emptyTotals();
	for (const record of records) {
		addRecord(totals, record);
	}
	return finalize(totals);
}

export function rollupTasks(
	records: readonly UsageRequestRecord[],
	taskPreviewById?: ReadonlyMap<string, string>,
): TaskRollup[] {
	const byTask = new Map<string, { rollup: TaskRollup; scratch: RequestTotals }>();
	for (const record of records) {
		if (!record.taskId) {
			continue;
		}
		let entry = byTask.get(record.taskId);
		if (!entry) {
			entry = {
				rollup: {
					...emptyTotals(),
					taskId: record.taskId,
					chatId: record.chatId,
					projectId: record.projectId,
					projectName: record.projectName,
					preview: record.taskPreview ?? taskPreviewById?.get(record.taskId) ?? '',
					vscodeModelId: record.vscodeModelId,
					firstSeenMs: record.timestampMs,
					lastSeenMs: record.timestampMs,
					byKind: {},
				},
				scratch: emptyTotals(),
			};
			byTask.set(record.taskId, entry);
		}
		addRecord(entry.scratch, record);
		const scratchKind = entry.rollup.byKind[record.requestKind] ?? emptyTotals();
		addRecord(scratchKind, record);
		entry.rollup.byKind[record.requestKind] = scratchKind;
		entry.rollup.firstSeenMs = Math.min(entry.rollup.firstSeenMs, record.timestampMs);
		entry.rollup.lastSeenMs = Math.max(entry.rollup.lastSeenMs, record.timestampMs);
		if (!entry.rollup.preview && record.taskPreview) {
			entry.rollup.preview = record.taskPreview;
		}
	}
	const result: TaskRollup[] = [];
	for (const entry of byTask.values()) {
		const finalized = finalize(entry.scratch);
		const byKind: Record<string, RequestTotals> = {};
		for (const [kind, kindTotals] of Object.entries(entry.rollup.byKind)) {
			byKind[kind] = finalize(kindTotals);
		}
		result.push({ ...entry.rollup, ...finalized, byKind });
	}
	result.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
	return result;
}

export function rollupChats(
	tasks: readonly TaskRollup[],
	displayNameByChatId?: ReadonlyMap<string, string>,
): ChatRollup[] {
	const byChat = new Map<string, ChatRollup & { scratch: RequestTotals }>();
	const unassigned: Array<TaskRollup> = [];
	for (const task of tasks) {
		if (!task.chatId) {
			unassigned.push(task);
			continue;
		}
		let entry = byChat.get(task.chatId);
		if (!entry) {
			entry = {
				...emptyTotals(),
				chatId: task.chatId,
				projectId: task.projectId,
				projectName: task.projectName,
				displayName: displayNameByChatId?.get(task.chatId) ?? task.preview ?? task.chatId,
				taskCount: 0,
				firstSeenMs: task.firstSeenMs,
				lastSeenMs: task.lastSeenMs,
				scratch: emptyTotals(),
			};
			byChat.set(task.chatId, entry);
		}
		entry.scratch.requests += task.requests;
		entry.scratch.billableRequests += task.billableRequests;
		entry.scratch.attempts += task.attempts;
		entry.scratch.inputTokens += task.inputTokens;
		entry.scratch.cachedTokens += task.cachedTokens;
		entry.scratch.uncachedTokens += task.uncachedTokens;
		entry.scratch.outputTokens += task.outputTokens;
		entry.scratch.reasoningTokens += task.reasoningTokens;
		entry.scratch.totalTokens += task.totalTokens;
		entry.scratch.estimatedCostUsd += task.estimatedCostUsd;
		entry.taskCount += 1;
		entry.firstSeenMs = Math.min(entry.firstSeenMs, task.firstSeenMs);
		entry.lastSeenMs = Math.max(entry.lastSeenMs, task.lastSeenMs);
	}
	const result: ChatRollup[] = [];
	for (const entry of byChat.values()) {
		const finalized = finalize(entry.scratch);
		const { scratch: _scratch, ...rest } = entry;
		result.push({ ...rest, ...finalized });
	}
	result.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
	void unassigned;
	return result;
}

export function rollupProjects(records: readonly UsageRequestRecord[]): ProjectRollup[] {
	const byProject = new Map<string, ProjectRollup & { scratch: RequestTotals }>();
	for (const record of records) {
		let entry = byProject.get(record.projectId);
		if (!entry) {
			entry = {
				...emptyTotals(),
				projectId: record.projectId,
				projectName: record.projectName,
				scratch: emptyTotals(),
			};
			byProject.set(record.projectId, entry);
		}
		addRecord(entry.scratch, record);
		entry.projectName = record.projectName || entry.projectName;
	}
	const result: ProjectRollup[] = [];
	for (const entry of byProject.values()) {
		const finalized = finalize(entry.scratch);
		const { scratch: _scratch, ...rest } = entry;
		result.push({ ...rest, ...finalized });
	}
	result.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
	return result;
}

export function filterByTime(
	records: readonly UsageRequestRecord[],
	nowMs: number,
	days: number | null,
): UsageRequestRecord[] {
	if (days === null || days <= 0) {
		return [...records];
	}
	const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
	return records.filter((record) => record.timestampMs >= cutoff);
}
