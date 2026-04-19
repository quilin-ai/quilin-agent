import { z } from "zod";
import { logger } from "../logger.js";

type JsonSchemaPrimitiveType =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "array"
	| "object";

interface JsonSchemaBase {
	readonly $id?: string;
	readonly type?: JsonSchemaPrimitiveType | string;
	readonly enum?: readonly unknown[];
	readonly anyOf?: readonly JsonSchema[];
	readonly oneOf?: readonly JsonSchema[];
}

export interface JsonSchemaObject extends JsonSchemaBase {
	readonly type: "object";
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
}

export interface JsonSchemaArray extends JsonSchemaBase {
	readonly type: "array";
	readonly items?: JsonSchema;
}

export type JsonSchema = JsonSchemaObject | JsonSchemaArray | JsonSchemaBase;

function fallbackToUnknown(schema: JsonSchema, schemaType: string): z.ZodUnknown {
	logger.warn(
		{
			schemaType,
			schemaId: schema.$id,
		},
		"unsupported MCP schema, falling back to unknown",
	);
	return z.unknown();
}

function toRequiredShape(
	properties: Readonly<Record<string, JsonSchema>>,
	required: ReadonlySet<string>,
): Record<string, z.ZodTypeAny> {
	return Object.fromEntries(
		Object.entries(properties).map(([name, propertySchema]) => {
			const zodSchema = jsonSchemaToZod(propertySchema);
			return [name, required.has(name) ? zodSchema : zodSchema.optional()];
		}),
	);
}

export function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
	if (schema.anyOf != null) {
		return fallbackToUnknown(schema, "anyOf");
	}

	if (schema.oneOf != null) {
		return fallbackToUnknown(schema, "oneOf");
	}

	switch (schema.type) {
		case "string":
			if (
				Array.isArray(schema.enum) &&
				schema.enum.length > 0 &&
				schema.enum.every((value) => typeof value === "string")
			) {
				return z.enum([
					schema.enum[0],
					...schema.enum.slice(1),
				] as [string, ...string[]]);
			}
			return z.string();
		case "number":
		case "integer":
			return z.number();
		case "boolean":
			return z.boolean();
		case "array":
			if (schema.items == null) {
				throw new Error("Unsupported MCP schema type for array: missing items");
			}
			return z.array(jsonSchemaToZod(schema.items));
		case "object": {
			const required = new Set(schema.required ?? []);
			return z.object(toRequiredShape(schema.properties ?? {}, required));
		}
		default:
			return fallbackToUnknown(schema, schema.type ?? "unknown");
	}
}
