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
	selectedChatId: string | null;
	overheadExpanded: boolean;
}

export interface UsageChangeSignature {
	requestBytes: number;
	contextBytes: number;
	requestCount: number;
}

/** Pure change-signature comparison for cross-window sync (R10). */
export function usageSignatureChanged(
	previous: UsageChangeSignature | undefined,
	current: UsageChangeSignature,
): boolean {
	if (!previous) {
		return true;
	}
	return (
		previous.requestBytes !== current.requestBytes ||
		previous.contextBytes !== current.contextBytes ||
		previous.requestCount !== current.requestCount
	);
}

/** Debounce helper: coalesce fast agent-loop bursts into one refresh. */
export function shouldRefreshSignature(
	previous: UsageChangeSignature | undefined,
	current: UsageChangeSignature,
	lastRefreshMs: number,
	nowMs: number,
	minIntervalMs: number,
): boolean {
	if (!usageSignatureChanged(previous, current)) {
		return false;
	}
	return nowMs - lastRefreshMs >= minIntervalMs;
}

export interface PendingRefreshState {
	acknowledged: UsageChangeSignature | undefined;
	pending: UsageChangeSignature | undefined;
	lastRefreshMs: number;
}

/**
 * R11B: decide whether a poll should render now or hold a pending change.
 * A changed signature observed inside the debounce holdoff is retained as
 * pending (never acknowledged as seen) so a later poll still refreshes even
 * when no further writes occur.
 */
export function nextRefreshDecision(
	state: PendingRefreshState,
	current: UsageChangeSignature | undefined,
	nowMs: number,
	minIntervalMs: number,
): { shouldRefresh: boolean; pending: UsageChangeSignature | undefined } {
	if (!current) {
		return { shouldRefresh: false, pending: state.pending };
	}
	if (!usageSignatureChanged(state.acknowledged, current)) {
		return { shouldRefresh: false, pending: undefined };
	}
	if (nowMs - state.lastRefreshMs >= minIntervalMs) {
		return { shouldRefresh: true, pending: undefined };
	}
	return { shouldRefresh: false, pending: current };
}

export class UsageDashboard {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private viewState: UsageDashboardState = {
		period: '30d',
		projectId: 'all',
		modelId: 'all',
		search: '',
		selectedTaskId: null,
		selectedChatId: null,
		overheadExpanded: false,
	};
	private watchTimer: NodeJS.Timeout | undefined;
	private lastSignature: UsageChangeSignature | undefined;
	private pendingSignature: UsageChangeSignature | undefined;
	private lastRefreshMs = 0;
	private refreshInFlight = false;
	private notifyTimer: NodeJS.Timeout | undefined;
	private notifyPending = false;

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
			await this.refreshPreservingState();
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
				this.stopWatching();
			},
			null,
			this.disposables,
		);
		this.panel.onDidChangeViewState(
			(e) => {
				if (e.webviewPanel.visible) {
					this.startWatching();
					void this.refreshPreservingState();
				} else {
					this.stopWatching();
				}
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
		await this.refreshPreservingState();
		this.startWatching();
	}

	/**
	 * R11A: coalesced entry point for locally recorded usage. Bursts of
	 * ledger writes share one state-preserving render on roughly the same
	 * 1–2s cadence as the cross-window watcher; filters and expanded
	 * Task/Chat/Overhead state are never reset by live updates.
	 */
	notifyRecorded(): void {
		if (!this.panel) {
			return;
		}
		if (this.notifyTimer) {
			this.notifyPending = true;
			return;
		}
		this.notifyPending = true;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined;
			if (!this.notifyPending) {
				return;
			}
			this.notifyPending = false;
			void this.refreshPreservingState().finally(() => {
				if (this.notifyPending && !this.notifyTimer) {
					this.notifyRecorded();
				}
			});
		}, 1500);
		if (typeof this.notifyTimer.unref === 'function') {
			this.notifyTimer.unref();
		}
	}

	async refresh(): Promise<void> {
		if (!this.panel) {
			return;
		}
		try {
			const ledger = await this.store.readRequests();
			const contexts = await this.store.readContexts();
			this.viewState = {
				period: '30d',
				projectId: 'all',
				modelId: 'all',
				search: '',
				selectedTaskId: null,
				selectedChatId: null,
				overheadExpanded: false,
			};
			this.lastSignature = await this.readSignature().catch(() => undefined);
			this.lastRefreshMs = Date.now();
			this.panel.webview.html = this.renderDashboard(ledger.records, contexts, this.viewState);
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
				await this.refreshPreservingState();
			} else if (message.command === 'filter') {
				this.viewState = {
					period: toPeriod(message.period),
					projectId: typeof message.projectId === 'string' ? message.projectId : 'all',
					modelId: typeof message.modelId === 'string' ? message.modelId : 'all',
					search: typeof message.search === 'string' ? message.search : '',
					selectedTaskId:
						typeof message.selectedTaskId === 'string' && message.selectedTaskId
							? message.selectedTaskId
							: null,
					selectedChatId:
						typeof message.selectedChatId === 'string' && message.selectedChatId
							? message.selectedChatId
							: null,
					overheadExpanded: message.overheadExpanded === true,
				};
				const ledger = await this.store.readRequests();
				const contexts = await this.store.readContexts();
				this.panel.webview.html = this.renderDashboard(ledger.records, contexts, this.viewState);
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
		const selectedChat = state.selectedChatId
			? chats.find((chat) => chat.chatId === state.selectedChatId)
			: undefined;
		const selectedChatTasks = selectedChat
			? tasks.filter((task) => task.chatId === selectedChat.chatId)
			: [];

		return [
			'<!DOCTYPE html><html><head><meta charset="utf-8">',
			"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none';\">",
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
			'<style>',
			'body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:1100px;margin:0 auto}',
			'.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:12px 0}',
			'.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:10px 14px;min-width:0;background:var(--vscode-sideBar-background)}',
			'.card .label{opacity:.75;font-size:12px}',
			'.card .value{font-size:18px;font-weight:600;overflow-wrap:anywhere}',
			'.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:12px;margin:12px 0}',
			'.tile{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px 14px;cursor:pointer;background:var(--vscode-sideBar-background);min-width:0}',
			'.tile:hover{border-color:var(--vscode-focusBorder)}',
			'.tile:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}',
			'.tile[aria-expanded=true]{border-color:var(--vscode-focusBorder)}',
			'.tile .title{font-weight:600;font-size:14px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
			'.tile .sub{opacity:.75;font-size:12px;margin-top:4px;overflow-wrap:anywhere}',
			'.tile .metrics{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px;font-size:12px}',
			'.tile .cost{font-weight:600;margin-top:8px}',
			'.detail{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px 14px;margin:12px 0;min-width:0}',
			'.detail-scroll{overflow-x:auto;max-width:100%}',
			'table{border-collapse:collapse;width:100%;margin-top:12px}',
			'th,td{border-bottom:1px solid var(--vscode-panel-border);padding:6px 8px;text-align:left;font-size:12px;vertical-align:top;overflow-wrap:anywhere}',
			'.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}',
			'.toolbar .spacer{flex:1 1 auto}',
			'input,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 8px;max-width:100%}',
			'button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:5px 12px;cursor:pointer;min-height:28px}',
			'button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}',
			'.note{opacity:.8;font-size:12px;margin-top:12px}',
			'code{font-size:11px;overflow-wrap:anywhere}',
			'@media (max-width:520px){body{padding:12px}.cards{grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}}',
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
			`<span class="spacer"></span>`,
			`<button id="refresh" class="secondary">${escapeHtml(t('usage.dashboard.refresh'))}</button>`,
			`<button id="exportCsv" class="secondary">${escapeHtml(t('usage.export.title'))}</button>`,
			`<button id="clear" class="secondary">${escapeHtml(t('usage.clear.title'))}</button>`,
			`</div>`,
			`<div class="cards">`,
			summaryCard(t('usage.dashboard.requests'), String(totals.requests)),
			summaryCard(t('usage.dashboard.input'), formatCompact(totals.inputTokens)),
			summaryCard(
				`${t('usage.dashboard.cached')} / ${t('usage.dashboard.cacheHit')}`,
				`${formatCompact(totals.cachedTokens)} · ${totals.cacheHitPct.toFixed(1)}%`,
			),
			summaryCard(t('usage.dashboard.output'), formatCompact(totals.outputTokens)),
			summaryCard(t('usage.dashboard.cost'), formatCost(totals.estimatedCostUsd)),
			`</div>`,
			`<h3>${escapeHtml(t('usage.dashboard.tasks'))} (${tasks.length})</h3>`,
			tasks.length === 0
				? `<p class="note">${escapeHtml(t('usage.dashboard.empty'))}</p>`
				: [
						'<div class="grid" role="list">',
						...tasks.map((task) => taskCard(task, state.selectedTaskId === task.taskId)),
						'</div>',
					].join(''),
			selectedTask
				? [
						`<div class="detail" id="task-detail">`,
						`<h3>${escapeHtml(t('usage.dashboard.taskDetail'))}: ${escapeHtml(selectedTask.preview || selectedTask.taskId.slice(0, 8))}</h3>`,
						`<p class="note">task_id <code>${escapeHtml(selectedTask.taskId)}</code> <button data-copy="${escapeHtml(selectedTask.taskId)}">${escapeHtml(t('usage.dashboard.copy'))}</button> · chat_id <code>${escapeHtml(selectedTask.chatId ?? '')}</code> <button data-copy="${escapeHtml(selectedTask.chatId ?? '')}">${escapeHtml(t('usage.dashboard.copy'))}</button></p>`,
						`<p class="note">${escapeHtml(t('usage.dashboard.start'))}: ${escapeHtml(formatDateTime(selectedTask.firstSeenMs))} · ${escapeHtml(t('usage.dashboard.lastActivity'))}: ${escapeHtml(formatDateTime(selectedTask.lastSeenMs))}</p>`,
						`<p class="note">${escapeHtml(t('usage.dashboard.input'))}: ${formatNumber(selectedTask.inputTokens)} · ${escapeHtml(t('usage.dashboard.cached'))}: ${formatNumber(selectedTask.cachedTokens)} · ${escapeHtml(t('usage.dashboard.output'))}: ${formatNumber(selectedTask.outputTokens)} · ${escapeHtml(t('usage.dashboard.reasoning'))}: ${formatNumber(selectedTask.reasoningTokens)}</p>`,
						`<p class="note">${escapeHtml(t('usage.dashboard.kindBreakdown'))}</p>`,
						'<div class="detail-scroll">',
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
						'</div>',
						'<div class="detail-scroll">',
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
						'</div>',
						`<p><button class="secondary" data-collapse="task">${escapeHtml(t('usage.dashboard.collapse'))}</button></p>`,
						`</div>`,
					].join('')
				: '',
			`<h3>${escapeHtml(t('usage.dashboard.chats'))} (${chats.length})</h3>`,
			chats.length === 0
				? `<p class="note">${escapeHtml(t('usage.dashboard.emptyChats'))}</p>`
				: [
						'<div class="grid" role="list">',
						...chats.map((chat) => chatCard(chat, tasks, state.selectedChatId === chat.chatId)),
						'</div>',
					].join(''),
			selectedChat
				? [
						`<div class="detail" id="chat-detail">`,
						`<h3>${escapeHtml(t('usage.dashboard.localSubject'))}: ${escapeHtml(selectedChat.displayName)}</h3>`,
						`<p class="note">${escapeHtml(t('usage.dashboard.localSubjectNote'))}</p>`,
						`<p class="note">chat_id <code>${escapeHtml(selectedChat.chatId)}</code> <button data-copy="${escapeHtml(selectedChat.chatId)}">${escapeHtml(t('usage.dashboard.copy'))}</button></p>`,
						`<p class="note">${escapeHtml(t('usage.dashboard.tasks'))}: ${selectedChat.taskCount} · ${escapeHtml(t('usage.dashboard.requests'))}: ${selectedChat.requests} · ${escapeHtml(t('usage.dashboard.cost'))}: ${formatCost(selectedChat.estimatedCostUsd)}</p>`,
						`<p class="note">${escapeHtml(t('usage.dashboard.start'))}: ${escapeHtml(formatDateTime(selectedChat.firstSeenMs))} · ${escapeHtml(t('usage.dashboard.lastActivity'))}: ${escapeHtml(formatDateTime(selectedChat.lastSeenMs))}</p>`,
						'<div class="grid" role="list">',
						...selectedChatTasks.map((task) =>
							taskCard(task, state.selectedTaskId === task.taskId),
						),
						'</div>',
						`<p><button class="secondary" data-collapse="chat">${escapeHtml(t('usage.dashboard.collapse'))}</button></p>`,
						`</div>`,
					].join('')
				: '',
			`<h3>${escapeHtml(t('usage.dashboard.overhead'))} (${overhead.requests})</h3>`,
			[
				`<div class="tile" role="listitem" tabindex="0" data-overhead="toggle" aria-expanded="${state.overheadExpanded ? 'true' : 'false'}" title="${escapeHtml(t('usage.dashboard.expand'))}">`,
				`<div class="title">${escapeHtml(t('usage.dashboard.overhead'))}</div>`,
				`<div class="sub">${overhead.requests} req · ${formatCompact(overhead.totalTokens)} tok</div>`,
				`<div class="cost">${formatCost(overhead.estimatedCostUsd)}</div>`,
				`</div>`,
			].join(''),
			state.overheadExpanded && overhead.requests > 0
				? [
						`<div class="detail" id="overhead-detail">`,
						`<p class="note">${escapeHtml(t('usage.dashboard.overheadNote'))}</p>`,
						'<div class="detail-scroll">',
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
						'</div>',
						`</div>`,
					].join('')
				: overhead.requests === 0
					? `<p class="note">${escapeHtml(t('usage.dashboard.emptyOverhead'))}</p>`
					: '',
			`<p class="note">${escapeHtml(t('usage.dashboard.localChatNote'))}</p>`,
			'<script>',
			'const vscode = acquireVsCodeApi();',
			'function readState(){return {period:document.getElementById("period").value,projectId:document.getElementById("projectId").value,modelId:document.getElementById("modelId").value,search:document.getElementById("search").value}}',
			'function current(extra){return Object.assign({command:"filter",selectedTaskId:window.__selectedTask||null,selectedChatId:window.__selectedChat||null,overheadExpanded:window.__overheadExpanded===true},readState(),extra||{})}',
			'document.getElementById("apply").addEventListener("click",()=>vscode.postMessage(current()));',
			'document.getElementById("refresh").addEventListener("click",()=>vscode.postMessage({command:"refresh"}));',
			'document.getElementById("exportCsv").addEventListener("click",()=>vscode.postMessage({command:"exportCsv"}));',
			'document.getElementById("clear").addEventListener("click",()=>vscode.postMessage({command:"clear"}));',
			'document.querySelectorAll("[data-task]").forEach(el=>{const select=()=>{const id=el.getAttribute("data-task");window.__selectedTask=(window.__selectedTask===id?null:id);vscode.postMessage(current({selectedTaskId:window.__selectedTask}))};el.addEventListener("click",select);el.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select()}})});',
			'document.querySelectorAll("[data-chat]").forEach(el=>{const select=()=>{const id=el.getAttribute("data-chat");window.__selectedChat=(window.__selectedChat===id?null:id);vscode.postMessage(current({selectedChatId:window.__selectedChat}))};el.addEventListener("click",select);el.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select()}})});',
			'document.querySelectorAll("[data-overhead]").forEach(el=>{const toggle=()=>{window.__overheadExpanded=!(window.__overheadExpanded===true);vscode.postMessage(current({overheadExpanded:window.__overheadExpanded}))};el.addEventListener("click",toggle);el.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();toggle()}})});',
			'document.querySelectorAll("[data-collapse]").forEach(b=>b.addEventListener("click",()=>{const kind=b.getAttribute("data-collapse");if(kind==="task"){window.__selectedTask=null}if(kind==="chat"){window.__selectedChat=null}vscode.postMessage(current({selectedTaskId:window.__selectedTask,selectedChatId:window.__selectedChat}))}));',
			'document.querySelectorAll("[data-copy]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();vscode.postMessage({command:"copy",value:b.getAttribute("data-copy")})}));',
			'</script>',
			'</body></html>',
		].join('');
	}

	private async refreshPreservingState(): Promise<void> {
		if (!this.panel) {
			return;
		}
		if (this.refreshInFlight) {
			return;
		}
		this.refreshInFlight = true;
		try {
			const ledger = await this.store.readRequests();
			const contexts = await this.store.readContexts();
			this.lastSignature = await this.readSignature().catch(() => undefined);
			this.lastRefreshMs = Date.now();
			this.panel.webview.html = this.renderDashboard(ledger.records, contexts, this.viewState);
			if (ledger.corruptedLines > 0) {
				logger.warn(
					`[usage] Ignored ${ledger.corruptedLines} corrupted ledger line(s); history remains readable.`,
				);
			}
		} catch (error) {
			logger.warn('[usage] Failed to render dashboard', error);
			this.panel.webview.html = this.renderShell(t('usage.dashboard.loadFailed'));
		} finally {
			this.refreshInFlight = false;
		}
	}

	/** R10: observe the shared ledger while the dashboard is visible. */
	private startWatching(): void {
		if (!this.panel || this.watchTimer) {
			return;
		}
		void this.readSignature()
			.then((signature) => {
				this.lastSignature = signature;
				this.lastRefreshMs = Date.now();
			})
			.catch((error) => {
				logger.warn('[usage] Failed to read usage signature', error);
			});
		this.watchTimer = setInterval(() => {
			void this.pollSignature();
		}, 1500);
		if (typeof this.watchTimer.unref === 'function') {
			this.watchTimer.unref();
		}
	}

	private stopWatching(): void {
		if (this.watchTimer) {
			clearInterval(this.watchTimer);
			this.watchTimer = undefined;
		}
	}

	private async pollSignature(): Promise<void> {
		if (!this.panel || !this.panel.visible || this.refreshInFlight) {
			return;
		}
		let current: UsageChangeSignature | undefined;
		try {
			current = await this.readSignature();
		} catch (error) {
			logger.warn('[usage] Failed to poll usage changes', error);
			return;
		}
		if (!current) {
			return;
		}
		// R11B: never acknowledge a changed signature merely because it was
		// observed inside the debounce holdoff. Retain it as pending so the
		// next poll still refreshes even when no further writes occur.
		const decision = nextRefreshDecision(
			{
				acknowledged: this.lastSignature,
				pending: this.pendingSignature,
				lastRefreshMs: this.lastRefreshMs,
			},
			current,
			Date.now(),
			1500,
		);
		this.pendingSignature = decision.pending ?? this.pendingSignature;
		if (!decision.shouldRefresh && this.pendingSignature) {
			return;
		}
		if (decision.shouldRefresh) {
			this.pendingSignature = undefined;
			await this.refreshPreservingState();
		}
	}

	private async readSignature(): Promise<UsageChangeSignature | undefined> {
		if (typeof this.store.getChangeSignature === 'function') {
			return this.store.getChangeSignature();
		}
		const ledger = await this.store.readRequests();
		const contexts = await this.store.readContexts();
		const requestBytes = ledger.records.reduce(
			(sum, record) => sum + (record.totalTokens ?? 0) + record.timestampMs,
			ledger.records.length,
		);
		return {
			requestBytes,
			contextBytes:
				Object.keys(contexts.chats).length * 100003 + Object.keys(contexts.tasks).length,
			requestCount: ledger.records.length,
		};
	}

	dispose(): void {
		this.stopWatching();
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

function taskCard(
	task: {
		taskId: string;
		preview: string;
		projectName: string;
		requests: number;
		inputTokens: number;
		cacheHitPct: number;
		outputTokens: number;
		estimatedCostUsd: number;
		lastSeenMs: number;
	},
	expanded: boolean,
): string {
	return [
		`<div class="tile" role="listitem" tabindex="0" data-task="${escapeHtml(task.taskId)}" aria-expanded="${expanded ? 'true' : 'false'}" title="${escapeHtml(t('usage.dashboard.expand'))}">`,
		`<div class="title">${escapeHtml(task.preview || task.taskId.slice(0, 8))}</div>`,
		`<div class="sub">${escapeHtml(task.projectName)}</div>`,
		`<div class="metrics"><span>${task.requests} req</span><span>${formatCompact(task.inputTokens)} in</span><span>${task.cacheHitPct.toFixed(1)}% cache</span><span>${formatCompact(task.outputTokens)} out</span></div>`,
		`<div class="cost">${formatCost(task.estimatedCostUsd)}</div>`,
		`</div>`,
	].join('');
}

function chatCard(
	chat: {
		chatId: string;
		displayName: string;
		taskCount: number;
		requests: number;
		estimatedCostUsd: number;
		inputTokens: number;
		cacheHitPct: number;
	},
	_tasks: unknown,
	expanded: boolean,
): string {
	// R12B: the collapsed chat card is the chat-level grouping/subject, not
	// the native Copilot title. The local subject derives from the first
	// cleaned human task preview and stays stable for the chat lifetime.
	return [
		`<div class="tile" role="listitem" tabindex="0" data-chat="${escapeHtml(chat.chatId)}" aria-expanded="${expanded ? 'true' : 'false'}" title="${escapeHtml(t('usage.dashboard.expand'))}">`,
		`<div class="sub">${escapeHtml(t('usage.dashboard.localSubject'))}</div>`,
		`<div class="title">${escapeHtml(chat.displayName)}</div>`,
		`<div class="sub">${chat.taskCount} tasks · ${chat.requests} requests</div>`,
		`<div class="metrics"><span>${formatCompact(chat.inputTokens)} in</span><span>${chat.cacheHitPct.toFixed(1)}% cache</span></div>`,
		`<div class="cost">${formatCost(chat.estimatedCostUsd)}</div>`,
		`</div>`,
	].join('');
}

function formatCompact(value: number): string {
	if (!Number.isFinite(value)) {
		return '—';
	}
	const rounded = Math.round(value);
	if (rounded >= 1_000_000) {
		return `${(rounded / 1_000_000).toFixed(1)}M`;
	}
	if (rounded >= 1_000) {
		return `${(rounded / 1_000).toFixed(1)}k`;
	}
	return String(rounded);
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
