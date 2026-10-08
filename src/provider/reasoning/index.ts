import type { MetaMessage, MetaReasoningItem } from '../../types';

export { REASONING_REPLAY_FILE, ReasoningReplayStore, type ReasoningLookup } from './store';

export interface ReasoningReplayStats {
	/** Assistant turns in the history that made tool calls. */
	toolTurns: number;
	/** Of those, turns whose stored reasoning was re-attached. */
	replayedTurns: number;
	replayedItems: number;
}

/** Re-attaches stored reasoning to assistant tool-call turns, in place. */
export function attachReplayedReasoning(
	messages: MetaMessage[],
	lookup: (callIds: readonly string[]) => MetaReasoningItem[] | undefined,
): ReasoningReplayStats {
	const stats: ReasoningReplayStats = { toolTurns: 0, replayedTurns: 0, replayedItems: 0 };
	for (const message of messages) {
		if (message.role !== 'assistant' || !message.tool_calls?.length) {
			continue;
		}
		stats.toolTurns += 1;
		const items = lookup(message.tool_calls.map((call) => call.id));
		if (items?.length) {
			message.reasoning_items = items;
			stats.replayedTurns += 1;
			stats.replayedItems += items.length;
		}
	}
	return stats;
}

export function formatReasoningReplayLog(stats: ReasoningReplayStats, stored?: { items: number; calls: number }): string {
	let line =
		`[reasoning-replay] protocol=responses toolTurns=${stats.toolTurns}` +
		` replayedTurns=${stats.replayedTurns} replayedItems=${stats.replayedItems}`;
	if (stored) {
		line += ` storedItems=${stored.items} storedForCalls=${stored.calls}`;
	}
	return line;
}
