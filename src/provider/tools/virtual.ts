import vscode from 'vscode';
import type { MetaMessage, MetaToolCall } from '../../types';
import {
	ACTIVATE_TOOL_PREFIX,
	MAX_TOOL_DISCOVERY_ROUNDS,
	SOFT_TOOL_GROUP_MIN_SIZE,
	TOOL_CATALOG_GROUP_SAMPLE_SIZE,
	TOOL_CATALOG_MAX_CHARS,
	TOOL_LISTING_DESCRIPTION_CHARS,
	TOOL_LOADER_NAME,
	TOOL_QUERY_MATCH_LIMIT,
} from './consts';

/**
 * Provider-side tool virtualization.
 *
 * `ProvideLanguageModelChatResponseOptions.tools` is the set of tools *available* to the model.
 * Copilot's classic agent loop groups large sets into `activate_*` virtual tools and stays within
 * 128, but the Agent Host (Copilot SDK) BYOK bridge forwards its whole inventory (300+ tools) and
 * does not forward `capabilities.toolCalling`. Meta accepts at most 128 function definitions per
 * request, so when the available set exceeds the limit we send a deterministic subset plus one
 * provider-owned loader function. The loader is resolved inside the provider and never reaches the
 * host; every deferred tool stays discoverable by name, group, or keyword query.
 */

type Tool = vscode.LanguageModelChatTool;

export interface ToolGroupSummary {
	key: string;
	names: string[];
}

export interface ToolSetPlan {
	virtualized: boolean;
	limit: number;
	suppliedCount: number;
	activatorCount: number;
	/** Tools to convert and send to Meta. Never longer than `limit`. */
	tools: readonly Tool[] | undefined;
	/** Sent tools excluding the provider loader. */
	concreteCount: number;
	deferred: readonly Tool[];
	/** Effective loaded tool names, most recent first. */
	loaded: readonly string[];
	/** Reserved loader name; intercepted even on rounds where the loader is not offered. */
	loaderName?: string;
	loaderIncluded: boolean;
}

export interface PlanToolSetInput {
	tools: readonly Tool[] | undefined;
	limit: number;
	/** Previously loaded tool names, most recent first. */
	loaded?: readonly string[];
	/** Tool names already called in this conversation, most recent first. */
	used?: readonly string[];
	/** False on the final discovery round so the model has to answer with concrete tools. */
	includeLoader?: boolean;
}

export function planToolSet({
	tools,
	limit,
	loaded = [],
	used = [],
	includeLoader = true,
}: PlanToolSetInput): ToolSetPlan {
	const supplied = tools ?? [];
	const activatorCount = supplied.filter((tool) =>
		tool.name.startsWith(ACTIVATE_TOOL_PREFIX),
	).length;
	if (supplied.length <= limit) {
		return {
			virtualized: false,
			limit,
			suppliedCount: supplied.length,
			activatorCount,
			tools,
			concreteCount: supplied.length,
			deferred: [],
			loaded: [],
			loaderIncluded: false,
		};
	}

	const byName = new Map<string, Tool>();
	for (const tool of supplied) {
		if (!byName.has(tool.name)) {
			byName.set(tool.name, tool);
		}
	}
	const budget = Math.max(0, limit - 1);
	const selected = new Set<string>();
	const select = (name: string): void => {
		if (selected.size < budget && byName.has(name)) {
			selected.add(name);
		}
	};

	const effectiveLoaded = dedupeExisting(loaded, byName).slice(0, budget);
	effectiveLoaded.forEach(select);
	dedupeExisting(used, byName).forEach(select);

	const { groups, ungrouped } = groupTools([...byName.values()]);
	ungrouped.forEach((tool) => select(tool.name));
	const smallestFirst = [...groups].sort((a, b) => a.names.length - b.names.length);
	for (const group of smallestFirst) {
		const missing = group.names.filter((name) => !selected.has(name));
		if (selected.size + missing.length <= budget) {
			missing.forEach(select);
		}
	}

	const sent: Tool[] = [];
	const deferred: Tool[] = [];
	for (const tool of byName.values()) {
		(selected.has(tool.name) ? sent : deferred).push(tool);
	}

	const loaderName = createLoaderName(byName);
	const loader =
		includeLoader && deferred.length > 0
			? createLoaderTool(loaderName, supplied.length, limit, deferred)
			: undefined;
	return {
		virtualized: true,
		limit,
		suppliedCount: supplied.length,
		activatorCount,
		tools: loader ? [...sent, loader] : sent,
		concreteCount: sent.length,
		deferred,
		loaded: effectiveLoaded,
		loaderName,
		loaderIncluded: loader !== undefined,
	};
}

/**
 * Namespace key used to keep related tools together. Recognizes the Copilot Chat MCP convention
 * (`mcp_<server>_<tool>`), double-underscore namespaces (`a__b__tool`), the Copilot SDK MCP
 * convention (`<server>-<tool>`), and large shared `prefix_` families. Copilot `activate_*`
 * activators are never grouped.
 */
export function toolGroupKey(name: string): { key: string; strong: boolean } | undefined {
	if (name.startsWith(ACTIVATE_TOOL_PREFIX)) {
		// Copilot virtual-group activators stay individually selectable.
		return undefined;
	}
	const mcp = /^(mcp_[^_]+)_./.exec(name);
	if (mcp) {
		return { key: mcp[1], strong: true };
	}
	const dunder = name.lastIndexOf('__');
	if (dunder > 0 && dunder < name.length - 2) {
		return { key: name.slice(0, dunder), strong: true };
	}
	const dash = name.lastIndexOf('-');
	if (dash > 0 && dash < name.length - 1) {
		return { key: name.slice(0, dash), strong: true };
	}
	const underscore = name.indexOf('_');
	if (underscore > 0) {
		return { key: name.slice(0, underscore), strong: false };
	}
	return undefined;
}

export function groupTools(tools: readonly Tool[]): {
	groups: ToolGroupSummary[];
	ungrouped: Tool[];
} {
	const buckets = new Map<string, { strong: boolean; tools: Tool[] }>();
	const keys = new Map<string, string>();
	for (const tool of tools) {
		const groupKey = toolGroupKey(tool.name);
		if (!groupKey) {
			continue;
		}
		keys.set(tool.name, groupKey.key);
		const bucket = buckets.get(groupKey.key) ?? { strong: groupKey.strong, tools: [] };
		bucket.tools.push(tool);
		buckets.set(groupKey.key, bucket);
	}

	const groups: ToolGroupSummary[] = [];
	const grouped = new Set<string>();
	for (const [key, bucket] of buckets) {
		const minSize = bucket.strong ? 2 : SOFT_TOOL_GROUP_MIN_SIZE;
		if (bucket.tools.length < minSize) {
			continue;
		}
		groups.push({ key, names: bucket.tools.map((tool) => tool.name) });
		bucket.tools.forEach((tool) => grouped.add(tool.name));
	}
	return { groups, ungrouped: tools.filter((tool) => !grouped.has(tool.name)) };
}

export interface ToolLoadResult {
	/** Names newly requested for loading, in request order. */
	loadedNames: string[];
	/** Model-facing tool result text. */
	text: string;
}

/**
 * Resolves one loader call against the full supplied tool set. Accepts exact tool names, group
 * keys, and a keyword query. Never loads more than `capacity` tools.
 */
export function resolveToolLoad(
	tools: readonly Tool[],
	deferred: readonly Tool[],
	args: unknown,
	capacity: number,
): ToolLoadResult {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const deferredNames = new Set(deferred.map((tool) => tool.name));
	const { groups } = groupTools(tools);
	const groupByKey = new Map(groups.map((group) => [group.key, group]));
	const { names: requested, query } = parseLoaderArgs(args);

	const toLoad: string[] = [];
	const add = (name: string): void => {
		if (!toLoad.includes(name)) {
			toLoad.push(name);
		}
	};
	const alreadyAvailable: string[] = [];
	const notFound: string[] = [];
	const listings: string[] = [];

	for (const name of requested) {
		if (byName.has(name)) {
			if (deferredNames.has(name)) {
				add(name);
			} else {
				alreadyAvailable.push(name);
			}
			continue;
		}
		const group = groupByKey.get(name);
		if (!group) {
			notFound.push(name);
			continue;
		}
		const pending = group.names.filter((member) => deferredNames.has(member));
		if (pending.length <= capacity) {
			pending.forEach(add);
		} else {
			listings.push(formatGroupListing(group, byName));
		}
	}

	if (query) {
		for (const name of searchTools(deferred, query, TOOL_QUERY_MATCH_LIMIT)) {
			add(name);
		}
	}

	const loadedNames = toLoad.slice(0, capacity);
	const lines: string[] = [];
	if (loadedNames.length > 0) {
		lines.push(
			`Loaded ${loadedNames.length} tool(s); call them directly from your next step: ${loadedNames.join(', ')}.`,
		);
	}
	if (toLoad.length > loadedNames.length) {
		lines.push(
			`Only ${capacity} tools can be loaded at once; not loaded: ${toLoad.slice(capacity).join(', ')}.`,
		);
	}
	if (alreadyAvailable.length > 0) {
		lines.push(`Already available: ${alreadyAvailable.join(', ')}.`);
	}
	if (notFound.length > 0) {
		lines.push(`Unknown tool or group name(s): ${notFound.join(', ')}.`);
	}
	lines.push(...listings);
	if (loadedNames.length === 0 && listings.length === 0) {
		lines.push(
			query
				? `No deferred tools matched "${query}". Try broader keywords, a group name, or exact names from the catalog.`
				: 'No tools were loaded. Pass exact tool names or group names in "tools", or keywords in "query".',
		);
	}
	return { loadedNames, text: lines.join('\n') };
}

export function searchTools(tools: readonly Tool[], query: string, limit: number): string[] {
	const terms = tokenize(query);
	if (terms.length === 0) {
		return [];
	}
	const scored: Array<{ name: string; score: number; index: number }> = [];
	tools.forEach((tool, index) => {
		const nameTokens = new Set(tokenize(tool.name));
		const descriptionTokens = new Set(tokenize(tool.description ?? ''));
		let score = 0;
		for (const term of terms) {
			if (nameTokens.has(term)) {
				score += 3;
			} else if ([...nameTokens].some((token) => token.startsWith(term))) {
				score += 2;
			}
			if (descriptionTokens.has(term)) {
				score += 1;
			}
		}
		if (score > 0) {
			scored.push({ name: tool.name, score, index });
		}
	});
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	return scored.slice(0, limit).map((entry) => entry.name);
}

/** Tool names called by the assistant in this conversation, most recent first. */
export function collectUsedToolNames(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): string[] {
	const names: string[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const content = messages[index].content;
		for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = content[partIndex];
			if (part instanceof vscode.LanguageModelToolCallPart && !names.includes(part.name)) {
				names.push(part.name);
			}
		}
	}
	return names;
}

export interface ToolDiscoveryRoundSummary {
	emittedToolCalls: number;
	content: string;
	reasoning: string;
	isThinkingModel: boolean;
}

export interface ToolDiscoveryDiagnostics {
	virtualized: boolean;
	supplied: number;
	activators: number;
	sent: number;
	concrete: number;
	deferred: number;
	loaded: number;
	limit: number;
	round: number;
	loaderCalls?: number;
	newlyLoaded?: number;
	toolSetChanged?: boolean;
	continued?: boolean;
}

/**
 * Per-request discovery session. Captures loader calls from Meta's stream, applies the requested
 * loads, and produces the follow-up messages for an in-provider continuation round.
 */
export class ToolDiscoverySession {
	private plan: ToolSetPlan;
	private round = 0;
	private captured: Array<{ call: MetaToolCall; result: ToolLoadResult }> = [];
	private lastRound: Pick<
		ToolDiscoveryDiagnostics,
		'loaderCalls' | 'newlyLoaded' | 'toolSetChanged' | 'continued'
	> = {};

	constructor(
		private readonly suppliedTools: readonly Tool[] | undefined,
		private readonly limit: number,
		private loaded: string[],
		private readonly used: readonly string[],
		private readonly maxRounds = MAX_TOOL_DISCOVERY_ROUNDS,
	) {
		this.plan = this.computePlan();
	}

	get virtualized(): boolean {
		return this.plan.virtualized;
	}

	get tools(): readonly Tool[] | undefined {
		return this.plan.tools;
	}

	/** Returns true when the call targets the provider loader and must not reach the host. */
	captureToolCall(toolCall: MetaToolCall): boolean {
		if (!this.plan.virtualized || toolCall.function.name !== this.plan.loaderName) {
			return false;
		}
		// Resolve now so a replay marker written at end of stream already includes these loads.
		const pending = this.pendingLoadNames();
		const result = resolveToolLoad(
			this.suppliedTools ?? [],
			this.plan.deferred.filter((tool) => !pending.includes(tool.name)),
			parseArguments(toolCall.function.arguments),
			Math.max(1, this.limit - 1),
		);
		this.captured.push({ call: toolCall, result });
		return true;
	}

	/** Whether the current round ends in an internal continuation instead of a host-visible turn. */
	willContinue(emittedToolCalls: number): boolean {
		return this.captured.length > 0 && emittedToolCalls === 0 && this.round + 1 < this.maxRounds;
	}

	/**
	 * Applies loader calls captured in the current round. Returns the follow-up Meta messages when
	 * the provider should continue internally; otherwise loads persist via the replay marker.
	 */
	finishRound(summary: ToolDiscoveryRoundSummary): MetaMessage[] | undefined {
		const captured = this.captured;
		if (captured.length === 0) {
			this.lastRound = {};
			return undefined;
		}

		const continued = summary.emittedToolCalls === 0 && this.round + 1 < this.maxRounds;
		const before = this.sentNames();
		const newlyLoaded = this.pendingLoadNames();
		this.captured = [];
		this.loaded = mergeLoaded(newlyLoaded, this.loaded);
		if (continued) {
			this.round += 1;
		}
		this.plan = this.computePlan();
		const after = this.sentNames();
		this.lastRound = {
			loaderCalls: captured.length,
			newlyLoaded: newlyLoaded.length,
			toolSetChanged: before.length !== after.length || before.some((name, i) => name !== after[i]),
			continued,
		};
		if (!continued) {
			return undefined;
		}

		const assistant: MetaMessage = {
			role: 'assistant',
			content: summary.content,
			tool_calls: captured.map(({ call }) => call),
		};
		if (summary.isThinkingModel) {
			assistant.reasoning_content = summary.reasoning;
		}
		return [
			assistant,
			...captured.map(
				({ call, result }): MetaMessage => ({
					role: 'tool',
					content: result.text,
					tool_call_id: call.id,
				}),
			),
		];
	}

	/** Loaded names to persist in the replay marker, or undefined when nothing needs persisting. */
	loadedToolNames(): string[] | undefined {
		if (!this.plan.virtualized) {
			return undefined;
		}
		const names = mergeLoaded(this.pendingLoadNames(), this.plan.loaded).slice(
			0,
			Math.max(1, this.limit - 1),
		);
		return names.length > 0 ? names : undefined;
	}

	diagnostics(): ToolDiscoveryDiagnostics {
		return {
			virtualized: this.plan.virtualized,
			supplied: this.plan.suppliedCount,
			activators: this.plan.activatorCount,
			sent: this.plan.tools?.length ?? 0,
			concrete: this.plan.concreteCount,
			deferred: this.plan.deferred.length,
			loaded: this.plan.loaded.length,
			limit: this.limit,
			round: this.round,
			...this.lastRound,
		};
	}

	private pendingLoadNames(): string[] {
		return mergeLoaded(
			this.captured.flatMap(({ result }) => result.loadedNames),
			[],
		);
	}

	private computePlan(): ToolSetPlan {
		return planToolSet({
			tools: this.suppliedTools,
			limit: this.limit,
			loaded: this.loaded,
			used: this.used,
			includeLoader: this.round + 1 < this.maxRounds,
		});
	}

	private sentNames(): string[] {
		return (this.plan.tools ?? []).map((tool) => tool.name);
	}
}

/** Single-line, argument-free summary for the output channel. */
export function formatToolDiscoveryDiagnostics(diagnostics: ToolDiscoveryDiagnostics): string {
	let line =
		`[tool-virtualization] mode=${diagnostics.virtualized ? 'virtualized' : 'passthrough'}` +
		` supplied=${diagnostics.supplied}` +
		` activators=${diagnostics.activators}` +
		` sentFunctions=${diagnostics.sent}/${diagnostics.limit}` +
		` concrete=${diagnostics.concrete}` +
		` deferred=${diagnostics.deferred}` +
		` loaded=${diagnostics.loaded}` +
		` round=${diagnostics.round}`;
	if (diagnostics.loaderCalls !== undefined) {
		line +=
			` loaderCalls=${diagnostics.loaderCalls}` +
			` newlyLoaded=${diagnostics.newlyLoaded ?? 0}` +
			` toolSetChanged=${diagnostics.toolSetChanged === true}` +
			` continued=${diagnostics.continued === true}`;
	}
	return line;
}

function createLoaderTool(
	name: string,
	supplied: number,
	limit: number,
	deferred: readonly Tool[],
): Tool {
	return {
		name,
		description: [
			`Load additional tools before calling them. ${supplied} tools are available in this session but at most ${limit} function definitions fit in one request, so ${deferred.length} tools are deferred and cannot be called until loaded.`,
			'Pass exact tool names or group names in "tools", and/or keywords describing the capability you need in "query". Loaded tools become callable in your next step and stay available afterwards.',
			'Deferred tool catalog:',
			formatCatalog(deferred),
		].join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				tools: {
					type: 'array',
					items: { type: 'string' },
					description: 'Exact tool names or group names from the deferred tool catalog.',
				},
				query: {
					type: 'string',
					description: 'Keywords describing the capability you need, e.g. "schematic wire".',
				},
			},
		},
	};
}

function formatCatalog(deferred: readonly Tool[]): string {
	const { groups, ungrouped } = groupTools(deferred);
	const sections = [
		...groups.map((group) => ({
			label: `group "${group.key}" (${group.names.length} tools)`,
			names: group.names,
		})),
		...(ungrouped.length > 0
			? [
					{
						label: `ungrouped (${ungrouped.length} tools)`,
						names: ungrouped.map((tool) => tool.name),
					},
				]
			: []),
	];
	const full = sections
		.map((section) => `- ${section.label}: ${section.names.join(', ')}`)
		.join('\n');
	if (full.length <= TOOL_CATALOG_MAX_CHARS) {
		return full;
	}
	return sections
		.map((section) => {
			const sample = section.names.slice(0, TOOL_CATALOG_GROUP_SAMPLE_SIZE);
			const more = section.names.length - sample.length;
			return `- ${section.label}: ${sample.join(', ')}${more > 0 ? `, … ${more} more (use "query" or the group name to list them)` : ''}`;
		})
		.join('\n');
}

function formatGroupListing(group: ToolGroupSummary, byName: Map<string, Tool>): string {
	const entries = group.names.map((name) => {
		const description = (byName.get(name)?.description ?? '').replace(/\s+/g, ' ').trim();
		const short =
			description.length > TOOL_LISTING_DESCRIPTION_CHARS
				? `${description.slice(0, TOOL_LISTING_DESCRIPTION_CHARS - 1)}…`
				: description;
		return short ? `${name}: ${short}` : name;
	});
	return `Group "${group.key}" has ${group.names.length} tools, too many to load at once. Load the specific tools you need by exact name:\n${entries.join('\n')}`;
}

function createLoaderName(byName: Map<string, Tool>): string {
	let name = TOOL_LOADER_NAME;
	for (let suffix = 2; byName.has(name); suffix += 1) {
		name = `${TOOL_LOADER_NAME}_${suffix}`;
	}
	return name;
}

/** Newer names first, without duplicates. */
function mergeLoaded(newer: readonly string[], older: readonly string[]): string[] {
	return [...new Set([...newer, ...older])];
}

function dedupeExisting(names: readonly string[], byName: Map<string, Tool>): string[] {
	return [...new Set(names)].filter((name) => byName.has(name));
}

function parseLoaderArgs(args: unknown): { names: string[]; query: string } {
	const value = (args && typeof args === 'object' ? args : {}) as {
		tools?: unknown;
		query?: unknown;
	};
	const rawNames = Array.isArray(value.tools)
		? value.tools
		: typeof value.tools === 'string'
			? value.tools.split(',')
			: [];
	const names = rawNames
		.filter((name): name is string => typeof name === 'string')
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const query = typeof value.query === 'string' ? value.query.trim() : '';
	return { names: [...new Set(names)], query };
}

function parseArguments(argumentsJson: string): unknown {
	try {
		return JSON.parse(argumentsJson);
	} catch {
		return {};
	}
}

function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1);
}
