import { describe, expect, it } from "vitest";
import {
	createStubRuntime,
	readJsonResponse,
	stubAgents,
} from "../test-fixtures.js";
import { handle } from "./agents.js";

describe("v2 route — /api/v2/agents", () => {
	it("returns the agents list wrapped in { items }", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/agents");
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse<{
			items: typeof stubAgents;
		}>(response);
		expect(status).toBe(200);
		expect(body.data?.items.length).toBe(stubAgents.length);
	});

	it("rejects POST with 405", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/agents", {
			method: "POST",
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(405);
	});

	it("propagates errors as 500", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			listAgents: () => {
				throw new Error("oops");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/agents");
		const response = await handle(request, broken);
		expect(response.status).toBe(500);
	});
});
