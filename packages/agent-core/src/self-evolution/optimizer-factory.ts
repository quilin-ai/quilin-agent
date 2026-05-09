import { logger } from "../logger.js";
import {
	DspyOfflineOptimizer,
	type DspyOfflineOptimizerOptions,
	type DspyOptimizerMCPClient,
} from "./dspy-offline-optimizer.js";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import { PromptRewriteOptimizer } from "./prompt-rewrite-optimizer.js";
import type { OfflineOptimizer } from "./types.js";

/**
 * Optimizer choice surfaced to user config under
 * `[self_evolution] optimizer = "..."`. Mirrors the enum in
 * `user-config-schema.ts` — keep the two in lockstep.
 *
 * 用户配置 `[self_evolution] optimizer = "..."` 暴露的选项。
 * 与 `user-config-schema.ts` 中的 enum 同步维护。
 */
export type OfflineOptimizerChoice = "noop" | "prompt_rewrite" | "dspy";

export interface OfflineOptimizerFactoryOptions {
	readonly choice: OfflineOptimizerChoice;
	readonly now?: () => Date;
	/**
	 * Factory returning the MCP client used by the DSPy optimizer. Only
	 * consulted when `choice === "dspy"`. When the factory is missing,
	 * `dspy` falls back to PromptRewriteOptimizer with a warning so a
	 * misconfigured user doesn't lose self-evolution entirely.
	 *
	 * 返回 DSPy 优化器使用的 MCP 客户端的工厂。仅在 `choice === "dspy"`
	 * 时调用。工厂缺失时 `dspy` 退化到 PromptRewriteOptimizer 并记录
	 * 警告，避免误配置导致 self-evolution 完全失效。
	 */
	readonly dspyClientFactory?: () => DspyOptimizerMCPClient;
	/**
	 * Override for the DSPy optimizer's `toolName`. Stage A leaves this
	 * at the default; Stage C may pivot to `optimize_v2` without forcing
	 * every caller to reach into options.
	 *
	 * 覆盖 DSPy 优化器调用的工具名。Stage A 使用默认值；Stage C 若改用
	 * `optimize_v2` 可在此修改而无需触及调用方。
	 */
	readonly dspyToolName?: string;
}

/**
 * Build the OfflineOptimizer the idle runner should use, based on user
 * config. Defaults remain backwards compatible: callers that don't
 * specify a choice still get PromptRewriteOptimizer.
 *
 * 根据用户配置构造 idle runner 使用的 OfflineOptimizer。
 * 不指定 choice 时仍返回 PromptRewriteOptimizer，保持向后兼容。
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
					"createOfflineOptimizer: DSPy chosen but no MCP client factory wired — falling back to prompt_rewrite",
				);
				return new PromptRewriteOptimizer(now == null ? {} : { now });
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
		default: {
			return new PromptRewriteOptimizer(now == null ? {} : { now });
		}
	}
}
