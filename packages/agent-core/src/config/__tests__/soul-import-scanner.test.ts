import {
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WriteAuthority } from "../../safety/write-authority.js";
import {
	buildQuilinMdCandidate,
	prepareSoulImportInstallPreview,
	scanSoulImportSources,
} from "../soul-import-scanner.js";

describe("soul-import-scanner", () => {
	let tmpDir: string;
	let homeDir: string;
	let projectRoot: string;

	beforeEach(() => {
		tmpDir = join(
			tmpdir(),
			`quilin-soul-import-scanner-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		homeDir = join(tmpDir, "home");
		projectRoot = join(tmpDir, "project");
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(projectRoot, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("extracts OpenClaw opaque memory snippets", () => {
		writeText(
			join(homeDir, ".openclaw", "memory", "profile.md"),
			"User prefers low-confidence provenance for imports.",
		);

		const plan = scanSoulImportSources({ homeDir, projectRoot, pathEnv: "" });

		expect(plan.frameworks.openclaw.present).toBe(true);
		expect(plan.userSnippets).toContainEqual(
			expect.objectContaining({
				framework: "openclaw",
				text: expect.stringContaining("low-confidence provenance"),
			}),
		);
	});

	it("extracts Hermes BOOT.md snippets", () => {
		writeText(
			join(homeDir, ".hermes", "BOOT.md"),
			"You are a direct assistant. User likes concise risk callouts.",
		);

		const plan = scanSoulImportSources({ homeDir, projectRoot });

		expect(plan.frameworks.hermes.present).toBe(true);
		expect(plan.personaSnippets).toContainEqual(
			expect.objectContaining({
				framework: "hermes",
				text: expect.stringContaining("direct assistant"),
			}),
		);
		expect(plan.userSnippets).toContainEqual(
			expect.objectContaining({
				framework: "hermes",
				text: expect.stringContaining("concise risk callouts"),
			}),
		);
	});

	it("extracts Claude Code persona, user, and project guide snippets", () => {
		writeText(
			join(homeDir, ".claude", "CLAUDE.md"),
			[
				"# Claude Memory",
				"You are concise and pragmatic.",
				"User prefers Chinese summaries.",
			].join("\n"),
		);
		writeText(
			join(projectRoot, "CLAUDE.md"),
			"Run pnpm test before changing TypeScript code.",
		);

		const plan = scanSoulImportSources({ homeDir, projectRoot });

		expect(plan.frameworks["claude-code"].present).toBe(true);
		expect(plan.personaSnippets).toContainEqual(
			expect.objectContaining({
				framework: "claude-code",
				text: expect.stringContaining("concise and pragmatic"),
			}),
		);
		expect(plan.userSnippets).toContainEqual(
			expect.objectContaining({
				framework: "claude-code",
				text: expect.stringContaining("prefers Chinese summaries"),
			}),
		);
		expect(plan.projectGuides).toContainEqual(
			expect.objectContaining({
				framework: "claude-code",
				text: expect.stringContaining("pnpm test"),
			}),
		);
	});

	it("extracts Codex global and project instructions", () => {
		writeText(join(homeDir, ".codex", "AGENTS.md"), "Always use TDD.");
		writeText(join(projectRoot, "AGENTS.md"), "Do not submit commits.");

		const plan = scanSoulImportSources({ homeDir, projectRoot });

		expect(plan.frameworks.codex.present).toBe(true);
		expect(plan.userSnippets).toContainEqual(
			expect.objectContaining({
				framework: "codex",
				text: expect.stringContaining("Always use TDD"),
			}),
		);
		expect(plan.projectGuides).toContainEqual(
			expect.objectContaining({
				framework: "codex",
				text: expect.stringContaining("Do not submit commits"),
			}),
		);
	});

	it("extracts Gemini CLI instructions", () => {
		writeText(join(homeDir, ".gemini", "GEMINI.md"), "Prefer bullet lists.");

		const plan = scanSoulImportSources({ homeDir, projectRoot });

		expect(plan.frameworks["gemini-cli"].present).toBe(true);
		expect(plan.userSnippets).toContainEqual(
			expect.objectContaining({
				framework: "gemini-cli",
				text: expect.stringContaining("Prefer bullet lists"),
			}),
		);
	});

	it("detects OpenCode from binary even without config directory", () => {
		const binDir = join(tmpDir, "bin");
		writeText(join(binDir, "opencode"), "#!/bin/sh\nexit 0");

		const plan = scanSoulImportSources({
			homeDir,
			projectRoot,
			pathEnv: binDir,
		});

		expect(plan.frameworks.opencode.present).toBe(true);
		expect(plan.frameworks.opencode.configPath).toBeNull();
		expect(plan.frameworks.opencode.binaryPath).toBe(join(binDir, "opencode"));
	});

	it("returns an empty preview when framework files are missing", () => {
		const plan = scanSoulImportSources({ homeDir, projectRoot, pathEnv: "" });

		expect(Object.values(plan.frameworks).every((item) => !item.present)).toBe(
			true,
		);
		expect(plan.userSnippets).toEqual([]);
		expect(plan.personaSnippets).toEqual([]);
		expect(plan.projectGuides).toEqual([]);
		expect(plan.quilinMdCandidate).toBeNull();
	});

	it("loads existing HTML-comment user.md metadata through the profile parser", async () => {
		const userPath = join(tmpDir, "existing-user.md");
		writeText(
			userPath,
			'<!-- quilin-profile schema=1 profile_id="legacy" scope="global_projection" updated_at="2026-05-20T00:00:00Z" -->\n# Existing User\n\n已有画像。',
		);

		const preview = await prepareSoulImportInstallPreview({
			homeDir,
			projectRoot,
			existingUserPath: userPath,
		});

		expect(preview.existingUserProfile?.profile_id).toBe("legacy");
		expect(preview.existingUserProfile?.body).toContain("已有画像");
	});

	it("preview refuses install seeding and never writes default configs", async () => {
		const soulPath = join(tmpDir, "seed", "soul.md");
		const userPath = join(tmpDir, "seed", "user.md");
		const authority = new WriteAuthority({
			mode: "ask",
			confirm: async () => false,
		});

		await expect(
			prepareSoulImportInstallPreview({
				homeDir,
				projectRoot,
				authority,
				soulPath,
				userPath,
				seedDefaultConfigs: true,
			}),
		).rejects.toThrow(/side-effect-free/u);
		expect(existsSync(soulPath)).toBe(false);
		expect(existsSync(userPath)).toBe(false);
	});

	it("preview mode never writes QUILIN.md", async () => {
		writeText(join(projectRoot, "AGENTS.md"), "Keep commits focused.");

		const preview = await prepareSoulImportInstallPreview({
			homeDir,
			projectRoot,
		});

		expect(preview.plan.quilinMdCandidate).toContain("Keep commits focused");
		expect(existsSync(join(projectRoot, "QUILIN.md"))).toBe(false);
	});

	it("deduplicates repeated snippets across frameworks", () => {
		writeText(join(homeDir, ".claude", "CLAUDE.md"), "Prefer short answers.");
		writeText(join(homeDir, ".codex", "AGENTS.md"), "Prefer short answers.");
		writeText(join(projectRoot, "CLAUDE.md"), "Run unit tests.");
		writeText(join(projectRoot, "AGENTS.md"), "Run unit tests.");

		const plan = scanSoulImportSources({ homeDir, projectRoot });

		expect(plan.userSnippets).toHaveLength(1);
		expect(plan.userSnippets[0]?.sources).toEqual([
			"claude-code:CLAUDE.md",
			"codex:AGENTS.md",
		]);
		expect(plan.projectGuides).toHaveLength(1);
		expect(plan.projectGuides[0]?.sources).toEqual([
			"claude-code:CLAUDE.md",
			"codex:AGENTS.md",
		]);
	});

	it("redacts likely secrets before snippets reach preview output", () => {
		writeText(
			join(homeDir, ".codex", "AGENTS.md"),
			[
				'api_key = "abcdefghijklmnopqrstuvwxyz"',
				'"apiKey": "sk-1234567890abcdef"',
				"Authorization: Bearer abcdefghijklmnop",
				"Keep responses terse.",
			].join("\n"),
		);

		const plan = scanSoulImportSources({ homeDir, projectRoot });
		const preview = JSON.stringify(plan);

		expect(preview).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(plan.redactedItems).toContainEqual(
			expect.objectContaining({ framework: "codex", reason: "likely_secret" }),
		);
		expect(plan.userSnippets[0]?.text).toContain("Keep responses terse");
	});

	it("ignores symlinked candidate files before reading their target", () => {
		const secretTarget = join(tmpDir, ".ssh", "id_rsa.md");
		writeText(secretTarget, "PRIVATE KEY SHOULD NOT BE READ");
		mkdirSync(join(homeDir, ".codex"), { recursive: true });
		symlinkSync(secretTarget, join(homeDir, ".codex", "AGENTS.md"));

		const plan = scanSoulImportSources({ homeDir, projectRoot });
		const preview = JSON.stringify(plan);

		expect(preview).not.toContain("PRIVATE KEY SHOULD NOT BE READ");
		expect(plan.userSnippets).toEqual([]);
	});

	it("ignores symlinked framework directories before reading nested files", () => {
		const secretConfig = join(tmpDir, "secret-codex-config");
		writeText(
			join(secretConfig, "AGENTS.md"),
			"PRIVATE DIRECTORY SHOULD NOT BE READ",
		);
		symlinkSync(secretConfig, join(homeDir, ".codex"), "dir");

		const plan = scanSoulImportSources({ homeDir, projectRoot, pathEnv: "" });
		const preview = JSON.stringify(plan);

		expect(preview).not.toContain("PRIVATE DIRECTORY SHOULD NOT BE READ");
		expect(plan.frameworks.codex.present).toBe(false);
		expect(plan.userSnippets).toEqual([]);
	});

	it("builds a QUILIN.md candidate from project guide snippets only", () => {
		const candidate = buildQuilinMdCandidate([
			{
				framework: "codex",
				kind: "project",
				path: join(projectRoot, "AGENTS.md"),
				label: "AGENTS.md",
				text: "Use Vitest for TypeScript changes.",
				sources: ["codex:AGENTS.md"],
			},
		]);

		expect(candidate).toContain("# QUILIN.md");
		expect(candidate).toContain("Use Vitest for TypeScript changes.");
		expect(candidate).toContain("## 麒麟约定 / Quilin Conventions");
	});
});

function writeText(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${content.trim()}\n`, "utf-8");
}
