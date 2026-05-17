import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
	ELICITATION_DEFAULT_TIMEOUT_MS,
	ELICITATION_SCHEMA_MAX_DEPTH,
	ELICITATION_SCHEMA_MAX_KEYS,
	ELICITATION_SCHEMA_MAX_STRING_LEN,
	type ElicitationCapableClient,
	type ElicitationHandlerOptions,
	type ElicitationRequest,
	type ElicitationResolver,
	registerElicitationHandler,
	validateSchemaBounds,
} from "./elicitation-handler.js";

type Handler = (
	request: { params: unknown },
	extra: unknown,
) => Promise<unknown>;

interface CapturedRegistration {
	readonly schema: typeof ElicitRequestSchema;
	readonly handler: Handler;
}

function makeClient(): {
	client: ElicitationCapableClient;
	registrations: CapturedRegistration[];
} {
	const registrations: CapturedRegistration[] = [];
	const client: ElicitationCapableClient = {
		setRequestHandler: ((schema: never, handler: never) => {
			registrations.push({
				schema: schema as typeof ElicitRequestSchema,
				handler: handler as Handler,
			});
		}) as ElicitationCapableClient["setRequestHandler"],
	};
	return { client, registrations };
}

/**
 * Register the handler and return it directly, avoiding any need for
 * non-null assertions on `registrations[0]` at every call site.
 */
function registerAndGetHandler(options: ElicitationHandlerOptions): {
	handler: Handler;
	registrations: CapturedRegistration[];
} {
	const { client, registrations } = makeClient();
	registerElicitationHandler(client, options);
	const first = registrations[0];
	if (first === undefined) {
		throw new Error("expected at least one registration");
	}
	return { handler: first.handler, registrations };
}

describe("registerElicitationHandler", () => {
	it("registers a handler keyed by ElicitRequestSchema", () => {
		const { client, registrations } = makeClient();
		registerElicitationHandler(client, {
			resolver: () => ({ action: "decline" }),
		});
		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.schema).toBe(ElicitRequestSchema);
	});

	it("forwards form-mode params to the resolver and returns accept+content", async () => {
		const resolver = vi.fn<ElicitationResolver>((req) => {
			expect(req.mode).toBe("form");
			expect(req.message).toBe("Need API key");
			return {
				action: "accept",
				content: { apiKey: "sk-123", count: 3, ok: true },
			};
		});
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: {
					message: "Need API key",
					requestedSchema: {
						type: "object",
						properties: { apiKey: { type: "string" } },
					},
				},
			},
			{},
		);
		expect(result).toEqual({
			action: "accept",
			content: { apiKey: "sk-123", count: 3, ok: true },
		});
		expect(resolver).toHaveBeenCalledTimes(1);
	});

	it("normalizes url-mode params and strips content from accept response", async () => {
		const observed: ElicitationRequest[] = [];
		const resolver: ElicitationResolver = (req) => {
			observed.push(req);
			return { action: "accept", content: { ignored: "yes" } };
		};
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: {
					mode: "url",
					message: "Open browser",
					elicitationId: "el-1",
					url: "https://example.com/auth",
				},
			},
			{},
		);
		expect(result).toEqual({ action: "accept" });
		expect(observed[0]).toEqual({
			mode: "url",
			message: "Open browser",
			elicitationId: "el-1",
			url: "https://example.com/auth",
		});
	});

	it("returns decline as-is and ignores any stray content", async () => {
		const { handler } = registerAndGetHandler({
			resolver: () => ({ action: "decline", content: { x: "ignored" } }),
		});
		const result = await handler(
			{
				params: {
					message: "no",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "decline" });
	});

	it("converts resolver throw into safe cancel result", async () => {
		const { handler } = registerAndGetHandler({
			resolver: () => {
				throw new Error("resolver crashed");
			},
		});
		const result = await handler(
			{
				params: {
					message: "any",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
	});

	it("converts an async resolver rejection into safe cancel result", async () => {
		const { handler } = registerAndGetHandler({
			resolver: () => Promise.reject(new Error("async-fail")),
		});
		const result = await handler(
			{
				params: {
					message: "async",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
	});

	it("falls back to decline when accept payload is missing content for form mode", async () => {
		const { handler } = registerAndGetHandler({
			resolver: () => ({ action: "accept" }),
		});
		const result = await handler(
			{
				params: {
					message: "Need a value",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "decline" });
	});

	it("sanitizes content — keeps primitives + string arrays, drops other types", async () => {
		const { handler } = registerAndGetHandler({
			resolver: () => ({
				action: "accept",
				content: {
					name: "ada",
					age: 30,
					subscribed: true,
					tags: ["a", "b"],
					// @ts-expect-error intentional bad shape to exercise sanitizer
					mixed: ["a", 1, true],
					// @ts-expect-error intentional bad shape
					bogus: { not: "primitive" },
				},
			}),
		});
		const result = (await handler(
			{
				params: {
					message: "fill",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		)) as { action: string; content: Record<string, unknown> };
		expect(result.action).toBe("accept");
		expect(result.content).toEqual({
			name: "ada",
			age: 30,
			subscribed: true,
			tags: ["a", "b"],
			mixed: ["a"],
		});
		expect(result.content).not.toHaveProperty("bogus");
	});

	it("uses default timeout constant when no custom timeoutMs is provided", async () => {
		expect(ELICITATION_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
		const { handler } = registerAndGetHandler({
			resolver: () => ({ action: "decline" }),
		});
		const result = await handler(
			{
				params: {
					message: "x",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "decline" });
	});

	it("cancels when resolver exceeds the configured timeout", async () => {
		const { handler } = registerAndGetHandler({
			resolver: () => new Promise(() => {}),
			timeoutMs: 15,
		});
		const result = await handler(
			{
				params: {
					message: "slow",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
	});

	it("accepts a synchronous resolver return value", async () => {
		const { handler } = registerAndGetHandler({
			resolver: () => ({ action: "accept", content: { v: "ok" } }),
		});
		const result = await handler(
			{
				params: {
					message: "go",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "accept", content: { v: "ok" } });
	});

	it("defaults missing message / schema to safe empty values", async () => {
		const observed: ElicitationRequest[] = [];
		const { handler } = registerAndGetHandler({
			resolver: (req) => {
				observed.push(req);
				return { action: "decline" };
			},
		});
		await handler({ params: {} }, {});
		expect(observed[0]).toEqual({
			mode: "form",
			message: "",
			requestedSchema: { type: "object", properties: {} },
		});
	});

	it("rejects url-mode requests with no url (empty string fails scheme check) before calling resolver (REAL-2)", async () => {
		const resolver = vi.fn<ElicitationResolver>(() => ({ action: "accept" }));
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler({ params: { mode: "url" } }, {});
		expect(result).toEqual({ action: "cancel" });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("rejects url-mode javascript: scheme without invoking resolver (REAL-2)", async () => {
		const resolver = vi.fn<ElicitationResolver>(() => ({ action: "accept" }));
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: {
					mode: "url",
					message: "Open this",
					elicitationId: "el-evil",
					url: "javascript:alert(1)",
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("rejects url-mode data: scheme (REAL-2)", async () => {
		const resolver = vi.fn<ElicitationResolver>(() => ({ action: "accept" }));
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: {
					mode: "url",
					url: "data:text/html,<script>alert(1)</script>",
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("rejects url-mode file: scheme (REAL-2)", async () => {
		const resolver = vi.fn<ElicitationResolver>(() => ({ action: "accept" }));
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: { mode: "url", url: "file:///etc/passwd" },
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("rejects malformed url-mode URL (parse failure) (REAL-2)", async () => {
		const resolver = vi.fn<ElicitationResolver>(() => ({ action: "accept" }));
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: { mode: "url", url: "not a url" },
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("accepts https url-mode and forwards to resolver (REAL-2)", async () => {
		const observed: ElicitationRequest[] = [];
		const { handler } = registerAndGetHandler({
			resolver: (req) => {
				observed.push(req);
				return { action: "accept" };
			},
		});
		const result = await handler(
			{
				params: {
					mode: "url",
					message: "Login",
					elicitationId: "el-1",
					url: "https://example.com/auth",
				},
			},
			{},
		);
		expect(result).toEqual({ action: "accept" });
		expect(observed[0]).toEqual({
			mode: "url",
			message: "Login",
			elicitationId: "el-1",
			url: "https://example.com/auth",
		});
	});

	it("accepts http url-mode and forwards to resolver (REAL-2 — http is allowed in dev/loopback)", async () => {
		const observed: ElicitationRequest[] = [];
		const { handler } = registerAndGetHandler({
			resolver: (req) => {
				observed.push(req);
				return { action: "accept" };
			},
		});
		const result = await handler(
			{
				params: {
					mode: "url",
					url: "http://localhost:8080/cb",
				},
			},
			{},
		);
		expect(result).toEqual({ action: "accept" });
		expect(observed[0]?.mode).toBe("url");
	});

	it("rejects requestedSchema deeper than max depth without invoking resolver (REAL-3)", async () => {
		// Build a deeply nested object: depth = MAX + 5
		let nested: Record<string, unknown> = { leaf: 1 };
		const overflow = ELICITATION_SCHEMA_MAX_DEPTH + 5;
		for (let i = 0; i < overflow; i++) {
			nested = { wrap: nested };
		}
		const resolver = vi.fn<ElicitationResolver>(() => ({ action: "accept" }));
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: {
					message: "deep",
					requestedSchema: {
						type: "object",
						properties: { root: nested },
					},
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("rejects requestedSchema with too many keys without invoking resolver (REAL-3)", async () => {
		const properties: Record<string, unknown> = {};
		// Exceed the cap. Total key count = properties' own keys + each nested
		// {type:"string"} object key. Use a large multiplier to be safe.
		for (let i = 0; i < ELICITATION_SCHEMA_MAX_KEYS + 50; i++) {
			properties[`f${i}`] = { type: "string" };
		}
		const resolver = vi.fn<ElicitationResolver>(() => ({ action: "accept" }));
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: {
					message: "wide",
					requestedSchema: { type: "object", properties },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("accepts a normal requestedSchema within all bounds (REAL-3)", async () => {
		const observed: ElicitationRequest[] = [];
		const { handler } = registerAndGetHandler({
			resolver: (req) => {
				observed.push(req);
				return { action: "accept", content: { v: "x" } };
			},
		});
		const result = await handler(
			{
				params: {
					message: "fill",
					requestedSchema: {
						type: "object",
						properties: {
							v: { type: "string", description: "value" },
						},
						required: ["v"],
					},
				},
			},
			{},
		);
		expect(result).toEqual({ action: "accept", content: { v: "x" } });
		expect(observed).toHaveLength(1);
	});

	it("rejects requestedSchema with an overlong string field (REAL-3)", async () => {
		const huge = "x".repeat(ELICITATION_SCHEMA_MAX_STRING_LEN + 1);
		const resolver = vi.fn<ElicitationResolver>(() => ({ action: "accept" }));
		const { handler } = registerAndGetHandler({ resolver });
		const result = await handler(
			{
				params: {
					message: "long",
					requestedSchema: {
						type: "object",
						properties: {
							v: { type: "string", description: huge },
						},
					},
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("defaults missing url-mode fields rejects (no url → scheme check fails) (REAL-2)", async () => {
		const observed: ElicitationRequest[] = [];
		const { handler } = registerAndGetHandler({
			resolver: (req) => {
				observed.push(req);
				return { action: "decline" };
			},
		});
		const result = await handler({ params: { mode: "url" } }, {});
		expect(result).toEqual({ action: "cancel" });
		expect(observed).toHaveLength(0);
	});
});

describe("validateSchemaBounds (REAL-3 — unit-level)", () => {
	const bounds = {
		maxDepth: 4,
		maxKeys: 10,
		maxStringLen: 32,
	};

	it("accepts a small flat schema", () => {
		const r = validateSchemaBounds(
			{ type: "object", properties: { a: { type: "string" } } },
			bounds,
		);
		expect(r.ok).toBe(true);
	});

	it("rejects depth overflow", () => {
		let nested: unknown = "leaf";
		for (let i = 0; i < 10; i++) nested = { x: nested };
		const r = validateSchemaBounds(nested, bounds);
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.reason).toContain("maxDepth");
	});

	it("rejects key-count overflow", () => {
		const props: Record<string, unknown> = {};
		for (let i = 0; i < 30; i++) props[`k${i}`] = 1;
		const r = validateSchemaBounds(props, bounds);
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.reason).toContain("maxKeys");
	});

	it("rejects long string values", () => {
		const r = validateSchemaBounds({ desc: "a".repeat(100) }, bounds);
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.reason).toContain("maxStringLen");
	});

	it("rejects long key names", () => {
		const long = "k".repeat(100);
		const r = validateSchemaBounds({ [long]: 1 }, bounds);
		expect(r.ok).toBe(false);
	});

	it("handles arrays without counting them as object keys", () => {
		const r = validateSchemaBounds({ list: [1, 2, 3, "x"] }, bounds);
		expect(r.ok).toBe(true);
	});
});
