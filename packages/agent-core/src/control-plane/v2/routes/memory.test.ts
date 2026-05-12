import { describe, expect, it } from "vitest";
import { createStubRuntime, readJsonResponse } from "../test-fixtures.js";
import { handle } from "./memory.js";

describe("v2 route — /api/v2/memory/tiers", () => {
	it("returns four tier counts", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/memory/tiers");
		const response = await handle(request, runtime, "tiers");
		const { status, body } =
			await readJsonResponse<Array<{ tier: string; count: number }>>(response);
		expect(status).toBe(200);
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data?.length).toBe(4);
	});

	it("propagates errors as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			listMemoryTiers: () => {
				throw new Error("nope");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/memory/tiers");
		const response = await handle(request, broken, "tiers");
		expect(response.status).toBe(500);
	});
});

describe("v2 route — /api/v2/memory/recent", () => {
	it("returns recent entries with default limit", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/memory/recent");
		const response = await handle(request, runtime, "recent");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
	});

	it("forwards tier and limit query params", async () => {
		let captured: { tier?: string; limit?: number } = {};
		const runtime = createStubRuntime({
			memoryRecent: (options) => {
				captured = options;
				return [];
			},
		});
		const request = new Request(
			"http://127.0.0.1/api/v2/memory/recent?tier=skill&limit=7",
		);
		const response = await handle(request, runtime, "recent");
		expect(response.status).toBe(200);
		expect(captured.tier).toBe("skill");
		expect(captured.limit).toBe(7);
	});

	it("clamps recent limit to upper bound", async () => {
		let captured: { limit?: number } = {};
		const runtime = createStubRuntime({
			memoryRecent: (options) => {
				captured = options;
				return [];
			},
		});
		const request = new Request(
			"http://127.0.0.1/api/v2/memory/recent?limit=999999",
		);
		const response = await handle(request, runtime, "recent");
		expect(response.status).toBe(200);
		expect(captured.limit).toBe(200);
	});

	it("rejects unknown tier", async () => {
		const runtime = createStubRuntime();
		const request = new Request(
			"http://127.0.0.1/api/v2/memory/recent?tier=bogus",
		);
		const response = await handle(request, runtime, "recent");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("rejects non-integer limit", async () => {
		const runtime = createStubRuntime();
		const request = new Request(
			"http://127.0.0.1/api/v2/memory/recent?limit=abc",
		);
		const response = await handle(request, runtime, "recent");
		expect(response.status).toBe(400);
	});

	it("rejects negative limit", async () => {
		const runtime = createStubRuntime();
		const request = new Request(
			"http://127.0.0.1/api/v2/memory/recent?limit=-2",
		);
		const response = await handle(request, runtime, "recent");
		expect(response.status).toBe(400);
	});

	it("propagates errors as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			listMemoryRecent: () => {
				throw new Error("backend gone");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/memory/recent");
		const response = await handle(request, broken, "recent");
		expect(response.status).toBe(500);
	});
});

describe("v2 route — /api/v2/memory miscellaneous", () => {
	it("returns 405 for non-GET", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/memory/tiers", {
			method: "PATCH",
		});
		const response = await handle(request, runtime, "tiers");
		expect(response.status).toBe(405);
	});

	it("returns 404 for unknown sub-path", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/memory/unknown");
		const response = await handle(request, runtime, "unknown");
		expect(response.status).toBe(404);
	});
});
