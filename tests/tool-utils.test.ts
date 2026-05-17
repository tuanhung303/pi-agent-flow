import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	appendDirectiveOnce,
	resetDirectiveTracker,
	configureDirective,
	stripDirectives,
	stripDirectivesFromContent,
	stripDirectivesFromMessages,
	DEFAULT_DIRECTIVE,
	NOTDONE_DIRECTIVE,
	VAGUE_DIRECTIVE,
	// Backward-compat aliases
	appendStrategicHintOnce,
	resetStrategicHintTracker,
	configureStrategicHint,
	stripStrategicHints,
	stripStrategicHintsFromContent,
} from "../src/steering/tool-utils.js";

function makeResult(text?: string) {
	return {
		content: text ? [{ type: "text", text }] : [],
	};
}

describe("appendDirectiveOnce", () => {
	beforeEach(() => {
		resetDirectiveTracker();
		configureDirective(true);
	});

	it("appends DEFAULT_DIRECTIVE when no hintContext provided", () => {
		const result = makeResult("hello");
		appendDirectiveOnce(result);
		expect(result.content[0].text).toContain("[Directive: Close what you start");
	});

	it("appends NOTDONE_DIRECTIVE when hasNotDone is true", () => {
		const result = makeResult("hello");
		appendDirectiveOnce(result, { hasNotDone: true, statusVague: false });
		expect(result.content[0].text).toContain("[Directive: Unfinished work detected");
	});

	it("appends VAGUE_DIRECTIVE when statusVague is true", () => {
		const result = makeResult("hello");
		appendDirectiveOnce(result, { hasNotDone: false, statusVague: true });
		expect(result.content[0].text).toContain("[Directive: Dispatch the same");
	});

	it("prioritizes NOTDONE_DIRECTIVE over VAGUE_DIRECTIVE when both are true", () => {
		const result = makeResult("hello");
		appendDirectiveOnce(result, { hasNotDone: true, statusVague: true });
		expect(result.content[0].text).toContain("[Directive: Unfinished work detected");
		expect(result.content[0].text).not.toContain("Dispatch the same");
	});

	it("skips directive on error results", () => {
		const result = { ...makeResult("error"), failed: true };
		appendDirectiveOnce(result);
		expect(result.content[0].text).toBe("error");
	});

	it("appends directive to each distinct result", () => {
		const result1 = makeResult("first");
		const result2 = makeResult("second");
		appendDirectiveOnce(result1);
		appendDirectiveOnce(result2);
		expect(result1.content[0].text).toContain("[Directive:");
		expect(result2.content[0].text).toContain("[Directive:");
	});

	it("skips directive when already appended to the same result", () => {
		const result = makeResult("only");
		appendDirectiveOnce(result);
		appendDirectiveOnce(result);
		expect(result.content[0].text).toContain("[Directive:");
		expect((result.content[0].text.match(/\[Directive:/g) || []).length).toBe(1);
	});

	it("skips directive when disabled via configureDirective(false)", () => {
		configureDirective(false);
		const result = makeResult("hello");
		appendDirectiveOnce(result);
		expect(result.content[0].text).toBe("hello");
	});
});

describe("stripDirectives", () => {
	it("removes DEFAULT_DIRECTIVE from text", () => {
		const text = "before" + DEFAULT_DIRECTIVE + " after";
		expect(stripDirectives(text)).toBe("before after");
	});

	it("removes NOTDONE_DIRECTIVE from text", () => {
		const text = "before" + NOTDONE_DIRECTIVE + " after";
		expect(stripDirectives(text)).toBe("before after");
	});

	it("removes VAGUE_DIRECTIVE from text", () => {
		const text = "before" + VAGUE_DIRECTIVE + " after";
		expect(stripDirectives(text)).toBe("before after");
	});

	it("removes legacy [Hint:] directives from text", () => {
		const text = 'before\n\n[Hint: Plan next step. Batch ALL pending edits/reads/commands into ONE batch call. Execute decisively.] after';
		expect(stripDirectives(text)).toBe("before after");
	});



	it("returns text unchanged when no directives present", () => {
		const text = "clean text";
		expect(stripDirectives(text)).toBe("clean text");
	});
});

describe("stripDirectivesFromContent", () => {
	it("strips from string content", () => {
		const content = "before" + DEFAULT_DIRECTIVE + " after";
		expect(stripDirectivesFromContent(content)).toBe("before after");
	});

	it("strips from text-part array", () => {
		const content = [
			{ type: "text", text: "before" + NOTDONE_DIRECTIVE + " after" },
			{ type: "text", text: "clean" },
		];
		const result = stripDirectivesFromContent(content) as Array<{ type: string; text: string }>;
		expect(result[0].text).toBe("before after");
		expect(result[1].text).toBe("clean");
	});

	it("preserves non-text parts", () => {
		const content = [
			{ type: "text", text: VAGUE_DIRECTIVE },
			{ type: "toolCall", name: "bash" },
		];
		const result = stripDirectivesFromContent(content) as Array<{ type: string; text?: string }>;
		expect(result[0].text).toBe("");
		expect(result[1].type).toBe("toolCall");
	});
});

describe("stripDirectivesFromMessages", () => {
	it("strips directives from string content in messages", () => {
		const messages = [
			{ role: "user", content: "before" + DEFAULT_DIRECTIVE + " after" },
		];
		const { messages: result, changed } = stripDirectivesFromMessages(messages);
		expect(changed).toBe(true);
		expect(result[0].content).toBe("before after");
	});

	it("strips directives from multipart content in messages", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "before" + NOTDONE_DIRECTIVE + " after" }] },
		];
		const { messages: result, changed } = stripDirectivesFromMessages(messages);
		expect(changed).toBe(true);
		expect((result[0].content as any[])[0].text).toBe("before after");
	});

	it("returns unchanged flag false when nothing to strip", () => {
		const messages = [{ role: "user", content: "clean" }];
		const { messages: result, changed } = stripDirectivesFromMessages(messages);
		expect(changed).toBe(false);
		expect(result[0].content).toBe("clean");
	});
});

describe("backward-compat aliases", () => {
	beforeEach(() => {
		resetDirectiveTracker();
		configureDirective(true);
	});

	it("appendStrategicHintOnce still callable", () => {
		const result = makeResult("hello");
		appendStrategicHintOnce(result);
		expect(result.content[0].text).toContain("[Directive:");
	});

	it("resetStrategicHintTracker still callable", () => {
		const result1 = makeResult("first");
		appendStrategicHintOnce(result1);
		resetStrategicHintTracker();
		const result2 = makeResult("second");
		appendStrategicHintOnce(result2);
		expect(result2.content[0].text).toContain("[Directive:");
	});

	it("configureStrategicHint still callable", () => {
		configureStrategicHint(false);
		const result = makeResult("hello");
		appendStrategicHintOnce(result);
		expect(result.content[0].text).toBe("hello");
	});

	it("stripStrategicHints still callable", () => {
		const text = "before" + DEFAULT_DIRECTIVE + " after";
		expect(stripStrategicHints(text)).toBe("before after");
	});

	it("stripStrategicHintsFromContent still callable", () => {
		const content = "before" + VAGUE_DIRECTIVE + " after";
		expect(stripStrategicHintsFromContent(content)).toBe("before after");
	});
});

describe("env var disable", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = originalEnv;
		// Re-import to reset module state — vitest cache busting via dynamic import
	});

	it("should be tested by verifying configureDirective overrides env", () => {
		// Module-level env initialization can't be re-run easily in vitest
		// without isolated modules. We verify the public API instead:
		// configureDirective(false) reliably disables directives.
		configureDirective(false);
		const result = makeResult("hello");
		appendDirectiveOnce(result);
		expect(result.content[0].text).toBe("hello");
	});
});
