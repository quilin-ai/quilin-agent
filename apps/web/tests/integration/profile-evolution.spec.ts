/**
 * Profile self-evolution tests (Task #12).
 *
 * 覆盖 append 安全约束:size cap、placeholder 替换、heading 不存在时
 * 新建、feature flag、空观察跳过。
 *
 * Covers append-side safety constraints. LLM call path is tested
 * indirectly via mock — we don't hit a real DEEPSEEK_API_KEY in CI.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	appendAdjustmentToSoulMd,
	appendObservationsToUserMd,
	isProfileEvolutionEnabled,
} from "@/lib/profile-evolution";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_FLAG = process.env.QUILIN_PROFILE_EVOLUTION;

let testHome: string;

beforeEach(() => {
	testHome = mkdtempSync(join(tmpdir(), "quilin-evolution-"));
	process.env.HOME = testHome;
	mkdirSync(join(testHome, ".quilin"), { recursive: true });
});

afterEach(() => {
	rmSync(testHome, { recursive: true, force: true });
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
	if (ORIGINAL_FLAG === undefined) delete process.env.QUILIN_PROFILE_EVOLUTION;
	else process.env.QUILIN_PROFILE_EVOLUTION = ORIGINAL_FLAG;
});

describe("isProfileEvolutionEnabled", () => {
	it("returns true by default", () => {
		delete process.env.QUILIN_PROFILE_EVOLUTION;
		expect(isProfileEvolutionEnabled()).toBe(true);
	});
	it("returns false for off/false/0/FALSE", () => {
		for (const v of ["off", "false", "0", "FALSE", "Off"]) {
			process.env.QUILIN_PROFILE_EVOLUTION = v;
			expect(isProfileEvolutionEnabled()).toBe(false);
		}
	});
	it("returns true for 'on' / 'true' / '1' / anything else", () => {
		for (const v of ["on", "true", "1", "yes"]) {
			process.env.QUILIN_PROFILE_EVOLUTION = v;
			expect(isProfileEvolutionEnabled()).toBe(true);
		}
	});
});

describe("appendObservationsToUserMd", () => {
	const userMdPath = () => join(testHome, ".quilin", "user.md");

	it("appends observations under existing heading + replaces placeholder", async () => {
		writeFileSync(
			userMdPath(),
			[
				"# 用户画像 / User Profile",
				"",
				"## 基本背景 / Background",
				"",
				"- 软件工程师,关注 AI agent 框架",
				"",
				"## Quilin 观察 / Agent-observed notes",
				"",
				"_(还没有观察记录 · no observations yet)_",
				"",
			].join("\n"),
			"utf8",
		);
		const r = await appendObservationsToUserMd(["偏好中文回答", "对实证 / 测试覆盖要求高"]);
		expect(r.appended).toBe(2);
		expect(r.skipped).toBeNull();
		const after = readFileSync(userMdPath(), "utf8");
		expect(after).toContain("偏好中文回答");
		expect(after).toContain("对实证 / 测试覆盖要求高");
		// Placeholder line was removed.
		expect(after).not.toContain("还没有观察记录");
		// Background section untouched (we never edit other sections).
		expect(after).toContain("软件工程师,关注 AI agent 框架");
		// Bullet format with ISO timestamp wrapper.
		expect(after).toMatch(/- `\d{4}-\d{2}-\d{2}T.*?` — 偏好中文回答/);
	});

	it("adds the section heading when missing", async () => {
		writeFileSync(userMdPath(), "# 用户画像\n\n## 基本背景\n\n- 工程师\n", "utf8");
		const r = await appendObservationsToUserMd(["第一条观察"]);
		expect(r.appended).toBe(1);
		const after = readFileSync(userMdPath(), "utf8");
		expect(after).toContain("## Quilin 观察 / Agent-observed notes");
		expect(after).toContain("第一条观察");
	});

	it("skips when entries array is empty", async () => {
		writeFileSync(userMdPath(), "# user\n", "utf8");
		const r = await appendObservationsToUserMd([]);
		expect(r.appended).toBe(0);
		expect(r.skipped).toBe("no entries to append");
	});

	it("skips when profile file is missing", async () => {
		const r = await appendObservationsToUserMd(["something"]);
		expect(r.appended).toBe(0);
		expect(r.skipped).toBe("profile file missing");
	});

	it("respects size cap (256KB)", async () => {
		// Write a 300KB file.
		const padding = "x".repeat(300 * 1024);
		writeFileSync(userMdPath(), `# big\n${padding}`, "utf8");
		const r = await appendObservationsToUserMd(["new observation"]);
		expect(r.appended).toBe(0);
		expect(r.skipped).toBe("file size cap reached");
	});

	it("respects feature flag", async () => {
		writeFileSync(userMdPath(), "# user\n", "utf8");
		process.env.QUILIN_PROFILE_EVOLUTION = "off";
		const r = await appendObservationsToUserMd(["disabled"]);
		expect(r.appended).toBe(0);
		expect(r.skipped).toBe("feature flag off");
	});

	it("doesn't corrupt the file on multiple appends", async () => {
		writeFileSync(
			userMdPath(),
			"# user\n\n## Quilin 观察 / Agent-observed notes\n\n_(还没有观察记录 · no observations yet)_\n",
			"utf8",
		);
		await appendObservationsToUserMd(["first"]);
		await appendObservationsToUserMd(["second", "third"]);
		const after = readFileSync(userMdPath(), "utf8");
		expect(after).toContain("first");
		expect(after).toContain("second");
		expect(after).toContain("third");
		// Heading should appear exactly once.
		expect(after.match(/## Quilin 观察/g)?.length).toBe(1);
		// Size sanity.
		expect(statSync(userMdPath()).size).toBeLessThan(2048);
	});
});

describe("appendAdjustmentToSoulMd", () => {
	const soulMdPath = () => join(testHome, ".quilin", "soul.md");

	it("appends adjustment notes to soul.md", async () => {
		writeFileSync(
			soulMdPath(),
			"# Soul\n\n## Quilin 自我修正记录 / Self-adjustment log\n\n_(还没有自修正记录 · no adjustments yet)_\n",
			"utf8",
		);
		const r = await appendAdjustmentToSoulMd(["不再使用 letter-label option"]);
		expect(r.appended).toBe(1);
		const after = readFileSync(soulMdPath(), "utf8");
		expect(after).toContain("不再使用 letter-label option");
		expect(after).not.toContain("还没有自修正记录");
	});

	it("auto-adds heading when missing on soul.md", async () => {
		writeFileSync(soulMdPath(), "# Soul\n\n## 称呼\n\n你\n", "utf8");
		const r = await appendAdjustmentToSoulMd(["新规则"]);
		expect(r.appended).toBe(1);
		const after = readFileSync(soulMdPath(), "utf8");
		expect(after).toContain("## Quilin 自我修正记录");
	});
});
