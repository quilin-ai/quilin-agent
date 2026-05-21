import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";
import type { WriteAuthority } from "../safety/write-authority.js";
import {
	type EnsureDefaultConfigsResult,
	readUserProfile,
	type UserProfileConfig,
} from "./soul-profile.js";

export type SoulImportFrameworkId =
	| "openclaw"
	| "hermes"
	| "claude-code"
	| "codex"
	| "gemini-cli"
	| "opencode";

export type SoulImportSnippetKind = "persona" | "user" | "project";

export interface SoulImportSnippet {
	readonly framework: SoulImportFrameworkId;
	readonly kind: SoulImportSnippetKind;
	readonly path: string;
	readonly label: string;
	readonly text: string;
	readonly sources: readonly string[];
}

export interface SoulImportFrameworkScan {
	readonly id: SoulImportFrameworkId;
	readonly present: boolean;
	readonly configPath: string | null;
	readonly binaryPath: string | null;
	readonly files: readonly string[];
	readonly missingFiles: readonly string[];
}

export interface SoulImportRedactedItem {
	readonly framework: SoulImportFrameworkId;
	readonly path: string;
	readonly label: string;
	readonly reason: "likely_secret" | "sensitive_path";
}

export interface SoulImportScanPlan {
	readonly mode: "preview";
	readonly frameworks: Record<SoulImportFrameworkId, SoulImportFrameworkScan>;
	readonly personaSnippets: readonly SoulImportSnippet[];
	readonly userSnippets: readonly SoulImportSnippet[];
	readonly projectGuides: readonly SoulImportSnippet[];
	readonly redactedItems: readonly SoulImportRedactedItem[];
	readonly quilinMdCandidate: string | null;
}

export interface SoulImportScanOptions {
	readonly homeDir?: string;
	readonly projectRoot?: string;
	readonly pathEnv?: string;
	readonly maxSnippetChars?: number;
}

export interface SoulImportInstallPreviewOptions extends SoulImportScanOptions {
	readonly existingUserPath?: string;
	readonly seedDefaultConfigs?: boolean;
	readonly authority?: WriteAuthority;
	readonly soulPath?: string;
	readonly userPath?: string;
}

export interface SoulImportInstallPreview {
	readonly mode: "preview";
	readonly plan: SoulImportScanPlan;
	readonly existingUserProfile: UserProfileConfig | null;
	readonly seededDefaults: EnsureDefaultConfigsResult | null;
}

interface CandidateFile {
	readonly framework: SoulImportFrameworkId;
	readonly basePath: string;
	readonly path: string;
	readonly label: string;
	readonly kind: SoulImportSnippetKind;
}

interface FrameworkDefinition {
	readonly id: SoulImportFrameworkId;
	readonly configDirName: string;
	readonly binaryNames: readonly string[];
	readonly globalFiles: readonly string[];
	readonly globalGlobs: readonly string[];
	readonly projectFiles: readonly string[];
	readonly projectGlobs: readonly string[];
}

const MAX_SNIPPET_CHARS = 4_000;
const SECRET_LINE_PATTERN =
	/(?:api[_-]?key|apikey|token|password|secret|authorization|bearer)\s*["']?\s*[:=]\s*["']?\s*(?:bearer\s+)?[A-Za-z0-9._/+~=-]{8,}/iu;
const SENSITIVE_PATH_PATTERN =
	/(?:^|[/\\])(?:\.ssh|\.gnupg)(?:[/\\]|$)|(?:^|[/\\])\.aws(?:[/\\]|$)|(?:^|[/\\])credentials(?:[/\\]|$)|(?:^|[/\\])auth(?:\.json|\.lock)?$/iu;

const FRAMEWORKS: readonly FrameworkDefinition[] = [
	{
		id: "openclaw",
		configDirName: ".openclaw",
		binaryNames: ["openclaw"],
		globalFiles: ["memory.md", "identity.md", "config.md"],
		globalGlobs: ["memory", "identity", "agents"],
		projectFiles: [".openclaw.md", "OPENCLAW.md"],
		projectGlobs: [join(".openclaw", "rules")],
	},
	{
		id: "hermes",
		configDirName: ".hermes",
		binaryNames: ["hermes"],
		globalFiles: ["BOOT.md", "memory.md", "prefs.md", "config.md"],
		globalGlobs: ["memory", "skills", "agents"],
		projectFiles: ["HERMES.md"],
		projectGlobs: [join(".hermes", "rules")],
	},
	{
		id: "claude-code",
		configDirName: ".claude",
		binaryNames: ["claude"],
		globalFiles: ["CLAUDE.md", "memory.md"],
		globalGlobs: ["memories", "projects"],
		projectFiles: ["CLAUDE.md"],
		projectGlobs: [],
	},
	{
		id: "codex",
		configDirName: ".codex",
		binaryNames: ["codex"],
		globalFiles: ["AGENTS.md", "instructions.md", "memory.md", "config.md"],
		globalGlobs: ["memories", "skills"],
		projectFiles: ["AGENTS.md"],
		projectGlobs: [],
	},
	{
		id: "gemini-cli",
		configDirName: ".gemini",
		binaryNames: ["gemini"],
		globalFiles: ["GEMINI.md", "memory.md"],
		globalGlobs: ["memories"],
		projectFiles: ["GEMINI.md"],
		projectGlobs: [],
	},
	{
		id: "opencode",
		configDirName: ".opencode",
		binaryNames: ["opencode"],
		globalFiles: ["rules.md", "config.md", "config.yaml", "config.json"],
		globalGlobs: ["rules", "memories"],
		projectFiles: ["OPENCODE.md"],
		projectGlobs: [join(".opencode", "rules")],
	},
] as const;

export function scanSoulImportSources(
	options: SoulImportScanOptions = {},
): SoulImportScanPlan {
	const home = resolve(options.homeDir ?? homedir());
	const projectRoot =
		options.projectRoot == null ? null : resolve(options.projectRoot);
	const maxSnippetChars = options.maxSnippetChars ?? MAX_SNIPPET_CHARS;

	const frameworks = {} as Record<
		SoulImportFrameworkId,
		SoulImportFrameworkScan
	>;
	const personaCandidates: SoulImportSnippet[] = [];
	const userCandidates: SoulImportSnippet[] = [];
	const projectCandidates: SoulImportSnippet[] = [];
	const redactedItems: SoulImportRedactedItem[] = [];

	for (const framework of FRAMEWORKS) {
		const configPath = join(home, framework.configDirName);
		const binaryPath = findBinaryPath(framework.binaryNames, options);
		const globalFiles = collectGlobalCandidateFiles(framework, configPath);
		const projectFiles =
			projectRoot == null
				? []
				: collectProjectCandidateFiles(framework, projectRoot);
		const files = [...globalFiles, ...projectFiles];
		const snippets = extractSnippets(files, maxSnippetChars, redactedItems);

		for (const snippet of snippets) {
			if (snippet.kind === "persona") {
				personaCandidates.push(snippet);
			} else if (snippet.kind === "project") {
				projectCandidates.push(snippet);
			} else {
				userCandidates.push(snippet);
			}
		}

		frameworks[framework.id] = {
			id: framework.id,
			present:
				isReadableDirectory(configPath) ||
				binaryPath != null ||
				files.length > 0,
			configPath: isReadableDirectory(configPath) ? configPath : null,
			binaryPath,
			files: files.map((file) => file.path),
			missingFiles: framework.globalFiles
				.map((fileName) => join(configPath, fileName))
				.filter((filePath) => !existsSync(filePath)),
		};
	}

	const personaSnippets = dedupeSnippets(personaCandidates);
	const userSnippets = dedupeSnippets(userCandidates);
	const projectGuides = dedupeSnippets(projectCandidates);
	const quilinMdCandidate =
		projectGuides.length === 0 ? null : buildQuilinMdCandidate(projectGuides);

	return {
		mode: "preview",
		frameworks,
		personaSnippets,
		userSnippets,
		projectGuides,
		redactedItems,
		quilinMdCandidate,
	};
}

export async function prepareSoulImportInstallPreview(
	options: SoulImportInstallPreviewOptions = {},
): Promise<SoulImportInstallPreview> {
	const seededDefaults: EnsureDefaultConfigsResult | null = null;
	if (options.seedDefaultConfigs === true) {
		throw new Error(
			"Soul import preview is side-effect-free; seed defaults separately",
		);
	}

	return {
		mode: "preview",
		plan: scanSoulImportSources(options),
		existingUserProfile:
			options.existingUserPath == null
				? null
				: readUserProfile(options.existingUserPath),
		seededDefaults,
	};
}

export function buildQuilinMdCandidate(
	projectGuides: readonly SoulImportSnippet[],
): string {
	const lines = [
		"# QUILIN.md",
		"",
		"<!-- generated-preview: soul-import-scanner; review before writing -->",
		"",
		"## 导入的项目约定 / Imported Project Conventions",
		"",
	];

	for (const guide of projectGuides) {
		lines.push(`<!-- from: ${guide.sources.join(", ")} -->`);
		lines.push(`### ${guide.label}`);
		lines.push("");
		lines.push(guide.text.trim());
		lines.push("");
	}

	lines.push("## 麒麟约定 / Quilin Conventions");
	lines.push("");
	lines.push(
		"- AUTO trust may approve routine actions, but CRITICAL writes still require WriteAuthority confirmation.",
	);
	lines.push(
		"- Keep project-local changes reviewable: small diffs, explicit tests, and no silent QUILIN.md writes.",
	);
	lines.push("");

	return `${lines.join("\n").trimEnd()}\n`;
}

function collectGlobalCandidateFiles(
	framework: FrameworkDefinition,
	configPath: string,
): CandidateFile[] {
	const files: CandidateFile[] = [];
	for (const fileName of framework.globalFiles) {
		const path = join(configPath, fileName);
		if (isReadableFile(path)) {
			files.push({
				framework: framework.id,
				basePath: configPath,
				path,
				label: fileName,
				kind: "user",
			});
		}
	}
	for (const dirName of framework.globalGlobs) {
		files.push(
			...collectMarkdownFiles(join(configPath, dirName), framework.id, "user"),
		);
	}
	return files;
}

function collectProjectCandidateFiles(
	framework: FrameworkDefinition,
	projectRoot: string,
): CandidateFile[] {
	const files: CandidateFile[] = [];
	for (const fileName of framework.projectFiles) {
		const path = join(projectRoot, fileName);
		if (isReadableFile(path)) {
			files.push({
				framework: framework.id,
				basePath: projectRoot,
				path,
				label: fileName,
				kind: "project",
			});
		}
	}
	for (const dirName of framework.projectGlobs) {
		files.push(
			...collectMarkdownFiles(
				join(projectRoot, dirName),
				framework.id,
				"project",
				projectRoot,
			),
		);
	}
	return files;
}

function collectMarkdownFiles(
	dirPath: string,
	framework: SoulImportFrameworkId,
	kind: SoulImportSnippetKind,
	basePath = dirPath,
): CandidateFile[] {
	if (!isReadableDirectory(dirPath)) {
		return [];
	}

	const files: CandidateFile[] = [];
	for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
		const path = join(dirPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectMarkdownFiles(path, framework, kind, basePath));
			continue;
		}
		if (!entry.isFile() || !isSupportedTextFile(path)) {
			continue;
		}
		files.push({
			framework,
			basePath,
			path,
			label: normalizePath(relative(basePath, path)) || basename(path),
			kind,
		});
	}
	return files;
}

function extractSnippets(
	files: readonly CandidateFile[],
	maxSnippetChars: number,
	redactedItems: SoulImportRedactedItem[],
): SoulImportSnippet[] {
	const snippets: SoulImportSnippet[] = [];
	for (const file of files) {
		if (isSensitivePath(file.path) || isSymlink(file.path)) {
			redactedItems.push(createRedactedItem(file, "sensitive_path"));
			continue;
		}

		const raw = readFileSync(file.path, "utf-8");
		const sanitized = redactSecretLines(raw, file, redactedItems).trim();
		if (sanitized === "") {
			continue;
		}

		const text = truncateSnippet(sanitized, maxSnippetChars);
		snippets.push(createSnippet(file, text, file.kind));
		if (file.kind === "user" && looksLikePersonaSnippet(text)) {
			snippets.push(createSnippet(file, text, "persona"));
		}
	}
	return snippets;
}

function createSnippet(
	file: CandidateFile,
	text: string,
	kind: SoulImportSnippetKind,
): SoulImportSnippet {
	return {
		framework: file.framework,
		kind,
		path: file.path,
		label: file.label,
		text,
		sources: [`${file.framework}:${file.label}`],
	};
}

function createRedactedItem(
	file: CandidateFile,
	reason: SoulImportRedactedItem["reason"],
): SoulImportRedactedItem {
	return {
		framework: file.framework,
		path: file.path,
		label: file.label,
		reason,
	};
}

function redactSecretLines(
	raw: string,
	file: CandidateFile,
	redactedItems: SoulImportRedactedItem[],
): string {
	const keptLines: string[] = [];
	for (const line of raw.split(/\r?\n/u)) {
		if (SECRET_LINE_PATTERN.test(line)) {
			redactedItems.push(createRedactedItem(file, "likely_secret"));
			continue;
		}
		keptLines.push(line);
	}
	return keptLines.join("\n");
}

function dedupeSnippets(
	snippets: readonly SoulImportSnippet[],
): SoulImportSnippet[] {
	const byText = new Map<string, SoulImportSnippet>();
	for (const snippet of snippets) {
		const key = normalizeSnippetText(snippet.text);
		const existing = byText.get(key);
		if (existing == null) {
			byText.set(key, snippet);
			continue;
		}
		byText.set(key, {
			...existing,
			sources: [...existing.sources, ...snippet.sources],
		});
	}
	return [...byText.values()];
}

function normalizeSnippetText(text: string): string {
	return text.trim().replace(/\s+/gu, " ");
}

function truncateSnippet(text: string, maxSnippetChars: number): string {
	if (text.length <= maxSnippetChars) {
		return text;
	}
	return `${text.slice(0, maxSnippetChars).trimEnd()}\n[truncated]`;
}

function looksLikePersonaSnippet(text: string): boolean {
	return /\b(?:you are|persona|assistant style|communication style)\b/iu.test(
		text,
	);
}

function isSupportedTextFile(path: string): boolean {
	return /\.(?:md|mdc|txt|ya?ml|json|toml)$/iu.test(path);
}

function isReadableFile(path: string): boolean {
	try {
		return (
			existsSync(path) && !hasSymlinkSegment(path) && statSync(path).isFile()
		);
	} catch {
		return false;
	}
}

function isReadableDirectory(path: string): boolean {
	try {
		return (
			existsSync(path) &&
			!hasSymlinkSegment(path) &&
			statSync(path).isDirectory()
		);
	} catch {
		return false;
	}
}

function isSensitivePath(path: string): boolean {
	return SENSITIVE_PATH_PATTERN.test(normalizePath(path));
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function hasSymlinkSegment(path: string): boolean {
	const resolved = resolve(path);
	const parts = resolved.split(sep).filter(Boolean);
	let current = resolved.startsWith(sep) ? sep : "";
	for (const [index, part] of parts.entries()) {
		current =
			current === sep || current === ""
				? join(current, part)
				: join(current, part);
		// macOS often exposes tmp paths through /var -> /private/var. That
		// top-level OS compatibility symlink is outside the scan root, so do
		// not reject every temp-backed fixture or user home because of it.
		if (resolved.startsWith(sep) && index === 0) {
			continue;
		}
		if (isSymlink(current)) {
			return true;
		}
	}
	return false;
}

function findBinaryPath(
	binaryNames: readonly string[],
	options: SoulImportScanOptions,
): string | null {
	const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) {
			continue;
		}
		for (const binaryName of binaryNames) {
			const binaryPath = join(dir, binaryName);
			if (isReadableBinary(binaryPath)) {
				return binaryPath;
			}
		}
	}
	return null;
}

function isReadableBinary(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

function normalizePath(path: string): string {
	return path.split(sep).join("/");
}
