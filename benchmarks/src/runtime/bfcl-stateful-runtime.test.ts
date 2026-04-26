import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BfclStatefulRuntimeError,
	StatefulRuntime,
	spawnBfclStatefulRuntime,
} from "./bfcl-stateful-runtime.js";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("BFCL stateful runtime", () => {
	it("keeps backend object state across 3+ tool calls and returns snapshots", async () => {
		const checkerRoot = await writeRuntimeBundle();
		const session = await StatefulRuntime.spawn(
			"task-stateful",
			["GorillaFileSystem"],
			{
				checkerRoot,
				commandTimeoutMs: 1_000,
				forwardSignals: false,
				initialConfig: {
					GorillaFileSystem: { files: { "seed.txt": "seed" } },
				},
			},
		);

		await expect(
			session.callTool("GorillaFileSystem.write_file", {
				content: "alpha",
				path: "alpha.txt",
			}),
		).resolves.toMatchObject({
			class: "GorillaFileSystem",
			function: "write_file",
			returnValue: { path: "alpha.txt", written: true },
		});
		await expect(
			session.callTool("GorillaFileSystem.append_file", {
				content: "+beta",
				path: "alpha.txt",
			}),
		).resolves.toMatchObject({
			returnValue: { appended: true, path: "alpha.txt" },
		});
		await expect(
			session.callTool("GorillaFileSystem.read_file", { path: "alpha.txt" }),
		).resolves.toMatchObject({
			returnValue: "alpha+beta",
		});

		const snapshot = await session.snapshot();
		expect(snapshot).toMatchObject({
			GorillaFileSystem: {
				state: {
					files: {
						"alpha.txt": "alpha+beta",
						"seed.txt": "seed",
					},
				},
			},
		});
		await session.close();
	});

	it("initializes all E3c1 backend classes and rejects E3c2/E4 classes fail-loud", async () => {
		const checkerRoot = await writeRuntimeBundle();
		const session = await spawnBfclStatefulRuntime(
			"task-all-classes",
			[
				"GorillaFileSystem",
				"MathAPI",
				"MessageAPI",
				"TwitterAPI",
				"TicketAPI",
				"TradingBot",
				"TravelAPI",
				"VehicleControlAPI",
			],
			{
				checkerRoot,
				commandTimeoutMs: 1_000,
				forwardSignals: false,
				initialConfig: {
					GorillaFileSystem: { files: {} },
					MessageAPI: { seeded: true },
					TicketAPI: { seeded: true },
					TradingBot: { seeded: true },
					TravelAPI: { seeded: true },
					TwitterAPI: { seeded: true },
					VehicleControlAPI: { seeded: true },
				},
			},
		);

		await expect(
			session.callTool("MathAPI.add", { left: 2, right: 3 }),
		).resolves.toMatchObject({ returnValue: 5 });
		await expect(
			session.callTool("TwitterAPI.ping", { value: "ok" }),
		).resolves.toMatchObject({ returnValue: { value: "ok" } });
		await session.close();

		await expect(
			spawnBfclStatefulRuntime("task-web", ["WebSearchAPI"], {
				checkerRoot,
				commandTimeoutMs: 1_000,
				forwardSignals: false,
			}),
		).rejects.toMatchObject({
			errorType: "backend_class_not_found",
		});
		await expect(
			spawnBfclStatefulRuntime("task-memory", ["MemoryAPI_kv"], {
				checkerRoot,
				commandTimeoutMs: 1_000,
				forwardSignals: false,
			}),
		).rejects.toMatchObject({
			errorType: "backend_class_not_found",
		});
	});

	it("preserves the five worker error types", async () => {
		const checkerRoot = await writeRuntimeBundle();
		const session = await spawnBfclStatefulRuntime(
			"task-errors",
			["GorillaFileSystem"],
			{ checkerRoot, commandTimeoutMs: 1_000, forwardSignals: false },
		);

		await expect(
			session.callTool("GorillaFileSystem.missing", {}),
		).rejects.toMatchObject({ errorType: "tool_method_not_found" });
		await expect(
			session.callTool("GorillaFileSystem.write_file", { path: "x" }),
		).rejects.toMatchObject({ errorType: "tool_args_invalid" });
		await expect(
			session.callTool("GorillaFileSystem.read_file", { path: "missing" }),
		).rejects.toMatchObject({ errorType: "tool_runtime_error" });
		await expect(
			session.callTool("GorillaFileSystem.remove", { path: "x" }),
		).rejects.toMatchObject({ errorType: "eval_security_violation" });
		await session.close();

		await expect(
			spawnBfclStatefulRuntime("task-unknown", ["UnknownAPI"], {
				checkerRoot,
				commandTimeoutMs: 1_000,
				forwardSignals: false,
			}),
		).rejects.toMatchObject({ errorType: "backend_class_not_found" });
	});

	it("times out stalled commands and removes signal listeners after close", async () => {
		const checkerRoot = await writeRuntimeBundle();
		const scriptPath = await writeNodeWorkerScript(
			[
				"process.stdout.write(JSON.stringify({type:'ready'}) + '\\n');",
				"process.stdin.resume();",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		const before = process.listenerCount("SIGTERM");

		await expect(
			spawnBfclStatefulRuntime("task-timeout", ["GorillaFileSystem"], {
				checkerRoot,
				commandTimeoutMs: 20,
				forwardSignals: false,
				pythonExecutable: process.execPath,
				workerScriptPath: scriptPath,
			}),
		).rejects.toThrow(/timed out/);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(process.listenerCount("SIGTERM")).toBe(before);
	});

	it("forwards parent termination signals to the worker", async () => {
		const checkerRoot = await writeRuntimeBundle();
		const markerPath = join(await makeTempRoot("quilin-bfcl-signal-"), "term");
		const scriptPath = await writeNodeWorkerScript(
			[
				"const fs = require('node:fs');",
				`const marker = ${JSON.stringify(markerPath)};`,
				"process.stdout.write(JSON.stringify({type:'ready'}) + '\\n');",
				"process.stdin.on('data', (chunk) => {",
				"  for (const line of String(chunk).trim().split(/\\n+/)) {",
				"    if (!line) continue;",
				"    const command = JSON.parse(line);",
				"    if (command.type === 'init_task') process.stdout.write(JSON.stringify({type:'ready', id: command.id}) + '\\n');",
				"    if (command.type === 'close') process.stdout.write(JSON.stringify({type:'closed', id: command.id}) + '\\n');",
				"  }",
				"});",
				"process.on('SIGTERM', () => { fs.writeFileSync(marker, 'SIGTERM'); process.exit(0); });",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		const before = process.listenerCount("SIGTERM");
		const session = await spawnBfclStatefulRuntime(
			"task-signal",
			["GorillaFileSystem"],
			{
				checkerRoot,
				commandTimeoutMs: 1_000,
				forwardSignals: false,
				pythonExecutable: process.execPath,
				workerScriptPath: scriptPath,
			},
		);

		(
			session as unknown as { readonly forwardSigterm: () => void }
		).forwardSigterm();
		await waitFor(() => existsSync(markerPath));

		expect(readFileSync(markerPath, "utf8")).toBe("SIGTERM");
		await session.close().catch(() => undefined);
		expect(process.listenerCount("SIGTERM")).toBeLessThanOrEqual(before);
	});

	it("handles adapter lifecycle edge cases without leaking sessions", async () => {
		const checkerRoot = await writeRuntimeBundle();
		const signalForwardingSession = await spawnBfclStatefulRuntime(
			"task-forward-default",
			["GorillaFileSystem"],
			{ checkerRoot, commandTimeoutMs: 1_000 },
		);
		await signalForwardingSession.close();

		const session = await spawnBfclStatefulRuntime(
			"task-defaults",
			["GorillaFileSystem"],
			{ checkerRoot, forwardSignals: false, idleTimeoutMs: 0 },
		);

		await (
			session as unknown as { readonly start: () => Promise<void> }
		).start();
		await session.close();
		await session.close();
		await expect(
			session.callTool("GorillaFileSystem.read_file", { path: "x" }),
		).rejects.toThrow(/closed/);
		await expect(
			spawnBfclStatefulRuntime("", ["GorillaFileSystem"], {
				checkerRoot,
				forwardSignals: false,
			}),
		).rejects.toThrow(/taskId/);
	});

	it("rejects malformed worker protocol output and bounded-output violations", async () => {
		const checkerRoot = await writeRuntimeBundle();
		const invalidJsonScript = await writeNodeWorkerScript(
			"process.stdout.write('not-json\\n'); setInterval(() => {}, 1000);",
		);
		await expect(
			spawnBfclStatefulRuntime("task-invalid-json", ["GorillaFileSystem"], {
				checkerRoot,
				commandTimeoutMs: 100,
				forwardSignals: false,
				pythonExecutable: process.execPath,
				workerScriptPath: invalidJsonScript,
			}),
		).rejects.toMatchObject({
			errorType: "worker_protocol_error",
		} satisfies Partial<BfclStatefulRuntimeError>);
		const nonObjectJsonScript = await writeNodeWorkerScript(
			"process.stdout.write('[]\\n'); setInterval(() => {}, 1000);",
		);
		await expect(
			spawnBfclStatefulRuntime("task-non-object-json", ["GorillaFileSystem"], {
				checkerRoot,
				commandTimeoutMs: 100,
				forwardSignals: false,
				pythonExecutable: process.execPath,
				workerScriptPath: nonObjectJsonScript,
			}),
		).rejects.toMatchObject({
			errorType: "worker_protocol_error",
		} satisfies Partial<BfclStatefulRuntimeError>);

		const largeOutputScript = await writeNodeWorkerScript(
			"process.stdout.write('x'.repeat(64)); setInterval(() => {}, 1000);",
		);
		await expect(
			spawnBfclStatefulRuntime("task-output-limit", ["GorillaFileSystem"], {
				checkerRoot,
				commandTimeoutMs: 100,
				forwardSignals: false,
				maxOutputBytes: 8,
				pythonExecutable: process.execPath,
				workerScriptPath: largeOutputScript,
			}),
		).rejects.toMatchObject({
			errorType: "worker_output_limit",
		} satisfies Partial<BfclStatefulRuntimeError>);

		const largeStderrScript = await writeNodeWorkerScript(
			"process.stdout.write(JSON.stringify({type:'ready'}) + '\\n'); process.stderr.write('x'.repeat(64)); setInterval(() => {}, 1000);",
		);
		await expect(
			spawnBfclStatefulRuntime("task-stderr-limit", ["GorillaFileSystem"], {
				checkerRoot,
				commandTimeoutMs: 100,
				forwardSignals: false,
				maxOutputBytes: 8,
				pythonExecutable: process.execPath,
				workerScriptPath: largeStderrScript,
			}),
		).rejects.toThrow();
	});

	it("ignores unrelated protocol messages and rejects malformed result payloads", async () => {
		const checkerRoot = await writeRuntimeBundle();
		const scriptPath = await writeNodeWorkerScript(
			[
				"process.stdout.write('\\n');",
				"process.stdout.write(JSON.stringify({type:'ready'}) + '\\n');",
				"process.stdin.on('data', (chunk) => {",
				"  for (const line of String(chunk).trim().split(/\\n+/)) {",
				"    if (!line) continue;",
				"    const command = JSON.parse(line);",
				"    process.stdout.write(JSON.stringify({type:'result'}) + '\\n');",
				"    process.stdout.write(JSON.stringify({type:'ready', id: 123}) + '\\n');",
				"    process.stdout.write(JSON.stringify({type:'ready', id:'999'}) + '\\n');",
				"    if (command.type === 'init_task') process.stdout.write(JSON.stringify({type:'ready', id: command.id}) + '\\n');",
				"    if (command.type === 'call_tool') process.stdout.write(JSON.stringify({type:'result', id: command.id, return_value: 1}) + '\\n');",
				"    if (command.type === 'close') process.stdout.write(JSON.stringify({type:'closed', id: command.id}) + '\\n');",
				"  }",
				"});",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		const session = await spawnBfclStatefulRuntime(
			"task-protocol-noise",
			["GorillaFileSystem"],
			{
				checkerRoot,
				commandTimeoutMs: 200,
				forwardSignals: false,
				pythonExecutable: process.execPath,
				workerScriptPath: scriptPath,
			},
		);

		await expect(session.callTool("anything", {})).rejects.toThrow(
			/missing class/,
		);
		await session.close();
	});
});

async function writeRuntimeBundle(): Promise<string> {
	const root = await makeTempRoot("quilin-bfcl-runtime-");
	const checkerRoot = join(root, "datasets", "bfcl-v4");
	await writeSupportFile(
		checkerRoot,
		"bfcl_eval/constants/executable_backend_config.py",
		[
			"BACKEND_PATH_PREFIX = 'bfcl_eval.eval_checker.multi_turn_eval.func_source_code'",
			"CLASS_FILE_PATH_MAPPING = {",
			"    'GorillaFileSystem': f'{BACKEND_PATH_PREFIX}.gorilla_file_system',",
			"    'MathAPI': f'{BACKEND_PATH_PREFIX}.math_api',",
			"    'MessageAPI': f'{BACKEND_PATH_PREFIX}.message_api',",
			"    'TwitterAPI': f'{BACKEND_PATH_PREFIX}.posting_api',",
			"    'TicketAPI': f'{BACKEND_PATH_PREFIX}.ticket_api',",
			"    'TradingBot': f'{BACKEND_PATH_PREFIX}.trading_bot',",
			"    'TravelAPI': f'{BACKEND_PATH_PREFIX}.travel_booking',",
			"    'VehicleControlAPI': f'{BACKEND_PATH_PREFIX}.vehicle_control',",
			"    'WebSearchAPI': f'{BACKEND_PATH_PREFIX}.web_search',",
			"    'MemoryAPI_kv': f'{BACKEND_PATH_PREFIX}.memory_kv',",
			"}",
			"STATELESS_CLASSES = ['MathAPI']",
			"",
		].join("\n"),
	);
	await writeInitFiles(checkerRoot);
	await writeSupportFile(
		checkerRoot,
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/gorilla_file_system.py",
		[
			"class GorillaFileSystem:",
			"    def __init__(self):",
			"        self.files = {}",
			"    def _load_scenario(self, scenario, long_context=False):",
			"        self.files = dict(scenario.get('files', {}))",
			"        self.long_context = long_context",
			"    def write_file(self, path, content):",
			"        self.files[path] = content",
			"        return {'written': True, 'path': path}",
			"    def append_file(self, path, content):",
			"        self.files[path] += content",
			"        return {'appended': True, 'path': path}",
			"    def read_file(self, path):",
			"        return self.files[path]",
			"",
		].join("\n"),
	);
	await writeSupportFile(
		checkerRoot,
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/math_api.py",
		[
			"class MathAPI:",
			"    def add(self, left, right):",
			"        return left + right",
			"",
		].join("\n"),
	);
	for (const [path, className] of [
		["message_api.py", "MessageAPI"],
		["posting_api.py", "TwitterAPI"],
		["ticket_api.py", "TicketAPI"],
		["trading_bot.py", "TradingBot"],
		["travel_booking.py", "TravelAPI"],
		["vehicle_control.py", "VehicleControlAPI"],
	] as const) {
		await writeSupportFile(
			checkerRoot,
			`bfcl_eval/eval_checker/multi_turn_eval/func_source_code/${path}`,
			genericBackendSource(className),
		);
	}
	return checkerRoot;
}

async function writeInitFiles(checkerRoot: string): Promise<void> {
	for (const relativePath of [
		"bfcl_eval/__init__.py",
		"bfcl_eval/constants/__init__.py",
		"bfcl_eval/eval_checker/__init__.py",
		"bfcl_eval/eval_checker/multi_turn_eval/__init__.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/__init__.py",
	]) {
		await writeSupportFile(checkerRoot, relativePath, "");
	}
}

function genericBackendSource(className: string): string {
	return [
		`class ${className}:`,
		"    def __init__(self):",
		"        self.calls = []",
		"        self.scenario = {}",
		"    def _load_scenario(self, scenario, long_context=False):",
		"        self.scenario = dict(scenario)",
		"        self.long_context = long_context",
		"    def ping(self, value='ok'):",
		"        self.calls.append(value)",
		"        return {'value': value}",
		"",
	].join("\n");
}

async function writeSupportFile(
	checkerRoot: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const filePath = join(checkerRoot, relativePath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
}

async function writeNodeWorkerScript(source: string): Promise<string> {
	const root = await makeTempRoot("quilin-bfcl-node-worker-");
	const scriptPath = join(root, "worker.cjs");
	await writeFile(scriptPath, source, "utf8");
	return scriptPath;
}

async function makeTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for condition");
}
