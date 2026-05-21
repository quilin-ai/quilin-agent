import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.QUILIN_ONBOARDING_HOME;
const ORIGINAL_PROJECT_ROOT = process.env.QUILIN_ONBOARDING_PROJECT_ROOT;

let testRoot: string;
let homeDir: string;
let projectRoot: string;

function writeText(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${content.trim()}\n`, "utf8");
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
	testRoot = mkdtempSync(join(tmpdir(), "quilin-onboarding-route-"));
	homeDir = join(testRoot, "home");
	projectRoot = join(testRoot, "project");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(projectRoot, { recursive: true });
	process.env.QUILIN_ONBOARDING_HOME = homeDir;
	process.env.QUILIN_ONBOARDING_PROJECT_ROOT = projectRoot;
});

afterEach(() => {
	rmSync(testRoot, { recursive: true, force: true });
	if (ORIGINAL_HOME === undefined) {
		delete process.env.QUILIN_ONBOARDING_HOME;
	} else {
		process.env.QUILIN_ONBOARDING_HOME = ORIGINAL_HOME;
	}
	if (ORIGINAL_PROJECT_ROOT === undefined) {
		delete process.env.QUILIN_ONBOARDING_PROJECT_ROOT;
	} else {
		process.env.QUILIN_ONBOARDING_PROJECT_ROOT = ORIGINAL_PROJECT_ROOT;
	}
});

describe("POST /api/onboarding/scan", () => {
	it("returns six framework scans and target file previews from existing Soul Import sources", async () => {
		writeText(
			join(homeDir, ".codex", "AGENTS.md"),
			[
				"You are a direct assistant with careful risk callouts.",
				"User prefers Chinese summaries and concise follow-ups.",
			].join("\n"),
		);
		writeText(join(projectRoot, "AGENTS.md"), "Run Vitest before changing TypeScript code.");

		const { POST } = await import("@/app/api/onboarding/scan/route");
		const response = await POST(
			new Request("http://localhost/api/onboarding/scan", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		const body = await jsonBody(response);

		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		const data = body.data as {
			scan: {
				frameworks: Record<string, { present: boolean }>;
				personaSnippets: Array<{ text: string }>;
				userSnippets: Array<{ text: string }>;
				projectGuides: Array<{ text: string }>;
			};
			previews: Record<"soul" | "user" | "project", { path: string; content: string }>;
		};
		expect(Object.keys(data.scan.frameworks).sort()).toEqual([
			"claude-code",
			"codex",
			"gemini-cli",
			"hermes",
			"openclaw",
			"opencode",
		]);
		expect(data.scan.frameworks.codex?.present).toBe(true);
		expect(data.scan.personaSnippets[0]?.text).toContain("direct assistant");
		expect(data.scan.userSnippets[0]?.text).toContain("Chinese summaries");
		expect(data.scan.projectGuides[0]?.text).toContain("Vitest");
		expect(data.previews.soul.path).toBe(join(homeDir, ".quilin", "soul.md"));
		expect(data.previews.soul.content).toContain("direct assistant");
		expect(data.previews.user.content).toContain("Chinese summaries");
		expect(data.previews.project.path).toBe(join(projectRoot, "QUILIN.md"));
		expect(data.previews.project.content).toContain("Run Vitest");
		expect(existsSync(join(homeDir, ".quilin", "soul.md"))).toBe(false);
		expect(existsSync(join(projectRoot, "QUILIN.md"))).toBe(false);
	});
});

describe("POST /api/onboarding/install", () => {
	it("returns a WriteAuthority approval request and does not write when confirmation is missing", async () => {
		writeText(join(homeDir, ".codex", "AGENTS.md"), "You are concise. User prefers TDD.");
		writeText(join(projectRoot, "AGENTS.md"), "Do not submit commits.");

		const { POST } = await import("@/app/api/onboarding/install/route");
		const response = await POST(
			new Request("http://localhost/api/onboarding/install", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		const body = await jsonBody(response);

		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		const data = body.data as {
			needsApproval: boolean;
			approvalRequest: { tool: string; riskLevel: string; origin: string; prompt: string };
		};
		expect(data.needsApproval).toBe(true);
		expect(data.approvalRequest).toEqual(
			expect.objectContaining({
				tool: "soul_import_install",
				riskLevel: "critical",
				origin: "install",
			}),
		);
		expect(data.approvalRequest.prompt).toContain("WriteAuthority");
		expect(existsSync(join(homeDir, ".quilin", "soul.md"))).toBe(false);
		expect(existsSync(join(homeDir, ".quilin", "user.md"))).toBe(false);
		expect(existsSync(join(projectRoot, "QUILIN.md"))).toBe(false);
	});

	it("writes soul.md, user.md, and QUILIN.md only after explicit confirmation", async () => {
		writeText(join(homeDir, ".codex", "AGENTS.md"), "You are concise. User prefers TDD.");
		writeText(join(projectRoot, "AGENTS.md"), "Do not submit commits.");

		const { POST } = await import("@/app/api/onboarding/install/route");
		const response = await POST(
			new Request("http://localhost/api/onboarding/install", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ confirmed: true }),
			}),
		);
		const body = await jsonBody(response);

		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		const data = body.data as { installed: boolean; needsApproval: boolean };
		expect(data.installed).toBe(true);
		expect(data.needsApproval).toBe(false);
		expect(readFileSync(join(homeDir, ".quilin", "soul.md"), "utf8")).toContain("concise");
		expect(readFileSync(join(homeDir, ".quilin", "user.md"), "utf8")).toContain("TDD");
		expect(readFileSync(join(projectRoot, "QUILIN.md"), "utf8")).toContain("Do not submit commits");
	});
});
