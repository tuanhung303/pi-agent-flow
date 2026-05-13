import { describe, it, expect } from "vitest";
import {
	STEERING_HINT,
	STEERING_HINT_OPEN_TAG,
	STEERING_HINT_CLOSE_TAG,
	stripSteeringHintText,
	stripSteeringHintFromContent,
	contentContainsSteeringHintTag,
	isJsonEqual,
	stripSteeringHintsFromMessages,
	makeSteeringHintMessage,
} from "../src/sliding-prompt.js";

describe("STEERING_HINT constants", () => {
	it("OPEN and CLOSE tags are defined", () => {
		expect(STEERING_HINT_OPEN_TAG).toBeTruthy();
		expect(STEERING_HINT_CLOSE_TAG).toBeTruthy();
		expect(STEERING_HINT_OPEN_TAG).toContain("pi-flow-steering-hint");
		expect(STEERING_HINT_CLOSE_TAG).toContain("pi-flow-steering-hint");
	});

	it("STEERING_HINT contains both tags", () => {
		expect(STEERING_HINT).toContain(STEERING_HINT_OPEN_TAG);
		expect(STEERING_HINT).toContain(STEERING_HINT_CLOSE_TAG);
	});
});

describe("stripSteeringHintText", () => {
	it("removes steering hint from text", () => {
		const text = "before " + STEERING_HINT + " after";
		expect(stripSteeringHintText(text)).toBe("before  after");
	});

	it("removes legacy steering hint tags", () => {
		const text = "before <pi-flow-steering-hint>some content</pi-flow-steering-hint> after";
		expect(stripSteeringHintText(text)).toBe("before  after");
	});

	it("returns text unchanged when no tags present", () => {
		const text = "hello world";
		expect(stripSteeringHintText(text)).toBe("hello world");
	});
});

describe("stripSteeringHintFromContent", () => {
	it("strips from string content", () => {
		const content = "before " + STEERING_HINT + " after";
		expect(stripSteeringHintFromContent(content)).toBe("before  after");
	});

	it("strips from text-part array", () => {
		const content = [
			{ type: "text", text: "before " + STEERING_HINT + " after" },
			{ type: "text", text: "clean" },
		];
		const result = stripSteeringHintFromContent(content) as Array<{ type: string; text: string }>;
		expect(result[0].text).toBe("before  after");
		expect(result[1].text).toBe("clean");
	});

	it("preserves non-text parts", () => {
		const content = [
			{ type: "text", text: STEERING_HINT },
			{ type: "toolCall", name: "bash" },
		];
		const result = stripSteeringHintFromContent(content) as Array<{ type: string; text?: string }>;
		expect(result[0].text).toBe("");
		expect(result[1].type).toBe("toolCall");
	});
});

describe("contentContainsSteeringHintTag", () => {
	it("detects current tag in string", () => {
		expect(contentContainsSteeringHintTag("before " + STEERING_HINT_OPEN_TAG + " after")).toBe(true);
	});

	it("detects legacy tag in string", () => {
		expect(contentContainsSteeringHintTag("<pi-flow-steering-hint>content</pi-flow-steering-hint>")).toBe(true);
	});

	it("returns false for clean string", () => {
		expect(contentContainsSteeringHintTag("no tags here")).toBe(false);
	});

	it("detects tag in text-part array", () => {
		const content = [
			{ type: "text", text: "before " + STEERING_HINT_OPEN_TAG },
		];
		expect(contentContainsSteeringHintTag(content)).toBe(true);
	});

	it("returns false for clean text-part array", () => {
		const content = [{ type: "text", text: "clean" }];
		expect(contentContainsSteeringHintTag(content)).toBe(false);
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

describe("stripSteeringHintsFromMessages", () => {
	it("removes system messages containing steering hint tag", () => {
		const messages = [
			{ role: "system", content: STEERING_HINT },
			{ role: "user", content: "hello" },
		];
		const { messages: result, changed } = stripSteeringHintsFromMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
		expect(changed).toBe(true);
	});

	it("strips tags from user messages", () => {
		const messages = [
			{ role: "user", content: "before " + STEERING_HINT + " after" },
		];
		const { messages: result, changed } = stripSteeringHintsFromMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("before  after");
		expect(changed).toBe(true);
	});

	it("returns unchanged flag when no modifications needed", () => {
		const messages = [
			{ role: "user", content: "hello" },
		];
		const { changed } = stripSteeringHintsFromMessages(messages);
		expect(changed).toBe(false);
	});
});

describe("makeSteeringHintMessage", () => {
	it("creates a system message with steering hint", () => {
		const msg = makeSteeringHintMessage();
		expect(msg.role).toBe("system");
		expect(msg.content).toBe(STEERING_HINT);
	});

	it("preserves timestamp from reference message", () => {
		const ref = { timestamp: 12345 };
		const msg = makeSteeringHintMessage(ref);
		expect(msg.timestamp).toBe(12345);
	});
});
