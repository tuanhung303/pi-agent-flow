export function getMarkdownTheme() {
	return {};
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
