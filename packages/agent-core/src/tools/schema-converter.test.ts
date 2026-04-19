import { describe, expect, it } from "vitest";
import { jsonSchemaToZod } from "./schema-converter.js";

describe("jsonSchemaToZod", () => {
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

	it("throws for unsupported schema types", () => {
		expect(() =>
			jsonSchemaToZod({
				type: "object",
				properties: {
					value: { type: "null" },
				},
			}),
		).toThrow(/Unsupported MCP schema type/);
	});
});
