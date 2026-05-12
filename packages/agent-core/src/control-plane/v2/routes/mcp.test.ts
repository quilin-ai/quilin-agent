import { describe, expect, it } from "vitest";
import { createStubRuntime, readJsonResponse } from "../test-fixtures.js";
import { handle } from "./mcp.js";

describe("v2 route — /api/v2/mcp", () => {
	it("returns the MCP registry", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/mcp");
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
	});

	it("rejects DELETE with 405", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/mcp", {
			method: "DELETE",
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(405);
	});

	it("propagates errors as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			listMcp: () => {
				throw new Error("nope");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/mcp");
		const response = await handle(request, broken);
		expect(response.status).toBe(500);
	});
});
