import vscode from 'vscode';
import { t } from '../i18n';
import { logger } from '../logger';
import { MetaChatProvider } from '../provider';
import { UsageDashboard, UsageService, UsageStatusBar } from '../usage';
import { createFileUsageStore } from '../usage/fileStore';
import { registerActionUrls } from './actions';
import { registerCommands } from './commands';
import { initializeDiagnostics } from './diagnostics';
import { registerProvider } from './provider';
import { showWelcomeIfNeeded } from './welcome';

let activeProvider: MetaChatProvider | undefined;
let activeDashboard: UsageDashboard | undefined;
let activeStatusBar: UsageStatusBar | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	await initializeDiagnostics(context);
	const store = createFileUsageStore(context.globalStorageUri);
	activeDashboard = new UsageDashboard(context, store, () => {
		activeStatusBar
			?.refresh()
			.catch((error) => logger.warn('[usage] Status refresh failed', error));
	});
	const usageService = new UsageService({
		store,
		onRecorded: () => {
			activeStatusBar
				?.refresh()
				.catch((error) => logger.warn('[usage] Status refresh failed', error));
			// R11A: coalesced state-preserving live update; never reset the
			// dashboard's filters/expanded cards on each recorded request.
			try {
				activeDashboard?.notifyRecorded();
			} catch (error) {
				logger.warn('[usage] Dashboard notify failed', error);
			}
		},
	});
	activeStatusBar = new UsageStatusBar(store, () => activeDashboard?.open());
	activeDashboard.setOnCleared(async () => {
		try {
			await usageService.clearAll();
			// R11D: dashboard clear must refresh the status bar immediately
			// (the initial constructor callback is replaced here, so refresh
			// explicitly alongside the clear).
			await activeStatusBar
				?.refresh()
				.catch((error) => logger.warn('[usage] Status refresh failed', error));
		} catch (error) {
			logger.warn('[usage] Dashboard clear failed', error);
			throw error;
		}
	});
	context.subscriptions.push(activeDashboard, activeStatusBar);
	registerCommands(
		context,
		{ dashboard: activeDashboard, statusBar: activeStatusBar, store },
		() => usageService,
	);
	registerActionUrls(context);

	try {
		const provider = await registerProvider(context, usageService);
		activeProvider = provider;

		void showWelcomeIfNeeded(context, provider).catch((error) => {
			logger.warn(t('extension.welcomeFailed'), error);
		});
		void activeStatusBar
			.refresh()
			.catch((error) => logger.warn('[usage] Status refresh failed', error));
		activeStatusBar.startAutoRefresh();

		logger.info(`Extension activated version=${context.extension.packageJSON.version}`);
	} catch (error) {
		activeProvider = undefined;
		logger.error('Failed to activate Meta extension', error);
		void vscode.window.showErrorMessage(t('extension.activateFailed'));
		throw error;
	}
}

export async function deactivate(): Promise<void> {
	try {
		await activeProvider?.prepareForDeactivate();
	} catch (error) {
		logger.warn(t('extension.deactivateFailed'), error);
	} finally {
		activeProvider = undefined;
		activeDashboard = undefined;
		activeStatusBar = undefined;
		logger.info('Extension deactivated');
		logger.dispose();
	}
}
