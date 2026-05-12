import { describe, expect, it } from "vitest";

import { DEFAULT_SESSION_TITLE, SessionRegistry } from "./session-registry.js";

function fixedClock(start: number, stepMs = 1): () => Date {
	let current = start;
	return () => {
		const d = new Date(current);
		current += stepMs;
		return d;
	};
}

describe("SessionRegistry.create", () => {
	it("assigns id, default title, idle status, and 0 turn count", () => {
		const registry = new SessionRegistry({
			idGen: () => "sess_test",
			clock: fixedClock(1_700_000_000_000),
		});
		const session = registry.create({ origin: "tui" });
		expect(session.id).toBe("sess_test");
		expect(session.title).toBe(DEFAULT_SESSION_TITLE);
		expect(session.origin).toBe("tui");
		expect(session.status).toBe("idle");
		expect(session.turnCount).toBe(0);
		expect(session.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
		expect(session.lastActiveAt).toBe(session.createdAt);
	});

	it("respects a caller-provided title", () => {
		const registry = new SessionRegistry({ idGen: () => "id" });
		const session = registry.create({ origin: "web", title: "Hello" });
		expect(session.title).toBe("Hello");
	});

	it("uses caller-provided defaultTitle when no title is supplied", () => {
		const registry = new SessionRegistry({
			idGen: () => "id",
			defaultTitle: "Untitled",
		});
		const session = registry.create({ origin: "api" });
		expect(session.title).toBe("Untitled");
	});

	it("throws on id collision", () => {
		const registry = new SessionRegistry({ idGen: () => "dup" });
		registry.create({ origin: "tui" });
		expect(() => registry.create({ origin: "tui" })).toThrow(/collision/);
	});

	it("falls back to a counter-based id when no idGen is provided", () => {
		const registry = new SessionRegistry({ clock: fixedClock(0) });
		const a = registry.create({ origin: "tui" });
		const b = registry.create({ origin: "tui" });
		expect(a.id).not.toBe(b.id);
		expect(a.id.startsWith("sess_")).toBe(true);
		expect(b.id.startsWith("sess_")).toBe(true);
	});
});

describe("SessionRegistry.get / list / size", () => {
	it("returns null for unknown ids", () => {
		const registry = new SessionRegistry({ idGen: () => "x" });
		expect(registry.get("missing")).toBeNull();
	});

	it("returns the registered session", () => {
		const registry = new SessionRegistry({ idGen: () => "kept" });
		const session = registry.create({ origin: "web" });
		expect(registry.get("kept")).toEqual(session);
	});

	it("list returns all sessions in insertion order", () => {
		let counter = 0;
		const idGen = (): string => {
			counter += 1;
			return `id-${counter}`;
		};
		const registry = new SessionRegistry({ idGen });
		registry.create({ origin: "tui" });
		registry.create({ origin: "web" });
		registry.create({ origin: "api" });
		const ids = registry.list().map((s) => s.id);
		expect(ids).toEqual(["id-1", "id-2", "id-3"]);
	});

	it("size matches the number of registered sessions", () => {
		let counter = 0;
		const idGen = (): string => {
			counter += 1;
			return `id-${counter}`;
		};
		const registry = new SessionRegistry({ idGen });
		expect(registry.size()).toBe(0);
		registry.create({ origin: "tui" });
		expect(registry.size()).toBe(1);
		registry.create({ origin: "tui" });
		expect(registry.size()).toBe(2);
	});
});

describe("SessionRegistry.update", () => {
	it("applies title, status, and turnCount patches and returns a new object", () => {
		const registry = new SessionRegistry({
			idGen: () => "u1",
			clock: fixedClock(1_700_000_000_000),
		});
		const original = registry.create({ origin: "tui" });
		const updated = registry.update("u1", {
			title: "New title",
			status: "running",
			turnCount: 3,
		});
		expect(updated).not.toBe(original);
		expect(updated.title).toBe("New title");
		expect(updated.status).toBe("running");
		expect(updated.turnCount).toBe(3);
		// Original snapshot is untouched (immutability).
		expect(original.title).toBe(DEFAULT_SESSION_TITLE);
	});

	it("leaves fields unchanged when their patch entry is omitted", () => {
		const registry = new SessionRegistry({ idGen: () => "u2" });
		registry.create({ origin: "web", title: "Keep me" });
		const updated = registry.update("u2", { status: "completed" });
		expect(updated.title).toBe("Keep me");
		expect(updated.turnCount).toBe(0);
	});

	it("updates lastActiveAt only when touch=true", () => {
		const clock = fixedClock(1_700_000_000_000, 60_000);
		const registry = new SessionRegistry({ idGen: () => "u3", clock });
		const original = registry.create({ origin: "tui" });
		const notTouched = registry.update("u3", { status: "running" });
		expect(notTouched.lastActiveAt).toBe(original.lastActiveAt);

		const touched = registry.update("u3", { touch: true });
		expect(touched.lastActiveAt).not.toBe(original.lastActiveAt);
	});

	it("throws on unknown session id", () => {
		const registry = new SessionRegistry({ idGen: () => "id" });
		expect(() => registry.update("missing", { title: "x" })).toThrow(/unknown/);
	});

	it("get() returns the latest snapshot after update", () => {
		const registry = new SessionRegistry({ idGen: () => "u4" });
		registry.create({ origin: "tui" });
		registry.update("u4", { title: "Updated" });
		expect(registry.get("u4")?.title).toBe("Updated");
	});
});
