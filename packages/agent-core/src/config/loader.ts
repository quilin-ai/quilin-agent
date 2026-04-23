import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { SkillsManager } from "../skills/manager.js";
import * as mcpClientModule from "../tools/mcp-client.js";
import type { MCPServerConfig as RuntimeMCPServerConfig } from "../tools/mcp-client.js";
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

			return resolveConfigPath(nextArg, cwd);
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

function parseYamlScalar(rawValue: string): unknown {
	const trimmed = rawValue.trim();
	if (trimmed === "true") {
		return true;
	}

	if (trimmed === "false") {
		return false;
	}

	if (/^-?\d+$/u.test(trimmed)) {
		return Number.parseInt(trimmed, 10);
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

		while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
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

function formatSchemaError(issues: readonly { path: PropertyKey[]; message: string }[]) {
	return issues
		.map((issue) => {
			const location =
				issue.path.length === 0 ? "root" : issue.path.join(".");
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

function buildSkillsManager(
	config: CapabilitiesConfig,
	baseDir: string,
): SkillsManager | undefined {
	if (!shouldInstantiateSkillsManager(config.skills)) {
		return undefined;
	}

	return new SkillsManager({
		...(config.skills.bundledRoots == null
			? {}
			: { bundledRoots: resolveStringArray(config.skills.bundledRoots, baseDir) }),
		...(config.skills.userRoots == null
			? {}
			: { userRoots: resolveStringArray(config.skills.userRoots, baseDir) }),
		...(config.skills.projectRoots == null
			? {}
			: {
					projectRoots: resolveStringArray(
						config.skills.projectRoots,
						baseDir,
					),
				}),
		...(config.skills.pluginRoots == null
			? {}
			: { pluginRoots: resolveStringArray(config.skills.pluginRoots, baseDir) }),
		...(config.skills.watcherEnabled == null
			? {}
			: { watcherEnabled: config.skills.watcherEnabled }),
		...(config.skills.debounceMs == null
			? {}
			: { debounceMs: config.skills.debounceMs }),
	});
}

function buildMcpServers(
	config: CapabilitiesConfig,
	baseDir: string,
): readonly MCPServerEntry[] {
	return Object.entries(config.mcpServers)
		.filter(([, serverConfig]) => serverConfig.enabled !== false)
		.map(([id, serverConfig]) => {
			const runtimeConfig: RuntimeMCPServerConfig = {
				command: serverConfig.command,
				args: [...serverConfig.args],
				...(serverConfig.cwd == null
					? {}
					: { cwd: resolveConfigPath(serverConfig.cwd, baseDir) }),
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
	return {
		schema_version: CAPABILITIES_SCHEMA_VERSION,
		mcpServers: {
			omnimem: {
				command: "uv",
				args: ["run", "python", "-m", "omnimem"],
				cwd: join(workspaceRoot, "providers", "memory"),
			},
		},
		skills: {
			enabled: false,
		},
	};
}

export async function loadCapabilitiesConfig(
	options: LoadCapabilitiesConfigOptions,
): Promise<LoadedCapabilitiesConfig> {
	const candidate = resolveCapabilitiesCandidate(options);
	if (candidate == null) {
		return {
			config: createDefaultCapabilitiesConfig(options.workspaceRoot),
			source: { kind: "builtin" },
			configDir: options.workspaceRoot,
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
		mcpServers: buildMcpServers(loaded.config, loaded.configDir),
		skillsManager: buildSkillsManager(loaded.config, loaded.configDir),
	};
}
