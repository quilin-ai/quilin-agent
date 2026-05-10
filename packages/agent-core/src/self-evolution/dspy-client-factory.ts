import type { MCPRegistry } from "../tools/registry.js";
import type { DspyOptimizerMCPClient } from "./dspy-offline-optimizer.js";

/**
 * Server id for the DSPy optimizer MCP server. Mirrors the entry
 * registered in `config/loader.ts` so this string can be the single
 * source of truth for both spawn-time gating and lookup-time wiring.
 *
 * DSPy 优化器 MCP 服务的 server id。与 `config/loader.ts` 中注册的
 * entry 保持一致，让 spawn 时的 gate 与查询时的 wire 共用唯一字面量。
 */
export const DSPY_OPTIMIZER_MCP_SERVER_ID = "quilin-optimizer" as const;

/**
 * Lazy view over the MCPRegistry — read at each `callTool` invocation
 * so a factory built before the registry is populated still works once
 * `syncRuntimeSurface` registers the optimizer server. The ref pattern
 * mirrors `DashboardRuntimeRefs.registry` (late-bound by `onRuntimeReady`).
 *
 * 对 MCPRegistry 的懒视图——每次 `callTool` 时再查询，保证在
 * registry 尚未填充时构造的 factory 也能在 `syncRuntimeSurface`
 * 注册 optimizer server 后正常工作。该 ref 模式与
 * `DashboardRuntimeRefs.registry`（由 `onRuntimeReady` 后绑定）一致。
 */
export interface MCPRegistryRef {
	registry?: MCPRegistry;
}

/**
 * Error thrown when the DSPy optimizer client is invoked before the
 * `quilin-optimizer` MCP server is registered / connected. The message
 * names the server id so operators can wire it up via capabilities config.
 *
 * 当 DSPy 优化器 client 在 `quilin-optimizer` MCP server 注册/连接前被
 * 调用时抛出。错误消息明确指出 server id，便于通过 capabilities config
 * 接入。
 */
export class DspyOptimizerNotConnectedError extends Error {
	constructor(serverId: string = DSPY_OPTIMIZER_MCP_SERVER_ID) {
		super(
			`DSPy optimizer MCP server "${serverId}" is not registered or not connected; ` +
				"check capabilities.toml mcpServers entry and QUILIN_OPTIMIZER_JUDGE_API_KEY.",
		);
		this.name = "DspyOptimizerNotConnectedError";
	}
}

/**
 * Build a `DspyOptimizerMCPClient` whose `callTool` resolves the
 * underlying transport from the registry on every invocation. Returning
 * `undefined` when the registry-bound `quilin-optimizer` entry is not
 * present in the loaded capabilities config tells `createOfflineOptimizer`
 * to fall back to PromptRewriteOptimizer with a warn log.
 *
 * 构造一个 `DspyOptimizerMCPClient`，其 `callTool` 在每次调用时从
 * registry 取出底层 transport。capabilities config 未载入
 * `quilin-optimizer` entry 时返回 `undefined`，告诉
 * `createOfflineOptimizer` 退化到 PromptRewriteOptimizer 并打 warn。
 *
 * @param registryRef Late-bound MCPRegistry container (populated when
 *   `onRuntimeReady` fires inside `startRepl`).
 * @param hasOptimizerEntry Predicate that returns `true` when the loaded
 *   capabilities config contains a `quilin-optimizer` server entry. We
 *   pass this in (rather than peeking at `process.env`) so the factory
 *   stays isolated from environment side effects and easy to test.
 */
export function buildDspyClientFactoryFromRegistryRef(options: {
	readonly registryRef: MCPRegistryRef;
	readonly hasOptimizerEntry: () => boolean;
	readonly serverId?: string;
}): (() => DspyOptimizerMCPClient) | undefined {
	if (!options.hasOptimizerEntry()) {
		return undefined;
	}
	const serverId = options.serverId ?? DSPY_OPTIMIZER_MCP_SERVER_ID;
	const registryRef = options.registryRef;
	return () => ({
		async callTool(
			name: string,
			args: Record<string, unknown>,
		): Promise<string> {
			const registry = registryRef.registry;
			if (registry == null) {
				throw new DspyOptimizerNotConnectedError(serverId);
			}
			const transport = registry.getServerCallToolTransport(serverId);
			if (transport == null) {
				throw new DspyOptimizerNotConnectedError(serverId);
			}
			return transport.callTool(name, args);
		},
	});
}
