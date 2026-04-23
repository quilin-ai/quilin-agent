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
				},
			},
			skills: {
				enabled: true,
				projectRoots: ["./skills/project"],
				userRoots: ["./skills/user"],
				watcherEnabled: false,
				debounceMs: 125,
			},
		};

		const parsed = capabilitiesConfigSchema.parse(
			JSON.parse(JSON.stringify(config)) as unknown,
		);

		expect(parsed).toEqual(config);
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
