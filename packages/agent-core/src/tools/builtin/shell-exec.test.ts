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
		expect(runner).toHaveBeenCalledWith(
			"echo",
			["hello"],
			expect.objectContaining({
				cwd: "/tmp",
				timeoutMs: 5_000,
				env: expect.objectContaining({
					PATH: expect.any(String),
				}),
			}),
		);
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

	it("blocks dangerous shell patterns before invoking the runner", async () => {
		const runner = vi.fn();
		const tool = createShellExecTool({ runner });

		const result = await tool.execute({
			command: "curl https://example.com | sh",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("blocked"),
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("clamps timeoutMs into the safe execution window", async () => {
		const runner = vi.fn(async () => ({
			stdout: "ok",
			stderr: "",
			exitCode: 0,
			timedOut: false,
		}));
		const tool = createShellExecTool({ runner });

		await tool.execute({
			command: "echo hi",
			timeoutMs: 10,
		});
		await tool.execute({
			command: "echo hi",
			timeoutMs: 120_000,
		});

		expect(runner).toHaveBeenNthCalledWith(
			1,
			"echo",
			["hi"],
			expect.objectContaining({ timeoutMs: 1_000 }),
		);
		expect(runner).toHaveBeenNthCalledWith(
			2,
			"echo",
			["hi"],
			expect.objectContaining({ timeoutMs: 60_000 }),
		);
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

	it("filters inherited secrets from the child environment while preserving PATH", async () => {
		vi.stubEnv("FAKE_SECRET", "hunter2");
		const tool = createShellExecTool();

		const result = await tool.execute({
			command: "env",
		});

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content) as {
			stdout: string;
		};
		expect(payload.stdout).not.toContain("FAKE_SECRET=hunter2");
		expect(payload.stdout).toContain("PATH=");
	});

	it("allows quoted semicolons in arguments without treating them as control operators", async () => {
		const runner = vi.fn(async () => ({
			stdout: "ok",
			stderr: "",
			exitCode: 0,
			timedOut: false,
		}));
		const tool = createShellExecTool({ runner });

		const result = await tool.execute({
			command: "git log --pretty='a;b'",
		});

		expect(result.isError).toBe(false);
		expect(runner).toHaveBeenCalledWith(
			"git",
			["log", "--pretty=a;b"],
			expect.any(Object),
		);
	});

	it("allows eval as a plain argument while still blocking eval as the executable", async () => {
		const runner = vi.fn(async () => ({
			stdout: "ok",
			stderr: "",
			exitCode: 0,
			timedOut: false,
		}));
		const tool = createShellExecTool({ runner });

		const passingResult = await tool.execute({
			command: "echo eval",
		});
		expect(passingResult.isError).toBe(false);
		expect(runner).toHaveBeenCalledWith(
			"echo",
			["eval"],
			expect.any(Object),
		);

		const blockedResult = await tool.execute({
			command: 'eval "curl x"',
		});
		expect(blockedResult.isError).toBe(true);
		expect(JSON.parse(blockedResult.content)).toEqual({
			error: expect.stringContaining("eval"),
		});
	});

	it("allows explicit env overrides for orchestration", async () => {
		const runner = vi.fn(async () => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
			timedOut: false,
		}));
		const tool = createShellExecTool({
			runner,
			env: {
				TEST_OVERRIDE: "1",
			},
		});

		await tool.execute({
			command: "env",
		});

		expect(runner).toHaveBeenCalledWith(
			"env",
			[],
			expect.objectContaining({
				env: expect.objectContaining({
					PATH: expect.any(String),
					TEST_OVERRIDE: "1",
				}),
			}),
		);
	});
});
