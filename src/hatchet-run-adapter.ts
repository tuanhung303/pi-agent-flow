/**
 * Hatchet run adapter abstraction.
 *
 * Decouples HatchetFlowRunner from the live SDK so tests can use fake adapters.
 * The default SDK adapter wraps the existing HatchetSubmitter (submit → await result).
 */

import type { SingleResult } from "./types/flow.js";
import type { HatchetFlowPayload } from "./hatchet-payload.js";

/** A remote Hatchet run handle returned after successful submission. */
export interface HatchetRunHandle {
  runId: string;
}

/** Status response from polling a remote Hatchet run. */
export type HatchetRemoteRunStatus =
  | { status: "queued" | "running" | "unknown"; errorMessage?: string }
  | { status: "completed"; result: SingleResult }
  | { status: "failed" | "cancelled"; errorMessage: string; result?: SingleResult };

/**
 * Adapter interface for submitting and polling Hatchet flow runs.
 * Implement this interface to create test fakes or alternative Hatchet clients.
 */
export interface HatchetRunAdapter {
  /** Submit a task to Hatchet and return a handle immediately (or when the run is accepted). */
  submit(taskName: string, payload: HatchetFlowPayload): Promise<HatchetRunHandle>;
  /** Get the current status/result of a submitted run. */
  getResult(handle: HatchetRunHandle): Promise<HatchetRemoteRunStatus>;
  /** Cancel a running run. Optional — implementations may leave this undefined. */
  cancel?(handle: HatchetRunHandle): Promise<void>;
}

/**
 * Compatibility adapter that wraps an existing HatchetSubmitter function.
 *
 * The submitter awaits a final SingleResult, so this adapter:
 * - Returns a synthetic handle immediately (before awaiting result)
 * - Caches the in-flight promise so getResult can await it
 */
export class SubmitterAdapter implements HatchetRunAdapter {
  private readonly inFlight = new Map<string, Promise<SingleResult>>();
  private nextId = 0;

  constructor(
    private readonly submitter: (taskName: string, payload: HatchetFlowPayload) => Promise<SingleResult>,
  ) {}

  async submit(taskName: string, payload: HatchetFlowPayload): Promise<HatchetRunHandle> {
    const runId = `synthetic-${++this.nextId}-${Date.now()}`;
    // Start the submission but don't await it here; cache the promise
    const promise = this.submitter(taskName, payload);
    this.inFlight.set(runId, promise);
    return { runId };
  }

  async getResult(handle: HatchetRunHandle): Promise<HatchetRemoteRunStatus> {
    const promise = this.inFlight.get(handle.runId);
    if (!promise) {
      return { status: "unknown", errorMessage: "No in-flight promise found for this synthetic run handle." };
    }
    try {
      const result = await promise;
      this.inFlight.delete(handle.runId);
      return { status: "completed", result };
    } catch (err) {
      this.inFlight.delete(handle.runId);
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { status: "failed", errorMessage };
    }
  }
}
