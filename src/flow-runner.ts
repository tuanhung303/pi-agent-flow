import { runFlow, type RunFlowOptions } from "./core/flow.js";
import { HatchetFlowRunner } from "./hatchet-runner.js";
import type { SingleResult } from "./types/flow.js";

/**
 * Context supplied by the parent executor when dispatching a flow attempt.
 * `projectFlowsDir` is the discovered project-local flow directory, or null when none exists.
 */
export interface FlowRunContext {
  /** Project-local flow directory discovered by the parent process, or null when unavailable. */
  projectFlowsDir: string | null;
  /** Session ID of the current Pi session, for Hatchet run registry. */
  sessionId?: string;
  /** Goal ID of the active goal, for idempotent completion tracking. */
  goalId?: string;
  /** Tool call ID from the executor, for stable deduplication. */
  toolCallId?: string;
  /** Index of this flow param in the batch (0-based). */
  paramIndex?: number;
  /** Attempt/failover index for this flow param (0-based). */
  attemptIndex?: number;
}

/**
 * Execution backend for a single resolved flow attempt.
 *
 * Implementations must propagate depth guards (PI_FLOW_DEPTH,
 * PI_FLOW_MAX_DEPTH, PI_FLOW_STACK, PI_FLOW_PREVENT_CYCLES) and timeout
 * deadline environment variables (PI_FLOW_DEADLINE_MS,
 * PI_FLOW_TOOL_SUMMARY_GRACE_MS) to child processes. LocalFlowRunner is the
 * canonical implementation and preserves this propagation contract by
 * delegating to runFlow.
 */
export interface FlowRunner {
  /**
   * Executes one resolved flow attempt.
   * @param options Complete runFlow-compatible options for the attempt.
   * @param context Optional parent executor context that runners may serialize or ignore.
   * @returns The final single-flow result.
   */
  run(options: RunFlowOptions, context?: FlowRunContext): Promise<SingleResult>;
}

/** Default in-process runner that preserves existing forked child-process behavior. */
export class LocalFlowRunner implements FlowRunner {
  /**
   * Delegates directly to runFlow without queue serialization.
   * @param options Complete runFlow-compatible options for the attempt.
   * @returns The final single-flow result.
   */
  run(options: RunFlowOptions): Promise<SingleResult> {
    return runFlow(options);
  }
}

/** Environment variable used to select the flow runner backend. */
export const PI_FLOW_RUNNER_ENV = "PI_FLOW_RUNNER";
/** Shared local runner instance used when no alternate backend is requested. */
export const DEFAULT_LOCAL_FLOW_RUNNER = new LocalFlowRunner();

/**
 * Creates a flow runner from environment configuration.
 * @param env Environment map to inspect; reads PI_FLOW_RUNNER and defaults to process.env.
 * @returns Hatchet runner for "hatchet", otherwise the shared local runner; unknown values warn and fall back.
 */
export function createFlowRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): FlowRunner {
  const requested = env[PI_FLOW_RUNNER_ENV]?.trim().toLowerCase();
  if (!requested || requested === "local") return DEFAULT_LOCAL_FLOW_RUNNER;
  if (requested === "hatchet") return new HatchetFlowRunner();
  console.warn(`[pi-agent-flow] Ignoring unknown ${PI_FLOW_RUNNER_ENV}="${requested}". Using local runner.`);
  return DEFAULT_LOCAL_FLOW_RUNNER;
}
