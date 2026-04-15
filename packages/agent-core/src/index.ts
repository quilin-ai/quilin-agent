import "dotenv/config";
import { generateText } from "ai";
import { createProvider, getDefaultModel } from "./llm/provider.js";
import { logger } from "./logger.js";
import { startRepl } from "./repl.js";

export * from "./types/index.js";
export * from "./llm/client.js";
export * from "./llm/provider.js";
export * from "./context/manager.js";
export * from "./tools/router.js";
export * from "./tools/mcp-client.js";
export * from "./state/checkpoint.js";
export * from "./repl.js";

export async function main(): Promise<void> {
	logger.info({ version: "0.0.1" }, "Quilin Agent starting");

	const provider = createProvider();
	const modelId = getDefaultModel();

	logger.info(
		{ provider: "deepseek", model: modelId },
		"LLM provider initialized",
	);

	logger.info("Verifying LLM connection...");

	try {
		const { text, usage } = await generateText({
			model: provider(modelId),
			prompt: 'Reply with exactly: "Quilin Agent online." Nothing else.',
			maxTokens: 20,
		});

		logger.info(
			{
				response: text.trim(),
				inputTokens: usage.promptTokens,
				outputTokens: usage.completionTokens,
			},
			"LLM connection verified",
		);
	} catch (err) {
		logger.fatal({ err }, "LLM connection failed");
		process.exit(1);
	}

	logger.info("Starting CLI REPL...");
	await startRepl({ provider, modelId });
}

if (import.meta.main) {
	main().catch((err) => {
		logger.fatal({ err }, "Unexpected error");
		process.exit(1);
	});
}
