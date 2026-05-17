/**
 * Shared template fragments to reduce duplication between loop-templates.ts
 * and template-strings.ts.
 */

/** Shared guidance stanza used in both idle and loop wakeup templates. */
export const sharedWakeupGuidance = `Guidance:
- Focus on safe, incremental improvements — do not refactor large areas or make risky changes.
- Prefer verification, testing, and documentation over new features.
- If you find potential issues, investigate with scout or audit before making changes.
- You cannot end this goal. Only the user can end a goal.`;

/** Shared loop-overall stats clause used in loop templates. */
export const loopOverallClause = `Loop overall: {{sessionCount}} sessions, {{totalTokensAcrossSessions}} tokens total.`;
