import { describe, expect, it } from "vitest";
import { parseExportedJson } from "./parser.js";

describe("parseExportedJson", () => {
	it("parses a normal wxbackup conversation and sorts by timestamp", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1001",
				talker: "wxid_friend",
				isSend: 0,
				type: 1,
				content: "你好",
				createTime: 1714000000,
				displayName: "好友",
				fromUser: "wxid_friend",
			},
			{
				msgSvrId: "1002",
				talker: "wxid_friend",
				isSend: 1,
				type: 1,
				content: "hi",
				createTime: 1713999000,
			},
		]);
		const conv = parseExportedJson(json, { selfId: "wxid_self" });
		expect(conv.source).toBe("wxbackup");
		expect(conv.conversationId).toBe("wxid_friend");
		expect(conv.messages).toHaveLength(2);
		// sorted by timestamp ascending
		expect(conv.messages[0]?.id).toBe("1002");
		expect(conv.messages[1]?.id).toBe("1001");
		expect(conv.messages[1]?.sender.displayName).toBe("好友");
		expect(conv.messages[0]?.isSelf).toBe(true);
		expect(conv.messages[1]?.isSelf).toBe(false);
		expect(conv.warnings).toEqual([]);
		expect(conv.participants.length).toBeGreaterThanOrEqual(2);
		expect(conv.startTime?.toISOString()).toBe(
			new Date(1713999000 * 1000).toISOString(),
		);
		expect(conv.endTime?.toISOString()).toBe(
			new Date(1714000000 * 1000).toISOString(),
		);
	});

	it("maps known WeChat type codes", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 3,
				content: "[图片]",
				createTime: 1700000000,
			},
			{
				msgSvrId: "2",
				talker: "wxid_x",
				isSend: 0,
				type: 49,
				content: "https://example.com",
				createTime: 1700000001,
			},
			{
				msgSvrId: "3",
				talker: "wxid_x",
				isSend: 0,
				type: 10000,
				content: "Friend added",
				createTime: 1700000002,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages.map((m) => m.messageType)).toEqual([
			"image",
			"link",
			"system",
		]);
	});

	it("emits warnings for unknown type codes but keeps the message", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 9999,
				content: "?",
				createTime: 1700000000,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages).toHaveLength(1);
		expect(conv.messages[0]?.messageType).toBe("unknown");
		expect(conv.warnings.join("\n")).toMatch(/unknown WeChat type code 9999/);
	});

	it("supports both seconds and millisecond createTime", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "a",
				createTime: 1714000000, // seconds
			},
			{
				msgSvrId: "2",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "b",
				createTime: 1714000000000, // milliseconds
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages).toHaveLength(2);
		expect(conv.messages[0]?.timestamp.toISOString()).toBe(
			conv.messages[1]?.timestamp.toISOString(),
		);
	});

	it("skips records missing required fields with warnings", () => {
		const json = JSON.stringify([
			null,
			{
				msgSvrId: "1",
				isSend: 0,
				type: 1,
				content: "no talker",
				createTime: 1,
			},
			{
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "no id",
				createTime: 1700000000,
			},
			{
				msgSvrId: "2",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "bad ts",
				createTime: "not-a-time",
			},
			{
				msgSvrId: "3",
				talker: "wxid_x",
				isSend: 1,
				type: 1,
				content: "ok",
				createTime: 1700000000,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages).toHaveLength(1);
		expect(conv.warnings.length).toBeGreaterThanOrEqual(4);
		expect(conv.warnings.some((w) => w.includes("not an object"))).toBe(true);
		expect(conv.warnings.some((w) => w.includes("missing 'talker'"))).toBe(
			true,
		);
		expect(conv.warnings.some((w) => w.includes("missing 'msgSvrId'"))).toBe(
			true,
		);
		expect(conv.warnings.some((w) => w.includes("invalid 'createTime'"))).toBe(
			true,
		);
	});

	it("warns when a record's talker differs from the established conversation", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_a",
				isSend: 0,
				type: 1,
				content: "x",
				createTime: 1700000000,
			},
			{
				msgSvrId: "2",
				talker: "wxid_b",
				isSend: 0,
				type: 1,
				content: "y",
				createTime: 1700000001,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.conversationId).toBe("wxid_a");
		expect(
			conv.warnings.some((w) => w.includes("differs from conversation")),
		).toBe(true);
	});

	it("falls back to selfId comparison when isSend is missing", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_friend",
				type: 1,
				content: "hi",
				createTime: 1700000000,
				fromUser: "wxid_self",
			},
			{
				msgSvrId: "2",
				talker: "wxid_friend",
				type: 1,
				content: "hi back",
				createTime: 1700000001,
				fromUser: "wxid_friend",
			},
		]);
		const conv = parseExportedJson(json, { selfId: "wxid_self" });
		expect(conv.messages[0]?.isSelf).toBe(true);
		expect(conv.messages[1]?.isSelf).toBe(false);
	});

	it("treats non-numeric isSend string as not-self when no selfId", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: "yes",
				type: 1,
				content: "x",
				createTime: 1700000000,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages[0]?.isSelf).toBe(false);
	});

	it("accepts numeric and string isSend representations", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: "1",
				type: 1,
				content: "a",
				createTime: 1700000000,
			},
			{
				msgSvrId: "2",
				talker: "wxid_x",
				isSend: true,
				type: 1,
				content: "b",
				createTime: 1700000001,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages.every((m) => m.isSelf)).toBe(true);
	});

	it("throws on unparseable JSON", () => {
		expect(() => parseExportedJson("not json")).toThrow(/failed to parse/);
	});

	it("throws when root is not an array", () => {
		expect(() => parseExportedJson('{"messages":[]}')).toThrow(
			/must be an array/,
		);
	});

	it("returns empty conversation when array is empty", () => {
		const conv = parseExportedJson("[]");
		expect(conv.messages).toEqual([]);
		expect(conv.participants).toEqual([]);
		expect(conv.startTime).toBeUndefined();
		expect(conv.endTime).toBeUndefined();
		expect(conv.warnings).toEqual([]);
	});

	it("allows overriding source label", () => {
		const conv = parseExportedJson("[]", { source: "itchat" });
		expect(conv.source).toBe("itchat");
	});

	it("treats string-encoded numeric type as the parsed code", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: "1",
				content: "a",
				createTime: 1700000000,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages[0]?.messageType).toBe("text");
	});

	it("defaults missing/object 'content' field to empty string", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: null,
				createTime: 1700000000,
			},
			{
				msgSvrId: "2",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: { nested: "object" },
				createTime: 1700000001,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages[0]?.content).toBe("");
		expect(conv.messages[1]?.content).toBe("");
	});

	it("accepts numeric-string createTime", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "x",
				createTime: "1714000000",
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages[0]?.timestamp.toISOString()).toBe(
			new Date(1714000000 * 1000).toISOString(),
		);
	});

	it("rejects unparseable string createTime via Date fallback", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "x",
				createTime: "totally-not-a-date",
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages).toHaveLength(0);
		expect(conv.warnings.join("\n")).toMatch(/invalid 'createTime'/);
	});

	it("coerces numeric 'content' field to string", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: 12345,
				createTime: 1700000000,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages[0]?.content).toBe("12345");
	});

	it("warns on non-numeric type strings", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: "abc",
				content: "x",
				createTime: 1700000000,
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages[0]?.messageType).toBe("unknown");
		expect(conv.warnings.join("\n")).toMatch(/missing or non-numeric 'type'/);
	});

	it("preserves displayName for sender on later occurrences", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "hi",
				createTime: 1700000000,
			},
			{
				msgSvrId: "2",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "again",
				createTime: 1700000001,
				displayName: "Friend",
			},
		]);
		const conv = parseExportedJson(json);
		const friend = conv.participants.find((p) => p.id === "wxid_x");
		expect(friend?.displayName).toBe("Friend");
	});

	it("does not flag self when neither isSend nor selfId match", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				type: 1,
				content: "hi",
				createTime: 1700000000,
				fromUser: "wxid_x",
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages[0]?.isSelf).toBe(false);
	});

	it("treats invalid numeric content/talker types as missing without crashing", () => {
		const json = JSON.stringify([
			{
				msgSvrId: 42,
				talker: 7,
				isSend: 0,
				type: 1,
				content: "hi",
				createTime: 1700000000,
			},
		]);
		const conv = parseExportedJson(json);
		// numeric talker/id are coerced via stringOrUndefined.
		expect(conv.messages).toHaveLength(1);
		expect(conv.messages[0]?.id).toBe("42");
		expect(conv.messages[0]?.conversationId).toBe("7");
	});

	it("parses ISO-style createTime strings", () => {
		const json = JSON.stringify([
			{
				msgSvrId: "1",
				talker: "wxid_x",
				isSend: 0,
				type: 1,
				content: "a",
				createTime: "2026-05-01T12:00:00Z",
			},
		]);
		const conv = parseExportedJson(json);
		expect(conv.messages[0]?.timestamp.toISOString()).toBe(
			"2026-05-01T12:00:00.000Z",
		);
	});
});
