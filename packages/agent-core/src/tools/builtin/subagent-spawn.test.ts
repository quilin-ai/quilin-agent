import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../loop.js";
import {
	_resetSubagentRegistryForTests,
	createSubagentSpawnTool,
	createSubagentStatusTool,
} from "./subagent-spawn.js";

// Mock at module-load time so the dynamic import inside subagent-spawn.ts
// resolves to our stub. Each test overrides behavior via vi.mocked below.
vi.mock("../../loop.js", () => ({
	runAgentLoop: vi.fn(),
}));

const mockedRunAgentLoop = vi.mocked(runAgentLoop);

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function makeNeverResolving(): Promise<string> {
	return new Promise<string>(() => {
		// Intentionally never resolves — keeps subagent in 'running' state.
	});
}

// Returns a minimal-shape loopConfig. We don't care about its content because
// runAgentLoop is mocked at the module level and never reads these fields in
// the test paths exercised here.
const stubLoopConfig = {
	getLoopConfig: () => ({}) as never,
};

describe("subagent_spawn parameter validation", () => {
	beforeEach(() => {
		// Default to a fast-rejecting mock so spawn-execute returns and the
		// fire-and-forget body settles to 'failed' quickly.
		mockedRunAgentLoop.mockImplementation(async () => {
			throw new Error("test-stub: runAgentLoop is mocked");
		});
	});
	afterEach(() => {
		_resetSubagentRegistryForTests();
		mockedRunAgentLoop.mockReset();
	});

	it("rejects task strings beyond 50_000 chars (DoS guard)", async () => {
		const spawn = createSubagentSpawnTool(stubLoopConfig);
		const oversized = "a".repeat(50_001);

		await expect(spawn.execute({ task: oversized })).rejects.toThrow();
	});

	it("accepts task strings up to 50_000 chars", async () => {
		const spawn = createSubagentSpawnTool(stubLoopConfig);
		const max = "a".repeat(50_000);

		const result = await spawn.execute({ task: max });

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content) as { status: string; runId: string };
		expect(payload.status).toBe("spawned");
		expect(payload.runId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("rejects empty tasks", async () => {
		const spawn = createSubagentSpawnTool(stubLoopConfig);
		await expect(spawn.execute({ task: "" })).rejects.toThrow();
	});
});

describe("subagent_status filtering and limits", () => {
	afterEach(() => {
		_resetSubagentRegistryForTests();
		mockedRunAgentLoop.mockReset();
	});

	it("supports status='running' filter", async () => {
		// Use the never-resolving mock so spawned subagents stay in 'running'.
		mockedRunAgentLoop.mockImplementation(() => makeNeverResolving());
		const spawn = createSubagentSpawnTool(stubLoopConfig);
		const status = createSubagentStatusTool();

		await spawn.execute({ task: "first" });
		await spawn.execute({ task: "second" });
		// Status check while both fire-and-forget tasks are pending — running count stays at 2.
		const result = await status.execute({ status: "running" });

		const payload = JSON.parse(result.content) as {
			running: number;
			shown: number;
			runs: ReadonlyArray<{ status: string }>;
		};
		expect(payload.running).toBe(2);
		expect(payload.shown).toBe(2);
		expect(payload.runs.every((r) => r.status === "running")).toBe(true);
	});

	it("supports status='failed' filter after fire-and-forget rejects", async () => {
		mockedRunAgentLoop.mockImplementation(async () => {
			throw new Error("test-stub: rejected");
		});
		const spawn = createSubagentSpawnTool(stubLoopConfig);
		const status = createSubagentStatusTool();

		await spawn.execute({ task: "first" });
		await flushMicrotasks();
		// Wait for the rejected runAgentLoop to settle into 'failed' status.
		await flushMicrotasks();

		const result = await status.execute({ status: "failed" });
		const payload = JSON.parse(result.content) as {
			failed: number;
			runs: ReadonlyArray<{ status: string }>;
		};
		expect(payload.failed).toBe(1);
		expect(payload.runs.every((r) => r.status === "failed")).toBe(true);
	});

	it("respects limit parameter for response size bounds", async () => {
		mockedRunAgentLoop.mockImplementation(() => makeNeverResolving());
		const spawn = createSubagentSpawnTool(stubLoopConfig);
		const status = createSubagentStatusTool();

		for (let i = 0; i < 10; i++) {
			await spawn.execute({ task: `task ${i}` });
		}

		const result = await status.execute({ status: "all", limit: 3 });
		const payload = JSON.parse(result.content) as {
			total: number;
			shown: number;
			runs: ReadonlyArray<unknown>;
		};
		expect(payload.total).toBe(10);
		expect(payload.shown).toBe(3);
		expect(payload.runs.length).toBe(3);
	});

	it("rejects limit beyond 500 hard cap", async () => {
		const status = createSubagentStatusTool();
		await expect(status.execute({ limit: 501 })).rejects.toThrow();
	});

	it("returns shape with capacity and zero records when registry is empty", async () => {
		const status = createSubagentStatusTool();
		const result = await status.execute({});

		expect(result.isError).toBe(false);
		expect(result.content).toBe("No subagents spawned yet.");
	});
});

describe("subagentRegistry capacity eviction (memory-leak guard)", () => {
	afterEach(() => {
		_resetSubagentRegistryForTests();
		mockedRunAgentLoop.mockReset();
	});

	it("evicts oldest terminal records once cap is reached, preserving total <=200", async () => {
		mockedRunAgentLoop.mockImplementation(async () => {
			throw new Error("test-stub: rejected");
		});
		const spawn = createSubagentSpawnTool(stubLoopConfig);
		const status = createSubagentStatusTool();

		// Spawn 200, all become 'failed' once microtasks flush.
		for (let i = 0; i < 200; i++) {
			await spawn.execute({ task: `task ${i}` });
		}
		await flushMicrotasks();
		await flushMicrotasks();

		// Spawn one more; oldest terminal entry should be evicted.
		await spawn.execute({ task: "overflow" });
		await flushMicrotasks();

		const result = await status.execute({ status: "all", limit: 500 });
		const payload = JSON.parse(result.content) as { total: number; capacity: number };
		expect(payload.total).toBeLessThanOrEqual(200);
		expect(payload.capacity).toBe(200);
	});
});
