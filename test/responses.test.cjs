/**
 * DC-0005: Responses API transport with encrypted reasoning replay.
 *
 * Unit coverage for the Chat→Responses translation, the Responses stream mapper and the reasoning
 * store, plus a loopback integration that drives the real compiled `MetaChatProvider` through an
 * Agent Host-shaped tool loop whose history carries no provider data parts (the shape observed in
 * the field). No network beyond 127.0.0.1; no real API key.
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
let apiProtocol = 'responses';
const channel = Object.fromEntries(
	['info', 'warn', 'error', 'debug', 'trace'].map((level) => [level, (m) => logs.push(`[${level}] ${m}`)]),
);
class EventEmitter {
	constructor() {
		this.event = () => ({ dispose() {} });
	}
	fire() {}
	dispose() {}
}
const vscode = {
	...lm,
	EventEmitter,
	ConfigurationTarget: { Global: 1, Workspace: 2 },
	Uri: {
		file: (p) => ({ fsPath: p, path: p, scheme: 'file' }),
		joinPath: (u, ...parts) => ({ fsPath: path.join(u.fsPath, ...parts), path: path.join(u.fsPath, ...parts), scheme: 'file' }),
	},
	window: { createOutputChannel: () => channel, showInformationMessage: async () => undefined },
	workspace: {
		workspaceFolders: [],
		getConfiguration: () => ({
			get: (key, fallback) => {
				if (key === 'baseUrl') return `http://127.0.0.1:${port}/v1`;
				if (key === 'apiProtocol') return apiProtocol;
				return fallback;
			},
			inspect: (key) => (key === 'debugMode' ? { globalValue: 'minimal' } : undefined),
		}),
		onDidChangeConfiguration: () => ({ dispose() {} }),
	},
	lm: { selectChatModels: async () => [] },
};
const STUB_ID = 'vscode-responses-test-stub';
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: vscode };
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === 'vscode' ? STUB_ID : originalResolve.call(this, request, ...rest);
};

const {
	toResponsesRequest,
	ResponsesStreamMapper,
	ResponsesStreamError,
	normalizeCallId,
} = require('../out/client/responses.js');
const { ReasoningReplayStore } = require('../out/provider/reasoning/index.js');
const { MetaChatProvider } = require('../out/provider/index.js');

const reasoning = (id, enc, summary = []) => ({
	type: 'reasoning',
	id,
	summary: summary.map((text) => ({ type: 'summary_text', text })),
	encrypted_content: enc,
});
const call = (id, name = 'view', args = '{"path":"README.md"}') => ({ id, type: 'function', function: { name, arguments: args } });
const baseRequest = (messages, extra = {}) => ({
	model: 'muse-spark-1.3-contributor',
	messages,
	stream: true,
	prompt_cache_key: 'vscode-copilot-meta-spark',
	...extra,
});

describe('toResponsesRequest', () => {
	it('replays reasoning before commentary text and its function call, statelessly', () => {
		const body = toResponsesRequest(
			baseRequest(
				[
					{ role: 'developer', content: 'You are an AI assistant using Copilot SDK in VS Code.' },
					{ role: 'user', content: 'Restart the app.' },
					{ role: 'assistant', content: 'Checking the docs.', tool_calls: [call('call_1')], reasoning_items: [reasoning('rs_1', 'ENC1')], reasoning_content: '' },
					{ role: 'tool', content: 'file text', tool_call_id: 'call_1' },
				],
				{ reasoning_effort: 'xhigh', max_completion_tokens: 4096 },
			),
			{ reasoningSummary: true },
		);
		assert.deepEqual(body.input, [
			{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are an AI assistant using Copilot SDK in VS Code.' }] },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Restart the app.' }] },
			{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the docs.' }], phase: 'commentary' },
			{ type: 'function_call', call_id: 'call_1', name: 'view', arguments: '{"path":"README.md"}' },
			{ type: 'function_call_output', call_id: 'call_1', output: 'file text' },
		]);
		assert.equal(body.store, false);
		assert.equal(body.stream, true);
		assert.deepEqual(body.include, ['reasoning.encrypted_content']);
		assert.deepEqual(body.reasoning, { effort: 'xhigh', summary: 'auto' });
		assert.equal(body.max_output_tokens, 4096);
		assert.equal(body.prompt_cache_key, 'vscode-copilot-meta-spark');
		for (const key of ['messages', 'stream_options', 'reasoning_effort', 'max_completion_tokens', 'previous_response_id']) {
			assert.ok(!(key in body), `${key} must not be sent`);
		}
	});

	it('sends final-answer text without a phase and omits reasoning without summary or effort', () => {
		const body = toResponsesRequest(baseRequest([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'Hello.' },
			{ role: 'user', content: 'again' },
		]));
		assert.deepEqual(body.input[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.' }] });
		assert.ok(!('reasoning' in body));
		assert.ok(!('tools' in body));
		assert.ok(!('max_output_tokens' in body));
	});

	it('flattens function tools and defaults a missing schema', () => {
		const body = toResponsesRequest(baseRequest([{ role: 'user', content: 'x' }], {
			tools: [
				{ type: 'function', function: { name: 'view', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
				{ type: 'function', function: { name: 'noargs' } },
			],
			tool_choice: 'auto',
		}));
		assert.deepEqual(body.tools, [
			{ type: 'function', name: 'view', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
			{ type: 'function', name: 'noargs', parameters: { type: 'object', properties: {} } },
		]);
		assert.equal(body.tool_choice, 'auto');
	});

	it('omits replayed reasoning on request, deduplicates ids, and never leaves reasoning unanchored', () => {
		const messages = [
			{ role: 'user', content: 'x' },
			{ role: 'assistant', content: '', reasoning_items: [reasoning('rs_0', 'ENC0')] },
			{ role: 'assistant', content: '', tool_calls: [call('a')], reasoning_items: [reasoning('rs_1', 'ENC1')] },
			{ role: 'tool', content: 'ok', tool_call_id: 'a' },
			{ role: 'assistant', content: '', tool_calls: [call('b')], reasoning_items: [reasoning('rs_1', 'ENC1'), reasoning('rs_2', 'ENC2')] },
			{ role: 'tool', content: 'ok', tool_call_id: 'b' },
		];
		const ids = (body) => body.input.filter((i) => i.type === 'reasoning').map((i) => i.id);
		assert.deepEqual(ids(toResponsesRequest(baseRequest(messages))), ['rs_1', 'rs_2']);
		assert.deepEqual(ids(toResponsesRequest(baseRequest(messages), { omitReasoning: true })), []);
	});

	it('repairs tool pairing that Meta would reject', () => {
		const longId = `toolu_${'x'.repeat(80)}`;
		const body = toResponsesRequest(baseRequest([
			{ role: 'user', content: 'x' },
			{ role: 'assistant', content: '', tool_calls: [call('a'), call(longId)] },
			{ role: 'tool', content: 'long ok', tool_call_id: longId },
			{ role: 'tool', content: 'stray', tool_call_id: 'gone' },
			{ role: 'user', content: 'next' },
		]));
		const short = normalizeCallId(longId);
		assert.ok(short.length <= 64 && short !== longId);
		assert.equal(normalizeCallId(longId), short, 'stable');
		assert.deepEqual(body.input.slice(1), [
			{ type: 'function_call', call_id: 'a', name: 'view', arguments: '{"path":"README.md"}' },
			{ type: 'function_call', call_id: short, name: 'view', arguments: '{"path":"README.md"}' },
			{ type: 'function_call_output', call_id: short, output: 'long ok' },
			{ type: 'function_call_output', call_id: 'a', output: 'No result was recorded for this tool call.' },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tool result (gone):\nstray' }] },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
		]);
	});

	it('sends images as input_image with a plain data URL', () => {
		const body = toResponsesRequest(baseRequest([
			{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
		]));
		assert.deepEqual(body.input[0].content, [
			{ type: 'input_text', text: 'what is this' },
			{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
		]);
	});
});

describe('ResponsesStreamMapper', () => {
	function collect() {
		const out = { content: '', thinking: '', toolCalls: [], reasoning: [] };
		const mapper = new ResponsesStreamMapper({
			onContent: (c) => (out.content += c),
			onThinking: (t) => (out.thinking += t),
			onToolCall: (tc) => out.toolCalls.push(tc),
			onReasoningItem: (r) => out.reasoning.push(r),
			onError: () => {},
			onDone: () => {},
		});
		return { out, mapper };
	}

	it('maps text, summaries, streamed arguments, reasoning items and usage', () => {
		const { out, mapper } = collect();
		const events = [
			{ type: 'response.created', response: { status: 'in_progress' } },
			{ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
			{ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0 },
			{ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Plan the restart.' },
			{ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan the restart.' }], encrypted_content: 'ENC1' } },
			{ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary' } },
			{ type: 'response.output_text.delta', output_index: 1, delta: 'Starting ' },
			{ type: 'response.output_text.delta', output_index: 1, delta: 'ECI.' },
			{ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'powershell', arguments: '' } },
			{ type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '{"command":' },
			{ type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '"Start-EciV2.ps1"}' },
			{ type: 'response.function_call_arguments.done', output_index: 2, item_id: 'fc_1', arguments: '{"command":"Start-EciV2.ps1"}' },
			{ type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'powershell', arguments: '{"command":"Start-EciV2.ps1"}', status: 'completed' } },
		];
		for (const event of events) {
			assert.equal(mapper.handle(event), undefined);
		}
		const terminal = mapper.handle({
			type: 'response.completed',
			response: {
				status: 'completed',
				output: [
					{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' },
					{ type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'powershell', arguments: '{"command":"Start-EciV2.ps1"}' },
				],
				usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020, input_tokens_details: { cached_tokens: 300 }, output_tokens_details: { reasoning_tokens: 80 } },
			},
		});
		assert.deepEqual(terminal, { status: 'completed' });
		assert.equal(out.content, 'Starting ECI.');
		assert.equal(out.thinking, 'Plan the restart.');
		assert.deepEqual(out.toolCalls, [{ id: 'call_9', type: 'function', function: { name: 'powershell', arguments: '{"command":"Start-EciV2.ps1"}' } }]);
		assert.deepEqual(out.reasoning, [{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan the restart.' }], encrypted_content: 'ENC1' }]);
		assert.deepEqual(mapper.latestUsage, {
			prompt_tokens: 900,
			completion_tokens: 120,
			total_tokens: 1020,
			prompt_tokens_details: { cached_tokens: 300 },
			completion_tokens_details: { reasoning_tokens: 80 },
		});
	});

	it('emits a call that only appears in the terminal response and reports incomplete responses', () => {
		const { out, mapper } = collect();
		const terminal = mapper.handle({
			type: 'response.incomplete',
			response: {
				status: 'incomplete',
				incomplete_details: { reason: 'max_output_tokens' },
				output: [{ type: 'function_call', call_id: 'call_late', name: 'view', arguments: '{}' }],
			},
		});
		assert.deepEqual(terminal, { status: 'incomplete', incompleteReason: 'max_output_tokens' });
		assert.deepEqual(out.toolCalls.map((c) => c.id), ['call_late']);
	});

	it('throws on response.failed and error events', () => {
		const { mapper } = collect();
		assert.throws(
			() => mapper.handle({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'boom' } } }),
			(error) => error instanceof ResponsesStreamError && error.code === 'server_error' && error.message === 'boom',
		);
		assert.throws(
			() => mapper.handle({ type: 'error', code: 'server_shutting_down', message: 'draining' }),
			(error) => error instanceof ResponsesStreamError && error.code === 'server_shutting_down',
		);
	});
});

describe('ReasoningReplayStore', () => {
	it('finds an entry by any of its call ids, only for the same model', async () => {
		const store = new ReasoningReplayStore(undefined);
		await store.ready();
		store.record('muse-spark-1.3', ['call_a', 'call_b'], [reasoning('rs_1', 'ENC1')]);
		assert.deepEqual(store.lookup('muse-spark-1.3', ['call_b']).map((r) => r.id), ['rs_1']);
		assert.deepEqual(store.lookup('muse-spark-1.3', ['missing', 'call_a']).map((r) => r.id), ['rs_1']);
		assert.equal(store.lookup('muse-spark-1.3-contributor', ['call_a']), undefined, 'bound to the producing model');
		store.record('muse-spark-1.3', ['call_c'], [{ type: 'reasoning', summary: [], encrypted_content: '' }]);
		assert.equal(store.lookup('muse-spark-1.3', ['call_c']), undefined, 'nothing replayable is not stored');
	});

	it('persists across instances and expires old entries', async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'muse-reasoning-store-'));
		try {
			let now = Date.now();
			const first = ReasoningReplayStore.forStorageDir(dir);
			await first.ready();
			first.record('m', ['call_a'], [reasoning('rs_1', 'ENC1')]);
			await first.flush();

			const second = new ReasoningReplayStore(path.join(dir, 'reasoning-replay-v1.json'), () => now);
			await second.ready();
			assert.deepEqual(second.lookup('m', ['call_a']).map((r) => r.encrypted_content), ['ENC1']);
			now += 8 * 24 * 60 * 60 * 1000;
			assert.equal(second.lookup('m', ['call_a']), undefined, 'expired after 7 days');

			await fsp.writeFile(path.join(dir, 'reasoning-replay-v1.json'), '{not json');
			const corrupt = ReasoningReplayStore.forStorageDir(dir);
			await corrupt.ready();
			assert.equal(corrupt.size, 0, 'unreadable store is ignored, not fatal');
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Loopback provider integration
// ---------------------------------------------------------------------------

const TARGET = 'konnect-add_schematic_wire_0';
const received = [];
/** Per-test response script: (body, index) => { status?, events? }. */
let script;

function sse(res, events) {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const event of events) {
		res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	}
	res.end('data: [DONE]\n\n');
}

function responseEvents({ reasoningId, enc, summary, text, calls = [], usage }) {
	const events = [{ type: 'response.created', response: { status: 'in_progress' } }];
	const output = [];
	let index = 0;
	if (enc) {
		const item = { type: 'reasoning', id: reasoningId, summary: summary ? [{ type: 'summary_text', text: summary }] : [], encrypted_content: enc };
		if (summary) {
			events.push({ type: 'response.reasoning_summary_text.delta', output_index: index, delta: summary });
		}
		events.push({ type: 'response.output_item.done', output_index: index, item });
		output.push(item);
		index += 1;
	}
	if (text) {
		events.push({ type: 'response.output_text.delta', output_index: index, delta: text });
		index += 1;
	}
	for (const c of calls) {
		const item = { type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) };
		events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '' } });
		events.push({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: item.arguments });
		events.push({ type: 'response.output_item.done', output_index: index, item });
		output.push(item);
		index += 1;
	}
	events.push({
		type: 'response.completed',
		response: { status: 'completed', output, usage: usage ?? { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 30 } } },
	});
	return events;
}

const server = http.createServer((req, res) => {
	let raw = '';
	req.on('data', (chunk) => (raw += chunk));
	req.on('end', () => {
		const body = JSON.parse(raw);
		received.push({ path: req.url, body });
		const reply = script(body, received.length);
		if (reply.status && reply.status !== 200) {
			res.writeHead(reply.status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(reply.error));
			return;
		}
		sse(res, reply.events);
	});
});

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
const system = { role: lm.LanguageModelChatMessageRole.System, content: [new lm.LanguageModelTextPart('You are an AI assistant using Copilot SDK in VS Code.')] };
const human = (text) => ({ role: lm.LanguageModelChatMessageRole.User, content: [new lm.LanguageModelTextPart(text)] });
/** Agent Host history shape: text + tool calls only; thinking and data parts are stripped. */
const assistantTurn = (text, toolCalls) => ({
	role: lm.LanguageModelChatMessageRole.Assistant,
	content: [...(text ? [new lm.LanguageModelTextPart(text)] : []), ...toolCalls.map((c) => new lm.LanguageModelToolCallPart(c.callId, c.name, c.input))],
});
const toolResult = (callId, text) => ({ role: lm.LanguageModelChatMessageRole.User, content: [new lm.LanguageModelToolResultPart(callId, [new lm.LanguageModelTextPart(text)])] });
const smallTools = ['view', 'powershell', 'grep'].map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }));

function bigToolSet() {
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

const reasoningOf = (body) => body.input.filter((i) => i.type === 'reasoning').map((i) => i.encrypted_content);

describe('provider integration: Responses API reasoning replay (loopback Meta)', () => {
	let storage;
	let provider;
	const usage = [];
	const newProvider = () => {
		const p = new MetaChatProvider({
			globalStorageUri: vscode.Uri.file(storage),
			subscriptions: [],
			secrets: { get: async () => 'test-key', store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
			globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
			workspaceState: { get: () => undefined, update: async () => {} },
		});
		p.setUsageService({
			beginRequest: async () => ({ allocation: {}, requestKind: 'main-agent' }),
			recordCompleted: async (_pending, completed) => usage.push(completed.usage),
			recordAttempt: async (_pending, reason) => usage.push({ attempt: reason }),
		});
		return p;
	};
	const run = async (p, messages, tools = smallTools) => {
		const reported = [];
		await p.provideLanguageModelChatResponse(modelInfo, messages, { tools, toolMode: 1, modelConfiguration: { reasoningEffort: 'xhigh' } }, { report: (part) => reported.push(part) }, token);
		return reported;
	};

	before(async () => {
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = server.address().port;
		storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'muse-responses-it-'));
		provider = newProvider();
	});

	after(async () => {
		server.close();
		await fsp.rm(storage, { recursive: true, force: true });
	});

	let turn1;

	it('first step goes to /responses statelessly and surfaces summary, commentary and the call', async () => {
		script = () => ({ events: responseEvents({ reasoningId: 'rs_1', enc: 'ENC1', summary: 'Need the launcher.', text: 'Checking the docs.', calls: [{ id: 'call_1', name: 'view', args: { value: 'docs' } }] }) });
		const reported = await run(provider, [system, human('ECI is not running. Restart it.')]);

		const { path: url, body } = received.at(-1);
		assert.equal(url, '/v1/responses');
		assert.equal(body.store, false);
		assert.deepEqual(body.include, ['reasoning.encrypted_content']);
		assert.equal(body.model, 'muse-spark-1.3-contributor');
		assert.equal(body.reasoning.summary, 'auto', 'main-agent requests ask for a summary');
		assert.deepEqual(body.tools.map((t) => t.name), ['view', 'powershell', 'grep']);

		const thinking = reported.filter((p) => p instanceof lm.LanguageModelThinkingPart).map((p) => p.value).join('');
		assert.equal(thinking, 'Need the launcher.');
		const text = reported.filter((p) => p instanceof lm.LanguageModelTextPart).map((p) => p.value).join('');
		assert.equal(text, 'Checking the docs.');
		const calls = reported.filter((p) => p instanceof lm.LanguageModelToolCallPart);
		assert.deepEqual(calls.map((c) => [c.callId, c.name]), [['call_1', 'view']]);
		assert.deepEqual(usage.at(-1), {
			prompt_tokens: 1000,
			completion_tokens: 50,
			total_tokens: 1050,
			prompt_tokens_details: { cached_tokens: 400 },
			completion_tokens_details: { reasoning_tokens: 30 },
		});
		turn1 = calls[0];
	});

	it('next step replays the stored reasoning although the host dropped every provider part', async () => {
		script = () => ({ events: responseEvents({ reasoningId: 'rs_2', enc: 'ENC2', text: 'Starting ECI.', calls: [{ id: 'call_2', name: 'powershell', args: { value: 'Start-EciV2.ps1' } }] }) });
		const history = [system, human('ECI is not running. Restart it.'), assistantTurn('Checking the docs.', [turn1]), toolResult('call_1', 'Use Start-EciV2.ps1')];
		await run(provider, history);

		const { body } = received.at(-1);
		assert.deepEqual(body.input.slice(2), [
			{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the docs.' }], phase: 'commentary' },
			{ type: 'function_call', call_id: 'call_1', name: 'view', arguments: '{"value":"docs"}' },
			{ type: 'function_call_output', call_id: 'call_1', output: 'Use Start-EciV2.ps1' },
		]);
		const replayLog = logs.filter((line) => line.includes('[reasoning-replay]')).at(-1);
		assert.match(replayLog, /protocol=responses toolTurns=1 replayedTurns=1 replayedItems=1 storedItems=1 storedForCalls=1/);
		assert.ok(!logs.some((line) => line.includes('ENC1')), 'encrypted reasoning is never logged');
	});

	it('a restarted provider replays the whole loop from the persisted store', async () => {
		await provider.reasoningReplay.flush();
		const restarted = newProvider();
		script = () => ({ events: responseEvents({ text: 'ECI is running.' }) });
		const history = [
			system,
			human('ECI is not running. Restart it.'),
			assistantTurn('Checking the docs.', [turn1]),
			toolResult('call_1', 'Use Start-EciV2.ps1'),
			assistantTurn('Starting ECI.', [new lm.LanguageModelToolCallPart('call_2', 'powershell', { value: 'Start-EciV2.ps1' })]),
			toolResult('call_2', 'started'),
		];
		await run(restarted, history);
		assert.deepEqual(reasoningOf(received.at(-1).body), ['ENC1', 'ENC2']);
		const persisted = await fsp.readFile(path.join(storage, 'reasoning-replay-v1.json'), 'utf8');
		assert.ok(persisted.includes('ENC1'));
		assert.ok(!persisted.includes('Need the launcher.'), 'readable reasoning summaries are not persisted');
	});

	it('retries once without reasoning when Meta rejects a replayed item', async () => {
		const before = received.length;
		script = (body) =>
			reasoningOf(body).length > 0
				? { status: 400, error: { error: { message: "Referenced reasoning item 'rs_1' was not found or has expired", type: 'invalid_request_error', param: 'input', code: null } } }
				: { events: responseEvents({ text: 'Recovered.' }) };
		const reported = await run(provider, [system, human('ECI is not running. Restart it.'), assistantTurn('Checking the docs.', [turn1]), toolResult('call_1', 'Use Start-EciV2.ps1')]);
		assert.equal(received.length - before, 2);
		assert.deepEqual(reasoningOf(received[before].body), ['ENC1']);
		assert.deepEqual(reasoningOf(received[before + 1].body), []);
		assert.equal(reported.filter((p) => p instanceof lm.LanguageModelTextPart).map((p) => p.value).join(''), 'Recovered.');
		assert.ok(logs.some((line) => line.includes('retrying once without them')));
	});

	it('does not retry unrelated 400s', async () => {
		const before = received.length;
		script = () => ({ status: 400, error: { error: { message: 'max_output_tokens too large', type: 'invalid_request_error', param: 'max_output_tokens', code: null } } });
		await assert.rejects(run(provider, [system, human('x'), assistantTurn('Checking the docs.', [turn1]), toolResult('call_1', 'ok')]), /max_output_tokens too large/);
		assert.equal(received.length - before, 1);
	});

	it('keeps tool virtualization working and carries the discovery round reasoning forward', async () => {
		const before = received.length;
		script = (body) => {
			const names = body.tools.map((t) => t.name);
			assert.ok(names.length <= 128, `outbound functions ${names.length}`);
			const loader = names.find((n) => n.startsWith('meta_spark_load_tools'));
			return !names.includes(TARGET) && loader
				? { events: responseEvents({ reasoningId: 'rs_load', enc: 'ENC_LOAD', calls: [{ id: 'call_load', name: loader, args: { query: 'schematic wire' } }] }) }
				: { events: responseEvents({ reasoningId: 'rs_wire', enc: 'ENC_WIRE', text: 'Adding the wire.', calls: [{ id: 'call_wire', name: TARGET, args: { value: 'x' } }] }) };
		};
		const reported = await run(provider, [system, human('Add a wire to the schematic.')], bigToolSet());
		assert.equal(received.length - before, 2, 'one discovery round, then the answer');
		const round2 = received[before + 1].body;
		const loaderCallIndex = round2.input.findIndex((i) => i.type === 'function_call' && i.call_id === 'call_load');
		assert.ok(loaderCallIndex > 0);
		assert.deepEqual(round2.input[loaderCallIndex - 1], { type: 'reasoning', id: 'rs_load', summary: [], encrypted_content: 'ENC_LOAD' });
		assert.equal(round2.input[loaderCallIndex + 1].type, 'function_call_output');
		assert.match(round2.input[loaderCallIndex + 1].output, /^Loaded \d+ tool\(s\)/);
		assert.deepEqual(reported.filter((p) => p instanceof lm.LanguageModelToolCallPart).map((c) => c.name), [TARGET], 'loader stays hidden');

		script = () => ({ events: responseEvents({ text: 'Done.' }) });
		await run(provider, [system, human('Add a wire to the schematic.'), assistantTurn('Adding the wire.', [new lm.LanguageModelToolCallPart('call_wire', TARGET, { value: 'x' })]), toolResult('call_wire', 'wire added')], bigToolSet());
		assert.deepEqual(reasoningOf(received.at(-1).body), ['ENC_LOAD', 'ENC_WIRE'], 'both rounds replay before the host-visible call');
	});

	it('chatCompletions setting keeps the old endpoint', async () => {
		apiProtocol = 'chatCompletions';
		try {
			const before = received.length;
			script = () => ({ events: [] });
			// The fake only speaks Responses; an empty stream is enough to prove the route.
			await run(provider, [system, human('hi')]).catch(() => {});
			assert.equal(received[before].path, '/v1/chat/completions');
			assert.ok(Array.isArray(received[before].body.messages));
		} finally {
			apiProtocol = 'responses';
		}
	});
});
