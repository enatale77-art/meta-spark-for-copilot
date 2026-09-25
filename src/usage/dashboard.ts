import vscode from 'vscode';
import {
	aggregateRequests,
	filterByTime,
	rollupChats,
	rollupTasks,
	rollupUnassignedOverhead,
} from './aggregate';
import { toCsvText } from './csv';
import { t } from '../i18n';
import { logger } from '../logger';
import type { UsageRequestRecord } from './types';
import type { UsageStore } from './storage';

export type UsagePeriod = '7d' | '30d' | '90d' | 'all';

export interface UsageDashboardState {
	period: UsagePeriod;
	projectId: string;
	modelId: string;
	search: string;
	selectedTaskId: string | null;
}

export class UsageDashboard {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: UsageStore,
		private onCleared?: () => void | Promise<void>,
	) {}

	setOnCleared(onCleared: () => void | Promise<void>): void {
		this.onCleared = onCleared;
	}

	async open(): Promise<void> {
		if (this.panel) {
			this.panel.reveal();
			await this.refresh();
			return;
		}
		this.panel = vscode.window.createWebviewPanel(
			'metaSparkUsageDashboard',
			t('usage.dashboard.title'),
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);
		this.panel.webview.options = { enableScripts: true };
		this.panel.webview.html = this.renderShell(t('usage.dashboard.loading'));
		this.panel.onDidDispose(
			() => {
				this.panel = undefined;
			},
			null,
			this.disposables,
		);
		this.panel.webview.onDidReceiveMessage(
			async (message) => {
				await this.handleMessage(message);
			},
			null,
			this.disposables,
		);
		await this.refresh();
	}

	async refresh(): Promise<void> {
		if (!this.panel) {
			return;
		}
		try {
			const ledger = await this.store.readRequests();
			const contexts = await this.store.readContexts();
			this.panel.webview.html = this.renderDashboard(ledger.records, contexts, {
				period: '30d',
				projectId: 'all',
				modelId: 'all',
				search: '',
				selectedTaskId: null,
			});
			if (ledger.corruptedLines > 0) {
				logger.warn(
					`[usage] Ignored ${ledger.corruptedLines} corrupted ledger line(s); history remains readable.`,
				);
			}
		} catch (error) {
			logger.warn('[usage] Failed to render dashboard', error);
			this.panel.webview.html = this.renderShell(t('usage.dashboard.loadFailed'));
		}
	}

	private async handleMessage(message: {
		command?: string;
		[key: string]: unknown;
	}): Promise<void> {
		if (!this.panel) {
			return;
		}
		try {
			if (message.command === 'refresh') {
				await this.refresh();
			} else if (message.command === 'filter') {
				const ledger = await this.store.readRequests();
				const contexts = await this.store.readContexts();
				this.panel.webview.html = this.renderDashboard(ledger.records, contexts, {
					period: toPeriod(message.period),
					projectId: typeof message.projectId === 'string' ? message.projectId : 'all',
					modelId: typeof message.modelId === 'string' ? message.modelId : 'all',
					search: typeof message.search === 'string' ? message.search : '',
					selectedTaskId:
						typeof message.selectedTaskId === 'string' && message.selectedTaskId
							? message.selectedTaskId
							: null,
				});
			} else if (message.command === 'exportCsv') {
				await this.exportCsv();
			} else if (message.command === 'clear') {
				await this.clearHistory();
			} else if (message.command === 'copy') {
				const value = typeof message.value === 'string' ? message.value : '';
				await vscode.env.clipboard.writeText(value);
				void vscode.window.showInformationMessage(t('usage.dashboard.copied'));
			}
		} catch (error) {
			logger.warn('[usage] Dashboard action failed', error);
			void vscode.window.showErrorMessage(t('usage.dashboard.actionFailed'));
		}
	}

	private async exportCsv(): Promise<void> {
		const ledger = await this.store.readRequests();
		if (ledger.records.length === 0) {
			void vscode.window.showInformationMessage(t('usage.export.empty'));
			return;
		}
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file('meta-spark-usage.csv'),
			filters: { CSV: ['csv'] },
			saveLabel: t('usage.export.saveLabel'),
		});
		if (!uri) {
			return;
		}
		const text = toCsvText(ledger.records);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
		void vscode.window.showInformationMessage(t('usage.export.done', ledger.records.length));
	}

	private async clearHistory(): Promise<void> {
		const confirmed = await vscode.window.showWarningMessage(
			t('usage.clear.confirm'),
			{ modal: true },
			t('usage.clear.confirmYes'),
		);
		if (confirmed !== t('usage.clear.confirmYes')) {
			return;
		}
		// The lifecycle onCleared hook routes through UsageService.clearAll()
		// so storage deletion and contexts-cache invalidation stay together.
		if (this.onCleared) {
			await this.onCleared();
		} else {
			await this.store.clear();
		}
		await this.refresh();
		void vscode.window.showInformationMessage(t('usage.clear.done'));
	}

	private renderShell(body: string): string {
		return [
			'<!DOCTYPE html><html><head><meta charset="utf-8">',
			"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none';\">",
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
			'<style>body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}</style>',
			'</head><body>',
			`<p>${escapeHtml(body)}</p>`,
			'</body></html>',
		].join('');
	}

	private renderDashboard(
		allRecords: UsageRequestRecord[],
		contexts: {
			chats: Record<string, { displayName: string }>;
			tasks: Record<string, { preview: string }>;
		},
		state: UsageDashboardState,
	): string {
		const periodDays = state.period === 'all' ? null : Number.parseInt(state.period, 10);
		let records = filterByTime(allRecords, Date.now(), periodDays);
		if (state.projectId !== 'all') {
			records = records.filter((record) => record.projectId === state.projectId);
		}
		if (state.modelId !== 'all') {
			records = records.filter((record) => record.vscodeModelId === state.modelId);
		}
		const query = state.search.trim().toLowerCase();
		if (query) {
			records = records.filter((record) =>
				(record.taskPreview ?? '').toLowerCase().includes(query),
			);
		}
		const totals = aggregateRequests(records);
		const tasks = rollupTasks(
			records,
			new Map(Object.entries(contexts.tasks).map(([id, task]) => [id, task.preview])),
		);
		const chats = rollupChats(
			tasks,
			new Map(Object.entries(contexts.chats).map(([id, chat]) => [id, chat.displayName])),
		);
		const projects = [...new Set(allRecords.map((record) => record.projectId))];
		const models = [...new Set(allRecords.map((record) => record.vscodeModelId))];
		const projectNameById = new Map(
			allRecords.map((record) => [record.projectId, record.projectName] as const),
		);

		const selectedTask = state.selectedTaskId
			? tasks.find((task) => task.taskId === state.selectedTaskId)
			: undefined;
		const selectedRequests = selectedTask
			? records
					.filter((record) => record.taskId === selectedTask.taskId)
					.sort((a, b) => a.timestampMs - b.timestampMs)
			: [];
		const overhead = rollupUnassignedOverhead(records);

		return [
			'<!DOCTYPE html><html><head><meta charset="utf-8">',
			"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none';\">",
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
			'<style>',
			'body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}',
			'.cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}',
			'.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:10px 14px;min-width:140px}',
			'.card .label{opacity:.75;font-size:12px}',
			'.card .value{font-size:18px;font-weight:600}',
			'table{border-collapse:collapse;width:100%;margin-top:12px}',
			'th,td{border-bottom:1px solid var(--vscode-panel-border);padding:6px 8px;text-align:left;font-size:12px;vertical-align:top}',
			'.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}',
			'input,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 8px}',
			'button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:5px 12px;cursor:pointer}',
			'button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}',
			'.note{opacity:.8;font-size:12px;margin-top:12px}',
			'code{font-size:11px}',
			'</style></head><body>',
			`<h2>${escapeHtml(t('usage.dashboard.title'))}</h2>`,
			`<div class="toolbar">`,
			`<label>${escapeHtml(t('usage.dashboard.period'))} <select id="period">`,
			renderOptions(['7d', '30d', '90d', 'all'], state.period),
			`</select></label>`,
			`<label>${escapeHtml(t('usage.dashboard.project'))} <select id="projectId">`,
			`<option value="all">${escapeHtml(t('usage.dashboard.all'))}</option>`,
			projects
				.map(
					(id) =>
						`<option value="${escapeHtml(id)}"${id === state.projectId ? ' selected' : ''}>${escapeHtml(projectNameById.get(id) ?? id)}</option>`,
				)
				.join(''),
			`</select></label>`,
			`<label>${escapeHtml(t('usage.dashboard.model'))} <select id="modelId">`,
			`<option value="all">${escapeHtml(t('usage.dashboard.all'))}</option>`,
			models
				.map(
					(id) =>
						`<option value="${escapeHtml(id)}"${id === state.modelId ? ' selected' : ''}>${escapeHtml(id)}</option>`,
				)
				.join(''),
			`</select></label>`,
			`<label>${escapeHtml(t('usage.dashboard.search'))} <input id="search" value="${escapeHtml(state.search)}" placeholder="${escapeHtml(t('usage.dashboard.searchPlaceholder'))}"></label>`,
			`<button id="apply">${escapeHtml(t('usage.dashboard.apply'))}</button>`,
			`<button id="refresh" class="secondary">${escapeHtml(t('usage.dashboard.refresh'))}</button>`,
			`<button id="exportCsv" class="secondary">${escapeHtml(t('usage.export.title'))}</button>`,
			`<button id="clear" class="secondary">${escapeHtml(t('usage.clear.title'))}</button>`,
			`</div>`,
			`<div class="cards">`,
			summaryCard(t('usage.dashboard.requests'), String(totals.requests)),
			summaryCard(t('usage.dashboard.input'), formatNumber(totals.inputTokens)),
			summaryCard(t('usage.dashboard.cached'), formatNumber(totals.cachedTokens)),
			summaryCard(t('usage.dashboard.output'), formatNumber(totals.outputTokens)),
			summaryCard(t('usage.dashboard.cacheHit'), `${totals.cacheHitPct.toFixed(1)}%`),
			summaryCard(t('usage.dashboard.cost'), formatCost(totals.estimatedCostUsd)),
			`</div>`,
			`<h3>${escapeHtml(t('usage.dashboard.tasks'))} (${tasks.length})</h3>`,
			tasks.length === 0
				? `<p class="note">${escapeHtml(t('usage.dashboard.empty'))}</p>`
				: [
						'<table><thead><tr>',
						`<th>${escapeHtml(t('usage.dashboard.task'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.project'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.chat'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.start'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.lastActivity'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.requests'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.input'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.cached'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.cacheHit'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.output'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.reasoning'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.cost'))}</th>`,
						'</tr></thead><tbody>',
						...tasks.map(
							(task) =>
								`<tr><td><a href="#" data-task="${escapeHtml(task.taskId)}">${escapeHtml(task.preview || task.taskId.slice(0, 8))}</a><br><code>${escapeHtml(task.taskId)}</code></td>` +
								`<td>${escapeHtml(task.projectName)}</td>` +
								`<td>${escapeHtml(chatLabel(task.chatId, contexts))}<br><code>${escapeHtml(task.chatId ?? '')}</code></td>` +
								`<td>${escapeHtml(formatDateTime(task.firstSeenMs))}</td>` +
								`<td>${escapeHtml(formatDateTime(task.lastSeenMs))}</td>` +
								`<td>${task.requests}</td><td>${formatNumber(task.inputTokens)}</td><td>${formatNumber(task.cachedTokens)}</td>` +
								`<td>${task.cacheHitPct.toFixed(1)}%</td><td>${formatNumber(task.outputTokens)}</td>` +
								`<td>${formatNumber(task.reasoningTokens)}</td><td>${formatCost(task.estimatedCostUsd)}</td></tr>`,
						),
						'</tbody></table>',
					].join(''),
			selectedTask
				? [
						`<h3>${escapeHtml(t('usage.dashboard.taskDetail'))}: ${escapeHtml(selectedTask.preview || selectedTask.taskId)}</h3>`,
						`<p class="note">task_id <code>${escapeHtml(selectedTask.taskId)}</code> <button data-copy="${escapeHtml(selectedTask.taskId)}">${escapeHtml(t('usage.dashboard.copy'))}</button> · chat_id <code>${escapeHtml(selectedTask.chatId ?? '')}</code> <button data-copy="${escapeHtml(selectedTask.chatId ?? '')}">${escapeHtml(t('usage.dashboard.copy'))}</button></p>`,
						`<p class="note">${escapeHtml(t('usage.dashboard.kindBreakdown'))}</p>`,
						'<table><thead><tr>',
						`<th>${escapeHtml(t('usage.dashboard.kind'))}</th><th>${escapeHtml(t('usage.dashboard.requests'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.input'))}</th><th>${escapeHtml(t('usage.dashboard.cached'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.cacheHit'))}</th><th>${escapeHtml(t('usage.dashboard.output'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.reasoning'))}</th><th>${escapeHtml(t('usage.dashboard.cost'))}</th>`,
						'</tr></thead><tbody>',
						...Object.entries(selectedTask.byKind)
							.sort((a, b) => b[1].requests - a[1].requests)
							.map(
								([kind, kindTotals]) =>
									`<tr><td>${escapeHtml(kind)}</td><td>${kindTotals.requests}</td>` +
									`<td>${formatNumber(kindTotals.inputTokens)}</td><td>${formatNumber(kindTotals.cachedTokens)}</td>` +
									`<td>${kindTotals.cacheHitPct.toFixed(1)}%</td><td>${formatNumber(kindTotals.outputTokens)}</td>` +
									`<td>${formatNumber(kindTotals.reasoningTokens)}</td><td>${formatCost(kindTotals.estimatedCostUsd)}</td></tr>`,
							),
						'</tbody></table>',
						'<table><thead><tr>',
						`<th>${escapeHtml(t('usage.dashboard.time'))}</th><th>${escapeHtml(t('usage.dashboard.kind'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.input'))}</th><th>${escapeHtml(t('usage.dashboard.cached'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.output'))}</th><th>${escapeHtml(t('usage.dashboard.cost'))}</th>`,
						'</tr></thead><tbody>',
						...selectedRequests.map(
							(record) =>
								`<tr><td>${escapeHtml(record.timestamp)}</td><td>${escapeHtml(record.requestKind)}</td>` +
								`<td>${formatNullable(record.promptTokens)}</td><td>${formatNullable(record.cachedInputTokens)}</td>` +
								`<td>${formatNullable(record.completionTokens)}</td><td>${formatCost(record.estimatedCostUsd ?? 0)}</td></tr>`,
						),
						'</tbody></table>',
					].join('')
				: '',
			`<h3>${escapeHtml(t('usage.dashboard.chats'))} (${chats.length})</h3>`,
			chats.length === 0
				? `<p class="note">${escapeHtml(t('usage.dashboard.emptyChats'))}</p>`
				: [
						'<table><thead><tr>',
						`<th>${escapeHtml(t('usage.dashboard.chat'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.tasks'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.requests'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.cost'))}</th>`,
						'</tr></thead><tbody>',
						...chats.map(
							(chat) =>
								`<tr><td>${escapeHtml(chat.displayName)}<br><code>${escapeHtml(chat.chatId)}</code></td>` +
								`<td>${chat.taskCount}</td><td>${chat.requests}</td><td>${formatCost(chat.estimatedCostUsd)}</td></tr>`,
						),
						'</tbody></table>',
					].join(''),
			`<h3>${escapeHtml(t('usage.dashboard.overhead'))} (${overhead.requests})</h3>`,
			overhead.requests === 0
				? `<p class="note">${escapeHtml(t('usage.dashboard.emptyOverhead'))}</p>`
				: [
						`<p class="note">${escapeHtml(t('usage.dashboard.overheadNote'))}</p>`,
						'<table><thead><tr>',
						`<th>${escapeHtml(t('usage.dashboard.kind'))}</th><th>${escapeHtml(t('usage.dashboard.requests'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.input'))}</th><th>${escapeHtml(t('usage.dashboard.cached'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.cacheHit'))}</th><th>${escapeHtml(t('usage.dashboard.output'))}</th>`,
						`<th>${escapeHtml(t('usage.dashboard.reasoning'))}</th><th>${escapeHtml(t('usage.dashboard.cost'))}</th>`,
						'</tr></thead><tbody>',
						...Object.entries(overhead.byKind)
							.sort((a, b) => b[1].requests - a[1].requests)
							.map(
								([kind, kindTotals]) =>
									`<tr><td>${escapeHtml(kind)}</td><td>${kindTotals.requests}</td>` +
									`<td>${formatNumber(kindTotals.inputTokens)}</td><td>${formatNumber(kindTotals.cachedTokens)}</td>` +
									`<td>${kindTotals.cacheHitPct.toFixed(1)}%</td><td>${formatNumber(kindTotals.outputTokens)}</td>` +
									`<td>${formatNumber(kindTotals.reasoningTokens)}</td><td>${formatCost(kindTotals.estimatedCostUsd)}</td></tr>`,
							),
						'</tbody></table>',
					].join(''),
			`<p class="note">${escapeHtml(t('usage.dashboard.localChatNote'))}</p>`,
			'<script>',
			'const vscode = acquireVsCodeApi();',
			'function current(){return {command:"filter",period:document.getElementById("period").value,projectId:document.getElementById("projectId").value,modelId:document.getElementById("modelId").value,search:document.getElementById("search").value,selectedTaskId:window.__selectedTask||null}}',
			'document.getElementById("apply").addEventListener("click",()=>vscode.postMessage(current()));',
			'document.getElementById("refresh").addEventListener("click",()=>vscode.postMessage({command:"refresh"}));',
			'document.getElementById("exportCsv").addEventListener("click",()=>vscode.postMessage({command:"exportCsv"}));',
			'document.getElementById("clear").addEventListener("click",()=>vscode.postMessage({command:"clear"}));',
			'document.querySelectorAll("[data-task]").forEach(a=>a.addEventListener("click",e=>{e.preventDefault();window.__selectedTask=a.getAttribute("data-task");vscode.postMessage(Object.assign(current(),{selectedTaskId:window.__selectedTask}))}));',
			'document.querySelectorAll("[data-copy]").forEach(b=>b.addEventListener("click",()=>vscode.postMessage({command:"copy",value:b.getAttribute("data-copy")})));',
			'</script>',
			'</body></html>',
		].join('');
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.panel?.dispose();
	}
}

function toPeriod(value: unknown): UsagePeriod {
	return value === '7d' || value === '30d' || value === '90d' || value === 'all' ? value : '30d';
}

function renderOptions(options: string[], selected: string): string {
	return options
		.map(
			(option) =>
				`<option value="${option}"${option === selected ? ' selected' : ''}>${option}</option>`,
		)
		.join('');
}

function summaryCard(label: string, value: string): string {
	return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function chatLabel(
	chatId: string | null,
	contexts: { chats: Record<string, { displayName: string }> },
): string {
	if (!chatId) {
		return 'Unassigned';
	}
	return contexts.chats[chatId]?.displayName ?? chatId.slice(0, 8);
}

function formatNumber(value: number): string {
	return Math.round(value).toLocaleString('en-US');
}

function formatNullable(value: number | null): string {
	return value === null || value === undefined ? '—' : formatNumber(value);
}

function formatDateTime(valueMs: number): string {
	try {
		return new Date(valueMs).toLocaleString();
	} catch {
		return '—';
	}
}

function formatCost(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return '—';
	}
	return `$${value.toFixed(4)}`;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
