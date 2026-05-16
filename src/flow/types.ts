/**
 * Flow goal types — autonomous continuation state for multi-step goals.
 */

export type GoalStatus = "active" | "paused" | "budget_limited" | "completed" | "abandoned";

export interface GoalEntry {
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
  status: GoalStatus;
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
  /** Session ID that owns this goal. */
  sessionId?: string;
}

export interface WarpEntry {
  id: string;
  parentSession: string;
  goal: string;
  createdAt: string;
  depth: number;
}

export interface GoalState {
  /** Currently active goal, if any. */
  current?: GoalEntry;
  /** Previously completed or abandoned goals. */
  history: GoalEntry[];
  /** Recorded session warps. */
  warps?: WarpEntry[];
}

export interface GoalContext {
  objective?: string;
  acceptance?: string;
  flowCount?: number;
  maxFlows?: number;
}
