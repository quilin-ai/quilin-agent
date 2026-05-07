import { describe, expect, expectTypeOf, it } from "vitest";
import type { MemoryClient } from "./client.js";
import { LocalMemoryClient } from "./local-client.js";
import type { MemoryItem, MemoryLayer } from "./types.js";

function makeMemoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
	return {
		id: crypto.randomUUID(),
		content: "Integration test memory entry about agent mesh protocol design.",
		content_type: "text/plain",
		layer: "working" as MemoryLayer,
		metadata: { schema_version: 1, source: "test" },
		embedding: null,
		created_at: new Date().toISOString(),
		last_accessed: new Date().toISOString(),
		access_count: 0,
		importance_score: 0.75,
		...overrides,
	};
}

describe("LocalMemoryClient", () => {
	it("implements the MemoryClient interface", () => {
		const client = new LocalMemoryClient(":memory:");
		expectTypeOf(client).toMatchTypeOf<MemoryClient>();
		client.dispose();
	});

	it("stores and recalls a MemoryItem end-to-end", async () => {
		const client = new LocalMemoryClient(":memory:");
		const item = makeMemoryItem({
			content: "End-to-end test: Docker sandbox router adapter pattern",
		});

		await client.store(item);

		const results = await client.recall("Docker sandbox router");
		expect(results.length).toBeGreaterThanOrEqual(1);

		const found = results.find((r) => r.id === item.id);
		expect(found).toBeDefined();
		if (!found) {
			return;
		}

		expect(found.content).toBe(item.content);
		expect(found.layer).toBe(item.layer);
		expect(found.content_type).toBe("text/plain");
		expect(found.embedding).toBeNull();
		expect(found.metadata.schema_version).toBe(1);

		client.dispose();
	});

	it("preserves metadata through a store-recall round-trip", async () => {
		const client = new LocalMemoryClient(":memory:");
		const item = makeMemoryItem({
			content: "Metadata round-trip test entry for local memory client",
			layer: "semantic",
			metadata: {
				schema_version: 1,
				source: "unit-test",
				score: 0.88,
				staleness: "fresh",
				custom_field: "custom_value",
			},
			importance_score: 0.92,
		});

		await client.store(item);

		const results = await client.recall("Metadata round-trip");
		const found = results.find((r) => r.id === item.id);
		expect(found).toBeDefined();
		if (!found) {
			return;
		}

		expect(found.metadata.schema_version).toBe(1);
		expect(found.metadata.source).toBe("unit-test");
		expect(found.metadata.score).toBe(0.88);
		expect(found.metadata.staleness).toBe("fresh");
		expect(found.metadata.custom_field).toBe("custom_value");
		expect(found.importance_score).toBe(0.92);
		expect(found.layer).toBe("semantic");

		client.dispose();
	});

	it("recall filters by layer", async () => {
		const client = new LocalMemoryClient(":memory:");
		await client.store(
			makeMemoryItem({
				content: "working layer test content",
				layer: "working",
			}),
		);
		await client.store(
			makeMemoryItem({ content: "skill layer test content", layer: "skill" }),
		);

		const workingResults = await client.recall("layer test", {
			layer: "working",
		});
		for (const item of workingResults) {
			expect(item.layer).toBe("working");
		}

		const skillResults = await client.recall("layer test", { layer: "skill" });
		for (const item of skillResults) {
			expect(item.layer).toBe("skill");
		}

		client.dispose();
	});

	it("recall respects limit", async () => {
		const client = new LocalMemoryClient(":memory:");
		for (let i = 0; i < 5; i++) {
			await client.store(
				makeMemoryItem({ content: `client limit test entry number ${i}` }),
			);
		}

		const results = await client.recall("limit test", { limit: 2 });
		expect(results.length).toBeLessThanOrEqual(2);

		client.dispose();
	});

	it("returns empty array when no match is found", async () => {
		const client = new LocalMemoryClient(":memory:");
		await client.store(
			makeMemoryItem({ content: "known content for no-match test" }),
		);

		const results = await client.recall(
			"completely unrelated gibberish xyzzy123",
		);
		expect(results).toEqual([]);

		client.dispose();
	});

	it("dispose closes the backend", async () => {
		const client = new LocalMemoryClient(":memory:");
		client.dispose();

		// After dispose, operations should throw from the closed backend
		await expect(client.recall("anything")).rejects.toThrow(/closed/i);
		await expect(
			client.store(makeMemoryItem({ content: "after close" })),
		).rejects.toThrow(/closed/i);
	});

	it("stores items across all four memory layers", async () => {
		const client = new LocalMemoryClient(":memory:");
		const layers: MemoryLayer[] = ["working", "episodic", "semantic", "skill"];

		for (const layer of layers) {
			await client.store(
				makeMemoryItem({ content: `cross-layer content for ${layer}`, layer }),
			);
		}

		for (const layer of layers) {
			const results = await client.recall(`cross-layer content`, { layer });
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results[0]!.layer).toBe(layer);
		}

		client.dispose();
	});
});
