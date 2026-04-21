import type { SkillDescriptor, SkillTrustLevel } from "./types.js";

const MAX_DESCRIPTION_CHARS = 64;
const HOT_SKILLS_LIMIT = 10;
const NAME_RELEVANCE_WEIGHT = 0.7;
const DESCRIPTION_RELEVANCE_WEIGHT = 0.3;
const RECENCY_WEIGHT = 0.6;
const RELEVANCE_WEIGHT = 0.4;
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
	readonly userInput?: string;
	readonly recentSkillNames?: readonly string[];
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

function compareSkillNames(left: SkillDescriptor, right: SkillDescriptor): number {
	if (left.name < right.name) {
		return -1;
	}
	if (left.name > right.name) {
		return 1;
	}
	return 0;
}

function isStableSkill(descriptor: SkillDescriptor): boolean {
	return descriptor.source === "bundled" || descriptor.source === "user";
}

function normalizeForMatch(text: string): string {
	return text.trim().toLowerCase();
}

function extractKeywords(input: string): readonly string[] {
	return normalizeForMatch(input)
		.split(/[^a-z0-9\u4e00-\u9fff-]+/u)
		.filter((keyword) => keyword.length > 0);
}

function scoreKeywordHits(
	text: string,
	keywords: readonly string[],
): number {
	if (keywords.length === 0) {
		return 0;
	}

	const normalizedText = normalizeForMatch(text);
	const matches = keywords.filter((keyword) =>
		normalizedText.includes(keyword),
	).length;
	return matches / keywords.length;
}

function scoreRelevance(
	descriptor: SkillDescriptor,
	userInput: string | undefined,
): number {
	if (userInput == null || userInput.trim().length === 0) {
		return 0;
	}

	const keywords = extractKeywords(userInput);
	const nameScore = scoreKeywordHits(descriptor.name, keywords);
	const descriptionScore = scoreKeywordHits(descriptor.description, keywords);
	return (
		nameScore * NAME_RELEVANCE_WEIGHT +
		descriptionScore * DESCRIPTION_RELEVANCE_WEIGHT
	);
}

function scoreRecency(
	descriptor: SkillDescriptor,
	recentSkillNames: readonly string[] | undefined,
): number {
	if (recentSkillNames == null || recentSkillNames.length === 0) {
		return 0;
	}

	const index = recentSkillNames.indexOf(descriptor.name);
	if (index === -1) {
		return 0;
	}

	return (recentSkillNames.length - index) / recentSkillNames.length;
}

function filterActiveSkills(
	descriptors: readonly SkillDescriptor[],
	turnContext: SkillsCatalogTurnContext,
): readonly SkillDescriptor[] {
	return descriptors
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
}

function renderSkillList(
	tagName: "available_skills" | "hot_skills",
	descriptors: readonly SkillDescriptor[],
): string {
	if (descriptors.length === 0) {
		return `<${tagName} />`;
	}

	const lines = descriptors.map((descriptor) => {
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

	return `<${tagName}>\n${lines.join("\n")}\n</${tagName}>`;
}

export function renderSkillsCatalog(
	descriptors: readonly SkillDescriptor[],
	turnContext: SkillsCatalogTurnContext,
): string {
	const filteredDescriptors = filterActiveSkills(descriptors, turnContext)
		.filter((descriptor) => isStableSkill(descriptor))
		.sort(compareSkillNames);

	return renderSkillList("available_skills", filteredDescriptors);
}

export function renderHotSkillsCatalog(
	descriptors: readonly SkillDescriptor[],
	turnContext: SkillsCatalogTurnContext,
): string {
	const filteredDescriptors = filterActiveSkills(descriptors, turnContext).filter(
		(descriptor) => !isStableSkill(descriptor),
	);

	const rankedDescriptors = filteredDescriptors
		.map((descriptor) => ({
			descriptor,
			recencyScore: scoreRecency(descriptor, turnContext.recentSkillNames),
			relevanceScore: scoreRelevance(descriptor, turnContext.userInput),
		}))
		.sort((left, right) => {
			const leftScore =
				left.recencyScore * RECENCY_WEIGHT +
				left.relevanceScore * RELEVANCE_WEIGHT;
			const rightScore =
				right.recencyScore * RECENCY_WEIGHT +
				right.relevanceScore * RELEVANCE_WEIGHT;
			if (leftScore !== rightScore) {
				return rightScore - leftScore;
			}
			if (left.recencyScore !== right.recencyScore) {
				return right.recencyScore - left.recencyScore;
			}
			if (left.relevanceScore !== right.relevanceScore) {
				return right.relevanceScore - left.relevanceScore;
			}
			return compareSkillNames(left.descriptor, right.descriptor);
		})
		.slice(0, HOT_SKILLS_LIMIT)
		.map((entry) => entry.descriptor);

	return renderSkillList("hot_skills", rankedDescriptors);
}
