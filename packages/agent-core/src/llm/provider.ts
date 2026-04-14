import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function createProvider() {
	const apiKey = process.env.DEEPSEEK_API_KEY;
	if (!apiKey) {
		throw new Error(
			"DEEPSEEK_API_KEY is required. Copy .env.example to .env and fill in your key.",
		);
	}

	return createOpenAICompatible({
		name: "deepseek",
		baseURL: "https://api.deepseek.com/v1",
		apiKey,
	});
}

export function getDefaultModel() {
	return process.env.QUILIN_DEFAULT_MODEL ?? "deepseek-chat";
}
