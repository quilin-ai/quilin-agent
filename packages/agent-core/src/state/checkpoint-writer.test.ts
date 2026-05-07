import { describe, expect, it, vi } from "vitest";
import {
	buildCheckpointState,
	saveCheckpointState,
} from "./checkpoint-writer.js";
import type { AgentState } from "./types.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
	return {
		messages: [{ role: "user", content: "hello" }],
		isTerminal: false,
		turnCount: 2,
		createdAt: "2026-04-21T00:00:00.000Z",
		lastActiveAt: "2026-04-21T00:00:01.000Z",
		...overrides,
	};
}

describe("checkpoint writer", () => {
	it("builds the next checkpoint state while preserving the original createdAt", () => {
		const checkpointState = buildCheckpointState(
			[
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "world" },
			],
			3,
			makeState(),
			() => new Date("2026-04-21T01:23:45.000Z"),
		);

		expect(checkpointState).toEqual({
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "world" },
			],
			isTerminal: false,
			turnCount: 3,
			createdAt: "2026-04-21T00:00:00.000Z",
			lastActiveAt: "2026-04-21T01:23:45.000Z",
		});
	});

	it("saves checkpoint state and records the span metadata", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const recordSpan = vi.fn().mockResolvedValue(undefined);

		await saveCheckpointState({
			checkpoint: {
				save,
				load: vi.fn(),
				list: vi.fn(),
				listSessions: vi.fn(),
			},
			messages: [{ role: "user", content: "hello" }],
			turnCount: 4,
			state: makeState(),
			phase: "assistant_response",
			recordSpan,
			now: () => new Date("2026-04-21T01:23:45.000Z"),
		});

		expect(save).toHaveBeenCalledWith({
			messages: [{ role: "user", content: "hello" }],
			isTerminal: false,
			turnCount: 4,
			createdAt: "2026-04-21T00:00:00.000Z",
			lastActiveAt: "2026-04-21T01:23:45.000Z",
		});
		expect(recordSpan).toHaveBeenCalledWith("loop.checkpoint.save", {
			turnCount: 4,
			phase: "assistant_response",
			messageCount: 1,
		});
	});
});
