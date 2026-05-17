import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WriteAuthority } from "../safety/write-authority.js";
import {
	DEFAULT_REGISTRY_BASE_URL,
	type RegistrySkillEntry,
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
});
