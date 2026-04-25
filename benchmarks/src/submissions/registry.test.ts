import { describe, expect, it } from "vitest";
import {
	defaultSubmissionAdapterRegistry,
	SubmissionAdapterRegistry,
	sweBenchVerifiedJsonlAdapter,
} from "./index.js";
import type { SubmissionAdapter } from "./types.js";
import { SubmissionAdapterRegistryError } from "./types.js";

const gaiaAdapter = {
	dataset: "gaia",
	format: "json",
	serialize: () => "{}",
	filename: (runId: string) => `gaia-${runId}.json`,
} satisfies SubmissionAdapter;

describe("SubmissionAdapterRegistry", () => {
	it("returns adapters by dataset", () => {
		const registry = new SubmissionAdapterRegistry([
			sweBenchVerifiedJsonlAdapter,
			gaiaAdapter,
		]);

		expect(registry.get("swe-bench-verified")).toBe(
			sweBenchVerifiedJsonlAdapter,
		);
		expect(registry.get("gaia")).toBe(gaiaAdapter);
	});

	it("registers adapters after construction", () => {
		const registry = new SubmissionAdapterRegistry();

		registry.register(sweBenchVerifiedJsonlAdapter);

		expect(registry.get("swe-bench-verified").format).toBe("jsonl");
	});

	it("throws for duplicate dataset registrations", () => {
		expect(
			() =>
				new SubmissionAdapterRegistry([
					sweBenchVerifiedJsonlAdapter,
					sweBenchVerifiedJsonlAdapter,
				]),
		).toThrow(SubmissionAdapterRegistryError);
	});

	it("throws for missing datasets", () => {
		const registry = new SubmissionAdapterRegistry();

		expect(() => registry.get("bfcl-v4")).toThrow(
			"No submission adapter registered for dataset: bfcl-v4",
		);
	});

	it("pre-registers the SWE-bench Verified adapter in the default registry", () => {
		expect(defaultSubmissionAdapterRegistry.get("swe-bench-verified")).toBe(
			sweBenchVerifiedJsonlAdapter,
		);
	});
});
