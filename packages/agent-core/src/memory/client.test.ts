import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import { NullMemoryClient } from "./client.js";
import type { MemoryItem, MemoryLayer } from "./types.js";

const FIXTURE_URL = new URL(
	"../../../../providers/memory/tests/fixtures/memory_item.json",
	import.meta.url,
);

const ALL_LAYERS = ["working", "episodic", "semantic", "skill"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}

function isMemoryLayer(value: unknown): value is MemoryLayer {
	return typeof value === "string" && ALL_LAYERS.includes(value as MemoryLayer);
}

function assertMemoryItemShape(value: unknown): asserts value is MemoryItem {
	expect(isRecord(value)).toBe(true);
	if (!isRecord(value)) {
		return;
	}

	expect(typeof value.id).toBe("string");
	expect(typeof value.content).toBe("string");
	expect(typeof value.content_type).toBe("string");
	expect(isMemoryLayer(value.layer)).toBe(true);
	expect(isRecord(value.metadata)).toBe(true);

	if (isRecord(value.metadata)) {
		expect(typeof value.metadata.schema_version).toBe("number");

		if (value.metadata.source != null) {
			expect(typeof value.metadata.source).toBe("string");
		}

		if (value.metadata.score != null) {
			expect(typeof value.metadata.score).toBe("number");
		}

		if (value.metadata.staleness != null) {
			expect(typeof value.metadata.staleness).toBe("string");
		}
	}

	expect(
		value.embedding == null ||
			(Array.isArray(value.embedding) &&
				value.embedding.every((item) => typeof item === "number")),
	).toBe(true);
	expect(typeof value.created_at).toBe("string");
	expect(typeof value.last_accessed).toBe("string");
	expect(typeof value.access_count).toBe("number");
	expect(typeof value.importance_score).toBe("number");
}

describe("MemoryItem fixture compatibility", () => {
	it("parses the shared Python fixture and covers all layers", async () => {
		const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as unknown;

		expect(Array.isArray(fixture)).toBe(true);
		if (!Array.isArray(fixture)) {
			return;
		}

		fixture.forEach(assertMemoryItemShape);

		expect(
			new Set(fixture.map((item) => item.layer)),
		).toEqual(new Set<MemoryLayer>(ALL_LAYERS));
	});

	it("keeps the client contract readonly-compatible with fixture items", async () => {
		const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as MemoryItem[];
		expectTypeOf(fixture).toMatchTypeOf<MemoryItem[]>();
		expect(fixture[0]?.metadata.schema_version).toBe(1);
	});
});

describe("NullMemoryClient", () => {
	it("returns an empty recall result and no-ops on store", async () => {
		const client = new NullMemoryClient();
		const [fixture] = JSON.parse(
			await readFile(FIXTURE_URL, "utf8"),
		) as MemoryItem[];

		await expect(client.recall("checkpoint")).resolves.toEqual([]);
		await expect(client.store(fixture)).resolves.toBeUndefined();
	});
});
