/**
 * GitHub Stars detector
 *
 * 探测层（detection layer）：只检查是否能访问 GitHub API + 拿到 stars 总数，
 * 不抓取仓库内容、不写记忆。
 *
 * Detection layer: only verifies GitHub API authentication is available
 * and returns the total star count. Does not fetch repository content,
 * does not write to memory.
 */

export type GitHubAuthSource = "env_token" | "gh_cli_hosts" | "none";

export interface GitHubAuthStatus {
	readonly authenticated: boolean;
	readonly source: GitHubAuthSource;
	readonly username?: string;
	readonly reason?: string;
}

export interface GitHubStarsCount {
	readonly accessible: boolean;
	readonly totalCount: number;
	readonly username?: string;
	readonly reason?: string;
}

export interface DetectGitHubAuthOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly readGhHosts?: () => Promise<string | null>;
}

/**
 * Minimal callable surface we need from `fetch`. We intentionally do NOT use
 * `typeof fetch` because `Response`-returning closures (used in tests) cannot
 * satisfy the `preconnect` method on the global `fetch` type.
 */
export type FetchLike = (
	url: string,
	init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

export interface ListStarsCountOptions {
	readonly auth: GitHubAuthStatus;
	/**
	 * Injected fetch implementation. Required — callers must pass either
	 * `globalThis.fetch` or a wrapper. We do not default to global fetch so
	 * that detection paths can be exercised offline in tests / CI.
	 */
	readonly fetchImpl: FetchLike;
	readonly apiBase?: string;
}

const DEFAULT_API_BASE = "https://api.github.com";

const GH_HOSTS_USER_REGEX = /^\s{2,}user:\s*([A-Za-z0-9-]+)\s*$/m;
const GH_HOSTS_TOKEN_REGEX = /^\s{2,}oauth_token:\s*([A-Za-z0-9_]+)\s*$/m;

/**
 * Determine whether the host machine has a GitHub credential available.
 *
 * Order of precedence:
 *   1. `GITHUB_TOKEN` / `GH_TOKEN` env var (CI-friendly)
 *   2. `~/.config/gh/hosts.yml` from the `gh` CLI (developer-friendly)
 */
export async function detectGitHubAuth(
	options: DetectGitHubAuthOptions = {},
): Promise<GitHubAuthStatus> {
	const env = options.env ?? {};
	const envToken = env.GITHUB_TOKEN ?? env.GH_TOKEN;
	if (typeof envToken === "string" && envToken.trim().length > 0) {
		return {
			authenticated: true,
			source: "env_token",
		};
	}

	if (options.readGhHosts) {
		try {
			const raw = await options.readGhHosts();
			if (raw && raw.trim().length > 0) {
				const username = GH_HOSTS_USER_REGEX.exec(raw)?.[1];
				const tokenMatch = GH_HOSTS_TOKEN_REGEX.exec(raw)?.[1];
				if (tokenMatch && tokenMatch.length > 0) {
					return {
						authenticated: true,
						source: "gh_cli_hosts",
						username,
					};
				}
				return {
					authenticated: false,
					source: "none",
					reason: "gh hosts.yml present but no oauth_token field",
				};
			}
		} catch (error: unknown) {
			return {
				authenticated: false,
				source: "none",
				reason: `gh hosts.yml read failed: ${getErrorMessage(error)}`,
			};
		}
	}

	return {
		authenticated: false,
		source: "none",
		reason:
			"no GITHUB_TOKEN / GH_TOKEN env var and no gh hosts.yml reader provided",
	};
}

/**
 * Call GitHub API `/user/starred?per_page=1` and read the `Link` header to
 * compute the total star count without fetching every page.
 *
 * Returns only metadata — no repo content is loaded.
 */
export async function listStarsCount(
	options: ListStarsCountOptions,
): Promise<GitHubStarsCount> {
	if (!options.auth.authenticated) {
		return {
			accessible: false,
			totalCount: 0,
			reason: options.auth.reason ?? "GitHub auth not detected",
		};
	}

	const fetchImpl = options.fetchImpl;
	const apiBase = options.apiBase ?? DEFAULT_API_BASE;
	const url = `${apiBase}/user/starred?per_page=1`;

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error: unknown) {
		return {
			accessible: false,
			totalCount: 0,
			reason: `network error: ${getErrorMessage(error)}`,
		};
	}

	if (!response.ok) {
		return {
			accessible: false,
			totalCount: 0,
			reason: `GitHub API ${response.status} ${response.statusText}`,
		};
	}

	const linkHeader =
		response.headers.get("link") ?? response.headers.get("Link");
	const totalCount = parseLastPageFromLinkHeader(linkHeader);

	return {
		accessible: true,
		totalCount,
		username: options.auth.username,
	};
}

function parseLastPageFromLinkHeader(linkHeader: string | null): number {
	if (!linkHeader) {
		// No Link header → 0 or 1 starred repo. Use 0 as the safe lower bound;
		// callers should treat this as "very few stars, exact count unknown".
		return 0;
	}
	// Format: <https://api.github.com/...&page=42>; rel="last", <...>; rel="first"
	const lastMatch = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/i.exec(
		linkHeader,
	);
	if (lastMatch?.[1]) {
		// The capture group already matched `\d+`, so parseInt always returns a
		// finite non-negative integer here.
		return Number.parseInt(lastMatch[1], 10);
	}
	return 0;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
