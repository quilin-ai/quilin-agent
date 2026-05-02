import { stderr, stdin } from "node:process";
import * as readline from "node:readline/promises";
import {
	isRuntimeToolEnabled,
	type RuntimeToolFilter,
} from "./config/runtime.js";
import { createDefaultPromptSections } from "./context/default-sections.js";
import { BasicContextManager } from "./context/manager.js";
import { PromptBuilder } from "./context/prompt-builder.js";
import { PromptSessionAssembler } from "./context/prompt-session-assembler.js";
import {
	createHotSkillsSection,
	createPostCompactSkillsSection,
	createSkillsCatalogSection,
} from "./context/skills-catalog-section.js";
import { createTemporalBucketSection } from "./context/temporal.js";
import {
	normalizeProviderError,
	ProviderControlPlaneLLMClient,
	StreamingLLMClient,
} from "./llm/client.js";
import { type createProvider, decideLLMRoute } from "./llm/provider.js";
import type {
	InferenceConfig,
	LLMProviderId,
	LLMStreamEvent,
	LLMTierRoutingConfig,
	ProviderRunRecord,
} from "./llm/types.js";
import { logger } from "./logger.js";
import { runAgentLoop } from "./loop.js";
import {
	type AgentRunLogSink,
	createToolProvenanceEntry,
	JsonlAgentRunLogger,
	recordAgentRunEvent,
	summarizeProviderRunRecord,
	type ToolProvenanceEntry,
} from "./observability/agent-run-log.js";
import type { SpanExporter } from "./observability/exporters/composite.js";
import type { AgentLoopObservability } from "./observability/loop.js";
import {
	type AuthorityMode,
	WriteAuthority,
} from "./safety/write-authority.js";
import type { SkillsCatalogChange, SkillsManager } from "./skills/manager.js";
import { SQLiteCheckpoint } from "./state/checkpoint.js";
import type { AgentState, Message } from "./state/types.js";
import { createBuiltinTools } from "./tools/builtin/index.js";
import { MCPRegistry, type MCPServerEntry } from "./tools/registry.js";
import type { SandboxApprovalRequest } from "./tools/router.js";
import type { ToolWithMetadata } from "./tools/tool-metadata.js";
import type { Tool } from "./tools/types.js";

const DEFAULT_INFERENCE_CONFIG: InferenceConfig = {
	temperature: 0.7,
	maxTokens: 4096,
	thinkingMode: "disabled",
};

interface ReplOptions {
	provider: ReturnType<typeof createProvider>;
	providerId?: LLMProviderId;
	modelId: string;
	sessionId?: string;
	observability?: AgentLoopObservability;
	spanExporter?: SpanExporter;
	tools?: readonly Tool[];
	mcpServers?: readonly MCPServerEntry[];
	skillsManager?: SkillsManager;
	inferenceConfig?: InferenceConfig;
	tierRouting?: LLMTierRoutingConfig;
	writeAuthorityMode?: AuthorityMode;
	toolFilter?: RuntimeToolFilter;
	agentRunLogger?: AgentRunLogSink;
	onProviderRunRecord?: (record: ProviderRunRecord) => void;
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

function createDefaultAgentRunLogger(
	sessionId: string,
): AgentRunLogSink | undefined {
	const explicit = process.env.QUILIN_AGENT_RUN_LOG?.toLowerCase();
	if (explicit === "off" || explicit === "false" || explicit === "0") {
		return undefined;
	}
	if (process.env.NODE_ENV === "test" && explicit == null) {
		return undefined;
	}
	const env = process.env.QUILIN_ENV ?? "dev";
	if (explicit == null && env === "prod") {
		return undefined;
	}
	return new JsonlAgentRunLogger({ sessionId });
}

function createPromptSessionAssembler(
	modelId: string,
	registry: MCPRegistry,
	sessionStartedAt: string,
	lastSessionEndTime?: string,
	skillsManager?: SkillsManager,
	toolFilter?: RuntimeToolFilter,
	getToolProvenance?: () => readonly ToolProvenanceEntry[],
): PromptSessionAssembler {
	const promptBuilder = new PromptBuilder();
	for (const section of createDefaultPromptSections()) {
		promptBuilder.register(section);
	}
	if (skillsManager != null) {
		promptBuilder.register(createSkillsCatalogSection(skillsManager));
		promptBuilder.register(createHotSkillsSection(skillsManager));
		promptBuilder.register(createPostCompactSkillsSection(skillsManager));
	}
	promptBuilder.register(createTemporalBucketSection());

	const assembler = new PromptSessionAssembler({
		promptBuilder,
		modelId,
		sessionStartedAt,
		lastSessionEndedAt: lastSessionEndTime,
		now: () => new Date(),
		getAvailableTools: () =>
			filterToolsByRuntimeConfig(registry.getAllTools(), toolFilter)
				.map((tool) => tool.name)
				.filter((name): name is string => name != null),
		getAvailableToolDescriptors: () =>
			filterToolsByRuntimeConfig(registry.getToolDescriptors(), toolFilter),
		getSessionState: () => ({
			skills: {
				recentSkillNames: skillsManager?.getRecentSkillNames() ?? [],
			},
			toolProvenance: {
				recent: getToolProvenance?.().slice(-12) ?? [],
			},
		}),
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

function formatReplList(values: readonly string[]): string {
	return values.length === 0 ? "none" : values.join(",");
}

function createSandboxApprovalPrompt(request: SandboxApprovalRequest): string {
	const { summary } = request;
	return `[Sandbox] ${summary.tool}: ${summary.summary}\nReasons: ${formatReplList(summary.reasonCodes)} | Required: ${formatReplList(summary.requiredApprovals)}\nAllow once? [y/N]: `;
}

function filterToolsByRuntimeConfig<T extends { readonly name?: string }>(
	tools: readonly T[],
	filter: RuntimeToolFilter | undefined,
): T[] {
	if (filter == null) {
		return [...tools];
	}

	return tools.filter(
		(tool) => tool.name != null && isRuntimeToolEnabled(tool.name, filter),
	);
}

function providerErrorLogFields(error: unknown): Record<string, string> {
	const normalized = normalizeProviderError(error);

	return {
		name: normalized.name,
		...(normalized.code == null ? {} : { code: normalized.code }),
		...(normalized.category == null ? {} : { category: normalized.category }),
	};
}

async function flushObservabilitySpans(
	observability: AgentLoopObservability | undefined,
	exporter: SpanExporter | undefined,
): Promise<void> {
	const spans = observability?.spans;
	if (spans == null || exporter == null) {
		return;
	}

	const snapshots = spans.snapshot();
	if (snapshots.length === 0) {
		return;
	}

	try {
		if (exporter.exportSpans != null) {
			await exporter.exportSpans(snapshots);
		} else if (exporter.exportSpan != null) {
			await Promise.all(snapshots.map((span) => exporter.exportSpan?.(span)));
		} else {
			return;
		}
		spans.clear();
	} catch (err) {
		logger.error(
			{ error: providerErrorLogFields(err) },
			"REPL: span export failed",
		);
	}
}

type ReasoningDisplayMode = "collapsed" | "verbose";

interface ReplStreamRenderState {
	thinkingShown: boolean;
	toolInputs: Map<string, string>;
}

function createStreamRenderState(): ReplStreamRenderState {
	return {
		thinkingShown: false,
		toolInputs: new Map(),
	};
}

function stringifyJson(value: unknown): string {
	const serialized = JSON.stringify(value);
	return serialized ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}

function summarizeInlineText(text: string, maxLength = 120): string {
	const singleLine = text.replace(/\s+/gu, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}

	return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeToolOutput(output: unknown): string {
	if (isRecord(output)) {
		const result = output.result;
		if (typeof result === "string") {
			return summarizeInlineText(result);
		}

		const content = output.content;
		if (typeof content === "string") {
			return summarizeInlineText(content.split(/\r?\n/u, 1)[0] ?? content);
		}
	}

	const raw =
		typeof output === "string" ? output : stringifyJson(output ?? "undefined");
	return summarizeInlineText(raw.split(/\r?\n/u, 1)[0] ?? raw);
}

function renderStreamEvent(
	event: LLMStreamEvent,
	reasoningDisplay: ReasoningDisplayMode,
	renderState: ReplStreamRenderState,
): void {
	switch (event.type) {
		case "text":
			stderr.write(event.delta);
			break;
		case "reasoning":
			if (reasoningDisplay === "verbose") {
				stderr.write(event.delta);
				return;
			}

			if (!renderState.thinkingShown) {
				renderState.thinkingShown = true;
				stderr.write("💭 [thinking...]\n");
			}
			break;
		case "tool-call-start":
			renderState.toolInputs.set(event.toolCallId, "");
			break;
		case "tool-call-args-delta":
			renderState.toolInputs.set(
				event.toolCallId,
				`${renderState.toolInputs.get(event.toolCallId) ?? ""}${event.delta}`,
			);
			break;
		case "tool-call-end": {
			const inputText =
				event.inputText.length > 0
					? event.inputText
					: (renderState.toolInputs.get(event.toolCallId) ??
						(event.input == null ? "" : stringifyJson(event.input)));
			renderState.toolInputs.delete(event.toolCallId);
			stderr.write(
				`\n🔧 calling ${event.toolName}(${summarizeInlineText(inputText)})\n`,
			);
			break;
		}
		case "tool-result":
			stderr.write(
				`\n${event.isError === true ? "⚠️" : "✅"} ${event.toolName} → ${summarizeToolOutput(event.output)}\n`,
			);
			break;
	}
}

function getEffectiveModelId(
	providerId: LLMProviderId,
	baseModelId: string,
	thinkingMode: InferenceConfig["thinkingMode"],
): string {
	try {
		return decideLLMRoute({
			provider: providerId,
			model: baseModelId,
			thinkingMode,
		}).effectiveModel;
	} catch {
		return baseModelId;
	}
}

function renderSkillsCatalogHint(change: SkillsCatalogChange): string | null {
	if (
		change.added.length === 1 &&
		change.removed.length === 0 &&
		change.changed.length === 0
	) {
		return `📥 New skill discovered: ${change.added[0]}\n`;
	}

	if (
		change.removed.length === 1 &&
		change.added.length === 0 &&
		change.changed.length === 0
	) {
		return `🗑 Skill removed: ${change.removed[0]}\n`;
	}

	if (
		change.added.length === 0 &&
		change.removed.length === 0 &&
		change.changed.length === 0
	) {
		return null;
	}

	return "🎯 Skills catalog updated\n";
}

export async function startRepl(options: ReplOptions): Promise<void> {
	const {
		provider,
		providerId = "deepseek",
		modelId,
		sessionId,
		tools = [],
		mcpServers = [],
		skillsManager,
		inferenceConfig: initialInferenceConfig,
		tierRouting,
		writeAuthorityMode = "ask",
		toolFilter,
		agentRunLogger,
		onProviderRunRecord,
	} = options;
	const context = new BasicContextManager();
	if (skillsManager != null) {
		await skillsManager.discover();
		skillsManager.startWatching();
	}
	const registry = new MCPRegistry();
	const resolvedSessionId = sessionId ?? crypto.randomUUID();
	const checkpoint = new SQLiteCheckpoint({ sessionId: resolvedSessionId });
	const runLogger =
		agentRunLogger ?? createDefaultAgentRunLogger(resolvedSessionId);
	let rl: readline.Interface | undefined;
	const queuedCommands: string[] = [];
	const toolProvenance: ToolProvenanceEntry[] = [];
	let activeTurnId: string | undefined;
	const writeAuthority = new WriteAuthority({
		actor: resolvedSessionId,
		mode: writeAuthorityMode,
		confirm: async (request) => {
			if (rl == null) {
				return false;
			}

			while (true) {
				const answer = (
					await rl.question(
						`[WriteAuthority] ${request.tool} (${request.riskLevel.toUpperCase()}): ${request.summary}\nAllow? [y/N/always-low/always-medium]: `,
					)
				).trim();

				if (answer.startsWith("/")) {
					queuedCommands.push(answer);
					stderr.write(`Command queued for next turn: ${answer}\n`);
					continue;
				}

				const normalizedAnswer = answer.toLowerCase();

				if (normalizedAnswer === "always-low") {
					writeAuthority.setMode("auto-low");
					return true;
				}

				if (normalizedAnswer === "always-medium") {
					writeAuthority.setMode("auto-medium");
					return true;
				}

				return normalizedAnswer === "y" || normalizedAnswer === "yes";
			}
		},
	});
	const confirmSandboxApproval = async (
		request: SandboxApprovalRequest,
	): Promise<boolean> => {
		if (rl == null) {
			return false;
		}

		while (true) {
			const answer = (
				await rl.question(createSandboxApprovalPrompt(request))
			).trim();

			if (answer.startsWith("/")) {
				queuedCommands.push(answer);
				stderr.write(`Command queued for next turn: ${answer}\n`);
				continue;
			}

			const normalizedAnswer = answer.toLowerCase();
			return normalizedAnswer === "y" || normalizedAnswer === "yes";
		}
	};

	try {
		registry.registerBuiltin(
			filterToolsByRuntimeConfig(
				createBuiltinTools({ writeAuthority, skillsManager }),
				toolFilter,
			),
		);
		for (const entry of mcpServers) {
			await registry.register(entry);
		}
		if (tools.length > 0) {
			registry.registerBuiltin(
				filterToolsByRuntimeConfig(withDefaultMetadata(tools), toolFilter),
			);
		}

		const allTools = filterToolsByRuntimeConfig(
			registry.getAllTools(),
			toolFilter,
		);
		const restoredState =
			sessionId == null ? null : await checkpoint.load(resolvedSessionId);
		const restoredMessages =
			restoredState?.messages[0]?.role === "system"
				? restoredState.messages.slice(1)
				: (restoredState?.messages ?? []);

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
		await recordAgentRunEvent(runLogger, "repl.session_started", {
			sessionId: resolvedSessionId,
			restored: restoredState != null,
			messageCount: restoredMessages.length,
			modelId,
			providerId,
			hasTierRouting: tierRouting != null,
		});

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
		const baseModel = provider(modelId);
		const sessionAssembler = createPromptSessionAssembler(
			modelId,
			registry,
			state.createdAt,
			restoredState?.lastActiveAt,
			skillsManager,
			toolFilter,
			() => toolProvenance,
		);
		skillsManager?.onCatalogChange((change) => {
			const hint = renderSkillsCatalogHint(change);
			if (hint != null) {
				stderr.write(hint);
			}
		});
		let inferenceConfig: InferenceConfig = {
			...DEFAULT_INFERENCE_CONFIG,
			...initialInferenceConfig,
		};
		let reasoningDisplay: ReasoningDisplayMode = "collapsed";
		let streamRenderState = createStreamRenderState();
		const streamingLlm = new StreamingLLMClient(
			{
				model: baseModel,
				resolveModel: provider,
			},
			(event) => {
				renderStreamEvent(event, reasoningDisplay, streamRenderState);
			},
		);
		let lastProviderRunRecord: ProviderRunRecord | undefined;
		const recordProviderRun = (record: ProviderRunRecord): void => {
			lastProviderRunRecord = record;
			onProviderRunRecord?.(record);
			void recordAgentRunEvent(
				runLogger,
				"llm.provider_run",
				summarizeProviderRunRecord(record),
				{ turnId: activeTurnId },
			);
		};
		const llm = new ProviderControlPlaneLLMClient(streamingLlm, {
			routeRequest: {
				provider: providerId,
				model: modelId,
			},
			...(tierRouting == null ? {} : { tierRouting }),
			onRunRecord: recordProviderRun,
		});

		while (true) {
			const input = queuedCommands.shift() ?? (await rl.question("quilin> "));
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
				streamRenderState = createStreamRenderState();
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

			if (trimmed === "/status") {
				const effectiveModel = getEffectiveModelId(
					providerId,
					modelId,
					inferenceConfig.thinkingMode,
				);
				stderr.write(
					tierRouting == null
						? `Status: model=${modelId} | effective=${effectiveModel} | thinking=${inferenceConfig.thinkingMode} | routing=fixed | reasoning=${reasoningDisplay}\n`
						: `Status: base_model=${modelId} | base_effective=${effectiveModel} | base_thinking=${inferenceConfig.thinkingMode} | routing=${tierRouting.mode} | reasoning=${reasoningDisplay}\n`,
				);
				if (tierRouting != null) {
					stderr.write(
						`Tiers: flash=${tierRouting.tiers.flash.provider}/${tierRouting.tiers.flash.model} thinking=${tierRouting.tiers.flash.thinkingMode} | lite=${tierRouting.tiers.lite.provider}/${tierRouting.tiers.lite.model} thinking=${tierRouting.tiers.lite.thinkingMode} | pro=${tierRouting.tiers.pro.provider}/${tierRouting.tiers.pro.model} thinking=${tierRouting.tiers.pro.thinkingMode}\n`,
					);
					if (lastProviderRunRecord != null) {
						const route = lastProviderRunRecord.route;
						stderr.write(
							`Last route: tier=${route.selectedTier ?? "none"} | provider=${route.provider} | configured=${route.configuredModel} | effective=${route.effectiveModel} | thinking=${route.thinkingMode ?? inferenceConfig.thinkingMode} | reason=${route.routeReason ?? "n/a"}\n`,
						);
					}
				}
				continue;
			}

			if (trimmed.startsWith("/think")) {
				const mode = trimmed.split(/\s+/u)[1];
				switch (mode) {
					case "on":
						inferenceConfig = {
							...inferenceConfig,
							thinkingMode: "enabled",
						};
						stderr.write("Thinking mode: enabled.\n");
						break;
					case "off":
						inferenceConfig = {
							...inferenceConfig,
							thinkingMode: "disabled",
						};
						stderr.write("Thinking mode: disabled.\n");
						break;
					case "auto":
						inferenceConfig = {
							...inferenceConfig,
							thinkingMode: "auto",
						};
						stderr.write("Thinking mode: auto.\n");
						break;
					default:
						stderr.write("Usage: /think on|off|auto\n");
						break;
				}
				continue;
			}

			if (trimmed === "/verbose") {
				reasoningDisplay = "verbose";
				stderr.write("Reasoning display: verbose.\n");
				continue;
			}

			if (trimmed === "/collapse") {
				reasoningDisplay = "collapsed";
				stderr.write("Reasoning display: collapsed.\n");
				continue;
			}

			const previousLastActiveAt = state.lastActiveAt;
			const currentTurnId = crypto.randomUUID();
			activeTurnId = currentTurnId;
			await recordAgentRunEvent(
				runLogger,
				"turn.input_received",
				{
					input: trimmed,
					inputChars: trimmed.length,
					historyMessageCount: messages.length,
					stateTurnCount: state.turnCount,
				},
				{ turnId: currentTurnId },
			);
			messages.push({ role: "user", content: trimmed });
			state = createState([...messages], {
				...state,
				messages: [...messages],
				lastActiveAt: new Date().toISOString(),
			});
			stderr.write("\n");

			try {
				streamRenderState = createStreamRenderState();
				let latestAssistantMessage: Message | undefined;
				let latestLoopMessages: readonly Message[] | undefined;
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
						toolRouterOptions: {
							sandboxOrigin: "agent",
							sandboxApproval: confirmSandboxApproval,
						},
						inferenceConfig,
						observability: {
							...options.observability,
							runLogger: runLogger ?? options.observability?.runLogger,
							turnId: currentTurnId,
							llmProviderId: providerId,
						},
						hooks: {
							onAssistantMessage: (message) => {
								latestAssistantMessage = message;
							},
							onMessagesUpdated: (loopMessages) => {
								latestLoopMessages = [...loopMessages];
							},
							onToolResult: async (event) => {
								const provenance = createToolProvenanceEntry({
									toolCall: event.toolCall,
									toolResult: event.toolResult,
									sanitizedContent: event.sanitizedContent,
									at: new Date().toISOString(),
								});
								if (provenance == null) {
									return;
								}
								toolProvenance.push(provenance);
								if (toolProvenance.length > 50) {
									toolProvenance.splice(0, toolProvenance.length - 50);
								}
								await recordAgentRunEvent(
									runLogger,
									"tool.provenance_recorded",
									{ provenance },
									{ turnId: currentTurnId },
								);
							},
						},
					},
					messages,
				);

				if (latestLoopMessages == null) {
					messages.push(
						latestAssistantMessage ?? { role: "assistant", content: response },
					);
				} else {
					messages.splice(0, messages.length, ...latestLoopMessages);
				}
				state = createState([...messages], {
					...state,
					messages: [...messages],
					turnCount: state.turnCount + 1,
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
				stderr.write("\n\n");
			} catch (err) {
				logger.error(
					{ error: providerErrorLogFields(err) },
					"REPL: LLM call failed",
				);
				streamRenderState = createStreamRenderState();
				stderr.write("\n[Error: LLM call failed. Check logs for details.]\n\n");
				messages.pop();
				state = createState([...messages], {
					...state,
					messages: [...messages],
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
			} finally {
				await flushObservabilitySpans(
					options.observability,
					options.spanExporter,
				);
				activeTurnId = undefined;
			}
		}
	} finally {
		rl?.close();
		skillsManager?.stopWatching();
		await registry.disconnectAll();
	}
}
