import { describe, expect, it } from "vitest";
import {
	errorEnvelope,
	errorResponse,
	errorToResponse,
	internalErrorResponse,
	jsonResponse,
	methodNotAllowedResponse,
	notFoundResponse,
	successEnvelope,
	successResponse,
	validationErrorResponse,
} from "./responses.js";

async function readBody(response: Response): Promise<{
	readonly ok: boolean;
	readonly data?: unknown;
	readonly error?: { code: string; message: string; detail?: unknown };
}> {
	return JSON.parse(await response.text());
}

describe("v2 response helpers", () => {
	it("successEnvelope wraps payload", () => {
		expect(successEnvelope({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
	});

	it("errorEnvelope includes detail only when provided", () => {
		expect(errorEnvelope("c", "m")).toEqual({
			ok: false,
			error: { code: "c", message: "m" },
		});
		expect(errorEnvelope("c", "m", { extra: 1 })).toEqual({
			ok: false,
			error: { code: "c", message: "m", detail: { extra: 1 } },
		});
	});

	it("jsonResponse sets standard headers and stringifies the body", async () => {
		const response = jsonResponse(200, { hello: "world" });
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toContain('"hello":"world"');
	});

	it("jsonResponse merges extra headers", () => {
		const response = jsonResponse(200, {}, { "x-custom": "v" });
		expect(response.headers.get("x-custom")).toBe("v");
	});

	it("successResponse defaults to 200", async () => {
		const response = successResponse({ ok: 1 });
		expect(response.status).toBe(200);
		const body = await readBody(response);
		expect(body.ok).toBe(true);
		expect(body.data).toEqual({ ok: 1 });
	});

	it("successResponse can set custom status code", () => {
		expect(successResponse({}, 201).status).toBe(201);
	});

	it("errorResponse sets the configured status", async () => {
		const response = errorResponse(403, "denied", "no");
		expect(response.status).toBe(403);
		const body = await readBody(response);
		expect(body.error?.code).toBe("denied");
	});

	it("notFoundResponse returns 404 with not_found code", async () => {
		const response = notFoundResponse();
		expect(response.status).toBe(404);
		const body = await readBody(response);
		expect(body.error?.code).toBe("not_found");
	});

	it("methodNotAllowedResponse sets allow header", () => {
		const response = methodNotAllowedResponse(["GET", "POST"]);
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, POST");
	});

	it("validationErrorResponse returns 400 with detail", async () => {
		const response = validationErrorResponse({ field: "x" });
		expect(response.status).toBe(400);
		const body = await readBody(response);
		expect(body.error?.detail).toEqual({ field: "x" });
	});

	it("internalErrorResponse returns 500", () => {
		expect(internalErrorResponse("boom").status).toBe(500);
	});

	it("errorToResponse handles Error and non-Error", async () => {
		const a = await readBody(errorToResponse(new Error("boom")));
		expect(a.error?.message).toBe("boom");
		const b = await readBody(errorToResponse("string err"));
		expect(b.error?.message).toBe("string err");
	});
});
