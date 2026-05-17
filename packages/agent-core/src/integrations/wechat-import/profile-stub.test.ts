import { describe, expect, it } from "vitest";
import { buildProfileStub } from "./profile-stub.js";
import type { WeChatConversation, WeChatMessage } from "./types.js";

function makeConversation(
	messageCount: number,
	id = "wxid_x",
): WeChatConversation {
	const messages: WeChatMessage[] = [];
	for (let i = 0; i < messageCount; i += 1) {
		messages.push({
			id: `${id}-${i}`,
			conversationId: id,
			sender: { id: i % 2 === 0 ? "self" : id },
			timestamp: new Date(2_000_000_000_000 + i * 1000),
			messageType: "text",
			content: `msg-${i}`,
			isSelf: i % 2 === 0,
		});
	}
	return {
		source: "wxbackup",
		conversationId: id,
		participants: [{ id: "self" }, { id }],
		messages,
		warnings: [],
		startTime: messages[0]?.timestamp,
		endTime: messages[messages.length - 1]?.timestamp,
	};
}

describe("buildProfileStub", () => {
	it("returns all 6 dimensions plus uncertainty notes", () => {
		const profile = buildProfileStub({ conversations: [makeConversation(3)] });
		expect(profile.communicationStyle.confidence).toBe("low");
		expect(profile.workPreferences.confidence).toBe("low");
		expect(profile.recurringInterests.confidence).toBe("low");
		expect(profile.decisionStyle.confidence).toBe("low");
		expect(profile.boundaries.confidence).toBe("low");
		expect(profile.sensitiveTopics.confidence).toBe("low");
		expect(profile.uncertaintyNotes.length).toBeGreaterThan(0);
		expect(profile.extractor).toBe("stub");
	});

	it("includes total message count in summary + evidenceCount", () => {
		const profile = buildProfileStub({
			conversations: [makeConversation(2), makeConversation(5, "wxid_y")],
		});
		expect(profile.communicationStyle.evidenceCount).toBe(7);
		expect(profile.communicationStyle.summary).toContain("7 messages");
	});

	it("respects injected now()", () => {
		const stamp = new Date("2026-05-17T10:00:00Z");
		const profile = buildProfileStub({
			conversations: [],
			now: () => stamp,
		});
		expect(profile.extractedAt.toISOString()).toBe(stamp.toISOString());
	});

	it("falls back to real Date.now when now() not supplied", () => {
		const before = Date.now();
		const profile = buildProfileStub({ conversations: [] });
		const after = Date.now();
		const stamp = profile.extractedAt.getTime();
		expect(stamp).toBeGreaterThanOrEqual(before);
		expect(stamp).toBeLessThanOrEqual(after);
	});

	it("uncertainty notes are frozen and mention conversation count", () => {
		const profile = buildProfileStub({
			conversations: [makeConversation(1), makeConversation(1)],
		});
		expect(Object.isFrozen(profile.uncertaintyNotes)).toBe(true);
		expect(profile.uncertaintyNotes.join("\n")).toMatch(/2 conversation/);
	});

	it("handles empty conversation list", () => {
		const profile = buildProfileStub({ conversations: [] });
		expect(profile.communicationStyle.evidenceCount).toBe(0);
		expect(profile.communicationStyle.summary).toContain("0 messages");
	});
});
