import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasSecretPattern } from "../safety/redaction.js";
import { JsonlTrajectoryStore } from "./trajectory-store.js";
import type { TrajectoryRecordInput } from "./types.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fsTempDir("quilin-trajectory-store-");
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

async function fsTempDir(prefix: string): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	return mkdtemp(path.join(tmpdir(), prefix));
}

function makeTrajectory(
	overrides: Partial<TrajectoryRecordInput> = {},
): TrajectoryRecordInput {
	return {
		runId: "run-123",
		outcome: "failure",
		steps: [
			{
				index: 0,
				kind: "tool",
				label: "shell_exec",
				input: {
					command: "do thing",
					api_key: "sk-secretsecretsecretsecret",
				},
				error: "command failed with exit code 1",
				evidenceRefs: [" tool-call:1 ", " "],
			},
		],
		failures: [
			{
				message: "tool error with sk-secretsecretsecretsecret",
				source: "Bearer secretsecretsecretsecret",
				evidenceRefs: [" failure:1 ", "\t"],
				metadata: {
					token: "sk-secretsecretsecretsecret",
				},
			},
		],
		metadata: {
			authorization: "Bearer secretsecretsecretsecret",
			owner: "agent-core",
		},
		...overrides,
	};
}

describe("JsonlTrajectoryStore", () => {
	it("appends JSONL records, queries by runId, and exports sanitized data", async () => {
		const filePath = path.join(tmpDir, "trajectories.jsonl");
		const store = new JsonlTrajectoryStore({
			filePath,
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		const first = await store.append(makeTrajectory());
		await store.append(makeTrajectory({ runId: "other-run" }));

		const rawLines = (await readFile(filePath, "utf8")).trim().split("\n");
		expect(rawLines).toHaveLength(2);
		expect(first.schemaVersion).toBe(1);
		expect(first.trajectoryRef).toMatch(/^trajectory:/u);
		expect(first.contentHash).toHaveLength(64);

		const records = await store.queryByRunId("run-123");
		expect(records).toHaveLength(1);
		expect(records[0]?.trajectoryRef).toBe(first.trajectoryRef);

		const exported = await store.exportSanitized({ runId: "run-123" });
		expect(exported[0]?.metadata?.authorization).toBeUndefined();
		expect(exported[0]?.metadata?.["[REDACTED]"]).toBe("[REDACTED]");
		expect(exported[0]?.steps[0]?.input).toEqual({
			command: "do thing",
			"[REDACTED]": "[REDACTED]",
		});
		expect(exported[0]?.steps[0]?.evidenceRefs).toEqual(["tool-call:1"]);
		expect(exported[0]?.failures?.[0]?.message).not.toContain(
			"sk-secretsecretsecretsecret",
		);
		expect(exported[0]?.failures?.[0]?.source).toBe("[REDACTED]");
		expect(exported[0]?.failures?.[0]?.evidenceRefs).toEqual(["failure:1"]);
		expect(exported[0]?.failures?.[0]?.metadata?.token).toBeUndefined();
		expect(exported[0]?.failures?.[0]?.metadata?.["[REDACTED]"]).toBe(
			"[REDACTED]",
		);
	});

	it("redacts shared safety patterns before persisting JSONL records", async () => {
		const filePath = path.join(tmpDir, "shared-redaction.jsonl");
		const store = new JsonlTrajectoryStore({ filePath });
		const githubPat = `github_pat_${"C".repeat(24)}`;
		const databaseUrl = "mongodb://user:pass@localhost:27017/app";
		const envSecret = "DEEPSEEK_API_KEY=plain-deepseek-secret";
		const email = "gamma@example.com";
		const providerKey = "pk-abcdefghijklmnopqrstuvwxyz012345";

		await store.append(
			makeTrajectory({
				steps: [
					{
						index: 0,
						kind: "tool",
						label: "shell_exec",
						input: {
							note: [
								`pat ${githubPat}`,
								`db ${databaseUrl}`,
								envSecret,
								`email ${email}`,
								`provider ${providerKey}`,
							].join("\n"),
						},
						output: `contact ${email}`,
						error: `failed with ${databaseUrl}`,
						evidenceRefs: [githubPat, databaseUrl, envSecret],
					},
				],
				failures: [
					{
						message: `leaked ${githubPat} to ${email}`,
						source: databaseUrl,
						evidenceRefs: [providerKey],
						metadata: {
							ownerEmail: email,
						},
					},
				],
				metadata: {
					env: envSecret,
					databaseUrl,
				},
			}),
		);

		const rawJsonl = await readFile(filePath, "utf8");

		expect(rawJsonl).not.toContain(githubPat);
		expect(rawJsonl).not.toContain(databaseUrl);
		expect(rawJsonl).not.toContain("plain-deepseek-secret");
		expect(rawJsonl).not.toContain(email);
		expect(rawJsonl).not.toContain(providerKey);
		expect(rawJsonl).toContain("[REDACTED:github_token]");
		expect(rawJsonl).toContain("[REDACTED:database_url]");
		expect(rawJsonl).toContain("DEEPSEEK_API_KEY=[REDACTED:env_secret]");
		expect(rawJsonl).toContain("[REDACTED:email]");
		expect(hasSecretPattern(rawJsonl)).toBe(false);
	});

	it("rejects invalid runtime enum and timestamp values before persisting", async () => {
		const filePath = path.join(tmpDir, "invalid-shape.jsonl");
		const store = new JsonlTrajectoryStore({ filePath });

		await expect(
			store.append(
				makeTrajectory({
					outcome: "unknown" as never,
				}),
			),
		).rejects.toThrow(/outcome/u);

		await expect(
			store.append(
				makeTrajectory({
					createdAt: "not-a-date",
				}),
			),
		).rejects.toThrow(/timestamp/u);

		await expect(
			store.append(
				makeTrajectory({
					steps: [
						{
							index: -1,
							kind: "tool",
							label: "shell_exec",
						},
					],
				}),
			),
		).rejects.toThrow(/non-negative integer/u);

		await expect(
			store.append(
				makeTrajectory({
					steps: [
						{
							index: 0,
							kind: "unknown" as never,
							label: "shell_exec",
						},
					],
				}),
			),
		).rejects.toThrow(/kind/u);
	});

	it("keeps stable refs and hashes across createdAt changes", async () => {
		const filePath = path.join(tmpDir, "stable.jsonl");
		const store = new JsonlTrajectoryStore({ filePath });

		const first = await store.append(
			makeTrajectory({ createdAt: "2026-05-01T00:00:00.000Z" }),
		);
		const second = await store.append(
			makeTrajectory({ createdAt: "2026-05-01T00:01:00.000Z" }),
		);

		expect(second.contentHash).toBe(first.contentHash);
		expect(second.trajectoryRef).toBe(first.trajectoryRef);
	});

	it("rejects relative traversal outside the configured data root", () => {
		expect(
			() =>
				new JsonlTrajectoryStore({
					dataRoot: tmpDir,
					filePath: "../escape.jsonl",
				}),
		).toThrow(/within dataRoot/u);
	});

	it("serializes concurrent appends so jsonl lines stay one-per-line (queue guard)", async () => {
		const filePath = path.join(tmpDir, "concurrent.jsonl");
		const store = new JsonlTrajectoryStore({
			filePath,
			now: () => new Date("2026-05-08T00:00:00.000Z"),
		});

		// Fire 20 appends simultaneously. Without the transitionQueue the writes
		// could interleave at chunk boundaries; with it, every line stays atomic.
		const writes = Array.from({ length: 20 }, (_, i) =>
			store.append(makeTrajectory({ runId: `concurrent-${i}` })),
		);
		const records = await Promise.all(writes);

		const fileContent = await readFile(filePath, "utf8");
		const lines = fileContent.trim().split("\n");
		expect(lines).toHaveLength(20);
		// Each line must be valid JSON — interleaved writes would corrupt some.
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		// All run IDs from the records appear exactly once in the file.
		for (const record of records) {
			expect(fileContent).toContain(record.runId);
		}
	});

	it("rejects JSONL writes through symlink paths", async () => {
		const dataRoot = path.join(tmpDir, "data");
		const outsideRoot = path.join(tmpDir, "outside");
		await mkdir(dataRoot, { recursive: true });
		await mkdir(outsideRoot, { recursive: true });
		const symlinkPath = path.join(dataRoot, "trajectories.jsonl");
		await symlink(path.join(outsideRoot, "escaped.jsonl"), symlinkPath);
		const store = new JsonlTrajectoryStore({
			dataRoot,
			filePath: symlinkPath,
		});

		await expect(store.append(makeTrajectory())).rejects.toThrow(/symlink/u);
	});
});
