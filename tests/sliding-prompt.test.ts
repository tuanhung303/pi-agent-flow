import { describe, it, expect } from "vitest";
import {
	SLIDING_PROMPT,
	SLIDING_PROMPT_OPEN_TAG,
	SLIDING_PROMPT_CLOSE_TAG,
	stripSlidingPromptText,
	stripSlidingPromptFromContent,
	contentContainsSlidingTag,
	isJsonEqual,
	stripSlidingPromptsFromMessages,
	makeSlidingPromptMessage,
} from "../src/sliding-prompt.js";

describe("SLIDING_PROMPT constants", () => {
	it("OPEN and CLOSE tags are defined", () => {
		expect(SLIDING_PROMPT_OPEN_TAG).toBeTruthy();
		expect(SLIDING_PROMPT_CLOSE_TAG).toBeTruthy();
		expect(SLIDING_PROMPT_OPEN_TAG).toContain("pi-flow-sliding-system");
		expect(SLIDING_PROMPT_CLOSE_TAG).toContain("pi-flow-sliding-system");
	});

	it("SLIDING_PROMPT contains both tags", () => {
		expect(SLIDING_PROMPT).toContain(SLIDING_PROMPT_OPEN_TAG);
		expect(SLIDING_PROMPT).toContain(SLIDING_PROMPT_CLOSE_TAG);
	});
});

describe("stripSlidingPromptText", () => {
	it("removes sliding prompt from text", () => {
		const text = "before " + SLIDING_PROMPT + " after";
		expect(stripSlidingPromptText(text)).toBe("before  after");
	});

	it("removes legacy sliding prompt tags", () => {
		const text = "before <pi-flow-sliding-system>some content</pi-flow-sliding-system> after";
		expect(stripSlidingPromptText(text)).toBe("before  after");
	});

	it("returns text unchanged when no tags present", () => {
		const text = "hello world";
		expect(stripSlidingPromptText(text)).toBe("hello world");
	});
});

describe("stripSlidingPromptFromContent", () => {
	it("strips from string content", () => {
		const content = "before " + SLIDING_PROMPT + " after";
		expect(stripSlidingPromptFromContent(content)).toBe("before  after");
	});

	it("strips from text-part array", () => {
		const content = [
			{ type: "text", text: "before " + SLIDING_PROMPT + " after" },
			{ type: "text", text: "clean" },
		];
		const result = stripSlidingPromptFromContent(content) as Array<{ type: string; text: string }>;
		expect(result[0].text).toBe("before  after");
		expect(result[1].text).toBe("clean");
	});

	it("preserves non-text parts", () => {
		const content = [
			{ type: "text", text: SLIDING_PROMPT },
			{ type: "toolCall", name: "bash" },
		];
		const result = stripSlidingPromptFromContent(content) as Array<{ type: string; text?: string }>;
		expect(result[0].text).toBe("");
		expect(result[1].type).toBe("toolCall");
	});
});

describe("contentContainsSlidingTag", () => {
	it("detects current tag in string", () => {
		expect(contentContainsSlidingTag("before " + SLIDING_PROMPT_OPEN_TAG + " after")).toBe(true);
	});

	it("detects legacy tag in string", () => {
		expect(contentContainsSlidingTag("<pi-flow-sliding-system>content</pi-flow-sliding-system>")).toBe(true);
	});

	it("returns false for clean string", () => {
		expect(contentContainsSlidingTag("no tags here")).toBe(false);
	});

	it("detects tag in text-part array", () => {
		const content = [
			{ type: "text", text: "before " + SLIDING_PROMPT_OPEN_TAG },
		];
		expect(contentContainsSlidingTag(content)).toBe(true);
	});

	it("returns false for clean text-part array", () => {
		const content = [{ type: "text", text: "clean" }];
		expect(contentContainsSlidingTag(content)).toBe(false);
	});
});

describe("isJsonEqual", () => {
	it("returns true for identical values", () => {
		expect(isJsonEqual(1, 1)).toBe(true);
		expect(isJsonEqual("a", "a")).toBe(true);
		expect(isJsonEqual(null, null)).toBe(true);
	});

	it("returns true for deeply equal objects", () => {
		expect(isJsonEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(true);
	});

	it("handles unordered keys", () => {
		expect(isJsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
	});

	it("returns false for different values", () => {
		expect(isJsonEqual({ a: 1 }, { a: 2 })).toBe(false);
		expect(isJsonEqual([1], [2])).toBe(false);
	});

	it("returns false for different types", () => {
		expect(isJsonEqual(1, "1")).toBe(false);
		expect(isJsonEqual(null, undefined)).toBe(false);
	});
});

describe("stripSlidingPromptsFromMessages", () => {
	it("removes system messages containing sliding tag", () => {
		const messages = [
			{ role: "system", content: SLIDING_PROMPT },
			{ role: "user", content: "hello" },
		];
		const { messages: result, changed } = stripSlidingPromptsFromMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
		expect(changed).toBe(true);
	});

	it("strips tags from user messages", () => {
		const messages = [
			{ role: "user", content: "before " + SLIDING_PROMPT + " after" },
		];
		const { messages: result, changed } = stripSlidingPromptsFromMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("before  after");
		expect(changed).toBe(true);
	});

	it("returns unchanged flag when no modifications needed", () => {
		const messages = [
			{ role: "user", content: "hello" },
		];
		const { changed } = stripSlidingPromptsFromMessages(messages);
		expect(changed).toBe(false);
	});
});

describe("makeSlidingPromptMessage", () => {
	it("creates a system message with sliding prompt", () => {
		const msg = makeSlidingPromptMessage();
		expect(msg.role).toBe("system");
		expect(msg.content).toBe(SLIDING_PROMPT);
	});

	it("preserves timestamp from reference message", () => {
		const ref = { timestamp: 12345 };
		const msg = makeSlidingPromptMessage(ref);
		expect(msg.timestamp).toBe(12345);
	});
});
