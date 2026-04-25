import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, loadUserConfig, UserConfigError } from "./user-config.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(tmpdir(), "quilin-user-config-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeConfig(toml: string, mode = 0o600): Promise<string> {
	const file = path.join(tmpDir, "config.toml");
	await fs.writeFile(file, toml, { mode });
	await fs.chmod(file, mode);
	return file;
}

describe("user-config schema defaults", () => {
	it("returns built-in defaults when file is absent and env is empty", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {},
		});

		expect(result.config.schema_version).toBe(1);
		expect(result.config.llm.default_model).toBe("claude-sonnet-4-6");
		expect(result.config.llm.temperature).toBe(0.7);
		expect(result.config.observability.log_level).toBe("INFO");
		expect(result.config.safety.trust_mode).toBe("read_only");
		expect(result.config.idle_evolution.enabled).toBe(false);
		expect(result.filePath).toBeNull();
		expect(result.sources["llm.default_model"]).toBe("default");
	});
});

describe("user-config TOML loading", () => {
	it("parses TOML and reports file as source", async () => {
		const file = await writeConfig(`
[llm]
default_model = "claude-opus-4-7"
temperature = 0.3

[observability]
log_level = "DEBUG"
`);
		const result = await loadUserConfig({ configPath: file, env: {} });
		expect(result.config.llm.default_model).toBe("claude-opus-4-7");
		expect(result.config.llm.temperature).toBe(0.3);
		expect(result.config.observability.log_level).toBe("DEBUG");
		expect(result.sources["llm.default_model"]).toBe("file");
		expect(result.sources["llm.temperature"]).toBe("file");
	});

	it("rejects file with permission > 0600", async () => {
		const file = await writeConfig(`[llm]\ndefault_model = "x"\n`, 0o644);
		await expect(loadUserConfig({ configPath: file, env: {} })).rejects.toThrow(
			UserConfigError,
		);
	});

	it("allows wider perms when enforceFileMode is false", async () => {
		const file = await writeConfig(`[llm]\ndefault_model = "x"\n`, 0o644);
		const result = await loadUserConfig({
			configPath: file,
			env: {},
			enforceFileMode: false,
		});
		expect(result.config.llm.default_model).toBe("x");
	});

	it("rejects forbidden field names with API-key fragments", async () => {
		const file = await writeConfig(`
[llm]
anthropic_api_key = "sk-leak"
`);
		await expect(loadUserConfig({ configPath: file, env: {} })).rejects.toThrow(
			/forbidden field/,
		);
	});

	it("rejects nested forbidden token field", async () => {
		const file = await writeConfig(`
[llm]
[llm.openai]
access_token = "leak"
`);
		await expect(loadUserConfig({ configPath: file, env: {} })).rejects.toThrow(
			/forbidden field/,
		);
	});

	it("returns malformed TOML as TOML_PARSE error", async () => {
		const file = await writeConfig(`[llm\nbroken = "no closing bracket"\n`);
		await expect(loadUserConfig({ configPath: file, env: {} })).rejects.toThrow(
			UserConfigError,
		);
	});
});

describe("user-config env-var mapping", () => {
	it("maps OMNI_LLM_DEFAULT_MODEL to llm.default_model with longest-prefix match", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: { OMNI_LLM_DEFAULT_MODEL: "claude-opus-4-7" },
		});
		expect(result.config.llm.default_model).toBe("claude-opus-4-7");
		expect(result.sources["llm.default_model"]).toBe("env");
	});

	it("coerces boolean env vars from yes/on/true/1", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: { OMNI_OBSERVABILITY_TRACING_ENABLED: "yes" },
		});
		expect(result.config.observability.tracing.enabled).toBe(true);
	});

	it("coerces number env vars", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: { OMNI_LLM_MAX_TOKENS: "16384" },
		});
		expect(result.config.llm.max_tokens).toBe(16_384);
	});

	it("rejects malformed boolean env value", async () => {
		await expect(
			loadUserConfig({
				configPath: path.join(tmpDir, "missing.toml"),
				env: { OMNI_OBSERVABILITY_TRACING_ENABLED: "maybe" },
			}),
		).rejects.toThrow(/cannot be coerced to boolean/);
	});

	it("ignores env vars without OMNI_ prefix", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: { LLM_DEFAULT_MODEL: "ignored" },
		});
		expect(result.config.llm.default_model).toBe("claude-sonnet-4-6");
	});

	it("ignores OMNI_ env vars that don't match schema tree", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: { OMNI_FOO_BAR_BAZ: "ignored" },
		});
		expect(result.sources["llm.default_model"]).toBe("default");
	});

	it("splits comma-separated string arrays", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: { OMNI_TOOLS_ENABLED: "file_read, web_search ,code_execute" },
		});
		expect(result.config.tools.enabled).toEqual([
			"file_read",
			"web_search",
			"code_execute",
		]);
	});
});

describe("user-config cascade priority", () => {
	it("CLI overrides env which overrides file which overrides default", async () => {
		const file = await writeConfig(`
[llm]
default_model = "from-file"
temperature = 0.5
max_tokens = 4096
`);
		const result = await loadUserConfig({
			configPath: file,
			env: { OMNI_LLM_DEFAULT_MODEL: "from-env" },
			cliOverrides: { llm: { default_model: "from-cli" } },
		});

		expect(result.config.llm.default_model).toBe("from-cli");
		expect(result.config.llm.temperature).toBe(0.5);
		expect(result.config.llm.max_tokens).toBe(4096);
		expect(result.sources["llm.default_model"]).toBe("cli");
		expect(result.sources["llm.temperature"]).toBe("file");
	});

	it("schema validation rejects unknown top-level namespaces", async () => {
		const file = await writeConfig(`
[unknown_section]
foo = "bar"
`);
		await expect(loadUserConfig({ configPath: file, env: {} })).rejects.toThrow(
			/schema validation/,
		);
	});

	it("schema validation rejects out-of-range temperature", async () => {
		const file = await writeConfig(`
[llm]
temperature = 5.0
`);
		await expect(loadUserConfig({ configPath: file, env: {} })).rejects.toThrow(
			/schema validation/,
		);
	});
});

describe("user-config helpers", () => {
	it("envKeyToDotPath handles longest-prefix match", () => {
		expect(__testing.envKeyToDotPath("OMNI_LLM_DEFAULT_MODEL")).toEqual([
			"llm",
			"default_model",
		]);
		expect(
			__testing.envKeyToDotPath("OMNI_OBSERVABILITY_TRACING_ENDPOINT"),
		).toEqual(["observability", "tracing", "endpoint"]);
		expect(__testing.envKeyToDotPath("OMNI_TOOLS_ENABLED")).toEqual([
			"tools",
			"enabled",
		]);
		expect(__testing.envKeyToDotPath("OMNI_NOT_A_REAL_KEY")).toBeNull();
		expect(__testing.envKeyToDotPath("FOO_BAR")).toBeNull();
	});

	it("shallowMerge deep-merges nested tables", () => {
		const merged = __testing.shallowMerge(
			{ a: { b: 1, c: 2 } },
			{ a: { c: 3, d: 4 } },
		);
		expect(merged).toEqual({ a: { b: 1, c: 3, d: 4 } });
	});

	it("shallowMerge override replaces array, not deep-merge", () => {
		const merged = __testing.shallowMerge({ a: [1, 2] }, { a: [3] });
		expect(merged).toEqual({ a: [3] });
	});

	it("assertNoForbiddenFields catches uppercase variants", () => {
		expect(() =>
			__testing.assertNoForbiddenFields({ MY_API_KEY: "leak" }),
		).toThrow(/forbidden field/);
	});
});
