/**
 * Deterministic tests for the Muse usage monitor (WP-0001).
 * Uses Node's built-in `node:test`; pure logic only, no VS Code runtime.
 * Runs against compiled `out/` (CommonJS) so `npm test` needs no loader.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
	aggregateRequests,
	filterByTime,
	rollupChats,
	rollupTasks,
} = require('../out/usage/aggregate.js');
const {
	allocateUsageContext,
	deriveProjectId,
	isUtilityRequestKind,
	normalizePreview,
	parseMarkerPayload,
	buildMarkerPayload,
	serializeMarkerPayload,
} = require('../out/usage/context.js');
const { escapeCsvField, toCsvText } = require('../out/usage/csv.js');
const { calculateCost, resolvePricing, splitUsageTokens } = require('../out/usage/pricing.js');
const {
	parseContextsText,
	parseLedgerText,
	serializeContexts,
	serializeRecord,
	usageClearTargets,
} = require('../out/usage/storage.js');
const { emptyContexts } = require('../out/usage/types.js');
const { MODELS } = require('../out/consts.js');

function userText(text) {
	return {
		role: 'user',
		isHumanUserText: text.length > 0,
		text,
		hasTerminalNotification: false,
		hasControlUpdate: false,
		hasValidMarker: false,
		latestValidMarker: undefined,
		hasToolResultOnly: false,
		partCount: 1,
	};
}

function markerHolder(chatId, taskId) {
	return {
		role: 'assistant',
		isHumanUserText: false,
		text: '',
		hasTerminalNotification: false,
		hasControlUpdate: false,
		hasValidMarker: true,
		latestValidMarker: { valid: true, chatId, taskId, version: 1, writer: 'meta-spark-for-copilot' },
		hasToolResultOnly: false,
		partCount: 1,
	};
}

function toolOnly() {
	return {
		role: 'user',
		isHumanUserText: false,
		text: 'tool result payload',
		hasTerminalNotification: false,
		hasControlUpdate: false,
		hasValidMarker: false,
		latestValidMarker: undefined,
		hasToolResultOnly: true,
		partCount: 1,
	};
}

function makeRecord(overrides = {}) {
	const now = Date.now();
	return {
		version: 1,
		id: randomUUID(),
		timestamp: new Date(now).toISOString(),
		timestampMs: now,
		projectId: 'project-abc',
		projectName: 'Demo',
		chatId: 'chat-1',
		taskId: 'task-1',
		vscodeModelId: 'muse-spark-1.3-contributor',
		apiModelId: 'muse-spark-1.3-contributor',
		requestKind: 'main-agent',
		requestInitiator: null,
		reasoningEffort: 'medium',
		promptTokens: 1000,
		cachedInputTokens: 400,
		uncachedInputTokens: 600,
		completionTokens: 200,
		reasoningTokens: 50,
		totalTokens: 1200,
		estimatedCostUsd: 0.0001,
		pricingInputRate: 0.1,
		pricingCachedRate: 0.002,
		pricingOutputRate: 0.2,
		pricingModelId: 'muse-spark-1.3-contributor',
		pricingSource: 'MODELS:muse-spark-1.3-contributor',
		costUncertain: false,
		durationMs: 1000,
		status: 'completed',
		error: null,
		taskPreview: 'Fix login bug',
		...overrides,
	};
}

describe('pricing math', () => {
	it('contributor cost formula splits cached/uncached/output', () => {
		const pricing = resolvePricing({
			vscodeModelId: 'muse-spark-1.3-contributor',
			apiModelId: 'muse-spark-1.3-contributor',
			models: MODELS,
		});
		assert.equal(pricing.inputRate, 0.1);
		assert.equal(pricing.cachedRate, 0.002);
		assert.equal(pricing.outputRate, 0.2);
		const cost = calculateCost(
			{
				promptTokens: 1_000_000,
				cachedTokens: 500_000,
				uncachedTokens: 500_000,
				completionTokens: 1_000_000,
				reasoningTokens: 100,
				totalTokens: 2_000_000,
			},
			pricing,
		);
		assert.equal(cost.uncachedCost, 0.05);
		assert.equal(cost.cachedCost, 0.001);
		assert.equal(cost.outputCost, 0.2);
		assert.equal(cost.total, 0.251);
	});

	it('standard cost formula uses standard rates', () => {
		const pricing = resolvePricing({
			vscodeModelId: 'muse-spark-1.3',
			apiModelId: 'muse-spark-1.3',
			models: MODELS,
		});
		assert.equal(pricing.inputRate, 1.25);
		assert.equal(pricing.cachedRate, 0.15);
		assert.equal(pricing.outputRate, 4.25);
		const cost = calculateCost(
			{
				promptTokens: 1_000_000,
				cachedTokens: 0,
				uncachedTokens: 1_000_000,
				completionTokens: 1_000_000,
				reasoningTokens: 0,
				totalTokens: 2_000_000,
			},
			pricing,
		);
		assert.equal(cost.total, 5.5);
	});

	it('cached/uncached split derives from prompt minus cached; missing cache detail yields all uncached', () => {
		const split = splitUsageTokens({
			prompt_tokens: 1000,
			completion_tokens: 100,
			total_tokens: 1100,
			prompt_tokens_details: { cached_tokens: 300 },
			completion_tokens_details: { reasoning_tokens: 20 },
		});
		assert.equal(split.cachedTokens, 300);
		assert.equal(split.uncachedTokens, 700);
		const noCache = splitUsageTokens({
			prompt_tokens: 500,
			completion_tokens: 50,
			total_tokens: 550,
		});
		assert.equal(noCache.cachedTokens, 0);
		assert.equal(noCache.uncachedTokens, 500);
	});

	it('reasoning tokens are not double billed (output cost uses completion only)', () => {
		const pricing = resolvePricing({
			vscodeModelId: 'muse-spark-1.3-contributor',
			apiModelId: 'muse-spark-1.3-contributor',
			models: MODELS,
		});
		const withReasoning = calculateCost(
			{
				promptTokens: 0,
				cachedTokens: 0,
				uncachedTokens: 0,
				completionTokens: 1000,
				reasoningTokens: 900,
				totalTokens: 1000,
			},
			pricing,
		);
		assert.equal(withReasoning.outputCost, (1000 / 1_000_000) * 0.2);
	});

	it('model override flags cost as uncertain', () => {
		const pricing = resolvePricing({
			vscodeModelId: 'muse-spark-1.3',
			apiModelId: 'third-party-rewrite',
			models: MODELS,
		});
		assert.equal(pricing.uncertain, true);
	});
});

describe('correlation', () => {
	it('new chat: first main-agent request without marker allocates chat+task', () => {
		const allocation = allocateUsageContext({
			messages: [userText('Fix the login bug')],
			requestKind: 'main-agent',
			marker: undefined,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.ok(allocation.chatId);
		assert.ok(allocation.taskId);
		assert.equal(allocation.isNewChat, true);
		assert.equal(allocation.isNewTask, true);
		assert.equal(allocation.unassigned, false);
	});

	it('same task across tool-continuation calls', () => {
		const chatId = randomUUID();
		const taskId = randomUUID();
		const marker = { valid: true, chatId, taskId, version: 1, writer: 'meta-spark-for-copilot' };
		const allocation = allocateUsageContext({
			messages: [userText('Fix it'), markerHolder(chatId, taskId), toolOnly()],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(allocation.chatId, chatId);
		assert.equal(allocation.taskId, taskId);
		assert.equal(allocation.isNewTask, false);
	});

	it('new substantive human turn creates a new task under the same chat', () => {
		const chatId = randomUUID();
		const taskId = randomUUID();
		const marker = { valid: true, chatId, taskId, version: 1, writer: 'meta-spark-for-copilot' };
		const allocation = allocateUsageContext({
			messages: [userText('First task'), markerHolder(chatId, taskId), userText('Now do something else')],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(allocation.chatId, chatId);
		assert.notEqual(allocation.taskId, taskId);
		assert.equal(allocation.isNewTask, true);
		assert.equal(allocation.isNewChat, false);
	});

	it('tool-result-only continuation does not create a new task', () => {
		const chatId = randomUUID();
		const taskId = randomUUID();
		const marker = { valid: true, chatId, taskId, version: 1, writer: 'meta-spark-for-copilot' };
		const allocation = allocateUsageContext({
			messages: [userText('Build it'), markerHolder(chatId, taskId), toolOnly()],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(allocation.taskId, taskId);
		assert.equal(allocation.isNewTask, false);
	});

	it('terminal/background/control requests do not create a new task; missing marker means unassigned', () => {
		for (const kind of ['terminal-steering', 'todo-tracker', 'chat-title', 'git-commit-message', 'background']) {
			assert.equal(isUtilityRequestKind(kind) || kind === 'background', true);
			const allocation = allocateUsageContext({
				messages: [userText('background work')],
				requestKind: kind,
				marker: undefined,
				projectId: 'project-1',
				projectName: 'Demo',
			});
			assert.equal(allocation.unassigned, true);
			assert.equal(allocation.chatId, null);
			assert.equal(allocation.taskId, null);
		}
	});

	it('marker round-trip: encode/decode preserves ids; version/writer/payload errors rejected', () => {
		const chatId = randomUUID();
		const taskId = randomUUID();
		const payload = serializeMarkerPayload(buildMarkerPayload(chatId, taskId));
		const parsed = parseMarkerPayload(payload);
		assert.equal(parsed.valid, true);
		assert.equal(parsed.chatId, chatId.toLowerCase());
		assert.equal(parsed.taskId, taskId.toLowerCase());
		assert.equal(parseMarkerPayload('not-json').valid, false);
		assert.equal(parseMarkerPayload(JSON.stringify({ version: 2, writer: 'meta-spark-for-copilot', chatId, taskId })).valid, false);
		assert.equal(parseMarkerPayload(JSON.stringify({ version: 1, writer: 'other', chatId, taskId })).valid, false);
		assert.equal(parseMarkerPayload(JSON.stringify({ version: 1, writer: 'meta-spark-for-copilot', chatId: 'bad', taskId })).valid, false);
	});
});

describe('project identity and previews', () => {
	it('multi-root identity is deterministic under reordering', () => {
		const a = deriveProjectId(['file:///b', 'file:///a']);
		const b = deriveProjectId(['file:///a', 'file:///b']);
		assert.equal(a.projectId, b.projectId);
	});

	it('preview normalizes whitespace and caps at 160 chars', () => {
		assert.equal(normalizePreview('  hello\n  world  '), 'hello world');
		const long = normalizePreview('x'.repeat(500));
		assert.equal(long.length, 160);
	});
});

describe('persistence', () => {
	it('JSONL append/read tolerates a truncated final line', () => {
		const first = serializeRecord(makeRecord({ id: 'r1' }));
		const second = serializeRecord(makeRecord({ id: 'r2' }));
		const parsed = parseLedgerText(`${first}\n${second}\n{"version":1,"id":"tru`);
		assert.equal(parsed.records.length, 2);
		assert.equal(parsed.records[0].id, 'r1');
		assert.ok(parsed.corruptedLines >= 1);
		assert.equal(parsed.corruptedTailLines, 1);
	});

	it('contexts round-trip; corrupted text yields empty contexts', () => {
		const chatId = randomUUID();
		const contexts = emptyContexts();
		contexts.chats[chatId] = {
			chatId,
			projectId: 'project-1',
			projectName: 'Demo',
			createdAt: new Date().toISOString(),
			createdAtMs: 1,
			updatedAt: new Date().toISOString(),
			updatedAtMs: 2,
			displayName: 'Demo chat',
			nativeSessionId: null,
		};
		const text = serializeContexts(contexts);
		assert.equal(parseContextsText(text).corrupted, false);
		assert.equal(parseContextsText('{{{').corrupted, true);
	});

	it('clear-history scope targets only usage-v1 files', () => {
		assert.deepEqual(usageClearTargets(), ['usage-v1/requests.jsonl', 'usage-v1/contexts.json']);
	});
});

describe('aggregation', () => {
	it('totals and cache-hit percentage exclude attempts', () => {
		const records = [
			makeRecord({ promptTokens: 1000, cachedInputTokens: 500, uncachedInputTokens: 500, completionTokens: 100, totalTokens: 1100, estimatedCostUsd: 0.001 }),
			makeRecord({ promptTokens: 1000, cachedInputTokens: 0, uncachedInputTokens: 1000, completionTokens: 100, totalTokens: 1100, estimatedCostUsd: 0.002 }),
			makeRecord({ status: 'attempt', promptTokens: null, cachedInputTokens: null, uncachedInputTokens: null, completionTokens: null, reasoningTokens: null, totalTokens: null, estimatedCostUsd: null }),
		];
		const totals = aggregateRequests(records);
		assert.equal(totals.requests, 3);
		assert.equal(totals.billableRequests, 2);
		assert.equal(totals.attempts, 1);
		assert.equal(totals.inputTokens, 2000);
		assert.equal(totals.cacheHitPct, 25);
		assert.equal(totals.estimatedCostUsd, 0.003);
	});

	it('task and chat rollups group deterministically', () => {
		const now = Date.now();
		const records = [
			makeRecord({ taskId: 'task-a', chatId: 'chat-a', timestampMs: now - 1000, taskPreview: 'A' }),
			makeRecord({ taskId: 'task-a', chatId: 'chat-a', timestampMs: now, taskPreview: 'A' }),
			makeRecord({ taskId: 'task-b', chatId: 'chat-a', timestampMs: now, taskPreview: 'B' }),
		];
		const tasks = rollupTasks(records);
		assert.equal(tasks.length, 2);
		const chats = rollupChats(tasks);
		assert.equal(chats.length, 1);
		assert.equal(chats[0].taskCount, 2);
		assert.equal(chats[0].requests, 3);
	});

	it('time filter keeps windowed records', () => {
		const now = Date.now();
		const records = [
			makeRecord({ timestampMs: now - 2 * 24 * 3600 * 1000 }),
			makeRecord({ timestampMs: now }),
		];
		assert.equal(filterByTime(records, now, 7).length, 2);
		assert.equal(filterByTime(records, now, 1).length, 1);
		assert.equal(filterByTime(records, now, null).length, 2);
	});
});

describe('csv', () => {
	it('fields with commas/quotes/newlines are escaped', () => {
		assert.equal(escapeCsvField('plain'), 'plain');
		assert.equal(escapeCsvField('a,b'), '"a,b"');
		assert.equal(escapeCsvField('a"b'), '"a""b"');
		assert.equal(escapeCsvField('a\nb'), '"a\nb"');
	});

	it('csv text contains header plus one row per record', () => {
		const text = toCsvText([makeRecord({ taskPreview: 'a,b' })]);
		const lines = text.split('\r\n').filter(Boolean);
		assert.equal(lines.length, 2);
		assert.ok(lines[0].startsWith('id,timestamp,project_id'));
		assert.ok(lines[1].includes('"a,b"'));
	});
});

describe('synthetic provider-level sequence', () => {
	it('first prompt -> same-task accumulation -> tool continuation -> second task -> unassigned overhead; ledger matches rollups and export', () => {
		// 1. first main-agent prompt establishes a local chat/task
		const first = allocateUsageContext({
			messages: [userText('Implement feature X')],
			requestKind: 'main-agent',
			marker: undefined,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.ok(first.chatId && first.taskId);

		// 2-3. multiple usage callbacks + tool continuation retain the task
		const marker = { valid: true, chatId: first.chatId, taskId: first.taskId, version: 1, writer: 'meta-spark-for-copilot' };
		const continued = allocateUsageContext({
			messages: [userText('Implement feature X'), markerHolder(marker.chatId, marker.taskId), toolOnly()],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(continued.taskId, first.taskId);

		// 4. new human prompt creates a second task under the same chat
		const second = allocateUsageContext({
			messages: [userText('Implement feature X'), markerHolder(marker.chatId, marker.taskId), userText('Now fix the docs')],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(second.chatId, first.chatId);
		assert.notEqual(second.taskId, first.taskId);

		// 5. uncorrelated utility lands in unassigned overhead
		const overhead = allocateUsageContext({
			messages: [userText('title please')],
			requestKind: 'chat-title',
			marker: undefined,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(overhead.unassigned, true);

		// 6-7. dashboard rollups equal ledger totals; export rows equal ledger
		const ledger = [
			makeRecord({ chatId: first.chatId, taskId: first.taskId, promptTokens: 100, cachedInputTokens: 10, uncachedInputTokens: 90, completionTokens: 10, totalTokens: 110, estimatedCostUsd: 0.001 }),
			makeRecord({ chatId: first.chatId, taskId: first.taskId, promptTokens: 200, cachedInputTokens: 20, uncachedInputTokens: 180, completionTokens: 20, totalTokens: 220, estimatedCostUsd: 0.002 }),
			makeRecord({ chatId: second.chatId, taskId: second.taskId, promptTokens: 300, cachedInputTokens: 30, uncachedInputTokens: 270, completionTokens: 30, totalTokens: 330, estimatedCostUsd: 0.003 }),
			makeRecord({ chatId: null, taskId: null, promptTokens: 50, cachedInputTokens: 0, uncachedInputTokens: 50, completionTokens: 5, totalTokens: 55, estimatedCostUsd: 0.0005 }),
		];
		const totals = aggregateRequests(ledger);
		assert.equal(totals.inputTokens, 650);
		assert.equal(totals.requests, 4);
		const tasks = rollupTasks(ledger);
		assert.equal(tasks.reduce((sum, task) => sum + task.requests, 0), 3);
		const csvLines = toCsvText(ledger).split('\r\n').filter(Boolean);
		assert.equal(csvLines.length, ledger.length + 1);
	});
});
