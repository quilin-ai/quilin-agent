import type { Message } from "../state/types.js";
import type { PromptBuilder } from "./prompt-builder.js";
import type { AssembledPrompt, BuildContext } from "./prompt-types.js";
import {
	decoratePreciseTemporalUserInput,
	type TemporalContext,
} from "./temporal.js";

interface PromptSessionAssemblerOptions {
	readonly promptBuilder: PromptBuilder;
	readonly modelId: string;
	readonly sessionStartedAt: string;
	readonly lastSessionEndedAt?: string;
	readonly now?: () => Date;
	readonly getAvailableTools?: () => readonly string[];
	readonly getAvailableToolDescriptors?: () => BuildContext["availableToolDescriptors"];
	readonly getSessionState?: () => Record<string, unknown>;
}

interface BuildOutboundMessagesInput {
	readonly transcript: readonly Message[];
	readonly turnKind: "user-turn" | "tool-resume";
	readonly lastMessageTime?: string;
}

interface OutboundPromptRequest {
	readonly messages: readonly Message[];
	readonly prompt: AssembledPrompt;
	readonly temporal: TemporalContext;
}

function renderPromptText(prompt: AssembledPrompt): string {
	return [prompt.staticPrefix, prompt.dynamicSuffix]
		.filter((part) => part.length > 0)
		.join("\n\n");
}

export class PromptSessionAssembler {
	private readonly now: () => Date;
	private sessionStartedAt: string;

	constructor(private readonly options: PromptSessionAssemblerOptions) {
		this.now = options.now ?? (() => new Date());
		this.sessionStartedAt = options.sessionStartedAt;
	}

	invalidateSessionPrefix(_reason: string): void {
		this.options.promptBuilder.resetSession();
	}

	resetSession(): void {
		this.options.promptBuilder.resetSession();
		this.sessionStartedAt = this.now().toISOString();
	}

	buildOutboundPrompt(input: BuildOutboundMessagesInput): {
		readonly prompt: AssembledPrompt;
		readonly temporal: TemporalContext;
	} {
		const currentTime = this.now();
		const temporal: TemporalContext = {
			currentTime,
			lastMessageTime:
				input.lastMessageTime == null ? null : new Date(input.lastMessageTime),
			sessionStartTime: new Date(this.sessionStartedAt),
			lastSessionEndTime:
				this.options.lastSessionEndedAt == null
					? null
					: new Date(this.options.lastSessionEndedAt),
		};

		const latestMessage = input.transcript.at(-1);
		const externalSessionState = this.options.getSessionState?.() ?? {};
		const prompt = this.options.promptBuilder.build({
			userInput: latestMessage?.role === "user" ? latestMessage.content : "",
			sessionState: {
				...externalSessionState,
				temporal: {
					currentTime: temporal.currentTime.toISOString(),
					lastMessageTime: temporal.lastMessageTime?.toISOString(),
					sessionStartTime: temporal.sessionStartTime.toISOString(),
					lastSessionEndTime: temporal.lastSessionEndTime?.toISOString(),
				},
			},
			modelId: this.options.modelId,
			availableTools: this.options.getAvailableTools?.() ?? [],
			availableToolDescriptors: this.options.getAvailableToolDescriptors?.(),
			profile: "full",
		});

		return { prompt, temporal };
	}

	buildOutboundRequest(
		input: BuildOutboundMessagesInput,
	): OutboundPromptRequest {
		const rawTranscript =
			input.transcript[0]?.role === "system"
				? input.transcript.slice(1)
				: [...input.transcript];
		const { prompt, temporal } = this.buildOutboundPrompt({
			...input,
			transcript: rawTranscript,
		});

		const messages: Message[] = [
			{ role: "system", content: renderPromptText(prompt) },
		];

		for (const [index, message] of rawTranscript.entries()) {
			if (
				input.turnKind === "user-turn" &&
				index === rawTranscript.length - 1 &&
				message.role === "user"
			) {
				messages.push({
					...message,
					content: decoratePreciseTemporalUserInput(message.content, temporal),
				});
				continue;
			}

			messages.push({ ...message });
		}

		return { messages, prompt, temporal };
	}

	buildOutboundMessages(input: BuildOutboundMessagesInput): Message[] {
		return [...this.buildOutboundRequest(input).messages];
	}
}
