import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type FetchBenchmarkOptions,
	fetchBenchmark,
	main,
	parseArgs,
} from "../../scripts/fetch-benchmark.js";

const defaultRowsBaseUrl = "https://datasets-server.huggingface.co/rows";
const tempRoots: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	await Promise.all(
		tempRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("fetch-benchmark cache intent", () => {
	it("refetches when a partial cache is reused for a full fetch intent", async () => {
		const cacheRoot = await tempCacheRoot();
		mockRowsFetch(10);

		const partial = await fetchBenchmark(
			options({ cacheRoot, dataset: "swe-bench-verified", maxRows: 10 }),
		);
		expect(partial).toMatchObject({ rows: 10, skipped: false });

		const fullFetch = mockRowsFetch(500);
		const full = await fetchBenchmark(
			options({ cacheRoot, dataset: "swe-bench-verified" }),
		);
		const manifest = JSON.parse(
			await readFile(
				join(cacheRoot, "datasets", "swe-bench-verified", "manifest.json"),
				"utf8",
			),
		) as { readonly requested_max_rows: number | null };

		expect(full).toMatchObject({ rows: 500, skipped: false });
		expect(fullFetch).toHaveBeenCalledTimes(5);
		expect(manifest.requested_max_rows).toBeNull();
	});

	it("skips when an existing partial cache already satisfies a smaller partial request", async () => {
		const cacheRoot = await tempCacheRoot();
		mockRowsFetch(100);

		const larger = await fetchBenchmark(
			options({ cacheRoot, dataset: "swe-bench-lite", maxRows: 100 }),
		);
		expect(larger).toMatchObject({ rows: 100, skipped: false });

		const unusedFetch = mockRowsFetch(50);
		const smaller = await fetchBenchmark(
			options({ cacheRoot, dataset: "swe-bench-lite", maxRows: 50 }),
		);

		expect(smaller).toMatchObject({ rows: 100, skipped: true });
		expect(unusedFetch).not.toHaveBeenCalled();
	});

	it("skips when a full cache satisfies a later partial request", async () => {
		const cacheRoot = await tempCacheRoot();
		mockRowsFetch(300);

		const full = await fetchBenchmark(options({ cacheRoot }));
		expect(full).toMatchObject({ rows: 300, skipped: false });

		const unusedFetch = mockRowsFetch(1);
		const partial = await fetchBenchmark(options({ cacheRoot, maxRows: 1 }));

		expect(partial).toMatchObject({ rows: 300, skipped: true });
		expect(unusedFetch).not.toHaveBeenCalled();
	});

	it("refetches when the cached manifest schema is stale", async () => {
		const cacheRoot = await tempCacheRoot();
		mockRowsFetch(1);
		await fetchBenchmark(options({ cacheRoot, maxRows: 1 }));
		const manifestPath = join(
			cacheRoot,
			"datasets",
			"swe-bench-lite",
			"manifest.json",
		);
		const staleManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			schema_version: number;
		};
		await writeFile(
			manifestPath,
			`${JSON.stringify({ ...staleManifest, schema_version: 0 })}\n`,
			"utf8",
		);

		const refetch = mockRowsFetch(1);
		await expect(
			fetchBenchmark(options({ cacheRoot, maxRows: 1 })),
		).resolves.toMatchObject({ rows: 1, skipped: false });
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("refetches when cached content no longer matches manifest sha256", async () => {
		const cacheRoot = await tempCacheRoot();
		mockRowsFetch(1);
		await fetchBenchmark(options({ cacheRoot, maxRows: 1 }));
		await writeFile(
			join(cacheRoot, "datasets", "swe-bench-lite", "data.jsonl"),
			`${JSON.stringify(makeSweBenchRow(99))}\n`,
			"utf8",
		);

		const refetch = mockRowsFetch(1);
		await expect(
			fetchBenchmark(options({ cacheRoot, maxRows: 1 })),
		).resolves.toMatchObject({ rows: 1, skipped: false });
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("refetches when cached manifest row metadata is invalid", async () => {
		const cacheRoot = await tempCacheRoot();
		mockRowsFetch(1);
		await fetchBenchmark(options({ cacheRoot, maxRows: 1 }));
		const manifestPath = join(
			cacheRoot,
			"datasets",
			"swe-bench-lite",
			"manifest.json",
		);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			readonly rows: number;
		};
		await writeFile(
			manifestPath,
			`${JSON.stringify({ ...manifest, rows: -1 })}\n`,
			"utf8",
		);

		const refetch = mockRowsFetch(1);
		await expect(
			fetchBenchmark(options({ cacheRoot, maxRows: 1 })),
		).resolves.toMatchObject({ rows: 1, skipped: false });
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("rejects non-HuggingFace rows endpoints unless explicitly allowed", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockRowsFetch(1);

		await expect(
			fetchBenchmark(
				options({
					allowUnsafeRowsBaseUrl: false,
					cacheRoot,
					maxRows: 1,
					rowsBaseUrl: "http://127.0.0.1:9999/rows",
				}),
			),
		).rejects.toThrow(/Unsafe --rows-base-url rejected/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows local rows endpoints only behind the explicit unsafe test flag", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockRowsFetch(1);

		await expect(
			fetchBenchmark(
				options({
					allowUnsafeRowsBaseUrl: true,
					cacheRoot,
					maxRows: 1,
					rowsBaseUrl: "http://127.0.0.1:9999/rows",
				}),
			),
		).resolves.toMatchObject({ rows: 1, skipped: false });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stops fetching when the source returns fewer rows than requested", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockRowsFetch(2);

		await expect(
			fetchBenchmark(options({ cacheRoot, maxRows: 5 })),
		).resolves.toMatchObject({ rows: 2, skipped: false });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("accepts an empty rows payload as an empty source page", async () => {
		const cacheRoot = await tempCacheRoot();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => responseWithRowsPayload({})),
		);

		await expect(
			fetchBenchmark(options({ cacheRoot, maxRows: 5 })),
		).resolves.toMatchObject({ rows: 0, skipped: false });
	});

	it("retries transient fetch failures before accepting rows", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporary outage"))
			.mockResolvedValueOnce(responseWithRows([makeSweBenchRow(0)]));
		vi.stubGlobal("fetch", fetchMock);

		const resultPromise = fetchBenchmark(
			options({ cacheRoot, maxRows: 1, retries: 2 }),
		);

		await expect(resultPromise).resolves.toMatchObject({ rows: 1 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects exhausted fetch failures and invalid upstream rows", async () => {
		const firstCacheRoot = await tempCacheRoot();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						json: async () => ({}),
						ok: false,
						status: 503,
						statusText: "Unavailable",
					}) as Response,
			),
		);

		await expect(
			fetchBenchmark(options({ cacheRoot: firstCacheRoot, maxRows: 1 })),
		).rejects.toThrow(/503 Unavailable/);

		const secondCacheRoot = await tempCacheRoot();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				responseWithRows([{ ...makeSweBenchRow(0), patch: "" }]),
			),
		);
		await expect(
			fetchBenchmark(options({ cacheRoot: secondCacheRoot, maxRows: 1 })),
		).rejects.toThrow(/missing patch/);

		const thirdCacheRoot = await tempCacheRoot();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw "network down";
			}),
		);
		await expect(
			fetchBenchmark(options({ cacheRoot: thirdCacheRoot, maxRows: 1 })),
		).rejects.toThrow(/Failed to fetch benchmark rows/);
	});

	it("validates fetch option boundaries before network access", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockRowsFetch(1);

		await expect(
			fetchBenchmark(options({ cacheRoot, pageSize: 101 })),
		).rejects.toThrow(/--page-size/);
		await expect(
			fetchBenchmark(options({ cacheRoot, retries: 6 })),
		).rejects.toThrow(/--retries/);
		await expect(
			fetchBenchmark(
				options({ cacheRoot, dataset: "swe-bench-lite", maxRows: 301 }),
			),
		).rejects.toThrow(/--max-rows/);
		await expect(
			fetchBenchmark(options({ cacheRoot, dataset: "unknown" })),
		).rejects.toThrow(/Unsupported dataset/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("parses the verified alias and unsafe endpoint opt-in flag", () => {
		expect(
			parseArgs([
				"verified",
				"--max-rows",
				"10",
				"--allow-unsafe-rows-base-url",
			]),
		).toMatchObject({
			allowUnsafeRowsBaseUrl: true,
			dataset: "swe-bench-verified",
			maxRows: 10,
		});
	});

	it("parses all CLI options and rejects malformed arguments", () => {
		expect(
			parseArgs([
				"--dataset",
				"lite",
				"--cache-root",
				"/tmp/cache",
				"--page-size",
				"10",
				"--max-rows",
				"5",
				"--rows-base-url",
				defaultRowsBaseUrl,
				"--retries",
				"2",
				"--force",
			]),
		).toMatchObject({
			cacheRoot: "/tmp/cache",
			dataset: "swe-bench-lite",
			force: true,
			maxRows: 5,
			pageSize: 10,
			retries: 2,
		});
		expect(() => parseArgs(["lite", "verified"])).toThrow(
			/Unexpected positional argument/,
		);
		expect(() => parseArgs(["--cache-root"])).toThrow(/Missing value/);
		expect(() => parseArgs(["--max-rows", "1.5"])).toThrow(
			/must be a positive integer/,
		);
		expect(() => parseArgs(["--unknown", "value"])).toThrow(/Unknown argument/);
	});

	it("reads unsafe rows-base-url opt-in from the environment and prints main output", async () => {
		const cacheRoot = await tempCacheRoot();
		const previous = process.env.QUILIN_ALLOW_UNSAFE_BENCHMARK_ROWS_BASE_URL;
		process.env.QUILIN_ALLOW_UNSAFE_BENCHMARK_ROWS_BASE_URL = "1";
		const writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		mockRowsFetch(1);
		try {
			expect(parseArgs(["custom"]).dataset).toBe("custom");
			await expect(
				main([
					"lite",
					"--cache-root",
					cacheRoot,
					"--max-rows",
					"1",
					"--rows-base-url",
					"http://127.0.0.1:9999/rows",
				]),
			).resolves.toBeUndefined();
			expect(writeSpy).toHaveBeenCalledWith(
				expect.stringContaining('"rows": 1'),
			);
		} finally {
			if (previous === undefined) {
				delete process.env.QUILIN_ALLOW_UNSAFE_BENCHMARK_ROWS_BASE_URL;
			} else {
				process.env.QUILIN_ALLOW_UNSAFE_BENCHMARK_ROWS_BASE_URL = previous;
			}
			writeSpy.mockRestore();
		}
	});
});

function options(
	overrides: Partial<FetchBenchmarkOptions> & { readonly cacheRoot: string },
): FetchBenchmarkOptions {
	return {
		allowUnsafeRowsBaseUrl: overrides.allowUnsafeRowsBaseUrl ?? false,
		cacheRoot: overrides.cacheRoot,
		dataset: overrides.dataset ?? "swe-bench-lite",
		force: false,
		maxRows: overrides.maxRows,
		pageSize: overrides.pageSize ?? 100,
		retries: overrides.retries ?? 1,
		rowsBaseUrl: overrides.rowsBaseUrl ?? defaultRowsBaseUrl,
	};
}

async function tempCacheRoot(): Promise<string> {
	const cacheRoot = await mkdtemp(join(tmpdir(), "quilin-fetch-cache-"));
	tempRoots.push(cacheRoot);
	return cacheRoot;
}

function mockRowsFetch(totalRows: number): ReturnType<typeof vi.fn> {
	const rows = Array.from({ length: totalRows }, (_entry, index) =>
		makeSweBenchRow(index),
	);
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const offset = Number(url.searchParams.get("offset") ?? "0");
		const length = Number(url.searchParams.get("length") ?? "100");
		return responseWithRows(rows.slice(offset, offset + length));
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function responseWithRows(rows: readonly Record<string, unknown>[]): Response {
	return responseWithRowsPayload({
		rows: rows.map((row) => ({ row })),
	});
}

function responseWithRowsPayload(payload: DatasetServerRowsPayload): Response {
	return {
		json: async () => payload,
		ok: true,
		status: 200,
		statusText: "OK",
	} as Response;
}

interface DatasetServerRowsPayload {
	readonly rows?: readonly { readonly row?: Record<string, unknown> }[];
}

function makeSweBenchRow(index: number): Record<string, string> {
	return {
		base_commit: `commit-${index}`,
		instance_id: `repo__project-${index}`,
		patch: `diff --git a/file-${index}.py b/file-${index}.py\n+fix\n`,
		problem_statement: `Fix issue ${index}`,
		repo: "repo/project",
		test_patch: `diff --git a/test-${index}.py b/test-${index}.py\n+test\n`,
	};
}
