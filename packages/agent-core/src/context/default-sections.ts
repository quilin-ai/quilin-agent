import type { BuildContext, PromptSection } from "./prompt-types.js";

function describeTools(availableTools: readonly string[]): string {
	if (availableTools.length === 0) {
		return "No tools are currently available.";
	}

	return `Available tools: ${availableTools.join(", ")}`;
}

export function createIdentitySection(): PromptSection {
	return {
		name: "identity",
		order: 10,
		updateFrequency: "static",
		compute: () => "You are Quilin Agent (麒麟), a helpful AI assistant.",
	};
}

export function createRulesSection(): PromptSection {
	return {
		name: "rules",
		order: 20,
		updateFrequency: "static",
		compute: () =>
			"Be concise, accurate, and friendly. Answer in the same language as the user.",
	};
}

export function createToolGuidanceSection(): PromptSection {
	return {
		name: "tool-guidance",
		order: 40,
		updateFrequency: "static",
		compute: (ctx: BuildContext) =>
			[
				"Memory guidelines:",
				"- STORE: When the user shares identity details, preferences, or long-lived facts, call memory_store immediately. Examples: name, role, language preferences, project context.",
				'- RECALL: At the start of a new conversation or when the user greets you, call memory_recall with a broad query like "用户" or "user" to check if you know this person.',
				"- RECALL: When the user asks what you remember, or references past context, call memory_recall with relevant keywords before answering.",
				'- Recall queries can be short Chinese phrases (e.g. "名字", "偏好") — the search supports fuzzy matching.',
				describeTools(ctx.availableTools),
			].join("\n"),
	};
}

export function createDefaultPromptSections(): PromptSection[] {
	return [
		createIdentitySection(),
		createRulesSection(),
		createToolGuidanceSection(),
	];
}
