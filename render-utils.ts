/**
 * Pure utility functions for rendering — extracted for testability.
 */

import type { UsageStats } from "./types.js";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatFlowUsage(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.toolCalls && usage.toolCalls > 0) parts.push(`${usage.toolCalls} calls`);
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`CR:${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`CW:${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatCompactStats(usage: Partial<UsageStats>, model?: string): string {
	const io: string[] = [];
	if (usage.input) io.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) io.push(`↓${formatTokens(usage.output)}`);
	const meta: string[] = [];
	if (usage.cacheRead) meta.push(`CR:${formatTokens(usage.cacheRead)}`);
	if (usage.contextTokens && usage.contextTokens > 0) meta.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) meta.push(model);
	const parts: string[] = [];
	if (io.length) parts.push(io.join(" "));
	if (meta.length) parts.push(meta.join(" "));
	return parts.join(" │ ");
}

export function truncateChars(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.ceil(max * 0.6);
	const tail = max - head - 3;
	return text.slice(0, head) + " ... " + text.slice(-tail);
}

export function tailText(text: string, max: number): string {
	const flat = text.replace(/[\n\r\t]+/g, " ").replace(/ +/g, " ").trim();
	if (flat.length <= max) return flat;
	return flat.slice(-max);
}
