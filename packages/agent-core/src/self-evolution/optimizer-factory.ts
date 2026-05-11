import { logger } from "../logger.js";
import {
	DspyOfflineOptimizer,
	type DspyOfflineOptimizerOptions,
	type DspyOptimizerMCPClient,
} from "./dspy-offline-optimizer.js";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import type { OfflineOptimizer } from "./types.js";

/**
 * Optimizer choice surfaced to user config under
 * `[self_evolution] optimizer = "..."`. Mirrors the enum in
 * `user-config-schema.ts` — keep the two in lockstep.
 *
 * DSPy + GEPA is the singular self-evolution optimizer; PromptRewrite
 * (in-process heuristic) and MIPROv2 (the prior alternative DSPy
 * compiler) were removed 2026-05-12. See docs/10-self-evolution/README.md
 * §2.4 for the decision rationale.
 *
 * 用户配置 `[self_evolution] optimizer = "..."` 暴露的选项。
 * 与 `user-config-schema.ts` 中的 enum 同步维护。
 *
 * DSPy + GEPA 是唯一的自进化 optimizer；PromptRewrite（进程内启发式）
 * 和 MIPROv2（备选 DSPy 编译器）于 2026-05-12 移除。决策依据见
 * docs/10-self-evolution/README.md §2.4。
 */
export type OfflineOptimizerChoice = "noop" | "dspy";

export interface OfflineOptimizerFactoryOptions {
	readonly choice: OfflineOptimizerChoice;
	readonly now?: () => Date;
	/**
	 * Factory returning the MCP client used by the DSPy optimizer. Only
	 * consulted when `choice === "dspy"`. When the factory is missing,
	 * `dspy` falls back to a `noop` optimizer with a warning so a
	 * misconfigured agent doesn't crash — it just produces no proposals
	 * until the MCP client is wired.
	 *
	 * 返回 DSPy 优化器使用的 MCP 客户端的工厂。仅在 `choice === "dspy"`
	 * 时调用。工厂缺失时 `dspy` 退化到 noop 并记录警告，避免误配置导致
	 * Agent 崩溃；MCP 客户端接上之前不产出任何 proposal。
	 */
	readonly dspyClientFactory?: () => DspyOptimizerMCPClient;
	/**
	 * Override for the DSPy optimizer's `toolName`. Defaults to
	 * `"optimize"` — the only tool name the optimizer server exposes
	 * after the GEPA-only refactor.
	 *
	 * 覆盖 DSPy 优化器调用的工具名。默认 `"optimize"` —— GEPA-only 重构后
	 * optimizer server 只暴露这一个工具。
	 */
	readonly dspyToolName?: string;
}

/**
 * Build the OfflineOptimizer the idle runner should use, based on user
 * config. Defaults are GEPA-via-DSPy; only `choice="noop"` disables
 * self-evolution entirely.
 *
 * 根据用户配置构造 idle runner 使用的 OfflineOptimizer。默认走
 * DSPy + GEPA；只有 `choice="noop"` 完全禁用自进化。
 */
export function createOfflineOptimizer(
	options: OfflineOptimizerFactoryOptions,
): OfflineOptimizer {
	const now = options.now;

	switch (options.choice) {
		case "noop": {
			return new LocalNoopOfflineOptimizer(now == null ? {} : { now });
		}
		case "dspy": {
			if (options.dspyClientFactory == null) {
				logger.warn(
					{
						choice: "dspy",
						reason: "missing_dspy_client_factory",
					},
					"createOfflineOptimizer: DSPy chosen but no MCP client factory wired — falling back to noop (no proposals)",
				);
				return new LocalNoopOfflineOptimizer(now == null ? {} : { now });
			}
			const client = options.dspyClientFactory();
			const dspyOptions: DspyOfflineOptimizerOptions = {
				client,
				...(now == null ? {} : { now }),
				...(options.dspyToolName == null
					? {}
					: { toolName: options.dspyToolName }),
			};
			return new DspyOfflineOptimizer(dspyOptions);
		}
	}
}
