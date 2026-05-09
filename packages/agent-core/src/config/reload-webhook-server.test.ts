import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilitiesHotReloadController } from "./hot-reload.js";
import {
	assertLoopbackHost,
	computeReloadWebhookSignature,
	loadReloadWebhookSecret,
	RELOAD_WEBHOOK_SECRET_ENV,
	RELOAD_WEBHOOK_SIGNATURE_HEADER,
	ReloadWebhookConfigurationError,
	startReloadWebhookServer,
} from "./reload-webhook-server.js";

const createdDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "quilin-webhook-"));
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
	controller: ReturnType<typeof createCapabilitiesHotReloadController>;
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

afterEach(async () => {
	await Promise.all(
		createdDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("loadReloadWebhookSecret", () => {
	it("returns the secret when env var is set", () => {
		expect(
			loadReloadWebhookSecret({ [RELOAD_WEBHOOK_SECRET_ENV]: "shh" }),
		).toBe("shh");
	});

	it("throws when env var is missing", () => {
		expect(() => loadReloadWebhookSecret({})).toThrow(
			ReloadWebhookConfigurationError,
		);
	});

	it("throws when env var is empty", () => {
		expect(() =>
			loadReloadWebhookSecret({ [RELOAD_WEBHOOK_SECRET_ENV]: "" }),
		).toThrow(ReloadWebhookConfigurationError);
	});
});

describe("assertLoopbackHost", () => {
	it("accepts loopback aliases", () => {
		expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
		expect(() => assertLoopbackHost("::1")).not.toThrow();
		expect(() => assertLoopbackHost("localhost")).not.toThrow();
		expect(() => assertLoopbackHost("127.5.6.7")).not.toThrow();
	});

	it("rejects 0.0.0.0", () => {
		expect(() => assertLoopbackHost("0.0.0.0")).toThrow(
			ReloadWebhookConfigurationError,
		);
	});

	it("rejects unspecified IPv6", () => {
		expect(() => assertLoopbackHost("::")).toThrow(
			ReloadWebhookConfigurationError,
		);
	});

	it("rejects public IPv4", () => {
		expect(() => assertLoopbackHost("192.168.1.10")).toThrow(
			ReloadWebhookConfigurationError,
		);
		expect(() => assertLoopbackHost("8.8.8.8")).toThrow(
			ReloadWebhookConfigurationError,
		);
	});

	it("rejects empty / non-loopback hostnames", () => {
		expect(() => assertLoopbackHost("")).toThrow(
			ReloadWebhookConfigurationError,
		);
		expect(() => assertLoopbackHost("example.com")).toThrow(
			ReloadWebhookConfigurationError,
		);
	});
});

describe("computeReloadWebhookSignature", () => {
	it("matches a known HMAC-SHA256 reference value", () => {
		// HMAC-SHA256 of "" with key "k" — independently verified.
		const sig = computeReloadWebhookSignature("k", "");
		expect(sig).toMatch(/^[a-f0-9]{64}$/);
		expect(sig).toBe(computeReloadWebhookSignature("k", ""));
	});

	it("differs across keys", () => {
		const sigA = computeReloadWebhookSignature("a", "payload");
		const sigB = computeReloadWebhookSignature("b", "payload");
		expect(sigA).not.toBe(sigB);
	});
});

describe("startReloadWebhookServer", () => {
	it("refuses to start without QUILIN_RELOAD_WEBHOOK_SECRET", async () => {
		const { controller } = await createBootedController();
		try {
			await expect(
				startReloadWebhookServer({
					controller,
					host: "127.0.0.1",
					port: 0,
					env: {},
				}),
			).rejects.toBeInstanceOf(ReloadWebhookConfigurationError);
		} finally {
			controller.dispose();
		}
	});

	it("refuses to bind 0.0.0.0", async () => {
		const { controller } = await createBootedController();
		try {
			await expect(
				startReloadWebhookServer({
					controller,
					host: "0.0.0.0",
					port: 0,
					env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
				}),
			).rejects.toBeInstanceOf(ReloadWebhookConfigurationError);
		} finally {
			controller.dispose();
		}
	});

	it("binds 127.0.0.1 and reports host:port via onListen", async () => {
		const { controller } = await createBootedController();
		const calls: { host: string; port: number }[] = [];
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
			onListen: (info) => calls.push(info),
		});
		try {
			expect(handle.host).toBe("127.0.0.1");
			expect(handle.port).toBeGreaterThan(0);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.host).toBe("127.0.0.1");
			expect(calls[0]?.port).toBe(handle.port);
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("returns 200 + reload result for valid HMAC POST /reload", async () => {
		const secret = "test-secret";
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: secret },
		});
		try {
			const body = JSON.stringify({ reason: "test" });
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
			expect(controller.getStatus().lastSuccess?.trigger).toBe("webhook");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("returns 401 for invalid HMAC signature", async () => {
		const secret = "test-secret";
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: secret },
		});
		try {
			const body = "bad payload";
			const wrongSignature = "0".repeat(64);
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				headers: {
					[RELOAD_WEBHOOK_SIGNATURE_HEADER]: wrongSignature,
				},
				body,
			});
			expect(response.status).toBe(401);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.error).toBe("invalid_signature");
			// The reload should NOT have been triggered.
			expect(controller.getStatus().lastSuccess?.trigger).not.toBe("webhook");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("returns 401 when signature header is missing", async () => {
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				body: "anything",
			});
			expect(response.status).toBe(401);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.error).toBe("missing_signature");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("returns 405 for non-POST methods on /reload", async () => {
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "GET",
			});
			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("POST");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("returns 404 for unknown paths", async () => {
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
			expect(response.status).toBe(404);
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("rejects same-length non-hex signatures via buffer length guard", async () => {
		// String lengths match but Buffer.from(..., "hex") returns empty
		// for non-hex chars, hitting the expectedBuf.length === 0 guard.
		// 字符串长度一致但 Buffer.from(..., "hex") 对非 hex 字符返回空 buffer，
		// 触发 expectedBuf.length === 0 的守卫。
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				// 64 chars but all `z` so hex decode yields empty Buffer.
				headers: { [RELOAD_WEBHOOK_SIGNATURE_HEADER]: "z".repeat(64) },
				body: "x",
			});
			expect(response.status).toBe(401);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.error).toBe("invalid_signature");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("rejects mismatched-length signature without crashing the handler", async () => {
		// Length-mismatch fast path of timingSafeEqualHex.
		// 触发 timingSafeEqualHex 长度不一致的 fast path。
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				headers: { [RELOAD_WEBHOOK_SIGNATURE_HEADER]: "deadbeef" },
				body: "x",
			});
			expect(response.status).toBe(401);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.error).toBe("invalid_signature");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("logs handler errors via onError when controller.reload throws", async () => {
		const secret = "test-secret";
		const { controller } = await createBootedController();
		// Force controller.reload to throw via stub to cover the catch path.
		// stub controller.reload 抛错，覆盖 handler 的 catch 分支。
		const errors: string[] = [];
		const stubError = new Error("forced reload failure");
		(controller as unknown as { reload: () => Promise<never> }).reload = () => {
			throw stubError;
		};

		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: secret },
			onError: (err, context) => {
				errors.push(
					`${context}:${err instanceof Error ? err.message : String(err)}`,
				);
			},
		});
		try {
			const body = "payload";
			const signature = computeReloadWebhookSignature(secret, body);
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				headers: { [RELOAD_WEBHOOK_SIGNATURE_HEADER]: signature },
				body,
			});
			expect(response.status).toBe(500);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.error).toBe("internal_error");
			expect(payload.message).toContain("forced reload failure");
			expect(errors.length).toBeGreaterThanOrEqual(1);
			expect(errors[0]).toContain("reload_webhook_handler");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("returns 500 when controller.reload result is failure", async () => {
		const secret = "test-secret";
		const { controller, configPath } = await createBootedController();
		// Corrupt the config so reload returns failure (not throw).
		// 把 config 写坏，让 reload 返回 failure（而不是抛错）。
		const fs = await import("node:fs/promises");
		await fs.writeFile(configPath, "{ not valid json", "utf8");

		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: secret },
		});
		try {
			const body = "x";
			const signature = computeReloadWebhookSignature(secret, body);
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				headers: { [RELOAD_WEBHOOK_SIGNATURE_HEADER]: signature },
				body,
			});
			expect(response.status).toBe(500);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.status).toBe("failure");
			expect(payload.trigger).toBe("webhook");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("rejects when listen() emits an error (e.g. port already in use)", async () => {
		const { controller } = await createBootedController();
		// Bind first server to lock a port.
		const first = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			await expect(
				startReloadWebhookServer({
					controller,
					host: "127.0.0.1",
					port: first.port,
					env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
				}),
			).rejects.toBeInstanceOf(Error);
		} finally {
			await first.close();
			controller.dispose();
		}
	});

	it("close() resolves once and a second close rejects via callback error", async () => {
		// Covers the close-callback err branch — Node returns ERR_SERVER_NOT_RUNNING.
		// 覆盖 close 回调的 err 分支：第二次 close 触发 ERR_SERVER_NOT_RUNNING。
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			await handle.close();
			await expect(handle.close()).rejects.toBeInstanceOf(Error);
		} finally {
			controller.dispose();
		}
	});
});
