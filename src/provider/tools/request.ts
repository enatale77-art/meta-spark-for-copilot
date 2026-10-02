import vscode from 'vscode';
import { t } from '../../i18n';
import type { MetaMessage, MetaTool } from '../../types';
import { convertTools } from '../convert';
import { META_TOOLS_LIMIT } from './consts';

/**
 * Converts the planned tool list for Meta. Larger sets must already be virtualized
 * (see `./virtual`); this guard keeps the outbound request within Meta's limit and refuses
 * rather than silently truncating.
 */
export function prepareRequestTools(
	toolCallingCapability: boolean | number | undefined,
	plannedTools: readonly vscode.LanguageModelChatTool[] | undefined,
): MetaTool[] | undefined {
	const tools = toolCallingCapability ? convertTools(plannedTools) : undefined;
	const toolLimit = getToolCallingLimit(toolCallingCapability);
	const toolsCount = tools?.length ?? 0;
	if (toolsCount > toolLimit) {
		throw new Error(t('request.toolsLimitExceeded', toolLimit, toolsCount));
	}
	return tools;
}

export function collectTrailingToolResultIds(messages: readonly MetaMessage[]): string[] {
	const trailingToolResultIds: string[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== 'tool' || !message.tool_call_id) {
			break;
		}
		trailingToolResultIds.push(message.tool_call_id);
	}
	return trailingToolResultIds.reverse();
}

export function getToolCallingLimit(toolCallingCapability: boolean | number | undefined): number {
	return typeof toolCallingCapability === 'number' ? toolCallingCapability : META_TOOLS_LIMIT;
}
