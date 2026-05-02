import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createBeforeAfterEvaluation,
	createGeneratedPatchProposal,
} from "./patch-proposal.js";
import {
	buildProposalReviewQueueView,
	JsonlProposalStore,
	transitionProposalReviewState,
} from "./proposal-store.js";
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
		sourceRefs: ["trajectory:1"],
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
}

function generatedPatchProposal(evaluationId: string) {
	return createGeneratedPatchProposal({
		proposalKind: "scaffold_patch",
		title: "Review-only self-evolution patch",
		summary: "Synthetic diff for human review.",
		sourceRefs: ["trajectory:1"],
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
		expect(stored.beforeAfterEvaluation?.requiresHumanReview).toBe(true);
		expect(fetched?.generatedPatchProposal?.beforeAfterEvaluationId).toBe(
			fetched?.beforeAfterEvaluation?.evaluationId,
		);
		expect(fetched?.generatedPatchProposal?.fileChanges).toEqual(
			patchProposal.fileChanges,
		);
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
		expect(stored.metadata?.token).toBe("[REDACTED]");
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
			token: "[REDACTED]",
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
			},
			byReviewState: {
				pending_review: expectedPending,
				approved: [reviewQueueItem(approved)],
				rejected: [reviewQueueItem(rejected)],
				superseded: [reviewQueueItem(superseded)],
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
			},
			byReviewState: {
				pending_review: [],
				approved: [],
				rejected: [],
				superseded: [],
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
});
