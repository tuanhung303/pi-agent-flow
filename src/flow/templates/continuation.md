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

**Completion audit:** Before considering the goal complete, verify EACH requirement:
1. Re-read the original objective and acceptance criteria.
2. For every stated requirement, confirm concrete evidence of completion.
3. If ANY requirement lacks evidence, continue working rather than declaring victory.
4. A goal is complete only when ALL acceptance criteria are met with verifiable results.

Call the flow tool with the appropriate flow type to advance the goal.
</flow-continuation>
