import { describe, expect, it } from "vitest";
import {
	type SkillManifestCatalogHealthInput as PublicSkillManifestCatalogHealthInput,
	type SkillManifestCatalogHealthSummary as PublicSkillManifestCatalogHealthSummary,
	type SkillManifestHealthInput as PublicSkillManifestHealthInput,
	type SkillManifestHealthSummary as PublicSkillManifestHealthSummary,
	summarizeSkillManifestCatalogHealth as summarizeSkillManifestCatalogHealthFromIndex,
	summarizeSkillManifestHealth as summarizeSkillManifestHealthFromIndex,
} from "../index.js";
import {
	buildSkillManifest,
	type SkillManifestCatalogHealthSummary,
	type SkillManifestCatalogRawHealthInput,
	type SkillManifestHealthInput,
	type SkillManifestHealthSummary,
	summarizeSkillManifestCatalogHealth,
	summarizeSkillManifestCatalogHealthInputs,
	summarizeSkillManifestCatalogReadiness,
	summarizeSkillManifestCatalogReadinessInputs,
	summarizeSkillManifestHealth,
} from "./manifest.js";
import {
	createSkillContentDigest,
	createSkillProvenanceReceipt,
} from "./provenance.js";
import type { SkillDescriptor } from "./types.js";

const descriptor: SkillDescriptor = {
	name: "web-research",
	description: "Research public web pages and summarize findings",
	path: "/repo/skills/web-research/SKILL.md",
	source: "project",
	frontmatter: {
		name: "web-research",
		description: "Research public web pages and summarize findings",
		whenToUse: "Use when the user asks for public web research",
		allowedTools: ["web_fetch"],
		requiresTools: ["web_fetch"],
		requiresToolsets: ["browser"],
		platforms: ["linux"],
		version: "1.2.3",
		dependencies: {
			skills: ["summarize-page"],
			tools: ["web_fetch"],
			toolsets: ["browser"],
			packages: ["zod"],
		},
		userInvocable: true,
		disableModelInvocation: false,
		mandatory: false,
		trust: "trusted",
	},
};

describe("buildSkillManifest", () => {
	it("normalizes descriptor fields into a manifest with invocation and dependency metadata", () => {
		const manifest = buildSkillManifest({ descriptor });

		expect(manifest).toEqual({
			schemaVersion: "quilin.skill_manifest.v1",
			name: "web-research",
			description: "Research public web pages and summarize findings",
			version: "1.2.3",
			source: "project",
			path: "/repo/skills/web-research/SKILL.md",
			trust: "trusted",
			invocation: {
				userInvocable: true,
				modelInvocable: true,
				mandatory: false,
				whenToUse: "Use when the user asks for public web research",
			},
			tools: {
				allowed: ["web_fetch"],
				required: ["web_fetch"],
				requiredToolsets: ["browser"],
			},
			platforms: ["linux"],
			dependencies: {
				skills: ["summarize-page"],
				tools: ["web_fetch"],
				toolsets: ["browser"],
				packages: ["zod"],
			},
			provenance: undefined,
		});
	});

	it("attaches an optional provenance receipt without changing the digest", () => {
		const content = "---\nname: web-research\n---\n# Web Research";
		const provenance = createSkillProvenanceReceipt({ descriptor, content });

		const manifest = buildSkillManifest({ descriptor, provenance, content });

		expect(manifest.provenance).toBe(provenance);
		expect(manifest.provenance?.digest).toEqual(
			createSkillContentDigest(content),
		);
	});

	it("requires content when attaching provenance to a manifest", () => {
		const content = "---\nname: web-research\n---\n# Web Research";
		const provenance = createSkillProvenanceReceipt({ descriptor, content });

		expect(() => buildSkillManifest({ descriptor, provenance })).toThrow(
			"Skill provenance content is required",
		);
	});

	it("rejects provenance that does not match descriptor identity, path, source, or version", () => {
		const content = "---\nname: web-research\n---\n# Web Research";
		const provenance = {
			schemaVersion: "quilin.skill_provenance.v1" as const,
			skillName: "other-skill",
			skillVersion: "9.9.9",
			source: "bundled" as const,
			path: "/other/SKILL.md",
			digest: {
				algorithm: "sha256" as const,
				value: "b".repeat(64),
			},
			sizeBytes: 128,
		};

		expect(() =>
			buildSkillManifest({ descriptor, provenance, content }),
		).toThrow("Skill provenance receipt does not match descriptor");
		expect(() =>
			buildSkillManifest({ descriptor, provenance, content }),
		).toThrow("skillName expected web-research");
		expect(() =>
			buildSkillManifest({ descriptor, provenance, content }),
		).toThrow("skillVersion expected 1.2.3");
		expect(() =>
			buildSkillManifest({ descriptor, provenance, content }),
		).toThrow("source expected project");
		expect(() =>
			buildSkillManifest({ descriptor, provenance, content }),
		).toThrow("path expected /repo/skills/web-research/SKILL.md");
	});
});

describe("summarizeSkillManifestCatalogHealth", () => {
	it("is importable from the package public boundary with its public types", () => {
		const healthySummary = summarizeSkillManifestHealth(
			buildSkillManifest({ descriptor }),
		);
		const catalogInput: PublicSkillManifestCatalogHealthInput = {
			skillName: "web-research",
			summary: healthySummary,
		};
		const summary: PublicSkillManifestCatalogHealthSummary =
			summarizeSkillManifestCatalogHealthFromIndex([catalogInput]);

		expect(summary).toEqual(
			summarizeSkillManifestCatalogHealth([catalogInput]),
		);
	});

	it("reports an empty catalog summary", () => {
		expect(summarizeSkillManifestCatalogHealth([])).toEqual({
			total: 0,
			byStatus: {
				healthy: 0,
				warning: 0,
				critical: 0,
			},
			riskCodes: [],
			missingFields: [],
			unhealthySkillNames: [],
		});
	});

	it("counts an all-healthy catalog without catalog risks", () => {
		const healthySummary = summarizeSkillManifestHealth(
			buildSkillManifest({ descriptor }),
		);

		expect(
			summarizeSkillManifestCatalogHealth([
				{ skillName: "zeta-skill", summary: healthySummary },
				{ skillName: "alpha-skill", summary: healthySummary },
			]),
		).toEqual({
			total: 2,
			byStatus: {
				healthy: 2,
				warning: 0,
				critical: 0,
			},
			riskCodes: [],
			missingFields: [],
			unhealthySkillNames: [],
		});
	});

	it("aggregates mixed degraded and unhealthy manifest summaries", () => {
		const manifest = buildSkillManifest({ descriptor });
		const degradedSummary = summarizeSkillManifestHealth({
			...manifest,
			path: "/repo/skills/web-research/README.md",
		});
		const unhealthySummary = summarizeSkillManifestHealth({
			schemaVersion: "quilin.skill_manifest.v0",
			description: "Incomplete manifest",
			source: "project",
			path: "SKILL.md",
			invocation: {
				userInvocable: false,
			},
			tools: {},
		});

		expect(
			summarizeSkillManifestCatalogHealth([
				{ skillName: "unhealthy-skill", summary: unhealthySummary },
				{ skillName: "degraded-skill", summary: degradedSummary },
			]),
		).toEqual({
			total: 2,
			byStatus: {
				healthy: 0,
				warning: 1,
				critical: 1,
			},
			riskCodes: [
				{ code: "invalid_schema_version", count: 1 },
				{ code: "missing_required_fields", count: 1 },
				{ code: "path_not_skill_markdown", count: 1 },
			],
			missingFields: [
				{ field: "invocation.mandatory", count: 1 },
				{ field: "invocation.modelInvocable", count: 1 },
				{ field: "name", count: 1 },
			],
			unhealthySkillNames: ["degraded-skill", "unhealthy-skill"],
		});
	});

	it("sorts catalog issue counts and unhealthy names independently of input order", () => {
		const alphaSummary: SkillManifestHealthSummary = {
			status: "critical",
			missingFields: ["zeta", "alpha"],
			riskCodes: ["path_traversal", "missing_required_fields"],
			capabilityHints: [],
		};
		const betaSummary: SkillManifestHealthSummary = {
			status: "warning",
			missingFields: ["alpha"],
			riskCodes: ["missing_required_fields", "description_too_long"],
			capabilityHints: [],
		};

		const firstSummary = summarizeSkillManifestCatalogHealth([
			{ skillName: "beta-skill", summary: betaSummary },
			{ skillName: "alpha-skill", summary: alphaSummary },
		]);
		const secondSummary = summarizeSkillManifestCatalogHealth([
			{ skillName: "alpha-skill", summary: alphaSummary },
			{ skillName: "beta-skill", summary: betaSummary },
		]);

		expect(firstSummary).toEqual(secondSummary);
		expect(firstSummary.riskCodes).toEqual([
			{ code: "description_too_long", count: 1 },
			{ code: "missing_required_fields", count: 2 },
			{ code: "path_traversal", count: 1 },
		]);
		expect(firstSummary.missingFields).toEqual([
			{ field: "alpha", count: 2 },
			{ field: "zeta", count: 1 },
		]);
		expect(firstSummary.unhealthySkillNames).toEqual([
			"alpha-skill",
			"beta-skill",
		]);
	});
});

describe("summarizeSkillManifestCatalogReadiness", () => {
	it("reports empty readiness for an empty catalog", () => {
		expect(summarizeSkillManifestCatalogReadiness(catalogSummary())).toEqual({
			status: "empty",
			total: 0,
			warningCount: 0,
			criticalCount: 0,
			unhealthySkillNames: [],
		});
	});

	it("reports healthy readiness when the catalog has no warnings or criticals", () => {
		expect(
			summarizeSkillManifestCatalogReadiness(
				catalogSummary({
					total: 2,
					byStatus: {
						healthy: 2,
						warning: 0,
						critical: 0,
					},
				}),
			),
		).toEqual({
			status: "healthy",
			total: 2,
			warningCount: 0,
			criticalCount: 0,
			unhealthySkillNames: [],
		});
	});

	it("reports warning readiness when warnings exist without criticals", () => {
		expect(
			summarizeSkillManifestCatalogReadiness(
				catalogSummary({
					total: 3,
					byStatus: {
						healthy: 1,
						warning: 2,
						critical: 0,
					},
					unhealthySkillNames: ["warning-skill"],
				}),
			),
		).toEqual({
			status: "warning",
			total: 3,
			warningCount: 2,
			criticalCount: 0,
			unhealthySkillNames: ["warning-skill"],
		});
	});

	it("reports critical readiness when any critical manifest exists", () => {
		expect(
			summarizeSkillManifestCatalogReadiness(
				catalogSummary({
					total: 4,
					byStatus: {
						healthy: 1,
						warning: 2,
						critical: 1,
					},
					unhealthySkillNames: ["zeta-skill", " alpha-skill ", "warning-skill"],
				}),
			),
		).toEqual({
			status: "critical",
			total: 4,
			warningCount: 2,
			criticalCount: 1,
			unhealthySkillNames: ["alpha-skill", "warning-skill", "zeta-skill"],
		});
	});

	it("keeps readiness unhealthy names stable regardless of input order", () => {
		const firstSummary = summarizeSkillManifestCatalogReadiness(
			catalogSummary({
				total: 3,
				byStatus: {
					healthy: 0,
					warning: 2,
					critical: 1,
				},
				unhealthySkillNames: ["zeta-skill", "alpha-skill", "alpha-skill"],
			}),
		);
		const secondSummary = summarizeSkillManifestCatalogReadiness(
			catalogSummary({
				total: 3,
				byStatus: {
					healthy: 0,
					warning: 2,
					critical: 1,
				},
				unhealthySkillNames: ["alpha-skill", "zeta-skill"],
			}),
		);

		expect(firstSummary).toEqual(secondSummary);
		expect(firstSummary.unhealthySkillNames).toEqual([
			"alpha-skill",
			"zeta-skill",
		]);
	});
});

describe("summarizeSkillManifestCatalogHealthInputs", () => {
	it("matches the existing catalog summary when callers pass raw manifest health inputs", () => {
		const manifest = buildSkillManifest({ descriptor });
		const inputs: readonly SkillManifestCatalogRawHealthInput[] = [
			{ skillName: "healthy-skill", manifest },
			{
				skillName: "warning-skill",
				manifest: {
					...manifest,
					path: "/repo/skills/web-research/README.md",
				},
			},
			{
				skillName: "critical-skill",
				manifest: {
					schemaVersion: "quilin.skill_manifest.v0",
					description: "Incomplete manifest",
					source: "project",
					path: "SKILL.md",
					invocation: {
						userInvocable: false,
					},
					tools: {},
				},
			},
		];

		expect(summarizeSkillManifestCatalogHealthInputs(inputs)).toEqual(
			summarizeSkillManifestCatalogHealth(
				inputs.map((input) => ({
					skillName: input.skillName,
					summary: summarizeSkillManifestHealth(input.manifest),
				})),
			),
		);
	});

	it("reports an empty catalog summary for empty raw manifest health inputs", () => {
		expect(summarizeSkillManifestCatalogHealthInputs([])).toEqual({
			total: 0,
			byStatus: {
				healthy: 0,
				warning: 0,
				critical: 0,
			},
			riskCodes: [],
			missingFields: [],
			unhealthySkillNames: [],
		});
	});

	it("keeps catalog ordering deterministic regardless of raw input order", () => {
		const manifest = buildSkillManifest({ descriptor });
		const alphaInput: SkillManifestCatalogRawHealthInput = {
			skillName: "alpha-skill",
			manifest: {
				...manifest,
				path: "/repo/skills/web-research/README.md",
			},
		};
		const betaInput: SkillManifestCatalogRawHealthInput = {
			skillName: "beta-skill",
			manifest: {
				...manifest,
				name: "",
				invocation: {
					userInvocable: false,
				},
			},
		};

		const firstSummary = summarizeSkillManifestCatalogHealthInputs([
			betaInput,
			alphaInput,
		]);
		const secondSummary = summarizeSkillManifestCatalogHealthInputs([
			alphaInput,
			betaInput,
		]);

		expect(firstSummary).toEqual(secondSummary);
		expect(firstSummary.riskCodes).toEqual([
			{ code: "missing_required_fields", count: 1 },
			{ code: "path_not_skill_markdown", count: 1 },
		]);
		expect(firstSummary.missingFields).toEqual([
			{ field: "invocation.mandatory", count: 1 },
			{ field: "invocation.modelInvocable", count: 1 },
			{ field: "name", count: 1 },
		]);
		expect(firstSummary.unhealthySkillNames).toEqual([
			"alpha-skill",
			"beta-skill",
		]);
	});

	it("reports only computed unhealthy names from raw manifest health inputs", () => {
		const manifest = buildSkillManifest({ descriptor });

		expect(
			summarizeSkillManifestCatalogHealthInputs([
				{ skillName: "healthy-skill", manifest },
				{
					skillName: " zeta-skill ",
					manifest: {
						...manifest,
						path: "/repo/skills/web-research/README.md",
					},
				},
				{
					skillName: " alpha-skill ",
					manifest: {
						...manifest,
						schemaVersion: "quilin.skill_manifest.v0",
					},
				},
				{
					skillName: "   ",
					manifest: {
						...manifest,
						path: "/repo/skills/web-research/README.md",
					},
				},
			]).unhealthySkillNames,
		).toEqual(["alpha-skill", "zeta-skill"]);
	});
});

describe("summarizeSkillManifestCatalogReadinessInputs", () => {
	it("reports empty readiness for empty raw manifest health inputs", () => {
		expect(summarizeSkillManifestCatalogReadinessInputs([])).toEqual({
			status: "empty",
			total: 0,
			warningCount: 0,
			criticalCount: 0,
			unhealthySkillNames: [],
		});
	});

	it("reports healthy readiness for all-healthy raw manifest health inputs", () => {
		const manifest = buildSkillManifest({ descriptor });

		expect(
			summarizeSkillManifestCatalogReadinessInputs([
				{ skillName: "zeta-skill", manifest },
				{ skillName: "alpha-skill", manifest },
			]),
		).toEqual({
			status: "healthy",
			total: 2,
			warningCount: 0,
			criticalCount: 0,
			unhealthySkillNames: [],
		});
	});

	it("reports critical readiness for mixed warning and critical raw manifest health inputs", () => {
		const manifest = buildSkillManifest({ descriptor });

		expect(
			summarizeSkillManifestCatalogReadinessInputs([
				{ skillName: "healthy-skill", manifest },
				{
					skillName: "warning-skill",
					manifest: {
						...manifest,
						path: "/repo/skills/web-research/README.md",
					},
				},
				{
					skillName: "critical-skill",
					manifest: {
						...manifest,
						schemaVersion: "quilin.skill_manifest.v0",
					},
				},
			]),
		).toEqual({
			status: "critical",
			total: 3,
			warningCount: 1,
			criticalCount: 1,
			unhealthySkillNames: ["critical-skill", "warning-skill"],
		});
	});

	it("keeps readiness unhealthy skill names sorted from raw manifest health inputs", () => {
		const manifest = buildSkillManifest({ descriptor });
		const alphaInput: SkillManifestCatalogRawHealthInput = {
			skillName: " alpha-skill ",
			manifest: {
				...manifest,
				schemaVersion: "quilin.skill_manifest.v0",
			},
		};
		const zetaInput: SkillManifestCatalogRawHealthInput = {
			skillName: " zeta-skill ",
			manifest: {
				...manifest,
				path: "/repo/skills/web-research/README.md",
			},
		};

		const firstSummary = summarizeSkillManifestCatalogReadinessInputs([
			zetaInput,
			alphaInput,
		]);
		const secondSummary = summarizeSkillManifestCatalogReadinessInputs([
			alphaInput,
			zetaInput,
		]);

		expect(firstSummary).toEqual(secondSummary);
		expect(firstSummary.unhealthySkillNames).toEqual([
			"alpha-skill",
			"zeta-skill",
		]);
	});
});

function catalogSummary(
	overrides: Partial<SkillManifestCatalogHealthSummary> = {},
): SkillManifestCatalogHealthSummary {
	return {
		total: 0,
		byStatus: {
			healthy: 0,
			warning: 0,
			critical: 0,
		},
		riskCodes: [],
		missingFields: [],
		unhealthySkillNames: [],
		...overrides,
	};
}

describe("summarizeSkillManifestHealth", () => {
	it("is importable from the package public boundary with its public types", () => {
		const manifest: PublicSkillManifestHealthInput = buildSkillManifest({
			descriptor,
		});
		const summary: PublicSkillManifestHealthSummary =
			summarizeSkillManifestHealthFromIndex(manifest);

		expect(summary).toEqual(summarizeSkillManifestHealth(manifest));
	});

	it("reports a healthy full manifest with deterministic capability hints", () => {
		const manifest = buildSkillManifest({ descriptor });

		expect(summarizeSkillManifestHealth(manifest)).toEqual({
			status: "healthy",
			missingFields: [],
			riskCodes: [],
			capabilityHints: [
				"invocation:model",
				"invocation:user",
				"package:zod",
				"platform:linux",
				"skill:summarize-page",
				"source:project",
				"tool:web_fetch",
				"toolset:browser",
				"trigger:when-to-use",
				"trust:trusted",
			],
		});
	});

	it("reports missing required manifest fields without throwing", () => {
		const summary = summarizeSkillManifestHealth({
			schemaVersion: "quilin.skill_manifest.v1",
			description: "Incomplete manifest",
			source: "project",
			invocation: {
				userInvocable: false,
			},
			tools: {},
		});

		expect(summary.status).toBe("critical");
		expect(summary.missingFields).toEqual([
			"invocation.mandatory",
			"invocation.modelInvocable",
			"name",
			"path",
		]);
		expect(summary.riskCodes).toEqual(["missing_required_fields"]);
	});

	it("flags dangerous paths and over-limit manifest fields", () => {
		const manifest = {
			...buildSkillManifest({ descriptor }),
			name: "a".repeat(65),
			description: "d".repeat(1025),
			path: "/repo/skills/../danger/manifest.txt\0",
		};

		const summary = summarizeSkillManifestHealth(manifest);

		expect(summary.status).toBe("critical");
		expect(summary.missingFields).toEqual([]);
		expect(summary.riskCodes).toEqual([
			"description_too_long",
			"name_too_long",
			"path_not_skill_markdown",
			"path_nul_byte",
			"path_traversal",
		]);
	});

	it("deduplicates and sorts summary fields for stable consumers", () => {
		const baseManifest = buildSkillManifest({ descriptor });
		const manifest: SkillManifestHealthInput = {
			...baseManifest,
			invocation: {
				...baseManifest.invocation,
				mandatory: true,
			},
			tools: {
				allowed: ["zeta_tool", "alpha_tool", "web_fetch"],
				required: ["alpha_tool"],
				requiredToolsets: ["zeta", "browser"],
			},
			platforms: ["macos", "linux", "linux"],
			dependencies: {
				skills: ["beta-skill", "alpha-skill"],
				tools: ["zeta_tool"],
				toolsets: ["alpha-set"],
				packages: ["zod", "@scope/pkg"],
			},
		};

		const firstSummary = summarizeSkillManifestHealth(manifest);
		const secondSummary = summarizeSkillManifestHealth(manifest);

		expect(firstSummary).toEqual(secondSummary);
		expect(firstSummary.capabilityHints).toEqual([
			"invocation:mandatory",
			"invocation:model",
			"invocation:user",
			"package:@scope/pkg",
			"package:zod",
			"platform:linux",
			"platform:macos",
			"skill:alpha-skill",
			"skill:beta-skill",
			"source:project",
			"tool:alpha_tool",
			"tool:web_fetch",
			"tool:zeta_tool",
			"toolset:alpha-set",
			"toolset:browser",
			"toolset:zeta",
			"trigger:when-to-use",
			"trust:trusted",
		]);
	});
});
