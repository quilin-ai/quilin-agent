import path from "node:path";

export type BenchmarkSubmissionConfig = {
	readonly benchmarks?: {
		readonly output_dir?: string;
		readonly submissions_dir?: string;
		readonly cache_dir?: string;
		readonly network_whitelist?: readonly string[];
		readonly max_concurrent_tasks?: number;
	};
};

export type BenchmarkSubmissionConfigProvider = () =>
	| BenchmarkSubmissionConfig
	| undefined;

export type ResolvedBenchmarkSubmissionPaths = {
	readonly outputDir: string;
	readonly submissionsDir: string;
	readonly cacheDir: string;
};

const defaultBenchmarkConfig = {
	output_dir: ".benchmarks",
	submissions_dir: "submissions",
	cache_dir: "cache",
	network_whitelist: [] as readonly string[],
	max_concurrent_tasks: 1,
} as const;

function resolvePath(rootDir: string, value: string): string {
	return path.isAbsolute(value)
		? path.normalize(value)
		: path.resolve(rootDir, value);
}

export function resolveBenchmarkSubmissionPaths(
	provider: BenchmarkSubmissionConfigProvider = () => undefined,
	rootDir = process.cwd(),
): ResolvedBenchmarkSubmissionPaths {
	const benchmarks = provider()?.benchmarks ?? {};
	const outputDir = resolvePath(
		rootDir,
		benchmarks.output_dir ?? defaultBenchmarkConfig.output_dir,
	);

	return {
		outputDir,
		submissionsDir: resolvePath(
			outputDir,
			benchmarks.submissions_dir ?? defaultBenchmarkConfig.submissions_dir,
		),
		cacheDir: resolvePath(
			outputDir,
			benchmarks.cache_dir ?? defaultBenchmarkConfig.cache_dir,
		),
	};
}

export function resolveBenchmarkSubmissionConfig(
	provider: BenchmarkSubmissionConfigProvider = () => undefined,
): Required<NonNullable<BenchmarkSubmissionConfig["benchmarks"]>> {
	return {
		...defaultBenchmarkConfig,
		...(provider()?.benchmarks ?? {}),
	};
}
