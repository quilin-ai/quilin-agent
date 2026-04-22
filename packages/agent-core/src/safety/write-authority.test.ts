import { describe, expect, it, vi } from "vitest";
import {
	type AuditRecord,
	WriteAuthority,
	type WriteAuthorityOptions,
	type WriteDecision,
	type WriteRequest,
} from "./write-authority.js";

function createRequest(overrides: Partial<WriteRequest> = {}): WriteRequest {
	return {
		tool: "shell_exec",
		riskLevel: "low",
		summary: "echo hello",
		origin: "agent",
		...overrides,
	};
}

describe("WriteAuthority", () => {
	it("applies the MVP decision matrix across mode, origin, and risk", () => {
		const cases: ReadonlyArray<{
			mode: WriteAuthorityOptions["mode"];
			request: WriteRequest;
			expected: WriteDecision["kind"];
		}> = [
			{
				mode: "ask",
				request: createRequest({ origin: "user", riskLevel: "low" }),
				expected: "confirm",
			},
			{
				mode: "ask",
				request: createRequest({ origin: "agent", riskLevel: "critical" }),
				expected: "confirm",
			},
			{
				mode: "auto-low",
				request: createRequest({ origin: "agent", riskLevel: "low" }),
				expected: "allow",
			},
			{
				mode: "auto-low",
				request: createRequest({ origin: "agent", riskLevel: "medium" }),
				expected: "confirm",
			},
			{
				mode: "auto-medium",
				request: createRequest({ origin: "agent", riskLevel: "medium" }),
				expected: "allow",
			},
			{
				mode: "auto-medium",
				request: createRequest({ origin: "idle", riskLevel: "low" }),
				expected: "allow",
			},
			{
				mode: "auto-medium",
				request: createRequest({ origin: "agent", riskLevel: "critical" }),
				expected: "confirm",
			},
			{
				mode: "deny-all",
				request: createRequest({ origin: "user", riskLevel: "low" }),
				expected: "deny",
			},
			{
				mode: "ask",
				request: createRequest({ origin: "idle", riskLevel: "low" }),
				expected: "deny",
			},
		];

		for (const testCase of cases) {
			const authority = new WriteAuthority({ mode: testCase.mode });
			expect(authority.decide(testCase.request).kind).toBe(testCase.expected);
		}
	});

	it("upgrades confirm decisions into allow when the confirm hook accepts", async () => {
		const confirm = vi.fn(async () => true);
		const authority = new WriteAuthority({
			mode: "ask",
			confirm,
		});

		const decision = await authority.authorize(
			createRequest({ origin: "agent", riskLevel: "medium" }),
		);

		expect(decision).toEqual({ kind: "allow" });
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it("turns confirm decisions into deny when there is no interactive confirmer", async () => {
		const authority = new WriteAuthority({ mode: "ask" });

		const decision = await authority.authorize(
			createRequest({ origin: "agent", riskLevel: "medium" }),
		);

		expect(decision).toEqual({
			kind: "deny",
			reason: expect.stringContaining("confirmation"),
		});
	});

	it("records audit entries for final decisions", async () => {
		const auditRecords: AuditRecord[] = [];
		const authority = new WriteAuthority({
			mode: "deny-all",
			actor: "session-123",
			auditLog: (record) => {
				auditRecords.push(record);
			},
		});

		const request = createRequest({ riskLevel: "medium" });
		const decision = await authority.authorize(request);

		expect(decision.kind).toBe("deny");
		expect(auditRecords).toEqual([
			expect.objectContaining({
				request,
				decision,
				actor: "session-123",
				timestamp: expect.any(Number),
			}),
		]);
	});

	it("does not fail authorization when audit logging throws", async () => {
		const authority = new WriteAuthority({
			mode: "auto-low",
			auditLog: () => {
				throw new Error("disk full");
			},
		});

		await expect(
			authority.authorize(createRequest({ riskLevel: "low" })),
		).resolves.toEqual({ kind: "allow" });
	});

	it("allows the session mode to be updated explicitly", () => {
		const authority = new WriteAuthority({ mode: "ask" });

		authority.setMode("auto-low");

		expect(
			authority.decide(createRequest({ origin: "agent", riskLevel: "low" })),
		).toEqual({ kind: "allow" });
	});
});
