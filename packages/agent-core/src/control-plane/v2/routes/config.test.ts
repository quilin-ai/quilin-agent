import { describe, expect, it } from "vitest";
import { createStubRuntime, readJsonResponse } from "../test-fixtures.js";
import { handle } from "./config.js";

describe("v2 route — GET /api/v2/config", () => {
	it("returns the current config", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/config");
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
	});

	it("surfaces GET failures as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			getConfig: () => {
				throw new Error("offline");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/config");
		const response = await handle(request, broken);
		expect(response.status).toBe(500);
	});
});

describe("v2 route — POST /api/v2/config", () => {
	it("accepts a partial patch and returns the resulting config", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/config", {
			method: "POST",
			body: JSON.stringify({ trustMode: "ask" }),
			headers: { "content-type": "application/json" },
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse<{ trustMode: string }>(
			response,
		);
		expect(status).toBe(200);
		expect(body.data?.trustMode).toBe("ask");
	});

	it("returns validation_error for malformed JSON", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/config", {
			method: "POST",
			body: "{not json",
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("returns validation_error for schema mismatch", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/config", {
			method: "POST",
			body: JSON.stringify({ trustMode: "not-a-mode" }),
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(400);
	});

	it("treats empty body as empty patch", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/config", {
			method: "POST",
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(200);
	});

	it("returns 403 forbidden_critical_write when runtime rejects", async () => {
		const runtime = createStubRuntime({
			writeConfig: () => ({
				kind: "forbidden" as const,
				code: "forbidden_critical_write" as const,
				message: "trustMode is CRITICAL; ask gate required",
				detail: { field: "trustMode" },
			}),
		});
		const request = new Request("http://127.0.0.1/api/v2/config", {
			method: "POST",
			body: JSON.stringify({ trustMode: "yolo" }),
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(403);
		expect(body.error?.code).toBe("forbidden_critical_write");
		expect(body.error?.detail).toEqual({ field: "trustMode" });
	});

	it("surfaces POST runtime errors as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			writeConfig: () => {
				throw new Error("nope");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/config", {
			method: "POST",
			body: "{}",
		});
		const response = await handle(request, broken);
		expect(response.status).toBe(500);
	});
});

describe("v2 route — /api/v2/config method handling", () => {
	it("rejects PUT with 405", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/config", {
			method: "PUT",
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(405);
	});
});
