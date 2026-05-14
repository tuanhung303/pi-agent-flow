import { runFlow, type RunFlowOptions } from "./core/flow.js";
import type { SingleResult } from "./types/flow.js";

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
  run(options: RunFlowOptions): Promise<SingleResult>;
}

/** Default in-process runner that preserves existing forked child-process behavior. */
export class LocalFlowRunner implements FlowRunner {
  run(options: RunFlowOptions): Promise<SingleResult> {
    return runFlow(options);
  }
}
