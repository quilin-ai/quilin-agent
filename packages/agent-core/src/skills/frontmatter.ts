import type { SkillFrontmatter, SkillTrustLevel } from "./types.js";

interface ParsedSkillMarkdown {
	readonly frontmatter: SkillFrontmatter;
	readonly body: string;
}

type SkillFrontmatterInput = Record<string, unknown>;
type NestedObject = Record<string, unknown>;

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const KEBAB_CASE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRUST_VALUES = new Set<SkillTrustLevel>([
	"builtin",
	"trusted",
	"community",
	"agent-created",
]);

function parseScalar(rawValue: string): unknown {
	const trimmed = rawValue.trim();
	if (trimmed === "true") {
		return true;
	}

	if (trimmed === "false") {
		return false;
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1).trim();
		if (inner === "") {
			return [];
		}

		return inner
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0)
			.map((item) => item.replace(/^['"]|['"]$/g, ""));
	}

	return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseYamlLike(yamlText: string): SkillFrontmatterInput {
	const parsed: SkillFrontmatterInput = {};
	const lines = yamlText.split(/\r?\n/);
	const stack: Array<{ indent: number; value: NestedObject }> = [
		{ indent: -1, value: parsed },
	];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue;
		}

		const separatorIndex = line.indexOf(":");
		if (separatorIndex <= 0) {
			continue;
		}

		const indent = line.length - line.trimStart().length;
		const key = line.slice(0, separatorIndex).trim();
		const rawValue = line.slice(separatorIndex + 1);

		while (stack.length > 1 && indent <= stack[stack.length - 1]?.indent) {
			stack.pop();
		}

		const parent = stack[stack.length - 1]?.value;
		if (parent == null) {
			throw new Error("Skill frontmatter nesting is malformed");
		}

		if (rawValue.trim() === "") {
			const nested: NestedObject = {};
			parent[key] = nested;
			stack.push({ indent, value: nested });
			continue;
		}

		parent[key] = parseScalar(rawValue);
	}

	return parsed;
}

function normalizeString(
	value: unknown,
	fieldName: string,
	required: boolean,
): string | undefined {
	if (value == null) {
		if (required) {
			throw new Error(`Skill frontmatter requires ${fieldName}`);
		}

		return undefined;
	}

	if (typeof value !== "string") {
		throw new Error(`Skill frontmatter field ${fieldName} must be a string`);
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		if (required) {
			throw new Error(`Skill frontmatter requires ${fieldName}`);
		}

		return undefined;
	}

	return trimmed;
}

function normalizeStringArray(
	value: unknown,
	fieldName: string,
): readonly string[] | undefined {
	if (value == null) {
		return undefined;
	}

	if (!Array.isArray(value)) {
		throw new Error(`Skill frontmatter field ${fieldName} must be an array`);
	}

	return value.map((entry) => {
		if (typeof entry !== "string") {
			throw new Error(
				`Skill frontmatter field ${fieldName} must contain strings`,
			);
		}

		return entry.trim();
	});
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (value == null) {
		return fallback;
	}

	if (typeof value !== "boolean") {
		throw new Error("Skill frontmatter boolean field has invalid value");
	}

	return value;
}

function normalizeTrust(value: unknown): SkillTrustLevel {
	if (
		typeof value !== "string" ||
		!TRUST_VALUES.has(value as SkillTrustLevel)
	) {
		throw new Error("Skill frontmatter trust must be a valid trust level");
	}

	return value as SkillTrustLevel;
}

function getNestedRecord(
	value: unknown,
	fieldName: string,
): NestedObject | undefined {
	if (value == null) {
		return undefined;
	}

	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Skill frontmatter field ${fieldName} must be an object`);
	}

	return value as NestedObject;
}

function firstDefined(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined);
}

export function parseSkillFrontmatter(
	input: SkillFrontmatterInput,
): SkillFrontmatter {
	const name = normalizeString(input.name, "name", true);
	const description = normalizeString(input.description, "description", true);
	const metadata = getNestedRecord(input.metadata, "metadata");
	const quilinMetadata = getNestedRecord(metadata?.quilin, "metadata.quilin");

	if (name == null || description == null) {
		throw new Error("Skill frontmatter is missing required fields");
	}

	if (name.length > MAX_NAME_LENGTH) {
		throw new Error(`Skill name exceeds ${MAX_NAME_LENGTH} characters`);
	}

	if (!KEBAB_CASE_NAME.test(name)) {
		throw new Error("Skill name must be kebab-case");
	}

	if (description.length > MAX_DESCRIPTION_LENGTH) {
		throw new Error(
			`Skill description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
		);
	}

	const allowedTools = normalizeStringArray(
		input.allowedTools ?? input["allowed-tools"],
		"allowedTools",
	);
	const requiresTools = normalizeStringArray(
		firstDefined(
			input.requiresTools,
			input.requires_tools,
			quilinMetadata?.requiresTools,
			quilinMetadata?.requires_tools,
		),
		"requiresTools",
	);
	const requiresToolsets = normalizeStringArray(
		firstDefined(
			input.requiresToolsets,
			input.requires_toolsets,
			quilinMetadata?.requiresToolsets,
			quilinMetadata?.requires_toolsets,
		),
		"requiresToolsets",
	);
	const platforms = normalizeStringArray(
		firstDefined(input.platforms, quilinMetadata?.platforms),
		"platforms",
	);
	const trustValue = firstDefined(input.trust, quilinMetadata?.trust);

	return {
		name,
		description,
		whenToUse: normalizeString(
			firstDefined(input.whenToUse, input["when-to-use"]),
			"whenToUse",
			false,
		),
		allowedTools,
		requiresTools,
		requiresToolsets,
		platforms,
		version: normalizeString(input.version, "version", false),
		userInvocable: normalizeBoolean(input.userInvocable, true),
		disableModelInvocation: normalizeBoolean(
			input.disableModelInvocation,
			false,
		),
		trust: trustValue == null ? undefined : normalizeTrust(trustValue),
	};
}

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
	if (!markdown.startsWith("---")) {
		throw new Error("SKILL.md must start with YAML frontmatter");
	}

	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (match == null) {
		throw new Error("SKILL.md frontmatter block is malformed");
	}

	const [, yamlText, body] = match;
	const rawFrontmatter = parseYamlLike(yamlText);
	const frontmatter = parseSkillFrontmatter(rawFrontmatter);

	return {
		frontmatter,
		body,
	};
}
