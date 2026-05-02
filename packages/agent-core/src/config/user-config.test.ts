import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__testing,
	loadUserConfig,
	loadUserConfigSync,
	UserConfigError,
} from "./user-config.js";

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
		expect(result.config.llm.routing).toEqual({
			mode: "auto",
			default_tier: "lite",
			allow_escalation: true,
		});
		expect(result.config.llm.tiers).toEqual({
			flash: {
				provider: "deepseek",
				model: "deepseek-v4-flash",
				thinking: "disabled",
			},
			lite: {
				provider: "deepseek",
				model: "deepseek-v4-flash",
				thinking: "enabled",
			},
			pro: {
				provider: "deepseek",
				model: "deepseek-v4-pro",
				thinking: "enabled",
			},
		});
		expect(result.config.observability.log_level).toBe("INFO");
		expect(result.config.safety.trust_mode).toBe("read_only");
		expect(result.config.idle_evolution.enabled).toBe(false);
		expect(result.filePath).toBeNull();
		expect(result.sources["llm.default_model"]).toBe("default");
		expect(result.sources["llm.tiers.flash.model"]).toBe("default");
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

	it("parses tier routing TOML with arbitrary model ids per tier", async () => {
		const file = await writeConfig(`
[llm.routing]
mode = "auto"
default_tier = "flash"
allow_escalation = false

[llm.tiers.flash]
provider = "deepseek"
model = "local-small-anything"
thinking = "enabled"
max_tokens = 1024

[llm.tiers.lite]
provider = "deepseek"
model = "deepseek-v4-flash"
thinking = "auto"
temperature = 0.2

[llm.tiers.pro]
provider = "deepseek"
model = "vendor-pro-custom-2026-05"
thinking = "enabled"
thinking_budget_tokens = 12000
top_p = 0.8
`);

		const result = await loadUserConfig({ configPath: file, env: {} });

		expect(result.config.llm.routing).toEqual({
			mode: "auto",
			default_tier: "flash",
			allow_escalation: false,
		});
		expect(result.config.llm.tiers.flash).toEqual({
			provider: "deepseek",
			model: "local-small-anything",
			thinking: "enabled",
			max_tokens: 1024,
		});
		expect(result.config.llm.tiers.lite).toEqual({
			provider: "deepseek",
			model: "deepseek-v4-flash",
			thinking: "auto",
			temperature: 0.2,
		});
		expect(result.config.llm.tiers.pro).toEqual({
			provider: "deepseek",
			model: "vendor-pro-custom-2026-05",
			thinking: "enabled",
			thinking_budget_tokens: 12000,
			top_p: 0.8,
		});
		expect(result.sources["llm.routing.default_tier"]).toBe("file");
		expect(result.sources["llm.tiers.pro.model"]).toBe("file");
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

	it("merges multiple env values under the same namespace", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {
				OMNI_LLM_DEFAULT_MODEL: "claude-opus-4-7",
				OMNI_LLM_TEMPERATURE: "0.2",
			},
		});

		expect(result.config.llm.default_model).toBe("claude-opus-4-7");
		expect(result.config.llm.temperature).toBe(0.2);
		expect(result.sources["llm.default_model"]).toBe("env");
		expect(result.sources["llm.temperature"]).toBe("env");
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
			env: { LLM_DEFAULT_MODEL: "ignored", OMNI_LLM_DEFAULT_MODEL: undefined },
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

	it("coerces false-like booleans and rejects invalid numbers", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {
				OMNI_OBSERVABILITY_TRACING_ENABLED: "off",
				OMNI_IDLE_EVOLUTION_DAILY_BUDGET_TOKENS: "2500",
			},
		});
		expect(result.config.observability.tracing.enabled).toBe(false);
		expect(result.config.idle_evolution.daily_budget_tokens).toBe(2500);

		await expect(
			loadUserConfig({
				configPath: path.join(tmpDir, "missing.toml"),
				env: { OMNI_LLM_MAX_TOKENS: "many" },
			}),
		).rejects.toThrow(/cannot be coerced to number/);
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

	it("maps tier routing env vars into nested config", async () => {
		const result = await loadUserConfig({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {
				OMNI_LLM_ROUTING_MODE: "pro",
				OMNI_LLM_ROUTING_DEFAULT_TIER: "flash",
				OMNI_LLM_ROUTING_ALLOW_ESCALATION: "false",
				OMNI_LLM_TIERS_FLASH_MODEL: "deepseek-flash-local",
				OMNI_LLM_TIERS_FLASH_THINKING: "auto",
				OMNI_LLM_TIERS_LITE_MAX_TOKENS: "2048",
				OMNI_LLM_TIERS_PRO_THINKING_BUDGET_TOKENS: "16000",
				OMNI_LLM_TIERS_PRO_TOP_P: "0.75",
			},
		});

		expect(result.config.llm.routing).toEqual({
			mode: "pro",
			default_tier: "flash",
			allow_escalation: false,
		});
		expect(result.config.llm.tiers.flash.model).toBe("deepseek-flash-local");
		expect(result.config.llm.tiers.flash.thinking).toBe("auto");
		expect(result.config.llm.tiers.lite.max_tokens).toBe(2048);
		expect(result.config.llm.tiers.pro.thinking_budget_tokens).toBe(16_000);
		expect(result.config.llm.tiers.pro.top_p).toBe(0.75);
		expect(result.sources["llm.routing.mode"]).toBe("env");
		expect(result.sources["llm.tiers.flash.model"]).toBe("env");
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

describe("user-config synchronous loading", () => {
	it("returns defaults when sync config file is absent", () => {
		const result = loadUserConfigSync({
			configPath: path.join(tmpDir, "missing-sync.toml"),
			env: {},
		});

		expect(result.filePath).toBeNull();
		expect(result.config.llm.default_model).toBe("claude-sonnet-4-6");
		expect(result.sources["llm.default_model"]).toBe("default");
	});

	it("loads file, env, and CLI layers synchronously with source tracking", async () => {
		const file = await writeConfig(`
[llm]
default_model = "from-file"
temperature = 0.2
`);

		const result = loadUserConfigSync({
			configPath: file,
			env: { OMNI_LLM_DEFAULT_MODEL: "from-env" },
			cliOverrides: { llm: { fallback_model: "from-cli" } },
		});

		expect(result.filePath).toBe(file);
		expect(result.config.llm.default_model).toBe("from-env");
		expect(result.config.llm.fallback_model).toBe("from-cli");
		expect(result.config.llm.temperature).toBe(0.2);
		expect(result.sources["llm.default_model"]).toBe("env");
		expect(result.sources["llm.fallback_model"]).toBe("cli");
		expect(result.sources["llm.temperature"]).toBe("file");
	});

	it("rejects sync files with wide permissions on non-Windows platforms", async () => {
		const file = await writeConfig(`[llm]\ndefault_model = "x"\n`, 0o644);

		if (process.platform === "win32") {
			expect(() =>
				loadUserConfigSync({ configPath: file, env: {} }),
			).not.toThrow();
			return;
		}

		expect(() => loadUserConfigSync({ configPath: file, env: {} })).toThrow(
			UserConfigError,
		);
	});

	it("surfaces sync parse, forbidden-field, and schema errors", async () => {
		const malformed = await writeConfig(`[llm\nbroken = "no"\n`);
		expect(() =>
			loadUserConfigSync({ configPath: malformed, env: {} }),
		).toThrow(/Invalid TOML document/);

		const forbidden = await writeConfig(`[llm]\ntoken = "secret"\n`);
		expect(() =>
			loadUserConfigSync({ configPath: forbidden, env: {} }),
		).toThrow(/forbidden field/);

		const invalid = await writeConfig(`[llm]\ntemperature = 9\n`);
		expect(() => loadUserConfigSync({ configPath: invalid, env: {} })).toThrow(
			/schema validation/,
		);
	});
});

describe("user-config helpers", () => {
	it("envKeyToDotPath handles longest-prefix match", () => {
		expect(__testing.envKeyToDotPath("OMNI_")).toBeNull();
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

	it("shallowMerge replaces scalars with nested override tables", () => {
		const merged = __testing.shallowMerge(
			{ llm: "scalar" },
			{ llm: { default_model: "nested" } },
		);
		expect(merged).toEqual({ llm: { default_model: "nested" } });
	});

	it("assertNoForbiddenFields catches uppercase variants", () => {
		expect(() =>
			__testing.assertNoForbiddenFields({ MY_API_KEY: "leak" }),
		).toThrow(/forbidden field/);
	});

	it("helper coercion covers boolean aliases, empty arrays, and scalar passthrough", () => {
		expect(__testing.coerceEnvValue("NO", "boolean", "OMNI_FLAG")).toBe(false);
		expect(
			__testing.coerceEnvValue("a, , b", "string_array", "OMNI_TOOLS_ENABLED"),
		).toEqual(["a", "b"]);
		expect(__testing.coerceEnvValue("plain", undefined, "OMNI_UNKNOWN")).toBe(
			"plain",
		);
	});
});
