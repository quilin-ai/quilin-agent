import { describe, expect, it } from "vitest";
import {
	defaultSubmissionAdapterRegistry,
	gaiaJsonlAdapter,
	SubmissionAdapterRegistry,
	sweBenchVerifiedJsonlAdapter,
} from "./index.js";
import type { SubmissionAdapter } from "./types.js";
import { SubmissionAdapterRegistryError } from "./types.js";

const liteAdapter = {
	dataset: "swe-bench-lite",
	format: "json",
	serialize: () => "{}",
	filename: (runId: string) => `lite-${runId}.json`,
} satisfies SubmissionAdapter;

describe("SubmissionAdapterRegistry", () => {
	it("returns adapters by dataset", () => {
		const registry = new SubmissionAdapterRegistry([
			sweBenchVerifiedJsonlAdapter,
			liteAdapter,
		]);

		expect(registry.get("swe-bench-verified")).toBe(
			sweBenchVerifiedJsonlAdapter,
		);
		expect(registry.get("swe-bench-lite")).toBe(liteAdapter);
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

		expect(() => registry.get("swe-bench-lite")).toThrow(
			"No submission adapter registered for dataset: swe-bench-lite",
		);
	});

	it("pre-registers the SWE-bench Verified adapter in the default registry", () => {
		expect(defaultSubmissionAdapterRegistry.get("swe-bench-verified")).toBe(
			sweBenchVerifiedJsonlAdapter,
		);
	});

	it("pre-registers the GAIA adapter in the default registry", () => {
		expect(defaultSubmissionAdapterRegistry.get("gaia")).toBe(gaiaJsonlAdapter);
	});
});
