import { parse as parseYaml, YAMLParseError } from "yaml";
import type {
	SkillDependencyMetadata,
	SkillFrontmatter,
	SkillTrustLevel,
} from "./types.js";

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

function isPlainObject(value: unknown): value is NestedObject {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function parseFrontmatterYaml(yamlText: string): SkillFrontmatterInput {
	let parsed: unknown;
	try {
		parsed = parseYaml(yamlText, {
			// Preserve scalar types (booleans, numbers) but keep them YAML 1.2
			// compatible — block scalars (|, >) are supported by default.
			strict: false,
		});
	} catch (error) {
		if (error instanceof YAMLParseError) {
			throw new Error(`Skill frontmatter is malformed: ${error.message}`);
		}
		throw error;
	}

	if (parsed == null) {
		return {};
	}

	if (!isPlainObject(parsed)) {
		throw new Error(
			"Skill frontmatter must be a YAML mapping at the top level",
		);
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

function normalizeDependencies(
	value: unknown,
): SkillDependencyMetadata | undefined {
	const dependencies = getNestedRecord(value, "dependencies");
	if (dependencies == null) {
		return undefined;
	}

	const normalized: SkillDependencyMetadata = {
		skills: normalizeStringArray(dependencies.skills, "dependencies.skills"),
		tools: normalizeStringArray(dependencies.tools, "dependencies.tools"),
		toolsets: normalizeStringArray(
			firstDefined(dependencies.toolsets, dependencies.tool_sets),
			"dependencies.toolsets",
		),
		packages: normalizeStringArray(
			dependencies.packages,
			"dependencies.packages",
		),
	};

	if (
		normalized.skills == null &&
		normalized.tools == null &&
		normalized.toolsets == null &&
		normalized.packages == null
	) {
		return undefined;
	}

	return normalized;
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
	const dependencies = normalizeDependencies(
		firstDefined(input.dependencies, quilinMetadata?.dependencies),
	);

	return {
		name,
		description,
		whenToUse: normalizeString(
			firstDefined(input.whenToUse, input["when-to-use"]),
			"whenToUse",
			false,
		),
		allowedTools,
		mandatory: normalizeBoolean(
			firstDefined(input.mandatory, quilinMetadata?.mandatory),
			false,
		),
		requiresTools,
		requiresToolsets,
		platforms,
		version: normalizeString(input.version, "version", false),
		dependencies,
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
	const rawFrontmatter = parseFrontmatterYaml(yamlText);
	const frontmatter = parseSkillFrontmatter(rawFrontmatter);

	return {
		frontmatter,
		body,
	};
}
