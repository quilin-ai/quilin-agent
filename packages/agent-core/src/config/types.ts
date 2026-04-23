import type { RiskLevel } from "../tools/tool-metadata.js";

export const CAPABILITIES_SCHEMA_VERSION = 1 as const;

export interface McpServerConfig {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly namespace?: string;
	readonly defaultRiskLevel?: RiskLevel;
	readonly enabled?: boolean;
}

export interface SkillsConfig {
	readonly enabled?: boolean;
	readonly bundledRoots?: readonly string[];
	readonly userRoots?: readonly string[];
	readonly projectRoots?: readonly string[];
	readonly pluginRoots?: readonly string[];
	readonly watcherEnabled?: boolean;
	readonly debounceMs?: number;
}

export interface CapabilitiesConfig {
	readonly schema_version: typeof CAPABILITIES_SCHEMA_VERSION;
	readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
	readonly skills: SkillsConfig;
}
