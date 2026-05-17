import { describe, expect, it, vi } from "vitest";
import {
	defaultCandidatePaths,
	detectObsidianVaults,
	type VaultEvidence,
} from "./detector.js";

function makeEvidence(
	files: ReadonlyArray<{
		path: string;
		sizeBytes: number;
		modifiedAt: Date;
		isMarkdown: boolean;
	}>,
	hasObsidianConfigDir = true,
): VaultEvidence {
	return { hasObsidianConfigDir, files };
}

describe("defaultCandidatePaths", () => {
	it("expands well-known locations under home directory", () => {
		const paths = defaultCandidatePaths("/home/alice");
		expect(paths).toContain("/home/alice/Documents/Obsidian");
		expect(paths).toContain("/home/alice/.config/obsidian");
		expect(paths.length).toBeGreaterThan(0);
	});

	it("strips trailing slash from home dir", () => {
		const paths = defaultCandidatePaths("/home/alice/");
		expect(paths).toContain("/home/alice/Documents/Obsidian");
		expect(paths.every((p) => !p.startsWith("/home/alice//"))).toBe(true);
	});

	it("returns a frozen / readonly list", () => {
		const paths = defaultCandidatePaths("/home/alice");
		expect(Object.isFrozen(paths)).toBe(true);
	});
});

describe("detectObsidianVaults", () => {
	it("returns empty when no candidate is a vault", async () => {
		const probeCandidate = vi.fn(async () => null);
		const out = await detectObsidianVaults({
			homeDir: "/home/alice",
			probeCandidate,
		});
		expect(out).toEqual([]);
		expect(probeCandidate.mock.calls.length).toBeGreaterThan(0);
	});

	it("filters out directories without .obsidian config", async () => {
		const probeCandidate = vi.fn(async (path: string) => {
			if (path === "/home/alice/Documents/Obsidian") {
				return makeEvidence(
					[
						{
							path: "note.md",
							sizeBytes: 100,
							modifiedAt: new Date("2026-05-01T00:00:00Z"),
							isMarkdown: true,
						},
					],
					false,
				);
			}
			return null;
		});
		const out = await detectObsidianVaults({
			homeDir: "/home/alice",
			probeCandidate,
		});
		expect(out).toEqual([]);
	});

	it("summarises a detected vault with size + latest mtime + note count", async () => {
		const probeCandidate = vi.fn(async (path: string) => {
			if (path === "/home/alice/Documents/Obsidian") {
				return makeEvidence([
					{
						path: "a.md",
						sizeBytes: 100,
						modifiedAt: new Date("2026-04-01T00:00:00Z"),
						isMarkdown: true,
					},
					{
						path: "b.md",
						sizeBytes: 200,
						modifiedAt: new Date("2026-05-10T00:00:00Z"),
						isMarkdown: true,
					},
					{
						path: "attachment.png",
						sizeBytes: 50_000,
						modifiedAt: new Date("2026-03-01T00:00:00Z"),
						isMarkdown: false,
					},
				]);
			}
			return null;
		});
		const out = await detectObsidianVaults({
			homeDir: "/home/alice",
			probeCandidate,
		});
		expect(out).toHaveLength(1);
		const vault = out[0];
		if (!vault) throw new Error("expected vault");
		expect(vault.path).toBe("/home/alice/Documents/Obsidian");
		expect(vault.sizeBytes).toBe(100 + 200 + 50_000);
		expect(vault.noteCount).toBe(2);
		expect(vault.lastModified.toISOString()).toBe("2026-05-10T00:00:00.000Z");
	});

	it("merges user-specified extraPaths with default candidates", async () => {
		const probedPaths: string[] = [];
		const probeCandidate = vi.fn(async (path: string) => {
			probedPaths.push(path);
			if (path === "/srv/vault") {
				return makeEvidence([
					{
						path: "x.md",
						sizeBytes: 10,
						modifiedAt: new Date("2026-01-01T00:00:00Z"),
						isMarkdown: true,
					},
				]);
			}
			return null;
		});
		const out = await detectObsidianVaults({
			homeDir: "/home/alice",
			extraPaths: ["/srv/vault"],
			probeCandidate,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.path).toBe("/srv/vault");
		expect(probedPaths).toContain("/srv/vault");
	});

	it("dedupes extraPaths colliding with default candidate paths", async () => {
		const probeCandidate = vi.fn<(p: string) => Promise<VaultEvidence | null>>(
			async () => null,
		);
		await detectObsidianVaults({
			homeDir: "/home/alice",
			extraPaths: ["/home/alice/Documents/Obsidian/", ""],
			probeCandidate,
		});
		const probedPaths = probeCandidate.mock.calls.map((args) => args[0]);
		const occurrences = probedPaths.filter(
			(p) => p === "/home/alice/Documents/Obsidian",
		).length;
		expect(occurrences).toBe(1);
		expect(probedPaths).not.toContain("");
	});

	it("treats files with non-finite mtime as 0 epoch", async () => {
		const probeCandidate = vi.fn(async (path: string) => {
			if (path === "/home/alice/Documents/Obsidian") {
				return makeEvidence([
					{
						path: "broken.md",
						sizeBytes: 10,
						modifiedAt: new Date(Number.NaN),
						isMarkdown: true,
					},
				]);
			}
			return null;
		});
		const out = await detectObsidianVaults({
			homeDir: "/home/alice",
			probeCandidate,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.lastModified.getTime()).toBe(0);
	});

	it("clamps negative file sizes to zero", async () => {
		const probeCandidate = vi.fn(async (path: string) => {
			if (path === "/home/alice/Documents/Obsidian") {
				return makeEvidence([
					{
						path: "a.md",
						sizeBytes: -10,
						modifiedAt: new Date("2026-01-01T00:00:00Z"),
						isMarkdown: true,
					},
					{
						path: "b.md",
						sizeBytes: 50,
						modifiedAt: new Date("2026-01-02T00:00:00Z"),
						isMarkdown: true,
					},
				]);
			}
			return null;
		});
		const out = await detectObsidianVaults({
			homeDir: "/home/alice",
			probeCandidate,
		});
		expect(out[0]?.sizeBytes).toBe(50);
	});

	it("returns a frozen result list", async () => {
		const probeCandidate = vi.fn(async () => null);
		const out = await detectObsidianVaults({
			homeDir: "/home/alice",
			probeCandidate,
		});
		expect(Object.isFrozen(out)).toBe(true);
	});
});
