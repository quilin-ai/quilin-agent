import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
	detectGitHubAuth,
	type FetchLike,
	type GitHubAuthContext,
	type GitHubAuthStatus,
	listStarsCount,
} from "./detector.js";

// Internal helper: detect, then return only the context (mirrors the way
// integration code wires the two functions).
async function authContextFor(status: GitHubAuthStatus): Promise<{
	context: GitHubAuthContext;
}> {
	// Synthetic detection via env_token so the token slot is populated.
	const result = await detectGitHubAuth({
		env: { GITHUB_TOKEN: "ghp_synthetic_token_for_tests_0123" },
	});
	expect(result.status.authenticated).toBe(true);
	// Override status fields the test cares about while preserving the same
	// (token-bearing) context.
	const withOverride: GitHubAuthContext = {
		...result.context,
		status,
	};
	return { context: withOverride };
}

describe("detectGitHubAuth", () => {
	it("detects auth from GITHUB_TOKEN env var", async () => {
		const result = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_envtoken_abcdef0123456789" },
		});
		expect(result.status).toEqual({
			authenticated: true,
			source: "env_token",
		});
	});

	it("falls back to GH_TOKEN when GITHUB_TOKEN absent", async () => {
		const result = await detectGitHubAuth({
			env: { GH_TOKEN: "ghp_ghtoken_abcdef0123456789" },
		});
		expect(result.status.authenticated).toBe(true);
		expect(result.status.source).toBe("env_token");
	});

	it("treats empty env token as missing", async () => {
		const result = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "   " },
		});
		expect(result.status.authenticated).toBe(false);
		expect(result.status.source).toBe("none");
	});

	it("detects auth from gh hosts.yml", async () => {
		const hostsYaml = [
			"github.com:",
			"  user: alice",
			"  oauth_token: ghu_abcdef0123456789abcdef",
			"  git_protocol: ssh",
		].join("\n");
		const result = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => hostsYaml,
		});
		expect(result.status).toEqual({
			authenticated: true,
			source: "gh_cli_hosts",
			username: "alice",
		});
	});

	it("returns structured reason when hosts.yml has no oauth_token", async () => {
		const result = await detectGitHubAuth({
			env: {},
			readGhHosts: async () =>
				["github.com:", "  user: alice", "  git_protocol: ssh"].join("\n"),
		});
		expect(result.status.authenticated).toBe(false);
		expect(result.status.source).toBe("none");
		expect(result.status.reason).toMatch(/no oauth_token/);
	});

	it("returns structured reason when hosts.yml reader throws", async () => {
		const result = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => {
				throw new Error("EACCES");
			},
		});
		expect(result.status.authenticated).toBe(false);
		expect(result.status.reason).toMatch(/EACCES/);
	});

	it("returns structured reason when nothing configured", async () => {
		const result = await detectGitHubAuth({ env: {} });
		expect(result.status.authenticated).toBe(false);
		expect(result.status.source).toBe("none");
		expect(result.status.reason).toBeDefined();
	});

	it("returns missing-reason when hosts.yml reader returns empty string", async () => {
		const result = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => "",
		});
		expect(result.status.authenticated).toBe(false);
		expect(result.status.source).toBe("none");
	});

	it("returns missing-reason when hosts.yml reader returns null", async () => {
		const result = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => null,
		});
		expect(result.status.authenticated).toBe(false);
		expect(result.status.source).toBe("none");
	});

	it("returns missing-reason when hosts.yml reader returns whitespace-only string", async () => {
		const result = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => "\n   \n",
		});
		expect(result.status.authenticated).toBe(false);
		expect(result.status.source).toBe("none");
		expect(result.status.reason).toMatch(/no GITHUB_TOKEN/);
	});

	it("handles non-Error throw from hosts.yml reader", async () => {
		const result = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => {
				throw "permission denied";
			},
		});
		expect(result.status.authenticated).toBe(false);
		expect(result.status.reason).toMatch(/permission denied/);
	});

	it("returns an opaque context that does not leak the token via JSON.stringify", async () => {
		const secret = "ghp_supersecret_must_not_leak_0123456789";
		const result = await detectGitHubAuth({
			env: { GITHUB_TOKEN: secret },
		});
		const serialized = JSON.stringify(result.context);
		expect(serialized).not.toContain(secret);
		// Status fields must still serialize.
		expect(serialized).toContain("authenticated");
	});

	it("returns an opaque context that does not leak the token via util.inspect or toString", async () => {
		const secret = "ghp_supersecret_inspect_leak_check_0123";
		const result = await detectGitHubAuth({
			env: { GITHUB_TOKEN: secret },
		});
		expect(inspect(result.context)).not.toContain(secret);
		expect(String(result.context)).not.toContain(secret);
	});

	it("returns a context (no token slot) even when unauthenticated", async () => {
		const result = await detectGitHubAuth({ env: {} });
		expect(result.context.status.authenticated).toBe(false);
		// Sanity: stringifying still works and does not throw.
		expect(() => JSON.stringify(result.context)).not.toThrow();
	});

	it("trims surrounding whitespace from env tokens before storing", async () => {
		// Whitespace in headers would otherwise corrupt the Authorization line.
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const result = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "  ghp_padded_token_value_0123  " },
		});
		await listStarsCount({ context: result.context, fetchImpl });
		const headers = fetchImpl.mock.calls[0]?.[1]?.headers ?? {};
		expect(headers.Authorization).toBe("Bearer ghp_padded_token_value_0123");
	});
});

describe("listStarsCount", () => {
	it("returns inaccessible when auth missing", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const { context } = await authContextFor({
			authenticated: false,
			source: "none",
			reason: "no token",
		});
		const out = await listStarsCount({ context, fetchImpl });
		expect(out.accessible).toBe(false);
		expect(out.totalCount).toBe(0);
		expect(out.reason).toBe("no token");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns generic reason when auth missing and no reason given", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const { context } = await authContextFor({
			authenticated: false,
			source: "none",
		});
		const out = await listStarsCount({ context, fetchImpl });
		expect(out.accessible).toBe(false);
		expect(out.reason).toMatch(/GitHub auth not detected/);
	});

	it("sends Authorization: Bearer <token> when authenticated", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () =>
				new Response("[{}]", {
					status: 200,
					headers: {
						Link: '<https://api.github.com/user/starred?per_page=1&page=137>; rel="last"',
					},
				}),
		);
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_realtoken_send_in_header_0123456" },
		});
		await listStarsCount({ context: detected.context, fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const init = fetchImpl.mock.calls[0]?.[1];
		expect(init?.headers?.Authorization).toBe(
			"Bearer ghp_realtoken_send_in_header_0123456",
		);
		expect(init?.headers?.Accept).toBe("application/vnd.github+json");
		expect(init?.headers?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
	});

	it("sends Authorization derived from gh hosts.yml token", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const hostsYaml = [
			"github.com:",
			"  user: bob",
			"  oauth_token: ghu_hosts_yml_token_abcdef0123",
			"  git_protocol: ssh",
		].join("\n");
		const detected = await detectGitHubAuth({
			env: {},
			readGhHosts: async () => hostsYaml,
		});
		await listStarsCount({ context: detected.context, fetchImpl });
		expect(fetchImpl.mock.calls[0]?.[1]?.headers?.Authorization).toBe(
			"Bearer ghu_hosts_yml_token_abcdef0123",
		);
	});

	it("rejects hand-crafted context missing a token even if status says authenticated", async () => {
		// Defensive path: someone constructed a context outside detectGitHubAuth.
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const handCrafted: GitHubAuthContext = {
			status: { authenticated: true, source: "env_token" },
		};
		const out = await listStarsCount({ context: handCrafted, fetchImpl });
		expect(out.accessible).toBe(false);
		expect(out.reason).toMatch(/missing token/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("parses total count from Link header and propagates username", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () =>
				new Response("[{}]", {
					status: 200,
					headers: {
						Link: '<https://api.github.com/user/starred?per_page=1&page=2>; rel="next", <https://api.github.com/user/starred?per_page=1&page=137>; rel="last"',
					},
				}),
		);
		// Use gh_cli_hosts source to populate username naturally — preserves the
		// WeakMap-stored token and surfaces the username on the status.
		const detected = await detectGitHubAuth({
			env: {},
			readGhHosts: async () =>
				[
					"github.com:",
					"  user: alice",
					"  oauth_token: ghu_linkheader_user_token_0123456",
					"  git_protocol: ssh",
				].join("\n"),
		});
		const out = await listStarsCount({
			context: detected.context,
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

	it("returns total 0 when no Link header and body is empty array", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_empty_body_token_0123456789abcdef" },
		});
		const out = await listStarsCount({
			context: detected.context,
			fetchImpl,
		});
		expect(out.accessible).toBe(true);
		expect(out.totalCount).toBe(0);
	});

	it("returns total 1 when no Link header and body has exactly one entry", async () => {
		// GitHub returns no Link header when there is only one page of results.
		// With per_page=1 that is exactly 0 or 1 stars; disambiguate via body.
		const fetchImpl = vi.fn<FetchLike>(
			async () =>
				new Response(JSON.stringify([{ id: 42, name: "solo-star" }]), {
					status: 200,
				}),
		);
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_single_star_token_0123456789abcdef" },
		});
		const out = await listStarsCount({
			context: detected.context,
			fetchImpl,
		});
		expect(out.accessible).toBe(true);
		expect(out.totalCount).toBe(1);
	});

	it("falls back to 0 when no Link header and body is malformed", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("not json", { status: 200 }),
		);
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_malformed_body_token_0123456789abcd" },
		});
		const out = await listStarsCount({
			context: detected.context,
			fetchImpl,
		});
		expect(out.accessible).toBe(true);
		expect(out.totalCount).toBe(0);
	});

	it("falls back to 0 when no Link header and body is non-array JSON", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () =>
				new Response(JSON.stringify({ message: "unexpected" }), {
					status: 200,
				}),
		);
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_nonarray_body_token_0123456789abcd" },
		});
		const out = await listStarsCount({
			context: detected.context,
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
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_unauthorized_test_token_0123456789" },
		});
		const out = await listStarsCount({
			context: detected.context,
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
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_network_error_token_0123456789abcd" },
		});
		const out = await listStarsCount({
			context: detected.context,
			fetchImpl,
		});
		expect(out.accessible).toBe(false);
		expect(out.reason).toMatch(/ENOTFOUND/);
	});

	it("uses overridden apiBase", async () => {
		const fetchImpl = vi.fn<FetchLike>(
			async () => new Response("[]", { status: 200 }),
		);
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_apibase_override_token_0123456789ab" },
		});
		await listStarsCount({
			context: detected.context,
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
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_malformed_link_token_0123456789abcd" },
		});
		const out = await listStarsCount({
			context: detected.context,
			fetchImpl,
		});
		expect(out.accessible).toBe(true);
		expect(out.totalCount).toBe(0);
	});

	it("handles non-Error thrown values in fetch", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			throw "boom";
		});
		const detected = await detectGitHubAuth({
			env: { GITHUB_TOKEN: "ghp_thrown_value_token_0123456789abcdef" },
		});
		const out = await listStarsCount({
			context: detected.context,
			fetchImpl,
		});
		expect(out.accessible).toBe(false);
		expect(out.reason).toMatch(/boom/);
	});
});
