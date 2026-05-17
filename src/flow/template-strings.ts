import { sharedWakeupGuidance } from "./template-shared.js";

/**
 * Runtime template strings for flow prompts.
 * Kept in sync with the .md sources in templates/.
 */

export const budgetLimitTemplate = `<flow-budget>
The flow goal has exceeded its budget and has been auto-paused.

Objective: {{objective}}
Usage: {{totalTokens}}/{{maxTokens}} tokens, {{flowCount}}/{{maxFlows}} flows.

Resume with \`/flow:goal resume\` if you want to continue.
</flow-budget>`;

export const idleWakeupTemplate = `<flow-wakeup>
The user has been idle. Review the active goal and find safe, conservative improvements that advance it.

Objective: {{objective}}
{{acceptanceClause}}
Progress: {{flowCount}}/{{maxFlows}} flows, {{totalTokens}} tokens.

${sharedWakeupGuidance}

Call the flow tool with the appropriate flow type to continue.
</flow-wakeup>`;

export const continuationPromptTemplate = `<flow-continuation>
Continue execution toward the active goal.

Objective: {{objective}}
{{acceptanceClause}}
Progress: {{flowCount}}{{maxFlowsClause}} flows, {{tokenInfo}} tokens.

Latest user message: {{userMessage}}

Call the flow tool with an appropriate type (scout, craft, build, audit, debug, ideas) to advance. Only the user can end a goal. Keep finding improvements that advance the objective.
</flow-continuation>`;
