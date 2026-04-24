import type { RiskLevel } from "../tools/tool-metadata.js";

export const CAPABILITIES_SCHEMA_VERSION = 1 as const;
export type CapabilitiesSchemaVersion = 1 | 2;

export interface McpRetryPolicyConfig {
	readonly maxAttempts?: number;
	readonly retryableExitCodes?: readonly number[];
}

export interface McpBackoffConfig {
	readonly initialDelayMs?: number;
	readonly maxDelayMs?: number;
	readonly multiplier?: number;
}

export interface McpServerConfig {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly namespace?: string;
	readonly defaultRiskLevel?: RiskLevel;
	readonly enabled?: boolean;
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	readonly connectTimeoutMs?: number;
	readonly retryPolicy?: McpRetryPolicyConfig;
	readonly backoff?: McpBackoffConfig;
}

export interface SkillsConfig {
	readonly enabled?: boolean;
	readonly bundledRoots?: readonly string[];
	readonly userRoots?: readonly string[];
	readonly projectRoots?: readonly string[];
	readonly pluginRoots?: readonly string[];
	readonly watcherEnabled?: boolean;
	readonly debounceMs?: number;
	readonly reloadStrategy?: "manual" | "watch";
}

export type SafetyConfig = Record<string, never>;

export interface CapabilitiesConfigBase {
	readonly schema_version: CapabilitiesSchemaVersion;
	readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
	readonly skills: SkillsConfig;
	readonly safety?: SafetyConfig;
}

export type CapabilitiesConfig = CapabilitiesConfigBase;
