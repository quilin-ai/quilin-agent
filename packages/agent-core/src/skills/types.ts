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
	readonly version?: string;
	readonly userInvocable: boolean;
	readonly disableModelInvocation: boolean;
	readonly trust: SkillTrustLevel;
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
