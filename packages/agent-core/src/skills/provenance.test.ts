import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createSkillContentDigest,
	createSkillProvenanceReceipt,
	validateSkillProvenanceReceipt,
} from "./provenance.js";
import type { SkillDescriptor } from "./types.js";

const descriptor: SkillDescriptor = {
	name: "local-analysis",
	description: "Analyze local files without network access",
	path: "/repo/skills/local-analysis/SKILL.md",
	source: "user",
	frontmatter: {
		name: "local-analysis",
		description: "Analyze local files without network access",
		version: "0.4.0",
		userInvocable: true,
		disableModelInvocation: false,
		mandatory: false,
	},
};

describe("createSkillContentDigest", () => {
	it("computes a deterministic sha256 digest", () => {
		const content = "---\nname: local-analysis\n---\nBody\n";
		const expected = createHash("sha256").update(content).digest("hex");

		expect(createSkillContentDigest(content)).toEqual({
			algorithm: "sha256",
			value: expected,
		});
	});
});

describe("createSkillProvenanceReceipt", () => {
	it("records descriptor provenance and content size without implicit time", () => {
		const content = "skill body";
		const receipt = createSkillProvenanceReceipt({ descriptor, content });

		expect(receipt).toEqual({
			schemaVersion: "quilin.skill_provenance.v1",
			skillName: "local-analysis",
			skillVersion: "0.4.0",
			source: "user",
			path: "/repo/skills/local-analysis/SKILL.md",
			digest: createSkillContentDigest(content),
			sizeBytes: Buffer.byteLength(content),
			generatedAt: undefined,
		});
	});

	it("keeps an explicit generatedAt value when the caller supplies one", () => {
		const receipt = createSkillProvenanceReceipt({
			descriptor,
			content: "skill body",
			generatedAt: "2026-05-02T00:00:00.000Z",
		});

		expect(receipt.generatedAt).toBe("2026-05-02T00:00:00.000Z");
	});
});

describe("validateSkillProvenanceReceipt", () => {
	it("returns a clear failure when receipt identity does not match the descriptor", () => {
		const receipt = createSkillProvenanceReceipt({
			descriptor,
			content: "skill body",
		});

		expect(
			validateSkillProvenanceReceipt({
				descriptor,
				provenance: {
					...receipt,
					skillName: "other",
					path: "/other/SKILL.md",
				},
			}),
		).toEqual({
			ok: false,
			detail: expect.stringContaining(
				"Skill provenance receipt does not match descriptor",
			),
		});
	});
});
