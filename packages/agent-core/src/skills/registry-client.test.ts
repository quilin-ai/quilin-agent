import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WriteAuthority } from "../safety/write-authority.js";
import {
	DEFAULT_REGISTRY_BASE_URL,
	FALLBACK_REGISTRY_BASE_URL,
	type RegistrySkillEntry,
	resolveRegistryBaseUrlFromEnv,
	type SkillSignatureVerifier,
	SkillsRegistryClient,
} from "./registry-client.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quilin-registry-client-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function textResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/markdown" },
	});
}

function emptyResponse(status: number): Response {
	return new Response("", { status });
}

function makeAuthority(approve = true): WriteAuthority {
	return new WriteAuthority({
		mode: "ask",
		confirm: async () => approve,
	});
}

const sampleEntry: RegistrySkillEntry = {
	id: "test-skill",
	name: "test-skill",
	description: "demo entry",
	version: "1.0.0",
	downloadUrl: "https://cdn.agentskills.io/test-skill/1.0.0/SKILL.md",
};

describe("SkillsRegistryClient construction", () => {
	it("falls back to global fetch when fetchFn is omitted", async () => {
		const cacheDir = await createTempDir();
		// Construction alone should not throw. We exercise the field assignment
		// branch where `options.fetchFn ?? fetch` falls through to the global
		// fetch. We deliberately avoid calling searchRegistry to keep the test
		// hermetic (no real network traffic).
		const client = new SkillsRegistryClient({
			cacheDir,
			writeAuthority: makeAuthority(),
		});
		expect(client).toBeInstanceOf(SkillsRegistryClient);
	});

	it("strips trailing slashes from the configured base URL", async () => {
		const cacheDir = await createTempDir();
		const calls: string[] = [];
		const fetchFn = vi.fn(async (url: string | URL) => {
			calls.push(typeof url === "string" ? url : url.toString());
			return jsonResponse([]);
		});
		const client = new SkillsRegistryClient({
			cacheDir,
			baseUrl: "https://api.agentskills.io/v1///",
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		await client.searchRegistry("anything");
		expect(calls[0]).toBe(
			"https://api.agentskills.io/v1/skills/search?q=anything",
		);
	});

	it("normalizes { skills: [...] } envelope shape as well", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				skills: [{ id: "gamma", name: "gamma", version: "0.1" }],
			}),
		);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		const result = await client.searchRegistry("gamma");
		expect(result.map((entry) => entry.id)).toEqual(["gamma"]);
	});

	it("falls back to empty array when search payload is neither array nor envelope", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn(async () => jsonResponse({ unexpected: 42 }));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		expect(await client.searchRegistry("anything")).toEqual([]);
	});
});

describe("SkillsRegistryClient.searchRegistry", () => {
	it("returns empty array for empty query without making a request", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn();
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});

		const result = await client.searchRegistry("   ");
		expect(result).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("URL-encodes the query and parses array payload", async () => {
		const cacheDir = await createTempDir();
		const calls: string[] = [];
		const fetchFn = vi.fn(async (url: string | URL) => {
			calls.push(typeof url === "string" ? url : url.toString());
			return jsonResponse([
				{
					id: "alpha",
					name: "alpha-skill",
					description: "first",
					version: "0.1.0",
					download_url: "https://cdn.example.com/alpha",
				},
				{ name: "missing-id" },
			]);
		});
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});

		const result = await client.searchRegistry("alpha skill");
		expect(calls[0]).toBe(
			`${DEFAULT_REGISTRY_BASE_URL}/skills/search?q=alpha%20skill`,
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("alpha");
		expect(result[0]?.downloadUrl).toBe("https://cdn.example.com/alpha");
	});

	it("treats 404 as empty result, throws on other non-2xx", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(emptyResponse(404))
			.mockResolvedValueOnce(emptyResponse(503));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});

		expect(await client.searchRegistry("missing")).toEqual([]);
		await expect(client.searchRegistry("broken")).rejects.toThrow(/HTTP 503/u);
	});

	it("normalizes { results: [...] } envelope shape", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				results: [
					{
						id: "beta",
						name: "beta",
						version: "2.0",
						url: "https://cdn.example.com/beta",
					},
				],
			}),
		);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		const result = await client.searchRegistry("beta");
		expect(result.map((entry) => entry.id)).toEqual(["beta"]);
	});
});

describe("SkillsRegistryClient.pullSkill", () => {
	it("downloads manifest + body and writes to the cache dir", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(sampleEntry))
			.mockResolvedValueOnce(
				textResponse("---\nname: test-skill\ndescription: x\n---\n# body"),
			);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});

		const pulled = await client.pullSkill("test-skill", "1.0.0");
		expect(pulled.entry.name).toBe("test-skill");
		expect(pulled.cachePath.startsWith(cacheDir)).toBe(true);
		const written = await readFile(pulled.cachePath, "utf8");
		expect(written).toContain("# body");
	});

	it("throws when manifest fetch fails", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn().mockResolvedValueOnce(emptyResponse(500));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		await expect(client.pullSkill("test-skill", "1.0.0")).rejects.toThrow(
			/HTTP 500/u,
		);
	});

	it("rejects body that exceeds maxBodyBytes", async () => {
		const cacheDir = await createTempDir();
		const big = "x".repeat(100);
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(sampleEntry))
			.mockResolvedValueOnce(textResponse(big));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
			maxBodyBytes: 10,
		});
		await expect(client.pullSkill("test-skill", "1.0.0")).rejects.toThrow(
			/maxBodyBytes/u,
		);
	});

	it("throws when manifest payload is not an object (cannot normalize)", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse("not an object"));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		await expect(client.pullSkill("test-skill", "1.0.0")).rejects.toThrow(
			/missing required fields/u,
		);
	});

	it("throws when manifest is present but downloadUrl is empty", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				id: "x",
				name: "x",
				version: "1",
				downloadUrl: "   ",
			}),
		);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		await expect(client.pullSkill("x", "1")).rejects.toThrow(
			/missing downloadUrl/u,
		);
	});

	it("throws when body fetch returns non-2xx", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(sampleEntry))
			.mockResolvedValueOnce(emptyResponse(502));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		await expect(client.pullSkill("test-skill", "1.0.0")).rejects.toThrow(
			/pull body failed: HTTP 502/u,
		);
	});

	it("sanitizes empty / dot-only segments by replacing them with underscore", async () => {
		// Drives the sanitizeSegment empty/dot branch via an entry where the
		// payload's name is "." (collapses to "_").
		const cacheDir = await createTempDir();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					id: ".",
					name: ".",
					version: ".",
					downloadUrl: "https://cdn.example.com/dot",
				}),
			)
			.mockResolvedValueOnce(textResponse("body"));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		const pulled = await client.pullSkill(".", ".");
		expect(pulled.cachePath.startsWith(cacheDir)).toBe(true);
		expect(pulled.cachePath).toMatch(/_[/\\]_[/\\]SKILL\.md$/u);
	});

	it("sanitizes unsafe id/version path segments", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(sampleEntry))
			.mockResolvedValueOnce(textResponse("body"));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		const pulled = await client.pullSkill("../evil/id", "../../version");
		expect(pulled.cachePath).not.toContain("..");
		expect(pulled.cachePath.startsWith(cacheDir)).toBe(true);
	});
});

describe("SkillsRegistryClient.installSkill", () => {
	const buildRequest = (targetRoot: string, body = "# safe body") => ({
		cachePath: "/tmp/cache/test/SKILL.md",
		body,
		entry: sampleEntry,
		targetRoot,
	});

	it("approves install when authority returns allow and verifier passes", async () => {
		const targetRoot = await createTempDir();
		const verifier: SkillSignatureVerifier = {
			verify: vi.fn(async () => ({ valid: true })),
		};
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: makeAuthority(true),
			verifySignature: verifier,
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(true);
		if (result.ok) {
			const written = await readFile(result.installedPath, "utf8");
			expect(written).toBe("# safe body");
			expect(result.installedPath).toContain("test-skill");
		}
		expect(verifier.verify).toHaveBeenCalledOnce();
	});

	it("returns signature_invalid before contacting WriteAuthority", async () => {
		const targetRoot = await createTempDir();
		const authority = makeAuthority(true);
		const authorize = vi.spyOn(authority, "authorize");
		const verifier: SkillSignatureVerifier = {
			verify: vi.fn(async () => ({ valid: false, reason: "bad sig" })),
		};
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: authority,
			verifySignature: verifier,
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("signature_invalid");
			expect(result.detail).toContain("bad sig");
		}
		expect(authorize).not.toHaveBeenCalled();
	});

	it("returns write_denied when authority rejects", async () => {
		const targetRoot = await createTempDir();
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: makeAuthority(false),
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("write_denied");
		}
	});

	it("issues a CRITICAL WriteRequest with structured detail", async () => {
		const targetRoot = await createTempDir();
		const authority = makeAuthority(true);
		const authorize = vi.spyOn(authority, "authorize");
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: authority,
		});

		await client.installSkill(buildRequest(targetRoot, "# body"));
		expect(authorize).toHaveBeenCalledOnce();
		const request = authorize.mock.calls[0]?.[0];
		expect(request?.riskLevel).toBe("critical");
		expect(request?.tool).toBe("skill_install_from_registry");
		expect(request?.detail).toContain("id=test-skill");
		expect(request?.detail).toContain("version=1.0.0");
		expect(request?.detail).toMatch(/bytes=\d+/u);
	});

	it("returns io_failed when writing the installed skill throws", async () => {
		const targetRoot = await createTempDir();
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: makeAuthority(true),
			fsOps: {
				writeFile: async () => {
					throw new Error("disk full");
				},
			},
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("io_failed");
			expect(result.detail).toContain("disk full");
		}
	});

	it("returns io_failed via io_failed branch for non-Error throws", async () => {
		const targetRoot = await createTempDir();
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: makeAuthority(true),
			fsOps: {
				writeFile: async () => {
					throw "raw string failure";
				},
			},
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("io_failed");
			expect(result.detail).toBe("install io failed");
		}
	});

	it("uses default reason text when verifier rejects without a reason", async () => {
		const targetRoot = await createTempDir();
		const verifier: SkillSignatureVerifier = {
			verify: async () => ({ valid: false }),
		};
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: makeAuthority(true),
			verifySignature: verifier,
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("signature_invalid");
			expect(result.detail).toBe("skill signature failed verification");
		}
	});

	it("skips signature check when no verifier is provided but still requires authority", async () => {
		const targetRoot = await createTempDir();
		const authority = makeAuthority(true);
		const authorize = vi.spyOn(authority, "authorize");
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: authority,
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(true);
		expect(authorize).toHaveBeenCalledOnce();
	});

	it("returns verification_error (REAL-2 round-1 follow-up) when verifier throws", async () => {
		const targetRoot = await createTempDir();
		const authority = makeAuthority(true);
		const authorize = vi.spyOn(authority, "authorize");
		const verifier: SkillSignatureVerifier = {
			verify: vi.fn(async () => {
				throw new Error("HSM transport failure");
			}),
		};
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: authority,
			verifySignature: verifier,
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("verification_error");
			expect(result.detail).toContain("HSM transport failure");
		}
		// verifier failure must short-circuit before WriteAuthority is touched
		expect(authorize).not.toHaveBeenCalled();
	});

	it("returns verification_error when verifier throws a non-Error value", async () => {
		const targetRoot = await createTempDir();
		// Reusable raw-string thrown value — extracted to a local so the
		// throw site is `throw rawFailure` (not a bare string literal) which
		// keeps biome's useErrorMessage lint happy without a suppression.
		const rawFailure = "raw string failure";
		const verifier: SkillSignatureVerifier = {
			verify: async () => {
				throw rawFailure;
			},
		};
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: makeAuthority(true),
			verifySignature: verifier,
		});

		const result = await client.installSkill(buildRequest(targetRoot));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("verification_error");
			expect(result.detail).toContain("raw string failure");
		}
	});

	it("installs into id-hashed subdir to prevent sanitize collisions (SUSPECT-1)", async () => {
		const targetRoot = await createTempDir();
		const client = new SkillsRegistryClient({
			cacheDir: targetRoot,
			fetchFn: (() => {
				throw new Error("network not expected");
			}) as unknown as typeof fetch,
			writeAuthority: makeAuthority(true),
		});

		// Two entries whose names collide after sanitize ("my skill" and
		// "my-skill" both → "my_skill") but with distinct registry ids.
		const entryA: RegistrySkillEntry = {
			id: "publisher-a/skill",
			name: "my skill",
			description: "",
			version: "1.0.0",
			downloadUrl: "https://cdn.agentskills.io/a/SKILL.md",
		};
		const entryB: RegistrySkillEntry = {
			id: "publisher-b/skill",
			name: "my-skill",
			description: "",
			version: "1.0.0",
			downloadUrl: "https://cdn.agentskills.io/b/SKILL.md",
		};

		const resA = await client.installSkill({
			cachePath: "/tmp/cache/a/SKILL.md",
			body: "# from A",
			entry: entryA,
			targetRoot,
		});
		const resB = await client.installSkill({
			cachePath: "/tmp/cache/b/SKILL.md",
			body: "# from B",
			entry: entryB,
			targetRoot,
		});

		expect(resA.ok).toBe(true);
		expect(resB.ok).toBe(true);
		if (resA.ok && resB.ok) {
			expect(resA.installedPath).not.toBe(resB.installedPath);
			const writtenA = await readFile(resA.installedPath, "utf8");
			const writtenB = await readFile(resB.installedPath, "utf8");
			expect(writtenA).toBe("# from A");
			expect(writtenB).toBe("# from B");
		}
	});
});

describe("SkillsRegistryClient SSRF guard on downloadUrl (REAL-1)", () => {
	const ssrfCases: ReadonlyArray<readonly [label: string, url: string]> = [
		["file://", "file:///etc/passwd"],
		["AWS IMDS", "http://169.254.169.254/latest/meta-data/"],
		["localhost db probe", "http://localhost:5432/"],
		["loopback IPv4", "http://127.0.0.1:8080/SKILL.md"],
		["RFC1918", "http://10.0.0.1/SKILL.md"],
		["GCP metadata alias", "http://metadata.google.internal/"],
	];

	for (const [label, malicious] of ssrfCases) {
		it(`rejects manifest downloadUrl=${label}`, async () => {
			const cacheDir = await createTempDir();
			const fetchFn = vi.fn().mockResolvedValueOnce(
				jsonResponse({
					id: "evil",
					name: "evil",
					version: "1.0.0",
					downloadUrl: malicious,
				}),
			);
			const client = new SkillsRegistryClient({
				cacheDir,
				fetchFn: fetchFn as unknown as typeof fetch,
				writeAuthority: makeAuthority(),
			});
			await expect(client.pullSkill("evil", "1.0.0")).rejects.toThrow(
				/rejected downloadUrl/u,
			);
			// fetch should have been called once (for the manifest) and never
			// for the malicious body URL.
			expect(fetchFn).toHaveBeenCalledOnce();
		});
	}

	it("accepts a legitimate https downloadUrl", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					id: "good",
					name: "good",
					version: "1.0.0",
					downloadUrl: "https://cdn.agentskills.io/good/SKILL.md",
				}),
			)
			.mockResolvedValueOnce(textResponse("# good"));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		const pulled = await client.pullSkill("good", "1.0.0");
		expect(pulled.body).toBe("# good");
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
});

describe("SkillsRegistryClient OOM guards (REAL-2 / REAL-3)", () => {
	it("REAL-2: pullSkill rejects when body Content-Length exceeds maxBodyBytes", async () => {
		const cacheDir = await createTempDir();
		// huge declared length, tiny actual body — we must reject before
		// reading anything.
		const bigBodyResponse = new Response("payload", {
			status: 200,
			headers: {
				"content-type": "text/markdown",
				"content-length": "10000000",
			},
		});
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(sampleEntry))
			.mockResolvedValueOnce(bigBodyResponse);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
			maxBodyBytes: 1024,
		});
		await expect(client.pullSkill("test-skill", "1.0.0")).rejects.toThrow(
			/exceeds maxBodyBytes/u,
		);
	});

	it("REAL-2: pullSkill rejects when streamed bytes exceed maxBodyBytes (no Content-Length)", async () => {
		const cacheDir = await createTempDir();
		const big = "x".repeat(5000);
		const bodyResponse = new Response(big, {
			status: 200,
			headers: { "content-type": "text/markdown" },
		});
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(sampleEntry))
			.mockResolvedValueOnce(bodyResponse);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
			maxBodyBytes: 100,
		});
		await expect(client.pullSkill("test-skill", "1.0.0")).rejects.toThrow(
			/exceeds maxBodyBytes/u,
		);
	});

	it("REAL-3: searchRegistry rejects when payload exceeds maxBodyBytes", async () => {
		const cacheDir = await createTempDir();
		// 5 KB of JSON, maxBodyBytes capped at 100.
		const huge = JSON.stringify({
			results: Array.from({ length: 200 }, (_, i) => ({
				id: `s${i}`,
				name: `name-${i}`,
				version: "1.0.0",
				downloadUrl: "https://cdn.example.com/x",
			})),
		});
		const fetchFn = vi.fn(
			async () =>
				new Response(huge, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
			maxBodyBytes: 100,
		});
		await expect(client.searchRegistry("anything")).rejects.toThrow(
			/search response exceeds maxBodyBytes/u,
		);
	});

	it("REAL-2: pullSkill surfaces JSON parse failure on manifest", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn(
			async () =>
				new Response("{ not valid", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		await expect(client.pullSkill("x", "1.0.0")).rejects.toThrow(
			/manifest is not valid JSON/u,
		);
	});

	it("REAL-3: searchRegistry surfaces JSON parse failure with a stable error", async () => {
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn(
			async () =>
				new Response("{ not valid json", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		await expect(client.searchRegistry("x")).rejects.toThrow(/not valid JSON/u);
	});
});

describe("SkillsRegistryClient request timeout (Reviewer A round 1 REAL-3)", () => {
	/**
	 * Helper: a fetchFn that never resolves on its own — it only rejects
	 * when the caller-supplied AbortSignal fires. This simulates a hung
	 * upstream proxy (server accepts the TCP connection but never sends
	 * a response). Without the timeout wrapper this would block the
	 * agent forever.
	 */
	function hangingFetch(): typeof fetch {
		return ((_url: string | URL, init?: { signal?: AbortSignal }) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal == null) {
					// no signal supplied — keep hanging so the test fails loudly
					return;
				}
				if (signal.aborted) {
					reject(signal.reason ?? new Error("aborted"));
					return;
				}
				signal.addEventListener(
					"abort",
					() => reject(signal.reason ?? new Error("aborted")),
					{ once: true },
				);
			});
		}) as unknown as typeof fetch;
	}

	it("aborts searchRegistry when fetchFn hangs past requestTimeoutMs", async () => {
		const cacheDir = await createTempDir();
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: hangingFetch(),
			writeAuthority: makeAuthority(),
			requestTimeoutMs: 25,
		});
		const started = Date.now();
		await expect(client.searchRegistry("anything")).rejects.toThrow();
		// Should reject within a tight bound; if the timeout were missing the
		// promise would hang forever and Vitest would fail with its own
		// test timeout (5s default), failing the assertion below.
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("aborts pullSkill when manifest fetch hangs past requestTimeoutMs", async () => {
		const cacheDir = await createTempDir();
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: hangingFetch(),
			writeAuthority: makeAuthority(),
			requestTimeoutMs: 25,
		});
		const started = Date.now();
		await expect(client.pullSkill("test-skill", "1.0.0")).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("aborts pullSkill body fetch when body request hangs", async () => {
		const cacheDir = await createTempDir();
		const manifest = jsonResponse(sampleEntry);
		let call = 0;
		const fetchFn = ((_url: string | URL, init?: { signal?: AbortSignal }) => {
			call += 1;
			if (call === 1) {
				return Promise.resolve(manifest);
			}
			// Body request: hang until timeout aborts the signal.
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal == null) return;
				if (signal.aborted) {
					reject(signal.reason ?? new Error("aborted"));
					return;
				}
				signal.addEventListener(
					"abort",
					() => reject(signal.reason ?? new Error("aborted")),
					{ once: true },
				);
			});
		}) as unknown as typeof fetch;
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn,
			writeAuthority: makeAuthority(),
			requestTimeoutMs: 25,
		});
		const started = Date.now();
		await expect(client.pullSkill("test-skill", "1.0.0")).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("uses the default 30s timeout when requestTimeoutMs is omitted", async () => {
		// We don't actually want to wait 30s — just exercise the construction
		// path that picks up the default and prove searchRegistry still
		// resolves on a normal-speed fetchFn.
		const cacheDir = await createTempDir();
		const fetchFn = vi.fn(async () => jsonResponse([]));
		const client = new SkillsRegistryClient({
			cacheDir,
			fetchFn: fetchFn as unknown as typeof fetch,
			writeAuthority: makeAuthority(),
		});
		const result = await client.searchRegistry("anything");
		expect(result).toEqual([]);
		expect(fetchFn).toHaveBeenCalledOnce();
	});
});

describe("resolveRegistryBaseUrlFromEnv (REAL-4)", () => {
	let stderrWrite: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// silence the structured warn lines emitted on fallback so the test
		// output stays clean
		stderrWrite = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
	});

	afterEach(() => {
		stderrWrite.mockRestore();
	});

	it("returns the fallback when env var is unset", () => {
		const result = resolveRegistryBaseUrlFromEnv({});
		expect(result).toBe(FALLBACK_REGISTRY_BASE_URL);
	});

	it("accepts a valid https URL", () => {
		const result = resolveRegistryBaseUrlFromEnv({
			AGENTSKILLS_REGISTRY_URL: "https://registry.example.com/v1",
		});
		expect(result).toBe("https://registry.example.com/v1");
	});

	it("rejects http:// in strict mode and falls back with a warn line", () => {
		const result = resolveRegistryBaseUrlFromEnv({
			AGENTSKILLS_REGISTRY_URL: "http://registry.example.com/v1",
		});
		expect(result).toBe(FALLBACK_REGISTRY_BASE_URL);
		expect(stderrWrite).toHaveBeenCalled();
		const logged = String(stderrWrite.mock.calls[0]?.[0] ?? "");
		expect(logged).toContain("env_registry_url_rejected");
		expect(logged).toContain("disallowed protocol");
	});

	it("rejects file:// even with the insecure opt-in (still not http/https)", () => {
		const result = resolveRegistryBaseUrlFromEnv({
			AGENTSKILLS_REGISTRY_URL: "file:///tmp/registry",
			AGENTSKILLS_ALLOW_INSECURE: "1",
		});
		expect(result).toBe(FALLBACK_REGISTRY_BASE_URL);
	});

	it("rejects loopback by default (SSRF)", () => {
		const result = resolveRegistryBaseUrlFromEnv({
			AGENTSKILLS_REGISTRY_URL: "https://localhost:5432/v1",
		});
		expect(result).toBe(FALLBACK_REGISTRY_BASE_URL);
	});

	it("accepts http + localhost only when AGENTSKILLS_ALLOW_INSECURE=1", () => {
		const result = resolveRegistryBaseUrlFromEnv({
			AGENTSKILLS_REGISTRY_URL: "http://localhost:5000/v1",
			AGENTSKILLS_ALLOW_INSECURE: "1",
		});
		expect(result).toBe("http://localhost:5000/v1");
	});

	it("rejects malformed URLs with a structured warn", () => {
		const result = resolveRegistryBaseUrlFromEnv({
			AGENTSKILLS_REGISTRY_URL: "not a url",
		});
		expect(result).toBe(FALLBACK_REGISTRY_BASE_URL);
		const logged = String(stderrWrite.mock.calls[0]?.[0] ?? "");
		expect(logged).toContain("invalid URL");
	});

	it("default base url constant resolves at module load", () => {
		// Sanity check the back-compat re-export still points somewhere
		// reasonable (either the fallback or a previously-validated env).
		expect(DEFAULT_REGISTRY_BASE_URL).toMatch(/^https?:\/\//u);
	});
});
