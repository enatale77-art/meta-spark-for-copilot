/**
 * File-backed usage storage under `<globalStorageUri>/usage-v1/`.
 *
 * - `requests.jsonl` — append-only accounting ledger, schema-versioned per line.
 * - `contexts.json`  — versioned chat/task metadata, written atomically.
 * - `history-state.json` — visible-history cutoff only. Clear/Restore History
 *   rewrite this file and nothing else; the ledger and contexts are retained.
 *
 * Pure helpers (parse/serialize/filter) live here for deterministic tests.
 * VS Code `FileSystem`-backed IO is isolated in `createFileUsageStore`;
 * an in-memory store is exported for tests and provider-level verification.
 */
import type { ContextsFile, UsageRequestRecord } from './types';
import { emptyContexts } from './types';

export const USAGE_DIR_NAME = 'usage-v1';
export const REQUESTS_FILE_NAME = 'requests.jsonl';
export const CONTEXTS_FILE_NAME = 'contexts.json';
export const HISTORY_STATE_FILE_NAME = 'history-state.json';
export const REQUEST_RECORD_VERSION = 1;
export const HISTORY_STATE_VERSION = 1;

export interface ParsedLedger {
	records: UsageRequestRecord[];
	corruptedTailLines: number;
	corruptedLines: number;
}

export function serializeRecord(record: UsageRequestRecord): string {
	return JSON.stringify({ ...record, version: REQUEST_RECORD_VERSION });
}

export function parseLedgerText(text: string): ParsedLedger {
	const records: UsageRequestRecord[] = [];
	let corruptedLines = 0;
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) {
			continue;
		}
		try {
			const parsed = JSON.parse(line) as UsageRequestRecord;
			if (!isPlausibleRecord(parsed)) {
				corruptedLines += 1;
				continue;
			}
			records.push(parsed);
		} catch {
			corruptedLines += 1;
		}
	}
	// A truncated final line after a crash shows up as trailing corruption;
	// report it but keep older history readable.
	let corruptedTailLines = 0;
	if (lines.length > 0 && lines[lines.length - 1].trim() !== '' && corruptedLines > 0) {
		const lastNonEmpty = [...lines].reverse().find((line) => line.trim() !== '');
		if (lastNonEmpty !== undefined) {
			try {
				JSON.parse(lastNonEmpty);
			} catch {
				corruptedTailLines = 1;
			}
		}
	}
	return { records, corruptedTailLines, corruptedLines };
}

function isPlausibleRecord(value: unknown): value is UsageRequestRecord {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === 'string' &&
		typeof record.timestampMs === 'number' &&
		typeof record.projectId === 'string' &&
		typeof record.vscodeModelId === 'string'
	);
}

export function parseContextsText(text: string): {
	contexts: ContextsFile;
	corrupted: boolean;
} {
	try {
		const parsed = JSON.parse(text) as ContextsFile;
		if (!parsed || typeof parsed !== 'object' || !parsed.chats || !parsed.tasks) {
			return { contexts: emptyContexts(), corrupted: true };
		}
		return {
			contexts: {
				version: 1,
				chats: parsed.chats ?? {},
				tasks: parsed.tasks ?? {},
			},
			corrupted: false,
		};
	} catch {
		return { contexts: emptyContexts(), corrupted: true };
	}
}

export function serializeContexts(contexts: ContextsFile): string {
	return JSON.stringify({ version: 1, chats: contexts.chats, tasks: contexts.tasks });
}

export interface HistoryStateFile {
	version: 1;
	/**
	 * Inclusive visible-history cutoff (epoch ms): records at or before it are
	 * hidden from chat/task/overhead detail. 0 means nothing is hidden.
	 */
	hiddenBeforeMs: number;
}

export function parseHistoryStateText(text: string): number {
	try {
		const parsed = JSON.parse(text) as Partial<HistoryStateFile>;
		return typeof parsed.hiddenBeforeMs === 'number' && Number.isFinite(parsed.hiddenBeforeMs)
			? Math.max(0, parsed.hiddenBeforeMs)
			: 0;
	} catch {
		return 0;
	}
}

export function serializeHistoryState(hiddenBeforeMs: number): string {
	return JSON.stringify({
		version: HISTORY_STATE_VERSION,
		hiddenBeforeMs: Math.max(0, hiddenBeforeMs),
	});
}

export interface UsageChangeSignature {
	requestBytes: number;
	contextBytes: number;
	requestCount: number;
}

export function signatureFromLedger(
	records: readonly UsageRequestRecord[],
	contexts: ContextsFile,
	hiddenBeforeMs = 0,
): UsageChangeSignature {
	return {
		requestBytes: records.reduce(
			(sum, record) => sum + (record.totalTokens ?? 0) + record.timestampMs,
			records.length,
		),
		contextBytes:
			Object.keys(contexts.chats).length * 100003 +
			Object.keys(contexts.tasks).length +
			Math.max(0, hiddenBeforeMs),
		requestCount: records.length,
	};
}

export interface UsageStore {
	appendRequest(record: UsageRequestRecord): Promise<void>;
	readRequests(): Promise<ParsedLedger>;
	readContexts(): Promise<ContextsFile>;
	writeContexts(contexts: ContextsFile): Promise<void>;
	/** Visible-history cutoff in epoch ms; 0 when history was never cleared. */
	readHistoryCutoff(): Promise<number>;
	/**
	 * Atomically replace the visible-history cutoff. Only `history-state.json`
	 * is written; accounting data is never touched. 0 shows all history.
	 */
	writeHistoryCutoff(cutoffMs: number): Promise<void>;
	getChangeSignature?(): Promise<UsageChangeSignature | undefined>;
}

/**
 * Clear History: advance the visible-history cutoff to `nowMs`. The cutoff
 * never moves backwards (clock skew, a second window clearing earlier), so
 * anything already hidden stays hidden until Restore History.
 */
export async function clearVisibleHistory(
	store: UsageStore,
	nowMs: number = Date.now(),
): Promise<number> {
	const cutoffMs = Math.max(await store.readHistoryCutoff(), nowMs);
	await store.writeHistoryCutoff(cutoffMs);
	return cutoffMs;
}

/**
 * Restore History: reset the visible-history cutoff so every retained
 * chat/task/overhead record is shown again. Idempotent — when nothing is
 * hidden the marker is left untouched. Returns whether a cutoff was reset.
 */
export async function restoreVisibleHistory(store: UsageStore): Promise<boolean> {
	if ((await store.readHistoryCutoff()) <= 0) {
		return false;
	}
	await store.writeHistoryCutoff(0);
	return true;
}

/** In-memory store for tests and deterministic verification. */
export function createMemoryUsageStore(): UsageStore & {
	getRecords(): UsageRequestRecord[];
	getContexts(): ContextsFile;
} {
	let records: UsageRequestRecord[] = [];
	let contexts: ContextsFile = emptyContexts();
	let historyCutoffMs = 0;
	let revision = 0;
	return {
		async appendRequest(record: UsageRequestRecord): Promise<void> {
			records.push(record);
			revision += 1;
		},
		async readRequests(): Promise<ParsedLedger> {
			return { records: [...records], corruptedTailLines: 0, corruptedLines: 0 };
		},
		async readContexts(): Promise<ContextsFile> {
			return structuredClone(contexts);
		},
		async writeContexts(next: ContextsFile): Promise<void> {
			contexts = structuredClone(next);
			revision += 1;
		},
		async readHistoryCutoff(): Promise<number> {
			return historyCutoffMs;
		},
		async writeHistoryCutoff(cutoffMs: number): Promise<void> {
			historyCutoffMs = Math.max(0, cutoffMs);
			revision += 1;
		},
		async getChangeSignature(): Promise<UsageChangeSignature | undefined> {
			return signatureFromLedger(records, contexts, historyCutoffMs);
		},
		getRecords(): UsageRequestRecord[] {
			return [...records];
		},
		getContexts(): ContextsFile {
			return structuredClone(contexts);
		},
	};
}

/**
 * Scope guard: Clear/Restore History may only update the visibility marker.
 * The accounting ledger and context metadata are intentionally persistent.
 */
export function usageClearTargets(): readonly string[] {
	return [`${USAGE_DIR_NAME}/${HISTORY_STATE_FILE_NAME}`];
}
