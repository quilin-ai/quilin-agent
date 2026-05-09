import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	WriteAuthority,
	type WriteRequest,
} from "../safety/write-authority.js";
import {
	createBeforeAfterEvaluation,
	createGeneratedPatchProposal,
} from "./patch-proposal.js";
import {
	buildProposalReviewQueueView,
	JsonlProposalStore,
	type ProposalPatchApplierContext,
	transitionProposalAppliedState,
	transitionProposalReviewState,
	UnsupportedPatchTypeError,
} from "./proposal-store.js";
import {
	DockerProposalSandboxPolicyGate,
	type ProposalSandboxPolicyGate,
} from "./sandbox-policy-gate.js";
import type {
	CandidateArtifact,
	ProposalRecordInput,
	StoredProposalRecord,
} from "./types.js";

let tmpDir: string;

beforeEach(async () => {
	const { mkdtemp } = await import("node:fs/promises");
	tmpDir = await mkdtemp(path.join(tmpdir(), "quilin-proposal-store-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

function artifact(): CandidateArtifact {
	return {
		artifactId: "artifact:1",
		kind: "markdown",
		title: "Review summary",
		content: "Review this finding.",
		contentHash: "c".repeat(64),
		sourceRefs: ["trajectory:1", "QUI-45"],
	};
}

function proposal(
	overrides: Partial<ProposalRecordInput> = {},
): ProposalRecordInput {
	return {
		title: "Review failure",
		summary: "A review-only proposal.",
		artifacts: [artifact()],
		evidenceHashes: ["d".repeat(64)],
		riskPreview: {
			level: "low",
			reasons: ["artifact-only"],
			touchesRuntime: false,
			requiresHumanReview: true,
		},
		...overrides,
	};
}

function beforeAfterEvaluation() {
	return createBeforeAfterEvaluation({
		baselineLabel: "Current behavior",
		candidateLabel: "Generated patch proposal",
		summary: "Static comparison for reviewer triage.",
		evidenceRefs: ["trajectory:1", "QUI-45"],
		metrics: [
			{
				name: "reviewable proposal coverage",
				baselineValue: 0,
				candidateValue: 1,
				unit: "proposals",
				direction: "increase_is_better",
				evidenceRefs: ["trajectory:1", "QUI-45"],
			},
		],
	});
}

function generatedPatchProposal(evaluationId: string) {
	return createGeneratedPatchProposal({
		proposalKind: "scaffold_patch",
		title: "Review-only self-evolution patch",
		summary: "Synthetic diff for human review.",
		sourceRefs: ["trajectory:1", "QUI-45"],
		beforeAfterEvaluationId: evaluationId,
		rollbackPlan:
			"No rollback is needed before a human applies a reviewed change.",
		fileChanges: [
			{
				path: "packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
				changeKind: "modify",
				summary: "Add a regression fixture before changing runtime behavior.",
				unifiedDiff: [
					"--- a/packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
					"+++ b/packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
					"@@ synthetic review proposal @@",
					"+// proposal only",
				].join("\n"),
			},
		],
	});
}

function reviewQueueItem(record: StoredProposalRecord) {
	return {
		proposalId: record.proposalId,
		title: record.title,
		createdAt: record.createdAt,
	};
}

function compareStoredProposalIds(
	left: StoredProposalRecord,
	right: StoredProposalRecord,
): number {
	if (left.proposalId < right.proposalId) {
		return -1;
	}
	if (left.proposalId > right.proposalId) {
		return 1;
	}
	return 0;
}

describe("JsonlProposalStore", () => {
	it("defaults proposal status to pending_review and preserves risk/evidence fields", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "proposals.jsonl"),
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		const stored = await store.append(proposal());
		const fetched = await store.getById(stored.proposalId);

		expect(stored.status).toBe("pending_review");
		expect(stored.schemaVersion).toBe(1);
		expect(stored.contentHash).toHaveLength(64);
		expect(fetched?.riskPreview).toEqual(stored.riskPreview);
		expect(fetched?.evidenceHashes).toEqual(["d".repeat(64)]);
	});

	it("requires human review and evidence hashes", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "invalid.jsonl"),
		});

		await expect(
			store.append(
				proposal({
					evidenceHashes: [],
				}),
			),
		).rejects.toThrow(/evidence hash/u);
		await expect(
			store.append(
				proposal({
					riskPreview: {
						level: "low",
						reasons: [],
						touchesRuntime: false,
						requiresHumanReview: false as true,
					},
				}),
			),
		).rejects.toThrow(/human review/u);
	});

	it("persists generated patch proposals with before/after evaluation", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "patch-proposals.jsonl"),
		});
		const evaluation = beforeAfterEvaluation();
		const patchProposal = generatedPatchProposal(evaluation.evaluationId);

		const stored = await store.append(
			proposal({
				riskPreview: {
					level: "critical",
					reasons: ["synthetic patch proposal"],
					touchesRuntime: true,
					requiresHumanReview: true,
				},
				beforeAfterEvaluation: evaluation,
				generatedPatchProposal: patchProposal,
			}),
		);
		const fetched = await store.getById(stored.proposalId);

		expect(stored.status).toBe("pending_review");
		expect(stored.generatedPatchProposal?.reviewState).toBe(
			"pending_human_review",
		);
		expect(stored.generatedPatchProposal?.safetyBoundary.autoApplyAllowed).toBe(
			false,
		);
		expect(stored.generatedPatchProposal?.writeAuthorityPreview).toMatchObject({
			tool: "scaffold_patch",
			riskLevel: "critical",
			origin: "agent",
			requiresConfirmation: true,
			auditRequired: true,
		});
		expect(stored.beforeAfterEvaluation?.requiresHumanReview).toBe(true);
		expect(fetched?.generatedPatchProposal?.beforeAfterEvaluationId).toBe(
			fetched?.beforeAfterEvaluation?.evaluationId,
		);
		expect(fetched?.generatedPatchProposal?.fileChanges).toEqual(
			patchProposal.fileChanges,
		);
	});

	it("rejects generated patch proposals without a source issue taskRef anchor", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "patch-proposals-no-task-ref.jsonl"),
		});
		const evaluation = createBeforeAfterEvaluation({
			baselineLabel: "Current behavior",
			candidateLabel: "Generated patch proposal",
			summary: "Static comparison for reviewer triage.",
			evidenceRefs: ["trajectory:1"],
			metrics: [
				{
					name: "reviewable proposal coverage",
					baselineValue: 0,
					candidateValue: 1,
					unit: "proposals",
					direction: "increase_is_better",
					evidenceRefs: ["trajectory:1"],
				},
			],
		});
		const patchProposal = createGeneratedPatchProposal({
			proposalKind: "scaffold_patch",
			title: "Review-only self-evolution patch",
			summary: "Synthetic diff for human review.",
			sourceRefs: ["trajectory:1"],
			beforeAfterEvaluationId: evaluation.evaluationId,
			rollbackPlan:
				"No rollback is needed before a human applies a reviewed change.",
			fileChanges: [
				{
					path: "packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
					changeKind: "modify",
					summary: "Add a regression fixture before changing runtime behavior.",
					unifiedDiff: [
						"--- a/packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
						"+++ b/packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
						"@@ synthetic review proposal @@",
						"+// proposal only",
					].join("\n"),
				},
			],
		});

		await expect(
			store.append(
				proposal({
					artifacts: [
						{
							...artifact(),
							sourceRefs: ["trajectory:1"],
						},
					],
					riskPreview: {
						level: "critical",
						reasons: ["synthetic patch proposal"],
						touchesRuntime: true,
						requiresHumanReview: true,
					},
					beforeAfterEvaluation: evaluation,
					generatedPatchProposal: patchProposal,
				}),
			),
		).rejects.toThrow(/source issue taskRef/u);
	});

	it("rejects generated patch proposals that bypass review or path scope", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "unsafe-patch-proposals.jsonl"),
		});
		const evaluation = beforeAfterEvaluation();
		const patchProposal = generatedPatchProposal(evaluation.evaluationId);
		const [firstFileChange] = patchProposal.fileChanges;
		if (firstFileChange === undefined) {
			throw new Error("Test proposal must include a file change");
		}

		await expect(
			store.append(
				proposal({
					riskPreview: {
						level: "critical",
						reasons: ["synthetic patch proposal"],
						touchesRuntime: true,
						requiresHumanReview: true,
					},
					beforeAfterEvaluation: evaluation,
					generatedPatchProposal: {
						...patchProposal,
						safetyBoundary: {
							...patchProposal.safetyBoundary,
							autoApplyAllowed: true as false,
						},
					},
				}),
			),
		).rejects.toThrow(/auto-apply/u);

		await expect(
			store.append(
				proposal({
					riskPreview: {
						level: "critical",
						reasons: ["synthetic patch proposal"],
						touchesRuntime: true,
						requiresHumanReview: true,
					},
					beforeAfterEvaluation: evaluation,
					generatedPatchProposal: {
						...patchProposal,
						fileChanges: [
							{
								...firstFileChange,
								path: "agent-bridge.md",
							},
						],
					},
				}),
			),
		).rejects.toThrow(/allowed prefixes/u);

		await expect(
			store.append(
				proposal({
					riskPreview: {
						level: "high",
						reasons: ["synthetic patch proposal"],
						touchesRuntime: true,
						requiresHumanReview: true,
					},
					beforeAfterEvaluation: evaluation,
					generatedPatchProposal: patchProposal,
				}),
			),
		).rejects.toThrow(/critical/u);
	});

	it("forces generated records back to pending_review and sanitizes artifacts", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "safe.jsonl"),
		});

		const stored = await store.append(
			proposal({
				proposalId: "caller-controlled-sk-secret1234567890",
				status: "approved",
				artifacts: [
					{
						...artifact(),
						content: "Review sk-secret1234567890 before approval.",
						sourceRefs: [
							" trajectory:1 ",
							" ",
							"Bearer secret-source-ref-123456",
						],
					},
				],
				metadata: {
					token: "sk-secret1234567890",
					owner: "agent-core",
				},
			} as unknown as ProposalRecordInput),
		);

		expect(stored.status).toBe("pending_review");
		expect(stored.proposalId).toMatch(/^proposal:/u);
		expect(stored.proposalId).not.toContain("caller-controlled");
		expect(stored.artifacts[0]?.content).not.toContain("sk-secret1234567890");
		expect(stored.artifacts[0]?.content).toContain("[REDACTED]");
		expect(stored.artifacts[0]?.sourceRefs).toEqual([
			"trajectory:1",
			"[REDACTED]",
		]);
		expect(stored.metadata?.token).toBeUndefined();
		expect(stored.metadata?.["[REDACTED]"]).toBe("[REDACTED]");
	});

	it("transitions pending_review proposals to reviewed terminal states with metadata", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "review.jsonl"),
		});
		const stored = await store.append(proposal());

		const approved = transitionProposalReviewState(stored, {
			status: "approved",
			reviewer: "Rayson",
			reason: "Evidence is sufficient for a human-reviewed follow-up.",
			reviewedAt: "2026-05-02T00:00:00.000Z",
			metadata: {
				source: "manual_review",
			},
		});

		expect(approved.status).toBe("approved");
		expect(approved.review).toEqual({
			reviewer: "Rayson",
			reason: "Evidence is sufficient for a human-reviewed follow-up.",
			reviewedAt: "2026-05-02T00:00:00.000Z",
			metadata: {
				source: "manual_review",
			},
		});
		expect(approved.contentHash).toBe(stored.contentHash);
	});

	it("rejects missing review metadata and repeated or reversed review transitions", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "invalid-review.jsonl"),
		});
		const stored = await store.append(proposal());

		expect(() =>
			transitionProposalReviewState(stored, {
				status: "approved",
				reviewer: "",
				reason: "Looks good.",
				reviewedAt: "2026-05-02T00:00:00.000Z",
			}),
		).toThrow(/reviewer/u);
		expect(() =>
			transitionProposalReviewState(stored, {
				status: "rejected",
				reviewer: "Reviewer",
				reason: " ",
				reviewedAt: "2026-05-02T00:00:00.000Z",
			}),
		).toThrow(/reason/u);
		expect(() =>
			transitionProposalReviewState(stored, {
				status: "approved",
				reviewer: "Reviewer",
				reason: "Timestamp must be strict UTC ISO.",
				reviewedAt: "2026-05-02" as never,
			}),
		).toThrow(/ISO 8601 UTC/u);

		const approved = transitionProposalReviewState(stored, {
			status: "approved",
			reviewer: "Reviewer",
			reason: "Approved once.",
			reviewedAt: "2026-05-02T00:00:00.000Z",
		});
		const rejected = transitionProposalReviewState(stored, {
			status: "rejected",
			reviewer: "Reviewer",
			reason: "Rejected once.",
			reviewedAt: "2026-05-02T00:00:00.000Z",
		});

		expect(() =>
			transitionProposalReviewState(approved, {
				status: "approved",
				reviewer: "Reviewer",
				reason: "Approve again.",
				reviewedAt: "2026-05-02T00:01:00.000Z",
			}),
		).toThrow(/pending_review/u);
		expect(() =>
			transitionProposalReviewState(rejected, {
				status: "approved",
				reviewer: "Reviewer",
				reason: "Reverse rejection.",
				reviewedAt: "2026-05-02T00:01:00.000Z",
			}),
		).toThrow(/pending_review/u);
	});

	it("supports superseded review transitions and sanitizes review metadata", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "superseded-review.jsonl"),
		});
		const stored = await store.append(proposal());

		const superseded = transitionProposalReviewState(stored, {
			status: "superseded",
			reviewer: "Reviewer",
			reason: "Replaced by a better proposal.",
			reviewedAt: "2026-05-02T00:00:00.000Z",
			metadata: {
				token: "sk-secret1234567890",
				replacementProposalId: "proposal:next",
			},
		});

		expect(superseded.status).toBe("superseded");
		expect(superseded.review?.metadata).toEqual({
			"[REDACTED]": "[REDACTED]",
			replacementProposalId: "proposal:next",
		});
	});

	it("rejects non-object review metadata from deserialized inputs", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "invalid-review-metadata.jsonl"),
		});
		const stored = await store.append(proposal());

		expect(() =>
			transitionProposalReviewState(stored, {
				status: "approved",
				reviewer: "Reviewer",
				reason: "Review metadata must stay structured.",
				reviewedAt: "2026-05-02T00:00:00.000Z",
				metadata: "not-object" as never,
			}),
		).toThrow(/metadata/u);
	});

	it("keeps generated patch proposals review-only after proposal approval", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "review-only-patch.jsonl"),
		});
		const evaluation = beforeAfterEvaluation();
		const patchProposal = generatedPatchProposal(evaluation.evaluationId);
		const stored = await store.append(
			proposal({
				riskPreview: {
					level: "critical",
					reasons: ["synthetic patch proposal"],
					touchesRuntime: true,
					requiresHumanReview: true,
				},
				beforeAfterEvaluation: evaluation,
				generatedPatchProposal: patchProposal,
			}),
		);

		const approved = transitionProposalReviewState(stored, {
			status: "approved",
			reviewer: "Reviewer",
			reason: "Approve the proposal record without applying its patch.",
			reviewedAt: "2026-05-02T00:00:00.000Z",
		});

		expect(approved.status).toBe("approved");
		expect(approved.generatedPatchProposal?.reviewState).toBe(
			"pending_human_review",
		);
		expect(approved.generatedPatchProposal?.safetyBoundary).toMatchObject({
			applicationMode: "proposal_only",
			autoApplyAllowed: false,
			requiresHumanReview: true,
		});
		expect(approved.beforeAfterEvaluation?.requiresHumanReview).toBe(true);
	});

	it("appends review transitions as JSONL-compatible full records and reads the latest state", async () => {
		const filePath = path.join(tmpDir, "review-state.jsonl");
		const store = new JsonlProposalStore({
			filePath,
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});
		const stored = await store.append(proposal());

		const rejected = await store.transitionReviewState(stored.proposalId, {
			status: "rejected",
			reviewer: "Reviewer",
			reason: "Insufficient evidence for this proposal.",
		});
		const rawLines = (await readFile(filePath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { readonly status: string });
		const fetched = await store.getById(stored.proposalId);
		const listed = await store.list();

		expect(rawLines).toHaveLength(2);
		expect(rawLines.map((line) => line.status)).toEqual([
			"pending_review",
			"rejected",
		]);
		expect(rejected.review?.reviewedAt).toBe("2026-05-02T00:00:00.000Z");
		expect(fetched?.status).toBe("rejected");
		expect(listed).toHaveLength(1);
		expect(listed[0]?.proposalId).toBe(stored.proposalId);
		expect(listed[0]?.status).toBe("rejected");
	});

	it("does not reopen approved or rejected proposals when the same content is appended", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "terminal-duplicate.jsonl"),
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});
		const input = proposal({
			title: "Stable terminal proposal",
			createdAt: "2026-05-02T00:00:00.000Z",
		});
		const stored = await store.append(input);

		await store.transitionReviewState(stored.proposalId, {
			status: "approved",
			reviewer: "Reviewer",
			reason: "Terminal review decision.",
		});

		await expect(store.append(input)).rejects.toThrow(/cannot be reopened/u);
		expect(await store.getById(stored.proposalId)).toMatchObject({
			status: "approved",
		});
	});

	it("serializes duplicate appends with review transitions so terminal decisions remain latest", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "append-transition-queue.jsonl"),
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});
		const input = proposal({
			title: "Queued terminal proposal",
			createdAt: "2026-05-02T00:00:00.000Z",
		});
		const stored = await store.append(input);

		const duplicateAppend = store.append(input);
		const transition = store.transitionReviewState(stored.proposalId, {
			status: "approved",
			reviewer: "Reviewer",
			reason: "Terminal review decision.",
			reviewedAt: "2026-05-02T01:00:00.000Z",
		});

		await expect(duplicateAppend).resolves.toMatchObject({
			proposalId: stored.proposalId,
			status: "pending_review",
		});
		await expect(transition).resolves.toMatchObject({
			proposalId: stored.proposalId,
			status: "approved",
		});
		expect(await store.getById(stored.proposalId)).toMatchObject({
			status: "approved",
		});
	});

	it("serializes concurrent in-process review transitions for the same store", async () => {
		const filePath = path.join(tmpDir, "review-state-concurrent.jsonl");
		const store = new JsonlProposalStore({
			filePath,
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});
		const stored = await store.append(proposal());

		const [first, second] = await Promise.allSettled([
			store.transitionReviewState(stored.proposalId, {
				status: "approved",
				reviewer: "Reviewer A",
				reason: "Approve first.",
			}),
			store.transitionReviewState(stored.proposalId, {
				status: "rejected",
				reviewer: "Reviewer B",
				reason: "Reject second.",
			}),
		]);
		const fetched = await store.getById(stored.proposalId);

		expect(first.status).toBe("fulfilled");
		expect(second.status).toBe("rejected");
		if (second.status === "rejected") {
			expect(second.reason).toMatchObject({
				message: expect.stringContaining("pending_review"),
			});
		}
		expect(fetched?.status).toBe("approved");
		expect(fetched?.review?.reviewer).toBe("Reviewer A");
	});

	it("queries latest proposals by review state and inclusive createdAt range in deterministic order", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "query.jsonl"),
		});

		const lateApproved = await store.append(
			proposal({
				title: "Late approved proposal",
				createdAt: "2026-05-04T00:00:00.000Z",
			}),
		);
		const upperBoundaryRejected = await store.append(
			proposal({
				title: "Upper boundary rejected proposal",
				createdAt: "2026-05-03T00:00:00.000Z",
			}),
		);
		const middleApproved = await store.append(
			proposal({
				title: "Middle approved proposal",
				createdAt: "2026-05-02T12:00:00.000Z",
			}),
		);
		await store.append(
			proposal({
				title: "Too old pending proposal",
				createdAt: "2026-05-01T23:59:59.999Z",
			}),
		);
		await store.append(
			proposal({
				title: "Lower boundary pending proposal",
				createdAt: "2026-05-02T00:00:00.000Z",
			}),
		);
		await store.transitionReviewState(lateApproved.proposalId, {
			status: "approved",
			reviewer: "Reviewer",
			reason: "Approved outside the requested time range.",
			reviewedAt: "2026-05-05T00:00:00.000Z",
		});
		await store.transitionReviewState(upperBoundaryRejected.proposalId, {
			status: "rejected",
			reviewer: "Reviewer",
			reason: "Rejected exactly at the upper boundary.",
			reviewedAt: "2026-05-05T00:00:00.000Z",
		});
		await store.transitionReviewState(middleApproved.proposalId, {
			status: "approved",
			reviewer: "Reviewer",
			reason: "Approved inside the requested time range.",
			reviewedAt: "2026-05-05T00:00:00.000Z",
		});

		const queried = await store.query({
			reviewState: ["pending_review", "approved", "rejected"],
			createdAt: {
				from: "2026-05-02T00:00:00.000Z",
				to: "2026-05-03T00:00:00.000Z",
			},
		});

		expect(queried.map((record) => record.title)).toEqual([
			"Lower boundary pending proposal",
			"Middle approved proposal",
			"Upper boundary rejected proposal",
		]);
		expect(queried.map((record) => record.status)).toEqual([
			"pending_review",
			"approved",
			"rejected",
		]);
	});

	it("queries superseded proposals and tie-breaks equal createdAt by proposalId", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "query-superseded.jsonl"),
		});
		const sameTime = "2026-05-02T00:00:00.000Z";
		const first = await store.append(
			proposal({ title: "B proposal", createdAt: sameTime }),
		);
		const second = await store.append(
			proposal({ title: "A proposal", createdAt: sameTime }),
		);
		await store.transitionReviewState(first.proposalId, {
			status: "superseded",
			reviewer: "Reviewer",
			reason: "Superseded by later proposal.",
			reviewedAt: "2026-05-02T01:00:00.000Z",
		});
		await store.transitionReviewState(second.proposalId, {
			status: "superseded",
			reviewer: "Reviewer",
			reason: "Superseded by later proposal.",
			reviewedAt: "2026-05-02T01:00:00.000Z",
		});

		const queried = await store.query({ reviewState: "superseded" });

		expect(queried.map((record) => record.proposalId)).toEqual(
			[first.proposalId, second.proposalId].toSorted(),
		);
		expect(queried.map((record) => record.status)).toEqual([
			"superseded",
			"superseded",
		]);
	});

	it("builds a deterministic review queue view grouped by review state", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "review-queue.jsonl"),
		});
		const sameTime = "2026-05-02T00:00:00.000Z";
		const pendingB = await store.append(
			proposal({ title: "B pending proposal", createdAt: sameTime }),
		);
		const approvedSource = await store.append(
			proposal({
				title: "Approved proposal",
				createdAt: "2026-05-03T00:00:00.000Z",
			}),
		);
		const rejectedSource = await store.append(
			proposal({
				title: "Rejected proposal",
				createdAt: "2026-05-01T00:00:00.000Z",
			}),
		);
		const supersededSource = await store.append(
			proposal({
				title: "Superseded proposal",
				createdAt: "2026-05-04T00:00:00.000Z",
			}),
		);
		const pendingA = await store.append(
			proposal({ title: "A pending proposal", createdAt: sameTime }),
		);
		const approved = await store.transitionReviewState(
			approvedSource.proposalId,
			{
				status: "approved",
				reviewer: "Reviewer",
				reason: "Approved for queue grouping.",
				reviewedAt: "2026-05-05T00:00:00.000Z",
			},
		);
		const rejected = await store.transitionReviewState(
			rejectedSource.proposalId,
			{
				status: "rejected",
				reviewer: "Reviewer",
				reason: "Rejected for queue grouping.",
				reviewedAt: "2026-05-05T00:00:00.000Z",
			},
		);
		const superseded = await store.transitionReviewState(
			supersededSource.proposalId,
			{
				status: "superseded",
				reviewer: "Reviewer",
				reason: "Superseded for queue grouping.",
				reviewedAt: "2026-05-05T00:00:00.000Z",
			},
		);

		const view = buildProposalReviewQueueView([
			superseded,
			pendingB,
			rejected,
			approved,
			pendingA,
		]);
		const expectedPending = [pendingB, pendingA]
			.toSorted(compareStoredProposalIds)
			.map(reviewQueueItem);

		expect(view).toEqual({
			totalCount: 5,
			counts: {
				pending_review: 2,
				approved: 1,
				rejected: 1,
				superseded: 1,
				applied: 0,
			},
			byReviewState: {
				pending_review: expectedPending,
				approved: [reviewQueueItem(approved)],
				rejected: [reviewQueueItem(rejected)],
				superseded: [reviewQueueItem(superseded)],
				applied: [],
			},
			nextActions: [
				{
					kind: "review_pending",
					priority: 20,
					reasonCode: "pending_review_waiting_for_human",
					reviewState: "pending_review",
					proposalIds: expectedPending.map((item) => item.proposalId),
				},
				{
					kind: "record_approved_review",
					priority: 80,
					reasonCode: "approved_review_recorded",
					reviewState: "approved",
					proposalIds: [approved.proposalId],
				},
				{
					kind: "record_rejected_review",
					priority: 90,
					reasonCode: "rejected_review_recorded",
					reviewState: "rejected",
					proposalIds: [rejected.proposalId],
				},
				{
					kind: "record_superseded_review",
					priority: 100,
					reasonCode: "superseded_review_recorded",
					reviewState: "superseded",
					proposalIds: [superseded.proposalId],
				},
			],
		});
	});

	it("separates stale pending next actions at the configured threshold", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "review-queue-stale-pending.jsonl"),
		});
		const staleOlder = await store.append(
			proposal({
				title: "Older stale pending proposal",
				createdAt: "2026-05-01T00:00:00.000Z",
			}),
		);
		const fresh = await store.append(
			proposal({
				title: "Fresh pending proposal",
				createdAt: "2026-05-03T00:00:00.000Z",
			}),
		);
		const staleBoundary = await store.append(
			proposal({
				title: "Boundary stale pending proposal",
				createdAt: "2026-05-02T00:00:00.000Z",
			}),
		);

		const view = buildProposalReviewQueueView(
			[staleBoundary, fresh, staleOlder],
			{
				now: "2026-05-04T00:00:00.000Z",
				stalePendingAfterMs: 48 * 60 * 60 * 1000,
			},
		);

		expect(
			view.byReviewState.pending_review.map((item) => item.proposalId),
		).toEqual([
			staleOlder.proposalId,
			staleBoundary.proposalId,
			fresh.proposalId,
		]);
		expect(view.nextActions).toEqual([
			{
				kind: "review_stale_pending",
				priority: 10,
				reasonCode: "pending_review_stale",
				reviewState: "pending_review",
				proposalIds: [staleOlder.proposalId, staleBoundary.proposalId],
			},
			{
				kind: "review_pending",
				priority: 20,
				reasonCode: "pending_review_waiting_for_human",
				reviewState: "pending_review",
				proposalIds: [fresh.proposalId],
			},
		]);
	});

	it("redacts review queue titles without changing deterministic proposal order", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "review-queue-redaction.jsonl"),
		});
		const sameTime = "2026-05-02T00:00:00.000Z";
		const plain = await store.append(
			proposal({
				title: "Plain pending proposal",
				createdAt: sameTime,
			}),
		);
		const secret = await store.append(
			proposal({
				title: "Pending proposal with sk-secret1234567890",
				createdAt: sameTime,
			}),
		);
		const expectedPending = [plain, secret]
			.toSorted(compareStoredProposalIds)
			.map(reviewQueueItem);

		const view = buildProposalReviewQueueView([secret, plain]);

		expect(JSON.stringify(view)).not.toContain("sk-secret1234567890");
		expect(view.byReviewState.pending_review).toEqual(expectedPending);
		expect(view.nextActions).toEqual([
			{
				kind: "review_pending",
				priority: 20,
				reasonCode: "pending_review_waiting_for_human",
				reviewState: "pending_review",
				proposalIds: expectedPending.map((item) => item.proposalId),
			},
		]);
	});

	it("builds an empty review queue view from an empty query result", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "empty-review-queue.jsonl"),
		});

		const queried = await store.query();
		const view = buildProposalReviewQueueView(queried);

		expect(view).toEqual({
			totalCount: 0,
			counts: {
				pending_review: 0,
				approved: 0,
				rejected: 0,
				superseded: 0,
				applied: 0,
			},
			byReviewState: {
				pending_review: [],
				approved: [],
				rejected: [],
				superseded: [],
				applied: [],
			},
			nextActions: [],
		});
	});

	it("fails closed when a review queue record corrupts generated patch auto-apply", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "review-queue-corrupted-patch.jsonl"),
		});
		const evaluation = beforeAfterEvaluation();
		const stored = await store.append(
			proposal({
				riskPreview: {
					level: "critical",
					reasons: ["synthetic patch proposal"],
					touchesRuntime: true,
					requiresHumanReview: true,
				},
				beforeAfterEvaluation: evaluation,
				generatedPatchProposal: generatedPatchProposal(evaluation.evaluationId),
			}),
		);
		if (stored.generatedPatchProposal === undefined) {
			throw new Error("Test proposal must include a generated patch proposal");
		}
		const corrupted = {
			...stored,
			generatedPatchProposal: {
				...stored.generatedPatchProposal,
				safetyBoundary: {
					...stored.generatedPatchProposal.safetyBoundary,
					autoApplyAllowed: true,
				},
			},
		} as unknown as StoredProposalRecord;

		expect(() => buildProposalReviewQueueView([corrupted])).toThrow(
			/auto-apply/u,
		);
	});

	it("rejects invalid proposal query filters", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "invalid-query.jsonl"),
		});

		await expect(store.query("approved" as never)).rejects.toThrow(
			/filters must be an object/u,
		);
		await expect(
			store.query({ reviewState: "ready" as never }),
		).rejects.toThrow(/review state/u);
		await expect(store.query({ reviewState: [] })).rejects.toThrow(
			/at least one/u,
		);
		const sparseReviewStates = new Array(1) as "approved"[];
		await expect(
			store.query({ reviewState: sparseReviewStates }),
		).rejects.toThrow(/sparse entries/u);
		await expect(
			store.query({
				createdAt: {
					from: "2026-05-02",
				},
			}),
		).rejects.toThrow(/ISO 8601 UTC/u);
		await expect(
			store.query({
				createdAt: {
					from: "2026-05-03T00:00:00.000Z",
					to: "2026-05-02T00:00:00.000Z",
				},
			}),
		).rejects.toThrow(/from <= to/u);
		await expect(store.query({ status: "approved" } as never)).rejects.toThrow(
			/Unsupported proposal query filter/u,
		);
		await expect(
			store.query({
				createdAt: {
					until: "2026-05-02T00:00:00.000Z",
				} as never,
			}),
		).rejects.toThrow(/Unsupported proposal createdAt filter/u);
	});

	it("rejects non-UTC proposal createdAt values before persistence", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "invalid-created-at.jsonl"),
		});

		await expect(
			store.append(
				proposal({
					createdAt: "2026-05-02T00:00:00.000",
				}),
			),
		).rejects.toThrow(/Proposal createdAt must be ISO 8601 UTC/u);
		await expect(
			store.append(
				proposal({
					createdAt: "2026-05-02T08:00:00.000+08:00",
				}),
			),
		).rejects.toThrow(/Proposal createdAt must be ISO 8601 UTC/u);
	});

	it("fails closed on corrupted persisted createdAt and unsafe generated patch proposals", async () => {
		const filePath = path.join(tmpDir, "corrupted-query.jsonl");
		const store = new JsonlProposalStore({ filePath });
		const evaluation = beforeAfterEvaluation();
		const stored = await store.append(
			proposal({
				riskPreview: {
					level: "critical",
					reasons: ["synthetic patch proposal"],
					touchesRuntime: true,
					requiresHumanReview: true,
				},
				beforeAfterEvaluation: evaluation,
				generatedPatchProposal: generatedPatchProposal(evaluation.evaluationId),
			}),
		);
		const corruptedCreatedAt = {
			...stored,
			createdAt: "2026-05-02T00:00:00.000",
		};
		const corruptedPatch = {
			...stored,
			proposalId: `${stored.proposalId}-corrupted`,
			generatedPatchProposal: {
				...stored.generatedPatchProposal,
				safetyBoundary: {
					...stored.generatedPatchProposal?.safetyBoundary,
					autoApplyAllowed: true,
				},
			},
		};
		await import("node:fs/promises").then(({ appendFile }) =>
			appendFile(
				filePath,
				`${JSON.stringify(corruptedCreatedAt)}\n${JSON.stringify(corruptedPatch)}\n`,
				"utf8",
			),
		);

		await expect(store.query()).rejects.toThrow(/ISO 8601 UTC|auto-apply/u);
	});

	it("linearizes query behind queued review transitions", async () => {
		const filePath = path.join(tmpDir, "query-transition-queue.jsonl");
		const store = new JsonlProposalStore({
			filePath,
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});
		const stored = await store.append(proposal());

		const transition = store.transitionReviewState(stored.proposalId, {
			status: "approved",
			reviewer: "Reviewer",
			reason: "Approved while query waits.",
			reviewedAt: "2026-05-02T01:00:00.000Z",
		});
		const queried = await store.query({ reviewState: "approved" });

		await transition;
		expect(queried.map((record) => record.proposalId)).toEqual([
			stored.proposalId,
		]);
		expect(queried[0]?.status).toBe("approved");
	});

	it("keeps queried generated patch proposals proposal-only after review filtering", async () => {
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "query-review-only-patch.jsonl"),
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});
		const evaluation = beforeAfterEvaluation();
		const patchProposal = generatedPatchProposal(evaluation.evaluationId);
		const stored = await store.append(
			proposal({
				riskPreview: {
					level: "critical",
					reasons: ["synthetic patch proposal"],
					touchesRuntime: true,
					requiresHumanReview: true,
				},
				beforeAfterEvaluation: evaluation,
				generatedPatchProposal: patchProposal,
			}),
		);
		const approved = await store.transitionReviewState(stored.proposalId, {
			status: "approved",
			reviewer: "Reviewer",
			reason: "Approved for proposal tracking only.",
			reviewedAt: "2026-05-02T01:00:00.000Z",
		});

		const queried = await store.query({
			reviewState: "approved",
			createdAt: {
				from: "2026-05-02T00:00:00.000Z",
				to: "2026-05-02T00:00:00.000Z",
			},
		});

		expect(queried).toHaveLength(1);
		expect(queried[0]?.proposalId).toBe(approved.proposalId);
		expect(queried[0]?.generatedPatchProposal?.reviewState).toBe(
			"pending_human_review",
		);
		expect(queried[0]?.generatedPatchProposal?.safetyBoundary).toMatchObject({
			applicationMode: "proposal_only",
			autoApplyAllowed: false,
			requiresHumanReview: true,
		});
	});

	it("rejects relative traversal outside the configured data root", () => {
		expect(
			() =>
				new JsonlProposalStore({
					dataRoot: tmpDir,
					filePath: "../escape.jsonl",
				}),
		).toThrow(/within dataRoot/u);
	});

	it("rejects JSONL writes through symlink paths", async () => {
		const dataRoot = path.join(tmpDir, "data");
		const outsideRoot = path.join(tmpDir, "outside");
		await mkdir(dataRoot, { recursive: true });
		await mkdir(outsideRoot, { recursive: true });
		const symlinkPath = path.join(dataRoot, "proposals.jsonl");
		await symlink(path.join(outsideRoot, "escaped.jsonl"), symlinkPath);
		const store = new JsonlProposalStore({
			dataRoot,
			filePath: symlinkPath,
		});

		await expect(store.append(proposal())).rejects.toThrow(/symlink/u);
	});

	describe("applyApproved", () => {
		async function appendApprovedProposal(
			store: JsonlProposalStore,
			input: ProposalRecordInput,
			reviewedAt = "2026-05-02T01:00:00.000Z",
		): Promise<StoredProposalRecord> {
			const stored = await store.append(input);
			return store.transitionReviewState(stored.proposalId, {
				status: "approved",
				reviewer: "Reviewer",
				reason: "Approved for apply.",
				reviewedAt,
			});
		}

		function patchProposalInput(): ProposalRecordInput {
			const evaluation = beforeAfterEvaluation();
			return proposal({
				riskPreview: {
					level: "critical",
					reasons: ["synthetic patch proposal"],
					touchesRuntime: true,
					requiresHumanReview: true,
				},
				beforeAfterEvaluation: evaluation,
				generatedPatchProposal: generatedPatchProposal(evaluation.evaluationId),
			});
		}

		// Test-only no-op gate: round-2 cross-review (QUI-97) requires
		// scaffold_patch applies to pass through a SandboxPolicyGate, but
		// these existing tests are exercising orthogonal apply concerns
		// (WriteAuthority, applier errors, multi-record sequencing) and
		// don't need full Docker probe behavior. The no-op gate returns
		// the same `native + ""` decision a non-scaffold proposal would
		// produce, keeping behavior backward-compatible for the caller.
		// 测试用 no-op gate：让原有测试聚焦于 WriteAuthority / applier 错误 /
		// 串行处理等关注点，绕过 round-2 强制的"scaffold_patch 必须有 gate"
		// 检查（行为等价于无 sandbox 隔离的 native 返回）。
		const noopSandboxGate: ProposalSandboxPolicyGate = {
			decide: async () => ({ kind: "native", warning: "" }),
		};

		it("authorizes an approved proposal via WriteAuthority and transitions to applied", async () => {
			const filePath = path.join(tmpDir, "apply-success.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			const approved = await appendApprovedProposal(
				store,
				patchProposalInput(),
			);

			const confirm = vi.fn(async (_request: WriteRequest) => true);
			const authority = new WriteAuthority({
				mode: "ask",
				confirm,
				actor: "test-actor",
			});
			const applier = vi.fn(async (_record: StoredProposalRecord) => undefined);

			const result = await store.applyApproved(authority, {
				origin: "agent",
				reviewer: "Apply Bot",
				applier,
				sandboxPolicyGate: noopSandboxGate,
			});

			expect(result.applied).toHaveLength(1);
			expect(result.applied[0]?.status).toBe("applied");
			expect(result.applied[0]?.proposalId).toBe(approved.proposalId);
			expect(result.applied[0]?.review?.reviewer).toBe("Apply Bot");
			expect(result.applied[0]?.review?.reviewedAt).toBe(
				"2026-05-02T02:00:00.000Z",
			);
			expect(result.skipped).toEqual([]);
			expect(result.failed).toEqual([]);

			expect(confirm).toHaveBeenCalledTimes(1);
			const confirmArg = confirm.mock.calls[0]?.[0];
			expect(confirmArg?.tool).toBe("self_evolution_patch_apply");
			expect(confirmArg?.riskLevel).toBe("critical");
			expect(confirmArg?.origin).toBe("agent");
			expect(confirmArg?.summary).toContain(approved.proposalId);
			expect(confirmArg?.detail).toContain("paths=");
			expect(applier).toHaveBeenCalledTimes(1);

			const fetched = await store.getById(approved.proposalId);
			expect(fetched?.status).toBe("applied");

			const persisted = (await readFile(filePath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { status: string });
			expect(persisted.map((line) => line.status)).toEqual([
				"pending_review",
				"approved",
				"applied",
			]);
		});

		it("records a skipped outcome when WriteAuthority rejects the apply request", async () => {
			const filePath = path.join(tmpDir, "apply-rejected.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			const approved = await appendApprovedProposal(
				store,
				patchProposalInput(),
			);

			const authority = new WriteAuthority({
				mode: "ask",
				confirm: async () => false,
			});
			const applier = vi.fn(async (_record: StoredProposalRecord) => undefined);

			const result = await store.applyApproved(authority, { applier });

			expect(result.applied).toEqual([]);
			expect(result.failed).toEqual([]);
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped[0]).toMatchObject({
				proposalId: approved.proposalId,
				status: "skipped",
				reasonCode: "user_rejected",
			});
			expect(applier).not.toHaveBeenCalled();

			const fetched = await store.getById(approved.proposalId);
			expect(fetched?.status).toBe("approved");
		});

		it("records unsupported_patch_type for the default applier and keeps state at approved", async () => {
			const filePath = path.join(tmpDir, "apply-unsupported.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			const approved = await appendApprovedProposal(
				store,
				patchProposalInput(),
			);

			const authority = new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			});

			const result = await store.applyApproved(authority, {
				sandboxPolicyGate: noopSandboxGate,
			});

			expect(result.applied).toEqual([]);
			expect(result.skipped).toEqual([]);
			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]).toMatchObject({
				proposalId: approved.proposalId,
				status: "failed",
				reasonCode: "unsupported_patch_type",
			});

			const fetched = await store.getById(approved.proposalId);
			expect(fetched?.status).toBe("approved");
		});

		it("rolls back to approved when a custom applier throws an apply_error", async () => {
			const filePath = path.join(tmpDir, "apply-error.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			const approved = await appendApprovedProposal(
				store,
				patchProposalInput(),
			);

			const authority = new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			});
			const applier = vi.fn(async (_record: StoredProposalRecord) => {
				throw new Error("disk full");
			});

			const result = await store.applyApproved(authority, {
				applier,
				sandboxPolicyGate: noopSandboxGate,
			});

			expect(result.applied).toEqual([]);
			expect(result.skipped).toEqual([]);
			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]).toMatchObject({
				proposalId: approved.proposalId,
				status: "failed",
				reasonCode: "apply_error",
				reason: "disk full",
			});
			expect(applier).toHaveBeenCalledTimes(1);

			const fetched = await store.getById(approved.proposalId);
			expect(fetched?.status).toBe("approved");

			const persisted = (await readFile(filePath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { status: string });
			expect(persisted.map((line) => line.status)).toEqual([
				"pending_review",
				"approved",
			]);
		});

		it("processes multiple approved proposals serially with mixed outcomes", async () => {
			const filePath = path.join(tmpDir, "apply-multiple.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			const first = await appendApprovedProposal(
				store,
				{
					...patchProposalInput(),
					title: "First approved proposal",
					createdAt: "2026-05-01T00:00:00.000Z",
				},
				"2026-05-01T01:00:00.000Z",
			);
			const second = await appendApprovedProposal(
				store,
				{
					...patchProposalInput(),
					title: "Second approved proposal",
					createdAt: "2026-05-01T00:00:30.000Z",
				},
				"2026-05-01T01:00:30.000Z",
			);
			const third = await appendApprovedProposal(
				store,
				{
					...patchProposalInput(),
					title: "Third approved proposal",
					createdAt: "2026-05-01T00:01:00.000Z",
				},
				"2026-05-01T01:01:00.000Z",
			);

			const seenIds: string[] = [];
			const applier = vi.fn(async (record: StoredProposalRecord) => {
				seenIds.push(record.proposalId);
				if (record.proposalId === second.proposalId) {
					throw new Error("flaky filesystem");
				}
				if (record.proposalId === third.proposalId) {
					throw new UnsupportedPatchTypeError("only add changes supported");
				}
			});
			const authority = new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			});

			const result = await store.applyApproved(authority, {
				applier,
				sandboxPolicyGate: noopSandboxGate,
			});

			expect(seenIds).toEqual([
				first.proposalId,
				second.proposalId,
				third.proposalId,
			]);
			expect(result.applied.map((record) => record.proposalId)).toEqual([
				first.proposalId,
			]);
			expect(result.failed).toHaveLength(2);
			expect(result.failed.map((entry) => entry.reasonCode).toSorted()).toEqual(
				["apply_error", "unsupported_patch_type"],
			);
			expect(result.skipped).toEqual([]);

			expect((await store.getById(first.proposalId))?.status).toBe("applied");
			expect((await store.getById(second.proposalId))?.status).toBe("approved");
			expect((await store.getById(third.proposalId))?.status).toBe("approved");
		});

		it("denies idle origin apply requests when WriteAuthority is in ask mode", async () => {
			const filePath = path.join(tmpDir, "apply-idle-denied.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			await appendApprovedProposal(store, patchProposalInput());

			const confirm = vi.fn(async (_request: WriteRequest) => true);
			const authority = new WriteAuthority({ mode: "ask", confirm });
			const applier = vi.fn(async (_record: StoredProposalRecord) => undefined);

			const result = await store.applyApproved(authority, {
				origin: "idle",
				applier,
			});

			expect(result.applied).toEqual([]);
			expect(result.failed).toEqual([]);
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped[0]?.reasonCode).toBe("user_rejected");
			expect(result.skipped[0]?.reason).toMatch(/idle/u);
			expect(confirm).not.toHaveBeenCalled();
			expect(applier).not.toHaveBeenCalled();
		});

		it("requires a WriteAuthority gate", async () => {
			const store = new JsonlProposalStore({
				filePath: path.join(tmpDir, "apply-no-authority.jsonl"),
			});

			await expect(store.applyApproved(undefined as never)).rejects.toThrow(
				/WriteAuthority/u,
			);
		});

		it("rejects an empty reviewer override", async () => {
			const store = new JsonlProposalStore({
				filePath: path.join(tmpDir, "apply-empty-reviewer.jsonl"),
			});
			const authority = new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			});

			await expect(
				store.applyApproved(authority, { reviewer: "   " }),
			).rejects.toThrow(/reviewer/u);
		});

		it("returns empty result when no approved proposals exist", async () => {
			const store = new JsonlProposalStore({
				filePath: path.join(tmpDir, "apply-none.jsonl"),
			});
			await store.append(proposal());
			const authority = new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			});

			const result = await store.applyApproved(authority);

			expect(result.applied).toEqual([]);
			expect(result.skipped).toEqual([]);
			expect(result.failed).toEqual([]);
		});

		it("classifies deny_all skip reasons when WriteAuthority is disabled", async () => {
			const filePath = path.join(tmpDir, "apply-deny-all.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			const approved = await appendApprovedProposal(
				store,
				patchProposalInput(),
			);

			const authority = new WriteAuthority({ mode: "deny-all" });
			const applier = vi.fn(async (_record: StoredProposalRecord) => undefined);

			const result = await store.applyApproved(authority, { applier });

			expect(result.applied).toEqual([]);
			expect(result.failed).toEqual([]);
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped[0]).toMatchObject({
				proposalId: approved.proposalId,
				status: "skipped",
				reasonCode: "deny_all",
			});
			expect(applier).not.toHaveBeenCalled();
		});

		it("classifies missing_confirm skips when no confirm hook is provided", async () => {
			const filePath = path.join(tmpDir, "apply-missing-confirm.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			const approved = await appendApprovedProposal(
				store,
				patchProposalInput(),
			);

			const authority = new WriteAuthority({ mode: "ask" });
			const applier = vi.fn(async (_record: StoredProposalRecord) => undefined);

			const result = await store.applyApproved(authority, { applier });

			expect(result.applied).toEqual([]);
			expect(result.failed).toEqual([]);
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped[0]).toMatchObject({
				proposalId: approved.proposalId,
				status: "skipped",
				reasonCode: "missing_confirm",
			});
			expect(applier).not.toHaveBeenCalled();
		});

		it("describes artifact-only proposals with the artifact-only summary", async () => {
			const filePath = path.join(tmpDir, "apply-artifact-only.jsonl");
			const store = new JsonlProposalStore({
				filePath,
				now: () => new Date("2026-05-02T02:00:00.000Z"),
			});
			const approved = await appendApprovedProposal(store, proposal());

			const confirm = vi.fn(async (_request: WriteRequest) => true);
			const authority = new WriteAuthority({ mode: "ask", confirm });

			const result = await store.applyApproved(authority);

			expect(result.applied).toEqual([]);
			expect(result.skipped).toEqual([]);
			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]).toMatchObject({
				proposalId: approved.proposalId,
				status: "failed",
				reasonCode: "unsupported_patch_type",
				reason: expect.stringContaining("artifact-only"),
			});
			expect(confirm).toHaveBeenCalledTimes(1);
			const detail = confirm.mock.calls[0]?.[0]?.detail ?? "";
			expect(detail).toContain("paths=artifact-only");
		});

		it("rejects applied transitions from non-approved states", async () => {
			const store = new JsonlProposalStore({
				filePath: path.join(tmpDir, "apply-transition-guard.jsonl"),
			});
			const stored = await store.append(proposal());

			expect(() =>
				transitionProposalAppliedState(stored, {
					reviewer: "Apply Bot",
					reason: "Apply attempt.",
					reviewedAt: "2026-05-02T01:00:00.000Z",
				}),
			).toThrow(/approved/u);
		});

		it("validates applied transition metadata is non-empty and ISO timestamps", async () => {
			const store = new JsonlProposalStore({
				filePath: path.join(tmpDir, "apply-transition-metadata.jsonl"),
			});
			const stored = await store.append(proposal());
			const approved = transitionProposalReviewState(stored, {
				status: "approved",
				reviewer: "Reviewer",
				reason: "Approved.",
				reviewedAt: "2026-05-02T01:00:00.000Z",
			});

			expect(() =>
				transitionProposalAppliedState(approved, {
					reviewer: "  ",
					reason: "Apply.",
					reviewedAt: "2026-05-02T01:00:00.000Z",
				}),
			).toThrow(/reviewer/u);
			expect(() =>
				transitionProposalAppliedState(approved, {
					reviewer: "Apply Bot",
					reason: "  ",
					reviewedAt: "2026-05-02T01:00:00.000Z",
				}),
			).toThrow(/reason/u);
			expect(() =>
				transitionProposalAppliedState(approved, {
					reviewer: "Apply Bot",
					reason: "Apply.",
					reviewedAt: "2026-05-02" as never,
				}),
			).toThrow(/ISO 8601 UTC/u);
		});

		describe("sandbox policy gate", () => {
			it("forwards a docker decision to the applier when Docker is available", async () => {
				const store = new JsonlProposalStore({
					filePath: path.join(tmpDir, "apply-sandbox-docker.jsonl"),
					now: () => new Date("2026-05-02T02:00:00.000Z"),
				});
				const approved = await appendApprovedProposal(
					store,
					patchProposalInput(),
				);

				const authority = new WriteAuthority({
					mode: "ask",
					confirm: async () => true,
				});
				const gate = new DockerProposalSandboxPolicyGate({
					isDockerAvailable: async () => true,
				});
				const applier = vi.fn(
					async (
						_record: StoredProposalRecord,
						_context?: ProposalPatchApplierContext,
					) => undefined,
				);

				const result = await store.applyApproved(authority, {
					applier,
					sandboxPolicyGate: gate,
				});

				expect(result.applied).toHaveLength(1);
				expect(result.skipped).toEqual([]);
				expect(result.failed).toEqual([]);
				expect(applier).toHaveBeenCalledTimes(1);
				const passedContext = applier.mock.calls[0]?.[1];
				expect(passedContext?.sandbox).toEqual({
					kind: "docker",
					provider: "docker",
				});

				const fetched = await store.getById(approved.proposalId);
				expect(fetched?.status).toBe("applied");
			});

			it("falls back to native with a warning when Docker is unavailable", async () => {
				const store = new JsonlProposalStore({
					filePath: path.join(tmpDir, "apply-sandbox-native.jsonl"),
					now: () => new Date("2026-05-02T02:00:00.000Z"),
				});
				const approved = await appendApprovedProposal(
					store,
					patchProposalInput(),
				);

				const authority = new WriteAuthority({
					mode: "ask",
					confirm: async () => true,
				});
				const gate = new DockerProposalSandboxPolicyGate({
					isDockerAvailable: async () => false,
				});
				const applier = vi.fn(
					async (
						_record: StoredProposalRecord,
						_context?: ProposalPatchApplierContext,
					) => undefined,
				);

				const result = await store.applyApproved(authority, {
					applier,
					sandboxPolicyGate: gate,
				});

				expect(result.applied).toHaveLength(1);
				expect(result.skipped).toEqual([]);
				expect(result.failed).toEqual([]);
				expect(applier).toHaveBeenCalledTimes(1);
				const passedContext = applier.mock.calls[0]?.[1];
				expect(passedContext?.sandbox?.kind).toBe("native");
				if (passedContext?.sandbox?.kind === "native") {
					expect(passedContext.sandbox.warning.length).toBeGreaterThan(0);
					expect(passedContext.sandbox.warning).toMatch(
						/Docker sandbox unavailable/iu,
					);
				}

				const fetched = await store.getById(approved.proposalId);
				expect(fetched?.status).toBe("applied");
			});

			it("skips the applier when the sandbox gate denies the apply", async () => {
				const denyFilePath = path.join(tmpDir, "apply-sandbox-deny.jsonl");
				const store = new JsonlProposalStore({
					filePath: denyFilePath,
					now: () => new Date("2026-05-02T02:00:00.000Z"),
				});
				const approved = await appendApprovedProposal(
					store,
					patchProposalInput(),
				);

				const authority = new WriteAuthority({
					mode: "ask",
					confirm: async () => true,
				});
				const gate: ProposalSandboxPolicyGate = {
					decide: async () => ({
						kind: "deny",
						reason: "ci-maintenance window",
					}),
				};
				const applier = vi.fn(
					async (
						_record: StoredProposalRecord,
						_context?: ProposalPatchApplierContext,
					) => undefined,
				);

				const result = await store.applyApproved(authority, {
					applier,
					sandboxPolicyGate: gate,
				});

				expect(result.applied).toEqual([]);
				expect(result.failed).toEqual([]);
				expect(result.skipped).toHaveLength(1);
				expect(result.skipped[0]).toMatchObject({
					proposalId: approved.proposalId,
					status: "skipped",
					reasonCode: "sandbox_denied",
					reason: "ci-maintenance window",
				});
				expect(applier).not.toHaveBeenCalled();

				const fetched = await store.getById(approved.proposalId);
				expect(fetched?.status).toBe("approved");

				const persisted = (await readFile(denyFilePath, "utf8"))
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { status: string });
				expect(persisted.map((line) => line.status)).toEqual([
					"pending_review",
					"approved",
				]);
			});

			it("skips sandbox enforcement for non scaffold_patch proposals (artifact-only)", async () => {
				const store = new JsonlProposalStore({
					filePath: path.join(tmpDir, "apply-sandbox-artifact-only.jsonl"),
					now: () => new Date("2026-05-02T02:00:00.000Z"),
				});
				const approved = await appendApprovedProposal(store, proposal());

				const authority = new WriteAuthority({
					mode: "ask",
					confirm: async () => true,
				});
				const isDockerAvailable = vi.fn(async () => true);
				const gate = new DockerProposalSandboxPolicyGate({
					isDockerAvailable,
				});
				const applier = vi.fn(
					async (
						_record: StoredProposalRecord,
						_context?: ProposalPatchApplierContext,
					) => undefined,
				);

				const result = await store.applyApproved(authority, {
					applier,
					sandboxPolicyGate: gate,
				});

				expect(result.applied).toHaveLength(1);
				expect(result.skipped).toEqual([]);
				expect(result.failed).toEqual([]);
				expect(applier).toHaveBeenCalledTimes(1);
				const passedContext = applier.mock.calls[0]?.[1];
				expect(passedContext?.sandbox?.kind).toBe("native");
				if (passedContext?.sandbox?.kind === "native") {
					expect(passedContext.sandbox.warning).toBe("");
				}
				// Docker availability is never probed for non-scaffold kinds.
				expect(isDockerAvailable).not.toHaveBeenCalled();

				const fetched = await store.getById(approved.proposalId);
				expect(fetched?.status).toBe("applied");
			});

			// HIGH-1 (round-2 cross-review): caller must pass sandboxPolicyGate
			// for scaffold_patch proposals — silently bypassing sandbox
			// enforcement is forbidden by 07 §2.6.5.
			it("denies scaffold_patch apply with sandbox_gate_missing when no gate is provided", async () => {
				const denyFilePath = path.join(
					tmpDir,
					"apply-sandbox-gate-missing.jsonl",
				);
				const store = new JsonlProposalStore({
					filePath: denyFilePath,
					now: () => new Date("2026-05-02T02:00:00.000Z"),
				});
				const approved = await appendApprovedProposal(
					store,
					patchProposalInput(),
				);

				const authority = new WriteAuthority({
					mode: "ask",
					confirm: async () => true,
				});
				const applier = vi.fn(
					async (
						_record: StoredProposalRecord,
						_context?: ProposalPatchApplierContext,
					) => undefined,
				);

				const result = await store.applyApproved(authority, {
					applier,
					// sandboxPolicyGate intentionally omitted — fix must deny.
				});

				expect(result.applied).toEqual([]);
				expect(result.failed).toEqual([]);
				expect(result.skipped).toHaveLength(1);
				expect(result.skipped[0]).toMatchObject({
					proposalId: approved.proposalId,
					status: "skipped",
					reasonCode: "sandbox_gate_missing",
				});
				expect(result.skipped[0]?.reason).toMatch(/sandboxPolicyGate/u);
				expect(applier).not.toHaveBeenCalled();

				// State remains "approved" — denied apply must not transition.
				const fetched = await store.getById(approved.proposalId);
				expect(fetched?.status).toBe("approved");
			});

			// HIGH-1 negative case: artifact-only proposals keep the legacy
			// optional-gate behavior (we can't break existing call sites).
			it("still applies artifact-only proposals without a sandbox gate", async () => {
				const store = new JsonlProposalStore({
					filePath: path.join(
						tmpDir,
						"apply-artifact-only-no-gate.jsonl",
					),
					now: () => new Date("2026-05-02T02:00:00.000Z"),
				});
				await appendApprovedProposal(store, proposal());

				const authority = new WriteAuthority({
					mode: "ask",
					confirm: async () => true,
				});
				const applier = vi.fn(
					async (
						_record: StoredProposalRecord,
						_context?: ProposalPatchApplierContext,
					) => undefined,
				);

				const result = await store.applyApproved(authority, {
					applier,
				});

				expect(result.applied).toHaveLength(1);
				expect(result.skipped).toEqual([]);
				expect(applier).toHaveBeenCalledTimes(1);
				// No sandbox context when no gate was supplied for artifact-only.
				const passedContext = applier.mock.calls[0]?.[1];
				expect(passedContext).toBeUndefined();
			});

			// MEDIUM-6 (round-2 cross-review): all five gate paths must emit a
			// `proposal.sandbox_decision` agent-run event so the audit trail
			// distinguishes docker / native / deny / probe_error / no_gate.
			it("emits proposal.sandbox_decision telemetry for all five gate paths", async () => {
				type Recorded = {
					readonly phase: string;
					readonly payload?: Record<string, unknown>;
				};
				const collected: Recorded[] = [];
				const sink = {
					record: async (input: {
						phase: string;
						payload?: Record<string, unknown>;
					}) => {
						collected.push({ phase: input.phase, payload: input.payload });
					},
				};

				const authority = new WriteAuthority({
					mode: "ask",
					confirm: async () => true,
				});

				// Path 1: docker
				{
					const store = new JsonlProposalStore({
						filePath: path.join(tmpDir, "telemetry-docker.jsonl"),
						now: () => new Date("2026-05-02T02:00:00.000Z"),
					});
					await appendApprovedProposal(store, patchProposalInput());
					const gate = new DockerProposalSandboxPolicyGate({
						isDockerAvailable: async () => true,
					});
					await store.applyApproved(authority, {
						applier: async () => undefined,
						sandboxPolicyGate: gate,
						runLogger: sink,
					});
				}

				// Path 2: native (Docker unavailable, requireDocker=false default)
				{
					const store = new JsonlProposalStore({
						filePath: path.join(tmpDir, "telemetry-native.jsonl"),
						now: () => new Date("2026-05-02T02:00:00.000Z"),
					});
					await appendApprovedProposal(store, patchProposalInput());
					const gate = new DockerProposalSandboxPolicyGate({
						isDockerAvailable: async () => false,
					});
					await store.applyApproved(authority, {
						applier: async () => undefined,
						sandboxPolicyGate: gate,
						runLogger: sink,
					});
				}

				// Path 3: deny (explicit policy override)
				{
					const store = new JsonlProposalStore({
						filePath: path.join(tmpDir, "telemetry-deny.jsonl"),
						now: () => new Date("2026-05-02T02:00:00.000Z"),
					});
					await appendApprovedProposal(store, patchProposalInput());
					const gate: ProposalSandboxPolicyGate = {
						decide: async () => ({
							kind: "deny",
							reason: "ci-maintenance window",
						}),
					};
					await store.applyApproved(authority, {
						applier: async () => undefined,
						sandboxPolicyGate: gate,
						runLogger: sink,
					});
				}

				// Path 4: probe_error (gate's deny reason flags probe failure)
				{
					const store = new JsonlProposalStore({
						filePath: path.join(tmpDir, "telemetry-probe.jsonl"),
						now: () => new Date("2026-05-02T02:00:00.000Z"),
					});
					await appendApprovedProposal(store, patchProposalInput());
					const gate = new DockerProposalSandboxPolicyGate({
						isDockerAvailable: async () => {
							throw new Error("docker socket missing");
						},
					});
					await store.applyApproved(authority, {
						applier: async () => undefined,
						sandboxPolicyGate: gate,
						runLogger: sink,
					});
				}

				// Path 5: no_gate (caller omitted gate for scaffold_patch)
				{
					const store = new JsonlProposalStore({
						filePath: path.join(tmpDir, "telemetry-no-gate.jsonl"),
						now: () => new Date("2026-05-02T02:00:00.000Z"),
					});
					await appendApprovedProposal(store, patchProposalInput());
					await store.applyApproved(authority, {
						applier: async () => undefined,
						runLogger: sink,
					});
				}

				const sandboxDecisions = collected.filter(
					(entry) => entry.phase === "proposal.sandbox_decision",
				);
				const kinds = sandboxDecisions
					.map((entry) => String(entry.payload?.kind))
					.sort();
				expect(kinds).toEqual(
					["deny", "docker", "native", "no_gate", "probe_error"].sort(),
				);

				// docker payload carries proposalKind but no warning/reason.
				const dockerPayload = sandboxDecisions.find(
					(entry) => entry.payload?.kind === "docker",
				)?.payload;
				expect(dockerPayload?.proposalKind).toBe("scaffold_patch");

				// native payload carries the warning string.
				const nativePayload = sandboxDecisions.find(
					(entry) => entry.payload?.kind === "native",
				)?.payload;
				expect(typeof nativePayload?.warning).toBe("string");

				// deny carries the policy reason; probe_error carries the
				// probe failure message; no_gate carries the requirement.
				const denyPayload = sandboxDecisions.find(
					(entry) => entry.payload?.kind === "deny",
				)?.payload;
				expect(String(denyPayload?.reason)).toMatch(/ci-maintenance/u);

				const probePayload = sandboxDecisions.find(
					(entry) => entry.payload?.kind === "probe_error",
				)?.payload;
				expect(String(probePayload?.reason)).toMatch(/sandbox probe failed/iu);

				const noGatePayload = sandboxDecisions.find(
					(entry) => entry.payload?.kind === "no_gate",
				)?.payload;
				expect(String(noGatePayload?.reason)).toMatch(/sandboxPolicyGate/u);
			});
		});
	});
});
