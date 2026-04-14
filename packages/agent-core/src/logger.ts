import pino from "pino";

const env = process.env.QUILIN_ENV ?? "dev";

export const logger = pino({
	name: "agent-core",
	level: process.env.LOG_LEVEL ?? (env === "prod" ? "info" : "debug"),
	formatters: {
		bindings: () => ({ service: "agent-core", env }),
	},
	timestamp: pino.stdTimeFunctions.isoTime,
	...(env === "dev"
		? {
				transport: {
					targets: [
						{ target: "pino-pretty", options: { destination: 2 } },
						{ target: "pino/file", options: { destination: 1 } },
					],
				},
			}
		: {}),
});
