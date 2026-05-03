import { describe, it, expect } from "vitest";
import { extractStructuredOutput } from "../src/structured-output.js";

// ---------------------------------------------------------------------------
// extractStructuredOutput
// ---------------------------------------------------------------------------

describe("extractStructuredOutput", () => {
	const validOutput = {
		version: "1.0",
		status: "complete",
		summary: "Implemented the feature successfully.",
		files: [
			{
				path: "src/example.ts",
				role: "modified",
				description: "Main implementation file",
				snippet: "const x = 1;",
				ranges: [{ start: 10, end: 25, label: "fix" }],
			},
		],
		actions: [
			{
				type: "write",
				description: "Wrote implementation",
				target: "src/example.ts",
				result: "success",
				evidence: "file created",
			},
		],
		nextSteps: ["Run tests", "Commit changes"],
		reasoning: ["Chose approach A because of X"],
		notes: ["Consider refactoring later"],
	};

	it("returns undefined for empty string", () => {
		expect(extractStructuredOutput("")).toBeUndefined();
	});

	it("returns undefined when no JSON block is present", () => {
		const text = "flow [build] accomplished\n\n[Summary]\nDid some work.";
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		const text = "Done.\n\n```json\n{broken json,}\n```";
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined when required fields are missing", () => {
		const text = "Done.\n\n```json\n{ \"version\": \"1.0\" }\n```";
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined when status is invalid", () => {
		const text = `Done.

\`\`\`json
${JSON.stringify({ ...validOutput, status: "unknown" })}
\`\`\``;
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined when arrays are missing", () => {
		const partial = {
			version: "1.0",
			status: "complete",
			summary: "Done.",
			files: [],
			actions: [],
			// missing nextSteps, reasoning, notes
		};
		const text = `Done.

\`\`\`json
${JSON.stringify(partial)}
\`\`\``;
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("extracts a valid structured output block", () => {
		const text = `flow [build] accomplished

[Summary]
Did some work.

[Done]
- Completed items.

\`\`\`json
${JSON.stringify(validOutput)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.version).toBe("1.0");
		expect(result!.status).toBe("complete");
		expect(result!.summary).toBe("Implemented the feature successfully.");
		expect(result!.files).toHaveLength(1);
		expect(result!.files[0].path).toBe("src/example.ts");
		expect(result!.actions).toHaveLength(1);
		expect(result!.nextSteps).toHaveLength(2);
		expect(result!.reasoning).toHaveLength(1);
		expect(result!.notes).toHaveLength(1);
	});

	it("uses the last JSON block when multiple exist", () => {
		const firstBlock = JSON.stringify({ ...validOutput, summary: "First" });
		const secondBlock = JSON.stringify({ ...validOutput, summary: "Second" });
		const text = `First attempt:

\`\`\`json
${firstBlock}
\`\`\`

Second attempt:

\`\`\`json
${secondBlock}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.summary).toBe("Second");
	});

	it("preserves extensions when present", () => {
		const withExtensions = {
			...validOutput,
			extensions: { rootCause: "Null pointer exception" },
		};
		const text = `Done.

\`\`\`json
${JSON.stringify(withExtensions)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.extensions).toEqual({ rootCause: "Null pointer exception" });
	});

	it("omits extensions when not present", () => {
		const text = `Done.

\`\`\`json
${JSON.stringify(validOutput)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.extensions).toBeUndefined();
	});

	it("handles all valid status values", () => {
		for (const status of ["complete", "partial", "blocked", "failed"]) {
			const text = `Done.

\`\`\`json
${JSON.stringify({ ...validOutput, status })}
\`\`\``;
			const result = extractStructuredOutput(text);
			expect(result).toBeDefined();
			expect(result!.status).toBe(status);
		}
	});

	it("trims whitespace from summary", () => {
		const spaced = { ...validOutput, summary: "  Spaced summary  " };
		const text = `Done.

\`\`\`json
${JSON.stringify(spaced)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.summary).toBe("Spaced summary");
	});

	it("handles code fence with language tag on same line", () => {
		const text = `Done.

\`\`\`json extra
${JSON.stringify(validOutput)}
\`\`\``;
		// Should not match because the fence has extra text after `json`
		expect(extractStructuredOutput(text)).toBeUndefined();
	});
});
