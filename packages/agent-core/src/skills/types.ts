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
	| "write_denied";

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
