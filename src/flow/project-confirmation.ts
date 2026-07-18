/**
 * Confirmation for repo-controlled prompt content.
 *
 * Project flows and project conventions share this gate so a bundled flow
 * cannot inherit unapproved instructions from .pi/agents/_conventions.md.
 */

import type { FlowConfig } from "./agents.js";

export async function confirmProjectFlowsIfNeeded(options: {
	projectFlows: FlowConfig[];
	requestedFlowNames?: Iterable<string>;
	projectFlowsDir: string | null;
	conventionsPath?: string;
	hasUI: boolean;
	uiConfirm: (title: string, body: string) => Promise<boolean>;
}): Promise<{ ok: boolean; blocked?: string }> {
	const { projectFlows, requestedFlowNames, projectFlowsDir, conventionsPath, hasUI, uiConfirm } = options;
	if (projectFlows.length === 0 && !conventionsPath) return { ok: true };

	const names = projectFlows.length > 0
		? projectFlows.map((flow) => flow.name).join(", ")
		: Array.from(requestedFlowNames ?? []).map((name) => name.toLowerCase()).join(", ") || "(unknown)";
	const dir = projectFlowsDir ?? "(unknown)";
	const conventionsLine = conventionsPath ? `\nConventions: ${conventionsPath}` : "";
	const warning = conventionsPath
		? "Project flows and conventions are repo-controlled. Only continue for trusted repositories."
		: "Project flows are repo-controlled. Only continue for trusted repositories.";

	if (hasUI) {
		const ok = await uiConfirm(
			"Run project-local flows?",
			`Flows: ${names}\nSource: ${dir}${conventionsLine}\n\n${warning}`,
		);
		return { ok };
	}

	return {
		ok: false,
		blocked: `Blocked: project-local flow confirmation required in non-UI mode.\nFlows: ${names}\nRe-run with confirmProjectFlows: false if trusted.`,
	};
}
