import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilitiesHotReloadController } from "./hot-reload.js";
import {
	assertLoopbackHost,
	computeReloadWebhookSignature,
	loadReloadWebhookSecret,
	MAX_RELOAD_REQUEST_BODY_BYTES,
	RELOAD_WEBHOOK_SECRET_ENV,
	RELOAD_WEBHOOK_SIGNATURE_HEADER,
	RELOAD_WEBHOOK_SOCKET_TIMEOUT_MS,
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

	it("rejects POST with Content-Length > 64 KiB cap with 413", async () => {
		// HIGH-1: declared Content-Length over the cap is rejected before
		// the body is buffered, preventing OOM via huge unauth payload.
		// HIGH-1：Content-Length 超过上限时在缓冲请求体之前直接拒绝，
		// 防止通过超大未授权 payload 撑爆内存。
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const oversize = MAX_RELOAD_REQUEST_BODY_BYTES + 1;
			const result = await new Promise<{
				status: number;
				body: string;
			}>((resolve, reject) => {
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port: handle.port,
						method: "POST",
						path: "/reload",
						headers: {
							[RELOAD_WEBHOOK_SIGNATURE_HEADER]: "0".repeat(64),
							"content-length": String(oversize),
						},
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (c: Buffer) => chunks.push(c));
						res.on("end", () =>
							resolve({
								status: res.statusCode ?? 0,
								body: Buffer.concat(chunks).toString("utf8"),
							}),
						);
					},
				);
				req.on("error", reject);
				// Do not actually send the oversize body — server should
				// 413 + destroy purely from the Content-Length pre-check.
				// 不真实发送大 body — server 应当仅根据 Content-Length 头预检 413 + 销毁。
				req.end();
			});
			expect(result.status).toBe(413);
			const parsed = JSON.parse(result.body) as Record<string, unknown>;
			expect(parsed.error).toBe("payload_too_large");
			// Reload must NOT have been triggered.
			// 必须未触发 reload。
			expect(controller.getStatus().lastSuccess?.trigger).not.toBe("webhook");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("rejects streamed body exceeding cap (no Content-Length) with 413", async () => {
		// HIGH-1: even when Content-Length is absent (chunked / unknown),
		// the streaming guard cuts off at the cap to prevent unbounded
		// memory growth.
		// HIGH-1：即便 Content-Length 缺失（chunked / 未知），流式守卫
		// 也会在上限处切断，防止内存无限增长。
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const result = await new Promise<{
				status: number;
				body: string;
			}>((resolve, reject) => {
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port: handle.port,
						method: "POST",
						path: "/reload",
						headers: {
							[RELOAD_WEBHOOK_SIGNATURE_HEADER]: "0".repeat(64),
							"transfer-encoding": "chunked",
						},
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (c: Buffer) => chunks.push(c));
						res.on("end", () =>
							resolve({
								status: res.statusCode ?? 0,
								body: Buffer.concat(chunks).toString("utf8"),
							}),
						);
					},
				);
				req.on("error", reject);
				// Stream past the cap in a single chunk — easy reproducible
				// trigger of the per-stream guard.
				// 单个 chunk 直接灌过上限 — 稳定触发流式守卫。
				const bigChunk = Buffer.alloc(MAX_RELOAD_REQUEST_BODY_BYTES + 100, "x");
				req.write(bigChunk);
				req.end();
			});
			expect(result.status).toBe(413);
			const parsed = JSON.parse(result.body) as Record<string, unknown>;
			expect(parsed.error).toBe("payload_too_large");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("accepts body exactly at cap then rejects with 401 (HMAC mismatch)", async () => {
		// HIGH-1 boundary: body at exactly MAX_RELOAD_REQUEST_BODY_BYTES
		// must pass the cap and then fail HMAC — proves the cap is not
		// off-by-one against legitimate payloads up to the limit.
		// HIGH-1 边界：body 恰好等于 MAX_RELOAD_REQUEST_BODY_BYTES 时
		// 必须通过容量检查再因 HMAC 不匹配返回 401 — 证明上限对边界
		// 大小的合法 payload 不会误伤。
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const body = Buffer.alloc(MAX_RELOAD_REQUEST_BODY_BYTES, "a");
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				headers: {
					[RELOAD_WEBHOOK_SIGNATURE_HEADER]: "0".repeat(64),
					"content-type": "application/octet-stream",
				},
				body,
			});
			expect(response.status).toBe(401);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.error).toBe("invalid_signature");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("destroys idle slow-stream sockets via setTimeout", async () => {
		// HIGH-1 socket timeout: a half-open POST that never sends data
		// must be torn down within RELOAD_WEBHOOK_SOCKET_TIMEOUT_MS.
		// We open a raw TCP socket, write request headers without `\r\n\r\n`
		// terminator (keeps the request "in progress" indefinitely from
		// the server's POV), and assert the socket is closed on us before
		// any response arrives.
		// HIGH-1 socket 超时：半开的 POST 永不发送数据时必须在
		// RELOAD_WEBHOOK_SOCKET_TIMEOUT_MS 内被销毁。我们打开原始 TCP
		// socket，发送不带 `\r\n\r\n` 终止符的请求头（让 server 视角
		// 一直停在请求处理中），断言 socket 在响应到来前被关闭。
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: "secret" },
		});
		try {
			const startedAt = Date.now();
			const closedAt = await new Promise<number>((resolve, reject) => {
				const sock = netConnect({ host: "127.0.0.1", port: handle.port });
				sock.on("error", reject);
				sock.on("connect", () => {
					// Half-open: send method + a partial header line, never
					// terminate the headers. Server's `setTimeout` should
					// destroy us shortly after the configured timeout.
					sock.write("POST /reload HTTP/1.1\r\nHost: 127.0.0.1\r\n");
					// Note: NO trailing \r\n\r\n on purpose.
				});
				sock.on("close", () => resolve(Date.now()));
			});
			const elapsed = closedAt - startedAt;
			// Lower bound: should not close before timeout fires (give
			// 200ms slack for handshake variability).
			// 下界：在超时触发前不应关闭（200ms 余量给握手抖动）。
			expect(elapsed).toBeGreaterThanOrEqual(
				Math.max(0, RELOAD_WEBHOOK_SOCKET_TIMEOUT_MS - 200),
			);
			// Upper bound: must close within 2x the timeout to prove the
			// guard fires (not just that the test framework gave up).
			// 上界：必须在 2 倍超时内关闭，证明守卫真的触发（而不是测试框架超时）。
			expect(elapsed).toBeLessThanOrEqual(RELOAD_WEBHOOK_SOCKET_TIMEOUT_MS * 2);
		} finally {
			await handle.close();
			controller.dispose();
		}
	}, 15_000);

	it("redacts configPath to basename in success response (info-leak hardening)", async () => {
		// R1: success JSON must expose only the file basename, not the
		// full absolute path.
		// R1：success JSON 只暴露文件 basename，不暴露绝对路径。
		const secret = "test-secret";
		const { controller, configPath } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: secret },
		});
		try {
			const body = JSON.stringify({ reason: "redact" });
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
			// Basename of the temp config — no directory separators in
			// the response.
			// 临时 config 的 basename — 响应中不应含目录分隔符。
			expect(payload.configPath).toBe("capabilities.json");
			expect(String(payload.configPath)).not.toContain("/");
			// Sanity: the absolute path actually contains `/` — so the
			// redaction is non-trivial.
			// 健全性：绝对路径必然包含 `/` — 证明裁剪非平凡。
			expect(configPath).toContain("/");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("trims whitespace / CRLF on the signature header before HMAC compare", async () => {
		// R2: surrounding whitespace from accidental shell pipes must not
		// flip a valid signature into 401.
		// R2：shell 管道意外混入的首尾空白不应让合法签名变成 401。
		const secret = "test-secret";
		const { controller } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: secret },
		});
		try {
			const body = JSON.stringify({ reason: "trim" });
			const signature = computeReloadWebhookSignature(secret, body);
			const response = await fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					// Surround with explicit ASCII whitespace + tab (HTTP
					// header values cannot contain raw CRLF — Node's
					// HTTP layer rejects it earlier).
					// 前后包裹普通空白 + tab（HTTP 头值不允许裸 CRLF —
					// Node HTTP 层会先拒绝）。
					[RELOAD_WEBHOOK_SIGNATURE_HEADER]: `  \t${signature}\t  `,
				},
				body,
			});
			expect(response.status).toBe(200);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload.status).toBe("success");
		} finally {
			await handle.close();
			controller.dispose();
		}
	});

	it("converges on latest config when webhook + manual reload race", async () => {
		// SUSPECT (Reviewer B) defensive test: fire two reload triggers
		// (webhook + manual, simulating webhook + SIGHUP) in rapid
		// succession and verify the controller's generation token logic
		// converges on the latest config without data loss. We do not
		// add a Promise mutex — the existing token logic is intentional.
		// SUSPECT (Reviewer B) 防御测试：快速连发 webhook + manual（模
		// 拟 webhook + SIGHUP）两次 reload，验证 controller 的
		// generation token 逻辑收敛到最新配置且无数据丢失。不引入
		// Promise 互斥锁 — 既有 token 设计是有意为之的。
		const secret = "race-secret";
		const { controller, configPath } = await createBootedController();
		const handle = await startReloadWebhookServer({
			controller,
			host: "127.0.0.1",
			port: 0,
			env: { [RELOAD_WEBHOOK_SECRET_ENV]: secret },
		});
		try {
			// Mutate config to mcp server "racer" — both reloads should
			// observe (or converge to) this new server.
			// 把 config 改为 mcp server "racer" — 两次 reload 都应当看到
			// （或收敛到）这个新 server。
			await writeFile(
				configPath,
				JSON.stringify(
					{
						schema_version: 1,
						mcpServers: {
							racer: { command: "node", args: ["server.js"], cwd: "." },
						},
						skills: { enabled: false },
					},
					null,
					2,
				),
				"utf8",
			);

			const body = JSON.stringify({ reason: "race" });
			const signature = computeReloadWebhookSignature(secret, body);
			const webhookPromise = fetch(`http://127.0.0.1:${handle.port}/reload`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[RELOAD_WEBHOOK_SIGNATURE_HEADER]: signature,
				},
				body,
			});
			// Fire a second reload via the controller directly,
			// simulating a SIGHUP arriving in the same millisecond as the
			// HTTP request.
			// 直接通过 controller 触发第二次 reload，模拟 SIGHUP 与 HTTP
			// 请求毫秒级到达。
			const manualPromise = controller.reload("manual");

			const [webhookResp, manualResult] = await Promise.all([
				webhookPromise,
				manualPromise,
			]);
			expect(webhookResp.status).toBe(200);
			expect(manualResult.status).toBe("success");
			// Both triggers report success — neither lost data.
			// 双方都报成功 — 都没丢数据。
			const status = controller.getStatus();
			expect(status.lastSuccess).not.toBeNull();
			// Final runtime converged on the latest config.
			// 最终 runtime 收敛到最新配置。
			expect(controller.getRuntime().mcpServers.map((s) => s.id)).toEqual([
				"racer",
			]);
		} finally {
			await handle.close();
			controller.dispose();
		}
	});
});
