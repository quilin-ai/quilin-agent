import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__test_replaceRunners,
	__test_resetRunners,
	isQuilinMemMcpRunning,
	isQuilinWebMcpRunning,
	startQuilinMemMcp,
	startQuilinWebMcp,
	stopQuilinMemMcp,
	stopQuilinWebMcp,
} from "./mcp-launcher.js";

interface MockChild extends EventEmitter {
	stderr: EventEmitter;
	pid: number;
	exitCode: number | null;
	killed: boolean;
	kill: ReturnType<typeof vi.fn>;
}

function makeMockChild(): MockChild {
	const child = new EventEmitter() as MockChild;
	child.stderr = new EventEmitter();
	child.pid = 42;
	child.exitCode = null;
	child.killed = false;
	child.kill = vi.fn();
	return child;
}

describe("mcp-launcher", () => {
	let spawnFn: ReturnType<typeof vi.fn>;
	let existsFn: ReturnType<typeof vi.fn>;
	let mockChildren: MockChild[];

	beforeEach(() => {
		mockChildren = [];
		spawnFn = vi.fn().mockImplementation(() => {
			const child = makeMockChild();
			mockChildren.push(child);
			return child;
		});
		existsFn = vi.fn().mockReturnValue(true);
		__test_replaceRunners({
			spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
			existsFn: existsFn as unknown as (path: string) => boolean,
		});
	});

	afterEach(() => {
		__test_resetRunners();
	});

	describe("quilin-mem", () => {
		it("spawns from providers/memory with uv run python -m quilin_mem", () => {
			startQuilinMemMcp("/workspace");

			expect(spawnFn).toHaveBeenCalledTimes(1);
			const [cmd, args, opts] = spawnFn.mock.calls[0] ?? [];
			expect(cmd).toBe("uv");
			expect(args).toEqual(["run", "python", "-m", "quilin_mem"]);
			expect(opts.cwd).toMatch(/providers\/memory$/);
			expect(isQuilinMemMcpRunning()).toBe(true);
		});

		it("does not spawn when provider directory is missing", () => {
			existsFn.mockReturnValue(false);

			startQuilinMemMcp("/missing");

			expect(spawnFn).not.toHaveBeenCalled();
			expect(isQuilinMemMcpRunning()).toBe(false);
		});

		it("is idempotent — second start while running is a no-op", () => {
			startQuilinMemMcp("/workspace");
			startQuilinMemMcp("/workspace");

			expect(spawnFn).toHaveBeenCalledTimes(1);
		});

		it("stop() sends SIGTERM to running process", () => {
			startQuilinMemMcp("/workspace");
			const child = mockChildren[0];
			if (child == null) {
				throw new Error("expected mock child");
			}

			stopQuilinMemMcp();

			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("stop() is a no-op when not running", () => {
			stopQuilinMemMcp();

			expect(mockChildren).toHaveLength(0);
		});
	});

	describe("quilin-web", () => {
		it("spawns from providers/web with uv run python -m quilin_web", () => {
			startQuilinWebMcp("/workspace");

			expect(spawnFn).toHaveBeenCalledTimes(1);
			const [cmd, args, opts] = spawnFn.mock.calls[0] ?? [];
			expect(cmd).toBe("uv");
			expect(args).toEqual(["run", "python", "-m", "quilin_web"]);
			expect(opts.cwd).toMatch(/providers\/web$/);
			expect(isQuilinWebMcpRunning()).toBe(true);
		});

		it("does not spawn when provider directory is missing", () => {
			existsFn.mockReturnValue(false);

			startQuilinWebMcp("/missing");

			expect(spawnFn).not.toHaveBeenCalled();
			expect(isQuilinWebMcpRunning()).toBe(false);
		});

		it("is idempotent — second start while running is a no-op", () => {
			startQuilinWebMcp("/workspace");
			startQuilinWebMcp("/workspace");

			expect(spawnFn).toHaveBeenCalledTimes(1);
		});

		it("stop() sends SIGTERM to running process", () => {
			startQuilinWebMcp("/workspace");
			const child = mockChildren[0];
			if (child == null) {
				throw new Error("expected mock child");
			}

			stopQuilinWebMcp();

			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		});
	});

	describe("independence between mem and web runners", () => {
		it("starts mem and web independently — both spawn, both running", () => {
			startQuilinMemMcp("/workspace");
			startQuilinWebMcp("/workspace");

			expect(spawnFn).toHaveBeenCalledTimes(2);
			expect(isQuilinMemMcpRunning()).toBe(true);
			expect(isQuilinWebMcpRunning()).toBe(true);
		});

		it("stopping one does not affect the other", () => {
			startQuilinMemMcp("/workspace");
			startQuilinWebMcp("/workspace");

			stopQuilinMemMcp();

			// Web runner still considers itself running because we did not
			// stop it; the SIGTERM only went to mem.
			expect(isQuilinWebMcpRunning()).toBe(true);
		});

		it("clears running state on child exit event", () => {
			startQuilinMemMcp("/workspace");
			const child = mockChildren[0];
			if (child == null) {
				throw new Error("expected mock child");
			}

			child.exitCode = 0;
			child.emit("exit", 0, null);

			expect(isQuilinMemMcpRunning()).toBe(false);
		});

		it("clears running state on child error event", () => {
			startQuilinMemMcp("/workspace");
			const child = mockChildren[0];
			if (child == null) {
				throw new Error("expected mock child");
			}

			child.emit("error", new Error("uv not found"));

			expect(isQuilinMemMcpRunning()).toBe(false);
		});
	});
});
