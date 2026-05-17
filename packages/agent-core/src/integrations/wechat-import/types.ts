/**
 * WeChat chat-history import types
 *
 * 结构化类型 / structured types for ingesting WeChat conversation exports.
 *
 * 默认采用 WeChat-Backup-Tool（俗称 wxbackup / wxexporter）的扁平 JSON 格式
 * （字段 msgSvrId / talker / isSend / content / createTime / type），这是社区
 * 工具链中最常见的导出格式，多个上游（itchat / wechat-history-toolkit 等）
 * 都向其对齐。
 *
 * The default supported shape is the WeChat-Backup-Tool (wxbackup / wxexporter)
 * flat-JSON export — fields `msgSvrId / talker / isSend / content / createTime
 * / type`. This is the most widely used schema across community tooling
 * (itchat, wechat-history-toolkit, etc. all align to it).
 */

export type WeChatMessageType =
	| "text"
	| "image"
	| "voice"
	| "video"
	| "file"
	| "link"
	| "location"
	| "sticker"
	| "system"
	| "unknown";

export type WeChatExportSource =
	| "wxbackup"
	| "itchat"
	| "wechat_history_toolkit"
	| "custom";

export interface WeChatParticipant {
	/** Stable id (WeChat alias / wxid); used for grouping. */
	readonly id: string;
	/** Optional human-readable display name. */
	readonly displayName?: string;
}

export interface WeChatMessage {
	/** Stable per-export message id (msgSvrId). */
	readonly id: string;
	/** Conversation owner / talker. */
	readonly conversationId: string;
	/** Author of this message. */
	readonly sender: WeChatParticipant;
	/** UTC timestamp parsed from createTime (seconds or ms). */
	readonly timestamp: Date;
	readonly messageType: WeChatMessageType;
	/** Plain-text payload, or a placeholder like "[图片]" for non-text. */
	readonly content: string;
	/** Whether the local export user is the author (isSend == 1). */
	readonly isSelf: boolean;
}

export interface WeChatConversation {
	readonly source: WeChatExportSource;
	readonly conversationId: string;
	readonly participants: readonly WeChatParticipant[];
	readonly messages: readonly WeChatMessage[];
	readonly startTime?: Date;
	readonly endTime?: Date;
	/** Non-fatal anomalies seen while parsing (e.g. unknown type codes). */
	readonly warnings: readonly string[];
}
