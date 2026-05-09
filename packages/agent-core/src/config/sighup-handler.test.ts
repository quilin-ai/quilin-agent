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
	installSighupHandler,
	isTestEnvironment,
	type ProcessLike,
} from "./sighup-handler.js";

const createdDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "quilin-sighup-"));
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

async function createBootedController(): Promise<{
	controller: CapabilitiesHotReloadController;
	workspaceRoot: string;
	configPath: string;
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
	return { controller, workspaceRoot, configPath };
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

describe("isTestEnvironment", () => {
	it("returns true when NODE_ENV=test", () => {
		expect(isTestEnvironment({ NODE_ENV: "test" })).toBe(true);
	});

	it("returns true when VITEST is set", () => {
		expect(isTestEnvironment({ VITEST: "true" })).toBe(true);
	});

	it("returns false in plain prod-like envs", () => {
		expect(isTestEnvironment({ NODE_ENV: "production" })).toBe(false);
		expect(isTestEnvironment({})).toBe(false);
	});
});

describe("installSighupHandler", () => {
	it("skips registration in test environment by default", async () => {
		const { controller } = await createBootedController();
		try {
			const fakeProcess = new FakeProcess();
			const handle = installSighupHandler(controller, {
				env: { NODE_ENV: "test" },
				processRef: fakeProcess,
			});
			expect(handle.registered).toBe(false);
			expect(handle.reason).toBe("test_environment");
			expect(fakeProcess.listenerCount("SIGHUP")).toBe(0);
			handle.dispose();
		} finally {
			controller.dispose();
		}
	});

	it("skips registration when VITEST env is set", async () => {
		const { controller } = await createBootedController();
		try {
			const fakeProcess = new FakeProcess();
			const handle = installSighupHandler(controller, {
				env: { VITEST: "true" },
				processRef: fakeProcess,
			});
			expect(handle.registered).toBe(false);
			expect(fakeProcess.listenerCount("SIGHUP")).toBe(0);
			handle.dispose();
		} finally {
			controller.dispose();
		}
	});

	it("registers handler in non-test env and dispose removes it", async () => {
		const { controller } = await createBootedController();
		try {
			const fakeProcess = new FakeProcess();
			let registered = false;
			const handle = installSighupHandler(controller, {
				env: { NODE_ENV: "production" },
				processRef: fakeProcess,
				onRegister: () => {
					registered = true;
				},
			});
			expect(handle.registered).toBe(true);
			expect(registered).toBe(true);
			expect(fakeProcess.listenerCount("SIGHUP")).toBe(1);

			handle.dispose();
			expect(fakeProcess.listenerCount("SIGHUP")).toBe(0);
		} finally {
			controller.dispose();
		}
	});

	it("invokes controller.reload('signal') when SIGHUP fires", async () => {
		const { controller } = await createBootedController();
		try {
			const fakeProcess = new FakeProcess();
			const reloads: string[] = [];
			const handle = installSighupHandler(controller, {
				forceRegister: true,
				processRef: fakeProcess,
				onReload: (result) => {
					if (result.status === "success") {
						reloads.push(result.snapshot.trigger);
					}
				},
			});
			expect(handle.registered).toBe(true);

			fakeProcess.emit("SIGHUP");

			// The handler is async — wait for it to complete.
			await new Promise<void>((resolve) => setTimeout(resolve, 100));

			expect(reloads).toContain("signal");
			expect(controller.getStatus().lastSuccess?.trigger).toBe("signal");

			handle.dispose();
		} finally {
			controller.dispose();
		}
	});

	it("forwards reload errors to onError without crashing", async () => {
		const { controller, workspaceRoot, configPath } =
			await createBootedController();
		try {
			// Corrupt the config so reload fails.
			await writeFile(configPath, "{not valid json", "utf8");
			void workspaceRoot;

			const fakeProcess = new FakeProcess();
			const errors: unknown[] = [];
			const handle = installSighupHandler(controller, {
				forceRegister: true,
				processRef: fakeProcess,
				onError: (err) => {
					errors.push(err);
				},
			});

			fakeProcess.emit("SIGHUP");

			await new Promise<void>((resolve) => setTimeout(resolve, 100));

			expect(errors.length).toBeGreaterThanOrEqual(1);
			expect(controller.getStatus().lastFailure?.trigger).toBe("signal");

			handle.dispose();
		} finally {
			controller.dispose();
		}
	});

	it("falls back to global process when processRef is omitted (test env path)", async () => {
		// processRef defaults to global process; in vitest the test-env
		// detection trips first so we never actually attach to it.
		// processRef 默认指向全局 process；vitest 中先命中 test-env 检测，
		// 因此实际不会向真实 process 注册。
		const { controller } = await createBootedController();
		try {
			const handle = installSighupHandler(controller);
			expect(handle.registered).toBe(false);
			expect(handle.reason).toBe("test_environment");
			handle.dispose();
		} finally {
			controller.dispose();
		}
	});

	it("forwards thrown reload errors via onError (catch branch)", async () => {
		const { controller } = await createBootedController();
		try {
			const fakeProcess = new FakeProcess();
			const errors: unknown[] = [];
			// Stub controller.reload to throw synchronously to cover the
			// catch branch in runReload.
			// stub controller.reload 抛错，覆盖 runReload 的 catch 分支。
			(controller as unknown as { reload: () => Promise<never> }).reload =
				async () => {
					throw new Error("forced sighup failure");
				};
			const handle = installSighupHandler(controller, {
				forceRegister: true,
				processRef: fakeProcess,
				onError: (err) => {
					errors.push(err);
				},
			});

			fakeProcess.emit("SIGHUP");
			await new Promise<void>((resolve) => setTimeout(resolve, 100));

			expect(errors.length).toBeGreaterThanOrEqual(1);
			const first = errors[0];
			expect(first).toBeInstanceOf(Error);
			if (first instanceof Error) {
				expect(first.message).toContain("forced sighup failure");
			}

			handle.dispose();
		} finally {
			controller.dispose();
		}
	});

	it("forceRegister bypasses test-env detection", async () => {
		const { controller } = await createBootedController();
		try {
			const fakeProcess = new FakeProcess();
			const handle = installSighupHandler(controller, {
				env: { NODE_ENV: "test", VITEST: "1" },
				processRef: fakeProcess,
				forceRegister: true,
			});
			expect(handle.registered).toBe(true);
			expect(handle.reason).toBe("forced");
			handle.dispose();
		} finally {
			controller.dispose();
		}
	});
});
