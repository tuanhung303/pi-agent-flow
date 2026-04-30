import { describe, it, expect } from "vitest";
import {
	extractSnippet,
	trimLargeDocument,
	stripMarkdownFormatting,
	urlToHash,
	validateFetchUrl,
	looksLikeUrlPrompt,
	looksLikeWebSearchPrompt,
	htmlToMarkdown,
} from "../web-tool.js";

describe("extractSnippet", () => {
	it("returns trimmed text up to max length", () => {
		const raw = "  Some long text that goes on and on  ";
		expect(extractSnippet(raw, "Other")).toBe("Some long text that goes on and on");
	});

	it("returns empty string when text matches title", () => {
		expect(extractSnippet("My Title", "My Title")).toBe("");
	});

	it("returns empty string for empty input", () => {
		expect(extractSnippet("", "title")).toBe("");
	});

	it("truncates to 160 characters", () => {
		const long = "a".repeat(300);
		expect(extractSnippet(long, "title").length).toBe(160);
	});

	it("strips leading title text from snippet", () => {
		const raw = "My Title and then the real snippet text follows here";
		expect(extractSnippet(raw, "My Title")).toBe("and then the real snippet text follows here");
	});

	it("returns empty when snippet is only the title", () => {
		expect(extractSnippet("My Title  ", "My Title")).toBe("");
	});
});

describe("trimLargeDocument", () => {
	it("returns original if within budget", () => {
		expect(trimLargeDocument("short", 1000)).toBe("short");
	});

	it("trims and adds marker for oversized documents", () => {
		const doc = "x".repeat(2000);
		const trimmed = trimLargeDocument(doc, 500);
		expect(trimmed).toContain("[...content trimmed...]");
		expect(trimmed.length).toBeLessThanOrEqual(500);
	});

	it("preserves head and tail", () => {
		const doc = "HEAD" + "x".repeat(2000) + "TAIL";
		const trimmed = trimLargeDocument(doc, 500);
		expect(trimmed.startsWith("HEAD")).toBe(true);
		expect(trimmed.endsWith("TAIL")).toBe(true);
	});

	it("respects budget exactly for various sizes", () => {
		for (const budget of [100, 250, 500, 1000, 5000]) {
			const doc = "a".repeat(budget * 3);
			const trimmed = trimLargeDocument(doc, budget);
			expect(trimmed.length).toBeLessThanOrEqual(budget);
		}
	});
});

describe("stripMarkdownFormatting", () => {
	it("removes heading markers", () => {
		expect(stripMarkdownFormatting("# Hello\n## World")).toBe("Hello\nWorld");
	});

	it("removes bold and italic markers", () => {
		expect(stripMarkdownFormatting("**bold** and *italic*")).toBe("bold and italic");
	});

	it("removes inline code backticks", () => {
		expect(stripMarkdownFormatting("use `foo()` here")).toBe("use foo() here");
	});

	it("extracts link text", () => {
		expect(stripMarkdownFormatting("[click here](https://example.com)")).toBe("click here");
	});

	it("removes list markers", () => {
		expect(stripMarkdownFormatting("- item one\n* item two\n+ item three")).toBe(
			"item one\nitem two\nitem three",
		);
	});

	it("removes blockquote markers", () => {
		expect(stripMarkdownFormatting("> quoted text")).toBe("quoted text");
	});

	it("collapses excessive newlines", () => {
		expect(stripMarkdownFormatting("a\n\n\n\nb")).toBe("a\n\nb");
	});

	it("strips fenced code blocks", () => {
		expect(stripMarkdownFormatting("```js\nconsole.log(1)\n```")).toBe("console.log(1)");
	});

	it("removes numbered list markers", () => {
		expect(stripMarkdownFormatting("1. first\n2. second")).toBe("first\nsecond");
	});

	it("extracts image alt text", () => {
		expect(stripMarkdownFormatting("![alt text](image.png)")).toBe("alt text");
	});

	it("decodes common HTML entities", () => {
		expect(stripMarkdownFormatting("&amp; &lt; &gt;")).toBe("& < >");
	});
});

describe("urlToHash", () => {
	it("returns a 12-char hex string", () => {
		const hash = urlToHash("https://example.com");
		expect(hash).toMatch(/^[a-f0-9]{12}$/);
	});

	it("returns the same hash for the same URL", () => {
		expect(urlToHash("https://example.com")).toBe(urlToHash("https://example.com"));
	});

	it("returns different hashes for different URLs", () => {
		expect(urlToHash("https://example.com")).not.toBe(urlToHash("https://other.com"));
	});
});

describe("validateFetchUrl", () => {
	it("accepts https URLs", () => {
		expect(() => validateFetchUrl("https://example.com")).not.toThrow();
	});

	it("accepts http URLs", () => {
		expect(() => validateFetchUrl("http://example.com")).not.toThrow();
	});

	it("rejects data: URIs", () => {
		expect(() => validateFetchUrl("data:text/html,<h1>hi</h1>")).toThrow("Unsupported URL scheme");
	});

	it("rejects file: URIs", () => {
		expect(() => validateFetchUrl("file:///etc/passwd")).toThrow("Unsupported URL scheme");
	});

	it("rejects javascript: URIs", () => {
		expect(() => validateFetchUrl("javascript:alert(1)")).toThrow("Unsupported URL scheme");
	});

	it("rejects ftp: URIs", () => {
		expect(() => validateFetchUrl("ftp://evil.com/payload")).toThrow("Unsupported URL scheme");
	});

	it("rejects localhost", () => {
		expect(() => validateFetchUrl("http://localhost:3000")).toThrow("private or internal");
	});

	it("rejects 127.0.0.1", () => {
		expect(() => validateFetchUrl("http://127.0.0.1:8080")).toThrow("private or internal");
	});

	it("rejects 169.254.x.x metadata endpoints", () => {
		expect(() => validateFetchUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
			"private or internal",
		);
	});

	it("rejects 10.x.x.x private ranges", () => {
		expect(() => validateFetchUrl("http://10.0.0.1/admin")).toThrow("private or internal");
	});

	it("rejects 192.168.x.x private ranges", () => {
		expect(() => validateFetchUrl("http://192.168.1.1")).toThrow("private or internal");
	});

	it("rejects 172.16-31.x.x private ranges", () => {
		expect(() => validateFetchUrl("http://172.16.0.1")).toThrow("private or internal");
		expect(() => validateFetchUrl("http://172.31.255.1")).toThrow("private or internal");
	});

	it("allows 172.32.x.x (not private)", () => {
		expect(() => validateFetchUrl("http://172.32.0.1")).not.toThrow();
	});

	it("rejects .local domains", () => {
		expect(() => validateFetchUrl("http://myserver.local/api")).toThrow("private or internal");
	});

	it("rejects .internal domains", () => {
		expect(() => validateFetchUrl("http://service.internal/health")).toThrow("private or internal");
	});

	it("rejects invalid URLs", () => {
		expect(() => validateFetchUrl("not-a-url")).toThrow("Invalid URL");
	});
});

describe("looksLikeUrlPrompt", () => {
	it("detects http URLs", () => {
		expect(looksLikeUrlPrompt("Check http://example.com")).toBe(true);
	});

	it("detects https URLs", () => {
		expect(looksLikeUrlPrompt("See https://docs.rs/foo")).toBe(true);
	});

	it("detects www URLs", () => {
		expect(looksLikeUrlPrompt("Go to www.example.com")).toBe(true);
	});

	it("returns false for plain text", () => {
		expect(looksLikeUrlPrompt("Just a regular question")).toBe(false);
	});
});

describe("looksLikeWebSearchPrompt", () => {
	it("detects 'latest version'", () => {
		expect(looksLikeWebSearchPrompt("What is the latest version of Node?")).toBe(true);
	});

	it("detects 'search the web'", () => {
		expect(looksLikeWebSearchPrompt("search the web for React hooks")).toBe(true);
	});

	it("detects 'official documentation'", () => {
		expect(looksLikeWebSearchPrompt("Find the official documentation for Vite")).toBe(true);
	});

	it("returns false for unrelated prompts", () => {
		expect(looksLikeWebSearchPrompt("Refactor this function")).toBe(false);
	});

	it("does not trigger on 'current' alone", () => {
		expect(looksLikeWebSearchPrompt("set current to 5")).toBe(false);
	});

	it("does not trigger on 'docs' alone", () => {
		expect(looksLikeWebSearchPrompt("read the docs folder")).toBe(false);
	});

	it("does not trigger on 'changelog' alone", () => {
		expect(looksLikeWebSearchPrompt("update the changelog file")).toBe(false);
	});

	it("does not trigger on 'news' alone", () => {
		expect(looksLikeWebSearchPrompt("fix the news component")).toBe(false);
	});

	it("does not trigger on 'article' alone", () => {
		expect(looksLikeWebSearchPrompt("add an article element")).toBe(false);
	});

	it("does not trigger on 'google' alone", () => {
		expect(looksLikeWebSearchPrompt("rename google variable")).toBe(false);
	});

	it("detects 'news about' pattern", () => {
		expect(looksLikeWebSearchPrompt("any news about the React 20 release?")).toBe(true);
	});
});

describe("htmlToMarkdown", () => {
	it("extracts title and converts body to markdown", () => {
		const html = `
      <html>
        <head><title>Test Page</title></head>
        <body><h1>Hello</h1><p>World</p></body>
      </html>
    `;
		const result = htmlToMarkdown(html, "https://example.com");
		expect(result.title).toBe("Test Page");
		expect(result.markdown).toContain("Hello");
		expect(result.markdown).toContain("World");
	});

	it("strips script and style tags", () => {
		const html = `
      <html>
        <head><title>T</title></head>
        <body>
          <script>alert('x')</script>
          <style>.foo{}</style>
          <p>Content</p>
        </body>
      </html>
    `;
		const result = htmlToMarkdown(html, "https://example.com");
		expect(result.markdown).not.toContain("alert");
		expect(result.markdown).not.toContain(".foo");
		expect(result.markdown).toContain("Content");
	});

	it("prefers main/article content", () => {
		const html = `
      <html>
        <head><title>T</title></head>
        <body>
          <nav>Navigation</nav>
          <main><p>Main content here</p></main>
          <footer>Footer</footer>
        </body>
      </html>
    `;
		const result = htmlToMarkdown(html, "https://example.com");
		expect(result.markdown).toContain("Main content here");
	});
});
