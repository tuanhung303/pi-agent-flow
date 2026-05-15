/**
 * Flow goal types — autonomous continuation state for multi-step goals.
 */

export type FlowGoalStatus = "active" | "paused" | "completed" | "abandoned";

export interface FlowGoalEntry {
  /** Unique goal identifier (timestamp-based). */
  id: string;
  /** Human-readable objective. */
  objective: string;
  /** Optional acceptance criteria. */
  acceptance?: string;
  /** ISO timestamp when the goal was created. */
  createdAt: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
  /** Current lifecycle status. */
  status: FlowGoalStatus;
  /** Flows that have been executed toward this goal. */
  completedFlows: Array<{
    type: string;
    intent: string;
    aim: string;
    completedAt: string;
  }>;
  /** Cumulative token usage across all completed flows. */
  totalTokens: number;
  /** Optional token budget. */
  maxTokens?: number;
  /** Optional maximum number of flows. */
  maxFlows?: number;
}

export interface FlowGoalState {
  /** Currently active goal, if any. */
  current?: FlowGoalEntry;
  /** Previously completed or abandoned goals. */
  history: FlowGoalEntry[];
}

export interface GoalContext {
  objective?: string;
  acceptance?: string;
  flowCount?: number;
  maxFlows?: number;
}

