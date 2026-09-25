import { createHash } from 'node:crypto';
import type { CostBreakdown, ResolvedPricing } from './types';
import type { ModelDefinition, MetaUsage } from '../types';

export interface UsageTokens {
	promptTokens: number;
	cachedTokens: number;
	uncachedTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	totalTokens: number;
}

/**
 * Pure cost math. Reasoning tokens are a breakdown of completion tokens and
 * are never billed separately.
 */
export function splitUsageTokens(usage: MetaUsage): UsageTokens {
	const promptTokens = Math.max(0, Math.floor(usage.prompt_tokens ?? 0));
	const completionTokens = Math.max(0, Math.floor(usage.completion_tokens ?? 0));
	const totalTokens = Math.max(
		0,
		Math.floor(usage.total_tokens ?? promptTokens + completionTokens),
	);
	const cachedTokens = Math.max(
		0,
		Math.floor(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0),
	);
	const explicitMiss = usage.prompt_cache_miss_tokens;
	const uncachedTokens =
		typeof explicitMiss === 'number'
			? Math.max(0, Math.floor(explicitMiss))
			: Math.max(promptTokens - cachedTokens, 0);
	const reasoningTokens = Math.max(
		0,
		Math.floor(usage.completion_tokens_details?.reasoning_tokens ?? 0),
	);
	return {
		promptTokens,
		cachedTokens,
		uncachedTokens,
		completionTokens,
		reasoningTokens,
		totalTokens,
	};
}

export function resolvePricing(input: {
	vscodeModelId: string;
	apiModelId?: string;
	models: readonly ModelDefinition[];
}): ResolvedPricing {
	const model = input.models.find((m) => m.id === input.vscodeModelId);
	const pricing = model?.pricing?.USD;
	if (!pricing) {
		return {
			inputRate: 0,
			cachedRate: 0,
			outputRate: 0,
			pricingModelId: null,
			source: 'missing',
			uncertain: true,
		};
	}
	const anyPricing = pricing as unknown as Record<string, number | undefined>;
	const inputRate = Number(anyPricing.input ?? anyPricing.cacheMissInput ?? 0);
	const cachedRate = Number(anyPricing.cachedInput ?? anyPricing.cacheHitInput ?? 0);
	const outputRate = Number(anyPricing.output ?? 0);
	const apiDiffers =
		Boolean(input.apiModelId) &&
		input.apiModelId !== input.vscodeModelId &&
		!isKnownAlias(input.vscodeModelId, input.apiModelId ?? '');
	return {
		inputRate,
		cachedRate,
		outputRate,
		pricingModelId: model?.id ?? null,
		source: `MODELS:${model?.id ?? 'unknown'}`,
		uncertain: apiDiffers,
	};
}

function isKnownAlias(vscodeModelId: string, apiModelId: string): boolean {
	// Model-ID overrides commonly rewrite the wire ID while the catalog rate
	// still applies. Treat identical-after-trim or prefix-stable IDs as known.
	if (vscodeModelId.trim() === apiModelId.trim()) {
		return true;
	}
	return false;
}

export function calculateCost(tokens: UsageTokens, pricing: ResolvedPricing): CostBreakdown {
	const uncachedCost = (tokens.uncachedTokens / 1_000_000) * pricing.inputRate;
	const cachedCost = (tokens.cachedTokens / 1_000_000) * pricing.cachedRate;
	const outputCost = (tokens.completionTokens / 1_000_000) * pricing.outputRate;
	return {
		uncachedTokens: tokens.uncachedTokens,
		cachedTokens: tokens.cachedTokens,
		completionTokens: tokens.completionTokens,
		uncachedCost,
		cachedCost,
		outputCost,
		total: uncachedCost + cachedCost + outputCost,
	};
}

export function formatUsd(value: number): string {
	return `$${value.toFixed(6)}`;
}

export function pricingFingerprint(pricing: ResolvedPricing): string {
	return createHash('sha256')
		.update(
			`${pricing.inputRate}|${pricing.cachedRate}|${pricing.outputRate}|${pricing.pricingModelId ?? ''}`,
		)
		.digest('hex')
		.slice(0, 16);
}
