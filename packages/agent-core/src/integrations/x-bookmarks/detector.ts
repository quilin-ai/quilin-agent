/**
 * X (Twitter) bookmarks detector
 *
 * 探测层（detection layer）：判断 X bookmarks 是否可达，并给出结构化的
 * 「为什么不可达」原因。Bookmarks 必须 OAuth 2.0 user-context access token
 * 才能读取（OAuth1 / app-only bearer 不支持），因此默认期望「不可达」。
 *
 * Detection layer: determines whether X bookmarks are reachable, and emits a
 * structured "why not" reason. Bookmarks require an OAuth 2.0 user-context
 * access token (OAuth1 and app-only bearer tokens cannot read bookmarks),
 * so the default state is "not accessible".
 */

export type XAccessIneligibleReason =
	| "no_credentials"
	| "wrong_auth_kind"
	| "missing_scope"
	| "expired_or_revoked"
	| "missing_authenticated_user_id";

export interface XAccessReasonDetail {
	readonly code: XAccessIneligibleReason;
	readonly message: string;
}

export interface XBookmarksAccessibility {
	readonly accessible: boolean;
	readonly authenticatedUserId?: string;
	readonly reason?: XAccessReasonDetail;
}

export interface XCredentialBundle {
	readonly kind: "oauth2_user_context" | "oauth1_user" | "app_only_bearer";
	/** Lowercased scope strings granted with the token. */
	readonly scopes?: readonly string[];
	readonly accessToken?: string;
	readonly expiresAt?: Date;
	/** The numeric / string id of the authenticated X user. */
	readonly authenticatedUserId?: string;
}

export interface DetectXBookmarksOptions {
	readonly credentials?: XCredentialBundle | null;
	readonly now?: () => Date;
}

const REQUIRED_SCOPE = "bookmark.read";

/**
 * Pure synchronous classifier that turns a credential bundle into an
 * accessibility verdict. No network calls — this is intentionally a
 * "do we even have a shot?" gate that runs offline.
 */
export function detectXBookmarksAccessible(
	options: DetectXBookmarksOptions = {},
): XBookmarksAccessibility {
	const creds = options.credentials;
	if (!creds) {
		return {
			accessible: false,
			reason: {
				code: "no_credentials",
				message:
					"no X credentials provided — bookmarks require an OAuth 2.0 user-context access token",
			},
		};
	}

	if (creds.kind !== "oauth2_user_context") {
		return {
			accessible: false,
			reason: {
				code: "wrong_auth_kind",
				message: `X bookmarks require oauth2_user_context, but got ${creds.kind}`,
			},
		};
	}

	const scopes = creds.scopes ?? [];
	if (!scopes.includes(REQUIRED_SCOPE)) {
		return {
			accessible: false,
			reason: {
				code: "missing_scope",
				message: `X token is missing required scope "${REQUIRED_SCOPE}"`,
			},
		};
	}

	if (creds.expiresAt) {
		const now = (options.now ?? (() => new Date()))();
		if (creds.expiresAt.getTime() <= now.getTime()) {
			return {
				accessible: false,
				reason: {
					code: "expired_or_revoked",
					message: `X access token expired at ${creds.expiresAt.toISOString()}`,
				},
			};
		}
	}

	if (
		!creds.authenticatedUserId ||
		creds.authenticatedUserId.trim().length === 0
	) {
		return {
			accessible: false,
			reason: {
				code: "missing_authenticated_user_id",
				message:
					"OAuth 2.0 user-context token present but authenticated user id is unknown",
			},
		};
	}

	return {
		accessible: true,
		authenticatedUserId: creds.authenticatedUserId,
	};
}
