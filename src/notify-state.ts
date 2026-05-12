/**
 * Notify State — turn-scoped notification context.
 *
 * Allows executor and ask-user modules to record what happened during a turn
 * so that the notification handler can produce context-aware title/body text.
 * State is reset at the start of each turn.
 */

export interface NotifyState {
	/** True when ask_user was invoked this turn. */
	pendingDecision: boolean;
	/** Name of the last flow that completed. */
	lastFlowName?: string;
	/** Acceptance criteria from the last completed flow. */
	lastFlowAcceptance?: string;
	/** Number of flows that finished so far. */
	completedFlows: number;
	/** Total number of flows dispatched. */
	totalFlows: number;
}

const DEFAULT_STATE: Readonly<NotifyState> = Object.freeze({
	pendingDecision: false,
	completedFlows: 0,
	totalFlows: 0,
});

let state: NotifyState = { ...DEFAULT_STATE };

/** Read the current notification state (read-only snapshot). */
export function getNotifyState(): Readonly<NotifyState> {
	return state;
}

/** Reset state to defaults. Called at the start of each turn. */
export function resetNotifyState(): void {
	state = { ...DEFAULT_STATE };
}

/** Mark that ask_user was invoked this turn. */
export function setPendingDecision(): void {
	state.pendingDecision = true;
}

/** Record the last flow's completion info.
 *  @param name - Flow type name (e.g. "scout", "build")
 *  @param acceptance - Acceptance criteria string, if provided
 *  @param index - 0-based index of this flow in the batch
 *  @param total - Total number of flows in the batch
 */
export function setFlowComplete(
	name: string,
	acceptance: string | undefined,
	index: number,
	total: number,
): void {
	state.lastFlowName = name;
	state.lastFlowAcceptance = acceptance;
	state.completedFlows = index + 1;
	state.totalFlows = total;
}
