import type { Message } from "../state/types.js";
import type { Tool } from "../tools/types.js";
import type { InferenceConfig, LLMClient, LLMResponse } from "./types.js";

export class VercelLLMClient implements LLMClient {
	async chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
	): Promise<LLMResponse> {
		void messages;
		void tools;
		void config;
		throw new Error("Not implemented");
	}
}
