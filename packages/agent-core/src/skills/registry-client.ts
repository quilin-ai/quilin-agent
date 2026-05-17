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

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	WriteAuthority,
	WriteRequest,
} from "../safety/write-authority.js";

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
}

export const DEFAULT_REGISTRY_BASE_URL =
	process.env.AGENTSKILLS_REGISTRY_URL ?? "https://api.agentskills.io/v1";

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
	private readonly fsOps: FsOps;

	constructor(
		options: SkillsRegistryClientOptions & SkillsRegistryClientInternals,
	) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_REGISTRY_BASE_URL).replace(
			/\/+$/u,
			"",
		);
		this.cacheDir = options.cacheDir;
		this.fetchFn = options.fetchFn ?? fetch;
		this.writeAuthority = options.writeAuthority;
		this.verifier = options.verifySignature;
		this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_REGISTRY_MAX_BODY_BYTES;
		this.fsOps = { ...defaultFsOps, ...options.fsOps };
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
		const response = await this.fetchFn(url);
		if (response.status === 404) {
			return [];
		}
		if (!response.ok) {
			throw new Error(
				`agentskills.io search failed: HTTP ${response.status} for ${url}`,
			);
		}
		const payload = (await response.json()) as unknown;
		return normalizeSearchResults(payload);
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
		const manifestResponse = await this.fetchFn(manifestUrl);
		if (!manifestResponse.ok) {
			throw new Error(
				`agentskills.io pull manifest failed: HTTP ${manifestResponse.status} for ${manifestUrl}`,
			);
		}
		const manifestPayload = (await manifestResponse.json()) as unknown;
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

		const bodyResponse = await this.fetchFn(entry.downloadUrl);
		if (!bodyResponse.ok) {
			throw new Error(
				`agentskills.io pull body failed: HTTP ${bodyResponse.status} for ${entry.downloadUrl}`,
			);
		}
		const body = await bodyResponse.text();
		if (Buffer.byteLength(body, "utf8") > this.maxBodyBytes) {
			throw new Error(
				`agentskills.io pull body exceeds maxBodyBytes for ${skillId}@${version}`,
			);
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
			const verifyResult = await this.verifier.verify({
				body: request.body,
				entry: request.entry,
			});
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

		const installedPath = join(
			request.targetRoot,
			sanitizeSegment(request.entry.name),
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
