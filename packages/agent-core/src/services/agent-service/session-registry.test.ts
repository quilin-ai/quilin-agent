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

describe("SessionRegistry.create with Task #30 subagent topology fields", () => {
	it("stores parentId when caller provides it (subagent spawn)", () => {
		const reg = new SessionRegistry();
		const child = reg.create({
			origin: "api",
			id: "subagent-1",
			parentId: "main-session",
		});
		expect(child.parentId).toBe("main-session");
	});

	it("stores task when caller provides it (subagent spawn)", () => {
		const reg = new SessionRegistry();
		const child = reg.create({
			origin: "api",
			id: "subagent-1",
			task: "lint the diff",
		});
		expect(child.task).toBe("lint the diff");
	});

	it("leaves parentId and task undefined for top-level sessions", () => {
		const reg = new SessionRegistry();
		const top = reg.create({ origin: "tui", id: "top-1" });
		expect(top.parentId).toBeUndefined();
		expect(top.task).toBeUndefined();
	});

	it("supports filtering sessions by parentId for parent → children topology queries", () => {
		const reg = new SessionRegistry();
		reg.create({ origin: "web", id: "main" });
		reg.create({ origin: "api", id: "child-1", parentId: "main" });
		reg.create({ origin: "api", id: "child-2", parentId: "main" });
		reg.create({ origin: "api", id: "orphan" });
		const children = reg.list().filter((s) => s.parentId === "main");
		expect(children.map((s) => s.id).sort()).toEqual(["child-1", "child-2"]);
	});

	it("preserves parentId and task through immutable update()", () => {
		const reg = new SessionRegistry();
		reg.create({
			origin: "api",
			id: "subagent-update",
			parentId: "main",
			task: "review",
		});
		const updated = reg.update("subagent-update", { status: "running" });
		expect(updated.parentId).toBe("main");
		expect(updated.task).toBe("review");
		expect(updated.status).toBe("running");
	});
});

describe("SessionRegistry.create with explicit id", () => {
	it("uses the caller-supplied id verbatim when provided", () => {
		const registry = new SessionRegistry({
			idGen: () => "auto-generated",
		});
		const session = registry.create({
			origin: "web",
			id: "client-supplied-id",
		});
		expect(session.id).toBe("client-supplied-id");
		expect(registry.get("client-supplied-id")).not.toBeNull();
		expect(registry.get("auto-generated")).toBeNull();
	});

	it("throws when the explicit id collides with an existing session", () => {
		const registry = new SessionRegistry();
		registry.create({ origin: "web", id: "dup" });
		expect(() => registry.create({ origin: "tui", id: "dup" })).toThrow(
			/collision/,
		);
	});

	it("falls back to idGen when id is omitted (backward compat)", () => {
		let counter = 0;
		const registry = new SessionRegistry({
			idGen: () => `auto-${++counter}`,
		});
		const a = registry.create({ origin: "web" });
		const b = registry.create({ origin: "web" });
		expect(a.id).toBe("auto-1");
		expect(b.id).toBe("auto-2");
	});
});

describe("SessionRegistry.delete", () => {
	it("removes a known session and returns true", () => {
		let counter = 0;
		const registry = new SessionRegistry({ idGen: () => `d${++counter}` });
		registry.create({ origin: "web" });
		expect(registry.size()).toBe(1);
		expect(registry.delete("d1")).toBe(true);
		expect(registry.size()).toBe(0);
		expect(registry.get("d1")).toBeNull();
	});

	it("returns false when the session id is unknown", () => {
		const registry = new SessionRegistry();
		expect(registry.delete("missing")).toBe(false);
	});

	it("does not emit anything (silent removal)", () => {
		// SessionRegistry has no event bus; this test simply documents the
		// contract that delete is silent — callers must emit termination
		// events themselves before calling delete.
		let counter = 0;
		const registry = new SessionRegistry({ idGen: () => `s${++counter}` });
		registry.create({ origin: "web" });
		registry.delete("s1");
		expect(registry.list()).toEqual([]);
	});
});

describe("SessionRegistry.evictLruIfOver", () => {
	it("returns [] and is a no-op when size is at or below the cap", () => {
		let counter = 0;
		const registry = new SessionRegistry({
			idGen: () => `lru${++counter}`,
			clock: fixedClock(1_700_000_000_000, 60_000),
		});
		registry.create({ origin: "web" });
		registry.create({ origin: "web" });
		expect(registry.evictLruIfOver(5)).toEqual([]);
		expect(registry.evictLruIfOver(2)).toEqual([]);
		expect(registry.size()).toBe(2);
	});

	it("evicts the oldest-by-lastActiveAt session when over cap", () => {
		let counter = 0;
		const registry = new SessionRegistry({
			idGen: () => `lru${++counter}`,
			clock: fixedClock(1_700_000_000_000, 60_000),
		});
		registry.create({ origin: "web" }); // lru1 → t0
		registry.create({ origin: "web" }); // lru2 → t60
		registry.create({ origin: "web" }); // lru3 → t120
		// Touch lru1 so it's newest now.
		registry.update("lru1", { touch: true });
		const evicted = registry.evictLruIfOver(2);
		expect(evicted).toEqual(["lru2"]);
		expect(registry.size()).toBe(2);
		expect(registry.get("lru1")).not.toBeNull();
		expect(registry.get("lru3")).not.toBeNull();
		expect(registry.get("lru2")).toBeNull();
	});

	it("evicts multiple sessions when far over cap", () => {
		let counter = 0;
		const registry = new SessionRegistry({
			idGen: () => `lru${++counter}`,
			clock: fixedClock(1_700_000_000_000, 60_000),
		});
		for (let i = 0; i < 5; i += 1) registry.create({ origin: "web" });
		const evicted = registry.evictLruIfOver(2);
		expect(evicted).toEqual(["lru1", "lru2", "lru3"]);
		expect(registry.size()).toBe(2);
	});

	it("treats negative cap as 0 (evict everything)", () => {
		let counter = 0;
		const registry = new SessionRegistry({
			idGen: () => `lru${++counter}`,
			clock: fixedClock(1_700_000_000_000, 60_000),
		});
		registry.create({ origin: "web" });
		registry.create({ origin: "web" });
		const evicted = registry.evictLruIfOver(-1);
		expect(evicted).toHaveLength(2);
		expect(registry.size()).toBe(0);
	});
});
