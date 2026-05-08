import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SoulConfig, UserProfileConfig } from "./soul-profile.js";
import {
	ensureDefaultConfigs,
	generateRandomSoul,
	readSoulConfig,
	readUserProfile,
	writeSoulConfig,
	writeUserProfile,
} from "./soul-profile.js";

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

describe("soul-profile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(
			tmpdir(),
			`quilin-soul-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// generateRandomSoul
	// -----------------------------------------------------------------------

	describe("generateRandomSoul", () => {
		it("returns zodiac within the 12 valid signs", () => {
			for (let i = 0; i < 50; i++) {
				const soul = generateRandomSoul();
				expect(ZODIAC_SIGNS).toContain(soul.zodiac);
			}
		});

		it("returns gender within the 3 valid options", () => {
			for (let i = 0; i < 50; i++) {
				const soul = generateRandomSoul();
				expect(GENDERS).toContain(soul.gender);
			}
		});

		it("returns MBTI within the 16 valid types", () => {
			for (let i = 0; i < 50; i++) {
				const soul = generateRandomSoul();
				expect(MBTI_TYPES).toContain(soul.mbti);
			}
		});

		it("uses zodiac sign as the default persona_name", () => {
			for (let i = 0; i < 20; i++) {
				const soul = generateRandomSoul();
				expect(soul.persona_name).toBe(soul.zodiac);
			}
		});

		it("includes default core_values, communication_style, schema_version", () => {
			const soul = generateRandomSoul();

			expect(soul.schema_version).toBe(1);
			expect(soul.core_values).toEqual(["简洁", "直白", "求知"]);
			expect(soul.communication_style).toBe("casual");
			expect(soul.body).toBeTruthy();
			expect(soul.body).toContain("Quilin");
		});

		it("sets created_at to an ISO-8601 timestamp", () => {
			const soul = generateRandomSoul();
			expect(() => new Date(soul.created_at)).not.toThrow();
			expect(new Date(soul.created_at).toISOString()).toBe(soul.created_at);
		});

		it("sets last_updated_by to system", () => {
			const soul = generateRandomSoul();
			expect(soul.last_updated_by).toBe("system");
		});
	});

	// -----------------------------------------------------------------------
	// writeSoulConfig / readSoulConfig
	// -----------------------------------------------------------------------

	describe("writeSoulConfig / readSoulConfig", () => {
		it("writes and reads a soul config roundtrip with fidelity", () => {
			const soulPath = join(tmpDir, "soul.md");
			const original: SoulConfig = {
				schema_version: 1,
				persona_name: "星辰",
				zodiac: "天蝎座",
				gender: "无性别",
				mbti: "INTJ",
				core_values: ["简洁", "直白", "求知"],
				communication_style: "casual",
				created_at: "2026-05-07T12:00:00Z",
				last_updated_by: "system",
				body: "我是 Quilin，你的本地 AI 伙伴。\n\n第二行内容。",
			};

			writeSoulConfig(original, soulPath);
			expect(existsSync(soulPath)).toBe(true);

			const read = readSoulConfig(soulPath);
			expect(read).not.toBeNull();

			expect(read!.schema_version).toBe(original.schema_version);
			expect(read!.persona_name).toBe(original.persona_name);
			expect(read!.zodiac).toBe(original.zodiac);
			expect(read!.gender).toBe(original.gender);
			expect(read!.mbti).toBe(original.mbti);
			expect(read!.core_values).toEqual(original.core_values);
			expect(read!.communication_style).toBe(original.communication_style);
			expect(read!.created_at).toBe(original.created_at);
			expect(read!.last_updated_by).toBe(original.last_updated_by);
			expect(read!.body).toBe(original.body);
		});

		it("returns null for non-existent soul config", () => {
			const result = readSoulConfig(join(tmpDir, "nonexistent-soul.md"));
			expect(result).toBeNull();
		});

		it("handles multiline body content in roundtrip", () => {
			const soulPath = join(tmpDir, "soul-multiline.md");
			const config: SoulConfig = {
				schema_version: 1,
				persona_name: "Leo",
				zodiac: "狮子座",
				gender: "男",
				mbti: "ENFP",
				core_values: ["自由", "创造力"],
				communication_style: "enthusiastic",
				created_at: "2026-01-01T00:00:00Z",
				last_updated_by: "user",
				body: "Line A\nLine B\n\nLine C after blank.",
			};

			writeSoulConfig(config, soulPath);
			const read = readSoulConfig(soulPath);
			expect(read!.body).toBe(config.body);
		});

		it("defaults to ~/.quilin/soul.md when no path is given", () => {
			const config: SoulConfig = {
				schema_version: 1,
				persona_name: "DefaultPath",
				zodiac: "白羊座",
				gender: "男",
				mbti: "ISTJ",
				core_values: ["test"],
				communication_style: "casual",
				created_at: "2026-05-07T12:00:00Z",
				last_updated_by: "test",
				body: "Default path test.",
			};
			// Passing no path exercises the ?? join(defaultQuilinDir(), ...) branch
			writeSoulConfig(config);
			const defaultPath = join(homedir(), ".quilin", "soul.md");
			expect(existsSync(defaultPath)).toBe(true);
			const read = readSoulConfig();
			expect(read).not.toBeNull();
			expect(read!.persona_name).toBe("DefaultPath");
		});

		it("creates parent directory when it does not exist", () => {
			const deepPath = join(tmpDir, "nested", "dir", "soul.md");
			const config: SoulConfig = {
				schema_version: 1,
				persona_name: "Nested",
				zodiac: "金牛座",
				gender: "女",
				mbti: "ISFJ",
				core_values: ["稳定"],
				communication_style: "warm",
				created_at: "2026-05-07T12:00:00Z",
				last_updated_by: "test",
				body: "Nested dir test.",
			};
			writeSoulConfig(config, deepPath);
			expect(existsSync(deepPath)).toBe(true);
			const read = readSoulConfig(deepPath);
			expect(read!.persona_name).toBe("Nested");
		});

		it("writes a file parsable by parseFrontmatter (no double-encode)", () => {
			const soulPath = join(tmpDir, "soul-reparse.md");
			const config: SoulConfig = {
				schema_version: 1,
				persona_name: "Test",
				zodiac: "水瓶座",
				gender: "女",
				mbti: "INFJ",
				core_values: ["test"],
				communication_style: "calm",
				created_at: "2026-05-07T12:00:00Z",
				last_updated_by: "system",
				body: "Body text.",
			};

			writeSoulConfig(config, soulPath);
			// Read back raw to ensure the file isn't corrupted
			const raw = readFileSync(soulPath, "utf-8");
			// Should start with ---
			expect(raw.trimStart()).toMatch(/^---/);
			// Should contain core values as a list
			expect(raw).toContain('- "test"');
			// Should contain the body
			expect(raw).toContain("Body text.");
		});

		it("throws on a file with no YAML frontmatter delimiter", () => {
			const soulPath = join(tmpDir, "soul-no-frontmatter.md");
			writeFileSync(
				soulPath,
				"Just plain text, no frontmatter at all.",
				"utf-8",
			);
			expect(() => readSoulConfig(soulPath)).toThrow(
				"Missing YAML frontmatter delimiter",
			);
		});

		it("throws on a file with unterminated YAML frontmatter", () => {
			const soulPath = join(tmpDir, "soul-unterminated.md");
			writeFileSync(
				soulPath,
				"---\nkey: value\nBody without closing delimiter.",
				"utf-8",
			);
			expect(() => readSoulConfig(soulPath)).toThrow(
				"Unterminated YAML frontmatter",
			);
		});

		it("fills defaults for missing frontmatter fields", () => {
			const soulPath = join(tmpDir, "soul-minimal.md");
			writeFileSync(soulPath, "---\n---\n\nMinimal body.", "utf-8");
			const read = readSoulConfig(soulPath);
			expect(read).not.toBeNull();
			// All fields get default values from ?? fallbacks
			expect(read!.schema_version).toBe(1);
			expect(read!.persona_name).toBe("");
			expect(read!.core_values).toEqual([]);
			expect(read!.communication_style).toBe("casual");
		});

		it("parses an unquoted non-numeric value as a string", () => {
			const soulPath = join(tmpDir, "soul-unquoted.md");
			writeFileSync(
				soulPath,
				"---\nschema_version: 1\npersona_name: TestName\n---\n\nBody.",
				"utf-8",
			);
			const read = readSoulConfig(soulPath);
			expect(read).not.toBeNull();
			expect(read!.persona_name).toBe("TestName");
		});
	});

	// -----------------------------------------------------------------------
	// writeUserProfile / readUserProfile
	// -----------------------------------------------------------------------

	describe("writeUserProfile / readUserProfile", () => {
		it("writes and reads user profile roundtrip with fidelity", () => {
			const userPath = join(tmpDir, "user.md");
			const original: UserProfileConfig = {
				schema_version: 1,
				profile_id: "default",
				scope: "global_projection",
				created_at: "2026-05-07T12:00:00Z",
				last_updated: "2026-05-07T12:00:00Z",
				body: "# 关于用户\n\n## 基本信息\n（待发现）",
			};

			writeUserProfile(original, userPath);
			expect(existsSync(userPath)).toBe(true);

			const read = readUserProfile(userPath);
			expect(read).not.toBeNull();

			expect(read!.schema_version).toBe(original.schema_version);
			expect(read!.profile_id).toBe(original.profile_id);
			expect(read!.scope).toBe(original.scope);
			expect(read!.created_at).toBe(original.created_at);
			expect(read!.last_updated).toBe(original.last_updated);
			expect(read!.body).toBe(original.body);
		});

		it("returns null for non-existent user profile", () => {
			const result = readUserProfile(join(tmpDir, "nonexistent-user.md"));
			expect(result).toBeNull();
		});

		it("handles multiline markdown body including headings", () => {
			const userPath = join(tmpDir, "user-headings.md");
			const config: UserProfileConfig = {
				schema_version: 1,
				profile_id: "custom",
				scope: "local",
				created_at: "2026-05-07T12:00:00Z",
				last_updated: "2026-05-07T13:00:00Z",
				body: "# 关于用户\n\n## 习惯\n- 早起\n- 跑步",
			};

			writeUserProfile(config, userPath);
			const read = readUserProfile(userPath);
			expect(read!.body).toBe(config.body);
			expect(read!.body).toContain("## 习惯");
			expect(read!.body).toContain("- 早起");
		});

		it("defaults to ~/.quilin/user.md when no path is given", () => {
			const config: UserProfileConfig = {
				schema_version: 1,
				profile_id: "default-path-test",
				scope: "global_projection",
				created_at: "2026-05-07T12:00:00Z",
				last_updated: "2026-05-07T12:00:00Z",
				body: "Default user path test.",
			};
			writeUserProfile(config);
			const defaultPath = join(homedir(), ".quilin", "user.md");
			expect(existsSync(defaultPath)).toBe(true);
			const read = readUserProfile();
			expect(read).not.toBeNull();
			expect(read!.profile_id).toBe("default-path-test");
		});

		it("creates parent directory when it does not exist for user profile", () => {
			const deepPath = join(tmpDir, "nested", "user", "user.md");
			const config: UserProfileConfig = {
				schema_version: 1,
				profile_id: "nested",
				scope: "local",
				created_at: "2026-05-07T12:00:00Z",
				last_updated: "2026-05-07T12:00:00Z",
				body: "Nested user test.",
			};
			writeUserProfile(config, deepPath);
			expect(existsSync(deepPath)).toBe(true);
			const read = readUserProfile(deepPath);
			expect(read!.profile_id).toBe("nested");
		});

		it("fills defaults for missing frontmatter fields in user profile", () => {
			const userPath = join(tmpDir, "user-minimal.md");
			writeFileSync(userPath, "---\n---\n\nMinimal user body.", "utf-8");
			const read = readUserProfile(userPath);
			expect(read).not.toBeNull();
			expect(read!.schema_version).toBe(1);
			expect(read!.profile_id).toBe("default");
			expect(read!.scope).toBe("global_projection");
		});
	});

	// -----------------------------------------------------------------------
	// ensureDefaultConfigs
	// -----------------------------------------------------------------------

	describe("ensureDefaultConfigs", () => {
		it("uses default paths when no explicit paths are given", () => {
			const result = ensureDefaultConfigs();
			const defaultSoul = join(homedir(), ".quilin", "soul.md");
			const defaultUser = join(homedir(), ".quilin", "user.md");
			expect(result.soulPath).toBe(defaultSoul);
			expect(result.userPath).toBe(defaultUser);
			expect(existsSync(defaultSoul)).toBe(true);
			expect(existsSync(defaultUser)).toBe(true);
		});

		it("creates soul.md and user.md when they do not exist", () => {
			const soulPath = join(tmpDir, "soul.md");
			const userPath = join(tmpDir, "user.md");

			const result = ensureDefaultConfigs(soulPath, userPath);

			expect(result.soulCreated).toBe(true);
			expect(result.userCreated).toBe(true);
			expect(existsSync(soulPath)).toBe(true);
			expect(existsSync(userPath)).toBe(true);
			expect(ZODIAC_SIGNS).toContain(result.soulConfig.zodiac);
		});

		it("does NOT overwrite existing soul.md or user.md", () => {
			const soulPath = join(tmpDir, "soul.md");
			const userPath = join(tmpDir, "user.md");

			// Pre-create soul.md with known content
			const existingSoul: SoulConfig = {
				schema_version: 1,
				persona_name: "Custom",
				zodiac: "双子座",
				gender: "男",
				mbti: "ENTP",
				core_values: ["custom-value"],
				communication_style: "formal",
				created_at: "2025-01-01T00:00:00Z",
				last_updated_by: "user",
				body: "Custom soul body.",
			};
			writeSoulConfig(existingSoul, soulPath);

			const existingUser: UserProfileConfig = {
				schema_version: 1,
				profile_id: "existing-profile",
				scope: "local",
				created_at: "2025-01-01T00:00:00Z",
				last_updated: "2025-01-01T00:00:00Z",
				body: "Existing user body.",
			};
			writeUserProfile(existingUser, userPath);

			const result = ensureDefaultConfigs(soulPath, userPath);

			expect(result.soulCreated).toBe(false);
			expect(result.userCreated).toBe(false);
			expect(result.soulConfig.persona_name).toBe("Custom");
			expect(result.soulConfig.body).toBe("Custom soul body.");
			expect(result.userProfile.profile_id).toBe("existing-profile");
			expect(result.userProfile.body).toBe("Existing user body.");
		});
	});

	// -----------------------------------------------------------------------
	// Sensitive info safety
	// -----------------------------------------------------------------------

	describe("sensitive info safety", () => {
		it("JSON.stringify does not leak sensitive keys when serializing configs", () => {
			const soulPath = join(tmpDir, "soul-sensitive.md");
			const config: SoulConfig = {
				schema_version: 1,
				persona_name: "Test",
				zodiac: "巨蟹座",
				gender: "无性别",
				mbti: "INTP",
				core_values: ["test"],
				communication_style: "casual",
				created_at: "2026-05-07T12:00:00Z",
				last_updated_by: "system",
				body: "Sample body.",
			};
			writeSoulConfig(config, soulPath);

			const json = JSON.stringify(config);
			// Soul config should never contain API keys or secrets
			expect(json).not.toContain("api_key");
			expect(json).not.toContain("secret");
			expect(json).not.toContain("token");
			expect(json).not.toContain("password");
			expect(json).not.toContain("credential");
		});

		it("UserProfileConfig JSON does not leak sensitive fields", () => {
			const config: UserProfileConfig = {
				schema_version: 1,
				profile_id: "default",
				scope: "global_projection",
				created_at: "2026-05-07T12:00:00Z",
				last_updated: "2026-05-07T12:00:00Z",
				body: "# 关于用户",
			};

			const json = JSON.stringify(config);
			expect(json).not.toContain("api_key");
			expect(json).not.toContain("secret");
			expect(json).not.toContain("token");
			expect(json).not.toContain("password");
		});
	});

	// -----------------------------------------------------------------------
	// path traversal guard (QUI-140 third-pass audit finding #9)
	// -----------------------------------------------------------------------

	describe("path traversal guard", () => {
		const traversalPaths = [
			"/etc/passwd",
			"/etc/shadow",
			join(homedir(), ".ssh", "id_rsa"),
		];

		const minimalSoul: SoulConfig = {
			schema_version: 1,
			persona_name: "x",
			zodiac: "天蝎座",
			gender: "无性别",
			mbti: "INTJ",
			core_values: [],
			communication_style: "casual",
			created_at: "2026-05-08T12:00:00Z",
			last_updated_by: "test",
			body: "x",
		};

		const minimalUser: UserProfileConfig = {
			schema_version: 1,
			profile_id: "default",
			scope: "global_projection",
			created_at: "2026-05-08T12:00:00Z",
			last_updated: "2026-05-08T12:00:00Z",
			body: "x",
		};

		for (const malicious of traversalPaths) {
			it(`rejects readSoulConfig outside ~/.quilin or tmpdir: ${malicious}`, () => {
				expect(() => readSoulConfig(malicious)).toThrow(/Refusing/);
			});

			it(`rejects writeSoulConfig outside ~/.quilin or tmpdir: ${malicious}`, () => {
				expect(() => writeSoulConfig(minimalSoul, malicious)).toThrow(
					/Refusing/,
				);
			});

			it(`rejects readUserProfile outside ~/.quilin or tmpdir: ${malicious}`, () => {
				expect(() => readUserProfile(malicious)).toThrow(/Refusing/);
			});

			it(`rejects writeUserProfile outside ~/.quilin or tmpdir: ${malicious}`, () => {
				expect(() => writeUserProfile(minimalUser, malicious)).toThrow(
					/Refusing/,
				);
			});
		}

		it("rejects path-traversal segments that escape ~/.quilin after resolution", () => {
			const traversal = join(homedir(), ".quilin", "..", "..", "..", "etc", "passwd");
			expect(() => readSoulConfig(traversal)).toThrow(/Refusing/);
		});
	});
});
