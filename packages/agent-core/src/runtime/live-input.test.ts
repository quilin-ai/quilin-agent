import { describe, expect, it } from "vitest";
import { LiveInputQueue } from "./live-input.js";

describe("LiveInputQueue", () => {
	it("ignores input outside an active turn", () => {
		const queue = new LiveInputQueue();

		expect(queue.append("hello")).toBeUndefined();
	});

	it("queues trimmed input with the active turn id", () => {
		const queue = new LiveInputQueue({
			createId: () => "live-1",
			now: () => new Date("2026-05-07T00:00:00.000Z"),
		});

		queue.beginTurn("turn-1");

		expect(queue.append("  follow up  ")).toEqual({
			id: "live-1",
			turnId: "turn-1",
			input: "follow up",
			kind: "message",
			receivedAt: "2026-05-07T00:00:00.000Z",
		});
	});

	it("classifies slash commands and ignores input while suspended", () => {
		const queue = new LiveInputQueue({
			createId: () => "live-1",
			now: () => new Date("2026-05-07T00:00:00.000Z"),
		});

		queue.beginTurn("turn-1");
		const resume = queue.suspend();

		expect(queue.append("/status")).toBeUndefined();

		resume();

		expect(queue.append("/status")).toMatchObject({
			kind: "slash_command",
			input: "/status",
			turnId: "turn-1",
		});
	});
});
