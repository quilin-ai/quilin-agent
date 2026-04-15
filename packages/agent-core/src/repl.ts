import { stderr, stdin } from "node:process";
import * as readline from "node:readline/promises";
import {
	BasicContextManager,
	createSystemContextSource,
	DEFAULT_CONTEXT_BUDGET,
} from "./context/manager.js";
import { StreamingLLMClient } from "./llm/client.js";
import type { createProvider } from "./llm/provider.js";
import type { InferenceConfig } from "./llm/types.js";
import { logger } from "./logger.js";
import { runAgentLoop } from "./loop.js";
import type { Message } from "./state/types.js";
import type { Tool } from "./tools/types.js";

const DEFAULT_SYSTEM_PROMPT_SOURCE = createSystemContextSource(
	`You are Quilin Agent (麒麟), a helpful AI assistant.
Be concise, accurate, and friendly. Answer in the same language as the user.`,
);

const DEFAULT_INFERENCE_CONFIG: InferenceConfig = {
	temperature: 0.7,
	maxTokens: 4096,
	thinkingMode: "disabled",
};

interface ReplOptions {
	provider: ReturnType<typeof createProvider>;
	modelId: string;
	tools?: readonly Tool[];
}

export async function startRepl(options: ReplOptions): Promise<void> {
	const { provider, modelId, tools = [] } = options;
	const context = new BasicContextManager();
	const systemPrompt = await context.buildContext(
		[DEFAULT_SYSTEM_PROMPT_SOURCE],
		DEFAULT_CONTEXT_BUDGET,
	);

	stderr.write("\n🐉 Quilin Agent v0.0.1 (DeepSeek)\n");
	stderr.write("Type your message, or /exit to quit.\n\n");

	const rl = readline.createInterface({ input: stdin, output: stderr });

	const messages: Message[] = [{ role: "system", content: systemPrompt }];

	const llm = new StreamingLLMClient(provider(modelId), (chunk) => {
		stderr.write(chunk);
	});

	while (true) {
		const input = await rl.question("quilin> ");
		const trimmed = input.trim();

		if (!trimmed) {
			continue;
		}

		if (trimmed === "/exit" || trimmed === "/quit") {
			stderr.write("\nBye! 🐉\n");
			rl.close();
			return;
		}

		if (trimmed === "/clear") {
			messages.length = 1;
			stderr.write("Conversation cleared.\n\n");
			continue;
		}

		messages.push({ role: "user", content: trimmed });
		stderr.write("\n");

		try {
			const response = await runAgentLoop(
				{
					llm,
					context,
					tools,
					inferenceConfig: DEFAULT_INFERENCE_CONFIG,
				},
				messages,
			);

			messages.push({ role: "assistant", content: response });
			stderr.write("\n\n");
		} catch (err) {
			logger.error({ err }, "REPL: LLM call failed");
			stderr.write("\n[Error: LLM call failed. Check logs for details.]\n\n");
			messages.pop();
		}
	}
}
