import { readSoulConfig } from "../config/soul-profile.js";
import {
	applyStyleToPrompt,
	resolveStylePreset,
} from "./conversation-style.js";
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

function safeProvenanceUrl(value: string): string {
	try {
		const parsed = new URL(value);
		const safePath =
			parsed.pathname !== "" && parsed.pathname !== "/"
				? "/[path-redacted]"
				: parsed.pathname || "/";
		const query = parsed.search.length > 0 ? "?[redacted]" : "";
		const fragment = parsed.hash.length > 0 ? "#[redacted]" : "";
		return `${parsed.protocol}//${parsed.host}${safePath}${query}${fragment}`;
	} catch {
		return "[invalid-url:redacted]";
	}
}

function provenanceEvidenceLabel(record: Record<string, unknown>): string {
	const auditOutcome =
		typeof record.auditOutcome === "string" ? record.auditOutcome : "unknown";
	if (record.usableEvidence === true) {
		return "usable";
	}
	return `not_evidence:${auditOutcome}`;
}

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

function findResolvedToolName(
	ctx: BuildContext,
	shortName: "memory_store" | "memory_recall",
): string {
	const descriptorNames =
		ctx.availableToolDescriptors?.map((tool) => tool.name) ?? [];
	const descriptorExactName = descriptorNames.find(
		(name) => name === shortName,
	);
	if (descriptorExactName != null) {
		return descriptorExactName;
	}

	const descriptorNamespacedName = descriptorNames.find((name) =>
		name.endsWith(`/${shortName}`),
	);
	if (descriptorNamespacedName != null) {
		return descriptorNamespacedName;
	}

	const availableExactName = ctx.availableTools.find(
		(name) => name === shortName,
	);
	if (availableExactName != null) {
		return availableExactName;
	}

	const availableNamespacedName = ctx.availableTools.find((name) =>
		name.endsWith(`/${shortName}`),
	);
	return availableNamespacedName ?? `quilin-mem/${shortName}`;
}

function renderToolProvenance(ctx: BuildContext): string | null {
	const provenance = ctx.sessionState.toolProvenance;
	if (provenance == null || typeof provenance !== "object") {
		return null;
	}
	const recent = (provenance as { readonly recent?: unknown }).recent;
	if (!Array.isArray(recent) || recent.length === 0) {
		return null;
	}

	const lines = recent
		.slice(-12)
		.map((entry) => {
			if (entry == null || typeof entry !== "object") {
				return null;
			}
			const record = entry as Record<string, unknown>;
			const tool =
				typeof record.tool === "string" ? record.tool : "unknown_tool";
			const url =
				typeof record.url === "string"
					? safeProvenanceUrl(record.url)
					: undefined;
			const host = typeof record.host === "string" ? record.host : undefined;
			const status =
				typeof record.status === "number" ? ` status=${record.status}` : "";
			const at = typeof record.at === "string" ? ` at=${record.at}` : "";
			const evidence = provenanceEvidenceLabel(record);
			const resultReportedUrl =
				typeof record.resultReportedUrl === "string"
					? ` result_reported=${safeProvenanceUrl(record.resultReportedUrl)}`
					: "";
			const source = url ?? host ?? "non-url tool result";
			return `- ${tool}: ${source}${resultReportedUrl}${status}${at} [${evidence}]`;
		})
		.filter((line): line is string => line != null);

	if (lines.length === 0) {
		return null;
	}

	return [
		"Recent tool/source provenance from actual tool calls in this session:",
		...lines,
		"When the user asks which sites, tools, or sources were checked, cite only entries marked usable as factual sources. Use the transcript only for conversation context and for explaining attempted, failed, sanitized, or blocked checks; never treat not_evidence entries as factual sources. Do not say the information came only from training data if relevant usable tool provenance is listed here.",
	].join("\n");
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
		compute: (ctx: BuildContext) => {
			const memoryStoreName = findResolvedToolName(ctx, "memory_store");
			const memoryRecallName = findResolvedToolName(ctx, "memory_recall");
			return [
				"Memory guidelines:",
				`- STORE: When the user shares identity details, preferences, or long-lived facts, call ${memoryStoreName} immediately. Examples: name, role, language preferences, project context.`,
				'- ROLE BINDING: In a user message, first-person words ("I", "me", "my", "我", "我的") refer to the user; second-person words ("you", "your", "你", "你的") refer to Quilin Agent unless explicitly quoted or attributed to someone else.',
				'- IDENTITY: Never invert user and assistant identity facts. If the user says "你是小明，我是孟哥", store that the assistant is 小明 and the user should be addressed as 孟哥; do not store "用户叫小明".',
				'- SEMANTIC STORE: When storing semantic memory, include metadata.source and metadata.stability_reason, for example metadata={"source":"user_explicit","stability_reason":"direct user correction"}.',
				"- CONFLICTS: If recalled identity facts conflict with a direct user correction, treat the latest explicit correction as authoritative and avoid presenting stale alternatives as equally true.",
				`- RECALL: At the start of a new conversation or when the user greets you, call ${memoryRecallName} with a broad query like "用户" or "user" to check if you know this person.`,
				`- RECALL: When the user asks what you remember, or references past context, call ${memoryRecallName} with relevant keywords before answering.`,
				'- Recall queries can be short Chinese phrases (e.g. "名字", "偏好") — the search supports fuzzy matching.',
				describeToolDescriptors(ctx),
			].join("\n");
		},
	};
}

export function createToolProvenanceSection(): PromptSection {
	return {
		name: "tool-provenance",
		order: 35,
		updateFrequency: "per_turn",
		compute: renderToolProvenance,
	};
}

export function createDefaultPromptSections(): PromptSection[] {
	return [
		createIdentitySection(),
		createRulesSection(),
		createToolProvenanceSection(),
		createToolGuidanceSection(),
	];
}
