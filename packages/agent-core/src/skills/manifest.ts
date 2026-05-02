import { validateSkillProvenanceReceipt } from "./provenance.js";
import type {
	SkillDependencyMetadata,
	SkillDescriptor,
	SkillManifest,
	SkillProvenanceReceipt,
} from "./types.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const EXPECTED_SCHEMA_VERSION = "quilin.skill_manifest.v1";
const CRITICAL_RISK_CODES = new Set<SkillManifestRiskCode>([
	"description_too_long",
	"invalid_schema_version",
	"missing_required_fields",
	"name_too_long",
	"path_nul_byte",
	"path_traversal",
]);

export type SkillManifestHealthStatus = "healthy" | "warning" | "critical";

export type SkillManifestRiskCode =
	| "description_too_long"
	| "invalid_schema_version"
	| "missing_required_fields"
	| "name_too_long"
	| "path_not_skill_markdown"
	| "path_nul_byte"
	| "path_traversal";

export type SkillManifestHealthInput = Partial<
	Omit<SkillManifest, "dependencies" | "invocation" | "schemaVersion" | "tools">
> & {
	readonly dependencies?: Partial<SkillDependencyMetadata>;
	readonly invocation?: Partial<SkillManifest["invocation"]>;
	readonly schemaVersion?: string;
	readonly tools?: Partial<SkillManifest["tools"]>;
};

export interface SkillManifestHealthSummary {
	readonly status: SkillManifestHealthStatus;
	readonly missingFields: readonly string[];
	readonly riskCodes: readonly SkillManifestRiskCode[];
	readonly capabilityHints: readonly string[];
}

export interface SkillManifestCatalogHealthInput {
	readonly skillName: string;
	readonly summary: SkillManifestHealthSummary;
}

export interface SkillManifestCatalogRawHealthInput {
	readonly skillName: string;
	readonly manifest: SkillManifestHealthInput;
}

export interface SkillManifestCatalogRiskCodeSummary {
	readonly code: SkillManifestRiskCode;
	readonly count: number;
}

export interface SkillManifestCatalogMissingFieldSummary {
	readonly field: string;
	readonly count: number;
}

export interface SkillManifestCatalogHealthSummary {
	readonly total: number;
	readonly byStatus: Readonly<Record<SkillManifestHealthStatus, number>>;
	readonly riskCodes: readonly SkillManifestCatalogRiskCodeSummary[];
	readonly missingFields: readonly SkillManifestCatalogMissingFieldSummary[];
	readonly unhealthySkillNames: readonly string[];
}

export type SkillManifestCatalogReadinessStatus =
	| "empty"
	| "healthy"
	| "warning"
	| "critical";

export interface SkillManifestCatalogReadinessSummary {
	readonly status: SkillManifestCatalogReadinessStatus;
	readonly total: number;
	readonly warningCount: number;
	readonly criticalCount: number;
	readonly unhealthySkillNames: readonly string[];
}

export interface BuildSkillManifestOptions {
	readonly descriptor: SkillDescriptor;
	readonly provenance?: SkillProvenanceReceipt;
	readonly content?: string | Buffer;
}

export function buildSkillManifest(
	options: BuildSkillManifestOptions,
): SkillManifest {
	const { descriptor, provenance } = options;
	const { frontmatter } = descriptor;
	if (provenance != null) {
		if (options.content === undefined) {
			throw new Error(
				"Skill provenance content is required to verify digest and size",
			);
		}
		const provenanceValidation = validateSkillProvenanceReceipt({
			descriptor,
			provenance,
			content: options.content,
		});
		if (!provenanceValidation.ok) {
			throw new Error(provenanceValidation.detail);
		}
	}

	return {
		schemaVersion: "quilin.skill_manifest.v1",
		name: descriptor.name,
		description: descriptor.description,
		version: frontmatter.version,
		source: descriptor.source,
		path: descriptor.path,
		trust: frontmatter.trust,
		invocation: {
			userInvocable: frontmatter.userInvocable,
			modelInvocable: !frontmatter.disableModelInvocation,
			mandatory: frontmatter.mandatory ?? false,
			whenToUse: frontmatter.whenToUse,
		},
		tools: {
			allowed: frontmatter.allowedTools,
			required: frontmatter.requiresTools,
			requiredToolsets: frontmatter.requiresToolsets,
		},
		platforms: frontmatter.platforms,
		dependencies: frontmatter.dependencies,
		provenance,
	};
}

export function summarizeSkillManifestHealth(
	manifest: SkillManifestHealthInput,
): SkillManifestHealthSummary {
	const missingFields = new Set<string>();
	const riskCodes = new Set<SkillManifestRiskCode>();
	const capabilityHints = new Set<string>();

	addRequiredField(missingFields, "schemaVersion", manifest.schemaVersion);
	addRequiredField(missingFields, "name", manifest.name);
	addRequiredField(missingFields, "description", manifest.description);
	addRequiredField(missingFields, "source", manifest.source);
	addRequiredField(missingFields, "path", manifest.path);
	addRequiredField(missingFields, "invocation", manifest.invocation);
	addRequiredField(missingFields, "tools", manifest.tools);

	if (manifest.invocation != null) {
		addRequiredField(
			missingFields,
			"invocation.userInvocable",
			manifest.invocation.userInvocable,
		);
		addRequiredField(
			missingFields,
			"invocation.modelInvocable",
			manifest.invocation.modelInvocable,
		);
		addRequiredField(
			missingFields,
			"invocation.mandatory",
			manifest.invocation.mandatory,
		);
	}

	if (missingFields.size > 0) {
		riskCodes.add("missing_required_fields");
	}

	if (
		manifest.schemaVersion != null &&
		manifest.schemaVersion !== EXPECTED_SCHEMA_VERSION
	) {
		riskCodes.add("invalid_schema_version");
	}

	if (
		typeof manifest.name === "string" &&
		manifest.name.length > MAX_NAME_LENGTH
	) {
		riskCodes.add("name_too_long");
	}

	if (
		typeof manifest.description === "string" &&
		manifest.description.length > MAX_DESCRIPTION_LENGTH
	) {
		riskCodes.add("description_too_long");
	}

	if (typeof manifest.path === "string") {
		addPathRiskCodes(riskCodes, manifest.path);
	}

	addInvocationHints(capabilityHints, manifest.invocation);
	addHint(capabilityHints, "source:", manifest.source);
	addHint(capabilityHints, "trust:", manifest.trust);
	addHints(capabilityHints, "tool:", manifest.tools?.allowed);
	addHints(capabilityHints, "tool:", manifest.tools?.required);
	addHints(capabilityHints, "tool:", manifest.dependencies?.tools);
	addHints(capabilityHints, "toolset:", manifest.tools?.requiredToolsets);
	addHints(capabilityHints, "toolset:", manifest.dependencies?.toolsets);
	addHints(capabilityHints, "skill:", manifest.dependencies?.skills);
	addHints(capabilityHints, "package:", manifest.dependencies?.packages);
	addHints(capabilityHints, "platform:", manifest.platforms);

	return {
		status: getHealthStatus(riskCodes),
		missingFields: sortStrings(missingFields),
		riskCodes: sortStrings(riskCodes),
		capabilityHints: sortStrings(capabilityHints),
	};
}

export function summarizeSkillManifestCatalogHealth(
	manifests: readonly SkillManifestCatalogHealthInput[],
): SkillManifestCatalogHealthSummary {
	const byStatus: Record<SkillManifestHealthStatus, number> = {
		healthy: 0,
		warning: 0,
		critical: 0,
	};
	const riskCodes = new Map<SkillManifestRiskCode, number>();
	const missingFields = new Map<string, number>();
	const unhealthySkillNames = new Set<string>();

	for (const manifest of manifests) {
		const { summary } = manifest;
		byStatus[summary.status] += 1;

		if (summary.status !== "healthy") {
			addCatalogSkillName(unhealthySkillNames, manifest.skillName);
		}

		for (const riskCode of summary.riskCodes) {
			incrementCount(riskCodes, riskCode);
		}

		for (const missingField of summary.missingFields) {
			incrementCount(missingFields, missingField);
		}
	}

	return {
		total: manifests.length,
		byStatus,
		riskCodes: sortRiskCodeSummaries(riskCodes),
		missingFields: sortMissingFieldSummaries(missingFields),
		unhealthySkillNames: sortStrings(unhealthySkillNames),
	};
}

export function summarizeSkillManifestCatalogReadiness(
	summary: SkillManifestCatalogHealthSummary,
): SkillManifestCatalogReadinessSummary {
	const warningCount = summary.byStatus.warning;
	const criticalCount = summary.byStatus.critical;
	const unhealthySkillNames = new Set<string>();
	for (const skillName of summary.unhealthySkillNames) {
		addCatalogSkillName(unhealthySkillNames, skillName);
	}

	return {
		status: getCatalogReadinessStatus({
			total: summary.total,
			warningCount,
			criticalCount,
		}),
		total: summary.total,
		warningCount,
		criticalCount,
		unhealthySkillNames: sortStrings(unhealthySkillNames),
	};
}

export function summarizeSkillManifestCatalogHealthInputs(
	inputs: readonly SkillManifestCatalogRawHealthInput[],
): SkillManifestCatalogHealthSummary {
	return summarizeSkillManifestCatalogHealth(
		inputs.map((input) => ({
			skillName: input.skillName,
			summary: summarizeSkillManifestHealth(input.manifest),
		})),
	);
}

export function summarizeSkillManifestCatalogReadinessInputs(
	inputs: readonly SkillManifestCatalogRawHealthInput[],
): SkillManifestCatalogReadinessSummary {
	return summarizeSkillManifestCatalogReadiness(
		summarizeSkillManifestCatalogHealthInputs(inputs),
	);
}

function addRequiredField(
	missingFields: Set<string>,
	field: string,
	value: unknown,
): void {
	if (
		value == null ||
		(typeof value === "string" && value.trim().length === 0)
	) {
		missingFields.add(field);
	}
}

function addPathRiskCodes(
	riskCodes: Set<SkillManifestRiskCode>,
	path: string,
): void {
	const normalizedPath = path.replaceAll("\\", "/");
	if (path.includes("\0")) {
		riskCodes.add("path_nul_byte");
	}

	if (normalizedPath.split("/").includes("..")) {
		riskCodes.add("path_traversal");
	}

	if (normalizedPath !== "SKILL.md" && !normalizedPath.endsWith("/SKILL.md")) {
		riskCodes.add("path_not_skill_markdown");
	}
}

function addInvocationHints(
	capabilityHints: Set<string>,
	invocation: SkillManifestHealthInput["invocation"],
): void {
	if (invocation?.modelInvocable === true) {
		capabilityHints.add("invocation:model");
	}

	if (invocation?.userInvocable === true) {
		capabilityHints.add("invocation:user");
	}

	if (invocation?.mandatory === true) {
		capabilityHints.add("invocation:mandatory");
	}

	if (isNonEmptyString(invocation?.whenToUse)) {
		capabilityHints.add("trigger:when-to-use");
	}
}

function addHint(
	capabilityHints: Set<string>,
	prefix: string,
	value: unknown,
): void {
	if (isNonEmptyString(value)) {
		capabilityHints.add(`${prefix}${value.trim()}`);
	}
}

function addHints(
	capabilityHints: Set<string>,
	prefix: string,
	values: readonly unknown[] | undefined,
): void {
	for (const value of values ?? []) {
		addHint(capabilityHints, prefix, value);
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function getHealthStatus(
	riskCodes: ReadonlySet<SkillManifestRiskCode>,
): SkillManifestHealthStatus {
	if (riskCodes.size === 0) {
		return "healthy";
	}

	for (const riskCode of riskCodes) {
		if (CRITICAL_RISK_CODES.has(riskCode)) {
			return "critical";
		}
	}

	return "warning";
}

function getCatalogReadinessStatus(summary: {
	readonly total: number;
	readonly warningCount: number;
	readonly criticalCount: number;
}): SkillManifestCatalogReadinessStatus {
	if (summary.total === 0) {
		return "empty";
	}

	if (summary.criticalCount > 0) {
		return "critical";
	}

	if (summary.warningCount > 0) {
		return "warning";
	}

	return "healthy";
}

function addCatalogSkillName(skillNames: Set<string>, skillName: string): void {
	const trimmedName = skillName.trim();
	if (trimmedName.length > 0) {
		skillNames.add(trimmedName);
	}
}

function incrementCount<T extends string>(
	counts: Map<T, number>,
	value: T,
): void {
	counts.set(value, (counts.get(value) ?? 0) + 1);
}

function sortRiskCodeSummaries(
	counts: ReadonlyMap<SkillManifestRiskCode, number>,
): readonly SkillManifestCatalogRiskCodeSummary[] {
	return [...counts]
		.sort(([left], [right]) => compareStrings(left, right))
		.map(([code, count]) => ({ code, count }));
}

function sortMissingFieldSummaries(
	counts: ReadonlyMap<string, number>,
): readonly SkillManifestCatalogMissingFieldSummary[] {
	return [...counts]
		.sort(([left], [right]) => compareStrings(left, right))
		.map(([field, count]) => ({ field, count }));
}

function sortStrings<T extends string>(values: ReadonlySet<T>): readonly T[] {
	return [...values].sort();
}

function compareStrings(left: string, right: string): number {
	if (left < right) {
		return -1;
	}

	if (left > right) {
		return 1;
	}

	return 0;
}
