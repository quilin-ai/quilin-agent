import { describe, expect, it } from "vitest";
import {
	DSPY_OFFLINE_OPTIMIZER_ID,
	DSPY_OPTIMIZE_TOOL_NAME,
	DspyOfflineOptimizer,
	type DspyOptimizerMCPClient,
	DspyOptimizerProtocolError,
} from "./dspy-offline-optimizer.js";
import {
	type FailureAnalysis,
	SELF_EVOLUTION_SCHEMA_VERSION,
	type StoredTrajectoryRecord,
} from "./types.js";

const FIXED_NOW = () => new Date("2026-05-09T00:00:00.000Z");

interface RecordedCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

class FakeMCPClient implements DspyOptimizerMCPClient {
	readonly calls: RecordedCall[] = [];
	private readonly responder:
		| string
		| ((args: Record<string, unknown>) => string | Promise<string>)
		| Error;

	constructor(
		responder:
			| string
			| ((args: Record<string, unknown>) => string | Promise<string>)
			| Error,
	) {
		this.responder = responder;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		this.calls.push({ name, args });
		if (this.responder instanceof Error) {
			throw this.responder;
		}
		if (typeof this.responder === "function") {
			return await this.responder(args);
		}
		return this.responder;
	}
}

function trajectory(
	overrides: Partial<StoredTrajectoryRecord> = {},
): StoredTrajectoryRecord {
	return {
		schemaVersion: 1,
		runId: "run-001",
		taskRef: "QUI-118",
		outcome: "failure",
		createdAt: "2026-05-09T00:00:00.000Z",
		trajectoryRef: "trajectory:run-001",
		contentHash: "a".repeat(64),
		steps: [
			{
				index: 0,
				kind: "tool",
				label: "shell_exec",
				error: "command failed with exit code 2",
				evidenceRefs: ["tool-call:1"],
			},
		],
		failures: [],
		...overrides,
	};
}

function stubServerPayload(
	overrides: Partial<{
		proposals: unknown[];
		no_proposal_reasons: unknown[];
	}> = {},
): string {
	return JSON.stringify({
		schema_version: SELF_EVOLUTION_SCHEMA_VERSION,
		optimizer_id: "dspy-stub",
		mode: "prompt_rewrite",
		created_at: "2026-05-09T00:00:00.000Z",
		stage: "A",
		dry_run: false,
		proposals: overrides.proposals ?? [
			{
				title: "DSPy placeholder optimization proposal",
				summary: "Stage A placeholder summary.",
				artifacts: [
					{
						artifactId: "artifact:abc",
						kind: "markdown",
						title: "DSPy stub summary",
						content: "# DSPy stub\n\nplaceholder body",
						contentHash: "deadbeef",
						sourceRefs: ["trajectory:run-001"],
					},
					{
						artifactId: "artifact:def",
						kind: "json",
						title: "DSPy stub payload",
						content: '{"stage":"A"}',
						contentHash: "cafebabe",
						sourceRefs: ["trajectory:run-001"],
					},
				],
				evidenceHashes: ["deadbeef", "cafebabe"],
				riskPreview: {
					level: "medium",
					reasons: ["DSPy stub proposal is a deterministic placeholder."],
					touchesRuntime: false,
					requiresHumanReview: true,
				},
				metadata: {
					optimizer_id: "dspy-stub",
					stage: "A",
					application_mode: "proposal_only",
				},
			},
		],
		no_proposal_reasons: overrides.no_proposal_reasons ?? [],
	});
}

describe("DspyOfflineOptimizer", () => {
	it("requires an MCP client", () => {
		expect(
			() =>
				new DspyOfflineOptimizer({
					client: undefined as unknown as DspyOptimizerMCPClient,
				}),
		).toThrow(/requires an MCP client/);
	});

	it("forwards trajectories + failure_categories + dry_run to the MCP tool", async () => {
		const client = new FakeMCPClient(stubServerPayload());
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		const result = await optimizer.optimize({
			trajectories: [trajectory()],
			dryRun: true,
		});

		expect(client.calls).toHaveLength(1);
		const call = client.calls[0];
		expect(call?.name).toBe(DSPY_OPTIMIZE_TOOL_NAME);
		expect(call?.args.dry_run).toBe(true);
		const trajectoriesArg = call?.args.trajectories as ReadonlyArray<
			Record<string, unknown>
		>;
		expect(trajectoriesArg).toHaveLength(1);
		expect(trajectoriesArg[0]).toMatchObject({
			trajectoryRef: "trajectory:run-001",
			runId: "run-001",
			taskRef: "QUI-118",
		});
		const categories = call?.args.failure_categories as readonly string[];
		// trajectory() above has a tool error step → category = tool_error.
		expect(categories).toContain("tool_error");

		expect(result.optimizerId).toBe(DSPY_OFFLINE_OPTIMIZER_ID);
		expect(result.mode).toBe("prompt_rewrite");
		expect(result.proposals).toHaveLength(1);
		const proposal = result.proposals[0];
		expect(proposal?.title).toBe("DSPy placeholder optimization proposal");
		expect(proposal?.artifacts).toHaveLength(2);
		expect(proposal?.artifacts[0]?.kind).toBe("markdown");
		expect(proposal?.artifacts[1]?.kind).toBe("json");
		expect(proposal?.riskPreview.level).toBe("medium");
		expect(proposal?.riskPreview.requiresHumanReview).toBe(true);
		expect(result.createdAt).toBe("2026-05-09T00:00:00.000Z");
	});

	it("returns an empty result with no_failure_detected for an empty trajectory list", async () => {
		const client = new FakeMCPClient("UNUSED");
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		const result = await optimizer.optimize({ trajectories: [] });

		expect(client.calls).toHaveLength(0);
		expect(result.proposals).toHaveLength(0);
		expect(result.noProposalReasons).toHaveLength(1);
		expect(result.noProposalReasons[0]?.code).toBe("no_failure_detected");
	});

	it("decodes no_proposal_reasons from the MCP response", async () => {
		const client = new FakeMCPClient(
			stubServerPayload({
				proposals: [],
				no_proposal_reasons: [
					{
						code: "insufficient_signal",
						message: "DSPy stub requires categories.",
						evidenceRefs: ["trajectory:run-001"],
					},
				],
			}),
		);
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		const result = await optimizer.optimize({
			trajectories: [trajectory()],
		});

		expect(result.proposals).toHaveLength(0);
		expect(result.noProposalReasons).toHaveLength(1);
		expect(result.noProposalReasons[0]?.code).toBe("insufficient_signal");
		expect(result.noProposalReasons[0]?.evidenceRefs).toContain(
			"trajectory:run-001",
		);
	});

	it("propagates errors when the MCP client throws", async () => {
		const client = new FakeMCPClient(new Error("connection lost"));
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		await expect(
			optimizer.optimize({ trajectories: [trajectory()] }),
		).rejects.toThrow(/connection lost/);
	});

	it("rejects non-JSON MCP responses with a protocol error", async () => {
		const client = new FakeMCPClient("not-json-payload");
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		await expect(
			optimizer.optimize({ trajectories: [trajectory()] }),
		).rejects.toBeInstanceOf(DspyOptimizerProtocolError);
	});

	it("treats a server-side error payload as a protocol error", async () => {
		const client = new FakeMCPClient(
			JSON.stringify({ error: "DSPy stub exploded" }),
		);
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		await expect(
			optimizer.optimize({ trajectories: [trajectory()] }),
		).rejects.toBeInstanceOf(DspyOptimizerProtocolError);
	});

	it("uses the caller-provided FailureAnalysis to extract failure categories", async () => {
		const client = new FakeMCPClient(stubServerPayload({ proposals: [] }));
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		const fakeAnalysis: FailureAnalysis = {
			schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
			runId: "run-001",
			trajectoryRef: "trajectory:run-001",
			findings: [
				{
					category: "schema_violation",
					confidence: "high",
					message: "schema violated",
					evidenceRefs: ["evidence:1"],
					proposalAllowed: true,
				},
				{
					category: "budget_exhaustion",
					confidence: "medium",
					message: "budget hit",
					evidenceRefs: ["evidence:2"],
					proposalAllowed: false,
				},
			],
			noProposalReasons: [],
			shouldPropose: true,
		};

		await optimizer.optimize({
			trajectories: [trajectory()],
			analyses: [fakeAnalysis],
		});

		const call = client.calls[0];
		const categories = call?.args.failure_categories as readonly string[];
		expect([...categories].sort()).toEqual(
			["budget_exhaustion", "schema_violation"].sort(),
		);
	});

	it("sanitizes secret-like content in artifact bodies", async () => {
		const client = new FakeMCPClient(
			stubServerPayload({
				proposals: [
					{
						title: "DSPy proposal",
						summary: "summary",
						artifacts: [
							{
								artifactId: "artifact:secret",
								kind: "markdown",
								title: "Leaks",
								content: "token: sk-abcdefghijklmnop123456",
								sourceRefs: ["trajectory:run-001"],
							},
						],
						evidenceHashes: ["x"],
						riskPreview: {
							level: "medium",
							reasons: [],
							touchesRuntime: false,
							requiresHumanReview: true,
						},
					},
				],
			}),
		);
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		const result = await optimizer.optimize({
			trajectories: [trajectory()],
		});
		const artifact = result.proposals[0]?.artifacts[0];
		expect(artifact?.content).not.toContain("sk-abcdefghijklmnop123456");
		expect(artifact?.content).toContain("[REDACTED]");
	});

	it("rejects malformed input (non-array trajectories)", async () => {
		const client = new FakeMCPClient("UNUSED");
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		await expect(
			optimizer.optimize({
				trajectories: "not-an-array",
			} as unknown as Parameters<typeof optimizer.optimize>[0]),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("forwards the caller-provided now() over the optimizer default", async () => {
		const client = new FakeMCPClient(stubServerPayload({ proposals: [] }));
		const optimizer = new DspyOfflineOptimizer({
			client,
			now: FIXED_NOW,
		});

		const result = await optimizer.optimize({
			trajectories: [trajectory()],
			now: () => new Date("2030-01-01T00:00:00.000Z"),
		});

		expect(result.createdAt).toBe("2030-01-01T00:00:00.000Z");
	});
});
