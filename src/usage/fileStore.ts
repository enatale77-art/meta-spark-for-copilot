import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vscode from 'vscode';
import { USAGE_DIR_NAME, CONTEXTS_FILE_NAME, REQUESTS_FILE_NAME } from './storage';
import type { UsageStore } from './storage';
import { parseContextsText, parseLedgerText, serializeContexts, serializeRecord } from './storage';
import type { ContextsFile, UsageRequestRecord } from './types';
import { emptyContexts } from './types';
import { logger } from '../logger';

export interface FileUsageStoreOptions {
	/** Test seam: synchronous, Node-fs-compatible file operations. */
	nodeFs?: {
		mkdir: (path: string, options?: { recursive?: boolean }) => Promise<unknown>;
		appendFile: (
			path: string,
			data: string | Uint8Array,
			options?: { encoding?: BufferEncoding },
		) => Promise<unknown>;
		readFile: (path: string, encoding: 'utf8') => Promise<string>;
		writeFile: (path: string, data: string | Uint8Array) => Promise<unknown>;
		unlink: (path: string) => Promise<unknown>;
		rename: (from: string, to: string) => Promise<unknown>;
		readdir: (path: string) => Promise<string[]>;
		isNotFound: (error: unknown) => boolean;
	};
}

/**
 * VS Code FileSystem-backed usage store. The JSONL ledger uses true file
 * appends (never read-modify-write), so runtime cost stays constant per
 * record and a failed read/open can never replace prior history.
 * `contexts.json` uses temp-file + rename for atomicity.
 * Only touches files under `<globalStorageUri>/usage-v1/`.
 */
export function createFileUsageStore(
	globalStorageUri: vscode.Uri,
	options?: FileUsageStoreOptions,
): UsageStore {
	const fsPath = typeof globalStorageUri.fsPath === 'string' ? globalStorageUri.fsPath : '';
	if (!fsPath) {
		return createVscodeFsStore(globalStorageUri);
	}
	const dir = join(fsPath, USAGE_DIR_NAME);
	const requestsPath = join(dir, REQUESTS_FILE_NAME);
	const contextsPath = join(dir, CONTEXTS_FILE_NAME);
	const node = options?.nodeFs ?? defaultNodeFs();
	let queue: Promise<void> = Promise.resolve();

	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = queue.then(work, work);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	return {
		appendRequest(record: UsageRequestRecord): Promise<void> {
			return enqueue(async () => {
				await node.mkdir(dir, { recursive: true });
				await node.appendFile(requestsPath, `${serializeRecord(record)}\n`, {
					encoding: 'utf8',
				});
			});
		},
		readRequests(): Promise<{
			records: UsageRequestRecord[];
			corruptedTailLines: number;
			corruptedLines: number;
		}> {
			return enqueue(async () => {
				let text: string;
				try {
					text = await node.readFile(requestsPath, 'utf8');
				} catch (error) {
					if (node.isNotFound(error)) {
						return { records: [], corruptedTailLines: 0, corruptedLines: 0 };
					}
					throw error;
				}
				return parseLedgerText(text);
			});
		},
		readContexts(): Promise<ContextsFile> {
			return enqueue(async () => {
				let text: string;
				try {
					text = await node.readFile(contextsPath, 'utf8');
				} catch (error) {
					if (node.isNotFound(error)) {
						return emptyContexts();
					}
					throw error;
				}
				return parseContextsText(text).contexts;
			});
		},
		writeContexts(contexts: ContextsFile): Promise<void> {
			return enqueue(async () => {
				await node.mkdir(dir, { recursive: true });
				const payload = serializeContexts(contexts);
				const tempPath = join(dir, `${CONTEXTS_FILE_NAME}.${Date.now()}.${randomSuffix()}.tmp`);
				await node.writeFile(tempPath, payload);
				try {
					await node.rename(tempPath, contextsPath);
				} catch {
					// Best-effort cleanup; the next write recreates the file.
					await node.unlink(tempPath).catch(() => undefined);
					throw new Error('[usage] Failed to replace contexts.json atomically');
				}
				// Remove stale temp files from crashed writes; never fail the write.
				void cleanupStaleTempFiles(node, dir).catch((error) => {
					logger.warn('[usage] Failed to clean stale contexts temp files', error);
				});
			});
		},
		clear(): Promise<void> {
			return enqueue(async () => {
				for (const path of [requestsPath, contextsPath]) {
					try {
						await node.unlink(path);
					} catch (error) {
						if (!node.isNotFound(error)) {
							throw error;
						}
					}
				}
			});
		},
	};
}

function randomSuffix(): string {
	return createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8);
}

async function cleanupStaleTempFiles(
	node: NonNullable<FileUsageStoreOptions['nodeFs']>,
	dir: string,
): Promise<void> {
	let entries: string[] = [];
	try {
		entries = await node.readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.startsWith(`${CONTEXTS_FILE_NAME}.`) && entry.endsWith('.tmp')) {
			await node.unlink(join(dir, entry)).catch(() => undefined);
		}
	}
}

function defaultNodeFs(): NonNullable<FileUsageStoreOptions['nodeFs']> {
	return {
		mkdir: (path, options) => mkdir(path, options),
		appendFile: (path, data, options) => appendFile(path, data, options),
		readFile: (path, encoding) => readFile(path, encoding),
		writeFile: (path, data) => writeFile(path, data),
		unlink: (path) => rm(path, { force: false }),
		rename: (from, to) => renameOverwrite(from, to),
		readdir: (path) => readdir(path),
		isNotFound: (error) => (error as NodeJS.ErrnoException)?.code === 'ENOENT',
	};
}

async function renameOverwrite(from: string, to: string): Promise<void> {
	try {
		const { rename } = await import('node:fs/promises');
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'EEXIST' || process.platform === 'win32') {
			await rm(to, { force: true });
			const { rename } = await import('node:fs/promises');
			await rename(from, to);
			return;
		}
		throw error;
	}
}

/**
 * Fallback for filesystems without a local path (virtual/remote). Keeps the
 * true-append contract: `appendRequest` never reads the ledger first and only
 * a genuine FileNotFound is treated as empty.
 */
function createVscodeFsStore(globalStorageUri: vscode.Uri): UsageStore {
	const dir = vscode.Uri.joinPath(globalStorageUri, USAGE_DIR_NAME);
	const requestsUri = vscode.Uri.joinPath(dir, REQUESTS_FILE_NAME);
	const contextsUri = vscode.Uri.joinPath(dir, CONTEXTS_FILE_NAME);
	let queue: Promise<void> = Promise.resolve();

	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = queue.then(work, work);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	return {
		appendRequest(record: UsageRequestRecord): Promise<void> {
			return enqueue(async () => {
				await vscode.workspace.fs.createDirectory(dir);
				const line = `${serializeRecord(record)}\n`;
				await appendThroughVscodeFs(requestsUri, new TextEncoder().encode(line));
			});
		},
		readRequests(): Promise<{
			records: UsageRequestRecord[];
			corruptedTailLines: number;
			corruptedLines: number;
		}> {
			return enqueue(async () => {
				let data: Uint8Array;
				try {
					data = await vscode.workspace.fs.readFile(requestsUri);
				} catch (error) {
					// Only a genuine missing file means "no history yet". Any
					// other read/open failure must surface — never silently
					// replace prior history or report an empty ledger.
					if ((error as vscode.FileSystemError)?.code === 'FileNotFound') {
						return { records: [], corruptedTailLines: 0, corruptedLines: 0 };
					}
					logger.warn('[usage] Failed to read requests ledger', error);
					throw error;
				}
				return parseLedgerText(new TextDecoder().decode(data));
			});
		},
		readContexts(): Promise<ContextsFile> {
			return enqueue(async () => {
				try {
					const data = await vscode.workspace.fs.readFile(contextsUri);
					const parsed = parseContextsText(new TextDecoder().decode(data));
					return parsed.contexts;
				} catch (error) {
					if ((error as vscode.FileSystemError)?.code === 'FileNotFound') {
						return emptyContexts();
					}
					throw error;
				}
			});
		},
		writeContexts(contexts: ContextsFile): Promise<void> {
			return enqueue(async () => {
				await vscode.workspace.fs.createDirectory(dir);
				const payload = new TextEncoder().encode(serializeContexts(contexts));
				const tempUri = vscode.Uri.joinPath(dir, `${CONTEXTS_FILE_NAME}.${Date.now()}.tmp`);
				await vscode.workspace.fs.writeFile(tempUri, payload);
				try {
					await vscode.workspace.fs.rename(tempUri, contextsUri, { overwrite: true });
				} catch {
					// Fallback for FS providers without overwrite rename support.
					try {
						await vscode.workspace.fs.delete(contextsUri, { useTrash: false });
					} catch {
						// ignore missing target
					}
					await vscode.workspace.fs.rename(tempUri, contextsUri, { overwrite: true });
				}
			});
		},
		clear(): Promise<void> {
			return enqueue(async () => {
				for (const uri of [requestsUri, contextsUri]) {
					try {
						await vscode.workspace.fs.delete(uri, { useTrash: false });
					} catch (error) {
						if ((error as vscode.FileSystemError)?.code !== 'FileNotFound') {
							throw error;
						}
					}
				}
			});
		},
	};
}

/**
 * Append bytes through the VS Code filesystem API. The API exposes no
 * offset-based write, so the queued append reads the current file and writes
 * back prior+chunk in one serialized step. The store queue makes that
 * read+write atomic relative to other store operations, and only a genuine
 * FileNotFound starts a new file — any other open/stat/read failure throws
 * and never truncates or replaces prior history.
 */
async function appendThroughVscodeFs(target: vscode.Uri, chunk: Uint8Array): Promise<void> {
	let existing: Uint8Array | undefined;
	try {
		const stat = await vscode.workspace.fs.stat(target);
		if (stat.size > 0) {
			existing = await vscode.workspace.fs.readFile(target);
		} else {
			existing = new Uint8Array(0);
		}
	} catch (error) {
		if ((error as vscode.FileSystemError)?.code === 'FileNotFound') {
			existing = new Uint8Array(0);
		} else {
			// A failed open/stat must never truncate or replace history.
			logger.warn('[usage] Failed to open ledger for append; keeping prior history', error);
			throw error;
		}
	}
	const prior = existing ?? new Uint8Array(0);
	const merged = new Uint8Array(prior.length + chunk.length);
	merged.set(prior, 0);
	merged.set(chunk, prior.length);
	await vscode.workspace.fs.writeFile(target, merged);
}
