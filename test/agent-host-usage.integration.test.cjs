/**
 * End-to-end regression test for Muse Usage chat/task correlation under the VS Code Agent Host
 * (Copilot SDK). Drives the real compiled `MetaChatProvider` — real `classifyProviderRequest`,
 * real `UsageService` (in-memory store), real stateful-marker emission — against a loopback fake
 * Meta endpoint, so unlike `provider-tools.integration.test.cjs` it does not stub `beginRequest`.
 *
 * Request shapes mirror real Agent Host provider-input dumps: a role-3 system prompt opening with
 * "You are an AI assistant using Copilot SDK in VS Code.", human turns wrapped as
 * `<current_datetime>…</current_datetime>` human turns, 380 tools, and `requestInitiator: 'core'`.
 * The captured seven-call sequence replays full history WITHOUT any stateful marker. Separate
 * compatibility cases retain the older 379-tool fixture and manufacture a leading pointer only
 * to test the conditional renderer path IF the SDK sends previous_response_id. These cases do
 * not prove that the live SDK echoes an emitted response ID.
 * No network beyond 127.0.0.1; no real API key.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const sevenCallFixture = require('./fixtures/agent-host-seven-calls.json');

const lm = require('./vscode-lm-stub.cjs');

const logs = [];
let port = 0;
const channel = Object.fromEntries(
	['info', 'warn', 'error', 'debug', 'trace'].map((level) => [level, (m) => logs.push(`[${level}] ${m}`)]),
);
class EventEmitter {
	constructor() {
		this.listeners = [];
		this.event = (listener) => {
			this.listeners.push(listener);
			return { dispose() {} };
		};
	}
	fire(value) {
		this.listeners.forEach((listener) => listener(value));
	}
	dispose() {}
}
const vscode = {
	...lm,
	EventEmitter,
	ThemeIcon: class {
		constructor(id) {
			this.id = id;
		}
	},
	ConfigurationTarget: { Global: 1, Workspace: 2 },
	LanguageModelChatToolMode: { Auto: 1, Required: 2 },
	Uri: {
		file: (p) => ({ fsPath: p, path: p, scheme: 'file' }),
		joinPath: (u, ...parts) => ({ fsPath: path.join(u.fsPath, ...parts), path: path.join(u.fsPath, ...parts), scheme: 'file' }),
	},
	window: { createOutputChannel: () => channel, showInformationMessage: async () => undefined },
	workspace: {
		workspaceFolders: [],
		getConfiguration: () => ({
			get: (key, fallback) => (key === 'baseUrl' ? `http://127.0.0.1:${port}/v1` : fallback),
			inspect: (key) => (key === 'debugMode' ? { globalValue: 'minimal' } : undefined),
		}),
		onDidChangeConfiguration: () => ({ dispose() {} }),
	},
	lm: { selectChatModels: async () => [] },
};
const STUB_ID = 'vscode-agent-host-usage-stub';
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: vscode };
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === 'vscode' ? STUB_ID : originalResolve.call(this, request, ...rest);
};

const { MetaChatProvider } = require('../out/provider/index.js');
const { classifyProviderRequest } = require('../out/provider/routing/index.js');
const { parseReplayMarkerData } = require('../out/provider/replay/index.js');
const { UsageService } = require('../out/usage/recorder.js');
const { createMemoryUsageStore } = require('../out/usage/storage.js');
const { partitionDashboardRecords } = require('../out/usage/dashboard.js');
const { aggregateRequests, rollupChats, rollupTasks, rollupUnassignedOverhead } = require('../out/usage/aggregate.js');

const { LanguageModelChatMessageRole: Role, LanguageModelTextPart: Text, LanguageModelDataPart: Data } = lm;
const SYSTEM = 3;
const TARGET = 'konnect-add_schematic_wire_0';
const MODEL_ID = 'muse-spark-1.3-contributor';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opening of the real Agent Host prompt, including the structure that follows the identity line. */
const AGENT_HOST_SYSTEM =
	'You are an AI assistant using Copilot SDK in VS Code. You help users with software engineering tasks. ' +
	'When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code. \n\n' +
	'<code_change_instructions>\n<rules_for_code_changes>\nMake minimal changes.\n</rules_for_code_changes>\n</code_change_instructions>\n' +
	'<tool_calling>\nCall tools when needed.\n</tool_calling>\n<task_completion>\nFinish the task.\n</task_completion>';

const received = [];
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', (chunk) => (body += chunk));
	req.on('end', () => {
		const request = JSON.parse(body);
		received.push(request);
		const toolNames = (request.tools ?? []).map((t) => t.function.name);
		if (toolNames.length > 128) {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: `too many functions: ${toolNames.length}` } }));
			return;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
		const loader = toolNames.find((name) => name.startsWith('meta_spark_load_tools'));
		send({ choices: [{ index: 0, delta: { reasoning_content: `thinking ${received.length}. ` } }] });
		if (toolNames.length === 0) {
			send({ choices: [{ index: 0, delta: { content: 'ok' } }] });
			send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
		} else {
			const call =
				!toolNames.includes(TARGET) && loader
					? { id: `call_load_${received.length}`, name: loader, args: { query: 'schematic wire' } }
					: { id: `call_real_${received.length}`, name: toolNames.includes(TARGET) ? TARGET : toolNames[0], args: { value: 'x' } };
			send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
			send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		}
		send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 500 } } });
		res.end('data: [DONE]\n\n');
	});
});

function agentHostTools() {
	const t = (name, description = `${name} tool`) => ({ name, description, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } });
	const r = (n, f) => Array.from({ length: n }, (_, i) => f(i));
	return [
		...['bash', 'powershell', 'view', 'edit', 'create', 'grep', 'glob', 'web_fetch', 'task', 'report_intent', 'ask_user', 'update_todo', 'read_agent'].map((n) => t(n)),
		...r(27, (i) => t(`copilot_clientTool${i}`)),
		...r(46, (i) => t(`github-mcp-server-op_${i}`)),
		...r(200, (i) => t(`konnect-${['add_schematic_wire', 'route_trace', 'run_drc', 'export_gerber', 'get_net'][i % 5]}_${i}`, `KiCad ${['schematic wire', 'pcb trace routing', 'design rule check', 'gerber export', 'net connectivity'][i % 5]} ${i}`)),
		...r(43, (i) => t(`eli-eli_op_${i}`)),
		...r(9, (i) => t(`eci-eci_op_${i}`)),
		...r(41, (i) => t(`freecad-cad_op_${i}`)),
	];
}

const modelInfo = {
	id: MODEL_ID,
	name: 'Muse Spark 1.3 (Contributor)',
	family: 'muse-spark',
	version: '1.3',
	maxInputTokens: 1048576,
	maxOutputTokens: 65536,
	capabilities: {},
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

// ---- Agent Host message builders --------------------------------------------------------------
const system = (text = AGENT_HOST_SYSTEM) => ({ role: SYSTEM, content: [new Text(text)] });
const human = (text, timestamp = '2026-10-01T21:26:13.124-07:00') => ({
	role: Role.User,
	content: [
		new Text(
			`<current_datetime>${timestamp}</current_datetime>\n<system_reminder>\nReminder text.\n</system_reminder>\n${text}`,
		),
	],
});
const assistantToolCall = (callId, text = 'Working on it.') => ({
	role: Role.Assistant,
	content: [new Text(text), new lm.LanguageModelToolCallPart(callId, TARGET, { value: 'x' })],
});
const toolResult = (callId) => ({
	role: Role.User,
	content: [new lm.LanguageModelToolResultPart(callId, [new Text('done')])],
});
/** `<skill-context>` is injected by the Agent Host as a text-only user message after a skill loads. */
const skillContext = () => ({
	role: Role.User,
	content: [new Text('<skill-context name="example-skill">\nSkill instructions that are not a human turn.\n</skill-context>')],
});
/** Conditional renderer shape IF previous_response_id is supplied; absent in the live seven calls. */
function hostPointer(marker) {
	const decoded = new TextDecoder().decode(marker.data);
	const responseId = decoded.slice(decoded.indexOf('\\') + 1);
	return { role: Role.Assistant, content: [new Data(new TextEncoder().encode(`${MODEL_ID}\\${responseId}`), 'stateful_marker')] };
}

function sessionContext(sessionFolder = sevenCallFixture.sessionFolder) {
	return `<session_context>\nSession folder: ${sessionFolder}\n\nContents:\n[redacted session contents]\n</session_context>`;
}

function fixtureSystem(sessionFolder = sevenCallFixture.sessionFolder, { ambiguous = false } = {}) {
	const context = sessionContext(sessionFolder);
	return system(`${AGENT_HOST_SYSTEM}\n\n${context}${ambiguous ? `\n\n${sessionContext('c:/Users/REDACTED/.copilot/session-state/00000000-0000-4000-8000-000000000002')}` : ''}`);
}

/** Build VS Code messages from the redacted role/part notation in the live snapshot fixture. */
function fixtureMessages(snapshot, { sessionFolder, humanPrompt, currentDatetime, ambiguousSession } = {}) {
	const calls = new Map();
	return snapshot.shape.split(';').map((messageShape, messageIndex) => {
		const separator = messageShape.indexOf(':');
		const roleKey = messageShape.slice(0, separator);
		const descriptors = messageShape.slice(separator + 1).split(',').filter(Boolean);
		const role = roleKey === 's' ? SYSTEM : roleKey === 'a' ? Role.Assistant : Role.User;
		const content = descriptors.map((descriptor) => {
			if (descriptor === 't') {
				if (roleKey === 's') {
					return new Text(fixtureSystem(sessionFolder, { ambiguous: ambiguousSession }).content[0].value);
				}
				if (roleKey === 'a') {
					return new Text('Redacted assistant response.');
				}
				return new Text(
					`<current_datetime>${currentDatetime ?? sevenCallFixture.currentDatetime}</current_datetime>\n<system_reminder>\nReminder text.\n</system_reminder>\n${humanPrompt ?? sevenCallFixture.humanText}`,
				);
			}
			if (/^c\d+$/.test(descriptor)) {
				const callId = `fixture-call-${descriptor.slice(1).padStart(2, '0')}`;
				calls.set(descriptor, callId);
				return new lm.LanguageModelToolCallPart(callId, 'fixture_tool', {});
			}
			if (/^r\d+$/.test(descriptor)) {
				const callId = calls.get(`c${descriptor.slice(1)}`);
				assert.ok(callId, `redacted result ${descriptor} refers to an earlier call`);
				return new lm.LanguageModelToolResultPart(callId, [new Text('redacted fixture tool result')]);
			}
			throw new Error(`Unknown Agent Host fixture part ${descriptor} at message ${messageIndex}`);
		});
		return { role, content };
	});
}

describe('Agent Host usage: full-history correlation and conditional marker compatibility', () => {
	let provider;
	let storage;
	let store;
	let service;
	const recorded = [];
	const requestOptions = (tools = agentHostTools()) => ({ tools, toolMode: 1, requestInitiator: 'core' });

	/** Runs one provider call and waits for its (fire-and-forget) usage record to be persisted. */
	async function run(messages, tools = agentHostTools()) {
		const before = recorded.length;
		const reported = [];
		await provider.provideLanguageModelChatResponse(modelInfo, messages, requestOptions(tools), { report: (p) => reported.push(p) }, token);
		for (let i = 0; i < 400 && recorded.length === before; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(recorded.length, before + 1, 'exactly one usage record per provider call');
		const markers = reported.filter((p) => p instanceof Data && p.mimeType === 'stateful_marker');
		return { record: recorded.at(-1), marker: markers.at(-1), markers, reported };
	}

	before(async () => {
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = server.address().port;
		storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'muse-agent-host-usage-'));
		store = createMemoryUsageStore();
		service = new UsageService({
			store,
			onRecorded: (record) => recorded.push(record),
			getWorkspaceUris: () => ['file:///d%3A/Development/Project'],
			getWorkspaceName: () => 'Project',
		});
		provider = new MetaChatProvider({
			globalStorageUri: vscode.Uri.file(storage),
			subscriptions: [],
			secrets: { get: async () => 'test-key', store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
			globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
			workspaceState: { get: () => undefined, update: async () => {} },
		});
		provider.setUsageService(service);
	});

	after(async () => {
		server.close();
		await fsp.rm(storage, { recursive: true, force: true });
	});

	// State carried through the ordered sequence below.
	const chain = {};

	describe('classification', () => {
		it('the Agent Host system prompt classifies as main-agent', () => {
			const kind = classifyProviderRequest({ messages: [system('You are an AI assistant using Copilot SDK in VS Code.'), human('hi')], tools: agentHostTools() });
			assert.equal(kind, 'main-agent');
			assert.equal(classifyProviderRequest({ messages: [system(), human('hi')], tools: agentHostTools() }), 'main-agent');
		});

		it('still classifies main-agent when the host prepends the previousResponseId pointer before the system prompt', () => {
			const pointer = { role: Role.Assistant, content: [new Data(new TextEncoder().encode(`${MODEL_ID}\\opaque`), 'stateful_marker')] };
			assert.equal(classifyProviderRequest({ messages: [pointer, system(), human('hi')], tools: agentHostTools() }), 'main-agent');
		});

		it('the legacy Copilot Chat prompt still classifies main-agent', () => {
			const messages = [{ role: Role.User, content: [new Text('You are an expert AI programming assistant, working with a user in the VS Code editor.')] }];
			assert.equal(classifyProviderRequest({ messages, tools: agentHostTools() }), 'main-agent');
		});

		const nonMain = [
			['chat-title', 'You are an expert in crafting pithy titles for chatbot conversations.', undefined, 'title this'],
			['todo-tracker', 'You are a background task tracker. Keep the todo list current.', ['manage_todo_list'], 'update'],
			['prompt-categorizer', 'You are an expert classifier for AI coding assistant prompts.', ['categorize_prompt'], 'classify'],
			['git-commit-message', 'You are an AI programming assistant, helping a software developer to come with the best git commit message.', undefined, 'diff'],
			['terminal-steering', AGENT_HOST_SYSTEM, ['bash'], '[Terminal 12 notification: command finished]'],
			['background', 'You are an exploration sub-agent. Search the codebase and report back.', ['grep', 'glob', 'view'], 'find usages'],
			['background', 'You are a helpful assistant.', ['bash', 'powershell'], 'hello'],
		];
		for (const [expected, prompt, toolNames, userText] of nonMain) {
			it(`${expected} fixture is not main-agent (${prompt.slice(0, 40)}…)`, () => {
				const tools = toolNames?.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
				const messages = [system(prompt), { role: Role.User, content: [new Text(userText)] }];
				assert.equal(classifyProviderRequest({ messages, tools }), expected);
			});
		}
	});

	describe('first human turn', () => {
		it('classifies main-agent, allocates a chat and task, records the IDs, and emits a matching marker', async () => {
			const { record, marker, markers, reported } = await run([system(), human('Add a wire to the schematic.')]);

			assert.equal(record.requestKind, 'main-agent');
			assert.equal(record.requestInitiator, 'core');
			assert.match(record.chatId, UUID);
			assert.match(record.taskId, UUID);
			assert.equal(record.taskPreview, 'Add a wire to the schematic.');
			assert.equal(record.promptTokens, 2000, 'discovery rounds are summed into a single record');

			assert.equal(markers.length, 1, 'single stateful marker for the whole response');
			assert.equal(new TextDecoder().decode(marker.data).split('\\')[0], MODEL_ID, 'marker prefix is the VS Code model id');
			const parsed = parseReplayMarkerData(marker.data);
			assert.equal(parsed.valid, true);
			assert.equal(parsed.usageChatId, record.chatId);
			assert.equal(parsed.usageTaskId, record.taskId);

			const contexts = store.getContexts();
			assert.deepEqual(Object.keys(contexts.chats), [record.chatId]);
			assert.deepEqual(Object.keys(contexts.tasks), [record.taskId]);
			const toolCall = reported.find((p) => p instanceof lm.LanguageModelToolCallPart);
			assert.equal(toolCall.name, TARGET);
			Object.assign(chain, { chatId: record.chatId, taskId1: record.taskId, marker, callId: toolCall.callId });
		});

		it('keeps >128-tool virtualization unchanged under real usage tracking', () => {
			assert.equal(received.length, 2, 'one discovery round, then the answer');
			for (const request of received) {
				assert.ok(request.tools.length <= 128, `outbound functions ${request.tools.length}`);
			}
			assert.ok(!received[0].tools.some((t) => t.function.name === TARGET));
			assert.ok(received[1].tools.some((t) => t.function.name === TARGET), 'loaded tool sent in round 2');
			assert.equal(received[1].messages.at(-1).role, 'tool');
			const virtualizationLogs = logs.filter((line) => line.includes('[tool-virtualization]'));
			assert.equal(virtualizationLogs.length, 2);
			assert.match(virtualizationLogs[0], /^\[info\] \[main-agent\] \[tool-virtualization\] mode=virtualized supplied=379 activators=0 sentFunctions=\d+\/128/);
			assert.match(virtualizationLogs[1], /loaderCalls=1 newlyLoaded=\d+ toolSetChanged=true continued=true/);
		});
	});

	describe('tool-result continuation inherits the same task', () => {
		const expectInherited = (record) => {
			assert.equal(record.requestKind, 'main-agent');
			assert.equal(record.chatId, chain.chatId);
			assert.equal(record.taskId, chain.taskId1);
		};

		it('Agent Host full history behind a previousResponseId pointer', async () => {
			const { record, marker } = await run([
				hostPointer(chain.marker),
				system(),
				human('Add a wire to the schematic.'),
				assistantToolCall(chain.callId),
				toolResult(chain.callId),
			]);
			expectInherited(record);
			chain.marker = marker;
		});

		it('Agent Host delta input behind a previousResponseId pointer', async () => {
			const { record, marker } = await run([hostPointer(chain.marker), system(), toolResult(chain.callId)]);
			expectInherited(record);
			chain.marker = marker;
		});

		it('an injected <skill-context> message is not a new human turn', async () => {
			const { record, marker } = await run([
				hostPointer(chain.marker),
				system(),
				human('Add a wire to the schematic.'),
				assistantToolCall(chain.callId),
				toolResult(chain.callId),
				skillContext(),
			]);
			expectInherited(record);
			chain.marker = marker;
		});

		it('classic history with the marker inside the assistant message', async () => {
			const { record, marker } = await run([
				system(),
				human('Add a wire to the schematic.'),
				{ role: Role.Assistant, content: [new Text('Working on it.'), new lm.LanguageModelToolCallPart(chain.callId, TARGET, { value: 'x' }), chain.marker] },
				toolResult(chain.callId),
			]);
			expectInherited(record);
			chain.marker = marker;
		});
	});

	describe('later human prompts', () => {
		it('a new substantive prompt (full history) creates a new task under the same chat', async () => {
			const { record, marker } = await run([
				hostPointer(chain.marker),
				system(),
				human('Add a wire to the schematic.'),
				assistantToolCall(chain.callId),
				toolResult(chain.callId),
				{ role: Role.Assistant, content: [new Text('The wire was added.')] },
				human('Now run a design rule check.'),
			]);
			assert.equal(record.requestKind, 'main-agent');
			assert.equal(record.chatId, chain.chatId);
			assert.notEqual(record.taskId, chain.taskId1);
			assert.match(record.taskId, UUID);
			assert.equal(record.taskPreview, 'Now run a design rule check.');
			assert.equal(parseReplayMarkerData(marker.data).usageTaskId, record.taskId);
			Object.assign(chain, { taskId2: record.taskId, marker });
		});

		it('a new substantive prompt (delta input) creates another task under the same chat', async () => {
			const { record, marker } = await run([hostPointer(chain.marker), system(), human('Export the gerbers.')]);
			assert.equal(record.chatId, chain.chatId);
			assert.notEqual(record.taskId, chain.taskId1);
			assert.notEqual(record.taskId, chain.taskId2);
			Object.assign(chain, { taskId3: record.taskId, marker });
		});

		it('tool-result continuation after the later prompt stays in that prompt\'s task', async () => {
			const { record } = await run([
				hostPointer(chain.marker),
				system(),
				human('Add a wire to the schematic.'),
				assistantToolCall('c1'),
				toolResult('c1'),
				{ role: Role.Assistant, content: [new Text('The wire was added.')] },
				human('Export the gerbers.'),
				assistantToolCall('c2'),
				toolResult('c2'),
			]);
			assert.equal(record.chatId, chain.chatId);
			assert.equal(record.taskId, chain.taskId3);
		});
	});

	describe('utility and background requests', () => {
		const fixtures = [
			['chat-title', `You are an expert in crafting pithy titles for chatbot conversations.\n\n${sessionContext()}`, undefined],
			['todo-tracker', `You are a background task tracker. Keep the todo list current.\n\n${sessionContext()}`, [{ name: 'manage_todo_list', description: 'todo', inputSchema: { type: 'object' } }]],
			['git-commit-message', `You are an AI programming assistant, helping a software developer to come with the best git commit message.\n\n${sessionContext()}`, undefined],
			['background', `You are an exploration sub-agent. Search the codebase and report back.\n\n${sessionContext()}`, agentHostTools().slice(0, 40)],
		];

		it('stay non-main, create no chats or tasks, and emit no usage marker', async () => {
			const chatsBefore = Object.keys(store.getContexts().chats).length;
			const tasksBefore = Object.keys(store.getContexts().tasks).length;
			for (const [expected, prompt, tools] of fixtures) {
				const { record, markers } = await run([system(prompt), { role: Role.User, content: [new Text('do the thing')] }], tools);
				assert.equal(record.requestKind, expected);
				assert.equal(record.chatId, null, `${expected} must not get a chat`);
				assert.equal(record.taskId, null, `${expected} must not get a task`);
				for (const marker of markers) {
					assert.equal(parseReplayMarkerData(marker.data).usageChatId, undefined, `${expected} must not carry usage correlation`);
				}
			}
			assert.equal(Object.keys(store.getContexts().chats).length, chatsBefore, 'no fake chats');
			assert.equal(Object.keys(store.getContexts().tasks).length, tasksBefore, 'no fake tasks');
		});
	});

	describe('dashboard rollup for the whole sequence', () => {
		it('shows one Local Chat with three tasks; only utility requests are unassigned overhead', async () => {
			const { records } = await store.readRequests();
			const filters = { period: 'all', projectId: 'all', modelId: 'all', search: '' };
			const { accounting, visible } = partitionDashboardRecords(records, filters, Date.now(), 0);
			const contexts = store.getContexts();
			const tasks = rollupTasks(visible, new Map(Object.entries(contexts.tasks).map(([id, task]) => [id, task.preview])));
			const chats = rollupChats(tasks, new Map(Object.entries(contexts.chats).map(([id, chat]) => [id, chat.displayName])));
			const overhead = rollupUnassignedOverhead(visible);

			assert.equal(chats.length, 1, 'Local chats must not be 0');
			assert.equal(chats[0].chatId, chain.chatId);
			assert.equal(chats[0].displayName, 'Add a wire to the schematic.');
			assert.equal(chats[0].taskCount, 3);
			assert.deepEqual(new Set(tasks.map((task) => task.taskId)), new Set([chain.taskId1, chain.taskId2, chain.taskId3]));

			const mainRequests = records.filter((record) => record.requestKind === 'main-agent');
			assert.equal(mainRequests.length, 8);
			assert.ok(mainRequests.every((record) => record.chatId === chain.chatId && record.taskId));
			assert.equal(chats[0].requests, mainRequests.length);
			assert.equal(overhead.requests, 4, 'only utility/background fixtures are overhead');
			assert.deepEqual(Object.keys(overhead.byKind).sort(), ['background', 'chat-title', 'git-commit-message', 'todo-tracker']);
			assert.equal(overhead.byKind['main-agent'], undefined, 'no main-agent request is unassigned overhead');
			assert.equal(aggregateRequests(accounting).requests, records.length, 'totals still include every request');
		});
	});
	describe('live Agent Host full-history snapshots without a marker', () => {
		const liveTools = [...agentHostTools(), {
			name: 'fixture_agent_host_tool_380',
			description: 'redacted Agent Host tool',
			inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
		}];
		const state = {};
		const firstPrompt = sevenCallFixture.humanText;
		const firstStamp = sevenCallFixture.currentDatetime;
		const latestSnapshot = sevenCallFixture.snapshots.at(-1);

		it('replays all seven increasing full histories into one chat and one task with no overhead', async () => {
			assert.equal(liveTools.length, sevenCallFixture.toolCount);
			assert.deepEqual(sevenCallFixture.snapshots.map((snapshot) => snapshot.messageCount), [2, 4, 8, 10, 12, 15, 20]);
			const previousChats = new Set(Object.keys(store.getContexts().chats));
			const previousTasks = new Set(Object.keys(store.getContexts().tasks));
			const liveRecords = [];
			for (const snapshot of sevenCallFixture.snapshots) {
				const { record, marker } = await run(fixtureMessages(snapshot), liveTools);
				assert.equal(record.requestKind, 'main-agent');
				assert.equal(record.requestInitiator, 'core');
				assert.equal(record.taskPreview, firstPrompt);
				assert.match(record.chatId, UUID);
				assert.match(record.taskId, UUID);
				assert.equal(parseReplayMarkerData(marker.data).usageChatId, record.chatId);
				assert.equal(parseReplayMarkerData(marker.data).usageTaskId, record.taskId);
				liveRecords.push(record);
				state.marker = marker;
				assert.equal(fixtureMessages(snapshot).length, snapshot.messageCount);
			}
			assert.equal(new Set(liveRecords.map((record) => record.chatId)).size, 1);
			assert.equal(new Set(liveRecords.map((record) => record.taskId)).size, 1);
			assert.equal(liveRecords.length, 7);
			assert.equal(new Set(Object.keys(store.getContexts().chats).filter((id) => !previousChats.has(id))).size, 1);
			assert.equal(new Set(Object.keys(store.getContexts().tasks).filter((id) => !previousTasks.has(id))).size, 1);
			assert.equal(rollupUnassignedOverhead(liveRecords).requests, 0, 'main-agent requests are fully assigned');
			const contexts = store.getContexts();
			const tasks = rollupTasks(liveRecords, new Map(Object.entries(contexts.tasks).map(([id, task]) => [id, task.preview])));
			const chats = rollupChats(tasks, new Map(Object.entries(contexts.chats).map(([id, chat]) => [id, chat.displayName])));
			assert.equal(chats.length, 1);
			assert.equal(chats[0].taskCount, 1);
			assert.equal(chats[0].requests, 7);
			Object.assign(state, { chatId: liveRecords[0].chatId, taskId: liveRecords[0].taskId });
		});

		it('a later stamped human turn starts a new task and the next tool loop keeps it', async () => {
			const nextStamp = '2026-10-01T22:53:11.013-07:00';
			const nextHistory = [
				...fixtureMessages(latestSnapshot),
				{ role: Role.Assistant, content: [new Text('The requested work is complete.')] },
				human('Please check the follow-up.', nextStamp),
			];
			const { record, reported } = await run(nextHistory, liveTools);
			assert.equal(record.chatId, state.chatId);
			assert.notEqual(record.taskId, state.taskId);
			assert.equal(record.taskPreview, 'Please check the follow-up.');
			const returnedCall = reported.find((part) => part instanceof lm.LanguageModelToolCallPart);
			assert.ok(returnedCall, 'fake endpoint should return a tool call for the follow-up request');
			const continuation = await run([
				...nextHistory,
				assistantToolCall(returnedCall.callId),
				toolResult(returnedCall.callId),
			], liveTools);
			assert.equal(continuation.record.chatId, state.chatId);
			assert.equal(continuation.record.taskId, record.taskId);
			state.followupTaskId = record.taskId;
		});

		it('same prompt and stamp in a second session creates a separate chat', async () => {
			const otherSession = 'c:/Users/REDACTED/.copilot/session-state/00000000-0000-4000-8000-000000000002';
			const { record } = await run(fixtureMessages(latestSnapshot, {
				sessionFolder: otherSession,
				humanPrompt: firstPrompt,
				currentDatetime: firstStamp,
			}), liveTools);
			assert.notEqual(record.chatId, state.chatId);
			assert.notEqual(record.taskId, state.taskId);
		});

		it('a valid in-history marker keeps its existing chat and task ahead of a copied session folder', async () => {
			const copiedSession = 'c:/Users/REDACTED/.copilot/session-state/00000000-0000-4000-8000-000000000002';
			const fullHistory = fixtureMessages(latestSnapshot, { sessionFolder: copiedSession });
			const { record } = await run([hostPointer(state.marker), ...fullHistory], liveTools);
			assert.equal(record.chatId, state.chatId);
			assert.equal(record.taskId, state.taskId);
		});

		it('missing or ambiguous system session blocks keep requests in the no-marker path', async () => {
			const missing = async () => run([system(), human(firstPrompt, firstStamp)], liveTools);
			const ambiguous = async () => run(fixtureMessages(sevenCallFixture.snapshots[0], { ambiguousSession: true }), liveTools);
			const missingOne = await missing();
			const missingTwo = await missing();
			const ambiguousOne = await ambiguous();
			const ambiguousTwo = await ambiguous();
			for (const { record } of [missingOne, missingTwo, ambiguousOne, ambiguousTwo]) {
				assert.match(record.chatId, UUID);
				assert.match(record.taskId, UUID);
			}
			assert.notEqual(missingOne.record.chatId, missingTwo.record.chatId);
			assert.notEqual(ambiguousOne.record.chatId, ambiguousTwo.record.chatId);
			assert.notEqual(missingOne.record.chatId, ambiguousOne.record.chatId);
		});

		it('does not treat a session path in user text as an Agent Host session signal', async () => {
			const pathOnlyPrompt = `Session folder: ${sevenCallFixture.sessionFolder}\n${firstPrompt}`;
			const make = () => [system(), human(pathOnlyPrompt, firstStamp)];
			const one = await run(make(), liveTools);
			const two = await run(make(), liveTools);
			assert.notEqual(one.record.chatId, two.record.chatId);
			assert.notEqual(one.record.taskId, two.record.taskId);
		});

		it('falls back when the human turn has no canonical timestamp', async () => {
			const make = () => [fixtureSystem(), { role: Role.User, content: [new Text(firstPrompt)] }];
			const one = await run(make(), liveTools);
			const two = await run(make(), liveTools);
			assert.notEqual(one.record.chatId, two.record.chatId);
			assert.notEqual(one.record.taskId, two.record.taskId);
		});

		it('the same stamped prompt repeated as a second human turn receives a distinct task', async () => {
			const messages = [
				...fixtureMessages(latestSnapshot),
				{ role: Role.Assistant, content: [new Text('First response.')] },
				human(firstPrompt, firstStamp),
			];
			const { record } = await run(messages, liveTools);
			assert.equal(record.chatId, state.chatId);
			assert.notEqual(record.taskId, state.taskId);
			assert.notEqual(record.taskId, state.followupTaskId);
		});

		it('reloaded UsageService derives the same IDs from the same full history', async () => {
			const originalService = service;
			const reloadedService = new UsageService({
				store,
				onRecorded: (record) => recorded.push(record),
				getWorkspaceUris: () => ['file:///d%3A/Development/Project'],
				getWorkspaceName: () => 'Project',
			});
			provider.setUsageService(reloadedService);
			try {
				const { record } = await run(fixtureMessages(latestSnapshot), liveTools);
				assert.equal(record.chatId, state.chatId);
				assert.equal(record.taskId, state.taskId);
			} finally {
				provider.setUsageService(originalService);
			}
		});
	});


});
