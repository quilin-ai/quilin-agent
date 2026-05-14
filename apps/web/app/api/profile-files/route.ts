/**
 * GET /api/profile-files?which=user|soul|project — UX-5 viewer endpoint.
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
 * - 200 always when `which` is valid; `exists: false` indicates the file
 *   is missing (the UI renders an empty placeholder rather than erroring).
 * - 400 on invalid `which`.
 * - 500 on IO error other than ENOENT.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WhichSchema = z.enum(["user", "soul", "project"]);

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
	switch (which) {
		case "user":
			return join(homedir(), ".quilin", "user.md");
		case "soul":
			return join(homedir(), ".quilin", "soul.md");
		case "project":
			return join(resolveRepoRoot(), "QUILIN.md");
	}
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
	const filePath = pathFor(parsed.data);
	try {
		if (!existsSync(filePath)) {
			return NextResponse.json({
				which: parsed.data,
				path: filePath,
				exists: false,
				content: null,
				size: 0,
				modifiedAt: null,
			});
		}
		const stat = statSync(filePath);
		const content = await readFile(filePath, "utf8");
		return NextResponse.json({
			which: parsed.data,
			path: filePath,
			exists: true,
			content,
			size: stat.size,
			modifiedAt: stat.mtime.toISOString(),
		});
	} catch (e) {
		const err = e instanceof Error ? e.message : String(e);
		console.log(`[GET /api/profile-files] read failed (which=${parsed.data}): ${err}`);
		return NextResponse.json(
			{ error: `profile file read failed: ${err}`, which: parsed.data, path: filePath },
			{ status: 500 },
		);
	}
}
