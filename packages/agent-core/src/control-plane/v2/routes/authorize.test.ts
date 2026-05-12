import { describe, expect, it } from "vitest";
import { createStubRuntime, readJsonResponse } from "../test-fixtures.js";
import { handle } from "./authorize.js";

describe("v2 route — /api/v2/authorize", () => {
	it("approves when runtime returns ok", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
			body: JSON.stringify({ requestId: "auth-1", decision: "approve" }),
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse<{
			requestId: string;
			resolved: boolean;
		}>(response);
		expect(status).toBe(200);
		expect(body.data?.resolved).toBe(true);
		expect(body.data?.requestId).toBe("auth-1");
	});

	it("denies when runtime returns ok", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
			body: JSON.stringify({ requestId: "auth-1", decision: "deny" }),
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(200);
	});

	it("returns 410 when the request expired", async () => {
		const runtime = createStubRuntime({
			authorize: () => ({
				kind: "expired" as const,
				code: "auth_request_expired" as const,
				message: "expired",
			}),
		});
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
			body: JSON.stringify({ requestId: "x", decision: "approve" }),
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(410);
		expect(body.error?.code).toBe("auth_request_expired");
	});

	it("returns 409 when the request was already resolved", async () => {
		const runtime = createStubRuntime({
			authorize: () => ({
				kind: "already_resolved" as const,
				code: "auth_request_already_resolved" as const,
				message: "already done",
			}),
		});
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
			body: JSON.stringify({ requestId: "x", decision: "approve" }),
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(409);
		expect(body.error?.code).toBe("auth_request_already_resolved");
	});

	it("returns 404 when the runtime can't find the request", async () => {
		const runtime = createStubRuntime({
			authorize: () => ({
				kind: "not_found" as const,
				code: "agent_not_found" as const,
				message: "no agent",
			}),
		});
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
			body: JSON.stringify({ requestId: "x", decision: "approve" }),
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(404);
		expect(body.error?.code).toBe("agent_not_found");
	});

	it("returns validation_error for missing fields", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
			body: JSON.stringify({ requestId: "x" }),
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(400);
	});

	it("returns validation_error for malformed JSON", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
			body: "{not json",
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("treats empty body as empty payload (which still fails schema)", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(400);
	});

	it("rejects non-POST with 405", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/authorize");
		const response = await handle(request, runtime);
		expect(response.status).toBe(405);
	});

	it("propagates runtime exceptions as 500", async () => {
		const runtime = createStubRuntime({
			authorize: () => {
				throw new Error("boom");
			},
		});
		const request = new Request("http://127.0.0.1/api/v2/authorize", {
			method: "POST",
			body: JSON.stringify({ requestId: "x", decision: "approve" }),
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(500);
	});
});
