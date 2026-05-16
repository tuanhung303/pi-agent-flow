/**
 * Runtime template strings for flow prompts.
 * Kept in sync with the .md sources in templates/.
 */

export const continuationTemplate = `<flow-continuation>
The current session has an active flow goal. Continue execution toward the objective.

Objective: {{objective}}
{{acceptanceClause}}
Progress: {{flowCount}}/{{maxFlows}} flows completed, {{totalTokens}} tokens used.

**Flow routing:** Choose the appropriate flow type based on the objective:
- \`scout\` — explore, map, discover
- \`craft\` — conservative design, architecture
- \`build\` — implement, test, verify, ship
- \`audit\` — security, quality, correctness review
- \`debug\` — investigate root cause and fix
- \`ideas\` — diverge, evaluate, recommend

**Completion audit:** Before considering the goal complete, verify EACH requirement:
1. Re-read the original objective and acceptance criteria.
2. For every stated requirement, confirm concrete evidence of completion.
3. If ANY requirement lacks evidence, continue working rather than declaring victory.
4. A goal is complete only when ALL acceptance criteria are met with verifiable results.

Call the flow tool with the appropriate flow type to advance the goal.
</flow-continuation>`;

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

export const objectiveUpdatedTemplate = `<flow-update>
The flow goal objective has been updated.

Previous: {{previousObjective}}
Current: {{objective}}
Acceptance: {{acceptance}}

Adjust your plan accordingly. Continue with the revised objective.
</flow-update>`;
