import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDefaultCapabilitiesConfig,
	loadCapabilitiesConfig,
	loadCapabilitiesRuntime,
} from "./loader.js";

const createdDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "quilin-config-"));
	createdDirs.push(workspaceRoot);
	return workspaceRoot;
}

async function writeCapabilitiesFile(
	workspaceRoot: string,
	fileName: string,
	content: string,
): Promise<string> {
	const directory = join(workspaceRoot, ".quilin");
	await mkdir(directory, { recursive: true });
	const filePath = join(directory, fileName);
	await writeFile(filePath, content, "utf8");
	return filePath;
}

function buildConfig(serverId: string): string {
	return JSON.stringify(
		{
			schema_version: 1,
			mcpServers: {
				[serverId]: {
					command: "node",
					args: ["stub-server.js"],
					cwd: ".",
				},
			},
			skills: {
				enabled: false,
			},
		},
		null,
		2,
	);
}

afterEach(async () => {
	await Promise.all(
		createdDirs
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("loadCapabilitiesConfig", () => {
	it("prefers --config over env and project defaults", async () => {
		const workspaceRoot = await createTempWorkspace();
		const cliPath = await writeCapabilitiesFile(
			workspaceRoot,
			"cli.json",
			buildConfig("cli-server"),
		);
		const envPath = await writeCapabilitiesFile(
			workspaceRoot,
			"env.json",
			buildConfig("env-server"),
		);
		await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.json",
			buildConfig("project-server"),
		);

		const loaded = await loadCapabilitiesConfig({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: ["--config", relative(workspaceRoot, cliPath)],
			env: {
				QUILIN_CONFIG_PATH: envPath,
			},
		});

		expect(loaded.source).toEqual({
			kind: "cli",
			path: cliPath,
		});
		expect(Object.keys(loaded.config.mcpServers)).toEqual(["cli-server"]);
	});

	it("trims --config path values like env config paths", async () => {
		const workspaceRoot = await createTempWorkspace();
		const cliPath = await writeCapabilitiesFile(
			workspaceRoot,
			"cli.json",
			buildConfig("cli-server"),
		);

		const loaded = await loadCapabilitiesConfig({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: ["--config", `  ${relative(workspaceRoot, cliPath)}  `],
			env: {},
		});

		expect(loaded.source).toEqual({
			kind: "cli",
			path: cliPath,
		});
	});

	it("uses QUILIN_CONFIG_PATH when CLI config is absent", async () => {
		const workspaceRoot = await createTempWorkspace();
		const envPath = await writeCapabilitiesFile(
			workspaceRoot,
			"env.json",
			buildConfig("env-server"),
		);

		const loaded = await loadCapabilitiesConfig({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: [],
			env: {
				QUILIN_CONFIG_PATH: envPath,
			},
		});

		expect(loaded.source).toEqual({
			kind: "env",
			path: envPath,
		});
		expect(Object.keys(loaded.config.mcpServers)).toEqual(["env-server"]);
	});

	it("uses project JSON when no explicit config is provided", async () => {
		const workspaceRoot = await createTempWorkspace();
		const projectPath = await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.json",
			buildConfig("project-server"),
		);

		const loaded = await loadCapabilitiesConfig({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: [],
			env: {},
		});

		expect(loaded.source).toEqual({
			kind: "project",
			path: projectPath,
		});
		expect(Object.keys(loaded.config.mcpServers)).toEqual(["project-server"]);
	});

	it("fails fast when project YAML exists but is invalid instead of falling back to JSON", async () => {
		const workspaceRoot = await createTempWorkspace();
		const yamlPath = await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.yaml",
			"schema_version: 1\nmcpServers:\n  broken\n",
		);
		await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.json",
			buildConfig("project-server"),
		);

		await expect(
			loadCapabilitiesConfig({
				workspaceRoot,
				cwd: workspaceRoot,
				argv: [],
				env: {},
			}),
		).rejects.toThrow(yamlPath);
	});

	it("returns the builtin OmniMem default when no config file exists", async () => {
		const workspaceRoot = await createTempWorkspace();

		const loaded = await loadCapabilitiesConfig({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: [],
			env: {},
		});

		expect(loaded.source).toEqual({ kind: "builtin" });
		expect(loaded.config).toEqual(
			createDefaultCapabilitiesConfig(workspaceRoot),
		);
	});

	it("fails fast when an explicit config path does not exist", async () => {
		const workspaceRoot = await createTempWorkspace();

		await expect(
			loadCapabilitiesConfig({
				workspaceRoot,
				cwd: workspaceRoot,
				argv: ["--config", "./missing.json"],
				env: {},
			}),
		).rejects.toThrow(/Capabilities config file not found/i);
	});

	it("resolves relative runtime paths from the config file directory", async () => {
		const workspaceRoot = await createTempWorkspace();
		const configPath = await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.json",
			JSON.stringify(
				{
					schema_version: 1,
					mcpServers: {
						stub: {
							command: "node",
							args: ["stub-server.js"],
							cwd: ".",
						},
					},
					skills: {
						enabled: true,
						projectRoots: ["./skills/project"],
						userRoots: ["./skills/user"],
						watcherEnabled: false,
					},
				},
				null,
				2,
			),
		);

		const runtime = await loadCapabilitiesRuntime({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: ["--config", configPath],
			env: {},
		});

		expect(runtime.mcpServers).toEqual([
			{
				id: "stub",
				namespace: "stub",
				config: {
					command: "node",
					args: ["stub-server.js"],
					cwd: join(workspaceRoot, ".quilin"),
				},
			},
		]);
		expect(runtime.skillsManager).toBeDefined();
	});

	it("parses the accepted YAML boolean subset and rejects floats", async () => {
		const workspaceRoot = await createTempWorkspace();
		const yamlPath = await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.yaml",
			[
				"schema_version: 1",
				"mcpServers:",
				"  stub:",
				"    command: node",
				"    args: [stub-server.js]",
				"    cwd: .",
				"    enabled: yes",
				"skills:",
				"  enabled: on",
				"  watcherEnabled: no",
				"  debounceMs: 10",
			].join("\n"),
		);

		const loaded = await loadCapabilitiesConfig({
			workspaceRoot,
			cwd: workspaceRoot,
			argv: ["--config", yamlPath],
			env: {},
		});

		expect(loaded.config.mcpServers.stub?.enabled).toBe(true);
		expect(loaded.config.skills.enabled).toBe(true);
		expect(loaded.config.skills.watcherEnabled).toBe(false);

		await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.yaml",
			[
				"schema_version: 1.5",
				"mcpServers: {}",
				"skills:",
				"  enabled: false",
			].join("\n"),
		);

		await expect(
			loadCapabilitiesConfig({
				workspaceRoot,
				cwd: workspaceRoot,
				argv: ["--config", yamlPath],
				env: {},
			}),
		).rejects.toThrow(/floats are not accepted/i);
	});

	it("rejects MCP server cwd values outside the workspace and config directory", async () => {
		const workspaceRoot = await createTempWorkspace();
		const configPath = await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.json",
			JSON.stringify(
				{
					schema_version: 1,
					mcpServers: {
						stub: {
							command: "node",
							args: ["stub-server.js"],
							cwd: "../..",
						},
					},
					skills: {
						enabled: false,
					},
				},
				null,
				2,
			),
		);

		await expect(
			loadCapabilitiesRuntime({
				workspaceRoot,
				cwd: workspaceRoot,
				argv: ["--config", configPath],
				env: {},
			}),
		).rejects.toThrow(/cwd escapes workspace\/config directory/i);
	});
});
