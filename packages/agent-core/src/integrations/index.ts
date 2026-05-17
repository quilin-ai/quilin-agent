/**
 * Integrations barrel
 *
 * 探测层（detection layer）+ 解析层（parser layer），用于 QUI-103 / QUI-104
 * 的"骨架"实现。**不抓取真实数据、不写记忆、不联网（除非显式注入 fetch）。**
 *
 * Detection + parser scaffolding for QUI-103 / QUI-104. Does not pull real
 * data, write to memory, or hit the network unless a fetch implementation
 * is explicitly injected.
 */

export type {
	DetectGitHubAuthOptions,
	FetchLike,
	GitHubAuthSource,
	GitHubAuthStatus,
	GitHubStarsCount,
	ListStarsCountOptions,
} from "./github-stars/detector.js";
export { detectGitHubAuth, listStarsCount } from "./github-stars/detector.js";

export type {
	DetectObsidianVaultsOptions,
	VaultEvidence,
	VaultFileEntry,
	VaultProbe,
} from "./obsidian-watcher/detector.js";
export {
	defaultCandidatePaths,
	detectObsidianVaults,
} from "./obsidian-watcher/detector.js";
export type { ParseExportedJsonOptions } from "./wechat-import/parser.js";
export { parseExportedJson } from "./wechat-import/parser.js";

export type {
	BuildProfileStubOptions,
	ProfileConfidence,
	ProfileDimension,
	UserProfileFromChats,
} from "./wechat-import/profile-stub.js";
export { buildProfileStub } from "./wechat-import/profile-stub.js";
export type {
	WeChatConversation,
	WeChatExportSource,
	WeChatMessage,
	WeChatMessageType,
	WeChatParticipant,
} from "./wechat-import/types.js";
export type {
	DetectXBookmarksOptions,
	XAccessIneligibleReason,
	XAccessReasonDetail,
	XBookmarksAccessibility,
	XCredentialBundle,
} from "./x-bookmarks/detector.js";
export { detectXBookmarksAccessible } from "./x-bookmarks/detector.js";
