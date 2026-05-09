import { describe, expect, it, vi } from "vitest";
import {
	createObserverBridgeIfEnabled,
	MCPObserverBridge,
	NullObserverBridge,
	type ObserverBridgeMCPTransport,
} from "./observer-bridge.js";

interface RecordedCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

function createTransport(
	response:
		| string
		| null
		| ((name: string, args: Record<string, unknown>) => string | null),
): {
	readonly calls: RecordedCall[];
	readonly transport: ObserverBridgeMCPTransport;
} {
	const calls: RecordedCall[] = [];
	return {
		calls,
		transport: {
			async callTool(name, args) {
				calls.push({ name, args });
				const result =
					typeof response === "function" ? response(name, args) : response;
				// MCPClientManager.callTool's return type is string. We model the
				// "null" path by returning an empty string (null guard inside the
				// bridge handles the case anyway via short-circuit).
				return result ?? "";
			},
		},
	};
}

describe("MCPObserverBridge", () => {
	it("calls memory_observe with snake_case wire arguments", async () => {
		const { calls, transport } = createTransport(
			JSON.stringify({ candidates: [] }),
		);
		const bridge = new MCPObserverBridge(transport);

		await bridge.observeTurn({
			userText: "I prefer concise answers",
			assistantText: "Got it.",
			userId: "alice",
			sessionId: "session-A",
		});

		expect(calls).toEqual([
			{
				name: "memory_observe",
				args: {
					user_text: "I prefer concise answers",
					assistant_text: "Got it.",
					user_id: "alice",
					session_id: "session-A",
				},
			},
		]);
	});

	it("omits user_id and session_id when not provided", async () => {
		const { calls, transport } = createTransport(
			JSON.stringify({ candidates: [] }),
		);
		const bridge = new MCPObserverBridge(transport);

		await bridge.observeTurn({
			userText: "hello",
			assistantText: "hi",
		});

		expect(calls[0]?.args).toEqual({
			user_text: "hello",
			assistant_text: "hi",
		});
	});

	it("forwards metadata only when non-empty", async () => {
		const { calls, transport } = createTransport(
			JSON.stringify({ candidates: [] }),
		);
		const bridge = new MCPObserverBridge(transport);

		await bridge.observeTurn({
			userText: "hello",
			assistantText: "hi",
			metadata: { trace_id: "abc" },
		});
		await bridge.observeTurn({
			userText: "hello",
			assistantText: "hi",
			metadata: {},
		});

		expect(calls[0]?.args.metadata).toEqual({ trace_id: "abc" });
		expect(calls[1]?.args).not.toHaveProperty("metadata");
	});

	it("swallows transport errors so the agent loop is never blocked", async () => {
		const transport: ObserverBridgeMCPTransport = {
			async callTool() {
				throw new Error("simulated transport failure");
			},
		};
		const bridge = new MCPObserverBridge(transport);

		await expect(
			bridge.observeTurn({
				userText: "hello",
				assistantText: "world",
				sessionId: "session-A",
			}),
		).resolves.toBeUndefined();
	});

	it("treats empty transport response as no-op (does not throw)", async () => {
		const { calls, transport } = createTransport(null);
		const bridge = new MCPObserverBridge(transport);

		await bridge.observeTurn({
			userText: "hello",
			assistantText: "world",
		});

		// One call still went out; bridge just doesn't try to parse anything.
		expect(calls).toHaveLength(1);
	});

	it("preserves session_id across multiple turns", async () => {
		const { calls, transport } = createTransport(
			JSON.stringify({ candidates: [] }),
		);
		const bridge = new MCPObserverBridge(transport);

		await bridge.observeTurn({
			userText: "turn 1",
			assistantText: "ack 1",
			sessionId: "session-A",
		});
		await bridge.observeTurn({
			userText: "turn 2",
			assistantText: "ack 2",
			sessionId: "session-A",
		});
		await bridge.observeTurn({
			userText: "turn 3",
			assistantText: "ack 3",
			sessionId: "session-A",
		});

		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(call.args.session_id).toBe("session-A");
		}
	});

	it("skips both empty user_text and empty assistant_text", async () => {
		const callTool = vi.fn().mockResolvedValue("");
		const bridge = new MCPObserverBridge({ callTool });

		await bridge.observeTurn({
			userText: "",
			assistantText: "",
			sessionId: "session-A",
		});

		expect(callTool).not.toHaveBeenCalled();
	});

	it("logs but does not throw on non-Error rejection values", async () => {
		const transport: ObserverBridgeMCPTransport = {
			async callTool() {
				// biome-ignore lint/suspicious/noExplicitAny: simulate string rejection
				throw "string-failure" as any;
			},
		};
		const bridge = new MCPObserverBridge(transport);

		await expect(
			bridge.observeTurn({
				userText: "hello",
				assistantText: "world",
			}),
		).resolves.toBeUndefined();
	});
});

describe("NullObserverBridge", () => {
	it("does nothing", async () => {
		const bridge = new NullObserverBridge();
		await expect(
			bridge.observeTurn({
				userText: "hello",
				assistantText: "world",
				sessionId: "session-A",
			}),
		).resolves.toBeUndefined();
	});
});

describe("createObserverBridgeIfEnabled", () => {
	const { transport } = createTransport(JSON.stringify({ candidates: [] }));

	it("returns undefined when enabled=false even with api keys + transport", () => {
		expect(
			createObserverBridgeIfEnabled({
				enabled: false,
				observerApiKey: "k1",
				deepseekApiKey: "k2",
				transport,
			}),
		).toBeUndefined();
	});

	it("returns undefined when enabled=true but no api key is present", () => {
		expect(
			createObserverBridgeIfEnabled({
				enabled: true,
				transport,
			}),
		).toBeUndefined();
		expect(
			createObserverBridgeIfEnabled({
				enabled: true,
				observerApiKey: "",
				deepseekApiKey: "",
				transport,
			}),
		).toBeUndefined();
	});

	it("returns undefined when enabled+api key but transport not yet ready", () => {
		expect(
			createObserverBridgeIfEnabled({
				enabled: true,
				observerApiKey: "k1",
			}),
		).toBeUndefined();
	});

	it("returns an MCPObserverBridge when all gates pass with QUILIN_OBSERVER_API_KEY", () => {
		const bridge = createObserverBridgeIfEnabled({
			enabled: true,
			observerApiKey: "k1",
			transport,
		});
		expect(bridge).toBeInstanceOf(MCPObserverBridge);
	});

	it("returns an MCPObserverBridge when DEEPSEEK_API_KEY alone is present", () => {
		const bridge = createObserverBridgeIfEnabled({
			enabled: true,
			deepseekApiKey: "k2",
			transport,
		});
		expect(bridge).toBeInstanceOf(MCPObserverBridge);
	});

	it("constructed bridge can call memory_observe through the transport", async () => {
		const { calls, transport: t } = createTransport(
			JSON.stringify({ candidates: [] }),
		);
		const bridge = createObserverBridgeIfEnabled({
			enabled: true,
			observerApiKey: "k1",
			transport: t,
		});
		expect(bridge).toBeInstanceOf(MCPObserverBridge);
		await bridge?.observeTurn({
			userText: "hi",
			assistantText: "ok",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("memory_observe");
	});
});
