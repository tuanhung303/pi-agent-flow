export function getMarkdownTheme() {
	return {};
}

let bashToolExecuteImpl: (...args: any[]) => Promise<any> = async () => ({ content: [{ type: "text", text: "" }] });
export const bashToolExecuteCalls: any[][] = [];

export function __setBashToolExecuteImpl(fn: (...args: any[]) => Promise<any>) {
	bashToolExecuteImpl = fn;
}

export function __resetBashToolMock() {
	bashToolExecuteCalls.length = 0;
	bashToolExecuteImpl = async () => ({ content: [{ type: "text", text: "" }] });
}

export function createBashToolDefinition(_cwd: string, _options?: any) {
	return {
		name: "bash",
		label: "Bash",
		description: "Mock bash tool",
		parameters: {},
		execute: async (...args: any[]) => {
			bashToolExecuteCalls.push(args);
			return bashToolExecuteImpl(...args);
		},
	};
}

export const registeredCommands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();

export function registerCommand(name: string, config: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
	registeredCommands.set(name, config);
}

export function parseFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) {
		throw new Error("No frontmatter found");
	}
	const yamlText = match[1];
	const body = match[2];
	const frontmatter: Record<string, unknown> = {};
	for (const line of yamlText.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let value: unknown = line.slice(idx + 1).trim();
		// Remove quotes
		if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		if (typeof value === "string" && value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1);
		}
		// Convert "true"/"false"
		if (value === "true") value = true;
		if (value === "false") value = false;
		// Convert numbers
		if (typeof value === "string" && /^-?\d+$/.test(value)) value = Number(value);
		frontmatter[key] = value;
	}
	return { frontmatter: frontmatter as T, body };
}
