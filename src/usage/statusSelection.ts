import { filterByTime } from './aggregate';
import { deriveProjectId } from './context';
import type { UsageRequestRecord } from './types';

export interface StatusSelection {
	/** Latest task in the active project, or undefined when none exists. */
	latest: UsageRequestRecord | undefined;
	/** All completed windowed records for that task (empty when none). */
	taskRecords: UsageRequestRecord[];
	/** Deterministic project identity of the active workspace. */
	projectId: string;
}

/**
 * Pure selection: filter the ledger window to the active project, then pick
 * the latest record's task. Cross-project records never leak into the item.
 * VS Code-free so deterministic tests can cover it without the editor API.
 */
export function selectStatusTask(input: {
	records: readonly UsageRequestRecord[];
	workspaceUris: readonly string[];
	nowMs: number;
	windowDays?: number;
}): StatusSelection {
	const projectId = deriveProjectId(input.workspaceUris).projectId;
	const windowed = filterByTime(input.records, input.nowMs, input.windowDays ?? 30).filter(
		(record) => record.status === 'completed' && record.projectId === projectId,
	);
	const sorted = [...windowed].sort((a, b) => b.timestampMs - a.timestampMs);
	const latest = sorted[0];
	const taskRecords =
		latest?.taskId != null
			? sorted.filter((record) => record.taskId === latest.taskId)
			: latest
				? [latest]
				: [];
	return { latest, taskRecords, projectId };
}
