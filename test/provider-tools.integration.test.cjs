/**
 * Loopback integration test for DC-0003: drives the real compiled
 * `MetaChatProvider` with the Agent Host's 379-tool request shape against a
 * local fake Meta SSE endpoint. Covers the provider wiring (planning, request
 * preparation, stream interception, discovery continuation, replay marker,
 * usage accounting) that the pure unit tests in `tools.test.cjs` cannot.
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
const STUB_ID = 'vscode-provider-integration-stub';
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: vscode };
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === 'vscode' ? STUB_ID : originalResolve.call(this, request, ...rest);
};

const { MetaChatProvider } = require('../out/provider/index.js');
const { parseReplayMarkerData } = require('../out/provider/replay/index.js');

const TARGET = 'konnect-add_schematic_wire_0';
const received = [];

/** Fake Meta: asks the loader until TARGET is sent, then calls TARGET. Rejects >128 functions like Meta. */
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
		const call =
			!toolNames.includes(TARGET) && loader
				? { id: `call_load_${received.length}`, name: loader, args: { query: 'schematic wire' } }
				: { id: `call_real_${received.length}`, name: TARGET, args: { value: 'x' } };
		if (call.name === TARGET) {
			send({ choices: [{ index: 0, delta: { content: 'Adding the wire.' } }] });
		}
		send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
		send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
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
	id: 'muse-spark-1.3-contributor',
	name: 'Muse Spark 1.3 (Contributor)',
	family: 'muse-spark',
	version: '1.3',
	maxInputTokens: 1048576,
	maxOutputTokens: 65536,
	capabilities: {},
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const userTurn = [
	{ role: lm.LanguageModelChatMessageRole.System, content: [new lm.LanguageModelTextPart('You are an AI assistant using Copilot SDK in VS Code.')] },
	{ role: lm.LanguageModelChatMessageRole.User, content: [new lm.LanguageModelTextPart('Add a wire to the schematic.')] },
];

describe('provider integration: Agent Host 379-tool request (loopback Meta)', () => {
	let provider;
	let storage;
	const usage = [];

	before(async () => {
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = server.address().port;
		storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'muse-provider-it-'));
		provider = new MetaChatProvider({
			globalStorageUri: vscode.Uri.file(storage),
			subscriptions: [],
			secrets: { get: async () => 'test-key', store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
			globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
			workspaceState: { get: () => undefined, update: async () => {} },
		});
		provider.setUsageService({
			beginRequest: async () => ({ allocation: {}, requestKind: 'main-agent' }),
			recordCompleted: async (_pending, completed) => usage.push(completed.usage),
			recordAttempt: async (_pending, reason) => usage.push({ attempt: reason }),
		});
	});

	after(async () => {
		server.close();
		await fsp.rm(storage, { recursive: true, force: true });
	});

	let firstTurn;

	it('completes without exceeding 128 functions and hides the loader from the host', async () => {
		const tools = agentHostTools();
		assert.equal(tools.length, 379);
		const reported = [];
		await provider.provideLanguageModelChatResponse(modelInfo, userTurn, { tools, toolMode: 1 }, { report: (p) => reported.push(p) }, token);

		assert.equal(received.length, 2, 'one discovery round, then the answer');
		for (const request of received) {
			assert.ok(request.tools.length <= 128, `outbound functions ${request.tools.length}`);
		}
		assert.ok(!received[0].tools.some((t) => t.function.name === TARGET));
		assert.ok(received[1].tools.some((t) => t.function.name === TARGET), 'loaded tool sent in round 2');
		const [assistant, toolResult] = received[1].messages.slice(-2);
		assert.equal(assistant.role, 'assistant');
		assert.equal(assistant.tool_calls[0].function.name, 'meta_spark_load_tools');
		assert.equal(assistant.reasoning_content, 'thinking 1. ');
		assert.equal(toolResult.role, 'tool');
		assert.match(toolResult.content, /^Loaded \d+ tool\(s\)/);

		const toolCalls = reported.filter((p) => p instanceof lm.LanguageModelToolCallPart);
		assert.deepEqual(toolCalls.map((c) => c.name), [TARGET]);
		const markers = reported.filter((p) => p instanceof lm.LanguageModelDataPart && p.mimeType === 'stateful_marker');
		assert.equal(markers.length, 1, 'single replay marker for the whole response');
		const marker = parseReplayMarkerData(markers[0].data);
		assert.ok(marker.loadedTools.includes(TARGET));
		assert.equal(marker.reasoningText, 'thinking 1. thinking 2. ');

		assert.equal(usage.length, 1, 'usage recorded once per provider call');
		assert.equal(usage[0].prompt_tokens, 2000);
		assert.equal(usage[0].prompt_tokens_details.cached_tokens, 1000);

		const virtualizationLogs = logs.filter((line) => line.includes('[tool-virtualization]'));
		assert.equal(virtualizationLogs.length, 2);
		assert.match(virtualizationLogs[0], /mode=virtualized supplied=379 activators=0 sentFunctions=\d+\/128/);
		assert.match(virtualizationLogs[1], /loaderCalls=1 newlyLoaded=\d+ toolSetChanged=true continued=true/);
		assert.ok(!logs.some((line) => line.includes('schematic wire"')), 'loader arguments are not logged');
		firstTurn = { toolCall: toolCalls[0], marker: markers[0] };
	});

	it('next turn reuses loaded tools from the replay marker without another discovery round', async () => {
		const before = received.length;
		const history = [
			...userTurn,
			{ role: lm.LanguageModelChatMessageRole.Assistant, content: [new lm.LanguageModelTextPart('Adding the wire.'), firstTurn.toolCall, firstTurn.marker] },
			{ role: lm.LanguageModelChatMessageRole.User, content: [new lm.LanguageModelToolResultPart(firstTurn.toolCall.callId, [new lm.LanguageModelTextPart('wire added')])] },
		];
		await provider.provideLanguageModelChatResponse(modelInfo, history, { tools: agentHostTools(), toolMode: 1 }, { report: () => {} }, token);
		assert.equal(received.length - before, 1);
		assert.ok(received[before].tools.length <= 128);
		assert.ok(received[before].tools.some((t) => t.function.name === TARGET));
	});

	it('128 or fewer tools are sent unchanged with no loader', async () => {
		const before = received.length;
		const tools = agentHostTools().slice(0, 128);
		await provider.provideLanguageModelChatResponse(modelInfo, userTurn, { tools, toolMode: 1 }, { report: () => {} }, token);
		assert.deepEqual(received[before].tools.map((t) => t.function.name), tools.map((t) => t.name));
	});
});
