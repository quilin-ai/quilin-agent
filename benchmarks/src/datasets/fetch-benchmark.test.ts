import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
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

	it("fetches GAIA validation rows with an HF token without writing the token to manifest", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockGaiaRowsFetch(2);

		const result = await fetchBenchmark(
			options({
				cacheRoot,
				dataset: "gaia",
				hfToken: "hf_test_token",
				maxRows: 2,
			}),
		);
		const manifest = await readFile(
			join(cacheRoot, "datasets", "gaia", "manifest.json"),
			"utf8",
		);
		const parsedManifest = JSON.parse(manifest) as {
			readonly attachments: Record<
				string,
				{ readonly sha256: string; readonly size_bytes: number }
			>;
		};
		const attachment = await readFile(
			join(cacheRoot, "datasets", "gaia", "attachments", "attachment-1.pdf"),
			"utf8",
		);

		expect(result).toMatchObject({ rows: 2, skipped: false });
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("dataset=gaia-benchmark%2FGAIA"),
			{ headers: { Authorization: "Bearer hf_test_token" } },
		);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("config=2023_all"),
			expect.anything(),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("split=validation"),
			expect.anything(),
		);
		expect(manifest).not.toContain("hf_test_token");
		expect(manifest).toContain('"dataset": "gaia"');
		expect(manifest).toContain('"requested_max_rows": 2');
		expect(parsedManifest.attachments["attachment-1.pdf"]).toEqual({
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			size_bytes: Buffer.byteLength("gaia attachment fixture"),
		});
		expect(attachment).toBe("gaia attachment fixture");
	});

	it("refetches GAIA when manifest is valid but cached attachments are missing", async () => {
		const cacheRoot = await tempCacheRoot();
		mockGaiaRowsFetch(2);
		await fetchBenchmark(
			options({
				cacheRoot,
				dataset: "gaia",
				hfToken: "hf_test_token",
				maxRows: 2,
			}),
		);
		await rm(
			join(cacheRoot, "datasets", "gaia", "attachments", "attachment-1.pdf"),
			{ force: true },
		);

		const refetch = mockGaiaRowsFetch(2);
		await expect(
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 2,
				}),
			),
		).resolves.toMatchObject({ rows: 2, skipped: false });
		expect(refetch).toHaveBeenCalledWith(
			expect.stringContaining("/resolve/main/2023/validation/attachment-1.pdf"),
			{ headers: { Authorization: "Bearer hf_test_token" } },
		);
	});

	it("refetches GAIA when cached attachment content no longer matches manifest", async () => {
		const cacheRoot = await tempCacheRoot();
		mockGaiaRowsFetch(2);
		await fetchBenchmark(
			options({
				cacheRoot,
				dataset: "gaia",
				hfToken: "hf_test_token",
				maxRows: 2,
			}),
		);
		await writeFile(
			join(cacheRoot, "datasets", "gaia", "attachments", "attachment-1.pdf"),
			"tampered",
			"utf8",
		);

		const refetch = mockGaiaRowsFetch(2);
		await expect(
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 2,
				}),
			),
		).resolves.toMatchObject({ rows: 2, skipped: false });
		expect(refetch).toHaveBeenCalledWith(
			expect.stringContaining("/resolve/main/2023/validation/attachment-1.pdf"),
			{ headers: { Authorization: "Bearer hf_test_token" } },
		);
	});

	it("refetches GAIA legacy manifests that do not include attachment hashes", async () => {
		const cacheRoot = await tempCacheRoot();
		mockGaiaRowsFetch(2);
		await fetchBenchmark(
			options({
				cacheRoot,
				dataset: "gaia",
				hfToken: "hf_test_token",
				maxRows: 2,
			}),
		);
		const manifestPath = join(cacheRoot, "datasets", "gaia", "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			attachments?: unknown;
		};
		delete manifest.attachments;
		await writeFile(
			manifestPath,
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8",
		);

		const refetch = mockGaiaRowsFetch(2);
		await expect(
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 2,
				}),
			),
		).resolves.toMatchObject({ rows: 2, skipped: false });
		expect(refetch).toHaveBeenCalledWith(
			expect.stringContaining("/resolve/main/2023/validation/attachment-1.pdf"),
			{ headers: { Authorization: "Bearer hf_test_token" } },
		);
	});

	it("serializes concurrent fetches for the same dataset cache", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockGaiaRowsFetch(2);

		const results = await Promise.all([
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 2,
				}),
			),
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 2,
				}),
			),
		]);
		const datasetEntries = await readdir(join(cacheRoot, "datasets", "gaia"));

		expect(results.filter((result) => result.skipped)).toHaveLength(1);
		expect(results.filter((result) => !result.skipped)).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(datasetEntries).not.toContain(".fetch.lock");
	});

	it("removes stale fetch locks before writing a dataset cache", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		await mkdir(datasetDir, { recursive: true });
		await writeFile(join(datasetDir, ".fetch.lock"), "stale\n", "utf8");
		const staleTime = new Date(Date.now() - 11 * 60 * 1000);
		await utimes(join(datasetDir, ".fetch.lock"), staleTime, staleTime);
		const fetchMock = mockRowsFetch(1);

		await expect(
			fetchBenchmark(options({ cacheRoot, maxRows: 1 })),
		).resolves.toMatchObject({ rows: 1, skipped: false });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await expect(
			readFile(join(datasetDir, ".fetch.lock"), "utf8"),
		).rejects.toThrow();
	});

	it("cleans staged GAIA attachments when an attachment fetch fails", async () => {
		const cacheRoot = await tempCacheRoot();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/resolve/main/")) {
					return {
						arrayBuffer: async () => Buffer.from(""),
						json: async () => ({}),
						ok: false,
						status: 503,
						statusText: "Unavailable",
					} as unknown as Response;
				}
				return responseWithRows([makeGaiaRow(1)]);
			}),
		);

		await expect(
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 1,
				}),
			),
		).rejects.toThrow(/503 Unavailable/);
		await expect(
			readFile(
				join(cacheRoot, "datasets", "gaia", "attachments", "attachment-1.pdf"),
			),
		).rejects.toThrow();
	});

	it("requires HF_TOKEN only when an uncached GAIA fetch needs network access", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockGaiaRowsFetch(1);

		await expect(
			fetchBenchmark(options({ cacheRoot, dataset: "gaia", maxRows: 1 })),
		).rejects.toThrow(/HF_TOKEN is required/);
		expect(fetchMock).not.toHaveBeenCalled();

		const secondRoot = await tempCacheRoot();
		mockGaiaRowsFetch(1);
		await fetchBenchmark(
			options({
				cacheRoot: secondRoot,
				dataset: "gaia",
				hfToken: "hf_test_token",
				maxRows: 1,
			}),
		);
		const unusedFetch = mockGaiaRowsFetch(1);
		await expect(
			fetchBenchmark(
				options({ cacheRoot: secondRoot, dataset: "gaia", maxRows: 1 }),
			),
		).resolves.toMatchObject({ rows: 1, skipped: true });
		expect(unusedFetch).not.toHaveBeenCalled();
	});

	it("validates GAIA upstream row aliases before writing cache", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes("/resolve/main/")) {
				return responseWithText("source attachment");
			}
			return responseWithRows([
				{
					answer: false,
					file: "source.txt",
					id: "gaia-alias",
					level: "2",
					question: "Alias question?",
				},
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 1,
				}),
			),
		).resolves.toMatchObject({ rows: 1 });

		const data = await readFile(
			join(cacheRoot, "datasets", "gaia", "data.jsonl"),
			"utf8",
		);
		expect(data).toContain('"Final answer":"false"');
		expect(data).toContain('"file_name":"source.txt"');
		expect(data).toContain('"Level":2');
		await expect(
			readFile(
				join(cacheRoot, "datasets", "gaia", "attachments", "source.txt"),
				"utf8",
			),
		).resolves.toBe("source attachment");
	});

	it("rejects invalid GAIA upstream rows before cache write", async () => {
		const cacheRoot = await tempCacheRoot();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => responseWithRows([{}])),
		);

		await expect(
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 1,
				}),
			),
		).rejects.toThrow(/Invalid gaia row/);
	});

	it("rejects unsafe GAIA attachment names before writing cache", async () => {
		const cacheRoot = await tempCacheRoot();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				responseWithRows([{ ...makeGaiaRow(1), file_name: "../secret.txt" }]),
			),
		);

		await expect(
			fetchBenchmark(
				options({
					cacheRoot,
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 1,
				}),
			),
		).rejects.toThrow(/Unsafe GAIA attachment/);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				responseWithRows([
					{ ...makeGaiaRow(1), file_name: `${"a".repeat(256)}.pdf` },
				]),
			),
		);
		await expect(
			fetchBenchmark(
				options({
					cacheRoot: await tempCacheRoot(),
					dataset: "gaia",
					hfToken: "hf_test_token",
					maxRows: 1,
				}),
			),
		).rejects.toThrow(/Unsafe GAIA attachment/);
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

	it("parses the GAIA alias without exposing HF_TOKEN in CLI output", () => {
		const previous = process.env.HF_TOKEN;
		process.env.HF_TOKEN = "hf_env_token";
		try {
			expect(parseArgs(["GAIA", "--max-rows", "1"])).toMatchObject({
				dataset: "gaia",
				hfToken: "hf_env_token",
				maxRows: 1,
			});
		} finally {
			if (previous === undefined) {
				delete process.env.HF_TOKEN;
			} else {
				process.env.HF_TOKEN = previous;
			}
		}
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
		hfToken: overrides.hfToken,
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

function mockGaiaRowsFetch(totalRows: number): ReturnType<typeof vi.fn> {
	const rows = Array.from({ length: totalRows }, (_entry, index) =>
		makeGaiaRow(index),
	);
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		if (String(input).includes("/resolve/main/")) {
			return responseWithText("gaia attachment fixture");
		}
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
		arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
		json: async () => payload,
		ok: true,
		status: 200,
		statusText: "OK",
	} as unknown as Response;
}

function responseWithText(text: string): Response {
	return {
		arrayBuffer: async () => Buffer.from(text),
		json: async () => JSON.parse(text),
		ok: true,
		status: 200,
		statusText: "OK",
	} as unknown as Response;
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

function makeGaiaRow(index: number): Record<string, string | number | null> {
	return {
		"Final answer": index === 0 ? "Paris" : "42",
		Level: (index % 3) + 1,
		Question: `GAIA validation question ${index}`,
		file_name: index === 0 ? null : `attachment-${index}.pdf`,
		task_id: `gaia-validation-${index}`,
	};
}
