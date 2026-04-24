import { describe, expect, it } from "vitest";
import { capabilitiesConfigSchema } from "./schema.js";
import { CAPABILITIES_SCHEMA_VERSION } from "./types.js";

describe("capabilitiesConfigSchema", () => {
	it("round-trips JSON without changing the config shape", () => {
		const config = {
			schema_version: CAPABILITIES_SCHEMA_VERSION,
			mcpServers: {
				stub: {
					command: "node",
					args: ["stub-server.js"],
					cwd: ".",
					namespace: "stub",
					defaultRiskLevel: "read",
					env: {
						LOG_LEVEL: "debug",
					},
					timeoutMs: 30_000,
					connectTimeoutMs: 5_000,
					retryPolicy: {
						maxAttempts: 2,
						retryableExitCodes: [75],
					},
					backoff: {
						initialDelayMs: 100,
						maxDelayMs: 1_000,
						multiplier: 2,
					},
				},
			},
			skills: {
				enabled: true,
				projectRoots: ["./skills/project"],
				userRoots: ["./skills/user"],
				watcherEnabled: false,
				debounceMs: 125,
				reloadStrategy: "watch",
			},
			safety: {},
		};

		const parsed = capabilitiesConfigSchema.parse(
			JSON.parse(JSON.stringify(config)) as unknown,
		);

		expect(parsed).toEqual(config);
	});

	it("accepts schema version 2 as a migration placeholder", () => {
		const parsed = capabilitiesConfigSchema.parse({
			schema_version: 2,
			mcpServers: {},
			skills: {},
			safety: {},
		});

		expect(parsed.schema_version).toBe(2);
	});

	it("rejects unknown top-level fields", () => {
		expect(() =>
			capabilitiesConfigSchema.parse({
				schema_version: CAPABILITIES_SCHEMA_VERSION,
				mcpServers: {},
				skills: {},
				extra: true,
			}),
		).toThrow(/unrecognized key/i);
	});
});
