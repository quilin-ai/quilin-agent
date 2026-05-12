import { describe, expect, it } from "vitest";
import { handleV2 } from "./router.js";
import { createStubRuntime, readJsonResponse } from "./test-fixtures.js";

describe("v2 router — dispatch", () => {
	const runtime = createStubRuntime();

	it("returns null for paths outside /api/v2/", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v1/anything"),
			{ runtime },
		);
		expect(response).toBeNull();
	});

	it("returns null for paths above v2 prefix (e.g. /api/v2other)", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2other"),
			{ runtime },
		);
		expect(response).toBeNull();
	});

	it("dispatches /api/v2/snapshot to snapshot route", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/snapshot"),
			{ runtime },
		);
		expect(response?.status).toBe(200);
	});

	it("dispatches /api/v2/sessions to sessions route", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/sessions"),
			{ runtime },
		);
		expect(response?.status).toBe(200);
	});

	it("dispatches /api/v2/sessions/:id with remainder", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/sessions/session-001"),
			{ runtime },
		);
		expect(response?.status).toBe(200);
	});

	it("dispatches /api/v2/memory/tiers", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/memory/tiers"),
			{ runtime },
		);
		expect(response?.status).toBe(200);
	});

	it("dispatches /api/v2/skills, /api/v2/tools, /api/v2/mcp", async () => {
		for (const path of ["skills", "tools", "mcp"]) {
			const response = await handleV2(
				new Request(`http://127.0.0.1/api/v2/${path}`),
				{ runtime },
			);
			expect(response?.status).toBe(200);
		}
	});

	it("dispatches /api/v2/config get and post", async () => {
		const getResp = await handleV2(
			new Request("http://127.0.0.1/api/v2/config"),
			{ runtime },
		);
		expect(getResp?.status).toBe(200);

		const postResp = await handleV2(
			new Request("http://127.0.0.1/api/v2/config", {
				method: "POST",
				body: JSON.stringify({ autoReflect: false }),
			}),
			{ runtime },
		);
		expect(postResp?.status).toBe(200);
	});

	it("dispatches /api/v2/agents", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/agents"),
			{ runtime },
		);
		expect(response?.status).toBe(200);
	});

	it("dispatches /api/v2/authorize", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/authorize", {
				method: "POST",
				body: JSON.stringify({ requestId: "x", decision: "approve" }),
			}),
			{ runtime },
		);
		expect(response?.status).toBe(200);
	});

	it("dispatches /api/v2/events with sse options forwarded", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			{
				runtime,
				sseOptions: { heartbeatIntervalMs: 5 },
			},
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		await response?.body?.cancel();
	});

	it("dispatches /api/v2/events with default sse options when omitted", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			{ runtime },
		);
		expect(response?.status).toBe(200);
		await response?.body?.cancel();
	});

	it("returns 404 for unknown sub-route", async () => {
		const response = await handleV2(
			new Request("http://127.0.0.1/api/v2/unknown"),
			{ runtime },
		);
		const { status, body } = await readJsonResponse(response as Response);
		expect(status).toBe(404);
		expect(body.error?.code).toBe("not_found");
	});

	it("returns 404 for bare /api/v2 prefix", async () => {
		const response = await handleV2(new Request("http://127.0.0.1/api/v2"), {
			runtime,
		});
		expect(response?.status).toBe(404);
	});

	it("returns 404 for bare /api/v2/ trailing slash with no segments", async () => {
		const response = await handleV2(new Request("http://127.0.0.1/api/v2/"), {
			runtime,
		});
		expect(response?.status).toBe(404);
	});
});
