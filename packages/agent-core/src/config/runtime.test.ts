import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	RuntimeReloadFailureSnapshot,
	RuntimeReloadOutcomeTransitionKind,
	RuntimeReloadSuccessSnapshot,
	UserRuntimeStateSnapshot,
} from "./runtime.js";
import {
	bootstrapUserRuntime,
	buildRuntimeInferenceConfig,
	buildRuntimeReloadAuditEvent,
	buildRuntimeToolFilter,
	diffUserRuntimeStateSnapshots,
	getDefaultSpanProvider,
	getDefaultStructuredLogger,
	getUserConfig,
	getUserConfigSources,
	getUserRuntime,
	getUserRuntimeStateSnapshot,
	isRuntimeToolEnabled,
	isUserRuntimeReady,
	reloadUserRuntime,
	resetUserRuntime,
	resolveRuntimeWriteAuthorityMode,
	UserRuntimeNotBootedError,
} from "./runtime.js";

let tmpDir: string;

function successSnapshot(
	generation: number,
	overrides: Partial<RuntimeReloadSuccessSnapshot> = {},
): RuntimeReloadSuccessSnapshot {
	return {
		generation,
		operation: "reload",
		completedAtEpochMs: 1000 + generation,
		configPath: `/tmp/quilin-${generation}.toml`,
		...overrides,
	};
}

function failureSnapshot(
	generation: number,
	overrides: Partial<RuntimeReloadFailureSnapshot> = {},
): RuntimeReloadFailureSnapshot {
	return {
		generation,
		operation: "reload",
		completedAtEpochMs: 2000 + generation,
		errorName: "UserConfigError",
		errorMessage: `invalid config ${generation}`,
		errorCode: "SCHEMA_VALIDATION",
		...overrides,
	};
}

function runtimeSnapshot(
	overrides: Partial<UserRuntimeStateSnapshot> = {},
): UserRuntimeStateSnapshot {
	return {
		generation: 1,
		booted: true,
		inFlight: false,
		inFlightGenerations: [],
		lastSuccess: null,
		lastFailure: null,
		...overrides,
	};
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(tmpdir(), "quilin-runtime-"));
	resetUserRuntime();
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
	resetUserRuntime();
});

describe("user runtime bootstrap", () => {
	it("throws on accessors before bootstrap", () => {
		expect(() => getUserConfig()).toThrow(UserRuntimeNotBootedError);
		expect(() => getDefaultSpanProvider()).toThrow(UserRuntimeNotBootedError);
		expect(() => getDefaultStructuredLogger()).toThrow(
			UserRuntimeNotBootedError,
		);
		expect(isUserRuntimeReady()).toBe(false);
		expect(getUserRuntimeStateSnapshot()).toMatchObject({
			booted: false,
			inFlight: false,
			inFlightGenerations: [],
			lastSuccess: null,
			lastFailure: null,
		});
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
		expect(isUserRuntimeReady()).toBe(true);
		const state = getUserRuntimeStateSnapshot();
		expect(state).toMatchObject({
			booted: true,
			inFlight: false,
			inFlightGenerations: [],
			lastFailure: null,
		});
		expect(state.lastSuccess).toMatchObject({
			generation: state.generation,
			operation: "bootstrap",
			configPath: null,
		});
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
		expect(isUserRuntimeReady()).toBe(false);
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

	it("diffUserRuntimeStateSnapshots() reports boot and in-flight deltas", () => {
		const diff = diffUserRuntimeStateSnapshots(
			{
				generation: 1,
				booted: false,
				inFlight: false,
				inFlightGenerations: [],
				lastSuccess: null,
				lastFailure: null,
			},
			{
				generation: 2,
				booted: true,
				inFlight: true,
				inFlightGenerations: [2],
				lastSuccess: null,
				lastFailure: null,
			},
		);

		expect(diff).toEqual({
			changedFields: [
				"generation",
				"booted",
				"inFlight",
				"inFlightGenerations",
			],
			generationDelta: 1,
			inFlightDelta: {
				addedGenerations: [2],
				removedGenerations: [],
				countDelta: 1,
			},
			failureSuccessTransition: {
				kind: "unchanged",
				from: { outcome: "none", generation: null },
				to: { outcome: "none", generation: null },
			},
			successPresent: false,
			failurePresent: false,
		});
	});

	it("diffUserRuntimeStateSnapshots() reports generation and success updates", () => {
		const diff = diffUserRuntimeStateSnapshots(
			{
				generation: 3,
				booted: true,
				inFlight: true,
				inFlightGenerations: [3, 4],
				lastSuccess: {
					generation: 2,
					operation: "bootstrap",
					completedAtEpochMs: 1000,
					configPath: null,
				},
				lastFailure: null,
			},
			{
				generation: 5,
				booted: true,
				inFlight: true,
				inFlightGenerations: [4, 5],
				lastSuccess: {
					generation: 5,
					operation: "reload",
					completedAtEpochMs: 2000,
					configPath: "/tmp/quilin.toml",
				},
				lastFailure: null,
			},
		);

		expect(diff).toEqual({
			changedFields: ["generation", "inFlightGenerations", "lastSuccess"],
			generationDelta: 2,
			inFlightDelta: {
				addedGenerations: [5],
				removedGenerations: [3],
				countDelta: 0,
			},
			failureSuccessTransition: {
				kind: "success-updated",
				from: { outcome: "success", generation: 2 },
				to: { outcome: "success", generation: 5 },
			},
			successPresent: true,
			failurePresent: false,
		});
	});

	it("diffUserRuntimeStateSnapshots() reports failure-to-success transitions", () => {
		const lastFailure = {
			generation: 2,
			operation: "reload" as const,
			completedAtEpochMs: 2000,
			errorName: "UserConfigError",
			errorMessage: "invalid log level",
			errorCode: "SCHEMA_VALIDATION",
		};
		const diff = diffUserRuntimeStateSnapshots(
			{
				generation: 2,
				booted: true,
				inFlight: false,
				inFlightGenerations: [],
				lastSuccess: {
					generation: 1,
					operation: "bootstrap",
					completedAtEpochMs: 1000,
					configPath: "/tmp/quilin.toml",
				},
				lastFailure,
			},
			{
				generation: 3,
				booted: true,
				inFlight: false,
				inFlightGenerations: [],
				lastSuccess: {
					generation: 3,
					operation: "reload",
					completedAtEpochMs: 3000,
					configPath: "/tmp/quilin.toml",
				},
				lastFailure,
			},
		);

		expect(diff).toEqual({
			changedFields: ["generation", "lastSuccess"],
			generationDelta: 1,
			inFlightDelta: {
				addedGenerations: [],
				removedGenerations: [],
				countDelta: 0,
			},
			failureSuccessTransition: {
				kind: "failure-to-success",
				from: { outcome: "failure", generation: 2 },
				to: { outcome: "success", generation: 3 },
			},
			successPresent: true,
			failurePresent: true,
		});
	});

	it("diffUserRuntimeStateSnapshots() classifies every reload outcome transition kind", () => {
		const cases: Array<{
			readonly expectedKind: RuntimeReloadOutcomeTransitionKind;
			readonly before: UserRuntimeStateSnapshot;
			readonly after: UserRuntimeStateSnapshot;
			readonly expectedFrom: {
				readonly outcome: string;
				readonly generation: number | null;
			};
			readonly expectedTo: {
				readonly outcome: string;
				readonly generation: number | null;
			};
		}> = [
			{
				expectedKind: "unchanged",
				before: runtimeSnapshot(),
				after: runtimeSnapshot(),
				expectedFrom: { outcome: "none", generation: null },
				expectedTo: { outcome: "none", generation: null },
			},
			{
				expectedKind: "none-to-success",
				before: runtimeSnapshot(),
				after: runtimeSnapshot({ lastSuccess: successSnapshot(2) }),
				expectedFrom: { outcome: "none", generation: null },
				expectedTo: { outcome: "success", generation: 2 },
			},
			{
				expectedKind: "none-to-failure",
				before: runtimeSnapshot(),
				after: runtimeSnapshot({ lastFailure: failureSnapshot(2) }),
				expectedFrom: { outcome: "none", generation: null },
				expectedTo: { outcome: "failure", generation: 2 },
			},
			{
				expectedKind: "success-to-none",
				before: runtimeSnapshot({ lastSuccess: successSnapshot(2) }),
				after: runtimeSnapshot(),
				expectedFrom: { outcome: "success", generation: 2 },
				expectedTo: { outcome: "none", generation: null },
			},
			{
				expectedKind: "success-to-failure",
				before: runtimeSnapshot({ lastSuccess: successSnapshot(2) }),
				after: runtimeSnapshot({
					lastSuccess: successSnapshot(2),
					lastFailure: failureSnapshot(3),
				}),
				expectedFrom: { outcome: "success", generation: 2 },
				expectedTo: { outcome: "failure", generation: 3 },
			},
			{
				expectedKind: "failure-to-none",
				before: runtimeSnapshot({ lastFailure: failureSnapshot(2) }),
				after: runtimeSnapshot(),
				expectedFrom: { outcome: "failure", generation: 2 },
				expectedTo: { outcome: "none", generation: null },
			},
			{
				expectedKind: "failure-to-success",
				before: runtimeSnapshot({ lastFailure: failureSnapshot(2) }),
				after: runtimeSnapshot({
					lastFailure: failureSnapshot(2),
					lastSuccess: successSnapshot(3),
				}),
				expectedFrom: { outcome: "failure", generation: 2 },
				expectedTo: { outcome: "success", generation: 3 },
			},
			{
				expectedKind: "success-updated",
				before: runtimeSnapshot({ lastSuccess: successSnapshot(2) }),
				after: runtimeSnapshot({ lastSuccess: successSnapshot(3) }),
				expectedFrom: { outcome: "success", generation: 2 },
				expectedTo: { outcome: "success", generation: 3 },
			},
			{
				expectedKind: "failure-updated",
				before: runtimeSnapshot({ lastFailure: failureSnapshot(2) }),
				after: runtimeSnapshot({ lastFailure: failureSnapshot(3) }),
				expectedFrom: { outcome: "failure", generation: 2 },
				expectedTo: { outcome: "failure", generation: 3 },
			},
		];

		expect(cases.map((testCase) => testCase.expectedKind)).toEqual([
			"unchanged",
			"none-to-success",
			"none-to-failure",
			"success-to-none",
			"success-to-failure",
			"failure-to-none",
			"failure-to-success",
			"success-updated",
			"failure-updated",
		]);

		for (const testCase of cases) {
			const diff = diffUserRuntimeStateSnapshots(
				testCase.before,
				testCase.after,
			);

			expect(diff.failureSuccessTransition).toEqual({
				kind: testCase.expectedKind,
				from: testCase.expectedFrom,
				to: testCase.expectedTo,
			});
		}
	});

	it("diffUserRuntimeStateSnapshots() treats same-generation payload changes as field changes, not outcome updates", () => {
		const successDiff = diffUserRuntimeStateSnapshots(
			runtimeSnapshot({
				lastSuccess: successSnapshot(7, {
					operation: "bootstrap",
					completedAtEpochMs: 1000,
					configPath: "/tmp/old.toml",
				}),
			}),
			runtimeSnapshot({
				lastSuccess: successSnapshot(7, {
					operation: "reload",
					completedAtEpochMs: 2000,
					configPath: "/tmp/new.toml",
				}),
			}),
		);
		expect(successDiff.changedFields).toEqual(["lastSuccess"]);
		expect(successDiff.failureSuccessTransition).toEqual({
			kind: "unchanged",
			from: { outcome: "success", generation: 7 },
			to: { outcome: "success", generation: 7 },
		});

		const failureDiff = diffUserRuntimeStateSnapshots(
			runtimeSnapshot({
				lastFailure: failureSnapshot(8, {
					completedAtEpochMs: 1000,
					errorMessage: "old failure",
					errorCode: "OLD_CODE",
				}),
			}),
			runtimeSnapshot({
				lastFailure: failureSnapshot(8, {
					completedAtEpochMs: 2000,
					errorMessage: "new failure",
					errorCode: "NEW_CODE",
				}),
			}),
		);
		expect(failureDiff.changedFields).toEqual(["lastFailure"]);
		expect(failureDiff.failureSuccessTransition).toEqual({
			kind: "unchanged",
			from: { outcome: "failure", generation: 8 },
			to: { outcome: "failure", generation: 8 },
		});
	});

	it("diffUserRuntimeStateSnapshots() reports an unchanged cloned snapshot without field deltas", () => {
		const before = runtimeSnapshot({
			generation: 42,
			inFlight: true,
			inFlightGenerations: [10, 12],
			lastSuccess: successSnapshot(12),
			lastFailure: failureSnapshot(10),
		});
		const after = {
			...before,
			inFlightGenerations: [...before.inFlightGenerations],
			lastSuccess:
				before.lastSuccess == null ? null : { ...before.lastSuccess },
			lastFailure:
				before.lastFailure == null ? null : { ...before.lastFailure },
		};

		expect(diffUserRuntimeStateSnapshots(before, after)).toEqual({
			changedFields: [],
			generationDelta: 0,
			inFlightDelta: {
				addedGenerations: [],
				removedGenerations: [],
				countDelta: 0,
			},
			failureSuccessTransition: {
				kind: "unchanged",
				from: { outcome: "success", generation: 12 },
				to: { outcome: "success", generation: 12 },
			},
			successPresent: true,
			failurePresent: true,
		});
	});

	it("diffUserRuntimeStateSnapshots() normalizes empty, removal-only, unsorted, and duplicate in-flight generations", () => {
		const emptyDiff = diffUserRuntimeStateSnapshots(
			runtimeSnapshot({ inFlightGenerations: [] }),
			runtimeSnapshot({ inFlightGenerations: [] }),
		);
		expect(emptyDiff.changedFields).toEqual([]);
		expect(emptyDiff.inFlightDelta).toEqual({
			addedGenerations: [],
			removedGenerations: [],
			countDelta: 0,
		});

		const removalOnlyDiff = diffUserRuntimeStateSnapshots(
			runtimeSnapshot({
				inFlight: true,
				inFlightGenerations: [9, 3, 3, 5],
			}),
			runtimeSnapshot({
				inFlight: false,
				inFlightGenerations: [],
			}),
		);
		expect(removalOnlyDiff.changedFields).toEqual([
			"inFlight",
			"inFlightGenerations",
		]);
		expect(removalOnlyDiff.inFlightDelta).toEqual({
			addedGenerations: [],
			removedGenerations: [3, 5, 9],
			countDelta: -3,
		});

		const unsortedDuplicateDiff = diffUserRuntimeStateSnapshots(
			runtimeSnapshot({
				inFlight: true,
				inFlightGenerations: [8, 2, 2, 5],
			}),
			runtimeSnapshot({
				inFlight: true,
				inFlightGenerations: [5, 8, 3, 3],
			}),
		);
		expect(unsortedDuplicateDiff.changedFields).toEqual([
			"inFlightGenerations",
		]);
		expect(unsortedDuplicateDiff.inFlightDelta).toEqual({
			addedGenerations: [3],
			removedGenerations: [2],
			countDelta: 0,
		});

		const duplicateOnlyDiff = diffUserRuntimeStateSnapshots(
			runtimeSnapshot({
				inFlight: true,
				inFlightGenerations: [4, 1, 4, 1],
			}),
			runtimeSnapshot({
				inFlight: true,
				inFlightGenerations: [1, 4],
			}),
		);
		expect(duplicateOnlyDiff.changedFields).toEqual([]);
		expect(duplicateOnlyDiff.inFlightDelta).toEqual({
			addedGenerations: [],
			removedGenerations: [],
			countDelta: 0,
		});
	});

	it("buildRuntimeReloadAuditEvent() builds an unchanged event from a diff", () => {
		const before = runtimeSnapshot({
			generation: 12,
			lastSuccess: successSnapshot(12),
		});
		const after = {
			...before,
			lastSuccess:
				before.lastSuccess == null ? null : { ...before.lastSuccess },
		};
		const diff = diffUserRuntimeStateSnapshots(before, after);

		expect(buildRuntimeReloadAuditEvent({ diff })).toEqual({
			event: "user_runtime_reload_audit",
			generationDelta: 0,
			changedFields: [],
			transitionKind: "unchanged",
			inFlight: {
				addedGenerations: [],
				removedGenerations: [],
				countDelta: 0,
			},
			successPresent: true,
			failurePresent: false,
		});
	});

	it("buildRuntimeReloadAuditEvent() reports success-to-failure presence from snapshots", () => {
		const before = runtimeSnapshot({
			generation: 4,
			lastSuccess: successSnapshot(4),
		});
		const after = runtimeSnapshot({
			generation: 5,
			lastSuccess: successSnapshot(4),
			lastFailure: failureSnapshot(5),
		});

		expect(buildRuntimeReloadAuditEvent({ before, after })).toEqual({
			event: "user_runtime_reload_audit",
			generationDelta: 1,
			changedFields: ["generation", "lastFailure"],
			transitionKind: "success-to-failure",
			inFlight: {
				addedGenerations: [],
				removedGenerations: [],
				countDelta: 0,
			},
			successPresent: true,
			failurePresent: true,
		});
	});

	it("buildRuntimeReloadAuditEvent() reports failure-to-success presence from snapshots", () => {
		const before = runtimeSnapshot({
			generation: 5,
			lastFailure: failureSnapshot(5),
		});
		const after = runtimeSnapshot({
			generation: 6,
			lastSuccess: successSnapshot(6),
			lastFailure: failureSnapshot(5),
		});

		expect(buildRuntimeReloadAuditEvent({ before, after })).toEqual({
			event: "user_runtime_reload_audit",
			generationDelta: 1,
			changedFields: ["generation", "lastSuccess"],
			transitionKind: "failure-to-success",
			inFlight: {
				addedGenerations: [],
				removedGenerations: [],
				countDelta: 0,
			},
			successPresent: true,
			failurePresent: true,
		});
	});

	it("buildRuntimeReloadAuditEvent() reports in-flight additions and removals", () => {
		const before = runtimeSnapshot({
			inFlight: true,
			inFlightGenerations: [1, 2, 4],
		});
		const after = runtimeSnapshot({
			inFlight: true,
			inFlightGenerations: [2, 3, 4, 5],
		});

		expect(buildRuntimeReloadAuditEvent({ before, after })).toEqual({
			event: "user_runtime_reload_audit",
			generationDelta: 0,
			changedFields: ["inFlightGenerations"],
			transitionKind: "unchanged",
			inFlight: {
				addedGenerations: [3, 5],
				removedGenerations: [1],
				countDelta: 1,
			},
			successPresent: false,
			failurePresent: false,
		});
	});

	it("reloadUserRuntime() hot-updates config from the original file path", async () => {
		const file = path.join(tmpDir, "config.toml");
		await fs.writeFile(
			file,
			`[observability]\nlog_level = "INFO"\n[memory.scratchpad]\nttl_sec = 10\n`,
			{ mode: 0o600 },
		);
		await fs.chmod(file, 0o600);

		await bootstrapUserRuntime({
			configPath: file,
			env: {},
		});
		const runtimeBefore = getUserRuntime();
		const stateBefore = getUserRuntimeStateSnapshot();
		const loggerBefore = getDefaultStructuredLogger();
		expect(getUserConfig().memory.scratchpad.ttl_sec).toBe(10);

		await fs.writeFile(
			file,
			`[observability]\nlog_level = "DEBUG"\n[memory.scratchpad]\nttl_sec = 30\n`,
		);
		await fs.chmod(file, 0o600);

		const runtimeAfter = await reloadUserRuntime();

		expect(runtimeAfter).toBe(getUserRuntime());
		expect(runtimeAfter).not.toBe(runtimeBefore);
		expect(getUserConfig().observability.log_level).toBe("DEBUG");
		expect(getUserConfig().memory.scratchpad.ttl_sec).toBe(30);
		expect(getUserConfigSources()["memory.scratchpad.ttl_sec"]).toBe("file");
		expect(getDefaultSpanProvider()).toBe(runtimeBefore.spanProvider);
		expect(getDefaultStructuredLogger()).not.toBe(loggerBefore);
		const stateAfter = getUserRuntimeStateSnapshot();
		expect(stateAfter.generation).toBeGreaterThan(stateBefore.generation);
		expect(stateAfter).toMatchObject({
			booted: true,
			inFlight: false,
			inFlightGenerations: [],
			lastFailure: null,
		});
		expect(stateAfter.lastSuccess).toMatchObject({
			generation: stateAfter.generation,
			operation: "reload",
			configPath: file,
		});
	});

	it("reloadUserRuntime() keeps the previous runtime when the new file is invalid", async () => {
		const file = path.join(tmpDir, "config.toml");
		await fs.writeFile(file, `[observability]\nlog_level = "INFO"\n`, {
			mode: 0o600,
		});
		await fs.chmod(file, 0o600);
		await bootstrapUserRuntime({
			configPath: file,
			env: {},
		});
		const runtimeBefore = getUserRuntime();

		await fs.writeFile(file, `[observability]\nlog_level = "TRACE"\n`);
		await fs.chmod(file, 0o600);

		const stateBefore = getUserRuntimeStateSnapshot();
		await expect(reloadUserRuntime()).rejects.toMatchObject({
			code: "SCHEMA_VALIDATION",
		});
		expect(getUserRuntime()).toBe(runtimeBefore);
		expect(getUserConfig().observability.log_level).toBe("INFO");
		const stateAfter = getUserRuntimeStateSnapshot();
		expect(stateAfter.generation).toBeGreaterThan(stateBefore.generation);
		expect(stateAfter).toMatchObject({
			booted: true,
			inFlight: false,
			inFlightGenerations: [],
		});
		expect(stateAfter.lastSuccess?.generation).toBe(
			stateBefore.lastSuccess?.generation,
		);
		expect(stateAfter.lastFailure).toMatchObject({
			generation: stateAfter.generation,
			operation: "reload",
			errorName: "UserConfigError",
			errorCode: "SCHEMA_VALIDATION",
		});
	});

	it("reloadUserRuntime() can update load options and preserve explicit dependencies", async () => {
		const firstFile = path.join(tmpDir, "first.toml");
		const secondFile = path.join(tmpDir, "second.toml");
		await fs.writeFile(firstFile, `[memory.scratchpad]\nttl_sec = 10\n`, {
			mode: 0o600,
		});
		await fs.writeFile(secondFile, `[memory.scratchpad]\nttl_sec = 50\n`, {
			mode: 0o600,
		});
		await fs.chmod(firstFile, 0o600);
		await fs.chmod(secondFile, 0o600);
		const { OTelSpanProvider } = await import("../observability/span.js");
		const { StructuredLogger } = await import("../observability/log.js");
		const customProvider = new OTelSpanProvider();
		const customLogger = new StructuredLogger({ level: "ERROR" });

		await bootstrapUserRuntime({
			configPath: firstFile,
			env: {},
			spanProvider: customProvider,
			structuredLogger: customLogger,
		});
		expect(getUserConfig().memory.scratchpad.ttl_sec).toBe(10);

		await reloadUserRuntime({ configPath: secondFile });

		expect(getUserConfig().memory.scratchpad.ttl_sec).toBe(50);
		expect(getDefaultSpanProvider()).toBe(customProvider);
		expect(getDefaultStructuredLogger()).toBe(customLogger);
	});

	it("reloadUserRuntime() lets the newest concurrent reload commit", async () => {
		const initialFile = path.join(tmpDir, "initial.toml");
		const slowFile = path.join(tmpDir, "slow.toml");
		const fastFile = path.join(tmpDir, "fast.toml");
		await fs.writeFile(initialFile, `[memory.scratchpad]\nttl_sec = 10\n`, {
			mode: 0o600,
		});
		await fs.writeFile(slowFile, `[memory.scratchpad]\nttl_sec = 20\n`, {
			mode: 0o600,
		});
		await fs.writeFile(fastFile, `[memory.scratchpad]\nttl_sec = 40\n`, {
			mode: 0o600,
		});
		await fs.chmod(initialFile, 0o600);
		await fs.chmod(slowFile, 0o600);
		await fs.chmod(fastFile, 0o600);
		await bootstrapUserRuntime({ configPath: initialFile, env: {} });

		let releaseSlowRead!: () => void;
		let markSlowStarted!: () => void;
		const slowReadRelease = new Promise<void>((resolve) => {
			releaseSlowRead = resolve;
		});
		const slowReadStarted = new Promise<void>((resolve) => {
			markSlowStarted = resolve;
		});
		const originalReadFile = fs.readFile.bind(fs);
		vi.spyOn(fs, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.readFile>
		) => {
			const [filePath] = args;
			if (path.resolve(String(filePath)) === path.resolve(slowFile)) {
				markSlowStarted();
				await slowReadRelease;
			}
			return originalReadFile(...args);
		}) as typeof fs.readFile);

		const slowReload = reloadUserRuntime({ configPath: slowFile });
		await slowReadStarted;
		const slowState = getUserRuntimeStateSnapshot();
		expect(slowState).toMatchObject({
			booted: true,
			inFlight: true,
		});
		expect(slowState.inFlightGenerations).toContain(slowState.generation);

		const fastRuntime = await reloadUserRuntime({ configPath: fastFile });
		const fastState = getUserRuntimeStateSnapshot();
		expect(fastState).toMatchObject({
			booted: true,
			inFlight: true,
			lastFailure: null,
		});
		expect(fastState.lastSuccess).toMatchObject({
			generation: fastState.generation,
			operation: "reload",
			configPath: fastFile,
		});
		expect(fastState.inFlightGenerations).toContain(
			slowState.inFlightGenerations[0],
		);
		releaseSlowRead();
		const slowRuntime = await slowReload;

		expect(getUserConfig().memory.scratchpad.ttl_sec).toBe(40);
		expect(fastRuntime).toBe(getUserRuntime());
		expect(slowRuntime).toBe(getUserRuntime());
		const finalState = getUserRuntimeStateSnapshot();
		expect(finalState).toMatchObject({
			booted: true,
			inFlight: false,
			inFlightGenerations: [],
			lastFailure: null,
		});
		expect(finalState.lastSuccess?.generation).toBe(fastState.generation);
	});

	it("reloadUserRuntime() does not let stale failures overwrite reload state", async () => {
		const initialFile = path.join(tmpDir, "initial.toml");
		const slowInvalidFile = path.join(tmpDir, "slow-invalid.toml");
		const fastFile = path.join(tmpDir, "fast.toml");
		await fs.writeFile(initialFile, `[memory.scratchpad]\nttl_sec = 10\n`, {
			mode: 0o600,
		});
		await fs.writeFile(
			slowInvalidFile,
			`[observability]\nlog_level = "TRACE"\n`,
			{ mode: 0o600 },
		);
		await fs.writeFile(fastFile, `[memory.scratchpad]\nttl_sec = 40\n`, {
			mode: 0o600,
		});
		await fs.chmod(initialFile, 0o600);
		await fs.chmod(slowInvalidFile, 0o600);
		await fs.chmod(fastFile, 0o600);
		await bootstrapUserRuntime({ configPath: initialFile, env: {} });

		let releaseSlowRead!: () => void;
		let markSlowStarted!: () => void;
		const slowReadRelease = new Promise<void>((resolve) => {
			releaseSlowRead = resolve;
		});
		const slowReadStarted = new Promise<void>((resolve) => {
			markSlowStarted = resolve;
		});
		const originalReadFile = fs.readFile.bind(fs);
		vi.spyOn(fs, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.readFile>
		) => {
			const [filePath] = args;
			if (path.resolve(String(filePath)) === path.resolve(slowInvalidFile)) {
				markSlowStarted();
				await slowReadRelease;
			}
			return originalReadFile(...args);
		}) as typeof fs.readFile);

		const staleFailure = reloadUserRuntime({ configPath: slowInvalidFile });
		await slowReadStarted;
		const fastRuntime = await reloadUserRuntime({ configPath: fastFile });
		const stateAfterFast = getUserRuntimeStateSnapshot();
		releaseSlowRead();

		await expect(staleFailure).rejects.toMatchObject({
			code: "SCHEMA_VALIDATION",
		});
		expect(fastRuntime).toBe(getUserRuntime());
		expect(getUserConfig().memory.scratchpad.ttl_sec).toBe(40);
		const finalState = getUserRuntimeStateSnapshot();
		expect(finalState).toMatchObject({
			booted: true,
			inFlight: false,
			inFlightGenerations: [],
			lastFailure: null,
		});
		expect(finalState.lastSuccess).toMatchObject({
			generation: stateAfterFast.generation,
			operation: "reload",
			configPath: fastFile,
		});
	});

	it("reloadUserRuntime() requires bootstrap first", async () => {
		await expect(reloadUserRuntime()).rejects.toThrow(
			UserRuntimeNotBootedError,
		);
		expect(isUserRuntimeReady()).toBe(false);
	});
});

describe("runtime config adapters", () => {
	it("maps user config into inference, trust, and tool runtime inputs", async () => {
		await bootstrapUserRuntime({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {
				OMNI_LLM_TEMPERATURE: "0.25",
				OMNI_LLM_MAX_TOKENS: "1234",
				OMNI_LLM_THINKING_ENABLED: "false",
				OMNI_LLM_THINKING_BUDGET_TOKENS: "4321",
				OMNI_SAFETY_TRUST_MODE: "auto",
				OMNI_TOOLS_ENABLED: "file_read,memory_recall",
				OMNI_TOOLS_DISABLED: "shell_exec",
			},
		});

		const config = getUserConfig();
		expect(buildRuntimeInferenceConfig(config)).toEqual({
			temperature: 0.25,
			maxTokens: 1234,
			thinkingMode: "disabled",
			thinkingBudget: 4321,
		});
		expect(resolveRuntimeWriteAuthorityMode(config)).toBe("auto-medium");

		const toolFilter = buildRuntimeToolFilter(config);
		expect(toolFilter).toEqual({
			enabled: ["file_read", "memory_recall"],
			disabled: ["shell_exec"],
		});
		expect(isRuntimeToolEnabled("file_read", toolFilter)).toBe(true);
		expect(isRuntimeToolEnabled("omnimem/memory_recall", toolFilter)).toBe(
			true,
		);
		expect(isRuntimeToolEnabled("memory_store", toolFilter)).toBe(false);
		expect(isRuntimeToolEnabled("omnimem/memory_store", toolFilter)).toBe(
			false,
		);
		expect(isRuntimeToolEnabled("shell_exec", toolFilter)).toBe(false);
	});
});
