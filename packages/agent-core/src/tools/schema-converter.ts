import { z } from "zod";

type JsonSchemaPrimitiveType =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "array"
	| "object";

interface JsonSchemaBase {
	readonly type?: JsonSchemaPrimitiveType | string;
	readonly enum?: readonly unknown[];
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
			throw new Error(
				`Unsupported MCP schema type: ${schema.type ?? "unknown"}`,
			);
	}
}
