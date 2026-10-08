import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../../logger';
import type { MetaReasoningItem } from '../../types';

/**
 * Provider-side store for Responses API encrypted reasoning.
 *
 * Copilot hosts do not reliably return provider data parts: the Agent Host (Copilot SDK) drops both
 * `stateful_marker` and thinking parts from history, so reasoning cannot ride along in the
 * conversation. Tool-call IDs do survive every host, so each response's reasoning items are keyed by
 * the tool calls it emitted and re-attached when that assistant turn is replayed. Entries are bound to
 * the API model that produced them, because encrypted reasoning only replays on that model.
 */

export const REASONING_REPLAY_FILE = 'reasoning-replay-v1.json';
const FILE_VERSION = 1;
const MAX_ENTRIES = 400;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 500;

interface ReasoningEntry {
	model: string;
	callIds: string[];
	items: MetaReasoningItem[];
	savedAt: number;
}

interface ReasoningReplayFile {
	version: number;
	entries: ReasoningEntry[];
}

export interface ReasoningLookup {
	(model: string, callIds: readonly string[]): MetaReasoningItem[] | undefined;
}

export class ReasoningReplayStore {
	/** Insertion-ordered, oldest first. */
	private entries: ReasoningEntry[] = [];
	private readonly byCallId = new Map<string, ReasoningEntry>();
	private loading: Promise<void> | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private saving: Promise<void> = Promise.resolve();

	constructor(
		private readonly filePath: string | undefined,
		private readonly now: () => number = Date.now,
	) {}

	static forStorageDir(storageDir: string): ReasoningReplayStore {
		return new ReasoningReplayStore(join(storageDir, REASONING_REPLAY_FILE));
	}

	/** Loads persisted entries once; later calls reuse the same load. */
	ready(): Promise<void> {
		this.loading ??= this.load();
		return this.loading;
	}

	record(model: string, callIds: readonly string[], items: readonly MetaReasoningItem[]): void {
		const ids = [...new Set(callIds.filter((id) => id.length > 0))];
		// Only the opaque encrypted state is kept; readable summaries never touch disk.
		const replayable = items
			.filter((item) => item.encrypted_content)
			.map(
				(item): MetaReasoningItem => ({
					type: 'reasoning',
					...(item.id ? { id: item.id } : {}),
					summary: [],
					encrypted_content: item.encrypted_content,
				}),
			);
		if (ids.length === 0 || replayable.length === 0) {
			return;
		}
		const entry: ReasoningEntry = { model, callIds: ids, items: replayable, savedAt: this.now() };
		this.entries.push(entry);
		for (const id of ids) {
			this.byCallId.set(id, entry);
		}
		this.prune();
		this.scheduleSave();
	}

	readonly lookup: ReasoningLookup = (model, callIds) => {
		for (const id of callIds) {
			const entry = this.byCallId.get(id);
			if (entry && entry.model === model && !this.isExpired(entry)) {
				return entry.items;
			}
		}
		return undefined;
	};

	get size(): number {
		return this.entries.length;
	}

	/** Writes any pending change now. */
	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
			this.saving = this.saving.then(() => this.save());
		}
		await this.saving;
	}

	private async load(): Promise<void> {
		if (!this.filePath) {
			return;
		}
		let parsed: ReasoningReplayFile;
		try {
			parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ReasoningReplayFile;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				logger.warn('[reasoning-replay] Ignoring unreadable reasoning store', error);
			}
			return;
		}
		if (parsed?.version !== FILE_VERSION || !Array.isArray(parsed.entries)) {
			return;
		}
		// Entries recorded before the load finished are newer than anything on disk.
		const recorded = this.entries;
		this.entries = [];
		this.byCallId.clear();
		for (const entry of [...parsed.entries.filter(isValidEntry), ...recorded]) {
			this.entries.push(entry);
			for (const id of entry.callIds) {
				this.byCallId.set(id, entry);
			}
		}
		this.prune();
	}

	private prune(): void {
		const cutoff = this.now() - MAX_AGE_MS;
		const overflow = Math.max(0, this.entries.length - MAX_ENTRIES);
		const kept = this.entries.filter((entry, index) => index >= overflow && entry.savedAt >= cutoff);
		if (kept.length === this.entries.length) {
			return;
		}
		this.entries = kept;
		this.byCallId.clear();
		for (const entry of kept) {
			for (const id of entry.callIds) {
				this.byCallId.set(id, entry);
			}
		}
	}

	private isExpired(entry: ReasoningEntry): boolean {
		return entry.savedAt < this.now() - MAX_AGE_MS;
	}

	private scheduleSave(): void {
		if (!this.filePath || this.saveTimer) {
			return;
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.saving = this.saving.then(() => this.save());
		}, SAVE_DELAY_MS);
		this.saveTimer.unref?.();
	}

	private async save(): Promise<void> {
		if (!this.filePath) {
			return;
		}
		try {
			await this.ready();
			const payload: ReasoningReplayFile = { version: FILE_VERSION, entries: this.entries };
			await mkdir(dirname(this.filePath), { recursive: true });
			const tempPath = `${this.filePath}.tmp`;
			await writeFile(tempPath, JSON.stringify(payload), 'utf8');
			await rename(tempPath, this.filePath);
		} catch (error) {
			logger.warn('[reasoning-replay] Failed to save reasoning store', error);
		}
	}
}

function isValidEntry(value: unknown): value is ReasoningEntry {
	const entry = value as ReasoningEntry;
	return (
		Boolean(entry) &&
		typeof entry.model === 'string' &&
		typeof entry.savedAt === 'number' &&
		Array.isArray(entry.callIds) &&
		entry.callIds.every((id) => typeof id === 'string') &&
		Array.isArray(entry.items) &&
		entry.items.every(
			(item) =>
				item?.type === 'reasoning' &&
				typeof item.encrypted_content === 'string' &&
				Array.isArray(item.summary),
		)
	);
}
