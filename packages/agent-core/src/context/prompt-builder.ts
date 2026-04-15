import { normalizeSection } from "./cache-stability.js";
import type {
	AssembledPrompt,
	BuildContext,
	PromptProfile,
	PromptSection,
} from "./prompt-types.js";
import { estimateTokens } from "./tokens.js";

function truncateToTokens(content: string, maxTokens: number): string {
	if (maxTokens <= 0) {
		return "";
	}

	return content.slice(0, maxTokens * 4).trimEnd();
}

export class PromptBuilder {
	private readonly sections = new Map<string, PromptSection>();
	private readonly sessionCache = new Map<string, string>();

	register(section: PromptSection): void {
		this.sections.set(section.name, section);
	}

	unregister(name: string): void {
		this.sections.delete(name);
		this.sessionCache.delete(name);
	}

	resetSession(): void {
		this.sessionCache.clear();
	}

	build(ctx: BuildContext): AssembledPrompt {
		const sorted = [...this.sections.values()]
			.filter((section) => this.matchesProfile(section, ctx.profile))
			.sort((left, right) => left.order - right.order);

		const staticParts: string[] = [];
		const dynamicParts: string[] = [];
		const sectionTokens: Record<string, number> = {};

		for (const section of sorted) {
			let content: string | null;

			if (
				section.updateFrequency === "per_session" &&
				this.sessionCache.has(section.name)
			) {
				content = this.sessionCache.get(section.name) ?? null;
			} else {
				content = section.compute(ctx);
				if (content !== null) {
					content = normalizeSection(content);
					if (section.updateFrequency === "per_session") {
						this.sessionCache.set(section.name, content);
					}
				}
			}

			if (content === null) {
				continue;
			}

			const estimatedTokens = estimateTokens(content);
			const finalContent =
				section.maxTokens != null && estimatedTokens > section.maxTokens
					? truncateToTokens(content, section.maxTokens)
					: content;
			const finalTokens = estimateTokens(finalContent);

			sectionTokens[section.name] = finalTokens;

			const rendered = `<!-- ${section.name} -->\n${finalContent}`;
			if (section.updateFrequency === "per_turn") {
				dynamicParts.push(rendered);
				continue;
			}

			staticParts.push(rendered);
		}

		const staticPrefix = staticParts.join("\n\n");
		const dynamicSuffix = dynamicParts.join("\n\n");
		const totalTokens = Object.values(sectionTokens).reduce(
			(sum, tokenCount) => sum + tokenCount,
			0,
		);

		return {
			staticPrefix,
			dynamicSuffix,
			sectionTokens,
			totalTokens,
		};
	}

	private matchesProfile(
		section: PromptSection,
		profile: PromptProfile,
	): boolean {
		const profiles = section.profiles ?? ["full", "minimal"];
		return profiles.includes(profile);
	}
}
