/**
 * Runtime template strings for flow-goal prompts.
 * Kept in sync with the .md sources in templates/.
 */

export const continuationTemplate = `<flow-goal-continuation>
The current session has an active flow goal. Continue execution toward the objective.

Objective: {{objective}}
Acceptance: {{acceptance}}
Progress: {{flowCount}}/{{maxFlows}} flows completed, {{totalTokens}} tokens used.

Resume work. Use flows to advance the goal. Output structured findings.
</flow-goal-continuation>`;

export const budgetLimitTemplate = `<flow-goal-budget>
The flow goal has reached its budget limit.

Objective: {{objective}}
Usage: {{totalTokens}}/{{maxTokens}} tokens, {{flowCount}}/{{maxFlows}} flows.

The goal is now paused. Review results and adjust limits with \`/flow-goal resume\` or \`/flow-goal edit\`.
</flow-goal-budget>`;

export const objectiveUpdatedTemplate = `<flow-goal-update>
The flow goal objective has been updated.

Previous: {{previousObjective}}
Current: {{objective}}
Acceptance: {{acceptance}}

Adjust your plan accordingly. Continue with the revised objective.
</flow-goal-update>`;
