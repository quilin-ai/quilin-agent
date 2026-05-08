import type { LLMClient } from "../../llm/types.js";
import type { InferenceConfig } from "../../llm/types.js";
import type { Message } from "../../state/types.js";

type TurndownConstructor = typeof import("turndown");
type TurndownInstance = InstanceType<TurndownConstructor>;

let turndownPromise: Promise<TurndownInstance> | undefined;

export function resetTurndownCache(): void {
	turndownPromise = undefined;
}

async function defaultLoadTurndown(): Promise<TurndownInstance> {
	if (!turndownPromise) {
		turndownPromise = import("turndown").then((mod) => {
			const Turndown = (mod as unknown as { default: TurndownConstructor })
				.default;
			return new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
		});
	}
	return turndownPromise;
}

export type HtmlToMarkdown = (html: string) => Promise<string>;

export function createDefaultHtmlToMarkdown(): HtmlToMarkdown {
	return async (html) => {
		const turndown = await defaultLoadTurndown();
		return turndown.turndown(html);
	};
}

export interface ExtractWithLLMArgs {
	readonly llmClient: LLMClient;
	readonly inferenceConfig: InferenceConfig;
	readonly markdown: string;
	readonly prompt: string;
	readonly maxMarkdownLength?: number;
}

const DEFAULT_MAX_MARKDOWN_LENGTH = 100_000;

export function buildExtractionUserMessage(
	prompt: string,
	markdown: string,
	maxMarkdownLength: number,
): string {
	const truncated =
		markdown.length > maxMarkdownLength
			? `${markdown.slice(0, maxMarkdownLength)}\n\n[Content truncated due to length...]`
			: markdown;
	return [
		"You are extracting information from a web page that has been converted to markdown.",
		"Use only the markdown content provided below to answer the user's prompt.",
		"If the answer is not present, say so explicitly. Do not invent facts.",
		"",
		`User prompt: ${prompt}`,
		"",
		"--- Markdown content begins ---",
		truncated,
		"--- Markdown content ends ---",
	].join("\n");
}

export async function extractWithLLM(
	args: ExtractWithLLMArgs,
): Promise<string> {
	const userText = buildExtractionUserMessage(
		args.prompt,
		args.markdown,
		args.maxMarkdownLength ?? DEFAULT_MAX_MARKDOWN_LENGTH,
	);
	const message: Message = {
		role: "user",
		content: userText,
	};
	const response = await args.llmClient.chat(
		[message],
		[],
		args.inferenceConfig,
	);
	return response.content;
}
