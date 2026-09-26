/**
 * CSV export helpers. Pure functions so escaping is deterministically tested.
 * Never include API keys, full prompts, or filesystem paths — only the
 * 160-char preview and ledger IDs.
 */
import type { UsageRequestRecord } from './types';

export const CSV_COLUMNS = [
	'id',
	'timestamp',
	'project_id',
	'project_name',
	'chat_id',
	'task_id',
	'task_preview',
	'vscode_model_id',
	'api_model_id',
	'request_kind',
	'request_initiator',
	'reasoning_effort',
	'prompt_tokens',
	'cached_input_tokens',
	'uncached_input_tokens',
	'completion_tokens',
	'reasoning_tokens',
	'total_tokens',
	'estimated_cost_usd',
	'pricing_source',
	'cost_uncertain',
	'duration_ms',
	'status',
] as const;

export function toCsvRows(records: readonly UsageRequestRecord[]): string[][] {
	return records.map((record) => [
		record.id,
		record.timestamp,
		record.projectId,
		record.projectName,
		record.chatId ?? '',
		record.taskId ?? '',
		record.taskPreview ?? '',
		record.vscodeModelId,
		record.apiModelId,
		record.requestKind,
		record.requestInitiator ?? '',
		record.reasoningEffort ?? '',
		formatNullableNumber(record.promptTokens),
		formatNullableNumber(record.cachedInputTokens),
		formatNullableNumber(record.uncachedInputTokens),
		formatNullableNumber(record.completionTokens),
		formatNullableNumber(record.reasoningTokens),
		formatNullableNumber(record.totalTokens),
		formatNullableNumber(record.estimatedCostUsd),
		record.pricingSource ?? '',
		record.costUncertain ? 'true' : 'false',
		formatNullableNumber(record.durationMs),
		record.status,
	]);
}

export function toCsvText(records: readonly UsageRequestRecord[]): string {
	const lines = [[...CSV_COLUMNS].join(',')];
	for (const row of toCsvRows(records)) {
		lines.push(row.map(escapeCsvField).join(','));
	}
	return `${lines.join('\r\n')}\r\n`;
}

export function escapeCsvField(value: string): string {
	if (value === '') {
		return '';
	}
	if (/[",\r\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

function formatNullableNumber(value: number | null): string {
	return value === null || value === undefined ? '' : String(value);
}
