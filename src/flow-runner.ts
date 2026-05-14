import { runFlow, type RunFlowOptions } from "./flow.js";
import type { SingleResult } from "./types.js";

/** Execution backend for a single resolved flow attempt. */
export interface FlowRunner {
  run(options: RunFlowOptions): Promise<SingleResult>;
}

/** Default in-process runner that preserves existing forked child-process behavior. */
export class LocalFlowRunner implements FlowRunner {
  run(options: RunFlowOptions): Promise<SingleResult> {
    return runFlow(options);
  }
}
