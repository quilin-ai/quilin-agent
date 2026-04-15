import { describe, expect, it, vi } from "vitest";
import { createShellExecTool } from "./shell-exec.js";

describe("builtin shell_exec tool", () => {
	it("executes commands through the injected runner and returns stdout", async () => {
		const runner = vi.fn(async () => ({
			stdout: "hello\n",
			stderr: "",
			exitCode: 0,
			timedOut: false,
		}));
		const tool = createShellExecTool({
			runner,
			defaultTimeoutMs: 5_000,
		});

		const result = await tool.execute({
			command: "echo hello",
			cwd: "/tmp",
		});

		expect(result.isError).toBe(false);
		expect(runner).toHaveBeenCalledWith("echo hello", {
			cwd: "/tmp",
			timeoutMs: 5_000,
		});
		expect(JSON.parse(result.content)).toEqual({
			command: "echo hello",
			exitCode: 0,
			stdout: "hello\n",
			stderr: "",
			truncated: false,
		});
	});

	it("marks timed out or non-zero commands as errors", async () => {
		const timeoutRunner = vi.fn(async () => ({
			stdout: "",
			stderr: "timed out",
			exitCode: null,
			timedOut: true,
		}));
		const timeoutTool = createShellExecTool({ runner: timeoutRunner });

		const timedOut = await timeoutTool.execute({
			command: "sleep 10",
			timeoutMs: 10,
		});

		expect(timedOut.isError).toBe(true);
		expect(JSON.parse(timedOut.content)).toEqual({
			error: expect.stringContaining("timed out"),
		});

		const failingRunner = vi.fn(async () => ({
			stdout: "",
			stderr: "permission denied",
			exitCode: 126,
			timedOut: false,
		}));
		const failingTool = createShellExecTool({ runner: failingRunner });

		const failed = await failingTool.execute({
			command: "cat /root/secret",
		});

		expect(failed.isError).toBe(true);
		expect(JSON.parse(failed.content)).toEqual({
			error: "permission denied",
			exitCode: 126,
		});
	});

	it("truncates oversized combined output", async () => {
		const runner = vi.fn(async () => ({
			stdout: "abcdefghijklmnopqrstuvwxyz",
			stderr: "",
			exitCode: 0,
			timedOut: false,
		}));
		const tool = createShellExecTool({
			runner,
			maxOutputChars: 10,
		});

		const result = await tool.execute({
			command: "echo abcdefghijklmnopqrstuvwxyz",
		});

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toEqual({
			command: "echo abcdefghijklmnopqrstuvwxyz",
			exitCode: 0,
			stdout: "abcdefg...",
			stderr: "",
			truncated: true,
		});
	});
});
