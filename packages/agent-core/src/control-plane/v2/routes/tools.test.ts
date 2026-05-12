import { describe, expect, it } from "vitest";
import { createStubRuntime, readJsonResponse } from "../test-fixtures.js";
import { handle } from "./tools.js";

describe("v2 route — /api/v2/tools", () => {
	it("returns the tools catalog", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/tools");
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
	});

	it("rejects PUT with 405", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/tools", {
			method: "PUT",
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(405);
	});

	it("propagates errors as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			listTools: () => {
				throw new Error("offline");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/tools");
		const response = await handle(request, broken);
		expect(response.status).toBe(500);
	});
});
