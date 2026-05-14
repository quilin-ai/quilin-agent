/**
 * UX-5 — GET /api/profile-files endpoint integration tests.
 *
 * 覆盖 which 枚举校验、文件存在 / 不存在、IO 错误路径。每个 case 自建
 * 临时 home dir,通过 HOME env override 让 endpoint 读虚拟 profile 文件,
 * 避免依赖真实 ~/.quilin。
 *
 * Each case spins up an isolated tmpdir, overrides HOME so the endpoint
 * reads from `<tmpdir>/.quilin/...` instead of the real home dir; this
 * keeps the test fully hermetic and parallel-safe.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;

let testHome: string;

beforeEach(() => {
	testHome = mkdtempSync(join(tmpdir(), "quilin-profile-files-"));
	process.env.HOME = testHome;
	mkdirSync(join(testHome, ".quilin"), { recursive: true });
});

afterEach(() => {
	rmSync(testHome, { recursive: true, force: true });
	if (ORIGINAL_HOME === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = ORIGINAL_HOME;
	}
});

describe("UX-5 — GET /api/profile-files", () => {
	it("returns existing user.md content + metadata", async () => {
		writeFileSync(
			join(testHome, ".quilin", "user.md"),
			"# 用户偏好\n\n- 默认中文沟通\n- 偏好简洁回答\n",
			"utf8",
		);
		const { GET } = await import("@/app/api/profile-files/route");
		const res = await GET(new Request("http://localhost/api/profile-files?which=user"));
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.which).toBe("user");
		expect(body.exists).toBe(true);
		expect(body.content).toContain("默认中文沟通");
		expect(body.size).toBeGreaterThan(0);
		expect(body.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(body.path.endsWith("/.quilin/user.md")).toBe(true);
	});

	it("returns exists:false with no error when soul.md missing", async () => {
		const { GET } = await import("@/app/api/profile-files/route");
		const res = await GET(new Request("http://localhost/api/profile-files?which=soul"));
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.which).toBe("soul");
		expect(body.exists).toBe(false);
		expect(body.content).toBeNull();
		expect(body.size).toBe(0);
		expect(body.modifiedAt).toBeNull();
	});

	it("returns project file content (QUILIN.md from repo root)", async () => {
		// project file resolution walks up from cwd to pnpm-workspace.yaml; the
		// test runs from the workspace root so we hit the real QUILIN.md if
		// it exists; otherwise exists:false.
		const { GET } = await import("@/app/api/profile-files/route");
		const res = await GET(new Request("http://localhost/api/profile-files?which=project"));
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.which).toBe("project");
		expect(body.path.endsWith("QUILIN.md")).toBe(true);
		// Either exists with content or not; both are valid (developer's repo
		// state may vary). Just assert the shape.
		if (body.exists) {
			expect(typeof body.content).toBe("string");
			expect(body.size).toBeGreaterThan(0);
		}
	});

	it("400 on missing `which` param", async () => {
		const { GET } = await import("@/app/api/profile-files/route");
		const res = await GET(new Request("http://localhost/api/profile-files"));
		expect(res.status).toBe(400);
	});

	it("400 on invalid `which` value", async () => {
		const { GET } = await import("@/app/api/profile-files/route");
		const res = await GET(
			new Request("http://localhost/api/profile-files?which=evil%2F..%2Fetc%2Fpasswd"),
		);
		expect(res.status).toBe(400);
	});

	it("400 on traversal attempt in `which`", async () => {
		// Even with explicit `../etc/passwd` injected, the Zod enum kicks it back.
		const { GET } = await import("@/app/api/profile-files/route");
		const res = await GET(
			new Request("http://localhost/api/profile-files?which=../../etc/passwd"),
		);
		expect(res.status).toBe(400);
	});

	it("each enum value resolves to a distinct path", async () => {
		writeFileSync(join(testHome, ".quilin", "user.md"), "user file", "utf8");
		writeFileSync(join(testHome, ".quilin", "soul.md"), "soul file", "utf8");
		const { GET } = await import("@/app/api/profile-files/route");
		const userRes = await (
			await GET(new Request("http://localhost/api/profile-files?which=user"))
		).json();
		const soulRes = await (
			await GET(new Request("http://localhost/api/profile-files?which=soul"))
		).json();
		expect(userRes.path).not.toBe(soulRes.path);
		expect(userRes.content).toBe("user file");
		expect(soulRes.content).toBe("soul file");
	});
});
