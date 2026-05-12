import { describe, expect, it } from "vitest";
import { SessionsListResponse } from "../schemas.js";
import { createStubRuntime, readJsonResponse } from "../test-fixtures.js";
import { handle } from "./sessions.js";

describe("v2 route — /api/v2/sessions (list)", () => {
	it("returns the sessions list with envelope", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/sessions");
		const response = await handle(request, runtime, "");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(SessionsListResponse.safeParse(body.data).success).toBe(true);
	});

	it("rejects non-integer limit with validation_error", async () => {
		const runtime = createStubRuntime();
		const request = new Request(
			"http://127.0.0.1/api/v2/sessions?limit=not-a-number",
		);
		const response = await handle(request, runtime, "");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("rejects negative limit with validation_error", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/sessions?limit=-1");
		const response = await handle(request, runtime, "");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("clamps limit to upper bound and forwards cursor", async () => {
		const captured: { limit?: number; cursor?: string | null } = {};
		const runtime = createStubRuntime();
		const wrapped = {
			...runtime,
			listSessions: (options: { limit?: number; cursor?: string | null }) => {
				captured.limit = options.limit;
				captured.cursor = options.cursor;
				return { items: [], nextCursor: null };
			},
		};
		const request = new Request(
			"http://127.0.0.1/api/v2/sessions?limit=99999&cursor=xyz",
		);
		const response = await handle(request, wrapped, "");
		expect(response.status).toBe(200);
		expect(captured.limit).toBe(200);
		expect(captured.cursor).toBe("xyz");
	});

	it("accepts limit=0 as explicit empty page", async () => {
		const captured: { limit?: number } = {};
		const runtime = createStubRuntime();
		const wrapped = {
			...runtime,
			listSessions: (options: { limit?: number }) => {
				captured.limit = options.limit;
				return { items: [], nextCursor: null };
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/sessions?limit=0");
		const response = await handle(request, wrapped, "");
		expect(response.status).toBe(200);
		expect(captured.limit).toBe(0);
	});

	it("handles trailing slash on list path", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/sessions/");
		const response = await handle(request, runtime, "/");
		expect(response.status).toBe(200);
	});

	it("rejects non-GET with 405", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/sessions", {
			method: "DELETE",
		});
		const response = await handle(request, runtime, "");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(405);
		expect(body.error?.code).toBe("method_not_allowed");
	});

	it("propagates listSessions runtime errors as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			listSessions: () => {
				throw new Error("db down");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/sessions");
		const response = await handle(request, broken, "");
		expect(response.status).toBe(500);
	});
});

describe("v2 route — /api/v2/sessions/:id", () => {
	it("returns the session detail when found", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/sessions/session-001");
		const response = await handle(request, runtime, "session-001");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
	});

	it("returns 404 session_not_found for unknown ids", async () => {
		const runtime = createStubRuntime();
		const request = new Request(
			"http://127.0.0.1/api/v2/sessions/missing-session",
		);
		const response = await handle(request, runtime, "missing-session");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(404);
		expect(body.error?.code).toBe("session_not_found");
	});

	it("rejects an empty path segment with validation_error", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/sessions/");
		const response = await handle(
			request,
			{
				...runtime,
				listSessions: () => ({ items: [], nextCursor: null }),
			},
			"/",
		);
		// '/' normalizes to empty list path → 200
		expect(response.status).toBe(200);
	});

	it("rejects a path segment longer than SessionId schema allows", async () => {
		const runtime = createStubRuntime();
		const tooLong = "a".repeat(65);
		const request = new Request(`http://127.0.0.1/api/v2/sessions/${tooLong}`);
		const response = await handle(request, runtime, tooLong);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("decodes URL-encoded ids", async () => {
		const runtime = createStubRuntime();
		const captured: string[] = [];
		const wrapped = {
			...runtime,
			getSession: (id: string) => {
				captured.push(id);
				return null;
			},
		};
		const encoded = encodeURIComponent("with space");
		const request = new Request(`http://127.0.0.1/api/v2/sessions/${encoded}`);
		const response = await handle(request, wrapped, encoded);
		expect(response.status).toBe(404);
		expect(captured[0]).toBe("with space");
	});

	it("surfaces RangeError as 400 validation_error", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			getSession: () => {
				throw new RangeError("nope");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/sessions/session-001");
		const response = await handle(request, broken, "session-001");
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("surfaces generic errors as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			getSession: () => {
				throw new Error("oops");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/sessions/session-001");
		const response = await handle(request, broken, "session-001");
		expect(response.status).toBe(500);
	});

	it("supports stub override via function returning hit/miss and null", async () => {
		const funcRuntime = createStubRuntime({
			session: (id) =>
				id === "lookup-me"
					? {
							session: {
								id: "lookup-me",
								title: "",
								agentId: "main",
								turnsCount: 0,
								tokensTotal: 0,
								startedAt: "2026-05-12T08:00:00.000Z",
								lastTurnAt: "2026-05-12T08:00:00.000Z",
								status: "active",
								costUsd: null,
							},
							turns: [],
						}
					: null,
		});
		const okResponse = await handle(
			new Request("http://127.0.0.1/api/v2/sessions/lookup-me"),
			funcRuntime,
			"lookup-me",
		);
		expect(okResponse.status).toBe(200);
		const missResponse = await handle(
			new Request("http://127.0.0.1/api/v2/sessions/no-match"),
			funcRuntime,
			"no-match",
		);
		expect(missResponse.status).toBe(404);
	});
});
