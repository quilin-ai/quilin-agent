import { expect, test } from "@playwright/test";

const scanPayload = {
	ok: true,
	data: {
		scan: {
			mode: "preview",
			frameworks: {
				openclaw: {
					id: "openclaw",
					present: false,
					configPath: null,
					binaryPath: null,
					files: [],
					missingFiles: [],
				},
				hermes: {
					id: "hermes",
					present: false,
					configPath: null,
					binaryPath: null,
					files: [],
					missingFiles: [],
				},
				"claude-code": {
					id: "claude-code",
					present: true,
					configPath: "/tmp/home/.claude",
					binaryPath: null,
					files: ["/tmp/home/.claude/CLAUDE.md"],
					missingFiles: [],
				},
				codex: {
					id: "codex",
					present: true,
					configPath: "/tmp/home/.codex",
					binaryPath: "/usr/local/bin/codex",
					files: ["/tmp/home/.codex/AGENTS.md", "/tmp/project/AGENTS.md"],
					missingFiles: [],
				},
				"gemini-cli": {
					id: "gemini-cli",
					present: false,
					configPath: null,
					binaryPath: null,
					files: [],
					missingFiles: [],
				},
				opencode: {
					id: "opencode",
					present: false,
					configPath: null,
					binaryPath: null,
					files: [],
					missingFiles: [],
				},
			},
			personaSnippets: [
				{
					framework: "claude-code",
					kind: "persona",
					path: "/tmp/home/.claude/CLAUDE.md",
					label: "CLAUDE.md",
					text: "You are a pragmatic assistant.",
					sources: ["claude-code:CLAUDE.md"],
				},
			],
			userSnippets: [
				{
					framework: "codex",
					kind: "user",
					path: "/tmp/home/.codex/AGENTS.md",
					label: "AGENTS.md",
					text: "User prefers Chinese summaries.",
					sources: ["codex:AGENTS.md"],
				},
			],
			projectGuides: [
				{
					framework: "codex",
					kind: "project",
					path: "/tmp/project/AGENTS.md",
					label: "AGENTS.md",
					text: "Run Vitest before TypeScript changes.",
					sources: ["codex:AGENTS.md"],
				},
			],
			redactedItems: [],
			quilinMdCandidate: "# QUILIN.md\n\nRun Vitest before TypeScript changes.\n",
		},
		previews: {
			soul: {
				path: "/tmp/home/.quilin/soul.md",
				content: '---\npersona_name: "Quilin"\n---\n\nYou are a pragmatic assistant.\n',
			},
			user: {
				path: "/tmp/home/.quilin/user.md",
				content: '---\nprofile_id: "default"\n---\n\nUser prefers Chinese summaries.\n',
			},
			project: {
				path: "/tmp/project/QUILIN.md",
				content: "# QUILIN.md\n\nRun Vitest before TypeScript changes.\n",
			},
		},
	},
};

test("onboarding Soul Import wizard scans, previews, and confirms install", async ({ page }) => {
	let installBody: Record<string, unknown> | null = null;

	await page.route("**/api/onboarding/scan", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(scanPayload),
		});
	});

	await page.route("**/api/onboarding/install", async (route) => {
		installBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				ok: true,
				data: {
					installed: true,
					needsApproval: false,
					written: [
						{ kind: "soul", path: "/tmp/home/.quilin/soul.md" },
						{ kind: "user", path: "/tmp/home/.quilin/user.md" },
						{ kind: "project", path: "/tmp/project/QUILIN.md" },
					],
				},
			}),
		});
	});

	await page.goto("/onboarding");
	await expect(page.getByTestId("onboarding-step-welcome")).toBeVisible();
	await expect(page.getByText("Soul Import")).toBeVisible();

	await page.getByTestId("onboarding-start-scan").click();
	await expect(page.getByTestId("onboarding-step-frameworks")).toBeVisible();
	await expect(page.getByTestId("framework-card-codex")).toContainText("Detected");
	await expect(page.getByTestId("framework-card-claude-code")).toContainText("Detected");
	await expect(page.getByTestId("framework-card-gemini-cli")).toContainText("Not found");

	await page.getByTestId("onboarding-next-to-preview").click();
	await expect(page.getByTestId("onboarding-step-preview")).toBeVisible();
	await expect(page.getByTestId("preview-soul")).toContainText("pragmatic assistant");
	await expect(page.getByTestId("preview-user")).toContainText("Chinese summaries");
	await expect(page.getByTestId("preview-project")).toContainText("Run Vitest");

	await page.getByTestId("onboarding-next-to-confirm").click();
	await expect(page.getByTestId("onboarding-step-confirm")).toBeVisible();
	await page.getByTestId("onboarding-confirm-install").click();
	await expect(page.getByText("Installed")).toBeVisible();
	expect(installBody).toEqual(expect.objectContaining({ confirmed: true }));
});
