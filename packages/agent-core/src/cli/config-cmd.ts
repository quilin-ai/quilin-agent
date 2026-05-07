// CLI entry for `quilin config show` and `quilin config set` per
// ADR-009 §3 + §3.6. Pure TS argv parser; no external CLI library.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import {
	type ConfigSource,
	loadUserConfig,
	UserConfigError,
	type UserConfigLoadResult,
} from "../config/user-config.js";
import {
	FORBIDDEN_FIELD_FRAGMENTS,
	userConfigSchema,
} from "../config/user-config-schema.js";
import {
	buildProviderLiveMatrix,
	DEFAULT_PROVIDER_CATALOG,
	listProviderCredentialPathCandidates,
} from "../llm/provider.js";

const DEFAULT_CONFIG_PATH = path.join(homedir(), ".quilin", "config.toml");

export interface ConfigCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ConfigCommandOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly credentialPathExists?: CredentialPathExists;
}

type CredentialPathExists = (
	resolvedPath: string,
	redactedPath: string,
) => boolean | Promise<boolean>;

export async function runConfigCommand(
	argv: readonly string[],
	options: ConfigCommandOptions = {},
): Promise<ConfigCommandResult> {
	const env = options.env ?? process.env;
	const subcommand = argv[0];

	if (subcommand === "show") {
		return runShow(argv.slice(1), env);
	}
	if (subcommand === "status") {
		return runStatus(argv.slice(1), env, options.credentialPathExists);
	}
	if (subcommand === "set") {
		return runSet(argv.slice(1), env);
	}
	if (subcommand == null || subcommand === "help" || subcommand === "--help") {
		return {
			exitCode: subcommand == null ? 2 : 0,
			stdout: "",
			stderr: helpText(),
		};
	}
	return {
		exitCode: 2,
		stdout: "",
		stderr: `unknown config subcommand: ${subcommand}\n${helpText()}`,
	};
}

function helpText(): string {
	return [
		"Usage:",
		"  quilin config show [--source] [--config <path>]",
		"  quilin config status [--config <path>]",
		"  quilin config set <dot.path> <value> [--config <path>]",
		"",
		"`show` prints the merged user config as JSON. With --source, prints",
		"each leaf's winning layer (cli / env / file / default).",
		"`status` prints provider auth and quota readiness without secrets.",
		"",
		"`set` writes <value> at <dot.path> into the config file (default",
		"~/.quilin/config.toml; --config overrides). New files are created",
		"with mode 0600. Forbidden field name fragments (api_key / token /",
		"secret) are rejected; API keys live in env vars only.",
	].join("\n");
}

interface StatusFlags {
	readonly configPath: string;
}

function parseStatusFlags(argv: readonly string[]): StatusFlags {
	let configPath = DEFAULT_CONFIG_PATH;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--config") {
			const next = argv[i + 1];
			if (next == null || next.startsWith("--")) {
				throw new ConfigCliError("--config requires a path");
			}
			configPath = next;
			i += 1;
			continue;
		}
		throw new ConfigCliError(`unknown flag: ${arg}`);
	}
	return { configPath };
}

async function runStatus(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	credentialPathExists: CredentialPathExists = defaultCredentialPathExists,
): Promise<ConfigCommandResult> {
	let flags: StatusFlags;
	try {
		flags = parseStatusFlags(argv);
	} catch (error) {
		return cliError(error);
	}

	let result: UserConfigLoadResult;
	try {
		result = await loadUserConfig({ configPath: flags.configPath, env });
	} catch (error) {
		return cliError(error);
	}

	const existingCredentialPaths = await collectExistingCredentialPaths(
		env,
		credentialPathExists,
	);
	const providerLiveMatrix = buildProviderLiveMatrix(DEFAULT_PROVIDER_CATALOG, {
		env,
		existingCredentialPaths,
	});

	return {
		exitCode: 0,
		stdout: `${JSON.stringify(
			{
				file_path: result.filePath,
				provider_live_matrix: providerLiveMatrix,
			},
			null,
			2,
		)}\n`,
		stderr: "",
	};
}

async function collectExistingCredentialPaths(
	env: Readonly<Record<string, string | undefined>>,
	credentialPathExists: CredentialPathExists,
): Promise<readonly string[]> {
	const existing: string[] = [];
	for (const candidate of listProviderCredentialPathCandidates(
		DEFAULT_PROVIDER_CATALOG,
		env,
	)) {
		const resolvedPath = resolveCredentialPath(candidate);
		if (await credentialPathExists(resolvedPath, candidate)) {
			existing.push(candidate);
		}
	}
	return existing;
}

function resolveCredentialPath(candidate: string): string {
	if (candidate === "~") {
		return homedir();
	}
	if (candidate.startsWith("~/")) {
		return path.join(homedir(), candidate.slice(2));
	}
	return candidate;
}

async function defaultCredentialPathExists(
	resolvedPath: string,
): Promise<boolean> {
	try {
		await fs.access(resolvedPath);
		return true;
	} catch {
		return false;
	}
}

interface ShowFlags {
	readonly configPath: string;
	readonly withSource: boolean;
}

function parseShowFlags(argv: readonly string[]): ShowFlags {
	let configPath = DEFAULT_CONFIG_PATH;
	let withSource = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--source") {
			withSource = true;
			continue;
		}
		if (arg === "--config") {
			const next = argv[i + 1];
			if (next == null || next.startsWith("--")) {
				throw new ConfigCliError("--config requires a path");
			}
			configPath = next;
			i += 1;
			continue;
		}
		throw new ConfigCliError(`unknown flag: ${arg}`);
	}
	return { configPath, withSource };
}

async function runShow(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): Promise<ConfigCommandResult> {
	let flags: ShowFlags;
	try {
		flags = parseShowFlags(argv);
	} catch (error) {
		return cliError(error);
	}

	let result: UserConfigLoadResult;
	try {
		result = await loadUserConfig({ configPath: flags.configPath, env });
	} catch (error) {
		return cliError(error);
	}

	const payload = flags.withSource
		? buildShowWithSource(result)
		: { config: result.config, file_path: result.filePath };
	return {
		exitCode: 0,
		stdout: `${JSON.stringify(payload, null, 2)}\n`,
		stderr: "",
	};
}

function buildShowWithSource(
	result: UserConfigLoadResult,
): Record<string, unknown> {
	const sourcesRecord: Record<string, ConfigSource> = {};
	for (const [key, source] of Object.entries(result.sources)) {
		sourcesRecord[key] = source;
	}
	return {
		config: result.config,
		sources: sourcesRecord,
		file_path: result.filePath,
	};
}

interface SetFlags {
	readonly configPath: string;
	readonly dotPath: readonly string[];
	readonly rawValue: string;
}

function parseSetFlags(argv: readonly string[]): SetFlags {
	let configPath = DEFAULT_CONFIG_PATH;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--config") {
			const next = argv[i + 1];
			if (next == null || next.startsWith("--")) {
				throw new ConfigCliError("--config requires a path");
			}
			configPath = next;
			i += 1;
			continue;
		}
		if (arg.startsWith("--")) {
			throw new ConfigCliError(`unknown flag: ${arg}`);
		}
		positional.push(arg);
	}
	if (positional.length !== 2) {
		throw new ConfigCliError(
			"set requires exactly <dot.path> <value> positional args",
		);
	}
	const dotPath = positional[0].split(".");
	if (dotPath.some((segment) => segment.length === 0)) {
		throw new ConfigCliError(`invalid dot.path: ${positional[0]}`);
	}
	for (const segment of dotPath) {
		const lower = segment.toLowerCase();
		for (const fragment of FORBIDDEN_FIELD_FRAGMENTS) {
			const bare = fragment.replace(/^_/, "");
			if (lower === bare || lower.endsWith(fragment)) {
				throw new ConfigCliError(
					`refusing to set forbidden field "${positional[0]}"; API keys live in env vars only`,
				);
			}
		}
	}
	return { configPath, dotPath, rawValue: positional[1] };
}

async function runSet(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): Promise<ConfigCommandResult> {
	let flags: SetFlags;
	try {
		flags = parseSetFlags(argv);
	} catch (error) {
		return cliError(error);
	}

	let existing: Record<string, unknown> = {};
	try {
		await assertSetFileMode(flags.configPath);
		const raw = await fs.readFile(flags.configPath, "utf8");
		const { parse: parseToml } = await import("smol-toml");
		const parsed = parseToml(raw);
		if (typeof parsed === "object" && parsed !== null) {
			existing = parsed as Record<string, unknown>;
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			return cliError(error);
		}
	}

	const updated = setDotPath(
		existing,
		flags.dotPath,
		coerceLiteral(flags.rawValue),
	);

	const validation = userConfigSchema.safeParse(updated);
	if (!validation.success) {
		return cliError(
			new UserConfigError(
				`schema validation failed after set: ${validation.error.issues
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; ")}`,
				"SCHEMA_VALIDATION",
			),
		);
	}

	try {
		await fs.mkdir(path.dirname(flags.configPath), { recursive: true });
		await fs.writeFile(
			flags.configPath,
			stringifyToml(updated as Record<string, unknown>),
			{
				mode: 0o600,
			},
		);
		await fs.chmod(flags.configPath, 0o600);
	} catch (error) {
		return cliError(error);
	}

	// Reload to confirm and show the source layer of the just-set leaf.
	let reloaded: UserConfigLoadResult;
	try {
		reloaded = await loadUserConfig({ configPath: flags.configPath, env });
	} catch (error) {
		return cliError(error);
	}

	const dotKey = flags.dotPath.join(".");
	const newValue = pickDotPath(
		reloaded.config as Record<string, unknown>,
		flags.dotPath,
	);
	return {
		exitCode: 0,
		stdout: `${JSON.stringify(
			{
				file_path: flags.configPath,
				updated: { key: dotKey, value: newValue },
				source: reloaded.sources[dotKey] ?? "file",
			},
			null,
			2,
		)}\n`,
		stderr: "",
	};
}

async function assertSetFileMode(filePath: string): Promise<boolean> {
	const stat = await fs.stat(filePath);
	if (process.platform !== "win32") {
		const mode = stat.mode & 0o777;
		if (mode > 0o600) {
			throw new UserConfigError(
				`refusing to write ${filePath}: permission ${mode.toString(8)} > 0600 (chmod 0600 ${filePath})`,
				"FILE_PERMISSION",
			);
		}
	}
	return true;
}

function setDotPath(
	target: Record<string, unknown>,
	dotPath: readonly string[],
	value: unknown,
): Record<string, unknown> {
	const [head, ...rest] = dotPath;
	if (rest.length === 0) {
		return { ...target, [head]: value };
	}
	const nested = target[head];
	const child =
		typeof nested === "object" && nested !== null && !Array.isArray(nested)
			? (nested as Record<string, unknown>)
			: {};
	return { ...target, [head]: setDotPath(child, rest, value) };
}

function pickDotPath(
	source: Record<string, unknown>,
	dotPath: readonly string[],
): unknown {
	let cursor: unknown = source;
	for (const key of dotPath) {
		if (typeof cursor !== "object" || cursor === null) return undefined;
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return cursor;
}

function coerceLiteral(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	if (/^-?\d+$/.test(raw)) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (/^-?\d+\.\d+$/.test(raw)) {
		const parsed = Number.parseFloat(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (raw.startsWith("[") && raw.endsWith("]")) {
		try {
			return JSON.parse(raw);
		} catch {
			// fall through to string
		}
	}
	return raw;
}

class ConfigCliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigCliError";
	}
}

function cliError(error: unknown): ConfigCommandResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		exitCode: 1,
		stdout: "",
		stderr: `error: ${message}\n`,
	};
}

export const __testing = {
	parseShowFlags,
	parseStatusFlags,
	parseSetFlags,
	resolveCredentialPath,
	setDotPath,
	pickDotPath,
	coerceLiteral,
};
