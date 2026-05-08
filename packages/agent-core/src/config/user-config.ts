// User-level runtime config loader (ADR-009).
// Distinct from capability YAML loader in ./loader.ts.
//
// Cascade: CLI args > env vars > ~/.quilin/config.toml > built-in defaults.
// API keys never live in this file; they come from provider-specific env
// vars (ANTHROPIC_API_KEY etc.). The loader rejects any TOML containing
// field names matching FORBIDDEN_FIELD_FRAGMENTS.

import { promises as fs, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	FORBIDDEN_FIELD_FRAGMENTS,
	type UserConfig,
	userConfigSchema,
} from "./user-config-schema.js";

const ENV_PREFIX = "OMNI_";
const DEFAULT_CONFIG_PATH = path.join(homedir(), ".quilin", "config.toml");

export type ConfigSource = "cli" | "env" | "file" | "default";

export interface UserConfigLoadResult {
	readonly config: UserConfig;
	readonly sources: Readonly<Record<string, ConfigSource>>;
	readonly filePath: string | null;
}

export interface UserConfigLoadOptions {
	readonly configPath?: string;
	readonly cliOverrides?: Readonly<Record<string, unknown>>;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly enforceFileMode?: boolean;
}

export class UserConfigError extends Error {
	constructor(
		message: string,
		readonly code:
			| "FILE_PERMISSION"
			| "FORBIDDEN_FIELD"
			| "TOML_PARSE"
			| "SCHEMA_VALIDATION"
			| "ENV_TYPE",
	) {
		super(message);
		this.name = "UserConfigError";
	}
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function setDeep(
	target: PlainObject,
	pathKeys: readonly string[],
	value: unknown,
): void {
	let cursor: PlainObject = target;
	for (let index = 0; index < pathKeys.length - 1; index += 1) {
		const key = pathKeys[index];
		const existing = cursor[key];
		if (!isPlainObject(existing)) {
			cursor[key] = {};
		}
		cursor = cursor[key] as PlainObject;
	}
	cursor[pathKeys[pathKeys.length - 1]] = value;
}

function flattenLeafKeys(
	value: unknown,
	prefix: readonly string[] = [],
): readonly (readonly string[])[] {
	if (!isPlainObject(value)) {
		return [prefix];
	}
	const result: (readonly string[])[] = [];
	for (const key of Object.keys(value)) {
		result.push(...flattenLeafKeys(value[key], [...prefix, key]));
	}
	return result;
}

function isForbiddenFieldKey(key: string): { fragment: string } | null {
	const lower = key.toLowerCase();
	for (const fragment of FORBIDDEN_FIELD_FRAGMENTS) {
		// fragment is "_api_key" / "_token" / "_secret".
		// Match if the key equals fragment without the leading underscore
		// (e.g. exactly "token") or ends with the fragment as a separate
		// word (e.g. "access_token", "anthropic_api_key").
		// Avoid substring matches that would catch "max_tokens" / "tokens".
		const bareFragment = fragment.replace(/^_/, "");
		if (lower === bareFragment) {
			return { fragment };
		}
		if (lower.endsWith(fragment)) {
			return { fragment };
		}
	}
	return null;
}

function assertNoForbiddenFields(parsed: unknown): void {
	const leaves = flattenLeafKeys(parsed);
	for (const leaf of leaves) {
		for (const key of leaf) {
			const match = isForbiddenFieldKey(key);
			if (match != null) {
				throw new UserConfigError(
					`forbidden field name "${leaf.join(
						".",
					)}" matches fragment "${match.fragment}"; API keys must come from env vars only`,
					"FORBIDDEN_FIELD",
				);
			}
		}
	}
}

function shallowMerge(base: PlainObject, override: PlainObject): PlainObject {
	const result: PlainObject = { ...base };
	for (const key of Object.keys(override)) {
		const overrideValue = override[key];
		const baseValue = result[key];
		if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
			result[key] = shallowMerge(baseValue, overrideValue);
		} else {
			result[key] = overrideValue;
		}
	}
	return result;
}

async function readConfigFile(
	filePath: string,
	enforceFileMode: boolean,
): Promise<{ parsed: PlainObject; raw: string } | null> {
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return null;
		}
		throw error;
	}

	if (enforceFileMode && process.platform !== "win32") {
		const mode = stat.mode & 0o777;
		if (mode > 0o600) {
			throw new UserConfigError(
				`refusing to read ${filePath}: permission ${mode.toString(8)} > 0600 (chmod 0600 ${filePath})`,
				"FILE_PERMISSION",
			);
		}
	}

	const raw = await fs.readFile(filePath, "utf8");
	let parsed: unknown;
	try {
		parsed = parseToml(raw);
	} catch (error) {
		throw new UserConfigError(
			`failed to parse ${filePath} as TOML 1.0: ${(error as Error).message}`,
			"TOML_PARSE",
		);
	}
	if (!isPlainObject(parsed)) {
		throw new UserConfigError(
			`${filePath} root must be a TOML table`,
			"TOML_PARSE",
		);
	}
	assertNoForbiddenFields(parsed);
	return { parsed, raw };
}

interface SchemaTreeNode {
	readonly children: ReadonlyMap<string, SchemaTreeNode>;
	readonly leafType?:
		| "string"
		| "number"
		| "boolean"
		| "string_array"
		| "object";
}

function buildSchemaTree(): SchemaTreeNode {
	// We hard-code the env-mappable shape rather than reflecting the zod
	// schema at runtime (zod 4's internal shape is implementation detail
	// and brittle to introspect). New top-level namespaces must be added
	// here in lockstep with user-config-schema.ts.
	const mapping: Record<
		string,
		"string" | "number" | "boolean" | "string_array"
	> = {
		"llm.default_model": "string",
		"llm.fallback_model": "string",
		"llm.temperature": "number",
		"llm.max_tokens": "number",
		"llm.thinking.enabled": "boolean",
		"llm.thinking.budget_tokens": "number",
		"llm.routing.mode": "string",
		"llm.routing.default_tier": "string",
		"llm.routing.allow_escalation": "boolean",
		"llm.tiers.flash.provider": "string",
		"llm.tiers.flash.model": "string",
		"llm.tiers.flash.thinking": "string",
		"llm.tiers.flash.temperature": "number",
		"llm.tiers.flash.max_tokens": "number",
		"llm.tiers.flash.thinking_budget_tokens": "number",
		"llm.tiers.flash.top_p": "number",
		"llm.tiers.lite.provider": "string",
		"llm.tiers.lite.model": "string",
		"llm.tiers.lite.thinking": "string",
		"llm.tiers.lite.temperature": "number",
		"llm.tiers.lite.max_tokens": "number",
		"llm.tiers.lite.thinking_budget_tokens": "number",
		"llm.tiers.lite.top_p": "number",
		"llm.tiers.pro.provider": "string",
		"llm.tiers.pro.model": "string",
		"llm.tiers.pro.thinking": "string",
		"llm.tiers.pro.temperature": "number",
		"llm.tiers.pro.max_tokens": "number",
		"llm.tiers.pro.thinking_budget_tokens": "number",
		"llm.tiers.pro.top_p": "number",
		"memory.scratchpad.ttl_sec": "number",
		"memory.scratchpad.capacity_per_task": "number",
		"observability.log_level": "string",
		"observability.tracing.enabled": "boolean",
		"observability.tracing.endpoint": "string",
		"observability.metrics.enabled": "boolean",
		"observability.metrics.port": "number",
		"session.storage": "string",
		"session.db_path": "string",
		"session.max_history_tokens": "number",
		"session.auto_save_interval": "number",
		"tools.enabled": "string_array",
		"tools.disabled": "string_array",
		"idle_evolution.enabled": "boolean",
		"idle_evolution.mode": "string",
		"idle_evolution.daily_budget_tokens": "number",
		"idle_evolution.allowed_hours": "string",
		"idle_evolution.min_idle_minutes": "number",
		"safety.trust_mode": "string",
		"context.budget.total": "number",
		"context.budget.system": "number",
		"context.budget.memory": "number",
		"context.budget.tools": "number",
		"context.budget.conversation": "number",
		"context.budget.reserved": "number",
	};

	const root: {
		children: Map<string, SchemaTreeNode>;
		leafType?: SchemaTreeNode["leafType"];
	} = {
		children: new Map(),
	};
	for (const [dotPath, leafType] of Object.entries(mapping)) {
		const segments = dotPath.split(".");
		let cursor = root;
		for (let index = 0; index < segments.length; index += 1) {
			const key = segments[index];
			const isLeaf = index === segments.length - 1;
			let next = cursor.children.get(key) as
				| {
						children: Map<string, SchemaTreeNode>;
						leafType?: SchemaTreeNode["leafType"];
				  }
				| undefined;
			if (next == null) {
				next = { children: new Map() };
				cursor.children.set(key, next as SchemaTreeNode);
			}
			if (isLeaf) {
				next.leafType = leafType;
			}
			cursor = next;
		}
	}
	return root as SchemaTreeNode;
}

const SCHEMA_TREE = buildSchemaTree();

function envKeyToDotPath(envKey: string): readonly string[] | null {
	if (!envKey.startsWith(ENV_PREFIX)) {
		return null;
	}
	const stripped = envKey.slice(ENV_PREFIX.length).toLowerCase();
	if (stripped.length === 0) {
		return null;
	}
	const tokens = stripped.split("_");
	const result: string[] = [];
	let cursor: SchemaTreeNode = SCHEMA_TREE;
	let index = 0;
	while (index < tokens.length) {
		// Greedily match the longest known prefix so OMNI_LLM_DEFAULT_MODEL
		// resolves to llm.default_model rather than llm.default.model.
		let matched = false;
		for (let take = tokens.length - index; take >= 1; take -= 1) {
			const candidate = tokens.slice(index, index + take).join("_");
			const next = cursor.children.get(candidate);
			if (next != null) {
				result.push(candidate);
				cursor = next;
				index += take;
				matched = true;
				break;
			}
		}
		if (!matched) {
			return null;
		}
	}
	return result;
}

function coerceEnvValue(
	rawValue: string,
	leafType: SchemaTreeNode["leafType"] | undefined,
	envKey: string,
): unknown {
	switch (leafType) {
		case "boolean": {
			const normalized = rawValue.trim().toLowerCase();
			if (["true", "yes", "on", "1"].includes(normalized)) return true;
			if (["false", "no", "off", "0"].includes(normalized)) return false;
			throw new UserConfigError(
				`${envKey}=${rawValue} cannot be coerced to boolean`,
				"ENV_TYPE",
			);
		}
		case "number": {
			const parsed = Number(rawValue);
			if (!Number.isFinite(parsed)) {
				throw new UserConfigError(
					`${envKey}=${rawValue} cannot be coerced to number`,
					"ENV_TYPE",
				);
			}
			return parsed;
		}
		case "string_array": {
			return rawValue
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0);
		}
		default: {
			return rawValue;
		}
	}
}

function envOverrides(env: Readonly<Record<string, string | undefined>>): {
	tree: PlainObject;
	touched: readonly string[];
} {
	const tree: PlainObject = {};
	const touched: string[] = [];
	for (const [envKey, rawValue] of Object.entries(env)) {
		if (rawValue == null) continue;
		const dotPath = envKeyToDotPath(envKey);
		if (dotPath == null) continue;
		// Walk the schema tree to find the leaf type for coercion.
		let cursor: SchemaTreeNode = SCHEMA_TREE;
		for (const segment of dotPath) {
			const next = cursor.children.get(segment);
			if (next == null) {
				cursor = { children: new Map() };
				break;
			}
			cursor = next;
		}
		const leafType = cursor.leafType;
		const coerced = coerceEnvValue(rawValue, leafType, envKey);
		setDeep(tree, dotPath, coerced);
		touched.push(dotPath.join("."));
	}
	return { tree, touched };
}

function trackSources(
	tree: unknown,
	source: ConfigSource,
	prefix: readonly string[],
	out: Record<string, ConfigSource>,
): void {
	if (!isPlainObject(tree)) {
		out[prefix.join(".")] = source;
		return;
	}
	for (const key of Object.keys(tree)) {
		trackSources(tree[key], source, [...prefix, key], out);
	}
}

export async function loadUserConfig(
	options: UserConfigLoadOptions = {},
): Promise<UserConfigLoadResult> {
	const env = options.env ?? process.env;
	const enforceFileMode = options.enforceFileMode ?? true;
	const filePath = options.configPath ?? DEFAULT_CONFIG_PATH;
	const cliOverrides = options.cliOverrides ?? {};

	// Track each leaf key's winning source. Order: defaults < file < env < CLI.
	const sources: Record<string, ConfigSource> = {};

	// Layer 1: file (TOML)
	let merged: PlainObject = {};
	const fileResult = await readConfigFile(filePath, enforceFileMode);
	if (fileResult != null) {
		trackSources(fileResult.parsed, "file", [], sources);
		merged = shallowMerge(merged, fileResult.parsed);
	}

	// Layer 2: env
	const { tree: envTree, touched: envTouched } = envOverrides(env);
	for (const key of envTouched) {
		sources[key] = "env";
	}
	merged = shallowMerge(merged, envTree);

	// Layer 3: CLI
	if (Object.keys(cliOverrides).length > 0) {
		trackSources(cliOverrides, "cli", [], sources);
		merged = shallowMerge(merged, cliOverrides as PlainObject);
	}

	// Layer 4: defaults are applied by zod when fields are missing.
	const result = userConfigSchema.safeParse(merged);
	if (!result.success) {
		throw new UserConfigError(
			`user config schema validation failed: ${result.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")}`,
			"SCHEMA_VALIDATION",
		);
	}

	// Mark every untouched leaf as "default".
	for (const leaf of flattenLeafKeys(result.data)) {
		const key = leaf.join(".");
		if (!(key in sources)) {
			sources[key] = "default";
		}
	}

	return {
		config: result.data,
		sources,
		filePath: fileResult != null ? filePath : null,
	};
}

// Synchronous variant used by index.ts boot path; throws on permission issues.
export function loadUserConfigSync(
	options: UserConfigLoadOptions = {},
): UserConfigLoadResult {
	// Inline the async logic for the boot path; we do not need fs.promises here.
	const env = options.env ?? process.env;
	const enforceFileMode = options.enforceFileMode ?? true;
	const filePath = options.configPath ?? DEFAULT_CONFIG_PATH;
	const cliOverrides = options.cliOverrides ?? {};
	const sources: Record<string, ConfigSource> = {};

	let merged: PlainObject = {};
	let fileExisted = false;
	try {
		const stat = statSync(filePath);
		fileExisted = true;
		if (enforceFileMode && process.platform !== "win32") {
			const mode = stat.mode & 0o777;
			if (mode > 0o600) {
				throw new UserConfigError(
					`refusing to read ${filePath}: permission ${mode.toString(8)} > 0600`,
					"FILE_PERMISSION",
				);
			}
		}
		const raw = readFileSync(filePath, "utf8");
		const parsed = parseToml(raw);
		if (!isPlainObject(parsed)) {
			throw new UserConfigError(
				`${filePath} root must be a TOML table`,
				"TOML_PARSE",
			);
		}
		assertNoForbiddenFields(parsed);
		trackSources(parsed, "file", [], sources);
		merged = shallowMerge(merged, parsed);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw error;
	}

	const { tree: envTree, touched: envTouched } = envOverrides(env);
	for (const key of envTouched) {
		sources[key] = "env";
	}
	merged = shallowMerge(merged, envTree);

	if (Object.keys(cliOverrides).length > 0) {
		trackSources(cliOverrides, "cli", [], sources);
		merged = shallowMerge(merged, cliOverrides as PlainObject);
	}

	const result = userConfigSchema.safeParse(merged);
	if (!result.success) {
		throw new UserConfigError(
			`user config schema validation failed: ${result.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")}`,
			"SCHEMA_VALIDATION",
		);
	}

	for (const leaf of flattenLeafKeys(result.data)) {
		const key = leaf.join(".");
		if (!(key in sources)) {
			sources[key] = "default";
		}
	}

	return {
		config: result.data,
		sources,
		filePath: fileExisted ? filePath : null,
	};
}

export const __testing = {
	envKeyToDotPath,
	coerceEnvValue,
	shallowMerge,
	flattenLeafKeys,
	assertNoForbiddenFields,
};
