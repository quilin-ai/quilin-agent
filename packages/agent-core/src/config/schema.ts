import { z } from "zod";
import { CAPABILITIES_SCHEMA_VERSION } from "./types.js";

const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const nonEmptyStringSchema = z.string().trim().min(1);
const stringArraySchema = z.array(nonEmptyStringSchema).readonly();

export const mcpServerConfigSchema = z
	.object({
		command: nonEmptyStringSchema,
		args: stringArraySchema,
		cwd: nonEmptyStringSchema.optional(),
		namespace: nonEmptyStringSchema.regex(MCP_SERVER_ID_PATTERN).optional(),
		defaultRiskLevel: z.enum(["read", "write", "exec", "high-risk"]).optional(),
		enabled: z.boolean().optional(),
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
	})
	.strict();

export const capabilitiesConfigSchema = z
	.object({
		schema_version: z.literal(CAPABILITIES_SCHEMA_VERSION),
		mcpServers: z.record(
			z.string().regex(MCP_SERVER_ID_PATTERN),
			mcpServerConfigSchema,
		),
		skills: skillsConfigSchema,
	})
	.strict();
