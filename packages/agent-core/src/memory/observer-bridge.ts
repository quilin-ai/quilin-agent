// L3a observer bridge — wires the agent-core loop to the quilin-mem
// `memory_observe` MCP tool. Best-effort by design: any failure in the
// observer chain is swallowed so the agent loop is never blocked by an
// observer hiccup.
//
// L3a 观察桥：把 agent-core loop 与 quilin-mem `memory_observe` MCP 工具
// 串起来。设计为尽力而为：观察链上任何错误都被吞掉，不会阻塞 agent loop。

import { logger } from "../logger.js";
import type { MCPClientManager } from "../tools/mcp-client.js";

export interface ObserverBridgeTurnInput {
	readonly userText: string;
	readonly assistantText: string;
	readonly userId?: string;
	readonly sessionId?: string;
	readonly metadata?: Record<string, unknown>;
}

export interface ObserverBridge {
	observeTurn(input: ObserverBridgeTurnInput): Promise<void>;
}

export type ObserverBridgeMCPTransport = Pick<MCPClientManager, "callTool">;

/**
 * Bridge that publishes every completed turn to the `memory_observe` MCP
 * tool. The tool itself decides (via L3aObserver frequency gate) whether
 * to actually fan out to a flash LLM — this bridge is the runtime hook
 * that makes the L3a observer reachable from the agent loop.
 */
export class MCPObserverBridge implements ObserverBridge {
	constructor(private readonly transport: ObserverBridgeMCPTransport) {}

	async observeTurn(input: ObserverBridgeTurnInput): Promise<void> {
		// Empty turn is a no-op — nothing to observe.
		if (input.userText.length === 0 && input.assistantText.length === 0) {
			return;
		}

		const args: Record<string, unknown> = {
			user_text: input.userText,
			assistant_text: input.assistantText,
		};
		if (input.userId != null && input.userId.length > 0) {
			args.user_id = input.userId;
		}
		if (input.sessionId != null && input.sessionId.length > 0) {
			args.session_id = input.sessionId;
		}
		if (input.metadata != null && Object.keys(input.metadata).length > 0) {
			args.metadata = input.metadata;
		}

		try {
			const response = await this.transport.callTool("memory_observe", args);
			// Null/empty response is treated as a no-op (e.g. transport
			// returned null because the server isn't up yet).
			if (response == null) {
				return;
			}
		} catch (error: unknown) {
			// Best-effort: log and swallow. Never let observer hiccups block
			// the agent loop.
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				{ error: message, sessionId: input.sessionId },
				"memory_observe failed (ignored — observer is best-effort)",
			);
		}
	}
}

/** No-op observer used when memoryObserver.enabled is false (default). */
export class NullObserverBridge implements ObserverBridge {
	async observeTurn(_input: ObserverBridgeTurnInput): Promise<void> {
		// intentionally empty
	}
}
