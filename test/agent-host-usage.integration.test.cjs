/**
 * End-to-end regression test for Muse Usage chat/task correlation under the VS Code Agent Host
 * (Copilot SDK). Drives the real compiled `MetaChatProvider` — real `classifyProviderRequest`,
 * real `UsageService` (in-memory store), real stateful-marker emission — against a loopback fake
 * Meta endpoint, so unlike `provider-tools.integration.test.cjs` it does not stub `beginRequest`.
 *
 * Request shapes mirror real Agent Host provider-input dumps: a role-3 system prompt opening with
 * "You are an AI assistant using Copilot SDK in VS Code.", human turns wrapped as
 * `<current_datetime>…</current_datetime><system_reminder>…</system_reminder>text`, 379 tools,
 * `requestInitiator: 'core'`, and — once the host has a response id — a leading assistant message
 * holding only `stateful_marker` (`${modelId}\${responseId}`), exactly as the host builds it.
 * No network beyond 127.0.0.1; no real API key.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

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
const human = (text) => ({
	role: Role.User,
	content: [
		new Text(
			`<current_datetime>2026-10-01T21:26:13.124-07:00</current_datetime>\n<system_reminder>\nReminder text.\n</system_reminder>\n${text}`,
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
/** What the host builds from `previous_response_id`: `${modelId}\${responseId}` as the first message. */
function hostPointer(marker) {
	const decoded = new TextDecoder().decode(marker.data);
	const responseId = decoded.slice(decoded.indexOf('\\') + 1);
	return { role: Role.Assistant, content: [new Data(new TextEncoder().encode(`${MODEL_ID}\\${responseId}`), 'stateful_marker')] };
}

describe('Agent Host usage correlation: classifier -> real UsageService -> marker -> next turn', () => {
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
			['chat-title', 'You are an expert in crafting pithy titles for chatbot conversations.', undefined],
			['todo-tracker', 'You are a background task tracker. Keep the todo list current.', [{ name: 'manage_todo_list', description: 'todo', inputSchema: { type: 'object' } }]],
			['git-commit-message', 'You are an AI programming assistant, helping a software developer to come with the best git commit message.', undefined],
			['background', 'You are an exploration sub-agent. Search the codebase and report back.', agentHostTools().slice(0, 40)],
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
			assert.equal(overhead.requests, 4, 'only the four utility/background fixtures are overhead');
			assert.deepEqual(Object.keys(overhead.byKind).sort(), ['background', 'chat-title', 'git-commit-message', 'todo-tracker']);
			assert.equal(overhead.byKind['main-agent'], undefined, 'no main-agent request is unassigned overhead');
			assert.equal(aggregateRequests(accounting).requests, records.length, 'totals still include every request');
		});
	});
});
