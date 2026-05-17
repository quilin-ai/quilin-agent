/**
 * WeChat exported-JSON parser
 *
 * 解析 wxbackup / wxexporter 风格的 WeChat 聊天记录 JSON 导出。**只解析、
 * 不写记忆、不联网**。容错优先：未知类型、缺字段、坏时间戳都通过 warnings
 * 暴露，不抛错（除非顶层 JSON 不可解析或不是 array）。
 *
 * Parses wxbackup / wxexporter-style WeChat chat-history JSON exports.
 * Parse-only — no memory writes, no network. Fault-tolerant by design:
 * unknown types, missing fields, and bad timestamps surface as warnings
 * rather than thrown errors (except for unparseable top-level JSON or
 * non-array roots).
 */

import type {
	WeChatConversation,
	WeChatExportSource,
	WeChatMessage,
	WeChatMessageType,
	WeChatParticipant,
} from "./types.js";

export interface ParseExportedJsonOptions {
	readonly source?: WeChatExportSource;
	/**
	 * The wxid of the local export owner. If provided, `isSelf` falls back to
	 * `sender.id === selfId` when the raw record omits `isSend`.
	 */
	readonly selfId?: string;
}

interface RawRecord {
	readonly msgSvrId?: unknown;
	readonly talker?: unknown;
	readonly isSend?: unknown;
	readonly content?: unknown;
	readonly createTime?: unknown;
	readonly type?: unknown;
	readonly displayName?: unknown;
	readonly fromUser?: unknown;
	readonly toUser?: unknown;
}

const WECHAT_TYPE_MAP: Readonly<Record<number, WeChatMessageType>> = {
	1: "text",
	3: "image",
	34: "voice",
	43: "video",
	47: "sticker",
	48: "location",
	49: "link",
	10000: "system",
};

/**
 * Top-level entry. Throws only if the JSON is unparseable or the root is not
 * an array of records.
 */
export function parseExportedJson(
	json: string,
	options: ParseExportedJsonOptions = {},
): WeChatConversation {
	const source = options.source ?? "wxbackup";
	let root: unknown;
	try {
		root = JSON.parse(json);
	} catch (error: unknown) {
		throw new Error(
			`failed to parse WeChat export JSON: ${getErrorMessage(error)}`,
		);
	}
	if (!Array.isArray(root)) {
		throw new Error(
			"WeChat export JSON must be an array of message records at the top level",
		);
	}

	const warnings: string[] = [];
	const messages: WeChatMessage[] = [];
	const participantsById = new Map<string, WeChatParticipant>();
	let conversationId = "";

	for (let i = 0; i < root.length; i += 1) {
		const raw = root[i] as RawRecord | null;
		if (!raw || typeof raw !== "object") {
			warnings.push(`record[${i}]: skipped — not an object`);
			continue;
		}

		const talker = stringOrUndefined(raw.talker);
		if (!talker) {
			warnings.push(`record[${i}]: skipped — missing 'talker'`);
			continue;
		}
		if (!conversationId) {
			conversationId = talker;
		} else if (conversationId !== talker) {
			warnings.push(
				`record[${i}]: talker '${talker}' differs from conversation '${conversationId}'`,
			);
		}

		const id = stringOrUndefined(raw.msgSvrId);
		if (!id) {
			warnings.push(`record[${i}]: skipped — missing 'msgSvrId'`);
			continue;
		}

		const timestamp = parseTimestamp(raw.createTime);
		if (!timestamp) {
			warnings.push(`record[${i}]: skipped — invalid 'createTime'`);
			continue;
		}

		const isSelf = resolveIsSelf(raw, options.selfId, talker);
		const senderId = isSelf
			? (options.selfId ?? "self")
			: (stringOrUndefined(raw.fromUser) ?? talker);
		const displayName = stringOrUndefined(raw.displayName);
		const sender: WeChatParticipant = displayName
			? { id: senderId, displayName }
			: { id: senderId };
		if (!participantsById.has(senderId)) {
			participantsById.set(senderId, sender);
		} else if (displayName) {
			// upgrade with display name if we learned one later
			const existing = participantsById.get(senderId);
			if (existing && !existing.displayName) {
				participantsById.set(senderId, { id: senderId, displayName });
			}
		}

		const messageType = mapMessageType(raw.type, i, warnings);
		const content = stringOrEmpty(raw.content);

		messages.push({
			id,
			conversationId: talker,
			sender,
			timestamp,
			messageType,
			content,
			isSelf,
		});
	}

	const sortedMessages = [...messages].sort(
		(a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
	);

	return {
		source,
		conversationId,
		participants: Object.freeze(Array.from(participantsById.values())),
		messages: Object.freeze(sortedMessages),
		startTime: sortedMessages[0]?.timestamp,
		endTime: sortedMessages[sortedMessages.length - 1]?.timestamp,
		warnings: Object.freeze(warnings),
	};
}

function mapMessageType(
	raw: unknown,
	index: number,
	warnings: string[],
): WeChatMessageType {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		const mapped = WECHAT_TYPE_MAP[raw];
		if (mapped) return mapped;
		warnings.push(`record[${index}]: unknown WeChat type code ${raw}`);
		return "unknown";
	}
	if (typeof raw === "string") {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed)) {
			return mapMessageType(parsed, index, warnings);
		}
	}
	warnings.push(`record[${index}]: missing or non-numeric 'type'`);
	return "unknown";
}

function parseTimestamp(raw: unknown): Date | null {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		// WeChat exports use seconds (10-digit) or milliseconds (13-digit).
		const ms = raw < 1e12 ? raw * 1000 : raw;
		return new Date(ms);
	}
	if (typeof raw === "string") {
		// Plain digit strings are treated as seconds/ms epochs; anything else
		// goes through Date string parsing (ISO-8601, RFC2822, etc).
		if (/^-?\d+$/.test(raw.trim())) {
			return parseTimestamp(Number.parseInt(raw, 10));
		}
		const direct = new Date(raw);
		if (!Number.isNaN(direct.getTime())) return direct;
	}
	return null;
}

function resolveIsSelf(
	raw: RawRecord,
	selfId: string | undefined,
	_talker: string,
): boolean {
	if (typeof raw.isSend === "number") return raw.isSend === 1;
	if (typeof raw.isSend === "boolean") return raw.isSend;
	if (typeof raw.isSend === "string") {
		const parsed = Number.parseInt(raw.isSend, 10);
		if (Number.isFinite(parsed)) return parsed === 1;
	}
	if (selfId) {
		const fromUser = stringOrUndefined(raw.fromUser);
		// Without an isSend flag, only the explicit fromUser match counts as self.
		return fromUser === selfId;
	}
	return false;
}

function stringOrUndefined(raw: unknown): string | undefined {
	if (typeof raw === "string" && raw.length > 0) return raw;
	if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
	return undefined;
}

function stringOrEmpty(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
	return "";
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
