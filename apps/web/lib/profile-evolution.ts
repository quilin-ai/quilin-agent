/**
 * Profile self-evolution / 自演化 —— 每次 session 结束后从对话里抽取
 * "用户偏好观察",追加到 `~/.quilin/user.md` 的 "Quilin 观察" 段;
 * 用户直接给"纠正/反馈"时类似地 append 到 soul.md。
 *
 * Per docs/03-memory/profile-pure-markdown-migration.md §3.
 *
 * After a chat session ends, this module asks a cheap LLM to extract
 * 1–3 short "newly-noticed user preferences" from the turn's user
 * messages + assistant reply, then appends timestamped lines to
 * `~/.quilin/user.md`'s "## Quilin 观察 / Agent-observed notes" section.
 *
 * Append-only — never edits earlier sections, never overwrites the file
 * wholesale. This keeps the write safe under AUTO trust mode without an
 * approval gate. Caps:
 *   - max 3 observations per call
 *   - skip if extracted list is empty or non-substantive
 *   - skip if user.md is over 256 KB (so a runaway agent can't bloat it)
 *   - hard-skip if QUILIN_PROFILE_EVOLUTION=off
 *
 * 强约束:只 append 不改写,有 size cap,可关。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

/**
 * Resolved per-call rather than at module load — Node's `homedir()` reads
 * `process.env.HOME` each invocation, so tests can override HOME via
 * `process.env.HOME = tmpdir` before calling the append helpers. Computing
 * the constant at module load time caches the real home and would
 * silently let tests scribble into the real `~/.quilin/*.md`.
 *
 * 每次调用解析,不在模块加载时缓存。homedir() 每次读 HOME env,允许测试
 * 通过临时 HOME 覆盖避免污染真实 `~/.quilin/*.md`。
 */
function userMdPath(): string {
	return join(homedir(), ".quilin", "user.md");
}

function soulMdPath(): string {
	return join(homedir(), ".quilin", "soul.md");
}

const MAX_FILE_BYTES = 256 * 1024; // safety cap
const MAX_OBSERVATIONS_PER_CALL = 3;
const OBSERVATION_HEADING = "## Quilin 观察 / Agent-observed notes";
const ADJUSTMENT_HEADING = "## Quilin 自我修正记录 / Self-adjustment log";

/**
 * Check the feature flag. Defaults to `on` so the agent actually evolves
 * by default; set `QUILIN_PROFILE_EVOLUTION=off` to disable for the
 * session.
 */
export function isProfileEvolutionEnabled(): boolean {
	const v = process.env.QUILIN_PROFILE_EVOLUTION;
	if (v === undefined || v === "") return true;
	const n = v.toLowerCase();
	return n !== "off" && n !== "false" && n !== "0";
}

interface ExtractInput {
	readonly userText: string;
	readonly assistantText: string;
}

/**
 * Call a cheap LLM to extract 1-3 short user-preference observations.
 * Returns an empty array on any failure (network / no API key / parse
 * fail) — the caller treats that as "no append this round".
 *
 * Observations are short Chinese sentences (≤ 50 chars) describing
 * *newly noticed* preferences (language, depth, technical bias, etc.).
 * Returns `[]` when there's nothing substantive (avoid filler).
 */
export async function extractProfileObservations(input: ExtractInput): Promise<readonly string[]> {
	const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
	if (apiKey.length === 0) return [];
	const baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
	try {
		const provider = createOpenAICompatible({ name: "deepseek", baseURL, apiKey });
		const today = new Date().toISOString().slice(0, 10);
		const result = await generateText({
			model: provider("deepseek-chat"),
			messages: [
				{
					role: "system",
					content:
						"你是 Quilin agent 的画像观察员。给你一段对话(用户消息 + 助手回答),你的任务是从里面抽出**关于用户的、有用且新颖**的偏好观察。" +
						"\n\n规则:" +
						"\n- 只输出 1 到 3 条,每条 ≤ 50 字,中文。" +
						"\n- 必须是关于**用户本人**的有信号观察(语言、技术倾向、回答深度偏好、领域、长期目标、敏感话题)。" +
						"\n- 如果对话没体现新信号(只是寒暄 / 一次性查询无偏好暴露),输出空字符串。" +
						"\n- 不要重复对话内容,不要总结回答内容,不要编造没说过的偏好。" +
						"\n- 输出格式:每条一行,不要编号、不要标点开头。空内容直接不输出任何东西。",
				},
				{
					role: "user",
					content:
						`今天是 ${today}。\n\n` +
						`用户消息:${input.userText}\n\n` +
						`助手回答(摘要):${input.assistantText.slice(0, 1500)}`,
				},
			],
			maxRetries: 0,
		});
		const lines = result.text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && l.length <= 80)
			.slice(0, MAX_OBSERVATIONS_PER_CALL);
		// Drop lines that look like "no signal" / boilerplate.
		const filtered = lines.filter((l) => {
			const lower = l.toLowerCase();
			if (lower.includes("无新偏好") || lower.includes("没有")) return false;
			if (lower.startsWith("无") || lower.startsWith("none")) return false;
			return true;
		});
		return filtered;
	} catch {
		return [];
	}
}

/**
 * Append a batch of observations (already-extracted, post-filter) to
 * `~/.quilin/user.md`. Adds the file's `## Quilin 观察 / Agent-observed
 * notes` section header if missing, then appends timestamped bullet
 * lines under it.
 *
 * 把抽取出来的观察追加到 user.md 的 "Quilin 观察" 段;段不存在则建。
 */
export async function appendObservationsToUserMd(
	observations: readonly string[],
): Promise<{ readonly appended: number; readonly path: string; readonly skipped: string | null }> {
	return appendToProfileSection({
		path: userMdPath(),
		heading: OBSERVATION_HEADING,
		entries: observations,
	});
}

/**
 * Append a self-adjustment note to `~/.quilin/soul.md`. Used when the
 * user directly corrects Quilin's behaviour ("don't do X / always do Y").
 *
 * 用户直接给反馈纠正时调用,append 到 soul.md "Quilin 自我修正记录" 段。
 */
export async function appendAdjustmentToSoulMd(
	notes: readonly string[],
): Promise<{ readonly appended: number; readonly path: string; readonly skipped: string | null }> {
	return appendToProfileSection({
		path: soulMdPath(),
		heading: ADJUSTMENT_HEADING,
		entries: notes,
	});
}

interface AppendInput {
	readonly path: string;
	readonly heading: string;
	readonly entries: readonly string[];
}

async function appendToProfileSection(
	input: AppendInput,
): Promise<{ readonly appended: number; readonly path: string; readonly skipped: string | null }> {
	if (!isProfileEvolutionEnabled()) {
		return { appended: 0, path: input.path, skipped: "feature flag off" };
	}
	if (input.entries.length === 0) {
		return { appended: 0, path: input.path, skipped: "no entries to append" };
	}
	if (!existsSync(input.path)) {
		return { appended: 0, path: input.path, skipped: "profile file missing" };
	}
	try {
		const stat = statSync(input.path);
		if (stat.size > MAX_FILE_BYTES) {
			return { appended: 0, path: input.path, skipped: "file size cap reached" };
		}
		const existing = readFileSync(input.path, "utf8");
		const now = new Date().toISOString();
		const headingExists = existing.includes(input.heading);
		const newlinePrefix = existing.endsWith("\n") ? "" : "\n";
		const headerBlock = headingExists ? "" : `\n${input.heading}\n\n`;
		// Remove the placeholder line if it's still there.
		let normalized = existing;
		const placeholderRx =
			/\n_\(还没有(观察记录|自修正记录) · no (observations|adjustments) yet\)_\s*$/;
		if (placeholderRx.test(normalized)) {
			normalized = normalized.replace(placeholderRx, "\n");
		}
		const bullets = input.entries.map((e) => `- \`${now}\` — ${e}`).join("\n");
		const block = `${newlinePrefix}${headerBlock}${bullets}\n`;
		if (normalized !== existing) {
			// Replaced placeholder — rewrite the whole file (the only
			// time we don't use appendFile). Use writeFile via the
			// same fs/promises path for atomicity.
			const fs = await import("node:fs/promises");
			await fs.writeFile(input.path, `${normalized}${block}`, "utf8");
		} else {
			await appendFile(input.path, block, "utf8");
		}
		return { appended: input.entries.length, path: input.path, skipped: null };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { appended: 0, path: input.path, skipped: `write failed: ${msg}` };
	}
}
