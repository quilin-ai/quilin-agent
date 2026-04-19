import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { jsonSchemaToZod } from "./schema-converter.js";

vi.mock("../logger.js", () => ({
	logger: {
		warn: vi.fn(),
	},
}));

describe("jsonSchemaToZod", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("converts required and optional string fields", () => {
		const schema = jsonSchemaToZod({
			type: "object",
			properties: {
				query: { type: "string" },
				tier: {
					type: "string",
					enum: ["working", "episodic", "semantic", "skill"],
				},
			},
			required: ["query"],
		});

		expect(
			schema.safeParse({
				query: "老孟",
				tier: "working",
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				query: "老孟",
			}).success,
		).toBe(true);
		expect(schema.safeParse({ tier: "working" }).success).toBe(false);
		expect(
			schema.safeParse({
				query: "老孟",
				tier: "short",
			}).success,
		).toBe(false);
	});

	it("converts number, integer, and boolean fields", () => {
		const schema = jsonSchemaToZod({
			type: "object",
			properties: {
				timeoutMs: { type: "number" },
				retries: { type: "integer" },
				enabled: { type: "boolean" },
			},
			required: ["timeoutMs", "retries", "enabled"],
		});

		expect(
			schema.safeParse({
				timeoutMs: 5000,
				retries: 3,
				enabled: true,
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				timeoutMs: "5000",
				retries: 3,
				enabled: true,
			}).success,
		).toBe(false);
	});

	it("converts arrays and nested objects recursively", () => {
		const schema = jsonSchemaToZod({
			type: "object",
			properties: {
				tags: {
					type: "array",
					items: { type: "string" },
				},
				options: {
					type: "object",
					properties: {
						verbose: { type: "boolean" },
						limit: { type: "number" },
					},
					required: ["verbose"],
				},
			},
			required: ["tags", "options"],
		});

		expect(
			schema.safeParse({
				tags: ["a", "b"],
				options: {
					verbose: true,
					limit: 10,
				},
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				tags: ["a", 1],
				options: {
					verbose: true,
				},
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				tags: ["a"],
				options: {
					limit: 10,
				},
			}).success,
		).toBe(false);
	});

	it("falls back to z.unknown for anyOf/oneOf branches", () => {
		expect(
			jsonSchemaToZod({
				anyOf: [{ type: "string" }, { type: "number" }],
			} as never),
		).toBeInstanceOf(z.ZodUnknown);
		expect(
			jsonSchemaToZod({
				oneOf: [{ type: "string" }, { type: "number" }],
			} as never),
		).toBeInstanceOf(z.ZodUnknown);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ schemaType: "anyOf" }),
			"unsupported MCP schema, falling back to unknown",
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ schemaType: "oneOf" }),
			"unsupported MCP schema, falling back to unknown",
		);
	});

	it("falls back to unknown fields instead of throwing for null and unknown types", () => {
		const schema = jsonSchemaToZod({
			type: "object",
			properties: {
				value: { type: "null" },
				extra: { type: "mystery" },
			},
			required: ["value", "extra"],
		});

		expect(
			schema.safeParse({
				value: "anything",
				extra: { nested: true },
			}).success,
		).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ schemaType: "null" }),
			"unsupported MCP schema, falling back to unknown",
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ schemaType: "mystery" }),
			"unsupported MCP schema, falling back to unknown",
		);
	});

	it("keeps object schema conversion alive when a property uses anyOf", () => {
		const schema = jsonSchemaToZod({
			type: "object",
			properties: {
				query: { type: "string" },
				filters: {
					anyOf: [
						{ type: "string" },
						{ type: "object", properties: { limit: { type: "number" } } },
					],
				},
			},
			required: ["query", "filters"],
		} as never);

		expect(
			schema.safeParse({
				query: "hello",
				filters: { limit: 10 },
			}).success,
		).toBe(true);
	});
});
