import type { WatchListener } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CapabilitiesHotReloadEvent,
	CapabilitiesRuntimeNotBootedError,
	createCapabilitiesHotReloadController,
} from "./hot-reload.js";

const createdDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "quilin-hot-reload-"));
	createdDirs.push(workspaceRoot);
	return workspaceRoot;
}

async function writeCapabilitiesFile(
	workspaceRoot: string,
	content: Record<string, unknown> | string,
): Promise<string> {
	const directory = join(workspaceRoot, ".quilin");
	await mkdir(directory, { recursive: true });
	const filePath = join(directory, "capabilities.json");
	await writeFile(
		filePath,
		typeof content === "string" ? content : JSON.stringify(content, null, 2),
		"utf8",
	);
	return filePath;
}

async function writeSkill(
	root: string,
	name: string,
	description: string,
): Promise<void> {
	const skillDir = join(root, name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			`description: ${description}`,
			"---",
			`# ${name}`,
			"",
		].join("\n"),
		"utf8",
	);
}

function buildConfig(input: {
	readonly serverId?: string;
	readonly skills?: Record<string, unknown>;
}): Record<string, unknown> {
	return {
		schema_version: 1,
		mcpServers:
			input.serverId == null
				? {}
				: {
						[input.serverId]: {
							command: "node",
							args: ["server.js"],
							cwd: ".",
						},
					},
		skills: input.skills ?? { enabled: false },
	};
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		createdDirs
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("CapabilitiesHotReloadController", () => {
	it("requires bootstrap before runtime access", () => {
		const controller = createCapabilitiesHotReloadController({
			workspaceRoot: process.cwd(),
			watchEnabled: false,
		});

		expect(() => controller.getRuntime()).toThrow(
			CapabilitiesRuntimeNotBootedError,
		);
		expect(controller.getStatus()).toMatchObject({
			booted: false,
			watching: false,
			lastSuccess: null,
			lastFailure: null,
		});
	});

	it("reloads capabilities and keeps the previous runtime after failures", async () => {
		const workspaceRoot = await createTempWorkspace();
		const configPath = await writeCapabilitiesFile(
			workspaceRoot,
			buildConfig({ serverId: "alpha" }),
		);
		const controller = createCapabilitiesHotReloadController({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: ["--config", configPath],
			env: {},
			watchEnabled: false,
		});

		const bootRuntime = await controller.bootstrap();
		expect(bootRuntime.mcpServers.map((server) => server.id)).toEqual([
			"alpha",
		]);
		expect(controller.getStatus()).toMatchObject({
			booted: true,
			lastSuccess: {
				operation: "bootstrap",
				mcpReconnect: {
					status: "not_requested",
					activeServerIds: ["alpha"],
				},
			},
		});

		await writeCapabilitiesFile(workspaceRoot, "{");
		const failed = await controller.reload();

		expect(failed.status).toBe("failure");
		expect(failed.runtime.mcpServers.map((server) => server.id)).toEqual([
			"alpha",
		]);
		expect(
			controller.getRuntime().mcpServers.map((server) => server.id),
		).toEqual(["alpha"]);
		expect(controller.getStatus().lastFailure).toMatchObject({
			operation: "reload",
			trigger: "manual",
		});

		await writeCapabilitiesFile(
			workspaceRoot,
			buildConfig({ serverId: "beta" }),
		);
		const reloaded = await controller.reload();

		expect(reloaded.status).toBe("success");
		if (reloaded.status !== "success") {
			throw new Error("reload should succeed after writing a valid config");
		}
		expect(reloaded.runtime.mcpServers.map((server) => server.id)).toEqual([
			"beta",
		]);
		expect(reloaded.snapshot.mcpReconnect).toMatchObject({
			status: "pending_repl_apply",
			reason: "applied_at_repl_turn_boundary",
			activeServerIds: ["beta"],
			change: {
				added: ["beta"],
				removed: ["alpha"],
				changed: [],
			},
		});
	});

	it("records skills catalog reload status during bootstrap", async () => {
		const workspaceRoot = await createTempWorkspace();
		const skillsRoot = join(workspaceRoot, ".quilin", "skills");
		await writeSkill(skillsRoot, "research-helper", "Find useful context");
		const configPath = await writeCapabilitiesFile(
			workspaceRoot,
			buildConfig({
				skills: {
					enabled: true,
					projectRoots: ["./skills"],
					watcherEnabled: false,
				},
			}),
		);
		const controller = createCapabilitiesHotReloadController({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: ["--config", configPath],
			env: {},
			watchEnabled: false,
			startSkillsWatching: false,
		});

		await controller.bootstrap();

		expect(controller.getStatus()).toMatchObject({
			lastSkillsChange: {
				change: {
					added: ["research-helper"],
					removed: [],
					changed: [],
				},
				status: {
					lastSuccess: {
						catalogSize: 1,
					},
				},
			},
			skillsStatus: {
				lastSuccess: {
					catalogSize: 1,
				},
			},
		});
	});

	it("debounces watched config changes and emits structured reload events", async () => {
		vi.useFakeTimers();
		const workspaceRoot = await createTempWorkspace();
		const configPath = await writeCapabilitiesFile(
			workspaceRoot,
			buildConfig({ serverId: "first" }),
		);
		const watchCallbacks: Array<() => void> = [];
		const events: CapabilitiesHotReloadEvent[] = [];
		const closeSpy = vi.fn();
		const controller = createCapabilitiesHotReloadController({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: ["--config", configPath],
			env: {},
			debounceMs: 100,
			discoverSkills: false,
			startSkillsWatching: false,
			logEvent: (event) => events.push(event),
			watchFactory: ((
				_path: string,
				_options: { recursive?: boolean } | undefined,
				listener: WatchListener<string>,
			) => {
				watchCallbacks.push(() => listener("change", "capabilities.json"));
				return { close: closeSpy } as never;
			}) as never,
		});
		await controller.bootstrap();
		expect(watchCallbacks).toHaveLength(1);
		expect(controller.getStatus()).toMatchObject({
			watching: true,
			watchedPaths: [configPath],
		});

		await writeCapabilitiesFile(
			workspaceRoot,
			buildConfig({ serverId: "second" }),
		);
		watchCallbacks[0]?.();
		watchCallbacks[0]?.();
		await vi.advanceTimersByTimeAsync(99);
		expect(
			controller.getRuntime().mcpServers.map((server) => server.id),
		).toEqual(["first"]);

		await vi.advanceTimersByTimeAsync(1);
		await vi.waitFor(() => {
			expect(
				controller.getRuntime().mcpServers.map((server) => server.id),
			).toEqual(["second"]);
		});

		expect(controller.getStatus()).toMatchObject({
			lastSuccess: {
				operation: "reload",
				trigger: "watch",
			},
			lastFailure: null,
			mcpReconnect: {
				status: "pending_repl_apply",
				change: {
					added: ["second"],
					removed: ["first"],
					changed: [],
				},
			},
		});
		expect(events.at(-1)).toMatchObject({
			event: "capabilities_runtime_reload",
			status: "success",
			snapshot: {
				trigger: "watch",
			},
		});

		controller.dispose();
		expect(closeSpy).toHaveBeenCalledTimes(2);
	});
});
