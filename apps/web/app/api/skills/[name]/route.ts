/**
 * GET /api/skills/[name]
 *
 * Loads a single skill's full SKILL.md body via `SkillsManager.load()`.
 * The manager enforces path-safety (realpath inside allowed roots) and
 * body-size limits, so a malicious skill can't trick the route into
 * reading arbitrary files via symlink.
 *
 * Returns `{ descriptor, body, tokenEstimate }`.
 *
 * 加载某个 skill 的 SKILL.md 正文,SkillsManager.load() 会做 realpath 检查
 * 和体积限制,符号链接钓鱼无法绕过。
 */

import { getSkillsManager } from "@/lib/skills-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
	readonly params: Promise<{ readonly name: string }>;
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
	const { name: rawName } = await ctx.params;
	const name = decodeURIComponent(rawName);
	try {
		const { manager } = await getSkillsManager();
		const descriptor = manager.findByName(name);
		if (descriptor == null) {
			return Response.json(
				{ ok: false, error: { code: "not_found", message: `skill not found: ${name}` } },
				{ status: 404, headers: { "cache-control": "no-store" } },
			);
		}
		const loaded = await manager.load(name);
		return Response.json(
			{
				ok: true,
				data: {
					descriptor: {
						name: loaded.descriptor.name,
						description: loaded.descriptor.description,
						source: loaded.descriptor.source,
						path: loaded.descriptor.path,
						frontmatter: loaded.descriptor.frontmatter,
					},
					body: loaded.body,
					tokenEstimate: loaded.tokenEstimate,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/skills/${name}] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "skill_load_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
