import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { SkillsManager } from "../skills/manager.js";
import type { MCPServerConfig as RuntimeMCPServerConfig } from "../tools/mcp-client.js";
import * as mcpClientModule from "../tools/mcp-client.js";
import type { MCPServerEntry } from "../tools/registry.js";
import { capabilitiesConfigSchema } from "./schema.js";
import {
	CAPABILITIES_SCHEMA_VERSION,
	type CapabilitiesConfig,
	type SkillsConfig,
} from "./types.js";

export interface LoadCapabilitiesConfigOptions {
	readonly workspaceRoot: string;
	readonly argv?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
}

export interface CapabilitiesConfigSource {
	readonly kind: "cli" | "env" | "project" | "builtin";
	readonly path?: string;
}

export interface LoadedCapabilitiesConfig {
	readonly config: CapabilitiesConfig;
	readonly source: CapabilitiesConfigSource;
	readonly configDir: string;
	readonly workspaceRoot: string;
}

export interface CapabilitiesRuntime {
	readonly config: CapabilitiesConfig;
	readonly source: CapabilitiesConfigSource;
	readonly mcpServers: readonly MCPServerEntry[];
	readonly skillsManager?: SkillsManager;
}

interface ConfigPathCandidate {
	readonly kind: "cli" | "env" | "project";
	readonly path: string;
}

function resolveConfigPath(path: string, cwd: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function isContainedByOrEqual(path: string, root: string): boolean {
	const resolvedPath = resolve(path);
	const resolvedRoot = resolve(root);
	return (
		resolvedPath === resolvedRoot ||
		resolvedPath.startsWith(`${resolvedRoot}${sep}`)
	);
}

function parseCliConfigPath(
	argv: readonly string[],
	cwd: string,
): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--config") {
			const nextArg = argv[index + 1];
			if (nextArg == null || nextArg.startsWith("--")) {
				throw new Error("--config requires a path");
			}

			const trimmedPath = nextArg.trim();
			if (trimmedPath === "") {
				throw new Error("--config requires a path");
			}

			return resolveConfigPath(trimmedPath, cwd);
		}

		if (arg.startsWith("--config=")) {
			const inlinePath = arg.slice("--config=".length).trim();
			if (inlinePath === "") {
				throw new Error("--config requires a path");
			}

			return resolveConfigPath(inlinePath, cwd);
		}
	}

	return undefined;
}

function resolveProjectConfigCandidate(
	workspaceRoot: string,
): ConfigPathCandidate | undefined {
	const yamlPath = join(workspaceRoot, ".quilin", "capabilities.yaml");
	if (existsSync(yamlPath)) {
		return { kind: "project", path: yamlPath };
	}

	const jsonPath = join(workspaceRoot, ".quilin", "capabilities.json");
	if (existsSync(jsonPath)) {
		return { kind: "project", path: jsonPath };
	}

	return undefined;
}

function resolveCapabilitiesCandidate(
	options: LoadCapabilitiesConfigOptions,
): ConfigPathCandidate | undefined {
	const cwd = options.cwd ?? process.cwd();
	const argv = options.argv ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	const cliPath = parseCliConfigPath(argv, cwd);
	if (cliPath != null) {
		return { kind: "cli", path: cliPath };
	}

	const envPath = env.QUILIN_CONFIG_PATH?.trim();
	if (envPath != null && envPath !== "") {
		return { kind: "env", path: resolveConfigPath(envPath, cwd) };
	}

	return resolveProjectConfigCandidate(options.workspaceRoot);
}

function parseArrayItems(rawValue: string): readonly string[] {
	const inner = rawValue.slice(1, -1).trim();
	if (inner === "") {
		return [];
	}

	const items = inner.match(/"[^"]*"|'[^']*'|[^,]+/g);
	if (items == null) {
		return [];
	}

	return items
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.map((item) => item.replace(/^['"]|['"]$/g, ""));
}

// Accepted YAML subset for capabilities config:
// - indentation-based mappings with scalar leaves
// - inline arrays of scalar values: [value, "value"]
// - booleans: true/false/yes/no/on/off
// - integers only; floats must be quoted if they are intended as strings
// This parser intentionally rejects broader YAML features until config loading can
// add a full parser dependency through package metadata review.
function parseYamlScalar(rawValue: string): unknown {
	const trimmed = rawValue.trim();
	const lower = trimmed.toLowerCase();
	if (lower === "true" || lower === "yes" || lower === "on") {
		return true;
	}

	if (lower === "false" || lower === "no" || lower === "off") {
		return false;
	}

	if (/^-?\d+$/u.test(trimmed)) {
		return Number.parseInt(trimmed, 10);
	}

	if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed)) {
		throw new Error(
			`Unsupported YAML scalar ${trimmed}: floats are not accepted; quote the value to parse it as a string`,
		);
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return parseArrayItems(trimmed);
	}

	return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseYamlLike(yamlText: string): Record<string, unknown> {
	const parsed: Record<string, unknown> = {};
	const lines = yamlText.split(/\r?\n/u);
	const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
		{ indent: -1, value: parsed },
	];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue;
		}

		const separatorIndex = line.indexOf(":");
		if (separatorIndex <= 0) {
			throw new Error(`Malformed YAML line: ${line}`);
		}

		const indent = line.length - line.trimStart().length;
		const key = line.slice(0, separatorIndex).trim();
		const rawValue = line.slice(separatorIndex + 1);

		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}

		const parent = stack[stack.length - 1]?.value;
		if (parent == null) {
			throw new Error("Capabilities YAML nesting is malformed");
		}

		if (rawValue.trim() === "") {
			const nested: Record<string, unknown> = {};
			parent[key] = nested;
			stack.push({ indent, value: nested });
			continue;
		}

		parent[key] = parseYamlScalar(rawValue);
	}

	return parsed;
}

function formatSchemaError(
	issues: readonly { path: PropertyKey[]; message: string }[],
) {
	return issues
		.map((issue) => {
			const location = issue.path.length === 0 ? "root" : issue.path.join(".");
			return `${location}: ${issue.message}`;
		})
		.join("; ");
}

function parseCapabilitiesConfigText(
	filePath: string,
	content: string,
): CapabilitiesConfig {
	const extension = extname(filePath).toLowerCase();
	let rawConfig: unknown;

	switch (extension) {
		case ".json":
			try {
				rawConfig = JSON.parse(content) as unknown;
			} catch (error) {
				const detail =
					error instanceof Error ? error.message : "JSON parse failed";
				throw new Error(
					`Capabilities config JSON is invalid at ${filePath}: ${detail}`,
				);
			}
			break;
		case ".yaml":
			try {
				rawConfig = parseYamlLike(content);
			} catch (error) {
				const detail =
					error instanceof Error ? error.message : "YAML parse failed";
				throw new Error(
					`Capabilities config YAML is invalid at ${filePath}: ${detail}`,
				);
			}
			break;
		default:
			throw new Error(
				`Unsupported capabilities config format at ${filePath}: ${extension || "<none>"}`,
			);
	}

	const parsed = capabilitiesConfigSchema.safeParse(rawConfig);
	if (!parsed.success) {
		throw new Error(
			`Capabilities config schema invalid at ${filePath}: ${formatSchemaError(parsed.error.issues)}`,
		);
	}

	return parsed.data;
}

function resolveStringArray(
	values: readonly string[] | undefined,
	baseDir: string,
): readonly string[] | undefined {
	if (values == null) {
		return undefined;
	}

	return values.map((value) => resolveConfigPath(value, baseDir));
}

function shouldInstantiateSkillsManager(skills: SkillsConfig): boolean {
	if (skills.enabled === false) {
		return false;
	}

	return (
		skills.enabled === true ||
		(skills.bundledRoots?.length ?? 0) > 0 ||
		(skills.userRoots?.length ?? 0) > 0 ||
		(skills.projectRoots?.length ?? 0) > 0 ||
		(skills.pluginRoots?.length ?? 0) > 0
	);
}

function resolveSkillsWatcherEnabled(
	skills: SkillsConfig,
): boolean | undefined {
	if (skills.watcherEnabled != null) {
		return skills.watcherEnabled;
	}

	if (skills.reloadStrategy == null) {
		return undefined;
	}

	return skills.reloadStrategy === "watch";
}

function buildSkillsManager(
	config: CapabilitiesConfig,
	baseDir: string,
): SkillsManager | undefined {
	if (!shouldInstantiateSkillsManager(config.skills)) {
		return undefined;
	}

	const watcherEnabled = resolveSkillsWatcherEnabled(config.skills);

	return new SkillsManager({
		...(watcherEnabled == null ? {} : { watcherEnabled }),
		...(config.skills.bundledRoots == null
			? {}
			: {
					bundledRoots: resolveStringArray(config.skills.bundledRoots, baseDir),
				}),
		...(config.skills.userRoots == null
			? {}
			: { userRoots: resolveStringArray(config.skills.userRoots, baseDir) }),
		...(config.skills.projectRoots == null
			? {}
			: {
					projectRoots: resolveStringArray(config.skills.projectRoots, baseDir),
				}),
		...(config.skills.pluginRoots == null
			? {}
			: {
					pluginRoots: resolveStringArray(config.skills.pluginRoots, baseDir),
				}),
		...(config.skills.debounceMs == null
			? {}
			: { debounceMs: config.skills.debounceMs }),
	});
}

function buildMcpServers(
	config: CapabilitiesConfig,
	baseDir: string,
	workspaceRoot: string,
): readonly MCPServerEntry[] {
	return Object.entries(config.mcpServers)
		.filter(([, serverConfig]) => serverConfig.enabled !== false)
		.map(([id, serverConfig]) => {
			const resolvedCwd =
				serverConfig.cwd == null
					? undefined
					: resolveConfigPath(serverConfig.cwd, baseDir);
			if (
				resolvedCwd != null &&
				!isContainedByOrEqual(resolvedCwd, workspaceRoot) &&
				!isContainedByOrEqual(resolvedCwd, baseDir)
			) {
				throw new Error(
					`MCP server ${id} cwd escapes workspace/config directory: ${serverConfig.cwd}`,
				);
			}

			const runtimeConfig: RuntimeMCPServerConfig = {
				command: serverConfig.command,
				args: [...serverConfig.args],
				...(resolvedCwd == null ? {} : { cwd: resolvedCwd }),
			};
			mcpClientModule.validateMCPServerConfig?.(runtimeConfig);

			return {
				id,
				namespace: serverConfig.namespace ?? id,
				...(serverConfig.defaultRiskLevel == null
					? {}
					: { defaultRiskLevel: serverConfig.defaultRiskLevel }),
				config: runtimeConfig,
			} satisfies MCPServerEntry;
		});
}

export function createDefaultCapabilitiesConfig(
	workspaceRoot: string,
): CapabilitiesConfig {
	const memoryProviderCwd = join(workspaceRoot, "providers", "memory");
	const webProviderCwd = join(workspaceRoot, "providers", "web");
	// Build as a mutable Record then assign to the readonly field once
	// — `CapabilitiesConfig["mcpServers"]` is `Readonly<Record<...>>` so
	// direct index-write on the typed `NonNullable<...>` slot fails tsc.
	type McpServerEntry = NonNullable<
		CapabilitiesConfig["mcpServers"]
	>[string];
	const mcpServers: Record<string, McpServerEntry> = {};
	if (existsSync(memoryProviderCwd)) {
		mcpServers["quilin-mem"] = {
			command: "uv",
			args: ["run", "python", "-m", "quilin_mem"],
			cwd: memoryProviderCwd,
		};
	}
	if (existsSync(webProviderCwd)) {
		mcpServers["quilin-web"] = {
			command: "uv",
			args: ["run", "python", "-m", "quilin_web"],
			cwd: webProviderCwd,
		};
	}
	return {
		schema_version: CAPABILITIES_SCHEMA_VERSION,
		mcpServers,
		skills: {
			enabled: false,
		},
	};
}

export async function loadCapabilitiesConfig(
	options: LoadCapabilitiesConfigOptions,
): Promise<LoadedCapabilitiesConfig> {
	const workspaceRoot = resolve(options.workspaceRoot);
	const candidate = resolveCapabilitiesCandidate({
		...options,
		workspaceRoot,
	});
	if (candidate == null) {
		return {
			config: createDefaultCapabilitiesConfig(workspaceRoot),
			source: { kind: "builtin" },
			configDir: workspaceRoot,
			workspaceRoot,
		};
	}

	if (!existsSync(candidate.path)) {
		throw new Error(`Capabilities config file not found: ${candidate.path}`);
	}

	const content = await readFile(candidate.path, "utf8");
	return {
		config: parseCapabilitiesConfigText(candidate.path, content),
		source: {
			kind: candidate.kind,
			path: candidate.path,
		},
		configDir: dirname(candidate.path),
		workspaceRoot,
	};
}

export async function loadCapabilitiesRuntime(
	options: LoadCapabilitiesConfigOptions,
): Promise<CapabilitiesRuntime> {
	const loaded = await loadCapabilitiesConfig(options);
	return buildCapabilitiesRuntime(loaded);
}

export function buildCapabilitiesRuntime(
	loaded: LoadedCapabilitiesConfig,
): CapabilitiesRuntime {
	return {
		config: loaded.config,
		source: loaded.source,
		mcpServers: buildMcpServers(
			loaded.config,
			loaded.configDir,
			loaded.workspaceRoot,
		),
		skillsManager: buildSkillsManager(loaded.config, loaded.configDir),
	};
}
