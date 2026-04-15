import { stderr, stdin } from "node:process";
import * as readline from "node:readline/promises";
import { createDefaultPromptSections } from "./context/default-sections.js";
import {
	BasicContextManager,
	createSystemContextSource,
	DEFAULT_CONTEXT_BUDGET,
} from "./context/manager.js";
import { PromptBuilder } from "./context/prompt-builder.js";
import { createTemporalSection } from "./context/temporal.js";
import { StreamingLLMClient } from "./llm/client.js";
import type { createProvider } from "./llm/provider.js";
import type { InferenceConfig } from "./llm/types.js";
import { logger } from "./logger.js";
import { runAgentLoop } from "./loop.js";
import { SQLiteCheckpoint } from "./state/checkpoint.js";
import type { AgentState, Message } from "./state/types.js";
import { createBuiltinTools } from "./tools/builtin/index.js";
import { MCPRegistry, type MCPServerEntry } from "./tools/registry.js";
import type {
	ToolPromptDescriptor,
	ToolWithMetadata,
} from "./tools/tool-metadata.js";
import type { Tool } from "./tools/types.js";

const DEFAULT_INFERENCE_CONFIG: InferenceConfig = {
	temperature: 0.7,
	maxTokens: 4096,
	thinkingMode: "disabled",
};

interface ReplOptions {
	provider: ReturnType<typeof createProvider>;
	modelId: string;
	sessionId?: string;
	tools?: readonly Tool[];
	mcpServers?: readonly MCPServerEntry[];
}

function createState(
	messages: readonly Message[],
	overrides: Partial<AgentState> = {},
): AgentState {
	const now = new Date().toISOString();

	return {
		messages,
		isTerminal: false,
		turnCount: 0,
		createdAt: now,
		lastActiveAt: now,
		...overrides,
	};
}

function renderPromptText(prompt: {
	staticPrefix: string;
	dynamicSuffix: string;
}): string {
	return [prompt.staticPrefix, prompt.dynamicSuffix]
		.filter((part) => part.length > 0)
		.join("\n\n");
}

function buildDefaultSystemPrompt(
	tools: readonly Tool[],
	modelId: string,
	lastSessionEndTime?: string,
	descriptors?: readonly ToolPromptDescriptor[],
): string {
	const promptBuilder = new PromptBuilder();
	for (const section of createDefaultPromptSections()) {
		promptBuilder.register(section);
	}
	promptBuilder.register(
		createTemporalSection(() => ({
			currentTime: new Date(),
			lastMessageTime: null,
			sessionStartTime: new Date(),
			lastSessionEndTime:
				lastSessionEndTime == null ? null : new Date(lastSessionEndTime),
		})),
	);

	return renderPromptText(
		promptBuilder.build({
			userInput: "",
			sessionState: {},
			modelId,
			availableTools: tools
				.map((tool) => tool.name)
				.filter((name): name is string => name != null),
			availableToolDescriptors: descriptors,
			profile: "full",
		}),
	);
}

function withDefaultMetadata(tools: readonly Tool[]): ToolWithMetadata[] {
	return tools.map((tool) => ({
		...tool,
		category: "programmatic",
		riskLevel: "read",
	}));
}

export async function startRepl(options: ReplOptions): Promise<void> {
	const { provider, modelId, sessionId, tools = [], mcpServers = [] } = options;
	const context = new BasicContextManager();
	const registry = new MCPRegistry();
	const resolvedSessionId = sessionId ?? crypto.randomUUID();
	const checkpoint = new SQLiteCheckpoint({ sessionId: resolvedSessionId });
	let rl: readline.Interface | undefined;

	try {
		registry.registerBuiltin(createBuiltinTools());
		for (const entry of mcpServers) {
			await registry.register(entry);
		}
		if (tools.length > 0) {
			registry.registerBuiltin(withDefaultMetadata(tools));
		}

		const allTools = registry.getAllTools();
		const restoredState =
			sessionId == null ? null : await checkpoint.load(resolvedSessionId);
		const systemPrompt = await context.buildContext(
			[
				createSystemContextSource(
					buildDefaultSystemPrompt(
						allTools,
						modelId,
						restoredState?.lastActiveAt,
						registry.getToolDescriptors(),
					),
				),
			],
			DEFAULT_CONTEXT_BUDGET,
		);

		stderr.write("\n🐉 Quilin Agent v0.0.3 (DeepSeek)\n");
		stderr.write(
			`Session: ${resolvedSessionId} (${restoredState == null ? "new" : "restored"})\n`,
		);
		if (restoredState != null) {
			stderr.write(
				`Messages: ${restoredState.messages.length} | Last active: ${restoredState.lastActiveAt}\n`,
			);
		}
		stderr.write("Type your message, or /exit to quit.\n\n");

		rl = readline.createInterface({ input: stdin, output: stderr });

		let state =
			restoredState ?? createState([{ role: "system", content: systemPrompt }]);
		const messages: Message[] = [...state.messages];

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
				state = createState([...messages], {
					...state,
					isTerminal: true,
					lastActiveAt: new Date().toISOString(),
				});
				await checkpoint.save(state);
				stderr.write("\nBye! 🐉\n");
				break;
			}

			if (trimmed === "/clear") {
				messages.length = 1;
				state = createState([...messages], {
					...state,
					messages: [...messages],
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
				stderr.write("Conversation cleared.\n\n");
				continue;
			}

			messages.push({ role: "user", content: trimmed });
			state = createState([...messages], {
				...state,
				messages: [...messages],
				lastActiveAt: new Date().toISOString(),
			});
			stderr.write("\n");

			try {
				const response = await runAgentLoop(
					{
						llm,
						context,
						checkpoint,
						state,
						tools: allTools,
						inferenceConfig: DEFAULT_INFERENCE_CONFIG,
					},
					messages,
				);

				messages.push({ role: "assistant", content: response });
				state = createState([...messages], {
					...state,
					messages: [...messages],
					turnCount: state.turnCount + 1,
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
				stderr.write("\n\n");
			} catch (err) {
				logger.error({ err }, "REPL: LLM call failed");
				stderr.write("\n[Error: LLM call failed. Check logs for details.]\n\n");
				messages.pop();
				state = createState([...messages], {
					...state,
					messages: [...messages],
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
			}
		}
	} finally {
		rl?.close();
		await registry.disconnectAll();
	}
}
