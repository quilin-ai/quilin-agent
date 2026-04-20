import { stderr, stdin } from "node:process";
import * as readline from "node:readline/promises";
import { createDefaultPromptSections } from "./context/default-sections.js";
import { BasicContextManager } from "./context/manager.js";
import { PromptBuilder } from "./context/prompt-builder.js";
import { PromptSessionAssembler } from "./context/prompt-session-assembler.js";
import { createSkillsCatalogSection } from "./context/skills-catalog-section.js";
import { createTemporalBucketSection } from "./context/temporal.js";
import type { SkillsManager } from "./skills/manager.js";
import { StreamingLLMClient } from "./llm/client.js";
import type { createProvider } from "./llm/provider.js";
import type { InferenceConfig } from "./llm/types.js";
import { logger } from "./logger.js";
import { runAgentLoop } from "./loop.js";
import { WriteAuthority } from "./safety/write-authority.js";
import { SQLiteCheckpoint } from "./state/checkpoint.js";
import type { AgentState, Message } from "./state/types.js";
import { createBuiltinTools } from "./tools/builtin/index.js";
import { MCPRegistry, type MCPServerEntry } from "./tools/registry.js";
import type {
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
	skillsManager?: SkillsManager;
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

function createPromptSessionAssembler(
	modelId: string,
	registry: MCPRegistry,
	sessionStartedAt: string,
	lastSessionEndTime?: string,
	skillsManager?: SkillsManager,
): PromptSessionAssembler {
	const promptBuilder = new PromptBuilder();
	for (const section of createDefaultPromptSections()) {
		promptBuilder.register(section);
	}
	if (skillsManager != null) {
		promptBuilder.register(createSkillsCatalogSection(skillsManager));
	}
	promptBuilder.register(createTemporalBucketSection());

	const assembler = new PromptSessionAssembler({
		promptBuilder,
		modelId,
		sessionStartedAt,
		lastSessionEndedAt: lastSessionEndTime,
		now: () => new Date(),
		getAvailableTools: () =>
			registry
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name): name is string => name != null),
		getAvailableToolDescriptors: () => registry.getToolDescriptors(),
	});

	registry.onChange(() => {
		assembler.invalidateSessionPrefix("tool-registry-changed");
	});
	skillsManager?.onCatalogChange(() => {
		assembler.invalidateSessionPrefix("skills-catalog-changed");
	});

	return assembler;
}

function withDefaultMetadata(tools: readonly Tool[]): ToolWithMetadata[] {
	return tools.map((tool) => ({
		...tool,
		category: "programmatic",
		riskLevel: "read",
	}));
}

export async function startRepl(options: ReplOptions): Promise<void> {
	const {
		provider,
		modelId,
		sessionId,
		tools = [],
		mcpServers = [],
		skillsManager,
	} = options;
	const context = new BasicContextManager();
	if (skillsManager != null) {
		await skillsManager.discover();
	}
	const registry = new MCPRegistry();
	const resolvedSessionId = sessionId ?? crypto.randomUUID();
	const checkpoint = new SQLiteCheckpoint({ sessionId: resolvedSessionId });
	let rl: readline.Interface | undefined;
	const writeAuthority = new WriteAuthority({
		actor: resolvedSessionId,
		confirm: async (request) => {
			if (rl == null) {
				return false;
			}

			const answer = (
				await rl.question(
					`[WriteAuthority] ${request.tool} (${request.riskLevel.toUpperCase()}): ${request.summary}\nAllow? [y/N/always-low/always-medium]: `,
				)
			)
				.trim()
				.toLowerCase();

			if (answer === "always-low") {
				writeAuthority.setMode("auto-low");
				return true;
			}

			if (answer === "always-medium") {
				writeAuthority.setMode("auto-medium");
				return true;
			}

			return answer === "y" || answer === "yes";
		},
	});

	try {
		registry.registerBuiltin(createBuiltinTools({ writeAuthority }));
		for (const entry of mcpServers) {
			await registry.register(entry);
		}
			if (tools.length > 0) {
				registry.registerBuiltin(withDefaultMetadata(tools));
			}

			const allTools = registry.getAllTools();
			const restoredState =
				sessionId == null ? null : await checkpoint.load(resolvedSessionId);
			const restoredMessages =
				restoredState?.messages[0]?.role === "system"
					? restoredState.messages.slice(1)
					: restoredState?.messages ?? [];

			stderr.write("\n🐉 Quilin Agent v0.0.3 (DeepSeek)\n");
			stderr.write(
				`Session: ${resolvedSessionId} (${restoredState == null ? "new" : "restored"})\n`,
			);
			if (restoredState != null) {
				stderr.write(
					`Messages: ${restoredMessages.length} | Last active: ${restoredState.lastActiveAt}\n`,
				);
			}
			stderr.write("Type your message, or /exit to quit.\n\n");

			rl = readline.createInterface({ input: stdin, output: stderr });

			let state = restoredState;
			if (state == null) {
				state = createState([]);
			} else {
				state = createState(restoredMessages, {
					...state,
					messages: restoredMessages,
				});
			}
			const messages: Message[] = [...state.messages];
			const sessionAssembler = createPromptSessionAssembler(
				modelId,
				registry,
				state.createdAt,
				restoredState?.lastActiveAt,
				skillsManager,
			);

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
					messages.length = 0;
					sessionAssembler.resetSession();
					state = createState([...messages], {
						...state,
						messages: [...messages],
						isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
				stderr.write("Conversation cleared.\n\n");
				continue;
				}

				const previousLastActiveAt = state.lastActiveAt;
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
							sessionAssembler,
							checkpoint,
							state,
							modelId,
							lastMessageTime: previousLastActiveAt,
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
