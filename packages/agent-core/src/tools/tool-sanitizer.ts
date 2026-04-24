import { logger } from "../logger.js";

export const MCP_TOOL_METADATA_MAX_LENGTH = 512;
export const MCP_TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

const FORBIDDEN_TOOL_DESCRIPTION_PATTERN =
	/(<\s*\/?\s*(?:system|prompt)\b|###|system\s*:)/iu;

function stripControlCharacters(value: string): string {
	let normalized = "";
	for (const char of value) {
		const codePoint = char.codePointAt(0);
		if (
			codePoint != null &&
			((codePoint >= 0x00 && codePoint <= 0x1f) ||
				(codePoint >= 0x7f && codePoint <= 0x9f))
		) {
			normalized += " ";
			continue;
		}

		normalized += char;
	}

	return normalized;
}

function normalizeSanitizedToolText(value: string): string {
	return stripControlCharacters(value)
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, MCP_TOOL_METADATA_MAX_LENGTH);
}

export function sanitizeMCPToolName(
	name: string,
	options: {
		readonly field?: string;
	} = {},
): string {
	const field = options.field ?? "tool.name";
	const normalized = normalizeSanitizedToolText(name);
	if (!MCP_TOOL_NAME_PATTERN.test(normalized)) {
		logger.warn({ field, value: normalized }, "Rejected unsafe MCP tool name");
		throw new Error(
			`${field} must match ${MCP_TOOL_NAME_PATTERN.source} and be at most ${MCP_TOOL_METADATA_MAX_LENGTH} chars`,
		);
	}

	return normalized;
}

export function sanitizeMCPToolDescription(
	description: string,
	options: {
		readonly toolName: string;
	},
): string {
	const { toolName } = options;
	const normalized = normalizeSanitizedToolText(description);
	if (normalized === "") {
		return "";
	}

	if (FORBIDDEN_TOOL_DESCRIPTION_PATTERN.test(normalized)) {
		logger.warn(
			{ toolName, description: normalized },
			"Rejected unsafe MCP tool description",
		);
		throw new Error(`Unsafe MCP tool description rejected for ${toolName}`);
	}

	return normalized;
}
