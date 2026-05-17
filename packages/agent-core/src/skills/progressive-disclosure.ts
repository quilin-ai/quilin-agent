/**
 * 渐进式披露 / Progressive Disclosure
 *
 * Selectively exposes relevant chunks of a SKILL.md body based on the user's
 * current intent/query, instead of dumping the entire body into the model
 * context. Splits the body into markdown sections (H2/H3 headers) and ranks
 * them by simple keyword overlap with the query, then returns the top-K
 * relevant sections plus a table of contents and a hint telling the model
 * how to request additional sections.
 *
 * 根据用户当前的意图/查询，从 SKILL.md 正文中按需暴露相关 chunk，而不是把
 * 整个正文一次性放进模型上下文。把正文按 markdown 的 H2/H3 标题拆成 section，
 * 用关键词重叠度对每个 section 与查询打分，然后返回 top-K 最相关的 section、
 * 一个目录、以及一段提示告诉模型如何请求更多 section。
 *
 * 不依赖任何外部 embedding API；关键词匹配在 200~800 行的 markdown 上已经
 * 足够准确（H2/H3 标题本身就是高信号的关键词来源）。
 */

import type { LoadedSkill } from "./types.js";

/**
 * 单个 section / A single section
 */
export interface SkillSection {
	readonly heading: string;
	readonly level: 1 | 2 | 3 | 4 | 5 | 6;
	readonly content: string;
	readonly lineStart: number;
	readonly lineEnd: number;
}

/**
 * 段落分数 / Section score
 */
export interface ScoredSection {
	readonly section: SkillSection;
	readonly score: number;
	readonly matchedTerms: readonly string[];
}

/**
 * 渐进披露输入 / Progressive disclosure input
 */
export interface ProgressiveDisclosureInput {
	readonly skill: LoadedSkill;
	readonly query: string;
	readonly maxSections?: number;
	readonly preludeChars?: number;
	readonly minScore?: number;
}

/**
 * 渐进披露输出 / Progressive disclosure output
 */
export interface ProgressiveDisclosureResult {
	readonly skillName: string;
	readonly prelude: string;
	readonly toc: readonly TocEntry[];
	readonly selected: readonly ScoredSection[];
	readonly omittedHeadings: readonly string[];
	readonly hint: string;
	readonly totalSections: number;
}

export interface TocEntry {
	readonly heading: string;
	readonly level: number;
}

export const DEFAULT_MAX_SECTIONS = 3;
export const DEFAULT_PRELUDE_CHARS = 400;
export const DEFAULT_MIN_SCORE = 0;

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const TOKEN_PATTERN = /[^a-zA-Z0-9一-鿿]+/u;
const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"of",
	"to",
	"in",
	"for",
	"on",
	"is",
	"are",
	"was",
	"were",
	"be",
	"this",
	"that",
	"with",
	"as",
	"by",
	"at",
	"it",
	"do",
	"how",
	"what",
	"when",
	"where",
	"why",
	"which",
	"who",
	"can",
	"how",
]);

/**
 * 把 markdown 拆成 section / Split markdown body into sections
 *
 * Sections are delimited by H1-H6 headings. The prelude (text before the
 * first heading) is returned as a synthetic section with heading "" and
 * level 1 if it contains any non-whitespace text.
 *
 * 用 H1-H6 标题切分 section。第一个标题之前的内容作为合成 prelude section
 * 返回（heading 为空字符串，level 为 1），仅当其包含非空白文本时。
 */
export function splitIntoSections(body: string): readonly SkillSection[] {
	if (body.length === 0) {
		return [];
	}

	const lines = body.split(/\r?\n/);
	const sections: SkillSection[] = [];

	let currentHeading = "";
	let currentLevel: SkillSection["level"] = 1;
	let currentStart = 0;
	let currentContent: string[] = [];

	const flush = (endLine: number): void => {
		const trimmed = currentContent.join("\n").trim();
		if (currentHeading === "" && trimmed.length === 0) {
			return;
		}
		sections.push({
			heading: currentHeading,
			level: currentLevel,
			content: currentContent.join("\n"),
			lineStart: currentStart,
			lineEnd: endLine,
		});
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const headingMatch = HEADING_PATTERN.exec(line);
		if (headingMatch != null) {
			flush(index - 1);
			const rawLevel = (headingMatch[1] ?? "").length;
			currentLevel = clampLevel(rawLevel);
			currentHeading = (headingMatch[2] ?? "").trim();
			currentStart = index;
			currentContent = [];
		} else {
			currentContent.push(line);
		}
	}

	flush(lines.length - 1);

	// 没有 heading 时，flush 已经把整篇当作一个匿名 section 推入，
	// 因此不需要再走特殊的 "fallback to anonymous section" 分支。
	return sections;
}

/**
 * 按 query 打分 / Score sections by query
 *
 * Uses a simple keyword-overlap metric: count the number of distinct query
 * terms that appear in the section's heading or content, with heading
 * matches weighted 3x. Returns a normalized score in [0, 1].
 *
 * 用关键词重叠度打分：统计 query 中出现在 section 标题或内容中的去重词数，
 * 标题命中权重为 3x。返回归一化到 [0, 1] 的分数。
 */
export function scoreSection(
	section: SkillSection,
	queryTerms: readonly string[],
): ScoredSection {
	if (queryTerms.length === 0) {
		return { section, score: 0, matchedTerms: [] };
	}

	const headingTerms = new Set(tokenize(section.heading));
	const contentTerms = new Set(tokenize(section.content));

	const matched: string[] = [];
	let weightedHits = 0;
	const maxWeighted = queryTerms.length * 3;

	for (const term of queryTerms) {
		if (headingTerms.has(term)) {
			matched.push(term);
			weightedHits += 3;
			continue;
		}
		if (contentTerms.has(term)) {
			matched.push(term);
			weightedHits += 1;
		}
	}

	const score = maxWeighted === 0 ? 0 : weightedHits / maxWeighted;
	return { section, score, matchedTerms: matched };
}

/**
 * 把查询字符串拆成关键词 / Tokenize a query string into terms
 */
export function tokenizeQuery(query: string): readonly string[] {
	return Array.from(new Set(tokenize(query)));
}

function tokenize(text: string): readonly string[] {
	if (text.length === 0) {
		return [];
	}
	return text
		.toLowerCase()
		.split(TOKEN_PATTERN)
		.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function clampLevel(level: number): SkillSection["level"] {
	if (level <= 1) {
		return 1;
	}
	if (level >= 6) {
		return 6;
	}
	return level as SkillSection["level"];
}

/**
 * 渐进披露 skill / Apply progressive disclosure to a skill
 *
 * Returns:
 * - prelude: first N chars of the body before the first heading
 * - toc: table of contents (heading + level)
 * - selected: top-K scored sections matching the query
 * - omittedHeadings: list of headings that were not selected
 * - hint: instruction telling the LLM how to ask for more sections
 *
 * 返回内容：
 * - prelude：第一个标题之前的前 N 个字符
 * - toc：目录（标题 + 级别）
 * - selected：按 query 打分后 top-K 个 section
 * - omittedHeadings：未被选中的标题列表
 * - hint：提示 LLM 如何请求更多 section
 */
export function progressiveDisclose(
	input: ProgressiveDisclosureInput,
): ProgressiveDisclosureResult {
	const maxSections = input.maxSections ?? DEFAULT_MAX_SECTIONS;
	const preludeChars = input.preludeChars ?? DEFAULT_PRELUDE_CHARS;
	const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

	const allSections = splitIntoSections(input.skill.body);
	const totalSections = allSections.length;
	const queryTerms = tokenizeQuery(input.query);

	const scored = allSections
		.filter((section) => section.heading !== "")
		.map((section) => scoreSection(section, queryTerms));

	const ranked = [...scored]
		.filter((entry) => entry.score > minScore)
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			// Stable secondary order: original document order.
			return left.section.lineStart - right.section.lineStart;
		})
		.slice(0, Math.max(0, maxSections));

	const selectedHeadings = new Set(
		ranked.map((entry) => entry.section.heading),
	);
	const omittedHeadings = scored
		.filter((entry) => !selectedHeadings.has(entry.section.heading))
		.map((entry) => entry.section.heading);

	const toc: readonly TocEntry[] = allSections
		.filter((section) => section.heading !== "")
		.map((section) => ({ heading: section.heading, level: section.level }));

	const prelude = buildPrelude(allSections, preludeChars);

	const hint = buildHint(
		input.skill.descriptor.name,
		ranked.length,
		omittedHeadings.length,
		maxSections,
	);

	return {
		skillName: input.skill.descriptor.name,
		prelude,
		toc,
		selected: ranked,
		omittedHeadings,
		hint,
		totalSections,
	};
}

function buildPrelude(
	sections: readonly SkillSection[],
	preludeChars: number,
): string {
	if (preludeChars <= 0 || sections.length === 0) {
		return "";
	}
	const first = sections[0] as SkillSection;
	const source =
		first.heading === ""
			? first.content
			: `# ${first.heading}\n${first.content}`;
	const trimmed = source.trim();
	if (trimmed.length <= preludeChars) {
		return trimmed;
	}
	return `${trimmed.slice(0, preludeChars).trimEnd()}…`;
}

function buildHint(
	skillName: string,
	selectedCount: number,
	omittedCount: number,
	maxSections: number,
): string {
	if (selectedCount === 0) {
		if (omittedCount === 0) {
			return `(no sections matched the query for skill ${skillName})`;
		}
		return `(no sections matched the query for skill ${skillName}; call expand_section('${skillName}', '<heading>') to load any of the ${omittedCount} known sections)`;
	}
	if (omittedCount === 0) {
		return `Showing ${selectedCount} matched section(s) — entire skill body has been disclosed.`;
	}
	return `Showing top ${selectedCount} of ${selectedCount + omittedCount} sections (max ${maxSections}); call expand_section('${skillName}', '<heading>') to load any omitted section.`;
}

/**
 * 按标题展开指定 section / Expand a named section by heading
 *
 * 用于 LLM 在 hint 中看到目录后，主动请求某个具体 section 的完整内容。
 * 标题匹配大小写不敏感，并且容忍前后空白。
 *
 * Used when the LLM, after seeing the TOC in the hint, requests a specific
 * named section. Heading match is case-insensitive and trims surrounding
 * whitespace.
 */
export function expandSection(
	skill: LoadedSkill,
	heading: string,
): SkillSection | null {
	const target = heading.trim().toLowerCase();
	if (target.length === 0) {
		return null;
	}
	const sections = splitIntoSections(skill.body);
	for (const section of sections) {
		if (section.heading.trim().toLowerCase() === target) {
			return section;
		}
	}
	return null;
}
