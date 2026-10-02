/**
 * Deterministic regression tests for provider-side tool virtualization (DC-0003).
 *
 * The Agent Host (Copilot SDK) BYOK bridge hands the provider its full tool
 * inventory (332-383 tools observed) while Meta accepts at most 128 function
 * definitions per request. These tests prove the outbound tool list never
 * exceeds the limit, nothing is silently truncated, and deferred tools stay
 * discoverable. Runs against compiled `out/` with an LM-capable vscode stub.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { join } = require('node:path');

const vscode = require('./vscode-lm-stub.cjs');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'vscode') {
		return join(__dirname, 'vscode-lm-stub.cjs');
	}
	return originalResolve.call(this, request, ...rest);
};

const {
	planToolSet,
	toolGroupKey,
	groupTools,
	resolveToolLoad,
	searchTools,
	collectUsedToolNames,
	ToolDiscoverySession,
	formatToolDiscoveryDiagnostics,
} = require('../out/provider/tools/virtual.js');
const { prepareRequestTools, getToolCallingLimit } = require('../out/provider/tools/request.js');
const { convertTools } = require('../out/provider/convert.js');
const {
	createReplayMarkerPart,
	findLatestLoadedTools,
	parseReplayMarkerData,
} = require('../out/provider/replay/index.js');
const { META_TOOLS_LIMIT, TOOL_LOADER_NAME, MAX_TOOL_DISCOVERY_ROUNDS } = require('../out/provider/tools/consts.js');
const { sumMetaUsage, splitUsageTokens } = require('../out/usage/pricing.js');
const { MODELS } = require('../out/consts.js');

const LIMIT = META_TOOLS_LIMIT;

function tool(name, description = `${name.replace(/[-_]/g, ' ')} tool`) {
	return {
		name,
		description,
		inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
	};
}

function range(count, make) {
	return Array.from({ length: count }, (_, index) => make(index));
}

/** Standalone built-in / extension tools (no namespace). */
function builtins(count) {
	return range(count, (i) => tool(`builtin${i}`));
}

/** Copilot SDK MCP naming: `<server>-<tool>`. */
function sdkMcp(server, count, verbs = ['get', 'list', 'add', 'delete', 'edit']) {
	return range(count, (i) => tool(`${server}-${verbs[i % verbs.length]}_item_${i}`, `${server} ${verbs[i % verbs.length]} operation ${i}`));
}

/**
 * Simulated Agent Host population of exactly 379 tools: Copilot SDK built-ins,
 * VS Code client tools, GitHub MCP, Konnect, ELI, ECI, and FreeCAD MCP.
 */
function agentHostPopulation() {
	const tools = [
		...['bash', 'powershell', 'view', 'edit', 'create', 'grep', 'glob', 'web_fetch', 'task', 'report_intent', 'ask_user', 'update_todo', 'read_agent'].map((n) => tool(n)),
		...range(27, (i) => tool(`copilot_clientTool${i}`)),
		...sdkMcp('github-mcp-server', 46),
		...range(200, (i) => tool(`konnect-${['add_schematic_wire', 'route_trace', 'run_drc', 'export_gerber', 'get_net'][i % 5]}_${i}`, `KiCad ${['schematic wire', 'pcb trace routing', 'design rule check', 'manufacturing gerber export', 'net connectivity'][i % 5]} ${i}`)),
		...range(43, (i) => tool(`eli-eli_op_${i}`, `ENAX library intelligence operation ${i}`)),
		...range(9, (i) => tool(`eci-eci_op_${i}`, `ENAX component intelligence operation ${i}`)),
		...range(41, (i) => tool(`freecad-cad_op_${i}`, `FreeCAD modeling operation ${i}`)),
	];
	assert.equal(tools.length, 379);
	return tools;
}

function names(tools) {
	return (tools ?? []).map((t) => t.name);
}

function metaFunctionCount(tools) {
	return convertTools(tools)?.length ?? 0;
}

function loaderCall(id, args) {
	return { id, type: 'function', function: { name: TOOL_LOADER_NAME, arguments: JSON.stringify(args) } };
}

describe('tool set planning (passthrough vs virtualization)', () => {
	it('fewer than 128 tools pass through unchanged (same array, no loader)', () => {
		const tools = builtins(40);
		const plan = planToolSet({ tools, limit: LIMIT });
		assert.equal(plan.virtualized, false);
		assert.equal(plan.tools, tools);
		assert.equal(plan.deferred.length, 0);
		assert.ok(!names(plan.tools).includes(TOOL_LOADER_NAME));
	});

	it('exactly 128 tools pass through unchanged', () => {
		const tools = [...builtins(28), ...sdkMcp('konnect', 100)];
		const plan = planToolSet({ tools, limit: LIMIT });
		assert.equal(plan.virtualized, false);
		assert.equal(plan.tools.length, 128);
		assert.equal(metaFunctionCount(plan.tools), 128);
	});

	it('129 tools virtualize to at most 128 functions with the loader included', () => {
		const tools = [...builtins(29), ...sdkMcp('konnect', 100)];
		const plan = planToolSet({ tools, limit: LIMIT });
		assert.equal(plan.virtualized, true);
		assert.ok(plan.tools.length <= LIMIT);
		assert.ok(names(plan.tools).includes(TOOL_LOADER_NAME));
		assert.equal(plan.concreteCount + plan.deferred.length, 129);
	});

	it('379-tool Agent Host population: ≤128 functions, every tool sent or deferred', () => {
		const tools = agentHostPopulation();
		const plan = planToolSet({ tools, limit: LIMIT });
		assert.equal(plan.virtualized, true);
		assert.equal(plan.suppliedCount, 379);
		assert.ok(metaFunctionCount(plan.tools) <= LIMIT);
		const sent = new Set(names(plan.tools).filter((n) => n !== TOOL_LOADER_NAME));
		const deferred = new Set(names(plan.deferred));
		for (const t of tools) {
			assert.ok(sent.has(t.name) !== deferred.has(t.name), `${t.name} must be exactly one of sent/deferred`);
		}
		// Built-in agent tools stay eagerly callable.
		for (const core of ['bash', 'view', 'edit', 'grep', 'copilot_clientTool0']) {
			assert.ok(sent.has(core), `${core} should be eager`);
		}
		// Whole MCP groups are deferred together rather than split arbitrarily.
		assert.ok(names(plan.deferred).some((n) => n.startsWith('konnect-')));
		assert.ok(!names(plan.tools).some((n) => n.startsWith('konnect-')));
	});

	it('no MCP tools: 200 standalone tools virtualize and stay loadable by name', () => {
		const tools = builtins(200);
		const plan = planToolSet({ tools, limit: LIMIT });
		assert.equal(plan.virtualized, true);
		assert.equal(plan.concreteCount, LIMIT - 1);
		assert.equal(plan.deferred.length, 200 - (LIMIT - 1));
		const result = resolveToolLoad(tools, plan.deferred, { tools: ['builtin199'] }, LIMIT - 1);
		assert.deepEqual(result.loadedNames, ['builtin199']);
	});

	it('one MCP group: built-ins eager, the oversized group deferred as a unit', () => {
		const tools = [...builtins(60), ...sdkMcp('konnect', 250)];
		const plan = planToolSet({ tools, limit: LIMIT });
		assert.deepEqual(names(plan.tools).filter((n) => n.startsWith('builtin')).length, 60);
		assert.equal(plan.deferred.length, 250);
		assert.ok(plan.deferred.every((t) => t.name.startsWith('konnect-')));
	});

	it('small groups that fit are kept whole', () => {
		const tools = [...builtins(100), ...sdkMcp('eci', 9), ...sdkMcp('konnect', 200)];
		const plan = planToolSet({ tools, limit: LIMIT });
		assert.equal(names(plan.tools).filter((n) => n.startsWith('eci-')).length, 9);
	});

	it('Copilot activate_* virtual tools are counted and never deferred as a group', () => {
		const activators = range(20, (i) => tool(`activate_group_${i}`));
		const small = planToolSet({ tools: [...builtins(10), ...activators], limit: LIMIT });
		assert.equal(small.virtualized, false);
		assert.equal(small.activatorCount, 20);
		assert.equal(toolGroupKey('activate_group_1'), undefined);
		const large = planToolSet({ tools: [...activators, ...sdkMcp('konnect', 200)], limit: LIMIT });
		assert.equal(large.activatorCount, 20);
		assert.equal(names(large.tools).filter((n) => n.startsWith('activate_')).length, 20);
	});

	it('previously loaded and used tools are prioritized, still within the limit', () => {
		const tools = agentHostPopulation();
		const loaded = ['konnect-route_trace_1', 'freecad-cad_op_3'];
		const used = ['eli-eli_op_7'];
		const plan = planToolSet({ tools, limit: LIMIT, loaded, used });
		for (const name of [...loaded, ...used]) {
			assert.ok(names(plan.tools).includes(name), `${name} should be sent`);
		}
		assert.ok(plan.tools.length <= LIMIT);
		assert.deepEqual(plan.loaded, loaded);
	});

	it('the outbound function count never exceeds 128 for any population or loaded set', () => {
		const population = agentHostPopulation();
		for (const size of [0, 1, 50, 127, 128, 129, 200, 300, 379, 1000]) {
			const tools = size <= population.length ? population.slice(0, size) : [...population, ...builtins(size - population.length)];
			for (const loaded of [[], names(tools).slice(0, 10), names(tools).reverse()]) {
				for (const includeLoader of [true, false]) {
					const plan = planToolSet({ tools, limit: LIMIT, loaded, used: names(tools).slice(5, 400), includeLoader });
					const count = metaFunctionCount(plan.tools);
					assert.ok(count <= LIMIT, `size=${size} loaded=${loaded.length} -> ${count}`);
					assert.doesNotThrow(() => prepareRequestTools(LIMIT, plan.tools));
				}
			}
		}
	});

	it('the loader name avoids collisions with supplied tools', () => {
		const tools = [tool(TOOL_LOADER_NAME), ...builtins(200)];
		const plan = planToolSet({ tools, limit: LIMIT });
		assert.equal(plan.loaderName, `${TOOL_LOADER_NAME}_2`);
		assert.equal(names(plan.tools).filter((n) => n.startsWith(TOOL_LOADER_NAME)).length, 2);
	});

	it('every Muse model still advertises the 128 tool limit to VS Code', () => {
		for (const model of MODELS) {
			assert.equal(model.capabilities.toolCalling, LIMIT);
			assert.equal(getToolCallingLimit(model.capabilities.toolCalling), LIMIT);
		}
	});
});

describe('no silent truncation', () => {
	it('prepareRequestTools refuses an unplanned list above the limit instead of slicing it', () => {
		assert.throws(() => prepareRequestTools(LIMIT, agentHostPopulation()), /at most 128 functions/);
		assert.throws(() => prepareRequestTools(LIMIT, builtins(129)), /got 129/);
	});

	it('the loader catalog accounts for every deferred tool', () => {
		const tools = [...builtins(100), ...sdkMcp('konnect', 60)];
		const plan = planToolSet({ tools, limit: LIMIT });
		const loader = plan.tools.find((t) => t.name === TOOL_LOADER_NAME);
		for (const deferred of plan.deferred) {
			assert.ok(loader.description.includes(deferred.name), `${deferred.name} missing from catalog`);
		}
	});

	it('a large catalog summarizes by group with exact counts', () => {
		const plan = planToolSet({ tools: agentHostPopulation(), limit: LIMIT });
		const loader = plan.tools.find((t) => t.name === TOOL_LOADER_NAME);
		const { groups, ungrouped } = groupTools(plan.deferred);
		const counted = groups.reduce((sum, g) => sum + g.names.length, 0) + ungrouped.length;
		assert.equal(counted, plan.deferred.length);
		for (const group of groups) {
			assert.ok(loader.description.includes(`group "${group.key}" (${group.names.length} tools)`));
		}
		assert.ok(loader.description.includes(`${plan.deferred.length} tools are deferred`));
	});
});

describe('tool grouping and search', () => {
	it('recognizes MCP naming conventions', () => {
		assert.deepEqual(toolGroupKey('mcp_konnect_add_wire'), { key: 'mcp_konnect', strong: true });
		assert.deepEqual(toolGroupKey('mcp__konnect__add_wire'), { key: 'mcp__konnect', strong: true });
		assert.deepEqual(toolGroupKey('github-mcp-server-list_issues'), { key: 'github-mcp-server', strong: true });
		assert.deepEqual(toolGroupKey('eli_block_get'), { key: 'eli', strong: false });
		assert.equal(toolGroupKey('bash'), undefined);
	});

	it('soft prefix families only group when large', () => {
		const { groups, ungrouped } = groupTools([tool('get_errors'), tool('get_changed_files'), ...range(8, (i) => tool(`eli_op${i}`))]);
		assert.deepEqual(groups.map((g) => g.key), ['eli']);
		assert.deepEqual(names(ungrouped), ['get_errors', 'get_changed_files']);
	});

	it('keyword search ranks name matches first and is deterministic', () => {
		const tools = agentHostPopulation();
		const first = searchTools(tools, 'schematic wire', 5);
		assert.equal(first.length, 5);
		assert.ok(first.every((n) => n.startsWith('konnect-add_schematic_wire')));
		assert.deepEqual(searchTools(tools, 'schematic wire', 5), first);
		assert.deepEqual(searchTools(tools, '', 5), []);
	});
});

describe('loader resolution', () => {
	const tools = [...builtins(100), ...sdkMcp('freecad', 20), ...sdkMcp('konnect', 200)];
	const plan = planToolSet({ tools, limit: LIMIT });

	it('expands a whole group that fits', () => {
		const result = resolveToolLoad(tools, plan.deferred, { tools: ['freecad'] }, LIMIT - 1);
		const freecad = names(tools).filter((n) => n.startsWith('freecad-'));
		const deferredFreecad = freecad.filter((n) => names(plan.deferred).includes(n));
		assert.deepEqual(result.loadedNames, deferredFreecad);
	});

	it('lists an oversized group instead of truncating it', () => {
		const result = resolveToolLoad(tools, plan.deferred, { tools: ['konnect'] }, LIMIT - 1);
		assert.deepEqual(result.loadedNames, []);
		assert.match(result.text, /Group "konnect" has 200 tools, too many to load at once/);
		assert.ok(result.text.includes('konnect-list_item_1'));
	});

	it('reports unknown names, already-available tools, and capacity overflow', () => {
		const result = resolveToolLoad(tools, plan.deferred, { tools: ['nope', 'builtin0', 'konnect-get_item_0', 'konnect-get_item_5'] }, 1);
		assert.deepEqual(result.loadedNames, ['konnect-get_item_0']);
		assert.match(result.text, /Unknown tool or group name\(s\): nope/);
		assert.match(result.text, /Already available: builtin0/);
		assert.match(result.text, /not loaded: konnect-get_item_5/);
	});

	it('tolerates malformed arguments', () => {
		assert.deepEqual(resolveToolLoad(tools, plan.deferred, null, LIMIT - 1).loadedNames, []);
		assert.deepEqual(resolveToolLoad(tools, plan.deferred, { tools: 'konnect-get_item_0, konnect-get_item_5' }, LIMIT - 1).loadedNames, ['konnect-get_item_0', 'konnect-get_item_5']);
	});
});

describe('discovery session (simulated Meta rounds)', () => {
	function sentFunctionCount(session) {
		return prepareRequestTools(LIMIT, session.tools)?.length ?? 0;
	}

	it('large mixed environment: loader round expands the tool set and then a real tool call reaches the host', () => {
		const tools = agentHostPopulation();
		const session = new ToolDiscoverySession(tools, LIMIT, [], []);
		const outbound = [sentFunctionCount(session)];
		assert.equal(session.virtualized, true);
		assert.ok(!names(session.tools).includes('konnect-add_schematic_wire_0'));

		// Round 1: Meta only asks to load tools.
		const call = loaderCall('call_1', { query: 'schematic wire' });
		assert.equal(session.captureToolCall(call), true, 'loader call is provider-internal');
		assert.equal(session.willContinue(0), true);
		const followUp = session.finishRound({ emittedToolCalls: 0, content: 'Looking up tools.', reasoning: 'need wire tool', isThinkingModel: true });
		assert.equal(followUp.length, 2);
		assert.deepEqual(followUp[0], { role: 'assistant', content: 'Looking up tools.', tool_calls: [call], reasoning_content: 'need wire tool' });
		assert.equal(followUp[1].role, 'tool');
		assert.equal(followUp[1].tool_call_id, 'call_1');
		assert.match(followUp[1].content, /Loaded \d+ tool\(s\)/);
		const diagnostics = session.diagnostics();
		assert.equal(diagnostics.toolSetChanged, true);
		assert.equal(diagnostics.continued, true);
		assert.ok(diagnostics.newlyLoaded > 0);

		// Round 2: expanded set includes the loaded tools and stays within the limit.
		outbound.push(sentFunctionCount(session));
		assert.ok(names(session.tools).includes('konnect-add_schematic_wire_0'));
		const realCall = { id: 'call_2', type: 'function', function: { name: 'konnect-add_schematic_wire_0', arguments: '{}' } };
		assert.equal(session.captureToolCall(realCall), false, 'real tool calls go to the host');
		assert.equal(session.finishRound({ emittedToolCalls: 1, content: '', reasoning: '', isThinkingModel: true }), undefined);
		assert.ok(session.loadedToolNames().includes('konnect-add_schematic_wire_0'));
		assert.ok(outbound.every((count) => count <= LIMIT), `outbound counts ${outbound}`);
	});

	it('loads requested alongside real tool calls persist without an internal round', () => {
		const session = new ToolDiscoverySession(agentHostPopulation(), LIMIT, [], []);
		assert.ok(!names(session.tools).includes('konnect-run_drc_2'));
		session.captureToolCall(loaderCall('call_1', { tools: ['konnect-run_drc_2'] }));
		// The replay marker is written at end of stream, before finishRound runs.
		assert.deepEqual(session.loadedToolNames(), ['konnect-run_drc_2']);
		assert.equal(session.willContinue(1), false);
		assert.equal(session.finishRound({ emittedToolCalls: 1, content: '', reasoning: '', isThinkingModel: false }), undefined);
		assert.equal(session.diagnostics().continued, false);
		// Available on the next provider call via the replay marker.
		assert.deepEqual(session.loadedToolNames(), ['konnect-run_drc_2']);
		assert.ok(names(session.tools).includes('konnect-run_drc_2'));
	});

	it('stops offering the loader on the final round but still intercepts it', () => {
		const session = new ToolDiscoverySession(agentHostPopulation(), LIMIT, [], []);
		for (let round = 1; round < MAX_TOOL_DISCOVERY_ROUNDS; round += 1) {
			assert.ok(names(session.tools).includes(TOOL_LOADER_NAME));
			session.captureToolCall(loaderCall(`call_${round}`, { query: `operation ${round}` }));
			assert.ok(session.finishRound({ emittedToolCalls: 0, content: '', reasoning: '', isThinkingModel: false }));
			assert.ok(sentFunctionCount(session) <= LIMIT);
		}
		assert.ok(!names(session.tools).includes(TOOL_LOADER_NAME));
		assert.equal(session.captureToolCall(loaderCall('late', { query: 'x' })), true);
		assert.equal(session.willContinue(0), false);
		assert.equal(session.finishRound({ emittedToolCalls: 0, content: '', reasoning: '', isThinkingModel: false }), undefined);
	});

	it('passthrough sessions never intercept and persist nothing', () => {
		const session = new ToolDiscoverySession(builtins(20), LIMIT, ['builtin1'], []);
		assert.equal(session.virtualized, false);
		assert.equal(session.captureToolCall(loaderCall('call_1', { query: 'x' })), false);
		assert.equal(session.loadedToolNames(), undefined);
		assert.equal(session.finishRound({ emittedToolCalls: 0, content: '', reasoning: '', isThinkingModel: false }), undefined);
	});

	it('diagnostics report counts without tool arguments', () => {
		const session = new ToolDiscoverySession(agentHostPopulation(), LIMIT, [], []);
		session.captureToolCall(loaderCall('call_1', { query: 'SECRET-TOKEN-123 schematic' }));
		session.finishRound({ emittedToolCalls: 0, content: '', reasoning: '', isThinkingModel: false });
		const line = formatToolDiscoveryDiagnostics(session.diagnostics());
		assert.match(line, /mode=virtualized supplied=379 activators=0 sentFunctions=\d+\/128/);
		assert.match(line, /loaderCalls=1 newlyLoaded=\d+ toolSetChanged=true continued=true/);
		assert.ok(!line.includes('SECRET'));
	});
});

describe('loaded tool persistence across turns', () => {
	function assistantWithMarker(loadedTools) {
		return {
			role: vscode.LanguageModelChatMessageRole.Assistant,
			content: [new vscode.LanguageModelTextPart('ok'), createReplayMarkerPart({ loadedTools }, 'muse-spark-1.3')],
		};
	}

	it('round-trips loaded tools through the replay marker and keeps the latest set', () => {
		const messages = [
			assistantWithMarker(['konnect-route_trace_1']),
			{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('next')] },
			assistantWithMarker(['freecad-cad_op_2', 'konnect-route_trace_1']),
		];
		assert.deepEqual(findLatestLoadedTools(messages), ['freecad-cad_op_2', 'konnect-route_trace_1']);
		const session = new ToolDiscoverySession(agentHostPopulation(), LIMIT, findLatestLoadedTools(messages), []);
		assert.ok(names(session.tools).includes('freecad-cad_op_2'));
		assert.ok(names(session.tools).includes('konnect-route_trace_1'));
	});

	it('ignores malformed loaded-tool entries and markers without tools', () => {
		const part = createReplayMarkerPart({ loadedTools: ['ok_tool', 'bad name with spaces'] }, 'muse-spark-1.3');
		assert.deepEqual(parseReplayMarkerData(part.data).loadedTools, ['ok_tool']);
		const plain = createReplayMarkerPart({ reasoningText: 'r' }, 'muse-spark-1.3');
		assert.equal(parseReplayMarkerData(plain.data).loadedTools, undefined);
		assert.deepEqual(findLatestLoadedTools([]), []);
	});

	it('collects tools already called in history, most recent first', () => {
		const messages = [
			{ role: 2, content: [new vscode.LanguageModelToolCallPart('a', 'view', {})] },
			{ role: 1, content: [new vscode.LanguageModelToolResultPart('a', [])] },
			{ role: 2, content: [new vscode.LanguageModelToolCallPart('b', 'konnect-run_drc_2', {}), new vscode.LanguageModelToolCallPart('c', 'view', {})] },
		];
		assert.deepEqual(collectUsedToolNames(messages), ['view', 'konnect-run_drc_2']);
	});
});

describe('usage across discovery rounds', () => {
	it('sums every round so the provider call is billed once and completely', () => {
		const total = sumMetaUsage(
			{ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 20 } },
			{ prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 900 } },
		);
		const tokens = splitUsageTokens(total);
		assert.equal(tokens.promptTokens, 2200);
		assert.equal(tokens.cachedTokens, 1300);
		assert.equal(tokens.uncachedTokens, 900);
		assert.equal(tokens.completionTokens, 130);
		assert.equal(tokens.reasoningTokens, 20);
		assert.equal(tokens.totalTokens, 2330);
	});
});
