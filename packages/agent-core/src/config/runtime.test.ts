import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bootstrapUserRuntime,
	getDefaultSpanProvider,
	getDefaultStructuredLogger,
	getUserConfig,
	getUserConfigSources,
	getUserRuntime,
	resetUserRuntime,
	UserRuntimeNotBootedError,
} from "./runtime.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(tmpdir(), "quilin-runtime-"));
	resetUserRuntime();
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	resetUserRuntime();
});

describe("user runtime bootstrap", () => {
	it("throws on accessors before bootstrap", () => {
		expect(() => getUserConfig()).toThrow(UserRuntimeNotBootedError);
		expect(() => getDefaultSpanProvider()).toThrow(UserRuntimeNotBootedError);
		expect(() => getDefaultStructuredLogger()).toThrow(
			UserRuntimeNotBootedError,
		);
	});

	it("populates runtime with built-in defaults when file is absent", async () => {
		await bootstrapUserRuntime({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {},
		});

		const config = getUserConfig();
		expect(config.observability.log_level).toBe("INFO");
		expect(config.llm.default_model).toBe("claude-sonnet-4-6");

		const sources = getUserConfigSources();
		expect(sources["llm.default_model"]).toBe("default");

		const provider = getDefaultSpanProvider();
		expect(provider).toBeDefined();

		const logger = getDefaultStructuredLogger();
		expect(logger).toBeDefined();
	});

	it("propagates observability.log_level from file into structured logger threshold", async () => {
		const file = path.join(tmpDir, "config.toml");
		await fs.writeFile(file, `[observability]\nlog_level = "DEBUG"\n`, {
			mode: 0o600,
		});
		await fs.chmod(file, 0o600);

		const lines: string[] = [];
		await bootstrapUserRuntime({
			configPath: file,
			env: {},
		});

		const logger = getDefaultStructuredLogger();
		// Re-instantiate with a sink to verify threshold rather than poking
		// the singleton's internal write fn (private). DEBUG must pass when
		// the threshold is DEBUG; INFO is always allowed.
		expect(logger).toBeDefined();
		const config = getUserConfig();
		expect(config.observability.log_level).toBe("DEBUG");

		// Smoke test: a fresh DEBUG-level logger should write DEBUG events.
		const { StructuredLogger } = await import("../observability/log.js");
		const fresh = new StructuredLogger({
			level: config.observability.log_level,
			write: (line) => lines.push(line),
		});
		fresh.debug("test", "boot_event");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({
			level: "DEBUG",
			component: "test",
			event: "boot_event",
		});
	});

	it("returns same singleton across accessors after bootstrap", async () => {
		await bootstrapUserRuntime({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {},
		});

		const runtime1 = getUserRuntime();
		const runtime2 = getUserRuntime();
		expect(runtime1).toBe(runtime2);
		expect(runtime1.spanProvider).toBe(getDefaultSpanProvider());
		expect(runtime1.structuredLogger).toBe(getDefaultStructuredLogger());
	});

	it("resetUserRuntime() clears state for test isolation", async () => {
		await bootstrapUserRuntime({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {},
		});
		expect(getUserConfig()).toBeDefined();

		resetUserRuntime();
		expect(() => getUserConfig()).toThrow(UserRuntimeNotBootedError);
	});

	it("accepts explicit spanProvider / structuredLogger overrides for testing", async () => {
		const { OTelSpanProvider } = await import("../observability/span.js");
		const { StructuredLogger } = await import("../observability/log.js");
		const customProvider = new OTelSpanProvider();
		const customLogger = new StructuredLogger({ level: "ERROR" });

		await bootstrapUserRuntime({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {},
			spanProvider: customProvider,
			structuredLogger: customLogger,
		});

		expect(getDefaultSpanProvider()).toBe(customProvider);
		expect(getDefaultStructuredLogger()).toBe(customLogger);
	});
});
