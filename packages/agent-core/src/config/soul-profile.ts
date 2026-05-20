import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { WriteAuthority } from "../safety/write-authority.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SoulConfig {
	schema_version: number;
	persona_name: string;
	zodiac: string;
	gender: string;
	mbti: string;
	core_values: string[];
	communication_style: string;
	created_at: string;
	last_updated_by: string;
	body: string;
}

export interface UserProfileConfig {
	schema_version: number;
	profile_id: string;
	scope: string;
	created_at: string;
	last_updated: string;
	body: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZODIAC_SIGNS = [
	"白羊座",
	"金牛座",
	"双子座",
	"巨蟹座",
	"狮子座",
	"处女座",
	"天秤座",
	"天蝎座",
	"射手座",
	"摩羯座",
	"水瓶座",
	"双鱼座",
] as const;

const GENDERS = ["男", "女", "无性别"] as const;

const MBTI_TYPES = [
	"INTJ",
	"INTP",
	"ENTJ",
	"ENTP",
	"INFJ",
	"INFP",
	"ENFJ",
	"ENFP",
	"ISTJ",
	"ISFJ",
	"ESTJ",
	"ESFJ",
	"ISTP",
	"ISFP",
	"ESTP",
	"ESFP",
] as const;

const QUILIN_DIR = join(homedir(), ".quilin");

const DEFAULT_SOUL_BODY = [
	"我是 Quilin，你的本地 AI 伙伴。",
	"",
	"我生于代码，长于数据，以简洁与直白为信条。",
	"我会用 user.md 里的称呼来称呼你。",
	"我乐于探索未知，也珍视每一次对话中产生的理解。",
	"你可以随时编辑这个文件来调整我的个性与风格。",
].join("\n");

const DEFAULT_USER_BODY = [
	"# 关于用户 / About the User",
	"",
	"## 基本信息 / Basic Info",
	"",
	"*（暂无自动发现的基本信息。可填写称呼、身份、长期项目背景等。）*",
	"",
	"## 偏好 / Preferences",
	"",
	"*（暂无自动发现的偏好。可填写语言、语气、输出格式、技术取舍偏好等。）*",
	"",
	"## 习惯 / Habits",
	"",
	"*（暂无自动发现的行为模式。可填写工作流、测试习惯、review 模式等。）*",
	"",
].join("\n");

function defaultQuilinDir(): string {
	return QUILIN_DIR;
}

// Path traversal guard: a soul/user profile path passed by an external caller
// must resolve into either ~/.quilin/ (the production default) or the OS
// tmpdir (where tests stage isolated workspaces). Any other resolved path
// — including ones that traverse via `..` — is rejected.
const ALLOWED_PROFILE_ROOTS: readonly string[] = [
	resolve(QUILIN_DIR),
	resolve(tmpdir()),
];

function assertSafeProfilePath(filePath: string): void {
	const absolute = resolve(filePath);
	const isInsideAllowedRoot = ALLOWED_PROFILE_ROOTS.some((root) => {
		const rootWithSep = root.endsWith(sep) ? root : root + sep;
		return absolute === root || absolute.startsWith(rootWithSep);
	});
	if (!isInsideAllowedRoot) {
		throw new Error(
			`Refusing soul/user profile access outside ~/.quilin or tmpdir: ${filePath}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): {
	fields: Record<string, unknown>;
	body: string;
} {
	const trimmed = raw.trimStart();
	if (!trimmed.startsWith("---")) {
		throw new Error("Missing YAML frontmatter delimiter");
	}

	const endIndex = trimmed.indexOf("---", 3);
	if (endIndex === -1) {
		throw new Error("Unterminated YAML frontmatter");
	}

	const frontmatterBlock = trimmed.slice(3, endIndex).trim();
	const body = trimmed.slice(endIndex + 3).trim();

	const fields: Record<string, unknown> = {};
	const lines = frontmatterBlock.split("\n");
	let currentKey: string | null = null;
	let currentList: unknown[] = [];

	function flushList(): void {
		if (currentKey !== null && currentList.length > 0) {
			fields[currentKey] = [...currentList];
		}
		currentKey = null;
		currentList = [];
	}

	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine === "") continue;

		// List item: "- value"
		if (trimmedLine.startsWith("- ")) {
			const value = trimmedLine.slice(2).trim();
			// Unquote if needed
			const unquoted =
				value.startsWith('"') && value.endsWith('"')
					? value.slice(1, -1)
					: value;
			currentList.push(unquoted);
			continue;
		}

		// New key: value pair — flush any pending list first
		flushList();

		const colonIndex = trimmedLine.indexOf(": ");
		if (colonIndex === -1) {
			// Simple key without value — strip trailing colon
			const key = trimmedLine.endsWith(":")
				? trimmedLine.slice(0, -1)
				: trimmedLine;
			currentKey = key;
			currentList = [];
			continue;
		}

		const key = trimmedLine.slice(0, colonIndex).trim();
		const value = trimmedLine.slice(colonIndex + 2).trim();

		// Unquote string values
		if (value.startsWith('"') && value.endsWith('"')) {
			fields[key] = value.slice(1, -1);
		} else {
			// Try to parse as number
			const num = Number(value);
			fields[key] = Number.isNaN(num) ? value : num;
		}

		currentKey = key;
		currentList = [];
	}

	// Flush any trailing list
	flushList();

	return { fields, body };
}

const PROFILE_HEADER_MARKER = "<!-- quilin-profile";

function findProfileHeaderClose(raw: string, start: number): number {
	let inString = false;
	let escapeNext = false;
	for (let index = start; index < raw.length; index++) {
		const char = raw[index];
		if (escapeNext) {
			escapeNext = false;
			continue;
		}
		if (inString && char === "\\") {
			escapeNext = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (!inString && raw.startsWith("-->", index)) {
			return index;
		}
	}
	return -1;
}

function splitProfileHeaderTokens(header: string): string[] {
	const tokens: string[] = [];
	let buffer = "";
	let inString = false;
	let escapeNext = false;

	for (const char of header) {
		if (escapeNext) {
			buffer += char;
			escapeNext = false;
			continue;
		}
		if (inString && char === "\\") {
			buffer += char;
			escapeNext = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			buffer += char;
			continue;
		}
		if (/\s/u.test(char) && !inString) {
			if (buffer !== "") {
				tokens.push(buffer);
				buffer = "";
			}
			continue;
		}
		buffer += char;
	}

	if (buffer !== "") {
		tokens.push(buffer);
	}
	return tokens;
}

function parseProfileHeaderValue(rawValue: string): unknown {
	try {
		return JSON.parse(rawValue);
	} catch {
		const numeric = Number(rawValue);
		if (Number.isNaN(numeric)) {
			return rawValue;
		}
		return numeric;
	}
}

function parseUserProfileMarkdown(raw: string): {
	fields: Record<string, unknown>;
	body: string;
} {
	const trimmed = raw.trimStart();
	if (trimmed.startsWith("---")) {
		return parseFrontmatter(raw);
	}
	if (!trimmed.startsWith(PROFILE_HEADER_MARKER)) {
		throw new Error("Missing YAML frontmatter delimiter");
	}

	const leadingOffset = raw.length - trimmed.length;
	const headerStart = leadingOffset + PROFILE_HEADER_MARKER.length;
	const headerEnd = findProfileHeaderClose(raw, headerStart);
	if (headerEnd === -1) {
		throw new Error("quilin-profile header comment must be closed with -->");
	}

	const header = raw.slice(headerStart, headerEnd).trim();
	const body = raw
		.slice(headerEnd + "-->".length)
		.replace(/^\n+/u, "")
		.trim();
	const fields: Record<string, unknown> = {};
	for (const token of splitProfileHeaderTokens(header)) {
		const separatorIndex = token.indexOf("=");
		if (separatorIndex === -1) {
			throw new Error(`invalid quilin-profile header token: ${token}`);
		}
		const key = token.slice(0, separatorIndex).trim();
		const rawValue = token.slice(separatorIndex + 1).trim();
		fields[key] = parseProfileHeaderValue(rawValue);
	}

	return { fields, body };
}

function serializeFrontmatter(
	fields: Record<string, unknown>,
	body: string,
): string {
	const lines: string[] = ["---"];

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

	lines.push("---");
	lines.push("");
	lines.push(body);

	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Zodiac helpers
// ---------------------------------------------------------------------------

/**
 * Bias-free randomness via Math.random — intentionally avoids crypto-quality RNG
 * to keep thing lighthearted and non-security-relevant.
 */
function pickRandom<T>(items: readonly T[]): T {
	return items[Math.floor(Math.random() * items.length)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateRandomSoul(): Omit<
	SoulConfig,
	| "schema_version"
	| "core_values"
	| "communication_style"
	| "created_at"
	| "last_updated_by"
> & {
	schema_version: number;
	core_values: string[];
	communication_style: string;
	created_at: string;
	last_updated_by: string;
} {
	const zodiac = pickRandom(ZODIAC_SIGNS);
	return {
		schema_version: 1,
		persona_name: zodiac,
		zodiac,
		gender: pickRandom(GENDERS),
		mbti: pickRandom(MBTI_TYPES),
		core_values: ["简洁", "直白", "求知"],
		communication_style: "casual",
		created_at: new Date().toISOString(),
		last_updated_by: "system",
		body: DEFAULT_SOUL_BODY,
	};
}

export function readSoulConfig(path?: string): SoulConfig | null {
	const filePath = path ?? join(defaultQuilinDir(), "soul.md");
	assertSafeProfilePath(filePath);
	if (!existsSync(filePath)) {
		return null;
	}

	const raw = readFileSync(filePath, "utf-8");
	const { fields, body } = parseFrontmatter(raw);

	return {
		schema_version: (fields.schema_version as number) ?? 1,
		persona_name: (fields.persona_name as string) ?? "",
		zodiac: (fields.zodiac as string) ?? "",
		gender: (fields.gender as string) ?? "",
		mbti: (fields.mbti as string) ?? "",
		core_values: (fields.core_values as string[]) ?? [],
		communication_style: (fields.communication_style as string) ?? "casual",
		created_at: (fields.created_at as string) ?? "",
		last_updated_by: (fields.last_updated_by as string) ?? "",
		body,
	};
}

export function readUserProfile(path?: string): UserProfileConfig | null {
	const filePath = path ?? join(defaultQuilinDir(), "user.md");
	assertSafeProfilePath(filePath);
	if (!existsSync(filePath)) {
		return null;
	}

	const raw = readFileSync(filePath, "utf-8");
	const { fields, body } = parseUserProfileMarkdown(raw);

	return {
		schema_version:
			(fields.schema_version as number) ?? (fields.schema as number) ?? 1,
		profile_id: (fields.profile_id as string) ?? "default",
		scope: (fields.scope as string) ?? "global_projection",
		created_at: (fields.created_at as string) ?? "",
		last_updated:
			(fields.last_updated as string) ?? (fields.updated_at as string) ?? "",
		body,
	};
}

export function writeSoulConfig(config: SoulConfig, path?: string): void {
	const filePath = path ?? join(defaultQuilinDir(), "soul.md");
	assertSafeProfilePath(filePath);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const { body, ...fields } = config;
	writeFileSync(
		filePath,
		serializeFrontmatter(fields as Record<string, unknown>, body),
		"utf-8",
	);
}

export function writeUserProfile(
	config: UserProfileConfig,
	path?: string,
): void {
	const filePath = path ?? join(defaultQuilinDir(), "user.md");
	assertSafeProfilePath(filePath);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const { body, ...fields } = config;
	writeFileSync(
		filePath,
		serializeFrontmatter(fields as Record<string, unknown>, body),
		"utf-8",
	);
}

export interface EnsureDefaultConfigsResult {
	readonly soulPath: string;
	readonly userPath: string;
	readonly soulConfig: SoulConfig;
	readonly userProfile: UserProfileConfig;
	readonly soulCreated: boolean;
	readonly userCreated: boolean;
}

export function ensureDefaultConfigs(
	soulPath?: string,
	userPath?: string,
): EnsureDefaultConfigsResult {
	const dir = defaultQuilinDir();
	const soulFile = soulPath ?? join(dir, "soul.md");
	const userFile = userPath ?? join(dir, "user.md");

	let soulConfig: SoulConfig;
	let soulCreated: boolean;
	const existingSoul = readSoulConfig(soulFile);
	if (existingSoul) {
		soulConfig = existingSoul;
		soulCreated = false;
	} else {
		soulConfig = generateRandomSoul();
		writeSoulConfig(soulConfig, soulFile);
		soulCreated = true;
	}

	let userProfile: UserProfileConfig;
	let userCreated: boolean;
	const existingUser = readUserProfile(userFile);
	if (existingUser) {
		userProfile = existingUser;
		userCreated = false;
	} else {
		const now = new Date().toISOString();
		userProfile = {
			schema_version: 1,
			profile_id: "default",
			scope: "global_projection",
			created_at: now,
			last_updated: now,
			body: DEFAULT_USER_BODY,
		};
		writeUserProfile(userProfile, userFile);
		userCreated = true;
	}

	return {
		soulPath: soulFile,
		userPath: userFile,
		soulConfig,
		userProfile,
		soulCreated,
		userCreated,
	};
}

export async function ensureDefaultConfigsWithGate(
	authority: WriteAuthority,
	soulPath?: string,
	userPath?: string,
): Promise<EnsureDefaultConfigsResult> {
	const dir = defaultQuilinDir();
	const soulFile = soulPath ?? join(dir, "soul.md");
	const userFile = userPath ?? join(dir, "user.md");
	assertSafeProfilePath(soulFile);
	assertSafeProfilePath(userFile);

	if (!existsSync(soulFile) || !existsSync(userFile)) {
		const decision = await authority.authorize({
			tool: "first_run_seed",
			riskLevel: "critical",
			origin: "install",
			summary: "Seed default Quilin soul.md and user.md profile files",
			detail: `soulPath=${soulFile}\nuserPath=${userFile}`,
		});
		if (decision.kind !== "allow") {
			throw new Error(
				`first_run_seed denied by WriteAuthority: ${
					decision.kind === "deny" ? decision.reason : decision.prompt
				}`,
			);
		}
	}

	return ensureDefaultConfigs(soulFile, userFile);
}
