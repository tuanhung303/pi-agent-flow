/** Declaration for runner-events.js */
export interface FlowResult {
	messages: any[];
	model?: string;
	stopReason?: string;
	exitCode?: number;
	stderr?: string;
	errorMessage?: string;
	usage?: any;
	sawAgentEnd?: boolean;
}

export function processFlowJsonLine(line: string, result: FlowResult): boolean;
export function drainStreamingText(result: FlowResult): string;
export function drainStreamingEstimate(result: FlowResult): number;
export function drainCtxEstimate(result: FlowResult): number;
export function updateSmoothedTps(result: FlowResult, estimatedTokens: number): void;
export function drainSmoothedTps(result: FlowResult): number;
export function getFlowFinalText(messages: any[]): string;
export function getFlowSummaryText(result?: FlowResult | null): string;
