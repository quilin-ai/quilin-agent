import { describe, expect, it } from "vitest";
import { RuntimeSnapshotSchema } from "../schemas.js";
import {
	createStubRuntime,
	readJsonResponse,
	stubSnapshot,
} from "../test-fixtures.js";
import { handle } from "./snapshot.js";

describe("v2 route — /api/v2/snapshot", () => {
	it("returns the runtime snapshot wrapped in the success envelope", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/snapshot");
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.data).toEqual(stubSnapshot);
		expect(RuntimeSnapshotSchema.safeParse(body.data).success).toBe(true);
	});

	it("rejects non-GET methods with 405", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/snapshot", {
			method: "POST",
		});
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(405);
		expect(body.ok).toBe(false);
		expect(body.error?.code).toBe("method_not_allowed");
	});

	it("surfaces runtime errors as a 500 envelope", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			getRuntimeSnapshot: () => {
				throw new Error("boom");
			},
		};
		const request = new Request("http://127.0.0.1/api/v2/snapshot");
		const response = await handle(request, broken);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(500);
		expect(body.error?.code).toBe("internal");
		expect(body.error?.message).toBe("boom");
	});

	it("surfaces non-Error rejections as a stringified message", async () => {
		const runtime = createStubRuntime();
		const broken = {
			...runtime,
			getRuntimeSnapshot: () => Promise.reject("string failure"),
		};
		const request = new Request("http://127.0.0.1/api/v2/snapshot");
		const response = await handle(request, broken);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(500);
		expect(body.error?.message).toBe("string failure");
	});
});
