/**
 * GET /api/skills
 *
 * Returns the full skill catalog as discovered by `SkillsManager` —
 * descriptor metadata only, no SKILL.md bodies. Used by the /skills page
 * to render the catalog sidebar. Body is fetched separately via
 * `GET /api/skills/[name]` to avoid sending 161 × ~5KB markdown blobs
 * on first page load.
 *
 * Response shape:
 *   { ok: true, data: { roots: { user, project }, skills: SkillSummary[] } }
 *   SkillSummary excludes the full body and uses only fields the UI shows.
 *
 * 返回 SkillsManager 已发现的全部 skills 概要(不含 SKILL.md 正文)。
 * 正文按需通过 /api/skills/[name] 拉取,避免首屏一次性传 100+ skills 的 markdown。
 */

import { getSkillsManager } from "@/lib/skills-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface SkillSummary {
	readonly name: string;
	readonly description: string;
	readonly source: "user" | "project" | "bundled" | "plugin";
	readonly path: string;
	readonly whenToUse: string | null;
	readonly trust: string | null;
	readonly mandatory: boolean;
	readonly userInvocable: boolean;
	readonly disableModelInvocation: boolean;
	readonly version: string | null;
	readonly allowedTools: readonly string[] | null;
	readonly requiresTools: readonly string[] | null;
}

export async function GET(): Promise<Response> {
	try {
		const { manager, userRoot, projectRoot, fsCounts } = await getSkillsManager();
		const descriptors = manager.list();
		const skills: readonly SkillSummary[] = descriptors.map((d) => ({
			name: d.name,
			description: d.description,
			source: d.source,
			path: d.path,
			whenToUse: d.frontmatter.whenToUse ?? null,
			trust: d.frontmatter.trust ?? null,
			mandatory: d.frontmatter.mandatory ?? false,
			userInvocable: d.frontmatter.userInvocable,
			disableModelInvocation: d.frontmatter.disableModelInvocation,
			version: d.frontmatter.version ?? null,
			allowedTools: d.frontmatter.allowedTools ?? null,
			requiresTools: d.frontmatter.requiresTools ?? null,
		}));
		const userLoaded = skills.filter((s) => s.source === "user").length;
		const projectLoaded = skills.filter((s) => s.source === "project").length;
		return Response.json(
			{
				ok: true,
				data: {
					roots: { user: userRoot, project: projectRoot },
					skills,
					counts: {
						total: skills.length,
						user: userLoaded,
						project: projectLoaded,
						bundled: skills.filter((s) => s.source === "bundled").length,
						plugin: skills.filter((s) => s.source === "plugin").length,
					},
					filesystem: {
						userDirsWithSkillMd: fsCounts.userWithSkillMd,
						projectDirsWithSkillMd: fsCounts.projectWithSkillMd,
						userFiltered: Math.max(0, fsCounts.userWithSkillMd - userLoaded),
						projectFiltered: Math.max(0, fsCounts.projectWithSkillMd - projectLoaded),
					},
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/skills] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "skills_load_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
