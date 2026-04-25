import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapUserRuntime, resetUserRuntime } from "../config/runtime.js";
import {
	DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK,
	DEFAULT_SCRATCHPAD_TTL_SEC,
	getScratchpadDefaults,
	MCPScratchpadClient,
	NullScratchpadClient,
	ScratchpadClientError,
	type ScratchpadMCPTransport,
} from "./scratchpad-client.js";

interface RecordedCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

function createTransport(
	response: string | ((name: string, args: Record<string, unknown>) => string),
): {
	readonly calls: RecordedCall[];
	readonly transport: ScratchpadMCPTransport;
} {
	const calls: RecordedCall[] = [];
	return {
		calls,
		transport: {
			async callTool(name, args) {
				calls.push({ name, args });
				return typeof response === "function" ? response(name, args) : response;
			},
		},
	};
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(tmpdir(), "quilin-scratchpad-client-"));
	resetUserRuntime();
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	resetUserRuntime();
});

describe("getScratchpadDefaults", () => {
	it("uses ADR defaults when user runtime has not been booted", () => {
		expect(getScratchpadDefaults()).toEqual({
			ttlSec: DEFAULT_SCRATCHPAD_TTL_SEC,
			capacityPerTask: DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK,
		});
	});

	it("uses runtime config after bootstrap", async () => {
		await bootstrapUserRuntime({
			configPath: path.join(tmpDir, "missing.toml"),
			env: {},
			cliOverrides: {
				memory: {
					scratchpad: {
						ttl_sec: 45,
						capacity_per_task: 7,
					},
				},
			},
		});

		expect(getScratchpadDefaults()).toEqual({
			ttlSec: 45,
			capacityPerTask: 7,
		});
	});
});

describe("MCPScratchpadClient", () => {
	it("writes through MCP with snake_case args and fallback defaults", async () => {
		const { calls, transport } = createTransport(JSON.stringify({ ok: true }));
		const client = new MCPScratchpadClient(transport);

		await client.write({
			taskId: "task-1",
			sessionId: "session-1",
			key: "outline",
			value: "draft answer",
		});

		expect(calls).toEqual([
			{
				name: "scratchpad_write",
				args: {
					task_id: "task-1",
					session_id: "session-1",
					key: "outline",
					value: "draft answer",
					ttl_sec: DEFAULT_SCRATCHPAD_TTL_SEC,
					capacity_per_task: DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK,
				},
			},
		]);
	});

	it("allows per-call ttl and capacity overrides", async () => {
		const { calls, transport } = createTransport(JSON.stringify({ ok: true }));
		const client = new MCPScratchpadClient(transport);

		await client.write({
			taskId: "task-1",
			sessionId: "session-1",
			key: "outline",
			value: "draft answer",
			ttlSec: 30,
			capacityPerTask: 3,
		});

		expect(calls[0]?.args).toMatchObject({
			ttl_sec: 30,
			capacity_per_task: 3,
		});
	});

	it("reads and clears scratchpad values through MCP", async () => {
		const { calls, transport } = createTransport((name) =>
			JSON.stringify(
				name === "scratchpad_read" ? { value: "saved value" } : { cleared: 2 },
			),
		);
		const client = new MCPScratchpadClient(transport);

		await expect(
			client.read({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
			}),
		).resolves.toBe("saved value");
		await expect(
			client.clear({
				taskId: "task-1",
				sessionId: "session-1",
			}),
		).resolves.toBe(2);

		expect(calls).toEqual([
			{
				name: "scratchpad_read",
				args: {
					task_id: "task-1",
					session_id: "session-1",
					key: "outline",
				},
			},
			{
				name: "scratchpad_clear",
				args: {
					task_id: "task-1",
					session_id: "session-1",
				},
			},
		]);
	});

	it("returns null for missing values and raises tool errors", async () => {
		const missing = new MCPScratchpadClient(
			createTransport(JSON.stringify({ value: null })).transport,
		);
		await expect(
			missing.read({
				taskId: "task-1",
				sessionId: "session-1",
				key: "missing",
			}),
		).resolves.toBeNull();

		const failing = new MCPScratchpadClient(
			createTransport(JSON.stringify({ error: "scratchpad offline" }))
				.transport,
		);
		await expect(
			failing.write({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
				value: "draft answer",
			}),
		).rejects.toThrow(ScratchpadClientError);
	});

	it("rejects invalid ttl and capacity overrides before calling MCP", async () => {
		const { calls, transport } = createTransport(JSON.stringify({ ok: true }));
		const client = new MCPScratchpadClient(transport);

		await expect(
			client.write({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
				value: "draft answer",
				ttlSec: 0,
			}),
		).rejects.toThrow(/ttlSec/);
		await expect(
			client.write({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
				value: "draft answer",
				capacityPerTask: 1.5,
			}),
		).rejects.toThrow(/capacityPerTask/);
		expect(calls).toEqual([]);
	});

	it("raises protocol errors for non-json, non-object, and invalid read values", async () => {
		const nonJson = new MCPScratchpadClient(
			createTransport("not-json").transport,
		);
		await expect(
			nonJson.read({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
			}),
		).rejects.toThrow(/non-JSON/);

		const nonObject = new MCPScratchpadClient(
			createTransport(JSON.stringify(["not", "object"])).transport,
		);
		await expect(
			nonObject.read({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
			}),
		).rejects.toThrow(/non-object/);

		const badValue = new MCPScratchpadClient(
			createTransport(JSON.stringify({ value: 123 })).transport,
		);
		await expect(
			badValue.read({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
			}),
		).rejects.toThrow(/value must be a string/);
	});

	it("clears by key, accepts count fallback, and rejects invalid counts", async () => {
		const { calls, transport } = createTransport(JSON.stringify({ count: 3 }));
		const client = new MCPScratchpadClient(transport);

		await expect(
			client.clear({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
			}),
		).resolves.toBe(3);
		expect(calls).toEqual([
			{
				name: "scratchpad_clear",
				args: {
					task_id: "task-1",
					session_id: "session-1",
					key: "outline",
				},
			},
		]);

		const invalid = new MCPScratchpadClient(
			createTransport(JSON.stringify({ cleared: -1 })).transport,
		);
		await expect(
			invalid.clear({
				taskId: "task-1",
				sessionId: "session-1",
			}),
		).rejects.toThrow(/non-negative integer/);
	});
});

describe("NullScratchpadClient", () => {
	it("no-ops as a fallback client", async () => {
		const client = new NullScratchpadClient();

		await expect(
			client.write({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
				value: "draft answer",
			}),
		).resolves.toBeUndefined();
		await expect(
			client.read({
				taskId: "task-1",
				sessionId: "session-1",
				key: "outline",
			}),
		).resolves.toBeNull();
		await expect(
			client.clear({
				taskId: "task-1",
				sessionId: "session-1",
			}),
		).resolves.toBe(0);
	});
});
