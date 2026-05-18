/**
 * agentskills.io 注册表客户端 / agentskills.io Registry Client
 *
 * Lightweight HTTP client for the public agentskills.io registry. Supports
 * three operations:
 *   - searchRegistry(query): query the registry for skill manifests matching
 *     a text query
 *   - pullSkill(skillId, version): download a SKILL.md to a local cache
 *     directory (read-only — no install side effects)
 *   - installSkill(cachedPath, targetRoot): copy a previously pulled skill
 *     into the user/project skill root, gated by WriteAuthority CRITICAL
 *     and an optional signature verification hook
 *
 * 公共 agentskills.io 注册表的轻量 HTTP 客户端，提供三个操作：搜索清单、
 * 把 SKILL.md 下载到本地缓存、把已下载的 skill 经 WriteAuthority CRITICAL
 * 网关 + 可选签名校验后安装到 user/project skill 根目录。
 *
 * TODO(agentskills.io): The public agentskills.io REST endpoint shape is
 * not yet stabilized at the time of writing. The default base URL and
 * response normalization below are placeholders that follow the conventional
 * REST shape (`/v1/skills/search?q=`, `/v1/skills/{id}/versions/{version}`).
 * When the official endpoint contract is published, update this file and
 * the normalization helpers. The signature verification call site delegates
 * to an injected `verifySignature` hook so that the actual signing
 * implementation (QUI-170 sibling task) can be plugged in without changing
 * this file's API surface.
 *
 * Counterpart to `remote-registry.ts` (which targets skills.sh) — this file
 * stays separate so the two marketplaces can evolve independently.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	WriteAuthority,
	WriteRequest,
} from "../safety/write-authority.js";
import {
	assertSafeUrl,
	BodyTooLargeError,
	readBodyWithSizeLimit,
} from "./url-guard.js";

/**
 * 注册表 skill 条目 / Registry skill entry
 *
 * Represents a single skill entry returned by the agentskills.io API. The
 * downloadUrl is opaque — the caller must not assume a particular host.
 */
export interface RegistrySkillEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly downloadUrl: string;
	readonly publisher?: string;
	readonly signatureUrl?: string;
}

/**
 * 已下载 skill / Pulled skill
 *
 * Result of pullSkill — the SKILL.md content and the local cache path where
 * it was written. The path is inside the cache directory passed at
 * construction time.
 */
export interface PulledSkill {
	readonly entry: RegistrySkillEntry;
	readonly cachePath: string;
	readonly body: string;
}

/**
 * 安装结果 / Install result
 */
export type InstallSkillResult =
	| {
			readonly ok: true;
			readonly installedPath: string;
	  }
	| {
			readonly ok: false;
			readonly error: InstallSkillError;
			readonly detail: string;
	  };

export type InstallSkillError =
	| "write_denied"
	| "signature_invalid"
	| "verification_error"
	| "io_failed";

/**
 * 安装上下文 / Install context
 */
export interface InstallSkillRequest {
	readonly cachePath: string;
	readonly body: string;
	readonly entry: RegistrySkillEntry;
	readonly targetRoot: string;
}

/**
 * 签名校验 hook / Signature verification hook
 *
 * Injected so that registry-client.ts does not duplicate signing logic.
 * The real implementation lives in skill-signing.ts (sibling task). If
 * `verifySignature` is omitted at construction time, installSkill will
 * proceed without signature verification but the install still goes
 * through the WriteAuthority CRITICAL gate.
 *
 * 通过依赖注入避免和 skill-signing.ts 重复实现签名逻辑。如果构造时未提供
 * `verifySignature`，安装时将跳过签名校验，但依然会走 WriteAuthority
 * CRITICAL 审批。
 */
export interface SkillSignatureVerifier {
	verify(input: {
		readonly body: string;
		readonly entry: RegistrySkillEntry;
	}): Promise<SignatureVerifyResult>;
}

export interface SignatureVerifyResult {
	readonly valid: boolean;
	readonly reason?: string;
}

/**
 * 客户端选项 / Client options
 */
export interface SkillsRegistryClientOptions {
	readonly baseUrl?: string;
	readonly cacheDir: string;
	readonly fetchFn?: typeof fetch;
	readonly writeAuthority: WriteAuthority;
	readonly verifySignature?: SkillSignatureVerifier;
	readonly maxBodyBytes?: number;
	/**
	 * 单次 HTTP 请求超时（毫秒）/ Per-request HTTP timeout in ms.
	 *
	 * Applied to every fetchFn call (search / manifest / body). Defaults to
	 * 30 000 ms. Set this lower in tests, higher only when a slow upstream
	 * registry is expected. The timeout is enforced via the same
	 * `AbortController` we already hand to `readBodyWithSizeLimit`, so a
	 * stuck connection AND an oversized body both terminate the request.
	 *
	 * 默认 30 秒。每个 fetch 调用都会被包在带 timeout 的 AbortController 里，
	 * 避免代理 hang 或服务器只回 header 不回 body 时永久阻塞 agent。
	 */
	readonly requestTimeoutMs?: number;
}

export const DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 默认 fallback URL / Default fallback URL
 *
 * Used when the env override is missing, malformed, or fails the SSRF /
 * protocol guard. Kept as a separate constant so tests and callers can
 * assert the post-guard baseUrl shape.
 */
export const FALLBACK_REGISTRY_BASE_URL = "https://api.agentskills.io/v1";

/**
 * 解析并校验 env 注册表 URL / Resolve + validate env-supplied registry URL
 *
 * `AGENTSKILLS_REGISTRY_URL` is set by humans (or worse, accidentally inherited
 * from CI / shell profile / parent process) — we must not blindly trust it.
 * Rules:
 *   - missing env → use FALLBACK_REGISTRY_BASE_URL silently
 *   - protocol must be https (REAL-4 hardening)
 *   - hostname must not be RFC1918/loopback/link-local/metadata
 *   - escape hatch: `AGENTSKILLS_ALLOW_INSECURE=1` allows http + private hosts
 *     (intended only for local development against a stub registry)
 *   - any rejection emits a structured warn log to stderr and falls back
 *
 * 解析环境变量 AGENTSKILLS_REGISTRY_URL：默认强制 https + 排除内网；
 * 设 AGENTSKILLS_ALLOW_INSECURE=1 可放行 http + 内网（仅本地开发用）。
 */
export function resolveRegistryBaseUrlFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const candidate = env.AGENTSKILLS_REGISTRY_URL;
	if (candidate == null || candidate.trim().length === 0) {
		return FALLBACK_REGISTRY_BASE_URL;
	}
	const insecureOptIn = env.AGENTSKILLS_ALLOW_INSECURE === "1";
	const result = assertSafeUrl(candidate, {
		allowedProtocols: insecureOptIn ? ["https:", "http:"] : ["https:"],
		allowPrivateHosts: insecureOptIn,
	});
	if (!result.ok) {
		// structured JSON warn — keeps the observability logging contract
		// (one JSON object per line on stderr) for downstream log shippers.
		process.stderr.write(
			`${JSON.stringify({
				level: "warn",
				module: "skills/registry-client",
				event: "env_registry_url_rejected",
				candidate,
				reason: result.reason,
				fallback: FALLBACK_REGISTRY_BASE_URL,
			})}\n`,
		);
		return FALLBACK_REGISTRY_BASE_URL;
	}
	return candidate;
}

/**
 * @deprecated 直接使用 `resolveRegistryBaseUrlFromEnv()` — 该常量在模块加载时
 *             解析一次，无法响应 env 在测试中临时改变。保留以兼容现有 import。
 */
export const DEFAULT_REGISTRY_BASE_URL = resolveRegistryBaseUrlFromEnv();

export const DEFAULT_REGISTRY_MAX_BODY_BYTES = 1024 * 1024;

interface FsOps {
	readonly mkdir: typeof mkdir;
	readonly writeFile: typeof writeFile;
}

/**
 * Internal fs ops bag — exported only for tests (avoid mocking node:fs).
 */
export interface SkillsRegistryClientInternals {
	readonly fsOps?: Partial<FsOps>;
}

const defaultFsOps: FsOps = {
	mkdir,
	writeFile,
};

/**
 * agentskills.io 注册表客户端 / The registry client itself
 */
export class SkillsRegistryClient {
	private readonly baseUrl: string;
	private readonly cacheDir: string;
	private readonly fetchFn: typeof fetch;
	private readonly writeAuthority: WriteAuthority;
	private readonly verifier?: SkillSignatureVerifier;
	private readonly maxBodyBytes: number;
	private readonly requestTimeoutMs: number;
	private readonly fsOps: FsOps;

	constructor(
		options: SkillsRegistryClientOptions & SkillsRegistryClientInternals,
	) {
		this.baseUrl = (options.baseUrl ?? resolveRegistryBaseUrlFromEnv()).replace(
			/\/+$/u,
			"",
		);
		this.cacheDir = options.cacheDir;
		this.fetchFn = options.fetchFn ?? fetch;
		this.writeAuthority = options.writeAuthority;
		this.verifier = options.verifySignature;
		this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_REGISTRY_MAX_BODY_BYTES;
		this.requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS;
		this.fsOps = { ...defaultFsOps, ...options.fsOps };
	}

	/**
	 * 受 timeout 保护的 fetch 包装 / Timeout-guarded fetch wrapper.
	 *
	 * Applies a timeout to fetchFn itself and returns the same AbortController
	 * used by `readBodyWithSizeLimit` for OOM defence. A single controller
	 * lets callers terminate either a hung request or an oversized body through
	 * the same cancellation path.
	 *
	 * fetchFn 自身使用 timeout 保护；同一个 AbortController 也交给
	 * body size guard 使用，保证 hung fetch 和超大 body 都能被同一路径终止。
	 */
	private async fetchWithTimeout(url: string): Promise<{
		response: Response;
		controller: AbortController;
		clearTimeout: () => void;
	}> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			// abort with a DOMException when supported so consumers see an
			// AbortError they can branch on; fall back to argument-less abort
			// on older runtimes.
			try {
				controller.abort(
					new DOMException(
						`agentskills.io request exceeded ${this.requestTimeoutMs}ms`,
						"TimeoutError",
					),
				);
			} catch {
				/* v8 ignore next -- @preserve DOMException unavailable on legacy runtimes */
				controller.abort();
			}
		}, this.requestTimeoutMs);
		try {
			const response = await this.fetchFn(url, { signal: controller.signal });
			return {
				response,
				controller,
				clearTimeout: () => clearTimeout(timeoutId),
			};
		} catch (error) {
			clearTimeout(timeoutId);
			throw error;
		}
	}

	/**
	 * 搜索注册表 / Search the registry
	 *
	 * Queries agentskills.io for skills matching `query`. The query is
	 * URL-encoded and sent as `?q=` on `/skills/search`. Returns an empty
	 * array on 404 or empty payloads (callers should not need to special-case
	 * "no results"). Throws on other non-2xx responses.
	 */
	async searchRegistry(query: string): Promise<readonly RegistrySkillEntry[]> {
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			return [];
		}
		const url = `${this.baseUrl}/skills/search?q=${encodeURIComponent(trimmed)}`;
		const request = await this.fetchWithTimeout(url);
		try {
			const { response, controller } = request;
			if (response.status === 404) {
				return [];
			}
			if (!response.ok) {
				throw new Error(
					`agentskills.io search failed: HTTP ${response.status} for ${url}`,
				);
			}
			// REAL-3: stream-read with hard size cap. A 1 GB search response
			// would OOM the agent if we called `.json()` directly.
			let text: string;
			try {
				text = await readBodyWithSizeLimit(
					response,
					this.maxBodyBytes,
					controller,
				);
			} catch (error) {
				if (error instanceof BodyTooLargeError) {
					throw new Error(
						`agentskills.io search response exceeds maxBodyBytes (${error.maxBytes}) for ${url}`,
					);
				}
				throw error;
			}
			let payload: unknown;
			try {
				payload = JSON.parse(text) as unknown;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new Error(
					`agentskills.io search response is not valid JSON for ${url}: ${msg}`,
				);
			}
			return normalizeSearchResults(payload);
		} finally {
			request.clearTimeout();
		}
	}

	/**
	 * 下载 skill 到本地缓存 / Pull a skill into the local cache
	 *
	 * Fetches the manifest, then downloads the SKILL.md body to
	 * `${cacheDir}/${id}/${version}/SKILL.md`. Does **not** install the
	 * skill — the file lives in cache only. The cache directory is treated
	 * as agent-owned scratch space; no WriteAuthority gate is involved for
	 * cache writes because the cache is non-executable until installSkill
	 * promotes it into a managed skill root.
	 */
	async pullSkill(skillId: string, version: string): Promise<PulledSkill> {
		const manifestUrl = `${this.baseUrl}/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}`;
		const manifestRequest = await this.fetchWithTimeout(manifestUrl);
		let manifestText: string;
		try {
			const { response: manifestResponse, controller: manifestController } =
				manifestRequest;
			if (!manifestResponse.ok) {
				throw new Error(
					`agentskills.io pull manifest failed: HTTP ${manifestResponse.status} for ${manifestUrl}`,
				);
			}
			// Manifest is also untrusted — apply the same size guard before JSON.parse.
			try {
				manifestText = await readBodyWithSizeLimit(
					manifestResponse,
					this.maxBodyBytes,
					manifestController,
				);
			} catch (error) {
				if (error instanceof BodyTooLargeError) {
					throw new Error(
						`agentskills.io manifest exceeds maxBodyBytes (${error.maxBytes}) for ${manifestUrl}`,
					);
				}
				throw error;
			}
		} finally {
			manifestRequest.clearTimeout();
		}
		let manifestPayload: unknown;
		try {
			manifestPayload = JSON.parse(manifestText) as unknown;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			throw new Error(
				`agentskills.io pull manifest is not valid JSON for ${manifestUrl}: ${msg}`,
			);
		}
		const entry = normalizeManifestEntry(manifestPayload, skillId, version);
		if (entry == null) {
			throw new Error(
				`agentskills.io pull manifest payload missing required fields for ${skillId}@${version}`,
			);
		}
		if (entry.downloadUrl.length === 0) {
			throw new Error(
				`agentskills.io pull manifest missing downloadUrl for ${skillId}@${version}`,
			);
		}

		// REAL-1: downloadUrl is server-controlled but the server itself is
		// untrusted from a defense-in-depth standpoint — an attacker who can
		// publish a malicious manifest could inject `file:///etc/passwd`,
		// `http://169.254.169.254/...` (AWS IMDS), or `http://localhost:5432/`
		// (database probe). Validate before handing the URL to fetch.
		const downloadGuard = assertSafeUrl(entry.downloadUrl);
		if (!downloadGuard.ok) {
			throw new Error(
				`agentskills.io pull rejected downloadUrl for ${skillId}@${version}: ${downloadGuard.reason}`,
			);
		}

		const bodyRequest = await this.fetchWithTimeout(entry.downloadUrl);
		let body: string;
		try {
			const { response: bodyResponse, controller: bodyController } =
				bodyRequest;
			if (!bodyResponse.ok) {
				throw new Error(
					`agentskills.io pull body failed: HTTP ${bodyResponse.status} for ${entry.downloadUrl}`,
				);
			}
			// REAL-2: previously we called `.text()` then checked the size —
			// a 1 GB body would OOM the agent before the check fired. Now we
			// short-circuit on Content-Length, then stream-read with a hard cap.
			try {
				body = await readBodyWithSizeLimit(
					bodyResponse,
					this.maxBodyBytes,
					bodyController,
				);
			} catch (error) {
				if (error instanceof BodyTooLargeError) {
					throw new Error(
						`agentskills.io pull body exceeds maxBodyBytes (${error.maxBytes}) for ${skillId}@${version}`,
					);
				}
				throw error;
			}
		} finally {
			bodyRequest.clearTimeout();
		}

		const cachePath = join(
			this.cacheDir,
			sanitizeSegment(skillId),
			sanitizeSegment(version),
			"SKILL.md",
		);
		await this.fsOps.mkdir(dirname(cachePath), { recursive: true });
		await this.fsOps.writeFile(cachePath, body, { encoding: "utf8" });
		return { entry, cachePath, body };
	}

	/**
	 * 安装 skill / Install a pulled skill into a managed skill root
	 *
	 * Promotes a cached SKILL.md into the user/project skill root. This
	 * write is **CRITICAL** because the skill, once installed, becomes
	 * discoverable by SkillsManager and may be invoked by the model. The
	 * WriteAuthority gate must approve every install, regardless of trust
	 * mode (matches the project Permission Model — see CLAUDE.md).
	 *
	 * If a signature verifier was injected at construction time, it runs
	 * **before** the WriteAuthority prompt so that an invalid signature
	 * short-circuits without bothering the user.
	 */
	async installSkill(
		request: InstallSkillRequest,
	): Promise<InstallSkillResult> {
		if (this.verifier != null) {
			let verifyResult: SignatureVerifyResult;
			try {
				verifyResult = await this.verifier.verify({
					body: request.body,
					entry: request.entry,
				});
			} catch (error) {
				// REAL-2 (Reviewer A round 1 follow-up): a verifier that throws
				// (network failure, malformed signature blob, unsupported curve,
				// HSM transport error, etc.) would previously reject the install
				// promise and skip the structured InstallSkillResult contract.
				// Callers expect a result object — surface a structured error
				// so write paths stay observable and the WriteAuthority gate
				// never sees an unverified body.
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					error: "verification_error",
					detail: `skill signature verifier threw: ${message}`,
				};
			}
			if (!verifyResult.valid) {
				return {
					ok: false,
					error: "signature_invalid",
					detail: verifyResult.reason ?? "skill signature failed verification",
				};
			}
		}

		const writeRequest: WriteRequest = buildInstallWriteRequest(request);
		const decision = await this.writeAuthority.authorize(writeRequest);
		if (decision.kind === "deny") {
			return {
				ok: false,
				error: "write_denied",
				detail: decision.reason,
			};
		}
		/* v8 ignore start -- @preserve future-proof against new WriteDecision variants */
		if (decision.kind !== "allow") {
			return {
				ok: false,
				error: "write_denied",
				detail: "install request was not approved",
			};
		}
		/* v8 ignore stop */

		// SUSPECT-1 fix: two entries with names `my skill` and `my-skill` would
		// both sanitize to `my_skill` and silently overwrite each other (and any
		// human-installed skill that happened to live at that path). Append a
		// short hash of the registry skill id so the install path is unique per
		// entry while staying human-readable for the common case.
		const idHash = createHash("sha256")
			.update(request.entry.id)
			.digest("hex")
			.slice(0, 8);
		const installedPath = join(
			request.targetRoot,
			`${sanitizeSegment(request.entry.name)}__${idHash}`,
			"SKILL.md",
		);
		try {
			await this.fsOps.mkdir(dirname(installedPath), { recursive: true });
			await this.fsOps.writeFile(installedPath, request.body, {
				encoding: "utf8",
			});
		} catch (error) {
			return {
				ok: false,
				error: "io_failed",
				detail:
					error instanceof Error
						? `install io failed: ${error.message}`
						: "install io failed",
			};
		}
		return { ok: true, installedPath };
	}
}

function buildInstallWriteRequest(request: InstallSkillRequest): WriteRequest {
	const bytes = Buffer.byteLength(request.body, "utf8");
	return {
		tool: "skill_install_from_registry",
		origin: "agent",
		riskLevel: "critical",
		summary: `skills.install ${request.entry.name}@${request.entry.version} from agentskills.io`,
		detail: [
			`id=${request.entry.id}`,
			`version=${request.entry.version}`,
			`cachePath=${request.cachePath}`,
			`targetRoot=${request.targetRoot}`,
			`bytes=${bytes}`,
		].join(" | "),
	};
}

function normalizeSearchResults(
	payload: unknown,
): readonly RegistrySkillEntry[] {
	const candidates: unknown[] = Array.isArray(payload)
		? payload
		: isRecord(payload) && Array.isArray(payload.results)
			? (payload.results as unknown[])
			: isRecord(payload) && Array.isArray(payload.skills)
				? (payload.skills as unknown[])
				: [];

	return candidates
		.map((item) => normalizeManifestEntry(item, undefined, undefined))
		.filter((entry): entry is RegistrySkillEntry => entry != null);
}

function normalizeManifestEntry(
	payload: unknown,
	fallbackId: string | undefined,
	fallbackVersion: string | undefined,
): RegistrySkillEntry | null {
	if (!isRecord(payload)) {
		return null;
	}

	const id =
		pickString(payload.id, payload.skill_id, payload.skillId) ?? fallbackId;
	const name = pickString(payload.name);
	const description = pickString(payload.description) ?? "";
	const version =
		pickString(
			payload.version,
			payload.latest_version,
			payload.latestVersion,
		) ?? fallbackVersion;
	const downloadUrl =
		pickString(payload.downloadUrl, payload.download_url, payload.url) ?? "";
	const publisher = pickString(payload.publisher, payload.author);
	const signatureUrl = pickString(payload.signatureUrl, payload.signature_url);

	if (id == null || name == null || version == null) {
		return null;
	}

	return {
		id,
		name,
		description,
		version,
		downloadUrl,
		publisher,
		signatureUrl,
	};
}

function pickString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				return trimmed;
			}
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}

function sanitizeSegment(segment: string): string {
	// Reject path traversal and absolute-path attempts before joining with
	// the cache or target root. Anything outside [a-zA-Z0-9._-] is replaced
	// with `_`, and the two-dot traversal token (`..`) is collapsed to a
	// single `_` so the resulting segment cannot escape its parent directory.
	const safe = segment
		.replace(/\.\.+/gu, "_")
		.replace(/[^a-zA-Z0-9._-]/gu, "_");
	if (safe === "" || safe === ".") {
		return "_";
	}
	return safe;
}
