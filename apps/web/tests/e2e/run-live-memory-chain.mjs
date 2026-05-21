#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "../..");
const repoRoot = resolve(webRoot, "../..");

function listen(server) {
	return new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectListen);
			const address = server.address();
			if (address == null || typeof address === "string") {
				rejectListen(new Error("server did not bind to a TCP port"));
				return;
			}
			resolveListen(address.port);
		});
	});
}

function closeServer(server) {
	return new Promise((resolveClose) => {
		server.close(() => resolveClose());
	});
}

function createFakeDeepSeekServer() {
	return createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}

		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			let stream = false;
			try {
				const parsed = JSON.parse(raw);
				stream = parsed?.stream === true;
			} catch {
				stream = false;
			}

			if (!stream) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "chatcmpl-live-memory-e2e",
						object: "chat.completion",
						created: Math.floor(Date.now() / 1000),
						model: "deepseek-chat",
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({
										candidates: [],
										confidence: 0,
										clusters: [],
									}),
								},
								finish_reason: "stop",
							},
						],
					}),
				);
				return;
			}

			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const created = Math.floor(Date.now() / 1000);
			const chunks = [
				{
					id: "chatcmpl-live-memory-e2e",
					object: "chat.completion.chunk",
					created,
					model: "deepseek-chat",
					choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
				},
				{
					id: "chatcmpl-live-memory-e2e",
					object: "chat.completion.chunk",
					created,
					model: "deepseek-chat",
					choices: [
						{
							index: 0,
							delta: { content: "收到，已记录这条测试观察。" },
							finish_reason: null,
						},
					],
				},
				{
					id: "chatcmpl-live-memory-e2e",
					object: "chat.completion.chunk",
					created,
					model: "deepseek-chat",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
			];
			for (const chunk of chunks) {
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			}
			res.end("data: [DONE]\n\n");
		});
	});
}

async function waitForHttp(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.status < 500) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
	}
	throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
}

async function getFreePort() {
	const server = createServer();
	try {
		return await listen(server);
	} finally {
		await closeServer(server);
	}
}

function spawnProcess(command, args, options) {
	const child = spawn(command, args, {
		...options,
		stdio: "inherit",
	});
	child.on("error", (error) => {
		console.error(error);
	});
	return child;
}

function waitForExit(child) {
	return new Promise((resolveExit) => {
		child.on("exit", (code, signal) => {
			resolveExit({ code, signal });
		});
	});
}

async function terminate(child) {
	if (child.exitCode != null || child.signalCode != null) return;
	child.kill("SIGTERM");
	const timer = setTimeout(() => {
		if (child.exitCode == null && child.signalCode == null) {
			child.kill("SIGKILL");
		}
	}, 5_000);
	await waitForExit(child);
	clearTimeout(timer);
}

async function main() {
	const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-live-e2e."));
	const claudeConfigPath = join(tmpRoot, "claude.json");
	await writeFile(claudeConfigPath, '{"mcpServers":{}}\n', "utf8");

	const fakeDeepSeek = createFakeDeepSeekServer();
	const fakePort = await listen(fakeDeepSeek);
	const nextPort =
		process.env.QUILIN_LIVE_E2E_PORT == null
			? await getFreePort()
			: Number(process.env.QUILIN_LIVE_E2E_PORT);
	const baseUrl = `http://127.0.0.1:${nextPort}`;
	const sharedEnv = {
		...process.env,
		QUILIN_LIVE_MCP_E2E: "1",
		QUILIN_ENV: "dev",
		QUILIN_MEM_DB_PATH: join(tmpRoot, "memory.db"),
		QUILIN_WEB_DB_PATH: join(tmpRoot, "sessions.db"),
		QUILIN_CLAUDE_CONFIG: claudeConfigPath,
		QUILIN_MCP_HOT_RELOAD: "off",
		QUILIN_SKILL_HOT_RELOAD: "off",
		QUILIN_WEB_ALLOWED_ROOTS: repoRoot,
		DEEPSEEK_API_KEY: "live-memory-e2e-fake-key",
		DEEPSEEK_BASE_URL: `http://127.0.0.1:${fakePort}/v1`,
		DEEPSEEK_MODEL: "deepseek-chat",
		QUILIN_OBSERVER_API_KEY: "live-memory-e2e-fake-key",
		QUILIN_OBSERVER_BASE_URL: `http://127.0.0.1:${fakePort}/v1/chat/completions`,
		QUILIN_DEDUPE_API_KEY: "live-memory-e2e-fake-key",
		QUILIN_DEDUPE_BASE_URL: `http://127.0.0.1:${fakePort}/v1/chat/completions`,
		NEXT_TELEMETRY_DISABLED: "1",
	};

	let nextProcess;
	try {
		console.log(`[live-memory-e2e] tmp=${tmpRoot}`);
		console.log(`[live-memory-e2e] fake DeepSeek=http://127.0.0.1:${fakePort}/v1`);
		nextProcess = spawnProcess(
			"pnpm",
			["exec", "next", "dev", "-p", String(nextPort), "-H", "127.0.0.1"],
			{ cwd: webRoot, env: { ...sharedEnv, HOME: tmpRoot, USERPROFILE: tmpRoot } },
		);
		await new Promise((resolveLaunch) => setTimeout(resolveLaunch, 250));
		if (nextProcess.exitCode != null || nextProcess.signalCode != null) {
			throw new Error(
				`next dev exited before readiness check (code=${nextProcess.exitCode}, signal=${nextProcess.signalCode})`,
			);
		}
		await waitForHttp(baseUrl, 120_000);
		if (nextProcess.exitCode != null || nextProcess.signalCode != null) {
			throw new Error(
				`next dev exited during readiness check (code=${nextProcess.exitCode}, signal=${nextProcess.signalCode})`,
			);
		}

		const playwright = spawnProcess(
			"pnpm",
			["exec", "playwright", "test", "tests/e2e/live-memory-chain.spec.ts", "--project=chromium"],
			{
				cwd: webRoot,
				env: {
					...sharedEnv,
					PLAYWRIGHT_BASE_URL: baseUrl,
				},
			},
		);
		const result = await waitForExit(playwright);
		if (result.code !== 0) {
			process.exitCode = result.code ?? 1;
		}
	} finally {
		if (nextProcess != null) {
			await terminate(nextProcess);
		}
		await closeServer(fakeDeepSeek);
		if (process.env.QUILIN_LIVE_E2E_KEEP_TMP !== "1") {
			await rm(tmpRoot, { recursive: true, force: true });
		} else {
			console.log(`[live-memory-e2e] kept tmp=${tmpRoot}`);
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
