import { describe, expect, it } from "vitest";
import { readJsonBody } from "./json-body.js";

describe("readJsonBody", () => {
	it("returns {} for empty body", async () => {
		const request = new Request("http://127.0.0.1/", {
			method: "POST",
			body: "",
		});
		expect(await readJsonBody(request)).toEqual({});
	});

	it("parses well-formed JSON", async () => {
		const request = new Request("http://127.0.0.1/", {
			method: "POST",
			body: JSON.stringify({ a: 1 }),
		});
		expect(await readJsonBody(request)).toEqual({ a: 1 });
	});

	it("throws SyntaxError with the parser message for malformed JSON", async () => {
		const make = () =>
			new Request("http://127.0.0.1/", { method: "POST", body: "{not json" });
		await expect(readJsonBody(make())).rejects.toThrow(SyntaxError);
		await expect(readJsonBody(make())).rejects.toMatchObject({
			message: expect.stringContaining("malformed JSON body"),
		});
	});

	it("falls back to String(error) when the thrown value is not an Error", async () => {
		// Build a Request-like that throws a non-Error on text(). We test
		// readJsonBody directly to exercise the defensive `String(error)`
		// branch — Request#text() always rejects with Error in practice,
		// but JSON.parse polyfills or other callers may not.
		const rawValue = "raw thrown string";
		const requestLike = {
			text: async () => "not-json-string",
		} as unknown as Request;
		// Monkey-patch JSON.parse for this single call so it throws a
		// non-Error and we can validate the fallback formatting.
		const original = JSON.parse;
		JSON.parse = () => {
			throw rawValue;
		};
		try {
			await expect(readJsonBody(requestLike)).rejects.toMatchObject({
				message: `malformed JSON body: ${rawValue}`,
			});
		} finally {
			JSON.parse = original;
		}
	});
});
