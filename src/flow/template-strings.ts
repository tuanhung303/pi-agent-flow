/**
 * Runtime template strings for flow prompts.
 * Kept in sync with the .md sources in templates/.
 */

export const budgetLimitTemplate = `<flow-budget>
The flow goal has exceeded its budget and has been auto-paused.

Objective: {{objective}}
Usage: {{totalTokens}}/{{maxTokens}} tokens, {{flowCount}}/{{maxFlows}} flows.

Resume with \`/flow resume\` if you want to continue.
</flow-budget>`;

export const goalCompletedTemplate = `<flow-completion>
The flow goal has been marked as completed by the orchestrator.

Objective: {{objective}}

Auto-continuation is now stopped. No further flows will be spawned for this goal.
</flow-completion>`;


