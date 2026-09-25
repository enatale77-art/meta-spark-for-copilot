import vscode from 'vscode';
import { USAGE_DIR_NAME, CONTEXTS_FILE_NAME, REQUESTS_FILE_NAME } from './storage';
import type { UsageStore } from './storage';
import { parseContextsText, parseLedgerText, serializeContexts, serializeRecord } from './storage';
import type { ContextsFile, UsageRequestRecord } from './types';
import { emptyContexts } from './types';

/**
 * VS Code FileSystem-backed usage store. Writes are queued to preserve
 * append order; contexts.json uses temp-file + rename for atomicity.
 * Only touches files under `<globalStorageUri>/usage-v1/`.
 */
export function createFileUsageStore(globalStorageUri: vscode.Uri): UsageStore {
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
				const encoded = new TextEncoder().encode(line);
				let existing: Uint8Array;
				try {
					existing = await vscode.workspace.fs.readFile(requestsUri);
				} catch {
					existing = new Uint8Array(0);
				}
				const merged = new Uint8Array(existing.length + encoded.length);
				merged.set(existing, 0);
				merged.set(encoded, existing.length);
				await vscode.workspace.fs.writeFile(requestsUri, merged);
			});
		},
		readRequests(): Promise<{
			records: UsageRequestRecord[];
			corruptedTailLines: number;
			corruptedLines: number;
		}> {
			return enqueue(async () => {
				try {
					const data = await vscode.workspace.fs.readFile(requestsUri);
					return parseLedgerText(new TextDecoder().decode(data));
				} catch (error) {
					if ((error as vscode.FileSystemError)?.code === 'FileNotFound') {
						return { records: [], corruptedTailLines: 0, corruptedLines: 0 };
					}
					throw error;
				}
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
