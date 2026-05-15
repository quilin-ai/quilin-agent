/**
 * `narrate_aside` tool — Iter F 交互 primitives Slice 4 (aside).
 *
 * Lets the LLM emit a short, muted parenthetical to the UI without
 * derailing the main reply. Shown as an italic `AsidePart` block
 * between text/process segments. Use sparingly — this is the
 * "thinking aloud" channel, not a third text stream.
 *
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §3.2
 *
 * 交互 primitives 第 3 种 emitter:让 LLM 在主回答外吐一句旁白(自我
 * 反思 / 风险提示 / 进度感),UI 用 muted italic 渲染,与主体分离。
 * 节制使用 —— 主流程文字别走这条。
 */

import { tool } from "ai";
import { z } from "zod";
import type { AgentServiceLike } from "@/lib/agent-service-client";

const MAX_TEXT_CHARS = 500;

const inputSchema = z.object({
	text: z.string().min(1).max(MAX_TEXT_CHARS),
	weight: z.enum(["low", "normal"]).optional(),
});

export type NarrateAsideInput = z.infer<typeof inputSchema>;

export interface MakeNarrateAsideToolDeps {
	readonly sessionId: string;
	readonly service: AgentServiceLike;
}

export function makeNarrateAsideTool(deps: MakeNarrateAsideToolDeps) {
	return tool({
		description:
			"在主回答之外吐一句旁白,UI 会用 muted italic 渲染。适合:" +
			"自我反思(『我刚才忽略了 X』)、风险提示(『这步不可逆,我会先 dry run』)、" +
			"进度感(『查了 3 个来源,有 2 个一致』)。节制使用 —— 不要把主回答塞进 aside。" +
			"text 最长 500 字,weight=low 用更淡的颜色(默认 normal)。",
		inputSchema: inputSchema,
		execute: async (rawInput: unknown) => {
			const input = inputSchema.parse(rawInput);
			deps.service.emitFromRunner(deps.sessionId, {
				type: "aside",
				text: input.text,
				...(input.weight === undefined ? {} : { weight: input.weight }),
			});
			// Return value tells the LLM the aside was queued; the rendered
			// text is the visible result, so we keep this short.
			return `aside_emitted text=${JSON.stringify(input.text.slice(0, 80))}`;
		},
	});
}
