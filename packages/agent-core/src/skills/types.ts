export type SkillSource = "bundled" | "user" | "project" | "plugin";

export type SkillTrustLevel =
	| "builtin"
	| "trusted"
	| "community"
	| "agent-created";

export interface SkillFrontmatter {
	readonly name: string;
	readonly description: string;
	readonly whenToUse?: string;
	readonly allowedTools?: readonly string[];
	readonly mandatory?: boolean;
	readonly requiresTools?: readonly string[];
	readonly requiresToolsets?: readonly string[];
	readonly platforms?: readonly string[];
	readonly version?: string;
	readonly dependencies?: SkillDependencyMetadata;
	readonly userInvocable: boolean;
	readonly disableModelInvocation: boolean;
	readonly trust?: SkillTrustLevel;
}

export interface SkillDependencyMetadata {
	readonly skills?: readonly string[];
	readonly tools?: readonly string[];
	readonly toolsets?: readonly string[];
	readonly packages?: readonly string[];
}

export interface SkillDescriptor {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly source: SkillSource;
	readonly frontmatter: SkillFrontmatter;
}

export type SkillManifestSchemaVersion = "quilin.skill_manifest.v1";

export interface SkillManifest {
	readonly schemaVersion: SkillManifestSchemaVersion;
	readonly name: string;
	readonly description: string;
	readonly version?: string;
	readonly source: SkillSource;
	readonly path: string;
	readonly trust?: SkillTrustLevel;
	readonly invocation: {
		readonly userInvocable: boolean;
		readonly modelInvocable: boolean;
		readonly mandatory: boolean;
		readonly whenToUse?: string;
	};
	readonly tools: {
		readonly allowed?: readonly string[];
		readonly required?: readonly string[];
		readonly requiredToolsets?: readonly string[];
	};
	readonly platforms?: readonly string[];
	readonly dependencies?: SkillDependencyMetadata;
	readonly provenance?: SkillProvenanceReceipt;
}

export type SkillDigestAlgorithm = "sha256";

export interface SkillContentDigest {
	readonly algorithm: SkillDigestAlgorithm;
	readonly value: string;
}

export type SkillProvenanceSchemaVersion = "quilin.skill_provenance.v1";

export interface SkillProvenanceReceipt {
	readonly schemaVersion: SkillProvenanceSchemaVersion;
	readonly skillName: string;
	readonly skillVersion?: string;
	readonly source: SkillSource;
	readonly path: string;
	readonly digest: SkillContentDigest;
	readonly sizeBytes: number;
	readonly generatedAt?: string;
}

export interface SkillTriggerEvalCase {
	readonly id: string;
	readonly input: string;
	readonly expectedSkillNames: readonly string[];
}

export interface SkillTriggerEvalCaseResult {
	readonly id: string;
	readonly selectedSkillNames: readonly string[];
	readonly expectedSkillNames: readonly string[];
	readonly truePositives: readonly string[];
	readonly falsePositives: readonly string[];
	readonly falseNegatives: readonly string[];
	readonly precision: number;
	readonly recall: number;
	readonly quality: SkillTriggerQualityScore;
	readonly passed: boolean;
}

export type SkillTriggerQualityBand =
	| "excellent"
	| "good"
	| "needs_improvement"
	| "poor";

export interface SkillTriggerQualityScore {
	readonly score: number;
	readonly precision: number;
	readonly recall: number;
	readonly band: SkillTriggerQualityBand;
}

export interface SkillTriggerEvalReport {
	readonly schemaVersion: "quilin.skill_trigger_eval.v1";
	readonly cases: readonly SkillTriggerEvalCaseResult[];
	readonly totals: {
		readonly truePositives: number;
		readonly falsePositives: number;
		readonly falseNegatives: number;
	};
	readonly metrics: {
		readonly precision: number;
		readonly recall: number;
	};
	readonly quality: SkillTriggerQualityScore;
	readonly thresholds: {
		readonly minPrecision: number;
		readonly minRecall: number;
	};
	readonly passed: boolean;
}

export interface LoadedSkill {
	readonly descriptor: SkillDescriptor;
	readonly body: string;
	readonly tokenEstimate: number;
}

export interface PostCompactRestoreEntry {
	readonly name: string;
	readonly source: SkillSource;
	readonly body: string;
	readonly tokenEstimate: number;
}

export interface PostCompactRestoreResult {
	readonly entries: readonly PostCompactRestoreEntry[];
	readonly totalTokens: number;
}

export type SkillManageAction =
	| {
			readonly action: "create";
			readonly descriptor: SkillDescriptor;
			readonly body: string;
			readonly target?: "user" | "project";
	  }
	| {
			readonly action: "update";
			readonly name: string;
			readonly patch: SkillDescriptorPatch;
			readonly body?: string;
	  }
	| {
			readonly action: "delete";
			readonly name: string;
			readonly reason: string;
	  };

export type SkillDescriptorPatch = Omit<
	Partial<SkillDescriptor>,
	"frontmatter"
> & {
	readonly frontmatter?: Partial<SkillFrontmatter>;
};

export type SkillManageError =
	| "validation_failed"
	| "path_denied"
	| "size_exceeded"
	| "not_found"
	| "write_denied"
	| "guard_denied";

export type SkillManageResult =
	| {
			readonly ok: true;
			readonly descriptor: SkillDescriptor;
	  }
	| {
			readonly ok: false;
			readonly error: SkillManageError;
			readonly detail: string;
	  };

export type GuardThreatCategory =
	| "data_exfiltration"
	| "prompt_injection"
	| "destructive_ops"
	| "persistence"
	| "obfuscation";

export type GuardSeverity = "low" | "medium" | "high" | "critical";

export interface GuardFinding {
	readonly category: GuardThreatCategory;
	readonly severity: GuardSeverity;
	readonly pattern_id: string;
	readonly match: string;
	readonly line: number;
}

export type GuardDecision =
	| { readonly kind: "pass" }
	| { readonly kind: "warn"; readonly findings: readonly GuardFinding[] }
	| { readonly kind: "ask"; readonly findings: readonly GuardFinding[] }
	| {
			readonly kind: "deny";
			readonly findings: readonly GuardFinding[];
			readonly detail: string;
	  };

export interface SkillsGuard {
	scan(
		body: string,
		ctx: {
			readonly trust: SkillTrustLevel;
			readonly stage: "read" | "write";
			readonly skillName: string;
		},
	): GuardDecision;
}
