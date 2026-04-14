import { logger } from "./logger.js";

export * from "./types/index.js";
export * from "./llm/client.js";
export * from "./llm/provider.js";
export * from "./context/manager.js";
export * from "./tools/router.js";
export * from "./tools/mcp-client.js";
export * from "./state/checkpoint.js";

if (import.meta.main) {
	logger.info(
		{ port: process.env.QUILIN_PORT ?? "3000" },
		"agent-core placeholder started",
	);

	setInterval(() => {
		logger.debug("agent-core heartbeat");
	}, 60_000);
}
