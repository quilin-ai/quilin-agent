import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, runConfigCommand } from "./config-cmd.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(tmpdir(), "quilin-config-cli-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("config show", () => {
	it("emits merged config as JSON when file is absent", async () => {
		const file = path.join(tmpDir, "missing.toml");
		const result = await runConfigCommand(["show", "--config", file], {
			env: {},
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.stdout);
		expect(parsed.config.llm.default_model).toBe("claude-sonnet-4-6");
		expect(parsed.file_path).toBeNull();
		expect(parsed.sources).toBeUndefined();
	});

	it("includes per-leaf sources when --source is set", async () => {
		const file = path.join(tmpDir, "config.toml");
		await fs.writeFile(file, `[llm]\ndefault_model = "claude-opus-4-7"\n`, {
			mode: 0o600,
		});
		await fs.chmod(file, 0o600);
		const result = await runConfigCommand(
			["show", "--source", "--config", file],
			{ env: { OMNI_LLM_TEMPERATURE: "0.5" } },
		);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.sources["llm.default_model"]).toBe("file");
		expect(parsed.sources["llm.temperature"]).toBe("env");
		expect(parsed.sources["safety.trust_mode"]).toBe("default");
	});

	it("returns exit 1 with error on schema violation in file", async () => {
		const file = path.join(tmpDir, "config.toml");
		await fs.writeFile(file, `[unknown]\nfoo = 1\n`, { mode: 0o600 });
		await fs.chmod(file, 0o600);
		const result = await runConfigCommand(["show", "--config", file], {
			env: {},
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/schema validation/);
	});

	it("returns exit 1 with error on unknown flag", async () => {
		const result = await runConfigCommand(["show", "--garbage"], { env: {} });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/unknown flag/);
	});

	it("returns exit 1 with error when --config has no path", async () => {
		const result = await runConfigCommand(["show", "--config"], { env: {} });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/--config requires a path/);

		const startsWithFlag = await runConfigCommand(
			["show", "--config", "--source"],
			{ env: {} },
		);
		expect(startsWithFlag.exitCode).toBe(1);
		expect(startsWithFlag.stderr).toMatch(/--config requires a path/);
	});
});

describe("config status", () => {
	it("emits provider auth and quota status without leaking secrets", async () => {
		const file = path.join(tmpDir, "missing.toml");
		const oauthPath = path.join(tmpDir, "gemini-oauth.json");
		const result = await runConfigCommand(["status", "--config", file], {
			env: {
				DEEPSEEK_API_KEY: "secret-deepseek-key",
				QUILIN_GEMINI_OAUTH_SESSION: oauthPath,
			},
			credentialPathExists: (_resolvedPath, redactedPath) =>
				redactedPath === oauthPath,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.stdout);
		expect(parsed.file_path).toBeNull();
		expect(result.stdout).not.toContain("secret-deepseek-key");
		expect(result.stdout).not.toContain(oauthPath);
		expect(parsed.provider_live_matrix).toContainEqual(
			expect.objectContaining({
				provider: "deepseek",
				credentialStatus: "configured",
				quotaStatus: "planned",
				redactedSources: ["env:DEEPSEEK_API_KEY"],
				quotaProbe: expect.objectContaining({
					ready: true,
					redactedCredentialSources: ["env:DEEPSEEK_API_KEY"],
				}),
			}),
		);
		expect(parsed.provider_live_matrix).toContainEqual(
			expect.objectContaining({
				provider: "gemini",
				credentialStatus: "configured",
				redactedSources: ["oauth_cli:QUILIN_GEMINI_OAUTH_SESSION"],
				credentialChecks: expect.arrayContaining([
					expect.objectContaining({
						mode: "oauth",
						status: "configured",
						redactedSource: "oauth_cli:QUILIN_GEMINI_OAUTH_SESSION",
					}),
				]),
			}),
		);
	});

	it("returns actionable missing credential reasons in provider status", async () => {
		const result = await runConfigCommand(["status"], {
			env: {
				DEEPSEEK_API_KEY: "  ",
				OPENAI_API_KEY: "",
			},
			credentialPathExists: () => false,
		});

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.provider_live_matrix).toContainEqual(
			expect.objectContaining({
				provider: "deepseek",
				credentialStatus: "missing",
				missingCredentialReasons: [
					expect.objectContaining({
						code: "env_empty",
						redactedSource: "env:DEEPSEEK_API_KEY",
					}),
				],
				quotaProbe: expect.objectContaining({
					ready: false,
					blockedReason: "missing_configured_credential",
				}),
			}),
		);
		expect(parsed.provider_live_matrix).toContainEqual(
			expect.objectContaining({
				provider: "openai",
				missingCredentialReasons: [
					expect.objectContaining({ code: "env_empty" }),
					expect.objectContaining({
						code: "credential_path_missing",
						redactedSource: "oauth_file:~/.codex/auth.json",
					}),
				],
			}),
		);
	});

	it("returns exit 1 with error on unknown status flag", async () => {
		const result = await runConfigCommand(["status", "--garbage"], {
			env: {},
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/unknown flag/);
	});
});

describe("config set", () => {
	it("writes new value to a fresh file with mode 0600", async () => {
		const file = path.join(tmpDir, "new.toml");
		const result = await runConfigCommand(
			["set", "llm.default_model", "claude-haiku-4-5", "--config", file],
			{ env: {} },
		);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.updated).toEqual({
			key: "llm.default_model",
			value: "claude-haiku-4-5",
		});
		expect(parsed.source).toBe("file");

		const stat = await fs.stat(file);
		expect(stat.mode & 0o777).toBe(0o600);

		const reloaded = await runConfigCommand(["show", "--config", file], {
			env: {},
		});
		const reloadedJson = JSON.parse(reloaded.stdout);
		expect(reloadedJson.config.llm.default_model).toBe("claude-haiku-4-5");
	});

	it("updates an existing file in place without dropping other values", async () => {
		const file = path.join(tmpDir, "config.toml");
		await fs.writeFile(
			file,
			`[llm]\ndefault_model = "claude-sonnet-4-6"\ntemperature = 0.7\n`,
			{ mode: 0o600 },
		);
		await fs.chmod(file, 0o600);

		const result = await runConfigCommand(
			["set", "llm.default_model", "claude-opus-4-7", "--config", file],
			{ env: {} },
		);
		expect(result.exitCode).toBe(0);

		const reloaded = await runConfigCommand(["show", "--config", file], {
			env: {},
		});
		const reloadedJson = JSON.parse(reloaded.stdout);
		expect(reloadedJson.config.llm.default_model).toBe("claude-opus-4-7");
		expect(reloadedJson.config.llm.temperature).toBe(0.7);
	});

	it("rejects wide-permission existing files before writing", async () => {
		const file = path.join(tmpDir, "wide.toml");
		const original = `[llm]\ndefault_model = "claude-sonnet-4-6"\n`;
		await fs.writeFile(file, original, { mode: 0o644 });
		await fs.chmod(file, 0o644);

		const result = await runConfigCommand(
			["set", "llm.default_model", "claude-opus-4-7", "--config", file],
			{ env: {} },
		);

		if (process.platform === "win32") {
			expect(result.exitCode).toBe(0);
			return;
		}

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/permission 644 > 0600/);
		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});

	it("coerces booleans and numbers from string args", async () => {
		const file = path.join(tmpDir, "config.toml");
		const boolResult = await runConfigCommand(
			["set", "observability.tracing.enabled", "true", "--config", file],
			{ env: {} },
		);
		expect(boolResult.exitCode).toBe(0);
		const numResult = await runConfigCommand(
			["set", "llm.max_tokens", "16384", "--config", file],
			{ env: {} },
		);
		expect(numResult.exitCode).toBe(0);

		const show = await runConfigCommand(["show", "--config", file], {
			env: {},
		});
		const shown = JSON.parse(show.stdout);
		expect(shown.config.observability.tracing.enabled).toBe(true);
		expect(shown.config.llm.max_tokens).toBe(16_384);
	});

	it("rejects forbidden field names in set", async () => {
		const file = path.join(tmpDir, "config.toml");
		const result = await runConfigCommand(
			["set", "llm.anthropic_api_key", "sk-leak", "--config", file],
			{ env: {} },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/forbidden field/);
	});

	it("rejects schema violation introduced by set", async () => {
		const file = path.join(tmpDir, "config.toml");
		const result = await runConfigCommand(
			["set", "llm.temperature", "5.0", "--config", file],
			{ env: {} },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/schema validation/);
	});

	it("rejects missing positional args", async () => {
		const file = path.join(tmpDir, "config.toml");
		const result = await runConfigCommand(
			["set", "llm.default_model", "--config", file],
			{ env: {} },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/exactly <dot.path> <value>/);
	});

	it("rejects unknown set flags, missing config values, and invalid dot paths", async () => {
		const file = path.join(tmpDir, "config.toml");
		const unknownFlag = await runConfigCommand(["set", "--garbage"], {
			env: {},
		});
		const missingConfig = await runConfigCommand(
			["set", "llm.default_model", "claude", "--config", "--source"],
			{ env: {} },
		);
		const invalidPath = await runConfigCommand(
			["set", "llm..default_model", "claude", "--config", file],
			{ env: {} },
		);

		expect(unknownFlag.exitCode).toBe(1);
		expect(unknownFlag.stderr).toMatch(/unknown flag/);
		expect(missingConfig.exitCode).toBe(1);
		expect(missingConfig.stderr).toMatch(/--config requires a path/);
		expect(invalidPath.exitCode).toBe(1);
		expect(invalidPath.stderr).toMatch(/invalid dot.path/);
	});
});

describe("config help", () => {
	it("prints help on no subcommand with exit 2", async () => {
		const result = await runConfigCommand([], { env: {} });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/quilin config show/);
	});

	it("prints help on `help` with exit 0", async () => {
		const result = await runConfigCommand(["help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toMatch(/quilin config set/);
		expect(result.stderr).toMatch(/quilin config status/);
	});

	it("rejects unknown subcommand", async () => {
		const result = await runConfigCommand(["bogus"], { env: {} });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/unknown config subcommand/);
	});
});

describe("coerceLiteral helper", () => {
	it("preserves boolean / number / null", () => {
		expect(__testing.coerceLiteral("true")).toBe(true);
		expect(__testing.coerceLiteral("false")).toBe(false);
		expect(__testing.coerceLiteral("null")).toBeNull();
		expect(__testing.coerceLiteral("42")).toBe(42);
		expect(__testing.coerceLiteral("3.14")).toBe(3.14);
	});

	it("parses JSON arrays", () => {
		expect(__testing.coerceLiteral('["a","b"]')).toEqual(["a", "b"]);
		expect(__testing.coerceLiteral("[not-json]")).toBe("[not-json]");
	});

	it("falls through to string", () => {
		expect(__testing.coerceLiteral("hello")).toBe("hello");
		expect(__testing.coerceLiteral("9".repeat(400))).toBe("9".repeat(400));
		expect(__testing.coerceLiteral(`${"9".repeat(400)}.1`)).toBe(
			`${"9".repeat(400)}.1`,
		);
		expect(__testing.pickDotPath({}, ["missing", "leaf"])).toBeUndefined();
		expect(__testing.pickDotPath({ a: null }, ["a", "leaf"])).toBeUndefined();
	});
});
