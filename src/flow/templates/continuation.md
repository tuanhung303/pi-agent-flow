<flow-continuation>
The current session has an active flow goal. Continue execution toward the objective.

Objective: {{objective}}
{{acceptanceClause}}
Progress: {{flowCount}}/{{maxFlows}} flows completed, {{totalTokens}} tokens used.

**Flow routing:** Choose the appropriate flow type based on the objective:
- `scout` — explore, map, discover
- `craft` — conservative design, architecture
- `build` — implement, test, verify, ship
- `audit` — security, quality, correctness review
- `debug` — investigate root cause and fix
- `ideas` — diverge, evaluate, recommend

**Goal termination:** You cannot end a goal. Only the user can end a goal via `/flow:goal complete` or `/flow:goal clear`. Keep working — find safe, conservative improvements that advance the objective.

Call the flow tool with the appropriate flow type to advance the goal.
</flow-continuation>
