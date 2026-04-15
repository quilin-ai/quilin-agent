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
import { SQLiteCheckpoint } from "./state/checkpoint.js";
import type { AgentState, Message } from "./state/types.js";
import type { Tool } from "./tools/types.js";

const DEFAULT_SYSTEM_PROMPT_SOURCE = createSystemContextSource(
	`You are Quilin Agent (麒麟), a helpful AI assistant.
Be concise, accurate, and friendly. Answer in the same language as the user.

Memory guidelines:
- STORE: When the user shares identity details, preferences, or long-lived facts, call memory_store immediately. Examples: name, role, language preferences, project context.
- RECALL: At the start of a new conversation or when the user greets you, call memory_recall with a broad query like "用户" or "user" to check if you know this person.
- RECALL: When the user asks what you remember, or references past context, call memory_recall with relevant keywords before answering.
- Recall queries can be short Chinese phrases (e.g. "名字", "偏好") — the search supports fuzzy matching.`,
);

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

export async function startRepl(options: ReplOptions): Promise<void> {
	const { provider, modelId, sessionId, tools = [] } = options;
	const context = new BasicContextManager();
	const resolvedSessionId = sessionId ?? crypto.randomUUID();
	const systemPrompt = await context.buildContext(
		[DEFAULT_SYSTEM_PROMPT_SOURCE],
		DEFAULT_CONTEXT_BUDGET,
	);
	const checkpoint = new SQLiteCheckpoint({ sessionId: resolvedSessionId });
	const restoredState =
		sessionId == null ? null : await checkpoint.load(resolvedSessionId);

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

	const rl = readline.createInterface({ input: stdin, output: stderr });

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
			rl.close();
			return;
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
					tools,
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
}
