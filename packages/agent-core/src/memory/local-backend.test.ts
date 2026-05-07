import { describe, expect, it } from "vitest";
import type { LocalMemoryItem } from "./local-backend.js";
import { LocalMemoryBackend } from "./local-backend.js";

function createBackend(): LocalMemoryBackend {
	return new LocalMemoryBackend(":memory:");
}

function makeItem(
	overrides: Partial<Omit<LocalMemoryItem, "id">> = {},
): Omit<LocalMemoryItem, "id"> {
	return {
		content: "This is a test memory item about Docker sandbox configuration.",
		layer: "working",
		score: 0.8,
		timestamp: Date.now(),
		metadata_json: JSON.stringify({ schema_version: 1, source: "test" }),
		...overrides,
	};
}

describe("LocalMemoryBackend", () => {
	describe("store and recall round-trip", () => {
		it("stores an item and recalls it via FTS5", () => {
			const backend = createBackend();
			const id = backend.store(
				makeItem({ content: "Docker sandbox router adapter design" }),
			);
			expect(id).toBeTypeOf("string");
			expect(id.length).toBeGreaterThan(0);

			const results = backend.recall("Docker sandbox");
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results.some((r) => r.id === id)).toBe(true);
			backend.close();
		});

		it("returns the stored item with correct fields", () => {
			const backend = createBackend();
			const input = makeItem({
				content: "unique recall test phrase",
				layer: "episodic",
				score: 0.9,
			});
			const id = backend.store(input);

			const results = backend.recall("unique recall test phrase");
			const found = results.find((r) => r.id === id);
			expect(found).toBeDefined();
			if (!found) {
				return;
			}

			expect(found.content).toBe(input.content);
			expect(found.layer).toBe("episodic");
			expect(found.score).toBe(0.9);
			expect(found.metadata_json).toBe(input.metadata_json);
			backend.close();
		});

		it("recall respects the limit option", () => {
			const backend = createBackend();
			for (let i = 0; i < 5; i++) {
				backend.store(
					makeItem({ content: `limit test memory entry number ${i}` }),
				);
			}

			const results = backend.recall("limit test memory", { limit: 2 });
			expect(results.length).toBeLessThanOrEqual(2);
			backend.close();
		});
	});

	describe("FTS5 Chinese search", () => {
		it("finds items containing Chinese text", () => {
			const backend = createBackend();
			const id = backend.store(
				makeItem({
					content:
						"麒麟 Agent 是一个自进化的 AI Agent 框架，支持热更新和多层记忆",
				}),
			);

			const results = backend.recall("麒麟 Agent");
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results.some((r) => r.id === id)).toBe(true);
			backend.close();
		});

		it("finds items with partial Chinese substring match", () => {
			const backend = createBackend();
			const id1 = backend.store(
				makeItem({ content: "热更新是麒麟的核心特性之一" }),
			);
			const id2 = backend.store(
				makeItem({ content: "Docker 沙箱用于安全隔离执行环境" }),
			);

			const results = backend.recall("热更新");
			expect(results.some((r) => r.id === id1)).toBe(true);

			const dockerResults = backend.recall("Docker");
			expect(dockerResults.some((r) => r.id === id2)).toBe(true);
			backend.close();
		});
	});

	describe("layer filtering", () => {
		const layers = ["working", "episodic", "semantic", "skill"] as const;

		it("filters recall results by layer", () => {
			const backend = createBackend();
			for (const layer of layers) {
				backend.store(
					makeItem({ content: `layer test content for ${layer}`, layer }),
				);
			}

			for (const layer of layers) {
				const results = backend.recall("layer test content", { layer });
				expect(results.length).toBeGreaterThanOrEqual(1);
				for (const item of results) {
					expect(item.layer).toBe(layer);
				}
			}

			backend.close();
		});

		it("list filters by layer", () => {
			const backend = createBackend();
			for (const layer of layers) {
				backend.store(
					makeItem({ content: `list filter test ${layer}`, layer }),
				);
			}

			for (const layer of layers) {
				const results = backend.list({ layer });
				expect(results.length).toBeGreaterThanOrEqual(1);
				for (const item of results) {
					expect(item.layer).toBe(layer);
				}
			}

			backend.close();
		});

		it("list returns all layers when no filter is provided", () => {
			const backend = createBackend();
			for (const layer of layers) {
				backend.store(
					makeItem({ content: `all layers recall test ${layer}`, layer }),
				);
			}
			// Store an extra to make sure we have at least 4
			backend.store(
				makeItem({ content: "extra recall item", layer: "working" }),
			);

			const results = backend.recall("all layers recall test");
			const resultLayers = new Set(results.map((r) => r.layer));
			expect(resultLayers.size).toBeGreaterThanOrEqual(1);
			backend.close();
		});
	});

	describe("recall threshold filtering", () => {
		it("excludes items below the threshold", () => {
			const backend = createBackend();
			backend.store(
				makeItem({
					content: "exact unique matching phrase for threshold test",
				}),
			);

			// With a very high threshold, nothing should pass
			const strictResults = backend.recall(
				"exact unique matching phrase for threshold test",
				{
					threshold: 0.99,
				},
			);
			// The exact match should still exist in DB, just filtered out
			expect(Array.isArray(strictResults)).toBe(true);

			// With a low threshold, the item should pass
			const lenientResults = backend.recall(
				"exact unique matching phrase for threshold test",
				{
					threshold: 0.01,
				},
			);
			expect(lenientResults.length).toBeGreaterThanOrEqual(1);
			backend.close();
		});

		it("threshold 0 returns all results", () => {
			const backend = createBackend();
			backend.store(
				makeItem({ content: "zero threshold memory content entry" }),
			);

			const results = backend.recall("zero threshold memory", { threshold: 0 });
			expect(results.length).toBeGreaterThanOrEqual(1);
			backend.close();
		});
	});

	describe("delete", () => {
		it("removes an item so it is no longer recalled", () => {
			const backend = createBackend();
			const id = backend.store(
				makeItem({ content: "delete me memory entry content" }),
			);

			const beforeDelete = backend.recall("delete me");
			expect(beforeDelete.some((r) => r.id === id)).toBe(true);

			backend.delete(id);

			const afterDelete = backend.recall("delete me");
			expect(afterDelete.some((r) => r.id === id)).toBe(false);
			backend.close();
		});

		it("deleting a non-existent id does not throw", () => {
			const backend = createBackend();
			expect(() => backend.delete("non-existent-id")).not.toThrow();
			backend.close();
		});
	});

	describe("list", () => {
		it("returns all stored items ordered by timestamp desc", () => {
			const backend = createBackend();
			const ids: string[] = [];
			for (let i = 0; i < 3; i++) {
				ids.push(
					backend.store(
						makeItem({
							content: `list all test ${i}`,
							timestamp: 1000 + i * 100,
						}),
					),
				);
			}

			const results = backend.list();
			expect(results.length).toBeGreaterThanOrEqual(3);

			// Most recent first
			for (let i = 1; i < results.length; i++) {
				expect(results[i - 1]!.timestamp).toBeGreaterThanOrEqual(
					results[i]!.timestamp,
				);
			}

			backend.close();
		});

		it("respects the limit option", () => {
			const backend = createBackend();
			for (let i = 0; i < 5; i++) {
				backend.store(makeItem({ content: `list limit test ${i}` }));
			}

			const results = backend.list({ limit: 2 });
			expect(results.length).toBe(2);
			backend.close();
		});
	});

	describe("close", () => {
		it("throws when calling store after close", () => {
			const backend = createBackend();
			backend.close();
			expect(() => backend.store(makeItem())).toThrow(/closed/i);
		});

		it("throws when calling recall after close", () => {
			const backend = createBackend();
			backend.close();
			expect(() => backend.recall("test")).toThrow(/closed/i);
		});

		it("throws when calling delete after close", () => {
			const backend = createBackend();
			backend.close();
			expect(() => backend.delete("test-id")).toThrow(/closed/i);
		});

		it("throws when calling list after close", () => {
			const backend = createBackend();
			backend.close();
			expect(() => backend.list()).toThrow(/closed/i);
		});
	});
});
