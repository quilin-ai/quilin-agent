/**
 * SkillsManager singleton for web routes that need the skill catalog
 * (`/api/skills`, `/skills` page). Scans the same directories as the
 * chat route — `~/.claude/skills` (user) + `<workspace>/.claude/skills`
 * (project) — but keeps its own instance because the chat route's
 * SkillsManager lives inside `loadBuiltinTools` and isn't exported.
 *
 * Cached on `globalThis` so Turbopack's hot reload doesn't rebuild on
 * every request, and re-`discover()`'d every 30s so newly added skill
 * files show up without a full server restart.
 *
 * SkillsManager 单例,给 /api/skills 和 /skills 页用。和 chat route 用同样
 * 的目录扫描,但保留独立实例。globalThis 缓存,30 秒重新 discover 一次。
 */

/**
 * Local mirrors of `@quilin/agent-core`'s exported types. The package
 * ships JS only (no `.d.ts` in `dist/`), and the chat route + mcp-loader
 * follow the same pattern: dynamic `import()` at runtime + local
 * interfaces for compile-time. Keeping these in sync with the upstream
 * `SkillDescriptor` / `LoadedSkill` shapes is the trade-off for not
 * coupling to a fragile build of the workspace package.
 *
 * `@quilin/agent-core` 没出 .d.ts。这里和 chat/route.ts、mcp-loader.ts 一样,
 * 运行时 dynamic import,编译期用本地 interface 镜像 agent-core 的类型。
 */
export interface SkillFrontmatter {
	readonly name: string;
	readonly description: string;
	readonly whenToUse?: string;
	readonly allowedTools?: readonly string[];
	readonly mandatory?: boolean;
	readonly requiresTools?: readonly string[];
	readonly requiresToolsets?: readonly string[];
	readonly platforms?: readonly string[];
	readonly version?: string;
	readonly userInvocable: boolean;
	readonly disableModelInvocation: boolean;
	readonly trust?: "builtin" | "trusted" | "community" | "agent-created";
}

export interface SkillDescriptor {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly source: "bundled" | "user" | "project" | "plugin";
	readonly frontmatter: SkillFrontmatter;
}

export interface LoadedSkill {
	readonly descriptor: SkillDescriptor;
	readonly body: string;
	readonly tokenEstimate: number;
}

interface SkillsManagerInstance {
	discover(): Promise<readonly SkillDescriptor[]>;
	list(): readonly SkillDescriptor[];
	findByName(name: string): SkillDescriptor | undefined;
	load(name: string): Promise<LoadedSkill>;
	/** File-watcher callback. Returns an unsubscribe function. */
	onCatalogChange(cb: () => void): () => void;
}
interface SkillsManagerCtor {
	new (options: {
		readonly bundledRoots?: readonly string[];
		readonly userRoots?: readonly string[];
		readonly projectRoots?: readonly string[];
		readonly pluginRoots?: readonly string[];
		readonly watcherEnabled?: boolean;
	}): SkillsManagerInstance;
}

export interface FilesystemScanCounts {
	readonly userDirs: number;
	readonly projectDirs: number;
	readonly userWithSkillMd: number;
	readonly projectWithSkillMd: number;
}

declare global {
	var __quilin_skills_unsubscribe__: (() => void) | undefined;
	var __quilin_skills_mgr__:
		| {
				readonly mgr: SkillsManagerInstance;
				readonly userRoot: string | null;
				readonly projectRoot: string;
				discoveredAtMs: number;
				fsCounts: FilesystemScanCounts;
		  }
		| undefined;
	/**
	 * In-flight promise for first-time SkillsManager construction.
	 * Coalesces concurrent first-hit requests so we don't run the
	 * filesystem scan + SkillsManager.discover() twice on cold start.
	 */
	var __quilin_skills_mgr_inflight__: Promise<SkillsManagerWithRoots> | undefined;
}

const REDISCOVER_INTERVAL_MS = 30_000;

export interface SkillsManagerWithRoots {
	readonly manager: SkillsManagerInstance;
	readonly userRoot: string | null;
	readonly projectRoot: string;
	readonly fsCounts: FilesystemScanCounts;
}

async function scanFilesystem(
	userRoot: string | null,
	projectRoot: string,
): Promise<FilesystemScanCounts> {
	const { readdir, stat } = await import("node:fs/promises");
	const { join } = await import("node:path");

	async function countDir(root: string | null): Promise<{ dirs: number; withSkillMd: number }> {
		if (root == null) return { dirs: 0, withSkillMd: 0 };
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch {
			return { dirs: 0, withSkillMd: 0 };
		}
		let dirs = 0;
		let withSkillMd = 0;
		for (const entry of entries) {
			try {
				const s = await stat(join(root, entry));
				if (!s.isDirectory()) continue;
				dirs += 1;
				try {
					const skillStat = await stat(join(root, entry, "SKILL.md"));
					if (skillStat.isFile()) withSkillMd += 1;
				} catch {
					/* no SKILL.md in this dir */
				}
			} catch {
				/* entry stat failed — skip */
			}
		}
		return { dirs, withSkillMd };
	}

	const user = await countDir(userRoot);
	const project = await countDir(projectRoot);
	return {
		userDirs: user.dirs,
		projectDirs: project.dirs,
		userWithSkillMd: user.withSkillMd,
		projectWithSkillMd: project.withSkillMd,
	};
}

export async function getSkillsManager(): Promise<SkillsManagerWithRoots> {
	const cached = globalThis.__quilin_skills_mgr__;
	const now = Date.now();
	if (cached != null) {
		if (now - cached.discoveredAtMs >= REDISCOVER_INTERVAL_MS) {
			try {
				await cached.mgr.discover();
				cached.fsCounts = await scanFilesystem(cached.userRoot, cached.projectRoot);
				cached.discoveredAtMs = now;
			} catch (e) {
				console.log(`[SKILLS] re-discover failed: ${String(e)}`);
			}
		}
		return {
			manager: cached.mgr,
			userRoot: cached.userRoot,
			projectRoot: cached.projectRoot,
			fsCounts: cached.fsCounts,
		};
	}
	// Coalesce concurrent first-hit callers so we don't run discover()
	// + scanFilesystem twice on cold start.
	const inflight = globalThis.__quilin_skills_mgr_inflight__;
	if (inflight != null) {
		return inflight;
	}
	const buildPromise = buildSkillsManager(now);
	globalThis.__quilin_skills_mgr_inflight__ = buildPromise;
	try {
		return await buildPromise;
	} finally {
		if (globalThis.__quilin_skills_mgr_inflight__ === buildPromise) {
			globalThis.__quilin_skills_mgr_inflight__ = undefined;
		}
	}
}

/**
 * Lazy import of `invalidateToolsCatalog` so this file (which is loaded
 * inside `tools-loader.buildToolsCatalog`) doesn't form a circular
 * import. Resolves on first call, caches, then re-uses.
 */
async function invalidateToolsCatalogFromSkillsLoader(): Promise<void> {
	try {
		const mod = await import("@/lib/tools-loader");
		await mod.invalidateToolsCatalog();
	} catch (e) {
		console.log(`[SKILLS hot-reload] invalidate failed: ${String(e)}`);
	}
}

async function buildSkillsManager(now: number): Promise<SkillsManagerWithRoots> {
	const mod = (await import(
		/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ "@quilin/agent-core"
	)) as { SkillsManager: SkillsManagerCtor };

	const home = process.env.HOME ?? "";
	const workspaceRoot = process.cwd().replace(/\/apps\/web\/?$/, "");
	const userSkillsDir = home.length > 0 ? `${home}/.claude/skills` : null;
	const projectSkillsDir = `${workspaceRoot}/.claude/skills`;
	// `watcherEnabled: true` (dev only) so SkillsManager's internal
	// file watcher picks up SKILL.md edits and re-discovers; we then
	// invalidate the tools catalog so the LLM sees the new/changed
	// skill on its next call. Matches the MCP server hot-reload
	// pattern in tools-loader.ts. Production stays off (filesystem
	// watch can be noisy + not all hosts support recursive watch).
	const enableWatcher =
		process.env.NODE_ENV !== "production" && process.env.QUILIN_SKILL_HOT_RELOAD !== "off";
	const mgr = new mod.SkillsManager({
		watcherEnabled: enableWatcher,
		...(userSkillsDir == null ? {} : { userRoots: [userSkillsDir] }),
		projectRoots: [projectSkillsDir],
	});
	try {
		await mgr.discover();
	} catch (e) {
		console.log(`[SKILLS] initial discover failed: ${String(e)}`);
	}
	// When a SKILL.md change fires, the manager re-discovers internally
	// AND we kick the tool catalog cache so the next chat request rebuilds
	// the LLM tool list with the updated skill metadata. Idempotent + safe
	// to call multiple times in a burst (invalidateToolsCatalog itself
	// debounces nothing but the cost is cheap).
	if (enableWatcher) {
		try {
			const unsubscribe = mgr.onCatalogChange(() => {
				console.log("[SKILLS hot-reload] catalog changed → invalidating tools catalog");
				void invalidateToolsCatalogFromSkillsLoader();
			});
			globalThis.__quilin_skills_unsubscribe__ = unsubscribe;
		} catch (e) {
			console.log(`[SKILLS] watcher subscription failed: ${String(e)}`);
		}
	}
	const fsCounts = await scanFilesystem(userSkillsDir, projectSkillsDir);
	const holder = {
		mgr,
		userRoot: userSkillsDir,
		projectRoot: projectSkillsDir,
		discoveredAtMs: now,
		fsCounts,
	};
	globalThis.__quilin_skills_mgr__ = holder;
	return {
		manager: mgr,
		userRoot: holder.userRoot,
		projectRoot: holder.projectRoot,
		fsCounts: holder.fsCounts,
	};
}
