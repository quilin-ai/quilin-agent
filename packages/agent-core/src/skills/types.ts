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
	readonly userInvocable: boolean;
	readonly disableModelInvocation: boolean;
	readonly trust?: SkillTrustLevel;
}

export interface SkillDescriptor {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly source: SkillSource;
	readonly frontmatter: SkillFrontmatter;
}

export interface LoadedSkill {
	readonly descriptor: SkillDescriptor;
	readonly body: string;
	readonly tokenEstimate: number;
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
			readonly patch: Partial<SkillDescriptor>;
			readonly body?: string;
	  }
	| {
			readonly action: "delete";
			readonly name: string;
			readonly reason: string;
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
