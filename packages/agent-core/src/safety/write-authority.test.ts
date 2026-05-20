import { describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import {
	type AuditRecord,
	WriteAuthority,
	type WriteAuthorityOptions,
	type WriteDecision,
	type WriteRequest,
} from "./write-authority.js";

vi.mock("../logger.js", () => ({
	logger: {
		warn: vi.fn(),
	},
}));

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
	it("defaults to ask mode and system actor", async () => {
		const auditRecords: AuditRecord[] = [];
		const authority = new WriteAuthority({
			auditLog: (record) => {
				auditRecords.push(record);
			},
		});

		expect(authority.getMode()).toBe("ask");

		await expect(
			authority.authorize(createRequest({ origin: "idle", riskLevel: "low" })),
		).resolves.toEqual({
			kind: "deny",
			reason: "idle writes require explicit AUTO opt-in",
		});
		expect(auditRecords[0]?.actor).toBe("system");
	});

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
			{
				mode: "auto-all",
				request: createRequest({ origin: "install", riskLevel: "critical" }),
				expected: "confirm",
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

	it("turns rejected or failed confirmations into deny decisions", async () => {
		const rejected = new WriteAuthority({
			mode: "ask",
			confirm: vi.fn(async () => false),
		});
		await expect(
			rejected.authorize(
				createRequest({ origin: "agent", riskLevel: "medium" }),
			),
		).resolves.toEqual({
			kind: "deny",
			reason: "write request not approved",
		});

		const failedWithError = new WriteAuthority({
			mode: "ask",
			confirm: vi.fn(async () => {
				throw new Error("tty closed");
			}),
		});
		await expect(
			failedWithError.authorize(
				createRequest({ origin: "agent", riskLevel: "medium" }),
			),
		).resolves.toEqual({
			kind: "deny",
			reason: "write confirmation failed: tty closed",
		});

		const failedWithUnknown = new WriteAuthority({
			mode: "ask",
			confirm: vi.fn(async () => {
				throw "closed";
			}),
		});
		await expect(
			failedWithUnknown.authorize(
				createRequest({ origin: "agent", riskLevel: "medium" }),
			),
		).resolves.toEqual({
			kind: "deny",
			reason: "write confirmation failed",
		});
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

	it("does not fail authorization when async audit logging rejects", async () => {
		vi.mocked(logger.warn).mockClear();
		const authority = new WriteAuthority({
			mode: "auto-low",
			auditLog: async () => {
				throw new Error("remote audit down");
			},
		});

		await expect(
			authority.authorize(createRequest({ riskLevel: "low" })),
		).resolves.toEqual({ kind: "allow" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				err: expect.any(Error),
				tool: "shell_exec",
				actor: "system",
			}),
			"WriteAuthority audit logging failed",
		);
	});

	it("allows the session mode to be updated explicitly", () => {
		const authority = new WriteAuthority({ mode: "ask" });

		authority.setMode("auto-low");

		expect(
			authority.decide(createRequest({ origin: "agent", riskLevel: "low" })),
		).toEqual({ kind: "allow" });
	});
});
