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

/**
 * Opaque credential handle passed from `detectGitHubAuth` to `listStarsCount`.
 *
 * The token is held inside a private slot and is NEVER exposed via:
 *   - public fields on the object
 *   - `JSON.stringify(context)` (overridden `toJSON`)
 *   - `console.log(context)` / `util.inspect(context)` (overridden custom
 *     inspect symbol)
 *   - default `toString(context)`
 *
 * Callers receive a `GitHubAuthContext` but cannot read the token directly —
 * only `listStarsCount` (which lives in this module) uses the internal
 * accessor. This avoids accidental leakage into logs, error reports, or
 * structured cloning across worker boundaries.
 *
 * 不可见的凭证句柄：token 保存在内部槽位，对外不暴露字段，也不会被
 * JSON.stringify / console.log / util.inspect 序列化出来，避免日志泄漏。
 */
export interface GitHubAuthContext {
	readonly status: GitHubAuthStatus;
}

export interface ListStarsCountOptions {
	readonly context: GitHubAuthContext;
	/**
	 * Injected fetch implementation. Required — callers must pass either
	 * `globalThis.fetch` or a wrapper. We do not default to global fetch so
	 * that detection paths can be exercised offline in tests / CI.
	 */
	readonly fetchImpl: FetchLike;
	readonly apiBase?: string;
}

export interface DetectGitHubAuthResult {
	readonly status: GitHubAuthStatus;
	readonly context: GitHubAuthContext;
}

const DEFAULT_API_BASE = "https://api.github.com";

const GH_HOSTS_USER_REGEX = /^\s{2,}user:\s*([A-Za-z0-9-]+)\s*$/m;
const GH_HOSTS_TOKEN_REGEX = /^\s{2,}oauth_token:\s*([A-Za-z0-9_]+)\s*$/m;

// WeakMap from public context object → secret token. The context object the
// caller holds has no own property pointing at the token, so accidental
// serialization (JSON / inspect) cannot reach it.
const tokenSlot = new WeakMap<GitHubAuthContext, string>();

function createAuthContext(
	status: GitHubAuthStatus,
	token: string | undefined,
): GitHubAuthContext {
	const ctx: GitHubAuthContext & {
		toJSON?: () => unknown;
		toString?: () => string;
		[key: symbol]: unknown;
	} = { status };
	// Defend against serialization leaks.
	Object.defineProperty(ctx, "toJSON", {
		value: () => ({ status }),
		enumerable: false,
	});
	Object.defineProperty(ctx, "toString", {
		value: () => "[GitHubAuthContext]",
		enumerable: false,
	});
	Object.defineProperty(ctx, Symbol.for("nodejs.util.inspect.custom"), {
		value: () => "[GitHubAuthContext]",
		enumerable: false,
	});
	const frozen = Object.freeze(ctx) as GitHubAuthContext;
	if (token !== undefined && token.length > 0) {
		tokenSlot.set(frozen, token);
	}
	return frozen;
}

function readToken(context: GitHubAuthContext): string | undefined {
	return tokenSlot.get(context);
}

/**
 * Determine whether the host machine has a GitHub credential available.
 *
 * Order of precedence:
 *   1. `GITHUB_TOKEN` / `GH_TOKEN` env var (CI-friendly)
 *   2. `~/.config/gh/hosts.yml` from the `gh` CLI (developer-friendly)
 *
 * Returns both a public `status` (safe to log / serialize) and an opaque
 * `context` carrying the secret token (must be passed to `listStarsCount`
 * to authenticate API calls).
 *
 * 同时返回可安全序列化的 status 和承载 token 的不透明 context；
 * 调用 listStarsCount 时必须传 context，否则请求将走未认证路径。
 */
export async function detectGitHubAuth(
	options: DetectGitHubAuthOptions = {},
): Promise<DetectGitHubAuthResult> {
	const env = options.env ?? {};
	const envTokenRaw = env.GITHUB_TOKEN ?? env.GH_TOKEN;
	if (typeof envTokenRaw === "string" && envTokenRaw.trim().length > 0) {
		const status: GitHubAuthStatus = {
			authenticated: true,
			source: "env_token",
		};
		// Preserve the trimmed token: trailing whitespace breaks `Authorization`
		// headers, and a token that was empty after trimming has already been
		// rejected above.
		return {
			status,
			context: createAuthContext(status, envTokenRaw.trim()),
		};
	}

	if (options.readGhHosts) {
		try {
			const raw = await options.readGhHosts();
			if (raw && raw.trim().length > 0) {
				const username = GH_HOSTS_USER_REGEX.exec(raw)?.[1];
				const tokenMatch = GH_HOSTS_TOKEN_REGEX.exec(raw)?.[1];
				if (tokenMatch && tokenMatch.length > 0) {
					const status: GitHubAuthStatus = {
						authenticated: true,
						source: "gh_cli_hosts",
						username,
					};
					return {
						status,
						context: createAuthContext(status, tokenMatch),
					};
				}
				const status: GitHubAuthStatus = {
					authenticated: false,
					source: "none",
					reason: "gh hosts.yml present but no oauth_token field",
				};
				return { status, context: createAuthContext(status, undefined) };
			}
		} catch (error: unknown) {
			const status: GitHubAuthStatus = {
				authenticated: false,
				source: "none",
				reason: `gh hosts.yml read failed: ${getErrorMessage(error)}`,
			};
			return { status, context: createAuthContext(status, undefined) };
		}
	}

	const status: GitHubAuthStatus = {
		authenticated: false,
		source: "none",
		reason:
			"no GITHUB_TOKEN / GH_TOKEN env var and no gh hosts.yml reader provided",
	};
	return { status, context: createAuthContext(status, undefined) };
}

/**
 * Call GitHub API `/user/starred?per_page=1` and read the `Link` header to
 * compute the total star count without fetching every page.
 *
 * Returns only metadata — no repo content is loaded.
 *
 * Authorization is provided via `options.context` (returned by
 * `detectGitHubAuth`). The token is read from an internal WeakMap and sent
 * as `Authorization: Bearer <token>` per GitHub REST API v3 guidance.
 *
 * 通过 context 中保存的 token 以 `Bearer` 形式发送 Authorization 头，
 * 避免走未认证路径触发 60/h 限流，并允许返回 private starred 仓库。
 */
export async function listStarsCount(
	options: ListStarsCountOptions,
): Promise<GitHubStarsCount> {
	const { context } = options;
	if (!context.status.authenticated) {
		return {
			accessible: false,
			totalCount: 0,
			reason: context.status.reason ?? "GitHub auth not detected",
		};
	}

	const token = readToken(context);
	if (!token) {
		// Defensive: status says authenticated but token slot empty. This can
		// only happen if a caller hand-crafted a context object instead of
		// using `detectGitHubAuth`. Treat as auth failure rather than silently
		// sending an unauthenticated request.
		return {
			accessible: false,
			totalCount: 0,
			reason:
				"GitHub auth context missing token (did you construct it manually instead of using detectGitHubAuth?)",
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
				Authorization: `Bearer ${token}`,
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
	if (linkHeader) {
		const total = parseLastPageFromLinkHeader(linkHeader);
		return {
			accessible: true,
			totalCount: total,
			username: context.status.username,
		};
	}

	// No Link header → GitHub returned a single page of results. With
	// `per_page=1`, that means the user has either 0 or 1 starred repos.
	// Disambiguate by inspecting the response body length (cheap: 0 or 1 row).
	const total = await readBodyArrayLength(response);
	return {
		accessible: true,
		totalCount: total,
		username: context.status.username,
	};
}

function parseLastPageFromLinkHeader(linkHeader: string): number {
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

async function readBodyArrayLength(response: Response): Promise<number> {
	try {
		const text = await response.text();
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			return 0;
		}
		const parsed: unknown = JSON.parse(trimmed);
		if (Array.isArray(parsed)) {
			return parsed.length;
		}
		// Unexpected shape — fall back to the safe lower bound rather than
		// throwing, so detection never crashes the agent loop.
		return 0;
	} catch {
		// Malformed body — treat as 0 (matches the previous "safe lower bound"
		// behaviour for unknown count situations).
		return 0;
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
