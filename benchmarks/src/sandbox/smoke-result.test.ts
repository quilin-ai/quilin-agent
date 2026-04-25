import { describe, expect, it } from "vitest";
import {
	assertDockerSmokeCommandSucceeded,
	assertDockerSmokeCommandTimedOut,
} from "./smoke-result.js";

describe("Docker smoke command result assertions", () => {
	it("accepts successful DockerSandbox command payloads", () => {
		expect(
			assertDockerSmokeCommandSucceeded(
				result({ exitCode: 0, isError: false }),
				"smoke",
			),
		).toMatchObject({ exitCode: 0, timedOut: false });
	});

	it("rejects ignored tool errors even when JSON content is parseable", () => {
		expect(() =>
			assertDockerSmokeCommandSucceeded(
				result({ exitCode: 12, isError: true, stderr: "network-allowed" }),
				"isolation",
			),
		).toThrow(/isolation failed.*network-allowed/);
	});

	it("rejects truncated output and malformed tool envelopes", () => {
		expect(() =>
			assertDockerSmokeCommandSucceeded(
				result({ exitCode: 0, isError: false, output_truncated: true }),
				"truncated",
			),
		).toThrow(/output_truncated=true/);
		expect(() => assertDockerSmokeCommandSucceeded(null, "missing")).toThrow(
			/non-object tool result/,
		);
		expect(() =>
			assertDockerSmokeCommandSucceeded({ isError: false }, "content"),
		).toThrow(/without string content/);
		expect(() =>
			assertDockerSmokeCommandSucceeded({ content: "{}" }, "malformed"),
		).toThrow(/without isError/);
		expect(() =>
			assertDockerSmokeCommandSucceeded(
				{ content: "not json", isError: false },
				"invalid",
			),
		).toThrow(/invalid JSON/);
		expect(() =>
			assertDockerSmokeCommandSucceeded(
				{ content: "null", isError: false },
				"payload",
			),
		).toThrow(/non-object JSON content/);
		expect(() =>
			assertDockerSmokeCommandSucceeded(
				{ content: JSON.stringify({ exitCode: 0 }), isError: false },
				"incomplete",
			),
		).toThrow(/incomplete DockerSandbox payload/);
	});

	it("requires timeout probes to return a timed-out tool error", () => {
		expect(
			assertDockerSmokeCommandTimedOut(
				result({ exitCode: null, isError: true, timedOut: true }),
				"timeout",
			),
		).toMatchObject({ exitCode: null, timedOut: true });
		expect(() =>
			assertDockerSmokeCommandTimedOut(
				result({ exitCode: 0, isError: false, timedOut: false }),
				"timeout",
			),
		).toThrow(/timeout failed/);
	});
});

function result(input: {
	readonly exitCode: number | null;
	readonly isError: boolean;
	readonly output_truncated?: boolean;
	readonly stderr?: string;
	readonly stdout?: string;
	readonly timedOut?: boolean;
}): { readonly content: string; readonly isError: boolean } {
	return {
		content: JSON.stringify({
			exitCode: input.exitCode,
			output_truncated: input.output_truncated ?? false,
			stderr: input.stderr ?? "",
			stdout: input.stdout ?? "",
			timedOut: input.timedOut ?? false,
		}),
		isError: input.isError,
	};
}
