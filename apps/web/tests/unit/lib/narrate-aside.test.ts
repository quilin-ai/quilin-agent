/**
 * Unit tests for `narrate_aside` tool — Iter F Slice 4 aside emitter.
 */

import { describe, expect, it } from "vitest";
import type { AgentServiceLike } from "@/lib/agent-service-client";
import { makeNarrateAsideTool } from "@/lib/tools/narrate-aside";

function makeFakeService(): {
	service: AgentServiceLike;
	emitted: Array<{ sessionId: string; payload: unknown }>;
} {
	const emitted: Array<{ sessionId: string; payload: unknown }> = [];
	const service = {
		emitFromRunner: (sessionId: string, payload: unknown) => {
			emitted.push({ sessionId, payload });
		},
	} as unknown as AgentServiceLike;
	return { service, emitted };
}

describe("makeNarrateAsideTool", () => {
	it("emits an aside event with default normal weight", async () => {
		const { service, emitted } = makeFakeService();
		const t = makeNarrateAsideTool({ sessionId: "s-1", service });
		const result = await (t.execute as NonNullable<typeof t.execute>)(
			{ text: "我刚才忽略了一个边界" },
			{ toolCallId: "tc-1", messages: [] },
		);
		expect(emitted).toHaveLength(1);
		const payload = emitted[0]?.payload as Record<string, unknown>;
		expect(payload.type).toBe("aside");
		expect(payload.text).toBe("我刚才忽略了一个边界");
		expect(payload.weight).toBeUndefined(); // not set → default normal at UI side
		expect(result).toContain("aside_emitted");
	});

	it("passes through explicit weight=low", async () => {
		const { service, emitted } = makeFakeService();
		const t = makeNarrateAsideTool({ sessionId: "s-2", service });
		await (t.execute as NonNullable<typeof t.execute>)(
			{ text: "进度: 3/5 来源已核对", weight: "low" },
			{ toolCallId: "tc-2", messages: [] },
		);
		const payload = emitted[0]?.payload as Record<string, unknown>;
		expect(payload.weight).toBe("low");
	});

	it("rejects empty text at schema validation", async () => {
		const { service } = makeFakeService();
		const t = makeNarrateAsideTool({ sessionId: "s", service });
		await expect(
			(t.execute as NonNullable<typeof t.execute>)(
				{ text: "" },
				{ toolCallId: "tc-3", messages: [] },
			),
		).rejects.toThrow();
	});

	it("rejects text over 500 chars", async () => {
		const { service } = makeFakeService();
		const t = makeNarrateAsideTool({ sessionId: "s", service });
		await expect(
			(t.execute as NonNullable<typeof t.execute>)(
				{ text: "x".repeat(501) },
				{ toolCallId: "tc-4", messages: [] },
			),
		).rejects.toThrow();
	});

	it("rejects invalid weight", async () => {
		const { service } = makeFakeService();
		const t = makeNarrateAsideTool({ sessionId: "s", service });
		await expect(
			(t.execute as NonNullable<typeof t.execute>)(
				// biome-ignore lint/suspicious/noExplicitAny: deliberately bad
				{ text: "hi", weight: "huge" } as any,
				{ toolCallId: "tc-5", messages: [] },
			),
		).rejects.toThrow();
	});
});
