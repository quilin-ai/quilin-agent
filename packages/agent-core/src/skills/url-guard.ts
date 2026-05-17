/**
 * SSRF / 协议 / OOM 守卫 / SSRF / Protocol / OOM Guards
 *
 * Shared URL safety primitives used by the agentskills.io registry client
 * (and any future module that calls an LLM-influenced or env-influenced URL).
 * Keeping these in one file ensures all callers apply the same hostname
 * blocklist as the web layer's `apps/web/app/api/chat/route.ts` —
 * if we add a new blocked range there, we copy the regex here too.
 *
 * 共用的 URL 安全工具：协议白名单、SSRF 主机黑名单、流式 body 大小守卫。
 * registry-client 与未来其他需要校验外部 URL 的模块共用本文件，避免每个
 * 调用方各自实现一遍黑名单（容易漏 IPv6-mapped 之类的边界）。黑名单与
 * apps/web/app/api/chat/route.ts 的 BLOCKED_HOSTNAME_PATTERNS 保持同步。
 */

/**
 * 被禁止的主机名模式 / Blocked hostname patterns
 *
 * Blocks loopback, RFC1918 private ranges, link-local (including AWS IMDS
 * 169.254.169.254 and Alibaba 100.100.100.200), IPv6 loopback / unique-local /
 * link-local, IPv4-mapped IPv6 forms, and the well-known `localhost` /
 * `metadata` aliases. Mirrors `apps/web/app/api/chat/route.ts`.
 *
 * 阻止 loopback、RFC1918 私网段、链路本地（含 AWS / 阿里云元数据 IP）、
 * IPv6 loopback / unique-local / link-local、IPv4-mapped IPv6 形式，以及
 * 常见 localhost / metadata 别名。与 web 层 BLOCKED_HOSTNAME_PATTERNS 同源。
 */
export const BLOCKED_HOSTNAME_PATTERNS: readonly RegExp[] = [
	/^127\./, // loopback IPv4
	/^10\./, // RFC1918
	/^192\.168\./, // RFC1918
	/^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
	/^169\.254\./, // link-local incl. AWS IMDS
	/^100\.100\.100\./, // Alibaba Cloud IMDS
	/^::1$/, // IPv6 loopback
	/^::$/, // IPv6 unspecified
	/^0\.0\.0\.0$/, // IPv4 unspecified — routes to all local interfaces on Linux/macOS
	/^::ffff:/i, // IPv4-mapped IPv6 (covers loopback + RFC1918 + link-local mapped forms)
	// IPv4-compatible IPv6 (deprecated `::a.b.c.d` form). Node normalizes
	// `[::127.0.0.1]` to `[::7f00:1]`, `[::169.254.169.254]` to `[::a9fe:a9fe]`,
	// etc. Any `::` followed by hex octets other than `ffff:` is either
	// IPv4-compatible (RFC 4291 deprecated) or a reserved IPv6 special
	// address — neither should be an agent-supplied web target. Modern
	// legitimate IPv6 starts with `2xxx:` / `3xxx:` / `fcxx:` / `fexx:`.
	/^::(?!ffff:)[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,2}$/i,
	/^fe80:/i, // IPv6 link-local
	/^fc[0-9a-f][0-9a-f]:/i, // IPv6 unique-local
	/^fd[0-9a-f][0-9a-f]:/i, // IPv6 unique-local
	// `\.*$` matches the bare name plus any number of trailing dots
	// (FQDN form `localhost.`, double-dot form `localhost..`, etc).
	/^localhost\.*$/i,
	/^localhost4\.*$/i,
	/^localhost6\.*$/i,
	/^localhost\.localdomain\.*$/i,
	/^localhost4\.localdomain4\.*$/i,
	/^localhost6\.localdomain6\.*$/i,
	/^ip6-localhost\.*$/i,
	/^ip6-loopback\.*$/i,
	/^metadata\.*$/i,
	/^metadata\.google\.internal\.*$/i,
];

/**
 * 判断主机名是否被禁止 / Check if a hostname is blocked
 *
 * Strips IPv6 bracket form (`[::1]` → `::1`) and lowercases before matching
 * the patterns above.
 *
 * 处理 IPv6 `[host]` 包装并小写化，然后逐个模式匹配。
 */
export function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return BLOCKED_HOSTNAME_PATTERNS.some((rx) => rx.test(normalized));
}

/**
 * URL 校验结果 / URL validation result
 */
export type SafeUrlResult =
	| { readonly ok: true; readonly url: URL }
	| { readonly ok: false; readonly reason: string };

/**
 * URL 校验选项 / URL validation options
 */
export interface AssertSafeUrlOptions {
	/**
	 * Allowed protocols. Defaults to `["https:", "http:"]`. The registry
	 * client uses the default; env-derived URLs use `["https:"]` unless the
	 * `AGENTSKILLS_ALLOW_INSECURE=1` escape hatch is enabled.
	 *
	 * 允许的协议列表，默认 `http(s):`。env 配置的 URL 默认只允许 https。
	 */
	readonly allowedProtocols?: readonly string[];
	/**
	 * Skip the SSRF hostname blocklist. Should only be enabled for trusted
	 * inputs (none today). Default `false`.
	 */
	readonly allowPrivateHosts?: boolean;
}

const DEFAULT_ALLOWED_PROTOCOLS = ["https:", "http:"] as const;

/**
 * 解析并校验 URL / Parse + validate a URL
 *
 * Returns a discriminated union so callers can decide between throwing
 * (registry-client) or falling back to a default (env override). Validation:
 *   1. URL is parseable
 *   2. protocol ∈ allowedProtocols (rejects `file:`, `data:`, `gopher:`, etc)
 *   3. hostname is not in the SSRF blocklist (unless allowPrivateHosts)
 *
 * 不抛错，返回 discriminated union 让调用方决定抛错还是降级。校验三件套：
 * URL 可解析、协议在白名单内、主机名不在 SSRF 黑名单内。
 */
export function assertSafeUrl(
	input: string,
	options: AssertSafeUrlOptions = {},
): SafeUrlResult {
	const allowedProtocols =
		options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return { ok: false, reason: `invalid URL: ${input}` };
	}
	if (!allowedProtocols.includes(parsed.protocol)) {
		return {
			ok: false,
			reason: `disallowed protocol ${parsed.protocol} (allowed: ${allowedProtocols.join(", ")})`,
		};
	}
	if (!options.allowPrivateHosts && isBlockedHostname(parsed.hostname)) {
		return {
			ok: false,
			reason: `hostname ${parsed.hostname} is private/loopback/link-local/metadata (SSRF guard)`,
		};
	}
	return { ok: true, url: parsed };
}

/**
 * 读 body 时累计 size 的守卫错误 / Body size guard error
 *
 * Thrown by `readBodyWithSizeLimit` when either `Content-Length` exceeds
 * the cap, or the streamed bytes-so-far exceed the cap before EOF. Callers
 * abort the underlying request via the supplied AbortController.
 */
export class BodyTooLargeError extends Error {
	public readonly maxBytes: number;
	public readonly observedBytes: number;

	constructor(message: string, maxBytes: number, observedBytes: number) {
		super(message);
		this.name = "BodyTooLargeError";
		this.maxBytes = maxBytes;
		this.observedBytes = observedBytes;
	}
}

/**
 * 流式读 body 并强制 size 上限 / Stream-read body with hard size cap
 *
 * Two-stage defense against OOM from a hostile or buggy upstream:
 *   1. If `Content-Length` is present and exceeds `maxBytes`, reject before
 *      reading a single byte.
 *   2. Otherwise stream-read via the response body's reader, tracking
 *      cumulative bytes. As soon as the cumulative count exceeds `maxBytes`
 *      we abort the request and throw `BodyTooLargeError` — we do NOT keep
 *      buffering. This matters for chunked-transfer responses that omit
 *      Content-Length.
 *
 * If the response body is not a ReadableStream (some test doubles use a
 * plain Response with `.text()` and no `body`), we fall back to calling
 * `.text()` directly and re-check the size after the fact. This still
 * protects against accidental large fixtures and is acceptable because the
 * fallback path is only reached when the runtime has already buffered the
 * body itself.
 *
 * 抗 OOM 双保险：先看 Content-Length，超限直接拒；没 header 就 stream 读 +
 * 字节累计，超限立刻 abort，不继续 buffer。
 */
export async function readBodyWithSizeLimit(
	response: Response,
	maxBytes: number,
	abortController?: AbortController,
): Promise<string> {
	const contentLengthHeader = response.headers.get("content-length");
	if (contentLengthHeader != null) {
		const declared = Number.parseInt(contentLengthHeader, 10);
		if (Number.isFinite(declared) && declared > maxBytes) {
			abortController?.abort();
			throw new BodyTooLargeError(
				`response Content-Length ${declared} exceeds limit ${maxBytes}`,
				maxBytes,
				declared,
			);
		}
	}

	const body = response.body;
	if (body == null) {
		// Test doubles or runtimes without ReadableStream: fall back to text()
		// and re-check size after the fact. Real Node runtime always sets
		// `body` for fetch responses, so this is purely a hardening fallback.
		const text = await response.text();
		const observed = Buffer.byteLength(text, "utf8");
		if (observed > maxBytes) {
			throw new BodyTooLargeError(
				`buffered body ${observed} bytes exceeds limit ${maxBytes}`,
				maxBytes,
				observed,
			);
		}
		return text;
	}

	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	const chunks: string[] = [];
	let total = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			if (value == null) {
				continue;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				abortController?.abort();
				// Release the reader before throwing so the underlying stream
				// can be GC'd. cancel() also signals upstream to stop sending.
				await reader.cancel().catch(() => {
					/* swallow — we are already throwing */
				});
				throw new BodyTooLargeError(
					`streamed body exceeded ${maxBytes} bytes (received ${total} so far)`,
					maxBytes,
					total,
				);
			}
			chunks.push(decoder.decode(value, { stream: true }));
		}
		// flush any trailing multi-byte sequence
		chunks.push(decoder.decode());
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* reader may already be released (cancel path) — ignore */
		}
	}
	return chunks.join("");
}
