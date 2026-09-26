import vscode from 'vscode';
import { aggregateRequests } from './aggregate';
import { t } from '../i18n';
import { getUsageStatusBarEnabled } from '../config';
import type { UsageStore } from './storage';
import { selectStatusTask } from './statusSelection';

const STATUS_BAR_PRIORITY = 90;

/**
 * Compact status-bar summary for the most recent tracked task in the
 * active workspace. Click opens the dashboard. Failures never block
 * model requests.
 */
export class UsageStatusBar {
	private readonly item: vscode.StatusBarItem;
	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly store: UsageStore,
		private readonly openDashboard: () => Promise<void> | void,
	) {
		this.item = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			STATUS_BAR_PRIORITY,
		);
		this.item.command = 'meta-spark.openUsageDashboard';
	}

	async refresh(): Promise<void> {
		try {
			if (!getUsageStatusBarEnabled()) {
				this.item.hide();
				return;
			}
			const ledger = await this.store.readRequests();
			const workspaceUris = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
				folder.uri.toString(),
			);
			const { latest, taskRecords } = selectStatusTask({
				records: ledger.records,
				workspaceUris,
				nowMs: Date.now(),
			});
			if (!latest) {
				this.item.text = t('usage.status.empty');
				this.item.tooltip = t('usage.status.emptyTooltip');
				this.item.show();
				return;
			}
			const totals = aggregateRequests(taskRecords.length > 0 ? taskRecords : [latest]);
			this.item.text = t(
				'usage.status.text',
				totals.requests,
				formatCompact(totals.totalTokens),
				formatCost(totals.estimatedCostUsd),
			);
			this.item.tooltip = [
				t('usage.status.tooltipTitle'),
				`${t('usage.dashboard.task')}: ${(latest.taskPreview || latest.taskId || '').slice(0, 80)}`,
				`${t('usage.dashboard.requests')}: ${totals.requests}`,
				`${t('usage.dashboard.input')}: ${totals.inputTokens} (${t('usage.dashboard.cached')}: ${totals.cachedTokens}, ${totals.cacheHitPct.toFixed(1)}%)`,
				`${t('usage.dashboard.output')}: ${totals.outputTokens}`,
				`${t('usage.dashboard.cost')}: ${formatCost(totals.estimatedCostUsd)}`,
				`chat_id: ${latest.chatId ?? ''}`,
				`task_id: ${latest.taskId ?? ''}`,
			].join('\n');
			this.item.show();
		} catch {
			// Status-bar failures must never block model requests.
			this.item.hide();
		}
	}

	startAutoRefresh(intervalMs = 30_000): void {
		this.stopAutoRefresh();
		this.refreshTimer = setInterval(() => {
			void this.refresh();
		}, intervalMs);
		if (typeof this.refreshTimer.unref === 'function') {
			this.refreshTimer.unref();
		}
	}

	stopAutoRefresh(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	dispose(): void {
		this.stopAutoRefresh();
		this.item.dispose();
	}
}

function formatCompact(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(Math.round(value));
}

function formatCost(value: number): string {
	return `$${value.toFixed(4)}`;
}
