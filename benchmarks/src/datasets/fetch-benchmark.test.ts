import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	open as openFile,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__privateForTests,
	type FetchBenchmarkOptions,
	type FetchResult,
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

	it("fetches BFCL v4 non-live/live rows from pinned raw GitHub data", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockBfclV4Fetch();

		const result = await fetchBenchmark(
			options({ cacheRoot, dataset: "bfcl-v4", maxRows: 3 }),
		);
		const manifest = await readFile(
			join(cacheRoot, "datasets", "bfcl-v4", "manifest.json"),
			"utf8",
		);
		const data = await readFile(
			join(cacheRoot, "datasets", "bfcl-v4", "data.jsonl"),
			"utf8",
		);

		expect(result).toMatchObject({ rows: 3, skipped: false });
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining(
				"raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735",
			),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining(
				"/data/possible_answer/BFCL_v4_simple_python.json",
			),
		);
		expect(manifest).toContain('"dataset": "bfcl-v4"');
		expect(manifest).toContain('"requested_max_rows": 3');
		expect(manifest).toContain("categories=non_live,live");
		expect(data).toContain('"category":"simple_python"');
		expect(data).toContain('"general_category":"non_live"');
		expect(data).toContain('"category":"simple_java"');
	});

	it("skips BFCL v4 refetch when the partial cache already satisfies the request", async () => {
		const cacheRoot = await tempCacheRoot();
		mockBfclV4Fetch();
		await fetchBenchmark(
			options({ cacheRoot, dataset: "bfcl-v4", maxRows: 3 }),
		);

		const unusedFetch = mockBfclV4Fetch();
		await expect(
			fetchBenchmark(options({ cacheRoot, dataset: "bfcl-v4", maxRows: 2 })),
		).resolves.toMatchObject({ rows: 3, skipped: true });
		expect(unusedFetch).not.toHaveBeenCalled();
	});

	it("skips a full BFCL v4 cache when it was fetched as a full slice", async () => {
		const cacheRoot = await tempCacheRoot();
		mockBfclV4Fetch();
		await expect(
			fetchBenchmark(options({ cacheRoot, dataset: "bfcl-v4" })),
		).resolves.toMatchObject({ rows: 3, skipped: false });

		const unusedFetch = mockBfclV4Fetch();
		await expect(
			fetchBenchmark(options({ cacheRoot, dataset: "bfcl-v4" })),
		).resolves.toMatchObject({ rows: 3, skipped: true });
		expect(unusedFetch).not.toHaveBeenCalled();
	});

	it("rejects invalid BFCL v4 raw JSONL before writing cache", async () => {
		const cacheRoot = await tempCacheRoot();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => responseWithText("{not-json}\n")),
		);

		await expect(
			fetchBenchmark(options({ cacheRoot, dataset: "bfcl-v4", maxRows: 1 })),
		).rejects.toThrow(/Invalid BFCL v4 JSONL/);
	});

	it("validates BFCL v4 private parser and raw URL guard edge cases", () => {
		const validUrl =
			"https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_simple_python.json";
		expect(
			__privateForTests.parseBfclV4Jsonl('{"id":"ok"}\n', validUrl),
		).toEqual([{ id: "ok" }]);
		expect(() => __privateForTests.parseBfclV4Jsonl("42\n", validUrl)).toThrow(
			/row is not an object/,
		);
		expect(() =>
			__privateForTests.validateBfclV4RawUrl(
				"https://example.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_simple_python.json",
			),
		).toThrow(/Unsafe BFCL v4 raw URL/);
		expect(() =>
			__privateForTests.validateBfclV4RawUrl(
				"https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/data/../secret.json",
			),
		).toThrow(/Unsafe BFCL v4 raw URL/);
	});

	it("validates BFCL v4 normalized row edge cases", () => {
		expect(() =>
			__privateForTests.validateBfclV4Row(
				{ ...makeBfclNormalizedRow(), id: "" },
				0,
			),
		).toThrow(/missing id/);
		expect(() =>
			__privateForTests.validateBfclV4Row(
				{ ...makeBfclNormalizedRow(), category: "unknown" },
				0,
			),
		).toThrow(/missing category/);
		expect(() =>
			__privateForTests.validateBfclV4Row(
				{ ...makeBfclNormalizedRow(), general_category: "live" },
				0,
			),
		).toThrow(/mismatch/);
		expect(() =>
			__privateForTests.validateBfclV4Row(
				{ ...makeBfclNormalizedRow(), function: {} },
				0,
			),
		).toThrow(/missing function definitions/);
		expect(() =>
			__privateForTests.validateBfclV4Row(
				{ ...makeBfclNormalizedRow(), question: undefined },
				0,
			),
		).toThrow(/missing question/);
		expect(
			__privateForTests.validateBfclV4Row(makeBfclNormalizedRow(), 0),
		).toMatchObject({ category: "simple_python" });
	});

	it("keeps source defaults and unsupported dataset errors explicit", () => {
		expect(__privateForTests.sourceConfigFor("gaia")).toBe("2023_all");
		expect(__privateForTests.sourceConfigFor("swe-bench-lite")).toBe("default");
		expect(__privateForTests.sourceSplitFor("gaia")).toBe("validation");
		expect(__privateForTests.sourceSplitFor("swe-bench-lite")).toBe("test");
		expect(() => __privateForTests.expectedRowsFor("unknown")).toThrow(
			/Unsupported dataset/,
		);
	});

	it("retries transient BFCL v4 raw fetch failures", async () => {
		const cacheRoot = await tempCacheRoot();
		const fetchMock = mockBfclV4Fetch();
		fetchMock.mockRejectedValueOnce(new Error("temporary raw outage"));

		await expect(
			fetchBenchmark(
				options({ cacheRoot, dataset: "bfcl-v4", maxRows: 1, retries: 2 }),
			),
		).resolves.toMatchObject({ rows: 1, skipped: false });
		expect(fetchMock).toHaveBeenCalledTimes(3);
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

	it("serializes cross-process fetches for the same dataset cache", async () => {
		const cacheRoot = await tempCacheRoot();
		const first = runFetchChild({ cacheRoot, delayMs: 250 });
		await delay(50);
		const second = runFetchChild({ cacheRoot, delayMs: 0 });

		const results = await Promise.all([first, second]);
		const datasetEntries = await readdir(
			join(cacheRoot, "datasets", "swe-bench-lite"),
		);

		expect(results.every((result) => result.ok)).toBe(true);
		expect(results.map((result) => result.result.skipped).sort()).toEqual([
			false,
			true,
		]);
		expect(results.reduce((sum, result) => sum + result.calls, 0)).toBe(1);
		expect(datasetEntries).not.toContain(".fetch.lock");
	});

	it("clears a crash-orphaned fetch lock whose pid is no longer alive", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		const lockWriter = await writeCrashOrphanLock(datasetDir);
		const fetchMock = mockRowsFetch(1);

		expect(lockWriter.exitCode).toBe(0);
		await expect(
			fetchBenchmark(options({ cacheRoot, maxRows: 1 })),
		).resolves.toMatchObject({ rows: 1, skipped: false });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await expect(
			readFile(join(datasetDir, ".fetch.lock"), "utf8"),
		).rejects.toThrow();
	});

	it("removes stale fetch locks before writing a dataset cache", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		await mkdir(datasetDir, { recursive: true });
		await writeFile(join(datasetDir, ".fetch.lock"), "stale\n", "utf8");
		const staleTime = new Date(Date.now() - 31 * 60 * 1000);
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

	it("keeps a live lock when the lock freshness is still within the stale threshold", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		const lockPath = join(datasetDir, ".fetch.lock");
		await mkdir(datasetDir, { recursive: true });
		await writeFile(
			lockPath,
			JSON.stringify({
				created_at: new Date().toISOString(),
				nonce: "live-lock",
				pid: process.pid,
			}),
			"utf8",
		);
		const staleTime = new Date(Date.now() - 31 * 60 * 1000);
		await utimes(lockPath, staleTime, staleTime);

		await expect(
			__privateForTests.removeStaleFetchLock(lockPath),
		).resolves.toBe(false);
		await expect(readFile(lockPath, "utf8")).resolves.toContain("live-lock");
	});

	it("removes a stale lock even when the stored pid now belongs to a live process", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		const lockPath = join(datasetDir, ".fetch.lock");
		const oldTime = new Date(Date.now() - 31 * 60 * 1000);
		await mkdir(datasetDir, { recursive: true });
		await writeFile(
			lockPath,
			JSON.stringify({
				created_at: oldTime.toISOString(),
				nonce: "recycled-pid-lock",
				pid: process.pid,
			}),
			"utf8",
		);
		await utimes(lockPath, oldTime, oldTime);

		await expect(
			__privateForTests.removeStaleFetchLock(lockPath),
		).resolves.toBe(true);
		await expect(readFile(lockPath, "utf8")).rejects.toThrow();
	});

	it("removes only the lock matching the owner nonce", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		const lockPath = join(datasetDir, ".fetch.lock");
		const owner = {
			created_at: new Date().toISOString(),
			nonce: "owner-lock",
			pid: process.pid,
		};
		const replacement = {
			created_at: new Date().toISOString(),
			nonce: "replacement-lock",
			pid: process.pid,
		};
		await mkdir(datasetDir, { recursive: true });
		await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, "utf8");

		await expect(
			__privateForTests.releaseFetchLock(lockPath, owner),
		).resolves.toBe(false);
		await expect(readFile(lockPath, "utf8")).resolves.toContain(
			"replacement-lock",
		);

		await expect(
			__privateForTests.releaseFetchLock(lockPath, replacement),
		).resolves.toBe(true);
		await expect(readFile(lockPath, "utf8")).rejects.toThrow();
	});

	it("heartbeats only the matching lock owner", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		const lockPath = join(datasetDir, ".fetch.lock");
		const owner = {
			created_at: new Date().toISOString(),
			nonce: "heartbeat-lock",
			pid: process.pid,
		};
		await mkdir(datasetDir, { recursive: true });
		await writeFile(lockPath, `${JSON.stringify(owner)}\n`, "utf8");
		const oldTime = new Date(Date.now() - 60_000);
		await utimes(lockPath, oldTime, oldTime);

		await __privateForTests.refreshFetchLock(lockPath, {
			...owner,
			nonce: "wrong-lock",
		});
		const unchanged = await stat(lockPath);
		expect(unchanged.mtimeMs).toBeLessThan(Date.now() - 10_000);

		await __privateForTests.refreshFetchLock(lockPath, owner);
		const refreshed = await stat(lockPath);
		expect(refreshed.mtimeMs).toBeGreaterThan(unchanged.mtimeMs);
	});

	it("parses fetch lock bodies defensively", () => {
		expect(
			__privateForTests.parseFetchLockBody(
				JSON.stringify({
					created_at: "2026-04-26T00:00:00.000Z",
					nonce: "ok",
					pid: 123,
				}),
			),
		).toEqual({
			created_at: "2026-04-26T00:00:00.000Z",
			nonce: "ok",
			pid: 123,
		});
		expect(__privateForTests.parseFetchLockBody("{")).toBeUndefined();
		expect(
			__privateForTests.parseFetchLockBody(
				JSON.stringify({ created_at: "x", nonce: "", pid: 1 }),
			),
		).toBeUndefined();
		expect(
			__privateForTests.parseFetchLockBody(
				JSON.stringify({ created_at: "x", nonce: "x", pid: -1 }),
			),
		).toBeUndefined();
		expect(
			__privateForTests.parseFetchLockBody(
				JSON.stringify({ created_at: 1, nonce: "x", pid: 1 }),
			),
		).toBeUndefined();
		expect(
			__privateForTests.parseFetchLockBody(
				JSON.stringify({ created_at: "not-a-date", nonce: "x", pid: 1 }),
			),
		).toBeUndefined();
		expect(
			__privateForTests.parseFetchLockBody(
				JSON.stringify({ created_at: "x", nonce: "x" }),
			),
		).toBeUndefined();
		expect(__privateForTests.parseFetchLockBody("null")).toBeUndefined();
	});

	it("handles missing and invalid fresh fetch locks without unsafe cleanup", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		const lockPath = join(datasetDir, ".fetch.lock");
		await mkdir(datasetDir, { recursive: true });

		await expect(
			__privateForTests.removeStaleFetchLock(lockPath),
		).resolves.toBe(true);

		await writeFile(lockPath, "not-json\n", "utf8");
		await expect(
			__privateForTests.removeStaleFetchLock(lockPath),
		).resolves.toBe(false);
		await expect(readFile(lockPath, "utf8")).resolves.toBe("not-json\n");
		await expect(
			__privateForTests.fetchLockMatches(lockPath, {
				created_at: new Date().toISOString(),
				nonce: "missing-lock",
				pid: process.pid,
			}),
		).resolves.toBe(false);
	});

	it("propagates non-missing fetch lock read errors", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		const owner = {
			created_at: new Date().toISOString(),
			nonce: "directory-lock",
			pid: process.pid,
		};
		await mkdir(datasetDir, { recursive: true });

		await expect(
			__privateForTests.fetchLockMatches(datasetDir, owner),
		).rejects.toThrow();
	});

	it("fails loudly on Windows instead of relying on unsupported pid liveness semantics", async () => {
		const cacheRoot = await tempCacheRoot();
		const restorePlatform = stubProcessPlatform("win32");
		const fetchMock = mockRowsFetch(1);
		try {
			await expect(
				fetchBenchmark(options({ cacheRoot, maxRows: 1 })),
			).rejects.toThrow(/lockfile is not supported on Windows/);
		} finally {
			restorePlatform();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("cleans up an empty lockfile if writing the lock owner fails", async () => {
		const cacheRoot = await tempCacheRoot();
		const datasetDir = join(cacheRoot, "datasets", "swe-bench-lite");
		const lockPath = join(datasetDir, ".fetch.lock");
		const probePath = join(cacheRoot, "probe.lock");
		const probe = await openFile(probePath, "w");
		const fileHandlePrototype = Object.getPrototypeOf(probe) as {
			writeFile: typeof probe.writeFile;
		};
		await probe.close();
		const writeSpy = vi
			.spyOn(fileHandlePrototype, "writeFile")
			.mockRejectedValueOnce(new Error("simulated lock write failure"));
		const fetchMock = mockRowsFetch(1);
		try {
			await expect(
				fetchBenchmark(options({ cacheRoot, maxRows: 1 })),
			).rejects.toThrow(/simulated lock write failure/);
		} finally {
			writeSpy.mockRestore();
		}
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(readFile(lockPath, "utf8")).rejects.toThrow();
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

	it("parses BFCL aliases without requiring HF_TOKEN", () => {
		expect(parseArgs(["BFCL", "--max-rows", "5"])).toMatchObject({
			dataset: "bfcl-v4",
			hfToken: undefined,
			maxRows: 5,
		});
		expect(parseArgs(["bfcl"])).toMatchObject({ dataset: "bfcl-v4" });
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function mockBfclV4Fetch(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/data/possible_answer/BFCL_v4_simple_python.json")) {
			return responseWithText(
				`${JSON.stringify({
					ground_truth: [
						{ calculate_triangle_area: { base: [10], height: [5] } },
					],
					id: "simple_python_0",
				})}\n${JSON.stringify({
					ground_truth: [{ math_factorial: { number: [5] } }],
					id: "simple_python_1",
				})}\n`,
			);
		}
		if (url.includes("/data/BFCL_v4_simple_python.json")) {
			return responseWithText(
				`${JSON.stringify(makeBfclPromptRow("simple_python_0", "calculate_triangle_area"))}\n${JSON.stringify(makeBfclPromptRow("simple_python_1", "math_factorial"))}\n`,
			);
		}
		if (url.includes("/data/possible_answer/BFCL_v4_simple_java.json")) {
			return responseWithText(
				`${JSON.stringify({
					ground_truth: [{ java_factorial: { number: [5] } }],
					id: "simple_java_0",
				})}\n`,
			);
		}
		if (url.includes("/data/BFCL_v4_simple_java.json")) {
			return responseWithText(
				`${JSON.stringify(makeBfclPromptRow("simple_java_0", "java_factorial"))}\n`,
			);
		}
		return responseWithText("");
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function makeBfclPromptRow(
	id: string,
	functionName: string,
): Record<string, unknown> {
	return {
		function: [
			{
				name: functionName,
				parameters: {
					properties: { number: { type: "integer" } },
					required: ["number"],
					type: "dict",
				},
			},
		],
		id,
		question: [[{ content: `Call ${functionName}`, role: "user" }]],
	};
}

function makeBfclNormalizedRow(): Record<string, unknown> {
	return {
		category: "simple_python",
		function: [
			{
				name: "calculate_triangle_area",
				parameters: {
					properties: { base: { type: "integer" } },
					required: ["base"],
					type: "dict",
				},
			},
		],
		general_category: "non_live",
		ground_truth: [{ calculate_triangle_area: { base: [10] } }],
		id: "simple_python_0",
		question: [[{ content: "Find area", role: "user" }]],
	};
}

function runFetchChild(input: {
	readonly cacheRoot: string;
	readonly delayMs: number;
}): Promise<ChildFetchResult> {
	const script = `
import { fetchBenchmark } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts", "fetch-benchmark.ts")).href)};

const cacheRoot = process.env.CACHE_ROOT;
const delayMs = Number(process.env.FETCH_DELAY_MS ?? "0");
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return {
    arrayBuffer: async () => Buffer.from("{}"),
    json: async () => ({
      rows: [
        {
          row: {
            base_commit: "commit-child",
            instance_id: "repo__project-child",
            patch: "diff --git a/file.py b/file.py\\\\n+fix\\\\n",
            problem_statement: "Fix child issue",
            repo: "repo/project",
            test_patch: "diff --git a/test.py b/test.py\\\\n+test\\\\n"
          }
        }
      ]
    }),
    ok: true,
    status: 200,
    statusText: "OK"
  };
};
try {
  const result = await fetchBenchmark({
    allowUnsafeRowsBaseUrl: false,
    cacheRoot,
    dataset: "swe-bench-lite",
    force: false,
    maxRows: 1,
    pageSize: 100,
    retries: 1,
    rowsBaseUrl: ${JSON.stringify(defaultRowsBaseUrl)}
  });
  console.log(JSON.stringify({ calls, ok: true, pid: process.pid, result }));
} catch (error) {
  console.log(JSON.stringify({
    calls,
    error: error instanceof Error ? error.message : String(error),
    ok: false,
    pid: process.pid
  }));
  process.exitCode = 1;
}
`;
	return runNodeModule(script, {
		CACHE_ROOT: input.cacheRoot,
		FETCH_DELAY_MS: String(input.delayMs),
	});
}

function writeCrashOrphanLock(datasetDir: string): Promise<ChildProcessResult> {
	const script = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const datasetDir = process.env.DATASET_DIR;
await mkdir(datasetDir, { recursive: true });
await writeFile(
  join(datasetDir, ".fetch.lock"),
  JSON.stringify({
    created_at: new Date().toISOString(),
    nonce: "orphan-lock",
    pid: process.pid
  }) + "\\n",
  "utf8"
);
console.log(JSON.stringify({ ok: true, pid: process.pid }));
`;
	return runNodeModule(script, { DATASET_DIR: datasetDir });
}

function runNodeModule<T extends ChildProcessResult>(
	script: string,
	env: Record<string, string>,
): Promise<T> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", script],
			{
				cwd: process.cwd(),
				env: { ...process.env, ...env },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (exitCode) => {
			const line = stdout.trim().split(/\r?\n/).at(-1) ?? "{}";
			resolve({ ...JSON.parse(line), exitCode, stderr } as T);
		});
	});
}

function stubProcessPlatform(platform: NodeJS.Platform): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
	return () => {
		if (descriptor == null) {
			return;
		}
		Object.defineProperty(process, "platform", descriptor);
	};
}

interface ChildProcessResult {
	readonly exitCode: number | null;
	readonly ok: boolean;
	readonly pid: number;
	readonly stderr: string;
}

interface ChildFetchResult extends ChildProcessResult {
	readonly calls: number;
	readonly result: FetchResult;
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
		text: async () => text,
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
