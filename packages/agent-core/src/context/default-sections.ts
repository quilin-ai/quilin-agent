import type { BuildContext, PromptSection } from "./prompt-types.js";

function describeTools(availableTools: readonly string[]): string {
	if (availableTools.length === 0) {
		return "No tools are currently available.";
	}

	return `Available tools: ${availableTools.join(", ")}`;
}

const CATEGORY_ORDER = [
	"programmatic",
	"interactive",
	"control",
	"gui",
] as const;

const CATEGORY_TITLES = {
	programmatic: "Programmatic Tools",
	interactive: "Interactive Tools",
	control: "Control Tools",
	gui: "GUI Tools",
} as const;

function describeToolDescriptors(ctx: BuildContext): string {
	if (
		ctx.availableToolDescriptors == null ||
		ctx.availableToolDescriptors.length === 0
	) {
		return describeTools(ctx.availableTools);
	}
	const descriptors = ctx.availableToolDescriptors;

	const sections = CATEGORY_ORDER.flatMap((category) => {
		const matchingTools = descriptors
			.filter((tool) => tool.category === category)
			.sort((left, right) => left.name.localeCompare(right.name));

		if (matchingTools.length === 0) {
			return [];
		}

		return [
			`## ${CATEGORY_TITLES[category]}`,
			...matchingTools.map(
				(tool) => `- ${tool.name} (${tool.riskLevel}): ${tool.description}`,
			),
		];
	});

	return sections.join("\n");
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
		updateFrequency: "per_session",
		compute: (ctx: BuildContext) =>
			[
				"Memory guidelines:",
				"- STORE: When the user shares identity details, preferences, or long-lived facts, call memory_store immediately. Examples: name, role, language preferences, project context.",
				'- RECALL: At the start of a new conversation or when the user greets you, call memory_recall with a broad query like "用户" or "user" to check if you know this person.',
				"- RECALL: When the user asks what you remember, or references past context, call memory_recall with relevant keywords before answering.",
				'- Recall queries can be short Chinese phrases (e.g. "名字", "偏好") — the search supports fuzzy matching.',
				describeToolDescriptors(ctx),
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
