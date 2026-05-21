import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	buildQuilinMdCandidate,
	type SoulImportScanOptions,
	type SoulImportScanPlan,
	scanSoulImportSources,
} from "../../../packages/agent-core/src/config/soul-import-scanner.js";
import {
	generateRandomSoul,
	type SoulConfig,
	type UserProfileConfig,
	writeSoulConfig,
	writeUserProfile,
} from "../../../packages/agent-core/src/config/soul-profile.js";
import {
	WriteAuthority,
	type WriteRequest,
} from "../../../packages/agent-core/src/safety/write-authority.js";

export type OnboardingPreviewKind = "soul" | "user" | "project";

export interface OnboardingTargetPreview {
	readonly kind: OnboardingPreviewKind;
	readonly path: string;
	readonly content: string;
	readonly exists: boolean;
}

export interface OnboardingPreviewBundle {
	readonly scan: SoulImportScanPlan;
	readonly previews: {
		readonly soul: OnboardingTargetPreview;
		readonly user: OnboardingTargetPreview;
		readonly project: OnboardingTargetPreview;
	};
	readonly configs: {
		readonly soul: SoulConfig;
		readonly user: UserProfileConfig;
	};
}

export interface OnboardingApprovalRequest {
	readonly tool: string;
	readonly riskLevel: string;
	readonly origin: string;
	readonly summary: string;
	readonly detail: string;
	readonly prompt: string;
}

export interface OnboardingInstallResult {
	readonly installed: boolean;
	readonly needsApproval: boolean;
	readonly approvalRequest: OnboardingApprovalRequest | null;
	readonly previews: OnboardingPreviewBundle["previews"];
	readonly written: ReadonlyArray<{ readonly kind: OnboardingPreviewKind; readonly path: string }>;
}

export interface OnboardingInstallInput {
	readonly confirmed?: boolean;
	readonly maxSnippetChars?: number;
}

interface OnboardingRoots {
	readonly homeDir: string;
	readonly projectRoot: string;
}

function resolveRepoRoot(): string {
	let current = resolve(process.cwd());
	while (true) {
		if (existsSync(join(current, "pnpm-workspace.yaml"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return resolve(process.cwd());
		}
		current = parent;
	}
}

function resolveOnboardingRoots(): OnboardingRoots {
	return {
		homeDir: resolve(
			process.env.QUILIN_ONBOARDING_HOME ?? process.env.QUILIN_PROFILE_HOME ?? homedir(),
		),
		projectRoot: resolve(
			process.env.QUILIN_ONBOARDING_PROJECT_ROOT ??
				process.env.QUILIN_PROFILE_PROJECT_ROOT ??
				resolveRepoRoot(),
		),
	};
}

function snippetBlock(
	title: string,
	snippets: SoulImportScanPlan["personaSnippets"],
	emptyText: string,
): string {
	if (snippets.length === 0) {
		return [`## ${title}`, "", emptyText].join("\n");
	}
	const lines = [`## ${title}`, ""];
	for (const snippet of snippets) {
		lines.push(`<!-- from: ${snippet.sources.join(", ")} -->`);
		lines.push(`### ${snippet.framework}:${snippet.label}`);
		lines.push("");
		lines.push(snippet.text.trim());
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function buildSoulConfig(scan: SoulImportScanPlan): SoulConfig {
	const generated = generateRandomSoul();
	return {
		...generated,
		persona_name: "Quilin",
		last_updated_by: "soul_import_web",
		body: [
			generated.body.trim(),
			"",
			snippetBlock(
				"导入的人格片段 / Imported Persona Snippets",
				scan.personaSnippets,
				"*No imported persona snippets were detected.*",
			),
		].join("\n"),
	};
}

function buildUserProfile(scan: SoulImportScanPlan): UserProfileConfig {
	const now = new Date().toISOString();
	return {
		schema_version: 1,
		profile_id: "default",
		scope: "global_projection",
		created_at: now,
		last_updated: now,
		body: snippetBlock(
			"导入的用户画像 / Imported User Profile",
			scan.userSnippets,
			"*No imported user profile snippets were detected.*",
		),
	};
}

function serializeFrontmatter(fields: Record<string, unknown>, body: string): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(fields)) {
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - "${String(item)}"`);
			}
		} else if (typeof value === "number") {
			lines.push(`${key}: ${value}`);
		} else if (value !== "") {
			lines.push(`${key}: "${String(value)}"`);
		}
	}
	lines.push("---", "", body);
	return `${lines.join("\n").trimEnd()}\n`;
}

function renderSoulConfig(config: SoulConfig): string {
	const { body, ...fields } = config;
	return serializeFrontmatter(fields as Record<string, unknown>, body);
}

function renderUserProfile(config: UserProfileConfig): string {
	const { body, ...fields } = config;
	return serializeFrontmatter(fields as Record<string, unknown>, body);
}

function buildProjectContent(scan: SoulImportScanPlan): string {
	if (scan.quilinMdCandidate != null) {
		return scan.quilinMdCandidate;
	}
	return buildQuilinMdCandidate([]);
}

export function buildOnboardingPreviewBundle(
	options: Pick<SoulImportScanOptions, "maxSnippetChars"> = {},
): OnboardingPreviewBundle {
	const roots = resolveOnboardingRoots();
	const scan = scanSoulImportSources({
		homeDir: roots.homeDir,
		projectRoot: roots.projectRoot,
		pathEnv: process.env.PATH ?? "",
		...options,
	});
	const soul = buildSoulConfig(scan);
	const user = buildUserProfile(scan);
	const soulPath = join(roots.homeDir, ".quilin", "soul.md");
	const userPath = join(roots.homeDir, ".quilin", "user.md");
	const projectPath = join(roots.projectRoot, "QUILIN.md");

	return {
		scan,
		previews: {
			soul: {
				kind: "soul",
				path: soulPath,
				content: renderSoulConfig(soul),
				exists: existsSync(soulPath),
			},
			user: {
				kind: "user",
				path: userPath,
				content: renderUserProfile(user),
				exists: existsSync(userPath),
			},
			project: {
				kind: "project",
				path: projectPath,
				content: buildProjectContent(scan),
				exists: existsSync(projectPath),
			},
		},
		configs: { soul, user },
	};
}

function buildInstallWriteRequest(previews: OnboardingPreviewBundle["previews"]): WriteRequest {
	return {
		tool: "soul_import_install",
		riskLevel: "critical",
		origin: "install",
		summary: "Install Quilin Soul Import profile files",
		detail: [
			`soulPath=${previews.soul.path}`,
			`userPath=${previews.user.path}`,
			`projectPath=${previews.project.path}`,
		].join("\n"),
	};
}

function approvalRequestFromDecision(
	request: WriteRequest,
	prompt: string,
): OnboardingApprovalRequest {
	return {
		tool: request.tool,
		riskLevel: request.riskLevel,
		origin: request.origin,
		summary: request.summary,
		detail: request.detail ?? "",
		prompt,
	};
}

export async function installOnboardingSoulImport(
	input: OnboardingInstallInput = {},
): Promise<OnboardingInstallResult> {
	const bundle = buildOnboardingPreviewBundle({
		maxSnippetChars: input.maxSnippetChars,
	});
	const request = buildInstallWriteRequest(bundle.previews);

	if (input.confirmed !== true) {
		const decision = new WriteAuthority({ mode: "ask", actor: "web-onboarding" }).decide(request);
		const prompt =
			decision.kind === "confirm"
				? decision.prompt
				: `[WriteAuthority] ${request.tool} (${request.riskLevel.toUpperCase()}): ${request.summary}`;
		return {
			installed: false,
			needsApproval: true,
			approvalRequest: approvalRequestFromDecision(request, prompt),
			previews: bundle.previews,
			written: [],
		};
	}

	const authority = new WriteAuthority({
		mode: "ask",
		actor: "web-onboarding",
		confirm: async () => true,
	});
	const decision = await authority.authorize(request);
	if (decision.kind !== "allow") {
		const prompt = decision.kind === "deny" ? decision.reason : decision.prompt;
		return {
			installed: false,
			needsApproval: true,
			approvalRequest: approvalRequestFromDecision(request, prompt),
			previews: bundle.previews,
			written: [],
		};
	}

	writeSoulConfig(bundle.configs.soul, bundle.previews.soul.path);
	writeUserProfile(bundle.configs.user, bundle.previews.user.path);
	mkdirSync(dirname(bundle.previews.project.path), { recursive: true });
	writeFileSync(bundle.previews.project.path, bundle.previews.project.content, "utf8");

	return {
		installed: true,
		needsApproval: false,
		approvalRequest: null,
		previews: bundle.previews,
		written: [
			{ kind: "soul", path: bundle.previews.soul.path },
			{ kind: "user", path: bundle.previews.user.path },
			{ kind: "project", path: bundle.previews.project.path },
		],
	};
}
