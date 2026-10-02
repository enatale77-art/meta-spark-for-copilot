import vscode from 'vscode';
import { EXTERNAL_URLS } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import { ensureRequestDumpRoot } from '../provider/debug';
import type { UsageDashboard } from '../usage/dashboard';
import type { UsageStatusBar } from '../usage/status';
import type { UsageStore } from '../usage/storage';
import { toCsvText } from '../usage/csv';

export function registerCommands(
	context: vscode.ExtensionContext,
	deps?: { dashboard?: UsageDashboard; statusBar?: UsageStatusBar; store?: UsageStore },
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('meta-spark.showLogs', () => logger.show()),
		vscode.commands.registerCommand('meta-spark.openRequestDumpsFolder', () =>
			openRequestDumpsFolder(context),
		),
		vscode.commands.registerCommand('meta-spark.getApiKey', () =>
			vscode.env.openExternal(vscode.Uri.parse(EXTERNAL_URLS.meta.apiKeys)),
		),
		vscode.commands.registerCommand('meta-spark.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'meta-spark-copilot'),
		),
		vscode.commands.registerCommand('meta-spark.openUsageDashboard', () =>
			openUsageDashboard(deps),
		),
		vscode.commands.registerCommand('meta-spark.exportUsageCsv', () => exportUsageCsv(deps)),
		vscode.commands.registerCommand('meta-spark.clearUsageHistory', () =>
			runHistoryAction(deps?.dashboard, (dashboard) => dashboard.clearHistory()),
		),
		vscode.commands.registerCommand('meta-spark.restoreUsageHistory', () =>
			runHistoryAction(deps?.dashboard, (dashboard) => dashboard.restoreHistory()),
		),
	);
}

async function openUsageDashboard(deps?: {
	dashboard?: UsageDashboard;
	statusBar?: UsageStatusBar;
}): Promise<void> {
	try {
		await deps?.dashboard?.open();
		if (!deps?.dashboard) {
			void vscode.window.showWarningMessage(t('usage.dashboard.unavailable'));
		}
	} catch (error) {
		logger.warn('Failed to open usage dashboard', error);
		void vscode.window.showErrorMessage(t('usage.dashboard.actionFailed'));
	}
}

async function exportUsageCsv(deps?: { store?: UsageStore }): Promise<void> {
	try {
		if (!deps?.store) {
			void vscode.window.showWarningMessage(t('usage.dashboard.unavailable'));
			return;
		}
		const ledger = await deps.store.readRequests();
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
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(toCsvText(ledger.records)));
		void vscode.window.showInformationMessage(t('usage.export.done', ledger.records.length));
	} catch (error) {
		logger.warn('Failed to export usage CSV', error);
		void vscode.window.showErrorMessage(t('usage.dashboard.actionFailed'));
	}
}

/**
 * Clear/Restore History from the Command Palette share the dashboard's
 * implementation, so every path only moves the visible-history cutoff and
 * refreshes the dashboard and status bar the same way.
 */
async function runHistoryAction(
	dashboard: UsageDashboard | undefined,
	action: (dashboard: UsageDashboard) => Promise<void>,
): Promise<void> {
	try {
		if (!dashboard) {
			void vscode.window.showWarningMessage(t('usage.dashboard.unavailable'));
			return;
		}
		await action(dashboard);
	} catch (error) {
		logger.warn('Failed to update usage history visibility', error);
		void vscode.window.showErrorMessage(t('usage.dashboard.actionFailed'));
	}
}

async function openRequestDumpsFolder(context: vscode.ExtensionContext): Promise<void> {
	try {
		const root = await ensureRequestDumpRoot(context.globalStorageUri);
		logger.info(`Opening request dumps folder: ${root.toString(true)}`);
		await vscode.commands.executeCommand('revealFileInOS', root);
	} catch (error) {
		logger.warn('Failed to open request dumps folder', error);
		void vscode.window.showErrorMessage(t('extension.openRequestDumpsFolderFailed'));
	}
}
