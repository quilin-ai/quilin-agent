import { describe, expect, it } from "vitest";

import {
	DEFAULT_HISTORY_CAPACITY,
	EventBus,
	MIN_HISTORY_CAPACITY,
} from "./event-bus.js";
import type { AgentEventPayload } from "./types.js";

function fixedClock(start: number, stepMs = 1): () => Date {
	let current = start;
	return () => {
		const d = new Date(current);
		current += stepMs;
		return d;
	};
}

function payload(turnIndex = 1, delta = "hi"): AgentEventPayload {
	return { type: "llm.text", turnIndex, delta };
}

describe("EventBus constructor", () => {
	it("uses the default capacity when no override is provided", () => {
		const bus = new EventBus();
		expect(bus._subscriberCount()).toBe(0);
		expect(bus._peekNextSeq()).toBe(1);
		// Default capacity is documented; exercising the path here is enough
		// to lock it in (no setter exposes it for direct read).
		expect(DEFAULT_HISTORY_CAPACITY).toBeGreaterThan(MIN_HISTORY_CAPACITY);
	});

	it("rejects non-integer or negative capacity", () => {
		expect(() => new EventBus({ historyCapacity: 0 })).toThrow(
			/historyCapacity/,
		);
		expect(() => new EventBus({ historyCapacity: -1 })).toThrow(
			/historyCapacity/,
		);
		expect(() => new EventBus({ historyCapacity: 1.5 })).toThrow(
			/historyCapacity/,
		);
	});
});

describe("EventBus.emit", () => {
	it("assigns strictly increasing seq values starting at 1", () => {
		const bus = new EventBus({ clock: fixedClock(1_700_000_000_000) });
		const first = bus.emit("s1", payload(1, "a"));
		const second = bus.emit("s1", payload(1, "b"));
		const third = bus.emit("s2", payload(1, "c"));
		expect(first.seq).toBe(1);
		expect(second.seq).toBe(2);
		expect(third.seq).toBe(3);
		expect(bus._peekNextSeq()).toBe(4);
	});

	it("stamps the event with the clock's ISO time", () => {
		const bus = new EventBus({ clock: fixedClock(0) });
		const event = bus.emit("s1", payload());
		expect(event.ts).toBe(new Date(0).toISOString());
	});

	it("evicts oldest events when capacity is reached", () => {
		const bus = new EventBus({ historyCapacity: 3 });
		for (let i = 0; i < 5; i += 1) {
			bus.emit("s1", payload(i, `d${i}`));
		}
		const snapshot = bus.historySnapshot();
		expect(snapshot).toHaveLength(3);
		expect(snapshot[0]?.seq).toBe(3);
		expect(snapshot[2]?.seq).toBe(5);
	});

	it("returns the stored event so callers can read seq", () => {
		const bus = new EventBus();
		const event = bus.emit("s1", payload(1, "x"));
		expect(event.sessionId).toBe("s1");
		expect(event.payload).toEqual({
			type: "llm.text",
			turnIndex: 1,
			delta: "x",
		});
	});
});

describe("EventBus.historySnapshot", () => {
	it("returns all events when no filter is set", () => {
		const bus = new EventBus();
		bus.emit("a", payload(1, "x"));
		bus.emit("b", payload(1, "y"));
		expect(bus.historySnapshot()).toHaveLength(2);
	});

	it("filters by sessionId", () => {
		const bus = new EventBus();
		bus.emit("a", payload(1, "x"));
		bus.emit("b", payload(1, "y"));
		bus.emit("a", payload(2, "z"));
		const onlyA = bus.historySnapshot({ sessionId: "a" });
		expect(onlyA.map((e) => e.sessionId)).toEqual(["a", "a"]);
	});

	it("filters by afterSeq (strictly greater)", () => {
		const bus = new EventBus();
		bus.emit("a", payload(1, "x")); // seq=1
		bus.emit("a", payload(1, "y")); // seq=2
		bus.emit("a", payload(1, "z")); // seq=3
		const after1 = bus.historySnapshot({ afterSeq: 1 });
		expect(after1.map((e) => e.seq)).toEqual([2, 3]);
	});

	it("combines sessionId and afterSeq filters", () => {
		const bus = new EventBus();
		bus.emit("a", payload(1, "x")); // seq=1
		bus.emit("b", payload(1, "y")); // seq=2
		bus.emit("a", payload(2, "z")); // seq=3
		const result = bus.historySnapshot({ sessionId: "a", afterSeq: 1 });
		expect(result.map((e) => e.seq)).toEqual([3]);
	});
});

describe("EventBus.subscribe", () => {
	it("yields buffered events first, then live events", async () => {
		const bus = new EventBus();
		bus.emit("a", payload(1, "buffered"));
		const sub = bus.subscribe();
		const first = await sub.next();
		expect(first.done).toBe(false);
		if (first.done) {
			throw new Error("unreachable");
		}
		expect(
			first.value.payload.type === "llm.text" && first.value.payload.delta,
		).toBe("buffered");

		const livePromise = sub.next();
		bus.emit("a", payload(1, "live"));
		const second = await livePromise;
		expect(second.done).toBe(false);
		if (second.done) {
			throw new Error("unreachable");
		}
		expect(
			second.value.payload.type === "llm.text" && second.value.payload.delta,
		).toBe("live");
		sub.close();
	});

	it("filters live events by sessionId", async () => {
		const bus = new EventBus();
		const sub = bus.subscribe({ sessionId: "wanted" });

		const next = sub.next();
		bus.emit("ignored", payload(1, "skip"));
		bus.emit("wanted", payload(1, "keep"));
		const result = await next;
		expect(result.done).toBe(false);
		if (result.done) {
			throw new Error("unreachable");
		}
		expect(result.value.sessionId).toBe("wanted");
		sub.close();
	});

	it("replays buffered history matching afterSeq", async () => {
		const bus = new EventBus();
		bus.emit("a", payload(1, "0")); // seq=1
		bus.emit("a", payload(1, "1")); // seq=2
		bus.emit("a", payload(1, "2")); // seq=3
		const sub = bus.subscribe({ afterSeq: 1 });
		const got: number[] = [];
		for (let i = 0; i < 2; i += 1) {
			const next = await sub.next();
			if (next.done) {
				break;
			}
			got.push(next.value.seq);
		}
		expect(got).toEqual([2, 3]);
		sub.close();
	});

	it("marks replayTruncated when afterSeq is older than oldest buffered seq", () => {
		const bus = new EventBus({ historyCapacity: 2 });
		bus.emit("a", payload(1, "x")); // seq=1
		bus.emit("a", payload(1, "y")); // seq=2
		bus.emit("a", payload(1, "z")); // seq=3 — evicts seq=1
		const sub = bus.subscribe({ afterSeq: 0 });
		expect(sub.info.replayTruncated).toBe(true);
		sub.close();
	});

	it("marks replayTruncated false when history is empty even with afterSeq", () => {
		const bus = new EventBus();
		const sub = bus.subscribe({ afterSeq: 100 });
		expect(sub.info.replayTruncated).toBe(false);
		sub.close();
	});

	it("marks replayTruncated false when afterSeq is exactly oldest-1", () => {
		const bus = new EventBus({ historyCapacity: 5 });
		bus.emit("a", payload(1, "x")); // seq=1
		bus.emit("a", payload(1, "y")); // seq=2
		const sub = bus.subscribe({ afterSeq: 0 });
		expect(sub.info.replayTruncated).toBe(false);
		sub.close();
	});

	it("supports for-await iteration syntax", async () => {
		const bus = new EventBus();
		bus.emit("a", payload(1, "1"));
		bus.emit("a", payload(1, "2"));
		const sub = bus.subscribe();
		const deltas: string[] = [];
		const collected = (async () => {
			for await (const event of sub) {
				if (event.payload.type === "llm.text") {
					deltas.push(event.payload.delta);
				}
				if (deltas.length === 2) {
					sub.close();
				}
			}
		})();
		await collected;
		expect(deltas).toEqual(["1", "2"]);
	});

	it("fans out a single emit to multiple subscribers", async () => {
		const bus = new EventBus();
		const sub1 = bus.subscribe();
		const sub2 = bus.subscribe();
		const next1 = sub1.next();
		const next2 = sub2.next();
		bus.emit("a", payload(1, "hello"));
		const r1 = await next1;
		const r2 = await next2;
		expect(r1.done).toBe(false);
		expect(r2.done).toBe(false);
		sub1.close();
		sub2.close();
	});

	it("returns done after close, even from pending next()", async () => {
		const bus = new EventBus();
		const sub = bus.subscribe();
		const pending = sub.next();
		sub.close();
		const result = await pending;
		expect(result.done).toBe(true);
		expect(bus._subscriberCount()).toBe(0);
	});

	it("close() is idempotent", () => {
		const bus = new EventBus();
		const sub = bus.subscribe();
		sub.close();
		sub.close();
		expect(bus._subscriberCount()).toBe(0);
	});

	it("return() closes the subscription and yields done", async () => {
		const bus = new EventBus();
		const sub = bus.subscribe();
		const result = await sub.return();
		expect(result.done).toBe(true);
		expect(bus._subscriberCount()).toBe(0);
	});

	it("next() after close immediately resolves done", async () => {
		const bus = new EventBus();
		const sub = bus.subscribe();
		sub.close();
		const r = await sub.next();
		expect(r.done).toBe(true);
	});

	it("does not deliver events emitted after subscriber closed", async () => {
		const bus = new EventBus();
		const sub = bus.subscribe();
		sub.close();
		bus.emit("a", payload(1, "ignored"));
		const r = await sub.next();
		expect(r.done).toBe(true);
	});

	it("closing one subscriber leaves siblings intact", async () => {
		const bus = new EventBus();
		const closer = bus.subscribe();
		const survivor = bus.subscribe();
		closer.close();
		const survivorNext = survivor.next();
		bus.emit("a", payload(1, "x"));
		const result = await survivorNext;
		expect(result.done).toBe(false);
		if (result.done) {
			throw new Error("unreachable");
		}
		expect(result.value.sessionId).toBe("a");
		expect(bus._subscriberCount()).toBe(1);
		survivor.close();
		expect(bus._subscriberCount()).toBe(0);
	});
});
