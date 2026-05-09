// Integration tests for QUI-148: webhook + SIGHUP triggers exercising
// the real CapabilitiesHotReloadController + node:http server (webhook)
// or real EventEmitter wiring (SIGHUP) end-to-end. Unlike the unit tests
// in `reload-webhook-server.test.ts` and `sighup-handler.test.ts` these
// also verify the controller side-effects (status snapshots, mcp diff).
//
// QUI-148 集成测试：webhook + SIGHUP 触发器走完整链路（真 controller +
// node:http server / 真 EventEmitter），同时验证 controller 侧效（状态
// 快照、mcp 差异）。

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CapabilitiesHotReloadController,
	createCapabilitiesHotReloadController,
} from "./hot-reload.js";
import {
	computeReloadWebhookSignature,
	RELOAD_WEBHOOK_SECRET_ENV,
	RELOAD_WEBHOOK_SIGNATURE_HEADER,
	startReloadWebhookServer,
} from "./reload-webhook-server.js";
import { installSighupHandler, type ProcessLike } from "./sighup-handler.js";

const createdDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "quilin-hotreload-int-"));
	createdDirs.push(root);
	return root;
}

async function writeCapabilitiesFile(
	workspaceRoot: string,
	mcpServerId: string,
): Promise<string> {
	const dir = join(workspaceRoot, ".quilin");
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, "capabilities.json");
	const config = {
		schema_version: 1,
		mcpServers: {
			[mcpServerId]: {
				command: "node",
				args: ["server.js"],
				cwd: ".",
			},
		},
		skills: { enabled: false },
	};
	await writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
	return filePath;
}

async function bootController(): Promise<{
	controller: CapabilitiesHotReloadController;
	configPath: string;
	workspaceRoot: string;
}> {
	const workspaceRoot = await createTempWorkspace();
	const configPath = await writeCapabilitiesFile(workspaceRoot, "alpha");
	const controller = createCapabilitiesHotReloadController({
		workspaceRoot,
		cwd: workspaceRoot,
		argv: ["--config", configPath],
		env: {},
		watchEnabled: false,
		discoverSkills: false,
		startSkillsWatching: false,
	});
	await controller.bootstrap();
	return { controller, configPath, workspaceRoot };
}

class FakeProcess extends EventEmitter implements ProcessLike {
	readonly env: NodeJS.ProcessEnv;
	constructor(env: NodeJS.ProcessEnv = {}) {
		super();
		this.env = env;
	}
}

afterEach(async () => {
	await Promise.all(
		createdDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("hot reload triggers — integration", () => {
	it("webhook end-to-end: real HMAC client triggers controller reload + diff", async () => {
		const secret = "integration-secret";
		const { controller, configPath, workspaceRoot } = await bootController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: secret },
		});
		try {
			expect(controller.getRuntime().mcpServers.map((s) => s.id)).toEqual([
				"alpha",
			]);

			// Mutate capabilities config so the next reload introduces a real
			// diff (alpha -> beta).
			void workspaceRoot;
			await writeFile(
				configPath,
				JSON.stringify(
					{
						schema_version: 1,
						mcpServers: {
							beta: { command: "node", args: ["server.js"], cwd: "." },
						},
						skills: { enabled: false },
					},
					null,
					2,
				),
				"utf8",
			);

			const body = JSON.stringify({ requested_at: Date.now() });
			const signature = computeReloadWebhookSignature(secret, body);
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[RELOAD_WEBHOOK_SIGNATURE_HEADER]: signature,
				},
				body,
			});
			expect(response.status).toBe(200);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.status).toBe("success");
			expect(payload.trigger).toBe("webhook");

			// Controller-side effects.
			expect(controller.getRuntime().mcpServers.map((s) => s.id)).toEqual([
				"beta",
			]);
			const status = controller.getStatus();
			expect(status.lastSuccess?.trigger).toBe("webhook");
			expect(status.lastSuccess?.operation).toBe("reload");
			expect(status.mcpReconnect).toMatchObject({
				status: "pending_repl_apply",
				change: { added: ["beta"], removed: ["alpha"], changed: [] },
			});
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("SIGHUP integration: process.emit triggers controller.reload('signal')", async () => {
		const { controller, configPath } = await bootController();
		try {
			const fakeProcess = new FakeProcess();
			const reloadResults: string[] = [];
			const handle = installSighupHandler(controller, {
				forceRegister: true,
				processRef: fakeProcess,
				onReload: (result) => {
					if (result.status === "success") {
						reloadResults.push(result.snapshot.trigger);
					}
				},
			});

			// Mutate config so the SIGHUP-driven reload is a real reload.
			await writeFile(
				configPath,
				JSON.stringify(
					{
						schema_version: 1,
						mcpServers: {
							gamma: { command: "node", args: ["server.js"], cwd: "." },
						},
						skills: { enabled: false },
					},
					null,
					2,
				),
				"utf8",
			);

			fakeProcess.emit("SIGHUP");
			await new Promise<void>((resolve) => setTimeout(resolve, 150));

			expect(reloadResults).toContain("signal");
			const status = controller.getStatus();
			expect(status.lastSuccess?.trigger).toBe("signal");
			expect(controller.getRuntime().mcpServers.map((s) => s.id)).toEqual([
				"gamma",
			]);

			handle.dispose();
		} finally {
			controller.dispose();
		}
	});
});
