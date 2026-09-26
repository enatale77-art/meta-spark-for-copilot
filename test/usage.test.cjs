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
	rollupUnassignedOverhead,
} = require('../out/usage/aggregate.js');
const {
	allocateUsageContext,
	deriveProjectId,
	isUtilityRequestKind,
	normalizePreview,
	parseMarkerPayload,
	buildMarkerPayload,
	serializeMarkerPayload,
	sanitizePromptText,
} = require('../out/usage/context.js');
const { usageSignatureChanged, shouldRefreshSignature, nextRefreshDecision, sanitizeDashboardSelection, encodeWebviewSelection, applyHydratedSelection } = (() => {
	const Module = require('node:module');
	const { join } = require('node:path');
	const stubPath = join(__dirname, 'vscode-stub.cjs');
	const originalResolve = Module._resolveFilename;
	Module._resolveFilename = function (request, ...rest) {
		if (request === 'vscode') {
			return stubPath;
		}
		return originalResolve.call(this, request, ...rest);
	};
	try {
		return require('../out/usage/dashboard.js');
	} finally {
		Module._resolveFilename = originalResolve;
	}
})();
const { signatureFromLedger } = require('../out/usage/storage.js');
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
const { selectStatusTask } = require('../out/usage/statusSelection.js');
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
		latestValidMarker: {
			valid: true,
			chatId,
			taskId,
			version: 1,
			writer: 'meta-spark-for-copilot',
		},
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
			messages: [
				userText('First task'),
				markerHolder(chatId, taskId),
				userText('Now do something else'),
			],
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
		for (const kind of [
			'terminal-steering',
			'todo-tracker',
			'chat-title',
			'git-commit-message',
			'background',
		]) {
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

	it('utility/background with a valid marker inherits the current task; without it stays unassigned', () => {
		const chatId = randomUUID();
		const taskId = randomUUID();
		const marker = { valid: true, chatId, taskId, version: 1, writer: 'meta-spark-for-copilot' };
		for (const kind of [
			'terminal-steering',
			'todo-tracker',
			'chat-title',
			'git-commit-message',
			'background',
		]) {
			const inherited = allocateUsageContext({
				messages: [userText('task work'), markerHolder(chatId, taskId)],
				requestKind: kind,
				marker,
				projectId: 'project-1',
				projectName: 'Demo',
			});
			assert.equal(inherited.unassigned, false);
			assert.equal(inherited.chatId, chatId);
			assert.equal(inherited.taskId, taskId);
			assert.equal(inherited.inherited, true);
			assert.equal(inherited.isNewTask, false);
			const unassigned = allocateUsageContext({
				messages: [userText('background work')],
				requestKind: kind,
				marker: undefined,
				projectId: 'project-1',
				projectName: 'Demo',
			});
			assert.equal(unassigned.unassigned, true);
			assert.equal(unassigned.chatId, null);
			assert.equal(unassigned.taskId, null);
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
		assert.equal(
			parseMarkerPayload(
				JSON.stringify({ version: 2, writer: 'meta-spark-for-copilot', chatId, taskId }),
			).valid,
			false,
		);
		assert.equal(
			parseMarkerPayload(JSON.stringify({ version: 1, writer: 'other', chatId, taskId })).valid,
			false,
		);
		assert.equal(
			parseMarkerPayload(
				JSON.stringify({ version: 1, writer: 'meta-spark-for-copilot', chatId: 'bad', taskId }),
			).valid,
			false,
		);
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

	it('sanitizer strips Copilot scaffolding blocks', () => {
		const text =
			'<context>repo files</context><reminder>nudge</reminder><system-reminder>rule</system-reminder>' +
			'<attachments>files</attachments><current_datetime>today</current_datetime><pr_metadata foo="1"/>';
		assert.equal(sanitizePromptText(text).trim(), '');
	});

	it('sanitizer unwraps userRequest/user_query wrappers', () => {
		assert.equal(
			normalizePreview('<context>ctx</context><userRequest>Fix the tests</userRequest>'),
			'Fix the tests',
		);
		assert.equal(normalizePreview('<user_query>Fix the tests</user_query>'), 'Fix the tests');
	});

	it('context-only Copilot message after a marker is not a new task', () => {
		const chatId = randomUUID();
		const taskId = randomUUID();
		const marker = { valid: true, chatId, taskId, version: 1, writer: 'meta-spark-for-copilot' };
		const allocation = allocateUsageContext({
			messages: [
				userText('Fix it'),
				markerHolder(chatId, taskId),
				userText('<context>repo state</context><reminder>nudge</reminder>'),
			],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(allocation.taskId, taskId);
		assert.equal(allocation.isNewTask, false);
	});

	it('R12A: reminderInstructions scaffolding stripped; reminder-only never a task', () => {
		const mixed =
			'<reminderInstructions>When using tools, be careful</reminderInstructions>' +
			'<context>repo</context><userRequest>Checkout or sync the branch</userRequest>';
		assert.equal(normalizePreview(mixed), 'Checkout or sync the branch');
		const solo = '<reminderInstructions>When using tools, be careful</reminderInstructions>';
		assert.equal(sanitizePromptText(solo).trim(), '');
		const rChat = randomUUID();
		const rTask = randomUUID();
		const rMarker = {
			valid: true,
			chatId: rChat,
			taskId: rTask,
			version: 1,
			writer: 'meta-spark-for-copilot',
		};
		const reminderOnly =
			'<reminderInstructions>When using tools, be careful</reminderInstructions>';
		const rAlloc = allocateUsageContext({
			messages: [userText('Real prompt'), markerHolder(rChat, rTask), userText(reminderOnly)],
			requestKind: 'main-agent',
			marker: rMarker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(rAlloc.taskId, rTask);
		assert.equal(rAlloc.isNewTask, false);
	});

	it('R12B: chat cards expose explicit local subject distinct from native title', () => {
		const fs = require('node:fs');
		const path = require('node:path');
		const dashboard = fs.readFileSync(
			path.join(__dirname, '..', 'src', 'usage', 'dashboard.ts'),
			'utf8',
		);
		const i18n = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n.ts'), 'utf8');
		assert.ok(i18n.includes("'usage.dashboard.localSubject'"));
		assert.ok(dashboard.includes("t('usage.dashboard.localSubject')"));
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

	it('true-append ledger keeps prior records across sequential appends', async () => {
		const Module = require('node:module');
		const { mkdtempSync } = require('node:fs');
		const { tmpdir } = require('node:os');
		const { join } = require('node:path');
		const stubPath = join(__dirname, 'vscode-stub.cjs');
		const originalResolve = Module._resolveFilename;
		Module._resolveFilename = function (request, ...rest) {
			if (request === 'vscode') {
				return stubPath;
			}
			return originalResolve.call(this, request, ...rest);
		};
		try {
			const { createFileUsageStore } = require('../out/usage/fileStore.js');
			const dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
			const fakeUri = { fsPath: dir, scheme: 'file' };
			const store = createFileUsageStore(fakeUri);
			const first = makeRecord({ id: 'append-1', taskPreview: 'first' });
			const second = makeRecord({ id: 'append-2', taskPreview: 'second' });
			await store.appendRequest(first);
			await store.appendRequest(second);
			const ledger = await store.readRequests();
			assert.equal(ledger.records.length, 2);
			assert.equal(ledger.records[0].id, 'append-1');
			assert.equal(ledger.records[1].id, 'append-2');
			assert.equal(ledger.corruptedLines, 0);
		} finally {
			Module._resolveFilename = originalResolve;
		}
	});

	it('non-missing ledger read errors surface instead of reporting an empty ledger', async () => {
		const Module = require('node:module');
		const { join } = require('node:path');
		const stubPath = join(__dirname, 'vscode-stub.cjs');
		const originalResolve = Module._resolveFilename;
		Module._resolveFilename = function (request, ...rest) {
			if (request === 'vscode') {
				return stubPath;
			}
			return originalResolve.call(this, request, ...rest);
		};
		try {
			const { createFileUsageStore } = require('../out/usage/fileStore.js');
			const boom = new Error('EACCES: permission denied');
			const unreadableFs = {
				mkdir: async () => undefined,
				appendFile: async () => undefined,
				readFile: async () => {
					throw boom;
				},
				writeFile: async () => undefined,
				unlink: async () => undefined,
				rename: async () => undefined,
				readdir: async () => [],
				isNotFound: () => false,
			};
			const store = createFileUsageStore(
				{ fsPath: '/virtual-usage', scheme: 'file' },
				{ nodeFs: unreadableFs },
			);
			await assert.rejects(() => store.readRequests(), /EACCES/);
		} finally {
			Module._resolveFilename = originalResolve;
		}
	});

	it('clearAll drops the contexts cache so later requests cannot resurrect cleared metadata', async () => {
		const Module = require('node:module');
		const { join } = require('node:path');
		const stubPath = join(__dirname, 'vscode-stub.cjs');
		const originalResolve = Module._resolveFilename;
		Module._resolveFilename = function (request, ...rest) {
			if (request === 'vscode') {
				return stubPath;
			}
			return originalResolve.call(this, request, ...rest);
		};
		const originalWarn = console.warn;
		console.warn = () => undefined;
		try {
			const { createMemoryUsageStore } = require('../out/usage/storage.js');
			const { UsageService } = require('../out/usage/recorder.js');
			const store = createMemoryUsageStore();
			const service = new UsageService({
				store,
				getWorkspaceUris: () => ['file:///demo'],
				getWorkspaceName: () => 'Demo',
			});
			const pending = await service.beginRequest({
				messages: [],
				requestKind: 'main-agent',
				vscodeModelId: 'muse-spark-1.3',
				apiModelId: 'muse-spark-1.3',
			});
			assert.ok(pending.allocation.chatId);
			assert.ok(pending.allocation.taskId);
			const before = await store.readContexts();
			assert.equal(Object.keys(before.chats).length, 1);

			await service.clearAll();
			const cleared = await store.readContexts();
			assert.deepEqual(cleared, emptyContexts());

			// The service cache was invalidated with storage; the next request
			// must not write the stale pre-clear chat/task back to disk.
			await service.beginRequest({
				messages: [],
				requestKind: 'chat-title',
				vscodeModelId: 'muse-spark-1.3',
				apiModelId: 'muse-spark-1.3',
			});
			const after = await store.readContexts();
			assert.deepEqual(after, emptyContexts());
		} finally {
			Module._resolveFilename = originalResolve;
			console.warn = originalWarn;
		}
	});
});

describe('aggregation', () => {
	it('totals and cache-hit percentage exclude attempts', () => {
		const records = [
			makeRecord({
				promptTokens: 1000,
				cachedInputTokens: 500,
				uncachedInputTokens: 500,
				completionTokens: 100,
				totalTokens: 1100,
				estimatedCostUsd: 0.001,
			}),
			makeRecord({
				promptTokens: 1000,
				cachedInputTokens: 0,
				uncachedInputTokens: 1000,
				completionTokens: 100,
				totalTokens: 1100,
				estimatedCostUsd: 0.002,
			}),
			makeRecord({
				status: 'attempt',
				promptTokens: null,
				cachedInputTokens: null,
				uncachedInputTokens: null,
				completionTokens: null,
				reasoningTokens: null,
				totalTokens: null,
				estimatedCostUsd: null,
			}),
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

	it('unassigned overhead groups by kind and excludes task records', () => {
		const records = [
			makeRecord({
				chatId: null,
				taskId: null,
				requestKind: 'chat-title',
				promptTokens: 100,
				cachedInputTokens: 10,
				uncachedInputTokens: 90,
				completionTokens: 5,
				totalTokens: 105,
				estimatedCostUsd: 0.001,
			}),
			makeRecord({
				chatId: null,
				taskId: null,
				requestKind: 'chat-title',
				promptTokens: 200,
				cachedInputTokens: 20,
				uncachedInputTokens: 180,
				completionTokens: 10,
				totalTokens: 210,
				estimatedCostUsd: 0.002,
			}),
			makeRecord({
				chatId: 'chat-a',
				taskId: 'task-a',
				requestKind: 'main-agent',
				promptTokens: 300,
				cachedInputTokens: 30,
				uncachedInputTokens: 270,
				completionTokens: 15,
				totalTokens: 315,
				estimatedCostUsd: 0.003,
			}),
		];
		const overhead = rollupUnassignedOverhead(records);
		assert.equal(overhead.requests, 2);
		assert.equal(overhead.inputTokens, 300);
		assert.equal(Object.keys(overhead.byKind).length, 1);
		assert.equal(overhead.byKind['chat-title'].requests, 2);
		assert.equal(overhead.byKind['chat-title'].estimatedCostUsd, 0.003);
	});
});

describe('status selection', () => {
	it('status bar selects the active project task and ignores other projects', () => {
		const now = Date.now();
		const projectA = deriveProjectId(['file:///a']).projectId;
		const projectB = deriveProjectId(['file:///b']).projectId;
		const records = [
			makeRecord({
				projectId: projectB,
				projectName: 'B',
				taskId: 'task-b',
				chatId: 'chat-b',
				timestampMs: now,
				taskPreview: 'Other project',
			}),
			makeRecord({
				projectId: projectA,
				projectName: 'A',
				taskId: 'task-a',
				chatId: 'chat-a',
				timestampMs: now - 1000,
				taskPreview: 'Active project',
			}),
		];
		const selected = selectStatusTask({ records, workspaceUris: ['file:///a'], nowMs: now });
		assert.equal(selected.projectId, projectA);
		assert.equal(selected.latest?.taskId, 'task-a');
		assert.equal(selected.taskRecords.length, 1);
	});

	it('status bar shows empty when the active workspace has no usage', () => {
		const now = Date.now();
		const projectB = deriveProjectId(['file:///b']).projectId;
		const records = [
			makeRecord({
				projectId: projectB,
				projectName: 'B',
				taskId: 'task-b',
				chatId: 'chat-b',
				timestampMs: now,
			}),
		];
		const selected = selectStatusTask({ records, workspaceUris: ['file:///a'], nowMs: now });
		assert.equal(selected.latest, undefined);
		assert.deepEqual(selected.taskRecords, []);
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
		const marker = {
			valid: true,
			chatId: first.chatId,
			taskId: first.taskId,
			version: 1,
			writer: 'meta-spark-for-copilot',
		};
		const continued = allocateUsageContext({
			messages: [
				userText('Implement feature X'),
				markerHolder(marker.chatId, marker.taskId),
				toolOnly(),
			],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(continued.taskId, first.taskId);

		// 4. new human prompt creates a second task under the same chat
		const second = allocateUsageContext({
			messages: [
				userText('Implement feature X'),
				markerHolder(marker.chatId, marker.taskId),
				userText('Now fix the docs'),
			],
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
			makeRecord({
				chatId: first.chatId,
				taskId: first.taskId,
				promptTokens: 100,
				cachedInputTokens: 10,
				uncachedInputTokens: 90,
				completionTokens: 10,
				totalTokens: 110,
				estimatedCostUsd: 0.001,
			}),
			makeRecord({
				chatId: first.chatId,
				taskId: first.taskId,
				promptTokens: 200,
				cachedInputTokens: 20,
				uncachedInputTokens: 180,
				completionTokens: 20,
				totalTokens: 220,
				estimatedCostUsd: 0.002,
			}),
			makeRecord({
				chatId: second.chatId,
				taskId: second.taskId,
				promptTokens: 300,
				cachedInputTokens: 30,
				uncachedInputTokens: 270,
				completionTokens: 30,
				totalTokens: 330,
				estimatedCostUsd: 0.003,
			}),
			makeRecord({
				chatId: null,
				taskId: null,
				promptTokens: 50,
				cachedInputTokens: 0,
				uncachedInputTokens: 50,
				completionTokens: 5,
				totalTokens: 55,
				estimatedCostUsd: 0.0005,
			}),
		];
		const totals = aggregateRequests(ledger);
		assert.equal(totals.inputTokens, 650);
		assert.equal(totals.requests, 4);
		const tasks = rollupTasks(ledger);
		assert.equal(
			tasks.reduce((sum, task) => sum + task.requests, 0),
			3,
		);
		const csvLines = toCsvText(ledger).split('\r\n').filter(Boolean);
		assert.equal(csvLines.length, ledger.length + 1);
	});
});

describe('unified stateful marker (R7)', () => {
	function statefulBytes(prefix, payloadObject) {
		const json = JSON.stringify(payloadObject);
		const encoded = Buffer.from(json, 'utf8').toString('base64url');
		return new TextEncoder().encode(`${prefix}\\json:${encoded}`);
	}

	function loadStatefulParser() {
		const Module = require('node:module');
		const { join } = require('node:path');
		const stubPath = join(__dirname, 'vscode-stub.cjs');
		const originalResolve = Module._resolveFilename;
		Module._resolveFilename = function (request, ...rest) {
			if (request === 'vscode') {
				return stubPath;
			}
			return originalResolve.call(this, request, ...rest);
		};
		try {
			return require('../out/usage/marker.js');
		} finally {
			Module._resolveFilename = originalResolve;
		}
	}

	function loadReplay() {
		const Module = require('node:module');
		const { join } = require('node:path');
		const stubPath = join(__dirname, 'vscode-stub.cjs');
		const originalResolve = Module._resolveFilename;
		Module._resolveFilename = function (request, ...rest) {
			if (request === 'vscode') {
				return stubPath;
			}
			return originalResolve.call(this, request, ...rest);
		};
		try {
			return require('../out/provider/replay/markers.js');
		} finally {
			Module._resolveFilename = originalResolve;
		}
	}

	it('agent host round trip preserves chat/task ids through stateful marker', () => {
		const marker = loadStatefulParser();
		const chatId = randomUUID();
		const taskId = randomUUID();
		const modelId = 'muse-spark-1.3-contributor';
		const bytes = statefulBytes(modelId, {
			usage: { version: 1, writer: 'meta-spark-for-copilot', chatId, taskId },
		});
		// Simulate the bridge extracting the response id and rebuilding the
		// next request marker with the same model prefix.
		const decoded = new TextDecoder().decode(bytes);
		const responseId = decoded.slice(decoded.indexOf('\\') + 1);
		const rebuilt = new TextEncoder().encode(`${modelId}\\${responseId}`);
		const parsed = marker.parseStatefulUsageMarkerPart({
			mimeType: 'stateful_marker',
			data: rebuilt,
		});
		assert.equal(parsed?.valid, true);
		assert.equal(parsed?.chatId, chatId.toLowerCase());
		assert.equal(parsed?.taskId, taskId.toLowerCase());
	});

	it('standard and contributor model ids are accepted as prefixes', () => {
		const replay = loadReplay();
		const chatId = randomUUID();
		const taskId = randomUUID();
		for (const modelId of ['muse-spark-1.3', 'muse-spark-1.3-contributor']) {
			const bytes = statefulBytes(modelId, {
				reasoning: { text: 'think' },
				usage: { version: 1, writer: 'meta-spark-for-copilot', chatId, taskId },
			});
			const parsed = replay.parseReplayMarkerData(bytes);
			assert.equal(parsed.valid, true);
			assert.equal(parsed.usageChatId, chatId.toLowerCase());
			assert.equal(parsed.usageTaskId, taskId.toLowerCase());
			assert.equal(parsed.reasoningText, 'think');
		}
	});

	it('legacy meta-spark prefix and raw payloads remain parseable', () => {
		const replay = loadReplay();
		const legacy = statefulBytes('meta-spark', { reasoning: { text: 'think' } });
		const parsed = replay.parseReplayMarkerData(legacy);
		assert.equal(parsed.valid, true);
		assert.equal(parsed.reasoningText, 'think');
		assert.equal(parsed.usageChatId, undefined);
	});

	it('unified marker preserves reasoning replay and usage ids together', () => {
		const replay = loadReplay();
		const chatId = randomUUID();
		const taskId = randomUUID();
		const bytes = statefulBytes('muse-spark-1.3', {
			vision: { text: 'v' },
			reasoning: { text: 'r' },
			usage: { version: 1, writer: 'meta-spark-for-copilot', chatId, taskId },
		});
		const parsed = replay.parseReplayMarkerData(bytes);
		assert.equal(parsed.valid, true);
		assert.equal(parsed.visionText, 'v');
		assert.equal(parsed.reasoningText, 'r');
		assert.equal(parsed.usageChatId, chatId.toLowerCase());
		assert.equal(parsed.usageTaskId, taskId.toLowerCase());
	});

	it('no meta-spark-usage-context marker is emitted by the provider path', () => {
		const fs = require('node:fs');
		const path = require('node:path');
		const providerIndex = fs.readFileSync(
			path.join(__dirname, '..', 'src', 'provider', 'index.ts'),
			'utf8',
		);
		const stream = fs.readFileSync(
			path.join(__dirname, '..', 'src', 'provider', 'stream.ts'),
			'utf8',
		);
		assert.ok(!providerIndex.includes('createUsageMarkerPart'));
		assert.ok(!providerIndex.includes('meta-spark-usage-context'));
		assert.ok(!stream.includes('usageMarker'));
		assert.ok(!stream.includes('meta-spark-usage-context'));
	});

	it('two prompts in one stateful chain make one chat with two tasks; tool loop stays put', () => {
		const chatId = randomUUID();
		const firstTask = randomUUID();
		const marker = {
			valid: true,
			chatId,
			taskId: firstTask,
			version: 1,
			writer: 'meta-spark-for-copilot',
		};
		const loop = allocateUsageContext({
			messages: [userText('First'), markerHolder(chatId, firstTask), toolOnly()],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(loop.taskId, firstTask);
		const second = allocateUsageContext({
			messages: [userText('First'), markerHolder(chatId, firstTask), userText('Second prompt')],
			requestKind: 'main-agent',
			marker,
			projectId: 'project-1',
			projectName: 'Demo',
		});
		assert.equal(second.chatId, chatId);
		assert.notEqual(second.taskId, firstTask);
	});
});

describe('cross-window sync signatures (R10)', () => {
	it('signature changes when the ledger grows and debounce gates refresh', () => {
		const before = signatureFromLedger([], emptyContexts());
		const after = signatureFromLedger([makeRecord({})], emptyContexts());
		assert.equal(usageSignatureChanged(undefined, after), true);
		assert.equal(usageSignatureChanged(before, before), false);
		assert.equal(usageSignatureChanged(before, after), true);
		assert.equal(shouldRefreshSignature(before, after, 0, 1000, 1500), false);
		assert.equal(shouldRefreshSignature(before, after, 0, 2000, 1500), true);
		assert.equal(shouldRefreshSignature(after, after, 0, 5000, 1500), false);
	});

	it('R11B: change inside debounce stays pending and refreshes on a later poll', () => {
		const before = signatureFromLedger([], emptyContexts());
		const after = signatureFromLedger([makeRecord({})], emptyContexts());
		// Change arrives 200ms after the last render: hold, do not acknowledge.
		const held = nextRefreshDecision(
			{ acknowledged: before, pending: undefined, lastRefreshMs: 0 },
			after,
			200,
			1500,
		);
		assert.equal(held.shouldRefresh, false);
		assert.deepEqual(held.pending, after);
		// No new writes; a later poll past the interval still refreshes.
		const later = nextRefreshDecision(
			{ acknowledged: before, pending: held.pending, lastRefreshMs: 0 },
			held.pending,
			2000,
			1500,
		);
		assert.equal(later.shouldRefresh, true);
	});

	it('R11C: leading prompt plus echoed wrapper yields one copy; wrapper-only recovers inner text', () => {
		assert.equal(
			normalizePreview(
				'Fix the tests\n<context>x</context>\n<userRequest>Fix the tests</userRequest>',
			),
			'Fix the tests',
		);
		assert.equal(normalizePreview('<userRequest>Fix the tests</userRequest>'), 'Fix the tests');
		assert.equal(normalizePreview('<user_query>Fix the tests</user_query>'), 'Fix the tests');
	});

	it('R11A/R11D: local live path preserves state and clear refreshes status', () => {
		const fs = require('node:fs');
		const path = require('node:path');
		const lifecycle = fs.readFileSync(
			path.join(__dirname, '..', 'src', 'runtime', 'lifecycle.ts'),
			'utf8',
		);
		const dashboard = fs.readFileSync(
			path.join(__dirname, '..', 'src', 'usage', 'dashboard.ts'),
			'utf8',
		);
		// Local records must not call the resetting refresh().
		assert.ok(!lifecycle.includes('activeDashboard\n\t\t\t\t?.refresh()'));
		assert.ok(!lifecycle.includes('activeDashboard?.refresh()'));
		assert.ok(lifecycle.includes('notifyRecorded()'));
		assert.ok(dashboard.includes('notifyRecorded()'));
		// Dashboard clear must refresh the status bar (R11D).
		assert.ok(lifecycle.includes('usageService.clearAll()'));
		const clearBlock = lifecycle.slice(lifecycle.indexOf('setOnCleared'));
		assert.ok(clearBlock.includes('activeStatusBar'));
	});

	it('DC-0001: task selection only survives inside its parent chat', () => {
		const tasks = [
			{ taskId: 'task-1', chatId: 'chat-a' },
			{ taskId: 'task-2', chatId: 'chat-a' },
			{ taskId: 'task-3', chatId: 'chat-b' },
		];
		// Same-chat task survives.
		assert.deepEqual(
			sanitizeDashboardSelection(
				{ selectedChatId: 'chat-a', selectedTaskId: 'task-1' },
				tasks,
				['chat-a', 'chat-b'],
			),
			{ selectedChatId: 'chat-a', selectedTaskId: 'task-1' },
		);
		// Switching chats clears the previous task.
		assert.deepEqual(
			sanitizeDashboardSelection(
				{ selectedChatId: 'chat-b', selectedTaskId: 'task-1' },
				tasks,
				['chat-a', 'chat-b'],
			),
			{ selectedChatId: 'chat-b', selectedTaskId: null },
		);
		// Collapsing the chat clears the task.
		assert.deepEqual(
			sanitizeDashboardSelection(
				{ selectedChatId: null, selectedTaskId: 'task-1' },
				tasks,
				['chat-a', 'chat-b'],
			),
			{ selectedChatId: null, selectedTaskId: null },
		);
		// Unknown chat clears everything.
		assert.deepEqual(
			sanitizeDashboardSelection(
				{ selectedChatId: 'chat-gone', selectedTaskId: 'task-1' },
				tasks,
				['chat-a', 'chat-b'],
			),
			{ selectedChatId: null, selectedTaskId: null },
		);
		// Unknown task clears the task but keeps the chat.
		assert.deepEqual(
			sanitizeDashboardSelection(
				{ selectedChatId: 'chat-a', selectedTaskId: 'task-gone' },
				tasks,
				['chat-a', 'chat-b'],
			),
			{ selectedChatId: 'chat-a', selectedTaskId: null },
		);
	});

	it('DC-0001: chat-first render hides top-level tasks and nests diagnostics', () => {
		const fs = require('node:fs');
		const path = require('node:path');
		const dashboard = fs.readFileSync(
			path.join(__dirname, '..', 'src', 'usage', 'dashboard.ts'),
			'utf8',
		);
		// One Local Chats section; no separate top-level Tasks grid.
		assert.ok(dashboard.includes("<h3>${escapeHtml(t('usage.dashboard.chats'))}"));
		assert.ok(!dashboard.includes("<h3>${escapeHtml(t('usage.dashboard.tasks'))} (${tasks.length})</h3>"));
		// Expanded chat renders summary, nested tasks header, and nested task detail.
		assert.ok(dashboard.includes('chat-detail'));
		assert.ok(dashboard.includes('task-detail'));
		assert.ok(dashboard.includes('data-chat-context'));
		// Chat card carries project + output; chat detail keeps aggregate metrics.
		assert.ok(dashboard.includes('usage.dashboard.uncached'));
		// Aggregation path unchanged.
		assert.ok(dashboard.includes('rollupTasks('));
		assert.ok(dashboard.includes('rollupChats('));
		assert.ok(dashboard.includes('rollupUnassignedOverhead('));
	});

	it('DC-0001: one chat with one task aggregates identically at chat and task level', () => {
		const records = [makeRecord({ taskId: 'task-1', chatId: 'chat-1', taskPreview: 'Solo' })];
		const tasks = rollupTasks(records);
		const chats = rollupChats(tasks);
		assert.equal(tasks.length, 1);
		assert.equal(chats.length, 1);
		assert.equal(chats[0].taskCount, 1);
		assert.equal(chats[0].requests, tasks[0].requests);
		assert.equal(chats[0].inputTokens, tasks[0].inputTokens);
		assert.equal(chats[0].estimatedCostUsd, tasks[0].estimatedCostUsd);
	});

	it('DC-0001: one chat with three tasks shows one chat card with three nested tasks', () => {
		const now = Date.now();
		const records = [1, 2, 3].map((n) =>
			makeRecord({
				taskId: `task-${n}`,
				chatId: 'chat-1',
				timestampMs: now + n,
				taskPreview: `Task ${n}`,
			}),
		);
		const tasks = rollupTasks(records);
		const chats = rollupChats(tasks);
		assert.equal(chats.length, 1);
		assert.equal(chats[0].taskCount, 3);
		assert.equal(tasks.filter((task) => task.chatId === 'chat-1').length, 3);
		assert.equal(
			tasks.reduce((sum, task) => sum + task.requests, 0),
			chats[0].requests,
		);
	});

	it('DC-R1: hydration payload round-trips the effective server selection', () => {
		const encoded = encodeWebviewSelection({
			selectedChatId: 'chat-a',
			selectedTaskId: 'task-1',
			overheadExpanded: true,
		});
		assert.deepEqual(JSON.parse(encoded), {
			selectedChatId: 'chat-a',
			selectedTaskId: 'task-1',
			overheadExpanded: true,
		});
		// Nulls stay null; the client treats non-strings as unselected.
		assert.deepEqual(
			JSON.parse(
				encodeWebviewSelection({ selectedChatId: null, selectedTaskId: null, overheadExpanded: false }),
			),
			{ selectedChatId: null, selectedTaskId: null, overheadExpanded: false },
		);
		assert.deepEqual(applyHydratedSelection(
			{ selectedChatId: null, selectedTaskId: null, overheadExpanded: false },
			JSON.parse(encoded),
		), {
			selectedChatId: 'chat-a',
			selectedTaskId: 'task-1',
			overheadExpanded: true,
		});
		// Malformed payloads never select.
		assert.deepEqual(
			applyHydratedSelection(
				{ selectedChatId: 'chat-a', selectedTaskId: 'task-1', overheadExpanded: true },
				null,
			),
			{ selectedChatId: 'chat-a', selectedTaskId: 'task-1', overheadExpanded: true },
		);
		assert.deepEqual(
			applyHydratedSelection(
				{ selectedChatId: null, selectedTaskId: null, overheadExpanded: false },
				{ selectedChatId: 42, selectedTaskId: { evil: '</script>' }, overheadExpanded: 'yes' },
			),
			{ selectedChatId: null, selectedTaskId: null, overheadExpanded: false },
		);
	});

	it('DC-R1: hydration payload never raw-interpolates untrusted IDs into JS', () => {
		const hostile = '"></script><script>alert(1)</script>';
		const encoded = encodeWebviewSelection({
			selectedChatId: hostile,
			selectedTaskId: hostile,
			overheadExpanded: false,
		});
		// JSON string encoding keeps the payload inside a string literal:
		// no literal </script> may appear in the emitted source.
		assert.ok(!encoded.includes('</script>'));
		assert.deepEqual(JSON.parse(encoded).selectedChatId, hostile);
	});

	it('DC-R1: every render hydrates client state from the effective server selection', () => {
		const fs = require('node:fs');
		const path = require('node:path');
		const dashboard = fs.readFileSync(
			path.join(__dirname, '..', 'src', 'usage', 'dashboard.ts'),
			'utf8',
		);
		// The inline script seeds window state from JSON-encoded server state.
		assert.ok(dashboard.includes('window.__hydrated='));
		assert.ok(dashboard.includes('encodeWebviewSelection('));
		assert.ok(dashboard.includes('window.__selectedChat='));
		assert.ok(dashboard.includes('window.__selectedTask='));
		assert.ok(dashboard.includes('window.__overheadExpanded='));
		// The hydrated chat must survive a nested-task click: the task
		// handler reads window.__selectedChat, and sanitize keeps the pair.
		assert.deepEqual(
			sanitizeDashboardSelection(
				{ selectedChatId: 'chat-a', selectedTaskId: 'task-1' },
				[{ taskId: 'task-1', chatId: 'chat-a' }],
				['chat-a'],
			),
			{ selectedChatId: 'chat-a', selectedTaskId: 'task-1' },
		);
	});
});
