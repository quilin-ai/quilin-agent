import { describe, expect, it, vi } from "vitest";
import {
	detectGitHubAuth,
	type FetchLike,
	listStarsCount,
} from "./detector.js";

describe("detectGitHubAuth", () => {
	it("detects auth from GITHUB_TOKEN env var", async () => {
		const status = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_envtoken_abcdef0123456789" },
		});
		expect(status).toEqual({
			authenticated: true,
			source: "env_token",
		});
	});

	it("falls back to GH_TOKEN when GITHUB_TOKEN absent", async () => {
		const status = await detectGitHubAuth({
			env: { GH_TOKEN: "ghp_ghtoken_abcdef0123456789" },
		});
		expect(status.authenticated).toBe(true);
		expect(status.source).toBe("env_token");
	});

	it("treats empty env token as missing", async () => {
		const status = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "   " },
		});
		expect(status.authenticated).toBe(false);
		expect(status.source).toBe("none");
	});

	it("detects auth from gh hosts.yml", async () => {
		const hostsYaml = [
			"github.com:",
			"  user: alice",
			"  oauth_token: ghu_abcdef0123456789abcdef",
			"  git_protocol: ssh",
		].join("\n");
		const status = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => hostsYaml,
		});
		expect(status).toEqual({
			authenticated: true,
			source: "gh_cli_hosts",
			username: "alice",
		});
	});

	it("returns structured reason when hosts.yml has no oauth_token", async () => {
		const status = await detectGitHubAuth({
			env: {},
			readGhHosts: async () =>
				["github.com:", "  user: alice", "  git_protocol: ssh"].join("\n"),
		});
		expect(status.authenticated).toBe(false);
		expect(status.source).toBe("none");
		expect(status.reason).toMatch(/no oauth_token/);
	});

	it("returns structured reason when hosts.yml reader throws", async () => {
		const status = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => {
				throw new Error("EACCES");
			},
		});
		expect(status.authenticated).toBe(false);
		expect(status.reason).toMatch(/EACCES/);
	});

	it("returns structured reason when nothing configured", async () => {
		const status = await detectGitHubAuth({ env: {} });
		expect(status.authenticated).toBe(false);
		expect(status.source).toBe("none");
		expect(status.reason).toBeDefined();
	});

	it("returns missing-reason when hosts.yml reader returns empty string", async () => {
		const status = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => "",
		});
		expect(status.authenticated).toBe(false);
		expect(status.source).toBe("none");
	});

	it("returns missing-reason when hosts.yml reader returns null", async () => {
		const status = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => null,
		});
		expect(status.authenticated).toBe(false);
		expect(status.source).toBe("none");
	});

	it("returns missing-reason when hosts.yml reader returns whitespace-only string", async () => {
		const status = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => "\n   \n",
		});
		expect(status.authenticated).toBe(false);
		expect(status.source).toBe("none");
		expect(status.reason).toMatch(/no GITHUB_TOKEN/);
	});

	it("handles non-Error throw from hosts.yml reader", async () => {
		const status = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => {
				throw "permission denied";
			},
		});
		expect(status.authenticated).toBe(false);
		expect(status.reason).toMatch(/permission denied/);
	});
});

describe("listStarsCount", () => {
	it("returns inaccessible when auth missing", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const out = await listStarsCount({
			auth: {
				authenticated: false,
				source: "none",
				reason: "no token",
			},
			fetchImpl,
		});
		expect(out.accessible).toBe(false);
		expect(out.totalCount).toBe(0);
		expect(out.reason).toBe("no token");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns generic reason when auth missing and no reason given", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const out = await listStarsCount({
			auth: { authenticated: false, source: "none" },
			fetchImpl,
		});
		expect(out.accessible).toBe(false);
		expect(out.reason).toMatch(/GitHub auth not detected/);
	});

	it("parses total count from Link header", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () =>
				new Response("[{}]", {
					status: 200,
					headers: {
						Link: '<https://api.github.com/user/starred?per_page=1&page=2>; rel="next", <https://api.github.com/user/starred?per_page=1&page=137>; rel="last"',
					},
				}),
		);
		const out = await listStarsCount({
			auth: {
				authenticated: true,
				source: "env_token",
				username: "alice",
			},
			fetchImpl,
		});
		expect(out).toEqual({
			accessible: true,
			totalCount: 137,
			username: "alice",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const call = fetchImpl.mock.calls[0];
		expect(String(call?.[0])).toContain("/user/starred?per_page=1");
	});

	it("returns total 0 when no Link header (fewer than 2 stars)", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const out = await listStarsCount({
			auth: { authenticated: true, source: "env_token" },
			fetchImpl,
		});
		expect(out.accessible).toBe(true);
		expect(out.totalCount).toBe(0);
	});

	it("returns structured reason on non-2xx response", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () =>
				new Response("Unauthorized", {
					status: 401,
					statusText: "Unauthorized",
				}),
		);
		const out = await listStarsCount({
			auth: { authenticated: true, source: "env_token" },
			fetchImpl,
		});
		expect(out.accessible).toBe(false);
		expect(out.totalCount).toBe(0);
		expect(out.reason).toMatch(/401/);
	});

	it("returns structured reason on network error", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			throw new Error("ENOTFOUND");
		});
		const out = await listStarsCount({
			auth: { authenticated: true, source: "env_token" },
			fetchImpl,
		});
		expect(out.accessible).toBe(false);
		expect(out.reason).toMatch(/ENOTFOUND/);
	});

	it("uses overridden apiBase", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		await listStarsCount({
			auth: { authenticated: true, source: "env_token" },
			fetchImpl,
			apiBase: "https://github.example.com/api/v3",
		});
		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
			"https://github.example.com/api/v3/user/starred",
		);
	});

	it("ignores malformed Link header gracefully", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () =>
				new Response("[]", {
					status: 200,
					headers: { Link: "<garbage>; rel=last" },
				}),
		);
		const out = await listStarsCount({
			auth: { authenticated: true, source: "env_token" },
			fetchImpl,
		});
		expect(out.accessible).toBe(true);
		expect(out.totalCount).toBe(0);
	});

	it("handles non-Error thrown values in fetch", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			throw "boom";
		});
		const out = await listStarsCount({
			auth: { authenticated: true, source: "env_token" },
			fetchImpl,
		});
		expect(out.accessible).toBe(false);
		expect(out.reason).toMatch(/boom/);
	});
});
