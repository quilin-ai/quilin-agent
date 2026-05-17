import { describe, expect, it } from "vitest";
import { detectXBookmarksAccessible } from "./detector.js";

describe("detectXBookmarksAccessible", () => {
	it("returns no_credentials when nothing provided", () => {
		const out = detectXBookmarksAccessible();
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("no_credentials");
		expect(out.reason?.message).toMatch(/OAuth 2.0/);
	});

	it("returns no_credentials when credentials is explicitly null", () => {
		const out = detectXBookmarksAccessible({ credentials: null });
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("no_credentials");
	});

	it("rejects oauth1_user tokens", () => {
		const out = detectXBookmarksAccessible({
			credentials: { kind: "oauth1_user" },
		});
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("wrong_auth_kind");
		expect(out.reason?.message).toMatch(/oauth1_user/);
	});

	it("rejects app_only_bearer tokens", () => {
		const out = detectXBookmarksAccessible({
			credentials: { kind: "app_only_bearer" },
		});
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("wrong_auth_kind");
	});

	it("rejects oauth2 tokens missing bookmark.read scope", () => {
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				scopes: ["tweet.read", "users.read"],
				authenticatedUserId: "12345",
			},
		});
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("missing_scope");
		expect(out.reason?.message).toMatch(/bookmark\.read/);
	});

	it("rejects oauth2 tokens with empty scope list", () => {
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				authenticatedUserId: "12345",
			},
		});
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("missing_scope");
	});

	it("rejects expired oauth2 tokens", () => {
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				scopes: ["bookmark.read", "tweet.read"],
				authenticatedUserId: "12345",
				expiresAt: new Date("2024-01-01T00:00:00Z"),
			},
			now: () => new Date("2026-01-01T00:00:00Z"),
		});
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("expired_or_revoked");
		expect(out.reason?.message).toMatch(/2024-01-01/);
	});

	it("treats token expiring exactly at `now` as expired", () => {
		const stamp = new Date("2026-05-15T12:00:00Z");
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				scopes: ["bookmark.read"],
				authenticatedUserId: "12345",
				expiresAt: stamp,
			},
			now: () => stamp,
		});
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("expired_or_revoked");
	});

	it("rejects oauth2 tokens missing authenticatedUserId", () => {
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				scopes: ["bookmark.read"],
			},
		});
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("missing_authenticated_user_id");
	});

	it("rejects oauth2 tokens with whitespace-only authenticatedUserId", () => {
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				scopes: ["bookmark.read"],
				authenticatedUserId: "   ",
			},
		});
		expect(out.accessible).toBe(false);
		expect(out.reason?.code).toBe("missing_authenticated_user_id");
	});

	it("returns accessible for valid non-expiring oauth2 token", () => {
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				scopes: ["bookmark.read", "tweet.read", "users.read"],
				authenticatedUserId: "999000111",
			},
		});
		expect(out).toEqual({
			accessible: true,
			authenticatedUserId: "999000111",
		});
	});

	it("returns accessible for valid future-expiring oauth2 token", () => {
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				scopes: ["bookmark.read"],
				authenticatedUserId: "42",
				expiresAt: new Date("2027-01-01T00:00:00Z"),
			},
			now: () => new Date("2026-01-01T00:00:00Z"),
		});
		expect(out.accessible).toBe(true);
		expect(out.authenticatedUserId).toBe("42");
	});

	it("uses real Date.now when `now` injection is omitted", () => {
		const out = detectXBookmarksAccessible({
			credentials: {
				kind: "oauth2_user_context",
				scopes: ["bookmark.read"],
				authenticatedUserId: "1",
				// Far future — must be accepted by real Date.now()
				expiresAt: new Date(Date.now() + 10 * 60 * 1000),
			},
		});
		expect(out.accessible).toBe(true);
	});
});
