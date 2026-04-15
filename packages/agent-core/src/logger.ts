import pino, { type Logger as PinoLogger } from "pino";
import pretty from "pino-pretty";

export type LoggerRuntimeMode = "repl" | "service";

const env = process.env.QUILIN_ENV ?? "dev";

function createLogger(runtimeMode: LoggerRuntimeMode): PinoLogger {
	const baseOptions = {
		name: "agent-core",
		level: process.env.LOG_LEVEL ?? (env === "prod" ? "info" : "debug"),
		formatters: {
			bindings: () => ({ service: "agent-core", env }),
		},
		timestamp: pino.stdTimeFunctions.isoTime,
	};

	if (runtimeMode === "repl") {
		return pino(
			baseOptions,
			pretty({
				colorize: true,
				destination: process.stderr,
				sync: true,
			}),
		);
	}

	if (env === "dev") {
		return pino({
			...baseOptions,
			transport: {
				targets: [
					{ target: "pino-pretty", options: { destination: 2 } },
					{ target: "pino/file", options: { destination: 1 } },
				],
			},
		});
	}

	return pino(baseOptions);
}

function resolveInitialRuntimeMode(): LoggerRuntimeMode {
	return process.env.QUILIN_RUNTIME_MODE === "repl" ? "repl" : "service";
}

let currentRuntimeMode = resolveInitialRuntimeMode();
let currentLogger: PinoLogger | undefined;

function getLogger(): PinoLogger {
	if (!currentLogger) {
		currentLogger = createLogger(currentRuntimeMode);
	}

	return currentLogger;
}

export function configureLogger(runtimeMode: LoggerRuntimeMode): void {
	currentRuntimeMode = runtimeMode;
	currentLogger = createLogger(runtimeMode);
}

export function getLoggerRuntimeMode(): LoggerRuntimeMode {
	return currentRuntimeMode;
}

export const logger = new Proxy({} as PinoLogger, {
	get(_target, property, receiver) {
		const value = Reflect.get(getLogger(), property, receiver);
		return typeof value === "function" ? value.bind(getLogger()) : value;
	},
});
