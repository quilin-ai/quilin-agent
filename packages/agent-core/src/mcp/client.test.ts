import type { Client } from "@modelcontextprotocol/sdk/client";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMCPCapabilities } from "./client.js";

interface RegisteredHandler {
	readonly schema: unknown;
	readonly handler: (req: { params: unknown }, extra: unknown) => unknown;
}

function makeFakeClient(): {
	client: Client;
	registered: RegisteredHandler[];
	listPrompts: ReturnType<typeof vi.fn>;
	getPrompt: ReturnType<typeof vi.fn>;
} {
	const registered: RegisteredHandler[] = [];
	const listPrompts = vi.fn(async () => ({
		prompts: [{ name: "p1" }],
	}));
	const getPrompt = vi.fn(async () => ({
		messages: [
			{
				role: "user" as const,
				content: { type: "text" as const, text: "hi" },
			},
		],
	}));
	const fake = {
		listPrompts,
		getPrompt,
		setRequestHandler: (schema: unknown, handler: unknown) => {
			registered.push({
				schema,
				handler: handler as RegisteredHandler["handler"],
			});
		},
	};
	return {
		client: fake as unknown as Client,
		registered,
		listPrompts,
		getPrompt,
	};
}

describe("createMCPCapabilities", () => {
	it("does not register elicitation handler when option is omitted", () => {
		const { client, registered } = makeFakeClient();
		const caps = createMCPCapabilities(client);
		expect(caps.elicitationHandlerRegistered).toBe(false);
		expect(registered).toHaveLength(0);
	});

	it("registers elicitation handler when resolver option is provided", () => {
		const { client, registered } = makeFakeClient();
		const caps = createMCPCapabilities(client, {
			elicitation: { resolver: () => ({ action: "decline" }) },
		});
		expect(caps.elicitationHandlerRegistered).toBe(true);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.schema).toBe(ElicitRequestSchema);
	});

	it("exposes listPrompts pass-through that calls the underlying client", async () => {
		const { client, listPrompts } = makeFakeClient();
		const caps = createMCPCapabilities(client);
		const result = await caps.listPrompts();
		expect(result.ok).toBe(true);
		expect(listPrompts).toHaveBeenCalledTimes(1);
	});

	it("exposes getPrompt pass-through with optional args", async () => {
		const { client, getPrompt } = makeFakeClient();
		const caps = createMCPCapabilities(client);

		await caps.getPrompt("p1");
		expect(getPrompt).toHaveBeenLastCalledWith(
			{ name: "p1" },
			expect.objectContaining({ timeout: expect.any(Number) }),
		);

		await caps.getPrompt("p1", { foo: "bar" });
		expect(getPrompt).toHaveBeenLastCalledWith(
			{ name: "p1", arguments: { foo: "bar" } },
			expect.objectContaining({ timeout: expect.any(Number) }),
		);
	});

	it("forwards prompts options to the underlying PromptsClient", async () => {
		const { client, listPrompts } = makeFakeClient();
		const caps = createMCPCapabilities(client, {
			prompts: { timeoutMs: 1234, isConnected: () => true },
		});
		await caps.listPrompts({ cursor: "abc" });
		expect(listPrompts).toHaveBeenCalledWith(
			{ cursor: "abc" },
			{ timeout: 1234 },
		);
	});

	it("returns a stable PromptsClient instance via the .prompts handle", async () => {
		const { client } = makeFakeClient();
		const caps = createMCPCapabilities(client);
		const direct = await caps.prompts.listPrompts();
		const via = await caps.listPrompts();
		expect(direct.ok).toBe(via.ok);
	});

	it("invokes the registered elicitation handler and returns cancel on resolver error", async () => {
		const { client, registered } = makeFakeClient();
		createMCPCapabilities(client, {
			elicitation: {
				resolver: () => {
					throw new Error("nope");
				},
			},
		});
		const first = registered[0];
		if (first === undefined) {
			throw new Error("expected elicitation handler to be registered");
		}
		const result = await first.handler(
			{
				params: {
					message: "test",
					requestedSchema: { type: "object", properties: {} },
				},
			},
			{},
		);
		expect(result).toEqual({ action: "cancel" });
	});
});
