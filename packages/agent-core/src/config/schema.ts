import { z } from "zod";

const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const nonEmptyStringSchema = z.string().trim().min(1);
const stringArraySchema = z.array(nonEmptyStringSchema).readonly();
const capabilitiesSchemaVersionSchema = z.union([z.literal(1), z.literal(2)]);

const retryPolicySchema = z
	.object({
		maxAttempts: z.number().int().nonnegative().optional(),
		retryableExitCodes: z.array(z.number().int()).readonly().optional(),
	})
	.strict();

const backoffSchema = z
	.object({
		initialDelayMs: z.number().int().nonnegative().optional(),
		maxDelayMs: z.number().int().nonnegative().optional(),
		multiplier: z.number().positive().optional(),
	})
	.strict();

export const mcpServerConfigSchema = z
	.object({
		command: nonEmptyStringSchema,
		args: stringArraySchema,
		cwd: nonEmptyStringSchema.optional(),
		namespace: nonEmptyStringSchema.regex(MCP_SERVER_ID_PATTERN).optional(),
		defaultRiskLevel: z.enum(["read", "write", "exec", "high-risk"]).optional(),
		enabled: z.boolean().optional(),
		env: z.record(z.string(), z.string()).readonly().optional(),
		timeoutMs: z.number().int().nonnegative().optional(),
		connectTimeoutMs: z.number().int().nonnegative().optional(),
		retryPolicy: retryPolicySchema.optional(),
		backoff: backoffSchema.optional(),
	})
	.strict();

export const skillsConfigSchema = z
	.object({
		enabled: z.boolean().optional(),
		bundledRoots: stringArraySchema.optional(),
		userRoots: stringArraySchema.optional(),
		projectRoots: stringArraySchema.optional(),
		pluginRoots: stringArraySchema.optional(),
		watcherEnabled: z.boolean().optional(),
		debounceMs: z.number().int().nonnegative().optional(),
		reloadStrategy: z.enum(["manual", "watch"]).optional(),
	})
	.strict();

const safetyConfigSchema = z.object({}).strict();

export const capabilitiesConfigSchema = z
	.object({
		schema_version: capabilitiesSchemaVersionSchema,
		mcpServers: z.record(
			z.string().regex(MCP_SERVER_ID_PATTERN),
			mcpServerConfigSchema,
		),
		skills: skillsConfigSchema,
		safety: safetyConfigSchema.optional(),
	})
	.strict();
