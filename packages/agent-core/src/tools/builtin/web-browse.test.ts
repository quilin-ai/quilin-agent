import { describe, expect, it, vi } from "vitest";
import { WriteAuthority } from "../../safety/write-authority.js";
import { resolveSandboxPolicy } from "../sandbox.js";
import {
	createWebBrowseTool,
	type StagehandLike,
	type StagehandLikePage,
} from "./web-browse.js";

interface FakePage {
	goto: ReturnType<typeof vi.fn>;
	waitForSelector: ReturnType<typeof vi.fn>;
	extract: ReturnType<typeof vi.fn>;
	act: ReturnType<typeof vi.fn>;
	observe: ReturnType<typeof vi.fn>;
}

interface FakeStagehand {
	init: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	page: FakePage;
}

function makeFakeStagehand(): FakeStagehand {
	return {
		init: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		page: {
			goto: vi.fn().mockResolvedValue(undefined),
			waitForSelector: vi.fn().mockResolvedValue(undefined),
			extract: vi.fn().mockResolvedValue({ summary: "extracted" }),
			act: vi.fn().mockResolvedValue({ acted: true }),
			observe: vi.fn().mockResolvedValue([{ selector: "#x" }]),
		},
	};
}

function asStagehand(fake: FakeStagehand): StagehandLike {
	return {
		init: fake.init as unknown as StagehandLike["init"],
		close: fake.close as unknown as StagehandLike["close"],
		page: fake.page as unknown as StagehandLikePage,
	};
}

describe("createWebBrowseTool", () => {
	it("rejects non-http URLs without launching a browser", async () => {
		const factory = vi.fn();
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "file:///etc/passwd",
			instruction: "read",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content).error).toMatch(/http/);
		expect(factory).not.toHaveBeenCalled();
	});

	it("rejects malformed URLs", async () => {
		const factory = vi.fn();
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "not a url",
			instruction: "read",
		});

		expect(result.isError).toBe(true);
		expect(factory).not.toHaveBeenCalled();
	});

	it("runs extract mode by default and closes the browser", async () => {
		const fake = makeFakeStagehand();
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "https://example.com/article",
			instruction: "extract title and author",
		});

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content);
		expect(payload.mode).toBe("extract");
		expect(payload.url).toBe("https://example.com/article");
		expect(payload.result).toEqual({ summary: "extracted" });
		expect(fake.init).toHaveBeenCalledTimes(1);
		expect(fake.page.goto).toHaveBeenCalledWith(
			"https://example.com/article",
			expect.objectContaining({ timeout: 60000 }),
		);
		expect(fake.page.extract).toHaveBeenCalledWith({
			instruction: "extract title and author",
		});
		expect(fake.close).toHaveBeenCalledTimes(1);
	});

	it("supports observe mode", async () => {
		const fake = makeFakeStagehand();
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "https://example.com/",
			instruction: "list interactive elements",
			mode: "observe",
		});

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content);
		expect(payload.mode).toBe("observe");
		expect(payload.result).toEqual([{ selector: "#x" }]);
		expect(fake.page.observe).toHaveBeenCalledWith({
			instruction: "list interactive elements",
		});
		expect(fake.page.extract).not.toHaveBeenCalled();
	});

	it("runs act mode after WriteAuthority approves", async () => {
		const fake = makeFakeStagehand();
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const writeAuthority = new WriteAuthority({
			mode: "ask",
			confirm: async () => true,
		});
		const tool = createWebBrowseTool({
			stagehandFactory: factory,
			writeAuthority,
		});

		const result = await tool.execute({
			url: "https://example.com/login",
			instruction: "click the submit button",
			mode: "act",
		});

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content);
		expect(payload.mode).toBe("act");
		expect(payload.result).toEqual({ acted: true });
		expect(fake.page.act).toHaveBeenCalledWith({
			action: "click the submit button",
		});
	});

	it("blocks act mode when WriteAuthority denies", async () => {
		const fake = makeFakeStagehand();
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const writeAuthority = new WriteAuthority({ mode: "deny-all" });
		const tool = createWebBrowseTool({
			stagehandFactory: factory,
			writeAuthority,
		});

		const result = await tool.execute({
			url: "https://example.com/login",
			instruction: "click submit",
			mode: "act",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content).error).toMatch(/denied/);
		expect(factory).not.toHaveBeenCalled();
	});

	it("truncates long instructions in the WriteAuthority confirmation summary", async () => {
		const fake = makeFakeStagehand();
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const seenSummaries: string[] = [];
		const writeAuthority = new WriteAuthority({
			mode: "ask",
			confirm: async (request) => {
				seenSummaries.push(request.summary);
				return true;
			},
		});
		const tool = createWebBrowseTool({
			stagehandFactory: factory,
			writeAuthority,
		});

		const longInstruction = `Please${" something".repeat(20)}`;
		await tool.execute({
			url: "https://example.com/x",
			instruction: longInstruction,
			mode: "act",
		});

		expect(seenSummaries).toHaveLength(1);
		const summary = seenSummaries[0]!;
		expect(summary).toContain("example.com");
		expect(summary).toContain("...");
		expect(summary.length).toBeLessThan(longInstruction.length + 60);
	});

	it("returns an error when act mode is requested without a WriteAuthority", async () => {
		const fake = makeFakeStagehand();
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "https://example.com/x",
			instruction: "click",
			mode: "act",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content).error).toMatch(
			/WriteAuthority/,
		);
		expect(factory).not.toHaveBeenCalled();
	});

	it("returns an error when WriteAuthority asks but no confirm hook is configured", async () => {
		const fake = makeFakeStagehand();
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const writeAuthority = new WriteAuthority({ mode: "ask" });
		const tool = createWebBrowseTool({
			stagehandFactory: factory,
			writeAuthority,
		});

		const result = await tool.execute({
			url: "https://example.com/x",
			instruction: "click",
			mode: "act",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content).error).toMatch(
			/denied|interactive/,
		);
		expect(factory).not.toHaveBeenCalled();
	});

	it("waits for the configured selector when wait_for is provided", async () => {
		const fake = makeFakeStagehand();
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		await tool.execute({
			url: "https://example.com/",
			instruction: "extract price",
			wait_for: "#price",
			timeout_ms: 12_345,
		});

		expect(fake.page.goto).toHaveBeenCalledWith(
			"https://example.com/",
			expect.objectContaining({ timeout: 12345 }),
		);
		expect(fake.page.waitForSelector).toHaveBeenCalledWith(
			"#price",
			expect.objectContaining({ timeout: 12345, state: "attached" }),
		);
	});

	it("reports browse errors and still closes the browser", async () => {
		const fake = makeFakeStagehand();
		fake.page.extract = vi.fn().mockRejectedValue(new Error("LLM blew up"));
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "https://example.com/x",
			instruction: "extract",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content).error).toBe("LLM blew up");
		expect(fake.close).toHaveBeenCalledTimes(1);
	});

	it("reports non-Error browse failures generically", async () => {
		const fake = makeFakeStagehand();
		fake.page.extract = vi.fn().mockRejectedValue("kaboom");
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "https://example.com/x",
			instruction: "extract",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content).error).toBe("Browse failed");
	});

	it("swallows errors from stagehand.close to preserve the original outcome", async () => {
		const fake = makeFakeStagehand();
		fake.close = vi.fn().mockRejectedValue(new Error("close failed"));
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "https://example.com/x",
			instruction: "extract",
		});

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content).result).toEqual({ summary: "extracted" });
	});

	it("uses null for empty extract results", async () => {
		const fake = makeFakeStagehand();
		fake.page.extract = vi.fn().mockResolvedValue(undefined);
		const factory = vi.fn().mockResolvedValue(asStagehand(fake));
		const tool = createWebBrowseTool({ stagehandFactory: factory });

		const result = await tool.execute({
			url: "https://example.com/x",
			instruction: "extract",
		});

		expect(JSON.parse(result.content).result).toBeNull();
	});

	it("builds sandbox network signals from url and mode", async () => {
		const tool = createWebBrowseTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_browse sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-web-browse",
			requestedToolName: "web_browse",
			resolvedToolName: "web_browse",
			parsedArguments: {
				url: "https://example.com:8443/page",
				instruction: "click submit",
				mode: "act",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		expect(request).toEqual({
			operation: "network",
			origin: "agent",
			signals: {
				network: {
					method: "POST",
					sendsCredentials: false,
					destination: "example.com:8443",
					protocol: "https",
				},
			},
		});
	});

	it("falls back to GET method for read-only modes in sandbox signals", async () => {
		const tool = createWebBrowseTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_browse sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-web-browse-read",
			requestedToolName: "web_browse",
			resolvedToolName: "web_browse",
			parsedArguments: {
				url: "https://example.com/article",
				instruction: "extract title",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		if (request == null) throw new Error("expected sandbox request");
		expect(request.signals?.network?.method).toBe("GET");
	});

	it("preserves the raw destination in sandbox signals when url parsing fails", async () => {
		const tool = createWebBrowseTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_browse sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-web-browse-bad",
			requestedToolName: "web_browse",
			resolvedToolName: "web_browse",
			parsedArguments: {
				url: "not a url",
				instruction: "x",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		if (request == null) throw new Error("expected sandbox request");
		expect(request.signals?.network?.destination).toBe("not a url");
	});

	it("omits destination when no url argument is supplied to the sandbox policy", async () => {
		const tool = createWebBrowseTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_browse sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-web-browse-no-url",
			requestedToolName: "web_browse",
			resolvedToolName: "web_browse",
			parsedArguments: {},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		if (request == null) throw new Error("expected sandbox request");
		expect(request.signals?.network?.destination).toBeUndefined();
	});
});
