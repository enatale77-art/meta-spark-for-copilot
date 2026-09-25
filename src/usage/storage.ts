/**
 * File-backed usage storage under `<globalStorageUri>/usage-v1/`.
 *
 * - `requests.jsonl` — append-only ledger, schema-versioned per line.
 * - `contexts.json`  — versioned chat/task metadata, written atomically.
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
export const REQUEST_RECORD_VERSION = 1;

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

export interface UsageStore {
	appendRequest(record: UsageRequestRecord): Promise<void>;
	readRequests(): Promise<ParsedLedger>;
	readContexts(): Promise<ContextsFile>;
	writeContexts(contexts: ContextsFile): Promise<void>;
	clear(): Promise<void>;
}

/** In-memory store for tests and deterministic verification. */
export function createMemoryUsageStore(): UsageStore & {
	getRecords(): UsageRequestRecord[];
	getContexts(): ContextsFile;
} {
	let records: UsageRequestRecord[] = [];
	let contexts: ContextsFile = emptyContexts();
	return {
		async appendRequest(record: UsageRequestRecord): Promise<void> {
			records.push(record);
		},
		async readRequests(): Promise<ParsedLedger> {
			return { records: [...records], corruptedTailLines: 0, corruptedLines: 0 };
		},
		async readContexts(): Promise<ContextsFile> {
			return structuredClone(contexts);
		},
		async writeContexts(next: ContextsFile): Promise<void> {
			contexts = structuredClone(next);
		},
		async clear(): Promise<void> {
			records = [];
			contexts = emptyContexts();
		},
		getRecords(): UsageRequestRecord[] {
			return [...records];
		},
		getContexts(): ContextsFile {
			return structuredClone(contexts);
		},
	};
}

/** Scope guard: clearing usage history must only target usage-v1 files. */
export function usageClearTargets(): readonly string[] {
	return [`${USAGE_DIR_NAME}/${REQUESTS_FILE_NAME}`, `${USAGE_DIR_NAME}/${CONTEXTS_FILE_NAME}`];
}
