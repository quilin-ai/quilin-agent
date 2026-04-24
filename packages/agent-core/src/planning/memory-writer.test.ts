import { describe, expect, it, vi } from "vitest";
import {
	createPlanReviewMemoryItem,
	PLAN_REVIEW_SCHEMA_VERSION,
	PLAN_REVIEW_SOURCE,
	validatePlanReviewRecord,
	writePlanReviewRecord,
} from "./memory-writer.js";
import { createPlanningState } from "./state.js";

const FIXED_DATE = new Date("2026-04-24T08:00:00.000Z");

function makeReview() {
	return {
		run_id: "run-123",
		source: PLAN_REVIEW_SOURCE,
		schema_version: PLAN_REVIEW_SCHEMA_VERSION,
		summary: "Prefer fetching benchmark snapshots before drafting strategy.",
		stable_strategy: {
			ordering: ["search", "table", "recommend"],
			preferred_tools: ["web_search", "table_write"],
		},
		stability_reason: "Observed across two successful runs.",
	};
}

describe("validatePlanReviewRecord", () => {
	it("accepts the provisional S3 schema with optional non-breaking fields", () => {
		expect(validatePlanReviewRecord(makeReview())).toEqual(makeReview());
	});

	it("rejects raw PlanningState payloads and transient planning fields", () => {
		expect(() =>
			validatePlanReviewRecord(createPlanningState("run-live")),
		).toThrow(/running PlanningState/);
		expect(() =>
			validatePlanReviewRecord({
				...makeReview(),
				events: [],
			}),
		).toThrow(/transient planning fields/i);
	});
});

describe("createPlanReviewMemoryItem", () => {
	it("encodes the review as a semantic JSON MemoryItem", () => {
		const item = createPlanReviewMemoryItem(makeReview(), {
			now: () => FIXED_DATE,
			metadata: {
				stability_reason: "validated",
			},
		});

		expect(item).toEqual({
			id: expect.stringMatching(/^planning-review:run-123:/),
			content: JSON.stringify(makeReview()),
			content_type: "json",
			layer: "semantic",
			metadata: {
				stability_reason: "validated",
				schema_version: PLAN_REVIEW_SCHEMA_VERSION,
				source: PLAN_REVIEW_SOURCE,
				run_id: "run-123",
			},
			embedding: null,
			created_at: FIXED_DATE.toISOString(),
			last_accessed: FIXED_DATE.toISOString(),
			access_count: 0,
			importance_score: 1,
		});
	});

	it("creates the same id for equivalent records with different key insertion order", () => {
		const first = createPlanReviewMemoryItem(makeReview(), {
			now: () => FIXED_DATE,
		});
		const reordered = {
			stability_reason: "Observed across two successful runs.",
			stable_strategy: {
				preferred_tools: ["web_search", "table_write"],
				ordering: ["search", "table", "recommend"],
			},
			summary: "Prefer fetching benchmark snapshots before drafting strategy.",
			schema_version: PLAN_REVIEW_SCHEMA_VERSION,
			source: PLAN_REVIEW_SOURCE,
			run_id: "run-123",
		};
		const second = createPlanReviewMemoryItem(reordered, {
			now: () => FIXED_DATE,
		});

		expect(second.id).toBe(first.id);
	});
});

describe("writePlanReviewRecord", () => {
	it("stores the semantic MemoryItem when a memory client is available", async () => {
		const store = vi.fn(async () => undefined);

		const result = await writePlanReviewRecord(makeReview(), {
			client: {
				recall: vi.fn(async () => []),
				store,
			},
			now: () => FIXED_DATE,
		});

		expect(result.status).toBe("written");
		expect(store).toHaveBeenCalledWith(
			expect.objectContaining({
				layer: "semantic",
				content_type: "json",
				metadata: {
					schema_version: PLAN_REVIEW_SCHEMA_VERSION,
					source: PLAN_REVIEW_SOURCE,
					run_id: "run-123",
				},
			}),
		);
	});

	it("falls back to the event log hook when memory is unavailable", async () => {
		const eventLogger = vi.fn(async () => undefined);

		const result = await writePlanReviewRecord(makeReview(), {
			eventLogger,
			now: () => FIXED_DATE,
		});

		expect(result.status).toBe("fallback_logged");
		expect(result.fallback).toEqual({
			kind: "planning_review_fallback",
			reason: "memory_unavailable",
			error_code: undefined,
			created_at: FIXED_DATE.toISOString(),
			review: makeReview(),
		});
		expect(eventLogger).toHaveBeenCalledWith(result.fallback);
	});

	it("falls back to the event log hook when semantic storage fails", async () => {
		const eventLogger = vi.fn(async () => undefined);

		const result = await writePlanReviewRecord(makeReview(), {
			client: {
				recall: vi.fn(async () => []),
				store: vi.fn(async () => {
					throw new Error("semantic backend offline");
				}),
			},
			eventLogger,
			now: () => FIXED_DATE,
		});

		expect(result.status).toBe("fallback_logged");
		expect(result.fallback).toEqual({
			kind: "planning_review_fallback",
			reason: "store_failed",
			error_code: "SEMANTIC_BACKEND_OFFLINE",
			created_at: FIXED_DATE.toISOString(),
			review: makeReview(),
		});
		expect(eventLogger).toHaveBeenCalledWith(result.fallback);
	});

	it("does not throw when fallback logging fails", async () => {
		const eventLogger = vi.fn(async () => {
			throw new Error("fallback log unavailable");
		});

		const result = await writePlanReviewRecord(makeReview(), {
			eventLogger,
			now: () => FIXED_DATE,
		});

		expect(result.status).toBe("fallback_logged");
		expect(result.fallback).toEqual({
			kind: "planning_review_fallback",
			reason: "memory_unavailable",
			error_code: undefined,
			logger_error_code: "FALLBACK_LOG_UNAVAILABLE",
			created_at: FIXED_DATE.toISOString(),
			review: makeReview(),
		});
		expect(eventLogger).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "planning_review_fallback",
				reason: "memory_unavailable",
			}),
		);
	});
});
