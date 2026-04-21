import type { SkillDescriptor, SkillTrustLevel } from "./types.js";

const MAX_DESCRIPTION_CHARS = 64;
const TRUST_LEVEL_RANK: Record<SkillTrustLevel, number> = {
	"agent-created": 0,
	community: 1,
	trusted: 2,
	builtin: 3,
};

export interface SkillsCatalogTurnContext {
	readonly availableToolNames: readonly string[];
	readonly availableToolsets?: readonly string[];
	readonly minTrustLevel?: SkillTrustLevel;
	readonly platform?: NodeJS.Platform;
}

function truncateDescription(text: string): string {
	if (text.length <= MAX_DESCRIPTION_CHARS) {
		return text;
	}

	return `${text.slice(0, MAX_DESCRIPTION_CHARS)}…`;
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function covers(
	available: readonly string[],
	required: readonly string[] | undefined,
): boolean {
	if (required == null || required.length === 0) {
		return true;
	}

	const availableSet = new Set(available);
	return required.every((entry) => availableSet.has(entry));
}

function matchesPlatform(
	platforms: readonly string[] | undefined,
	platform: NodeJS.Platform,
): boolean {
	if (platforms == null || platforms.length === 0) {
		return true;
	}

	return platforms.includes(platform);
}

function meetsTrust(
	trust: SkillTrustLevel | undefined,
	minTrustLevel: SkillTrustLevel | undefined,
): boolean {
	if (minTrustLevel == null) {
		return true;
	}

	const effectiveTrust = trust ?? "community";
	return TRUST_LEVEL_RANK[effectiveTrust] >= TRUST_LEVEL_RANK[minTrustLevel];
}

function normalizeMandatory(descriptor: SkillDescriptor): SkillDescriptor {
	if (
		descriptor.frontmatter.mandatory !== true ||
		descriptor.source === "bundled" ||
		descriptor.source === "user"
	) {
		return descriptor;
	}

	return {
		...descriptor,
		frontmatter: {
			...descriptor.frontmatter,
			mandatory: false,
		},
	};
}

export function renderSkillsCatalog(
	descriptors: readonly SkillDescriptor[],
	turnContext: SkillsCatalogTurnContext,
): string {
	const filteredDescriptors = descriptors
		.filter((descriptor) =>
			covers(turnContext.availableToolNames, descriptor.frontmatter.requiresTools),
		)
		.filter((descriptor) =>
			covers(
				turnContext.availableToolsets ?? [],
				descriptor.frontmatter.requiresToolsets,
			),
		)
		.filter((descriptor) =>
			matchesPlatform(
				descriptor.frontmatter.platforms,
				turnContext.platform ?? process.platform,
			),
		)
		.filter((descriptor) =>
			meetsTrust(descriptor.frontmatter.trust, turnContext.minTrustLevel),
		)
		.map((descriptor) => normalizeMandatory(descriptor));

	if (filteredDescriptors.length === 0) {
		return "<available_skills />";
	}

	const lines = filteredDescriptors.map((descriptor) => {
		const attrs: string[] = [
			`name="${xmlEscape(descriptor.name)}"`,
			`source="${descriptor.source}"`,
		];

		const whenToUse = descriptor.frontmatter.whenToUse;
		if (whenToUse != null && whenToUse.length > 0) {
			attrs.push(`when_to_use="${xmlEscape(whenToUse)}"`);
		}

		const allowedTools = descriptor.frontmatter.allowedTools;
		if (allowedTools != null && allowedTools.length > 0) {
			attrs.push(`allowed_tools="${xmlEscape(allowedTools.join(","))}"`);
		}
		if (descriptor.frontmatter.mandatory) {
			attrs.push('mandatory="true"');
		}

		const body = xmlEscape(truncateDescription(descriptor.description));
		return `  <skill ${attrs.join(" ")}>${body}</skill>`;
	});

	return `<available_skills>\n${lines.join("\n")}\n</available_skills>`;
}
