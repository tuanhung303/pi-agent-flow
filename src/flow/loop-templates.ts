import { loopOverallClause, sharedWakeupGuidance } from "./template-shared.js";

/**
 * Runtime template strings for endless loop prompts.
 */

export const autoWarpTriggerTemplate = `<flow-loop-warp>
The active goal has exceeded its budget, but the endless loop is active. Call the warp tool to continue in a new session.

Objective: {{objective}}
{{acceptanceClause}}
Loop progress: {{sessionCount}} sessions, {{totalFlowsAcrossSessions}} flows, {{totalTokensAcrossSessions}}/{{maxTokens}} tokens.

The new session should inherit this context and resume work toward the objective.
</flow-loop-warp>`;

export const loopContinuationPromptTemplate = `<flow-continuation>
Continue execution toward the active goal. This is an endless loop session.

Objective: {{objective}}
{{acceptanceClause}}
Progress: {{flowCount}}{{maxFlowsClause}} flows in this session, {{tokenInfo}} tokens.
${loopOverallClause}

Latest user message: {{userMessage}}

Call the flow tool with an appropriate type to advance, or call the warp tool to hand off to a fresh session if budget is exceeded. Only the user can end a goal. Keep finding improvements that advance the objective.
</flow-continuation>`;

export const loopWakeupTemplate = `<flow-wakeup>
The user has been idle. Review the active goal and find safe, conservative improvements that advance it. This is an endless loop session.

Objective: {{objective}}
{{acceptanceClause}}
Progress: {{flowCount}}/{{maxFlows}} flows in this session, {{totalTokens}} tokens.
${loopOverallClause}

${sharedWakeupGuidance}

Call the flow tool with the appropriate flow type to continue, or call the warp tool to hand off to a fresh session if budget is exceeded.
</flow-wakeup>`;
