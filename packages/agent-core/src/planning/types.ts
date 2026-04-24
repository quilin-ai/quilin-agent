import { z } from "zod";
import type { ToolCall } from "../tools/types.js";

export type Intent =
	| "SIMPLE_QA"
	| "SINGLE_TOOL"
	| "MULTI_STEP"
	| "CLARIFICATION";

export interface IntentClassification {
	readonly intent: Intent;
	readonly confidence: number;
	readonly source: "structural" | "audit";
	readonly latencyMs: number;
	readonly reasoningDigest?: string;
}

export type MemoryWriteScope =
	| "none"
	| "working"
	| "episodic"
	| "semantic"
	| "skill";

export type RiskLevel = "low" | "medium" | "high";

export interface SubTask {
	readonly id: string;
	readonly action: string;
	readonly name: string;
	readonly description: string;
	readonly estimatedTokens: number;
	readonly estimatedSteps: number;
	readonly preconditions: ReadonlyArray<string>;
	readonly effects: ReadonlyArray<string>;
	readonly skillHint?: string;
	readonly arguments?: Readonly<Record<string, unknown>>;
	readonly depth?: number;
	readonly writeScope?: MemoryWriteScope;
	readonly risk?: RiskLevel;
}

export interface LinearPlan {
	readonly kind: "linear";
	readonly subtasks: ReadonlyArray<SubTask>;
}

export interface DagPlan {
	readonly kind: "dag";
	readonly subtasks: ReadonlyArray<SubTask>;
	readonly edges: ReadonlyArray<readonly [string, string]>;
}

export type Plan = LinearPlan | DagPlan;

export interface ClarificationRequest {
	readonly question: string;
	readonly missing: ReadonlyArray<string>;
}

export interface PlannerAudit {
	readonly intentHint: Intent;
	readonly confidence: number;
	readonly reasoningDigest?: string;
}

export interface LLMPlannerResponse {
	readonly text?: string;
	readonly toolCalls?: ReadonlyArray<ToolCall>;
	readonly planSketch?: LinearPlan | DagPlan;
	readonly needClarification?: ClarificationRequest;
	readonly audit?: PlannerAudit;
}

export interface IntentClassifier {
	dispatch(response: LLMPlannerResponse): IntentClassification;
}

const nonEmptyStringSchema = z.string().trim().min(1);
const unknownRecordSchema = z.record(z.string(), z.unknown());

export const memoryWriteScopeSchema = z.enum([
	"none",
	"working",
	"episodic",
	"semantic",
	"skill",
]);

export const riskLevelSchema = z.enum(["low", "medium", "high"]);

export const toolCallSchema = z
	.object({
		id: nonEmptyStringSchema,
		name: nonEmptyStringSchema,
		arguments: unknownRecordSchema,
	})
	.strict();

export const subTaskSchema = z
	.object({
		id: nonEmptyStringSchema,
		action: nonEmptyStringSchema,
		name: nonEmptyStringSchema,
		description: nonEmptyStringSchema,
		estimatedTokens: z.number().finite(),
		estimatedSteps: z.number().int().nonnegative(),
		preconditions: z.array(nonEmptyStringSchema).readonly(),
		effects: z.array(nonEmptyStringSchema).readonly(),
		skillHint: nonEmptyStringSchema.optional(),
		arguments: unknownRecordSchema.readonly().optional(),
		depth: z.number().int().nonnegative().optional(),
		writeScope: memoryWriteScopeSchema.optional(),
		risk: riskLevelSchema.optional(),
	})
	.strict();

export const linearPlanSchema = z
	.object({
		kind: z.literal("linear"),
		subtasks: z.array(subTaskSchema).readonly(),
	})
	.strict();

export const dagPlanSchema = z
	.object({
		kind: z.literal("dag"),
		subtasks: z.array(subTaskSchema).readonly(),
		edges: z
			.array(z.tuple([nonEmptyStringSchema, nonEmptyStringSchema]).readonly())
			.readonly(),
	})
	.strict();

export const planSchema = z.discriminatedUnion("kind", [
	linearPlanSchema,
	dagPlanSchema,
]);

export const clarificationRequestSchema = z
	.object({
		question: nonEmptyStringSchema,
		missing: z.array(nonEmptyStringSchema).readonly(),
	})
	.strict();

export const plannerAuditSchema = z
	.object({
		intentHint: z.enum([
			"SIMPLE_QA",
			"SINGLE_TOOL",
			"MULTI_STEP",
			"CLARIFICATION",
		]),
		confidence: z.number().min(0).max(1),
		reasoningDigest: nonEmptyStringSchema.optional(),
	})
	.strict();

export const llmPlannerResponseSchema = z
	.object({
		text: z.string().optional(),
		toolCalls: z.array(toolCallSchema).readonly().optional(),
		planSketch: planSchema.optional(),
		needClarification: clarificationRequestSchema.optional(),
		audit: plannerAuditSchema.optional(),
	})
	.strict();

function formatIssuePath(path: readonly PropertyKey[]): string {
	if (path.length === 0) {
		return "<root>";
	}

	let result = "";
	for (const segment of path) {
		if (typeof segment === "number") {
			result += `[${segment}]`;
			continue;
		}

		const key = String(segment);
		result += result.length === 0 ? key : `.${key}`;
	}

	return result;
}

function formatSchemaError(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
		.join("; ");
}

export function parseLLMPlannerResponse(input: unknown): LLMPlannerResponse {
	const parsed = llmPlannerResponseSchema.safeParse(input);
	if (!parsed.success) {
		throw new Error(
			`Invalid planner response from model: ${formatSchemaError(parsed.error)}`,
		);
	}
	return parsed.data as LLMPlannerResponse;
}
