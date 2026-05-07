import { describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import {
	autoSaveCheckpoint,
	buildRecoveryContext,
	type CrashDetectionResult,
	DEFAULT_CHECKPOINT_INTERVAL,
	detectCrashRecovery,
} from "./recovery.js";
import type { AgentState, Checkpoint } from "./types.js";

vi.mock("../logger.js", () => ({
	logger: { warn: vi.fn() },
}));

function makeState(overrides: Partial<AgentState> = {}): AgentState {
	return {
		messages: [{ role: "system", content: "system prompt" }],
		isTerminal: false,
		turnCount: 1,
		createdAt: "2026-05-07T00:00:00.000Z",
		lastActiveAt: "2026-05-07T00:00:00.000Z",
		...overrides,
	};
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
	return {
		save: vi.fn().mockResolvedValue(undefined),
		load: vi.fn().mockResolvedValue(null),
		list: vi.fn().mockResolvedValue([]),
		listSessions: vi.fn().mockResolvedValue([]),
		...overrides,
	};
}

describe("autoSaveCheckpoint", () => {
	it("saves checkpoint at the configured interval", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = makeCheckpoint({ save });
		const baseState = makeState();
		const hook = autoSaveCheckpoint(checkpoint, baseState, 3);

		// Turn 1 — no save (1 % 3 !== 0)
		await hook.onTurnComplete(1, []);
		expect(save).not.toHaveBeenCalled();

		// Turn 2 — no save
		await hook.onTurnComplete(2, []);
		expect(save).not.toHaveBeenCalled();

		// Turn 3 — SAVE (3 % 3 === 0)
		await hook.onTurnComplete(3, [{ role: "user", content: "hello" }]);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				turnCount: 3,
				isTerminal: false,
			}),
		);
	});

	it("defaults to interval of 5 when no interval is provided", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = makeCheckpoint({ save });
		const hook = autoSaveCheckpoint(checkpoint, makeState());

		for (let i = 1; i < 5; i += 1) {
			await hook.onTurnComplete(i, []);
		}
		expect(save).not.toHaveBeenCalled();

		await hook.onTurnComplete(5, []);
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("uses DEFAULT_CHECKPOINT_INTERVAL of 5", () => {
		expect(DEFAULT_CHECKPOINT_INTERVAL).toBe(5);
	});

	it("preserves the original createdAt from base state", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = makeCheckpoint({ save });
		const baseState = makeState({ createdAt: "2024-01-01T00:00:00.000Z" });
		const hook = autoSaveCheckpoint(checkpoint, baseState, 1);

		await hook.onTurnComplete(1, [
			{ role: "user", content: "test" },
		]);
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				createdAt: "2024-01-01T00:00:00.000Z",
			}),
		);
	});

	it("sets isTerminal=false in auto-saved state", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = makeCheckpoint({ save });
		const hook = autoSaveCheckpoint(checkpoint, makeState(), 1);

		await hook.onTurnComplete(1, []);
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				isTerminal: false,
			}),
		);
	});

	it("does not throw when checkpoint.save fails", async () => {
		const save = vi
			.fn()
			.mockRejectedValue(new Error("disk full"));
		const checkpoint = makeCheckpoint({ save });
		const hook = autoSaveCheckpoint(checkpoint, makeState(), 1);

		await expect(hook.onTurnComplete(1, [])).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				err: expect.any(Error),
				turnCount: 1,
			}),
			"Auto-save checkpoint failed",
		);
	});

	it("saves multiple times across many turns", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = makeCheckpoint({ save });
		const hook = autoSaveCheckpoint(checkpoint, makeState(), 2);

		// Turn 1: no save
		await hook.onTurnComplete(1, []);
		// Turn 2: save
		await hook.onTurnComplete(2, [{ role: "user", content: "a" }]);
		// Turn 3: no save
		await hook.onTurnComplete(3, []);
		// Turn 4: save
		await hook.onTurnComplete(4, [{ role: "user", content: "b" }]);

		expect(save).toHaveBeenCalledTimes(2);
	});
});

describe("autoSaveCheckpoint.markTerminal", () => {
	it("saves state with isTerminal=true", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = makeCheckpoint({ save });
		const hook = autoSaveCheckpoint(checkpoint, makeState());

		await hook.markTerminal(10, [
			{ role: "assistant", content: "done" },
		]);
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				turnCount: 10,
				isTerminal: true,
			}),
		);
	});

	it("preserves createdAt in terminal state", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = makeCheckpoint({ save });
		const baseState = makeState({ createdAt: "2024-06-01T00:00:00.000Z" });
		const hook = autoSaveCheckpoint(checkpoint, baseState);

		await hook.markTerminal(5, []);
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				createdAt: "2024-06-01T00:00:00.000Z",
			}),
		);
	});

	it("does not throw when markTerminal save fails", async () => {
		const save = vi
			.fn()
			.mockRejectedValue(new Error("write error"));
		const checkpoint = makeCheckpoint({ save });
		const hook = autoSaveCheckpoint(checkpoint, makeState());

		await expect(hook.markTerminal(1, [])).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				err: expect.any(Error),
				turnCount: 1,
			}),
			"Terminal checkpoint save failed",
		);
	});
});

describe("autoSaveCheckpoint turnCounter independence", () => {
	it("resumes counting correctly when the same hook is used across resumed sessions", async () => {
		// Simulates: first session auto-saves at turn 3, then "resume" starts fresh counter
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = makeCheckpoint({ save });
		const baseState = makeState();

		// "Session 1": save at turns 3 and 6
		const hook1 = autoSaveCheckpoint(checkpoint, baseState, 3);
		await hook1.onTurnComplete(1, []);
		await hook1.onTurnComplete(2, []);
		await hook1.onTurnComplete(3, []);
		expect(save).toHaveBeenCalledTimes(1);
		await hook1.onTurnComplete(4, []);
		await hook1.onTurnComplete(5, []);
		await hook1.onTurnComplete(6, []);
		expect(save).toHaveBeenCalledTimes(2);

		// "Session 2" (resumed): fresh counter starts at 1 again
		const hook2 = autoSaveCheckpoint(checkpoint, baseState, 3);
		await hook2.onTurnComplete(1, []);
		await hook2.onTurnComplete(2, []);
		expect(save).toHaveBeenCalledTimes(2); // no new saves yet
		await hook2.onTurnComplete(3, []);
		expect(save).toHaveBeenCalledTimes(3); // now saves
	});
});

describe("detectCrashRecovery", () => {
	it("returns null when no previous state exists (load returns null)", async () => {
		const load = vi.fn().mockResolvedValue(null);
		const checkpoint = makeCheckpoint({ load });

		await expect(
			detectCrashRecovery(checkpoint, "session-1"),
		).resolves.toBeNull();
	});

	it("returns null when previous session terminated cleanly (isTerminal=true)", async () => {
		const load = vi
			.fn()
			.mockResolvedValue(makeState({ isTerminal: true, turnCount: 10 }));
		const checkpoint = makeCheckpoint({ load });

		await expect(
			detectCrashRecovery(checkpoint, "session-1"),
		).resolves.toBeNull();
	});

	it("returns crash result when previous session has isTerminal=false", async () => {
		const previousState = makeState({
			isTerminal: false,
			turnCount: 7,
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "run the tests" },
				{ role: "assistant", content: "running tests now..." },
				{ role: "user", content: "also check coverage" },
			],
		});
		const load = vi.fn().mockResolvedValue(previousState);
		const checkpoint = makeCheckpoint({ load });

		const result = await detectCrashRecovery(checkpoint, "session-1");

		expect(result).not.toBeNull();
		expect(result).toEqual<CrashDetectionResult>({
			crashed: true,
			previousState,
			lastUserMessage: "also check coverage",
			messageCount: 4,
		});
	});

	it("returns empty lastUserMessage when no user messages exist in crashed session", async () => {
		const previousState = makeState({
			isTerminal: false,
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "assistant", content: "auto-reply" },
			],
		});
		const load = vi.fn().mockResolvedValue(previousState);
		const checkpoint = makeCheckpoint({ load });

		const result = await detectCrashRecovery(checkpoint, "session-x");
		expect(result).not.toBeNull();
		expect(result?.lastUserMessage).toBe("");
	});

	it("returns the last user message when multiple user messages exist", async () => {
		const previousState = makeState({
			isTerminal: false,
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "first request" },
				{ role: "assistant", content: "first reply" },
				{ role: "user", content: "second request" },
			],
		});
		const load = vi.fn().mockResolvedValue(previousState);
		const checkpoint = makeCheckpoint({ load });

		const result = await detectCrashRecovery(checkpoint, "session-1");
		expect(result?.lastUserMessage).toBe("second request");
	});

	it("calls checkpoint.load with the correct sessionId", async () => {
		const load = vi.fn().mockResolvedValue(null);
		const checkpoint = makeCheckpoint({ load });

		await detectCrashRecovery(checkpoint, "my-session-id");
		expect(load).toHaveBeenCalledWith("my-session-id");
	});
});

describe("buildRecoveryContext", () => {
	it("builds recovery context with crash summary and system prompt", () => {
		const crashResult: CrashDetectionResult = {
			crashed: true,
			previousState: makeState({
				isTerminal: false,
				turnCount: 5,
				messages: [
					{ role: "system", content: "system prompt" },
					{ role: "user", content: "deploy the service to staging" },
					{
						role: "assistant",
						content: "I will deploy using the following steps...",
					},
					{ role: "user", content: "make sure to use the correct env" },
				],
			}),
			lastUserMessage: "make sure to use the correct env",
			messageCount: 4,
		};

		const context = buildRecoveryContext(crashResult);

		// Verify crashSummary contains key information
		expect(context.crashSummary).toContain("turn 5");
		expect(context.crashSummary).toContain("4 messages");
		expect(context.crashSummary).toContain("make sure to use the correct env");
		expect(context.crashSummary).toContain("[user]: deploy the service to staging");

		// Verify recoverySystemPrompt is meaningful
		expect(context.recoverySystemPrompt).toContain("crash recovery");
		expect(context.recoverySystemPrompt).toContain("interrupted");
		expect(context.recoverySystemPrompt).toContain("continue");
	});

	it("truncates long lastUserMessage in crash summary", () => {
		const longMessage = "z".repeat(400);
		const crashResult: CrashDetectionResult = {
			crashed: true,
			previousState: makeState({
				messages: [
					{ role: "user", content: longMessage },
				],
			}),
			lastUserMessage: longMessage,
			messageCount: 1,
		};

		const context = buildRecoveryContext(crashResult);
		// The full 400-char string should not appear (it's truncated to 300 chars + "...")
		expect(context.crashSummary).not.toContain(longMessage);
		// Should contain truncated version with "..."
		expect(context.crashSummary).toContain("...");
		// Truncated user request line should contain only 300 chars (plus "...")
		expect(context.crashSummary).toContain("z".repeat(300) + "...");
	});

	it("handles empty messages gracefully", () => {
		const crashResult: CrashDetectionResult = {
			crashed: true,
			previousState: makeState({ messages: [], turnCount: 0 }),
			lastUserMessage: "",
			messageCount: 0,
		};

		const context = buildRecoveryContext(crashResult);

		expect(context.crashSummary).toContain("(empty)");
		expect(context.crashSummary).toContain("No user message found");
		expect(context.recoverySystemPrompt).toBeDefined();
	});

	it("handles messages without user messages but with other messages", () => {
		const crashResult: CrashDetectionResult = {
			crashed: true,
			previousState: makeState({
				turnCount: 2,
				messages: [
					{ role: "system", content: "system prompt" },
					{ role: "assistant", content: "auto-reply content here" },
				],
			}),
			lastUserMessage: "",
			messageCount: 2,
		};

		const context = buildRecoveryContext(crashResult);
		expect(context.crashSummary).toContain("No user message found");
		expect(context.crashSummary).toContain("[assistant]");
	});

	it("includes message digest with role labels", () => {
		const crashResult: CrashDetectionResult = {
			crashed: true,
			previousState: makeState({
				messages: [
					{ role: "user", content: "request" },
					{ role: "assistant", content: "response" },
				],
			}),
			lastUserMessage: "request",
			messageCount: 2,
		};

		const context = buildRecoveryContext(crashResult);
		expect(context.crashSummary).toContain("[user]: request");
		expect(context.crashSummary).toContain("[assistant]: response");
	});

	it("limits message digest to last 4 messages", () => {
		const crashResult: CrashDetectionResult = {
			crashed: true,
			previousState: makeState({
				messages: [
					{ role: "user", content: "msg1" },
					{ role: "assistant", content: "msg2" },
					{ role: "user", content: "msg3" },
					{ role: "assistant", content: "msg4" },
					{ role: "user", content: "msg5" },
					{ role: "assistant", content: "msg6" },
				],
			}),
			lastUserMessage: "msg5",
			messageCount: 6,
		};

		const context = buildRecoveryContext(crashResult);
		// Should NOT contain msg1 or msg2 (first two, excluded by slice(-4))
		expect(context.crashSummary).not.toContain("msg1");
		expect(context.crashSummary).not.toContain("msg2");
		// Should contain msg3, msg4, msg5, msg6
		expect(context.crashSummary).toContain("msg3");
		expect(context.crashSummary).toContain("msg6");
	});
});
