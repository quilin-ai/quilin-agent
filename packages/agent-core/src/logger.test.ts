import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger runtime configuration", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		vi.doUnmock("pino");
		vi.doUnmock("pino-pretty");
		process.env = { ...originalEnv };
	});

	function mockLoggerModules() {
		const childLogger = {
			info: vi.fn(),
			level: "debug",
		};
		const pinoMock = vi.fn(() => childLogger);
		Object.assign(pinoMock, {
			stdTimeFunctions: { isoTime: vi.fn(() => "now") },
		});
		const prettyMock = vi.fn(() => ({ stream: true }));
		vi.doMock("pino", () => ({ default: pinoMock }));
		vi.doMock("pino-pretty", () => ({ default: prettyMock }));
		return { childLogger, pinoMock, prettyMock };
	}

	it("configures repl logging with pino-pretty on stderr", async () => {
		const { pinoMock, prettyMock } = mockLoggerModules();
		const { configureLogger, getLoggerRuntimeMode, logger } = await import(
			"./logger.js"
		);

		configureLogger("repl");
		logger.info("hello");

		expect(getLoggerRuntimeMode()).toBe("repl");
		expect(prettyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				colorize: true,
				destination: process.stderr,
				sync: true,
			}),
		);
		expect(pinoMock).toHaveBeenCalledWith(
			expect.objectContaining({ name: "agent-core" }),
			{ stream: true },
		);
	});

	it("configures dev service logging with pretty and stdout targets", async () => {
		const { pinoMock } = mockLoggerModules();
		process.env.QUILIN_ENV = "dev";
		process.env.LOG_LEVEL = "warn";

		const { configureLogger } = await import("./logger.js");

		configureLogger("service");

		expect(pinoMock).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "warn",
				transport: {
					targets: [
						{ target: "pino-pretty", options: { destination: 2 } },
						{ target: "pino/file", options: { destination: 1 } },
					],
				},
			}),
		);
	});

	it("uses prod info defaults and initial repl mode from environment", async () => {
		const { pinoMock } = mockLoggerModules();
		process.env.QUILIN_ENV = "prod";
		process.env.QUILIN_RUNTIME_MODE = "repl";
		delete process.env.LOG_LEVEL;

		const { getLoggerRuntimeMode, logger } = await import("./logger.js");

		expect(getLoggerRuntimeMode()).toBe("repl");
		expect(logger.level).toBe("debug");
		expect(pinoMock).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "info",
				formatters: expect.objectContaining({
					bindings: expect.any(Function),
				}),
			}),
			expect.any(Object),
		);
		const [options] = pinoMock.mock.calls[0] as unknown as [
			{ formatters: { bindings: () => Record<string, string> } },
		];
		expect(options.formatters.bindings()).toEqual({
			service: "agent-core",
			env: "prod",
		});
	});

	it("uses plain service logging outside dev and defaults missing env to dev", async () => {
		const prodMocks = mockLoggerModules();
		process.env.QUILIN_ENV = "prod";
		delete process.env.QUILIN_RUNTIME_MODE;
		delete process.env.LOG_LEVEL;

		const prodLogger = await import("./logger.js");
		prodLogger.configureLogger("service");

		expect(prodMocks.pinoMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ level: "info" }),
		);
		vi.resetModules();
		vi.doUnmock("pino");
		vi.doUnmock("pino-pretty");

		const devMocks = mockLoggerModules();
		delete process.env.QUILIN_ENV;
		delete process.env.LOG_LEVEL;

		const { configureLogger } = await import("./logger.js");
		configureLogger("service");

		expect(devMocks.pinoMock).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "debug",
				transport: expect.any(Object),
			}),
		);
	});
});
