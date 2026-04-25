import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type BenchmarkSubmissionConfig,
	resolveBenchmarkSubmissionConfig,
	resolveBenchmarkSubmissionPaths,
} from "./config.js";

const rootDir = path.resolve("/repo/quilin-agent");

describe("benchmark submission config", () => {
	it("resolves default benchmark paths under the workspace", () => {
		expect(resolveBenchmarkSubmissionPaths(() => undefined, rootDir)).toEqual({
			outputDir: path.join(rootDir, ".benchmarks"),
			submissionsDir: path.join(rootDir, ".benchmarks", "submissions"),
			cacheDir: path.join(rootDir, ".benchmarks", "cache"),
		});
	});

	it("uses process cwd defaults when no provider or root is injected", () => {
		expect(resolveBenchmarkSubmissionPaths()).toEqual({
			outputDir: path.join(process.cwd(), ".benchmarks"),
			submissionsDir: path.join(process.cwd(), ".benchmarks", "submissions"),
			cacheDir: path.join(process.cwd(), ".benchmarks", "cache"),
		});
		expect(resolveBenchmarkSubmissionConfig()).toEqual({
			output_dir: ".benchmarks",
			submissions_dir: "submissions",
			cache_dir: "cache",
			network_whitelist: [],
			max_concurrent_tasks: 1,
		});
	});

	it("resolves injected relative benchmark paths with Kelvin field names", () => {
		const provider = (): BenchmarkSubmissionConfig => ({
			benchmarks: {
				output_dir: "out/bench",
				submissions_dir: "submit",
				cache_dir: "data-cache",
				network_whitelist: ["https://datasets-server.huggingface.co"],
				max_concurrent_tasks: 4,
			},
		});

		expect(resolveBenchmarkSubmissionPaths(provider, rootDir)).toEqual({
			outputDir: path.join(rootDir, "out", "bench"),
			submissionsDir: path.join(rootDir, "out", "bench", "submit"),
			cacheDir: path.join(rootDir, "out", "bench", "data-cache"),
		});
		expect(resolveBenchmarkSubmissionConfig(provider)).toEqual({
			output_dir: "out/bench",
			submissions_dir: "submit",
			cache_dir: "data-cache",
			network_whitelist: ["https://datasets-server.huggingface.co"],
			max_concurrent_tasks: 4,
		});
	});

	it("preserves injected absolute output, submission, and cache paths", () => {
		const provider = (): BenchmarkSubmissionConfig => ({
			benchmarks: {
				output_dir: "/tmp/quilin-bench",
				submissions_dir: "/tmp/quilin-submissions",
				cache_dir: "/tmp/quilin-cache",
			},
		});

		expect(resolveBenchmarkSubmissionPaths(provider, rootDir)).toEqual({
			outputDir: path.normalize("/tmp/quilin-bench"),
			submissionsDir: path.normalize("/tmp/quilin-submissions"),
			cacheDir: path.normalize("/tmp/quilin-cache"),
		});
	});

	it("keeps defaults for omitted non-path Kelvin benchmark fields", () => {
		expect(
			resolveBenchmarkSubmissionConfig(() => ({ benchmarks: {} })),
		).toEqual({
			output_dir: ".benchmarks",
			submissions_dir: "submissions",
			cache_dir: "cache",
			network_whitelist: [],
			max_concurrent_tasks: 1,
		});
	});
});
