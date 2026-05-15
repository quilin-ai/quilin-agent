/**
 * Unit tests for `wrapToolWithApproval` — Path B server-side gate.
 */

import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentReplyPayload, AgentServiceLike } from "@/lib/agent-service-client";
import { _resetApprovalWhitelistForTests, wrapToolWithApproval } from "@/lib/tools/with-approval";

function makeFakeService(): {
	service: AgentServiceLike;
	emitted: Array<{ sessionId: string; payload: unknown }>;
} {
	const emitted: Array<{ sessionId: string; payload: unknown }> = [];
	const service = {
		emitFromRunner: (sessionId: string, payload: unknown) => {
			emitted.push({ sessionId, payload });
		},
	} as unknown as AgentServiceLike;
	return { service, emitted };
}

function makeDangerousTool() {
	let invocations = 0;
	const t = tool({
		description: "pretend shell_exec",
		inputSchema: z.object({ command: z.string() }),
		execute: async (args: { command: string }) => {
			invocations += 1;
			return { content: `ran: ${args.command}`, isError: false };
		},
	});
	return { t, getInvocations: () => invocations };
}

type UserDecisionKind = "allow" | "deny" | "allow_always_low" | "allow_always_medium";

function syntheticReply(decision: UserDecisionKind) {
	return () => ({
		askToken: "tok",
		reply: Promise.resolve<AgentReplyPayload>({
			kind: "user_decision",
			askId: "fixed",
			decision,
		}),
	});
}

describe("wrapToolWithApproval", () => {
	it("runs inner execute when decision=allow", async () => {
		_resetApprovalWhitelistForTests();
		const { service, emitted } = makeFakeService();
		const { t, getInvocations } = makeDangerousTool();
		const wrapped = wrapToolWithApproval(t, {
			sessionId: "s-1",
			service,
			toolName: "shell_exec",
			riskLevel: "high",
			awaitAsk: syntheticReply("allow"),
			generateAskId: () => "fixed",
			summarize: (input: unknown) => ({ summary: `cmd=${(input as { command: string }).command}` }),
		});
		const result = await (wrapped.execute as NonNullable<typeof wrapped.execute>)(
			{ command: "ls" },
			{ toolCallId: "tc-1", messages: [] },
		);
		expect(getInvocations()).toBe(1);
		expect(emitted).toHaveLength(1);
		const payload = emitted[0]?.payload as Record<string, unknown>;
		expect(payload.type).toBe("request_approval");
		expect(payload.tool).toBe("shell_exec");
		expect((result as { isError: boolean }).isError).toBe(false);
	});

	it("blocks inner execute when decision=deny", async () => {
		_resetApprovalWhitelistForTests();
		const { service } = makeFakeService();
		const { t, getInvocations } = makeDangerousTool();
		const wrapped = wrapToolWithApproval(t, {
			sessionId: "s-2",
			service,
			toolName: "shell_exec",
			riskLevel: "high",
			awaitAsk: syntheticReply("deny"),
			generateAskId: () => "fixed",
			summarize: () => ({ summary: "..." }),
		});
		const result = await (wrapped.execute as NonNullable<typeof wrapped.execute>)(
			{ command: "rm -rf /" },
			{ toolCallId: "tc-2", messages: [] },
		);
		expect(getInvocations()).toBe(0); // inner never ran
		expect((result as { isError: boolean }).isError).toBe(true);
		expect((result as { error?: { code: string } }).error?.code).toBe("tool_denied");
	});

	it("allow_always_low whitelists subsequent low-risk calls in the same session", async () => {
		_resetApprovalWhitelistForTests();
		const { service, emitted } = makeFakeService();
		const { t, getInvocations } = makeDangerousTool();
		const awaitAsk = vi.fn(() => ({
			askToken: "tok",
			reply: Promise.resolve<AgentReplyPayload>({
				kind: "user_decision",
				askId: "x",
				decision: "allow_always_low",
			}),
		}));
		const wrapped = wrapToolWithApproval(t, {
			sessionId: "s-3",
			service,
			toolName: "file_write",
			riskLevel: "low",
			awaitAsk,
			generateAskId: () => "x",
			summarize: () => ({ summary: "..." }),
		});
		// First call → asks, gets allow_always_low → runs.
		await (wrapped.execute as NonNullable<typeof wrapped.execute>)(
			{ command: "first" },
			{ toolCallId: "tc-1", messages: [] },
		);
		// Second call → whitelist hit → runs without asking.
		await (wrapped.execute as NonNullable<typeof wrapped.execute>)(
			{ command: "second" },
			{ toolCallId: "tc-2", messages: [] },
		);
		expect(getInvocations()).toBe(2);
		expect(awaitAsk).toHaveBeenCalledTimes(1); // only first call asked
		expect(emitted).toHaveLength(1); // only first call emitted event
	});

	it("allow_always_medium also whitelists low (transitive)", async () => {
		_resetApprovalWhitelistForTests();
		const { service } = makeFakeService();
		const { t, getInvocations } = makeDangerousTool();

		// First wrap as medium → user picks allow_always_medium.
		const mediumWrapped = wrapToolWithApproval(t, {
			sessionId: "s-4",
			service,
			toolName: "file_write",
			riskLevel: "medium",
			awaitAsk: syntheticReply("allow_always_medium"),
			generateAskId: () => "x",
			summarize: () => ({ summary: "..." }),
		});
		await (mediumWrapped.execute as NonNullable<typeof mediumWrapped.execute>)(
			{ command: "first-med" },
			{ toolCallId: "tc-1", messages: [] },
		);

		// Now a LOW-risk wrap for the same session — should short-circuit.
		const awaitAskSpy = vi.fn();
		const lowWrapped = wrapToolWithApproval(t, {
			sessionId: "s-4",
			service,
			toolName: "memory_recall",
			riskLevel: "low",
			awaitAsk: awaitAskSpy,
			generateAskId: () => "y",
			summarize: () => ({ summary: "..." }),
		});
		await (lowWrapped.execute as NonNullable<typeof lowWrapped.execute>)(
			{ command: "second-low" },
			{ toolCallId: "tc-2", messages: [] },
		);
		expect(awaitAskSpy).not.toHaveBeenCalled(); // low pre-whitelisted
		expect(getInvocations()).toBe(2); // both ran
	});

	it("high risk NEVER short-circuits even if a session had allow_always_*", async () => {
		_resetApprovalWhitelistForTests();
		const { service } = makeFakeService();
		const { t, getInvocations } = makeDangerousTool();

		// Pretend a previous medium decision whitelisted medium+low.
		const mediumWrapped = wrapToolWithApproval(t, {
			sessionId: "s-5",
			service,
			toolName: "x",
			riskLevel: "medium",
			awaitAsk: syntheticReply("allow_always_medium"),
			generateAskId: () => "x",
			summarize: () => ({ summary: "..." }),
		});
		await (mediumWrapped.execute as NonNullable<typeof mediumWrapped.execute>)(
			{ command: "med" },
			{ toolCallId: "tc-1", messages: [] },
		);

		// Now a high-risk call → MUST still ask.
		const askSpy = vi.fn(() => ({
			askToken: "tok",
			reply: Promise.resolve<AgentReplyPayload>({
				kind: "user_decision",
				askId: "z",
				decision: "allow",
			}),
		}));
		const highWrapped = wrapToolWithApproval(t, {
			sessionId: "s-5",
			service,
			toolName: "shell_exec",
			riskLevel: "high",
			awaitAsk: askSpy,
			generateAskId: () => "z",
			summarize: () => ({ summary: "..." }),
		});
		await (highWrapped.execute as NonNullable<typeof highWrapped.execute>)(
			{ command: "danger" },
			{ toolCallId: "tc-2", messages: [] },
		);
		expect(askSpy).toHaveBeenCalled(); // even with whitelist active, high asks
		expect(getInvocations()).toBe(2);
	});

	it("returns pass-through tool when inner has no execute", () => {
		_resetApprovalWhitelistForTests();
		const { service } = makeFakeService();
		const innerNoExecute = {
			description: "metadata-only",
			parameters: undefined,
		} as unknown as Parameters<typeof wrapToolWithApproval>[0];
		const wrapped = wrapToolWithApproval(innerNoExecute, {
			sessionId: "s",
			service,
			toolName: "shell_exec",
			riskLevel: "high",
			summarize: () => ({ summary: "..." }),
		});
		expect(wrapped).toBe(innerNoExecute); // pass-through, no wrapping
	});
});
