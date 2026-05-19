/**
 * GET /api/profile-files?which=user|soul|project — UX-5 viewer endpoint.
 * PATCH /api/profile-files — UX-5 write endpoint with approval gate.
 *
 * 提供只读访问 user.md / soul.md / QUILIN.md 三份 profile 文件。读路径
 * 严格限制到三个白名单文件,绝对路径在服务端常量里写死,query 参数只接
 * `user` / `soul` / `project` 枚举值 —— 没有任何用户输入参与路径拼接,
 * 避免 path traversal。
 *
 * Read-only viewer for the three "profile" markdown files:
 *   - user   → ~/.quilin/user.md
 *   - soul   → ~/.quilin/soul.md
 *   - project → ./QUILIN.md (or apps/web/../QUILIN.md depending on cwd)
 *
 * Path is hardcoded server-side per enum value; the `which` query param
 * is the only client input and is strictly enum-validated by Zod, so
 * there's no path traversal surface.
 *
 * Wire shape:
 *   { which, path, exists, content, size, modifiedAt }
 *
 * - GET: 200 always when `which` is valid; `exists: false` indicates the file
 *   is missing (the UI renders an empty placeholder rather than erroring).
 * - PATCH: 200 on approved write, 403 on missing approval, 409 on stale mtime.
 * - 400 on invalid `which` / invalid patch body.
 * - 500 on IO error other than ENOENT.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WhichSchema = z.enum(["user", "soul", "project"]);
const MAX_PROFILE_FILE_BYTES = 512 * 1024;
const PatchSchema = z.object({
	which: WhichSchema,
	content: z.string().max(MAX_PROFILE_FILE_BYTES),
	baseModifiedAt: z.string().nullable().optional(),
	confirmed: z.boolean().optional(),
});

function resolveRepoRoot(): string {
	let current = resolve(process.cwd());
	while (true) {
		if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(process.cwd());
		current = parent;
	}
}

function pathFor(which: z.infer<typeof WhichSchema>): string {
	const profileHome = process.env.QUILIN_PROFILE_HOME ?? homedir();
	const projectRoot = process.env.QUILIN_PROFILE_PROJECT_ROOT ?? resolveRepoRoot();
	switch (which) {
		case "user":
			return join(profileHome, ".quilin", "user.md");
		case "soul":
			return join(profileHome, ".quilin", "soul.md");
		case "project":
			return join(projectRoot, "QUILIN.md");
	}
}

async function readProfileFile(which: z.infer<typeof WhichSchema>): Promise<{
	readonly which: z.infer<typeof WhichSchema>;
	readonly path: string;
	readonly exists: boolean;
	readonly content: string | null;
	readonly size: number;
	readonly modifiedAt: string | null;
}> {
	const filePath = pathFor(which);
	if (!existsSync(filePath)) {
		return {
			which,
			path: filePath,
			exists: false,
			content: null,
			size: 0,
			modifiedAt: null,
		};
	}
	const stat = statSync(filePath);
	const content = await readFile(filePath, "utf8");
	return {
		which,
		path: filePath,
		exists: true,
		content,
		size: stat.size,
		modifiedAt: stat.mtime.toISOString(),
	};
}

export async function GET(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const parsed = WhichSchema.safeParse(url.searchParams.get("which"));
	if (!parsed.success) {
		return NextResponse.json(
			{
				error: "invalid `which` param — expected one of: user | soul | project",
				issues: parsed.error.issues,
			},
			{ status: 400 },
		);
	}
	try {
		return NextResponse.json(await readProfileFile(parsed.data));
	} catch (e) {
		const err = e instanceof Error ? e.message : String(e);
		const filePath = pathFor(parsed.data);
		console.log(`[GET /api/profile-files] read failed (which=${parsed.data}): ${err}`);
		return NextResponse.json(
			{ error: `profile file read failed: ${err}`, which: parsed.data, path: filePath },
			{ status: 500 },
		);
	}
}

export async function PATCH(req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
	}
	const parsed = PatchSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ ok: false, error: "invalid body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { which, content, baseModifiedAt, confirmed } = parsed.data;
	const filePath = pathFor(which);
	try {
		const current = await readProfileFile(which);
		if (baseModifiedAt !== undefined && current.modifiedAt !== baseModifiedAt) {
			return NextResponse.json(
				{
					ok: false,
					error: "profile file changed on disk; reload before saving",
					code: "profile_conflict",
					currentModifiedAt: current.modifiedAt,
				},
				{ status: 409 },
			);
		}

		if (confirmed !== true) {
			return NextResponse.json(
				{
					ok: false,
					error: "write request requires approval",
					code: "write_authority_denied",
				},
				{ status: 403 },
			);
		}

		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf8");
		const next = await readProfileFile(which);
		return NextResponse.json(
			{ ok: true, data: next },
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const err = e instanceof Error ? e.message : String(e);
		console.log(`[PATCH /api/profile-files] write failed (which=${which}): ${err}`);
		return NextResponse.json(
			{ ok: false, error: `profile file write failed: ${err}`, which, path: filePath },
			{ status: 500 },
		);
	}
}
