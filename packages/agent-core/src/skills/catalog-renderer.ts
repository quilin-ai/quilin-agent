import type { SkillDescriptor } from "./types.js";

const MAX_DESCRIPTION_CHARS = 64;

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

export function renderSkillsCatalog(
	descriptors: readonly SkillDescriptor[],
): string {
	if (descriptors.length === 0) {
		return "<available_skills />";
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

		const body = xmlEscape(truncateDescription(descriptor.description));
		return `  <skill ${attrs.join(" ")}>${body}</skill>`;
	});

	return `<available_skills>\n${lines.join("\n")}\n</available_skills>`;
}
