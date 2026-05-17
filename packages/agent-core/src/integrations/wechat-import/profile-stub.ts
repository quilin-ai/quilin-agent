/**
 * User profile derived from WeChat conversations — interface + stub
 *
 * 这里只定义最终 LLM 抽取得到的画像形状（dimensions）以及一个 stub 实现，
 * 真正的 LLM 调用（含 prompt、token 预算、redaction）放到后续 issue 实现。
 *
 * Defines the final shape of a user profile inferred from WeChat
 * conversations plus a deterministic stub. The actual LLM extraction
 * (prompting, token budget, redaction) lands in a follow-up issue.
 */

import type { WeChatConversation } from "./types.js";

export type ProfileConfidence = "low" | "medium" | "high";

export interface ProfileDimension {
	readonly summary: string;
	readonly evidenceCount: number;
	readonly confidence: ProfileConfidence;
}

export interface UserProfileFromChats {
	readonly communicationStyle: ProfileDimension;
	readonly workPreferences: ProfileDimension;
	readonly recurringInterests: ProfileDimension;
	readonly decisionStyle: ProfileDimension;
	readonly boundaries: ProfileDimension;
	readonly sensitiveTopics: ProfileDimension;
	readonly uncertaintyNotes: readonly string[];
	readonly extractedAt: Date;
	readonly extractor: "stub" | "llm";
}

export interface BuildProfileStubOptions {
	readonly conversations: readonly WeChatConversation[];
	readonly now?: () => Date;
}

/**
 * Stub profile builder.
 *
 * Returns a fixed-shape placeholder profile so downstream code paths can be
 * wired and tested end-to-end before the LLM extractor is implemented. Every
 * dimension is marked as `"low"` confidence and the summary explicitly says
 * "placeholder" so it cannot be mistaken for real output.
 */
export function buildProfileStub(
	options: BuildProfileStubOptions,
): UserProfileFromChats {
	const now = (options.now ?? (() => new Date()))();
	const totalMessages = options.conversations.reduce(
		(acc, conv) => acc + conv.messages.length,
		0,
	);
	const dim = (label: string): ProfileDimension => ({
		summary: `[stub] ${label} — pending LLM extractor; observed ${totalMessages} messages`,
		evidenceCount: totalMessages,
		confidence: "low",
	});
	return {
		communicationStyle: dim("communication_style"),
		workPreferences: dim("work_preferences"),
		recurringInterests: dim("recurring_interests"),
		decisionStyle: dim("decision_style"),
		boundaries: dim("boundaries"),
		sensitiveTopics: dim("sensitive_topics"),
		uncertaintyNotes: Object.freeze([
			"stub implementation — no LLM has been called",
			`observed ${options.conversations.length} conversation(s)`,
		]),
		extractedAt: now,
		extractor: "stub",
	};
}
