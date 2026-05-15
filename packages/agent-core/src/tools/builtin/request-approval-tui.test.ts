/**
 * Unit tests for `request_approval` TUI tool — Iter F Slice 3c.
 */

import { describe, expect, it, vi } from "vitest";
import {
	createRequestApprovalTuiTool,
	formatDecisionForLlm,
	parseRawDecision,
	type RequestApprovalTuiInput,
} from "./request-approval-tui.js";

function makeStubStream(): NodeJS.WriteStream {
	const stream = {
		write: (_chunk: string | Uint8Array) => true,
	} as unknown as NodeJS.WriteStream;
	return stream;
}

const baseInput: RequestApprovalTuiInput = {
	tool: "shell_exec",
	riskLevel: "medium",
	summary: "rm -rf /tmp/build-artifacts",
	origin: "agent",
};

describe("request_approval TUI tool", () => {
	it("'y' input → allow decision", async () => {
		const promptOverride = vi.fn(async () => "y");
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute(baseInput);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("decision=allow");
	});

	it("'n' input → deny decision", async () => {
		const promptOverride = vi.fn(async () => "n");
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute(baseInput);
		expect(result.content).toContain("decision=deny");
	});

	it("empty input → deny (matches web syntheticTimeoutReply for user_decision)", async () => {
		const promptOverride = vi.fn(async () => "");
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute(baseInput);
		expect(result.content).toContain("decision=deny");
	});

	it("null input (EOF / Ctrl-D) → deny", async () => {
		const promptOverride = vi.fn(async () => null);
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute(baseInput);
		expect(result.content).toContain("decision=deny");
	});

	it("'a' on medium risk → allow_always_medium", async () => {
		const promptOverride = vi.fn(async () => "a");
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute(baseInput);
		expect(result.content).toContain("decision=allow_always_medium");
	});

	it("'a' on low risk → allow_always_low", async () => {
		const promptOverride = vi.fn(async () => "a");
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({ ...baseInput, riskLevel: "low" });
		expect(result.content).toContain("decision=allow_always_low");
	});

	it("'a' on high risk → falls back to allow-once (not supported for always)", async () => {
		const promptOverride = vi.fn(async () => "a");
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({ ...baseInput, riskLevel: "high" });
		expect(result.content).toContain("decision=allow");
		expect(result.content).not.toContain("decision=allow_always");
	});

	it("unrecognized input ('maybe') → deny (safe default)", async () => {
		const promptOverride = vi.fn(async () => "maybe");
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute(baseInput);
		expect(result.content).toContain("decision=deny");
	});

	it("case-insensitive: 'YES' / 'NO' / 'Allow' all parse", () => {
		expect(parseRawDecision("YES", baseInput)).toBe("allow");
		expect(parseRawDecision("NO", baseInput)).toBe("deny");
		expect(parseRawDecision("Allow", baseInput)).toBe("allow");
		expect(parseRawDecision("Deny", baseInput)).toBe("deny");
	});

	it("invalid input shape → isError=true with invalid_arguments", async () => {
		const tool = createRequestApprovalTuiTool({ stderr: makeStubStream() });
		const result = await tool.execute({
			tool: "rm; cat /etc/passwd", // disallowed by regex
			riskLevel: "high",
			summary: "...",
			origin: "agent",
		});
		expect(result.isError).toBe(true);
		expect(result.error?.code).toBe("invalid_arguments");
	});

	it("respects caller-provided timeoutMs", async () => {
		const promptOverride = vi.fn(async (_rendered: string, timeoutMs: number) => {
			expect(timeoutMs).toBe(20_000);
			return "y";
		});
		const tool = createRequestApprovalTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		await tool.execute({ ...baseInput, timeoutMs: 20_000 });
		expect(promptOverride).toHaveBeenCalled();
	});

	it("formatDecisionForLlm defensive fallback on unknown decision", () => {
		const result = formatDecisionForLlm(
			// biome-ignore lint/suspicious/noExplicitAny: deliberately bad branch coverage
			"made-up-decision" as any,
			baseInput,
		);
		expect(result).toContain("decision=unknown");
	});
});
