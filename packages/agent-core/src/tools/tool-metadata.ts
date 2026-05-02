import type { SandboxOperationType, SandboxRiskSignals } from "./sandbox.js";
import type { Tool } from "./types.js";

/** 工具分类 — 对应 4 类混合动作空间 */
export type ToolCategory = "programmatic" | "interactive" | "control" | "gui";

/** 风险级别 — B2 安全策略的基础 */
export type RiskLevel = "read" | "write" | "exec" | "high-risk";

/** 扩展 Tool 接口，通过组合引入 metadata */
export interface ToolWithMetadata extends Tool {
	readonly category: ToolCategory;
	readonly riskLevel: RiskLevel;
	readonly timeoutMs?: number;
	readonly namespace?: string;
	readonly sandboxOperation?: SandboxOperationType;
	readonly sandboxSignals?: SandboxRiskSignals;
}

/** 用于 PromptBuilder tool-guidance section 的精简描述 */
export interface ToolPromptDescriptor {
	readonly name: string;
	readonly description: string;
	readonly category: ToolCategory;
	readonly riskLevel: RiskLevel;
}
