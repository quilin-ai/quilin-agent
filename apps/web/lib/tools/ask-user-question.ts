/**
 * `ask_user_question` tool — Iter F 交互 primitives Slice 3a.
 *
 * Lets the LLM pause execution and ask the human a structured question
 * (single-choice / multi-choice / free text), then resume with the
 * answer baked into the next LLM step. Wire end-to-end:
 *
 * 1. LLM calls this tool with `{question, mode, options?, defaultId?, timeoutMs?}`.
 * 2. Tool generates an `askId`, emits an `ask_user_question` event into
 *    AgentService so the SSE/UI sees an `InlineQuestion` block.
 * 3. Tool calls `registerAsk(...)` → returns a `Promise<AgentReplyPayload>`.
 * 4. User clicks an option in `InlineQuestion`; the UI POSTs to
 *    `/api/chat/answer`, which calls `resolveAsk(...)` and unblocks (3).
 * 5. Tool formats the reply into a string the LLM can read and returns
 *    it as the tool result.
 *
 * Timeout: if the user doesn't reply within `timeoutMs` (default 5
 * minutes), the registry resolves with a synthetic `{mode: "timeout"}`
 * reply so the agent doesn't block forever. The tool surfaces this as
 * an explicit "user did not answer" message rather than an error so the
 * LLM can decide whether to retry or proceed with defaults.
 *
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §3-§5
 *
 * 交互 primitives Slice 3a:LLM 通过本工具暂停并向用户提一个结构化问题
 * (单选 / 多选 / 自由文本),用户在 web 端 `InlineQuestion` 组件点选后,
 * 答案回到 LLM 上下文继续。整个 wire 已在 Slice 1/2 拉好,本工具只是
 * 触发端 + 接收端的胶水。
 */

import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import type { AgentReplyPayload, AgentServiceLike } from "@/lib/agent-service-client";
import { registerAsk } from "@/lib/pending-asks";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_QUESTION_CHARS = 2000;
const MAX_OPTIONS = 8;
const MAX_OPTION_LABEL_CHARS = 200;
const MAX_OPTION_DESCRIPTION_CHARS = 500;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

const optionSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9_-]+$/, "id must be alphanumeric / underscore / dash only"),
	label: z.string().min(1).max(MAX_OPTION_LABEL_CHARS),
	description: z.string().max(MAX_OPTION_DESCRIPTION_CHARS).optional(),
});

const askInputSchema = z
	.object({
		question: z.string().min(1).max(MAX_QUESTION_CHARS),
		mode: z.enum(["single", "multi", "free_text"]),
		options: z.array(optionSchema).min(1).max(MAX_OPTIONS).optional(),
		defaultId: z.string().max(64).optional(),
		timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
	})
	.superRefine((data, ctx) => {
		const needsOptions = data.mode === "single" || data.mode === "multi";
		if (needsOptions && (data.options == null || data.options.length === 0)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `mode "${data.mode}" requires non-empty options`,
				path: ["options"],
			});
		}
		if (data.mode === "free_text" && data.options != null && data.options.length > 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'mode "free_text" must not include options',
				path: ["options"],
			});
		}
		if (data.defaultId != null) {
			if (data.options == null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `defaultId is meaningless when no options are provided (mode "${data.mode}")`,
					path: ["defaultId"],
				});
			} else {
				const valid = data.options.some((o) => o.id === data.defaultId);
				if (!valid) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `defaultId "${data.defaultId}" must match one of options[].id`,
						path: ["defaultId"],
					});
				}
			}
		}
	});

export type AskUserQuestionInput = z.infer<typeof askInputSchema>;

export interface MakeAskUserQuestionToolDeps {
	readonly sessionId: string;
	readonly service: AgentServiceLike;
	/** Override for tests; production uses {@link registerAsk} from pending-asks. */
	readonly awaitAsk?: typeof registerAsk;
	/** Override for tests; production uses Node's crypto.randomUUID. */
	readonly generateAskId?: () => string;
}

export function makeAskUserQuestionTool(deps: MakeAskUserQuestionToolDeps) {
	const awaitAsk = deps.awaitAsk ?? registerAsk;
	const generateAskId = deps.generateAskId ?? randomUUID;
	return tool({
		description:
			"向用户提一个问题并暂停等待回答,适用于需要用户决策才能继续的场景。" +
			"三种模式:single(单选,必带 options)、multi(多选,必带 options)、" +
			"free_text(自由文本,不带 options)。每个 option 必须有 id(短字符串) + label(展示文本),可选 description。" +
			"用户在 web 界面点选后会返回结构化答案;5 分钟内不回则返回 timeout。" +
			"使用场景:需要在多个明确方案中让用户拍板、需要敏感操作的人工确认、需要补充未提供的关键信息。" +
			"不要滥用——能从上下文推断或合理默认时不要打断用户。",
		inputSchema: askInputSchema,
		execute: async (rawInput: unknown) => {
			// Defensive re-validation so the tool fails fast and predictably
			// even when called outside of an AI-SDK runtime (e.g., direct
			// test invocation). When called via AI SDK, the schema also runs
			// upstream; both paths produce the same error shape.
			const input = askInputSchema.parse(rawInput);
			const askId = generateAskId();
			const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			// Register FIRST so the askToken exists before we emit the SSE
			// event — the client needs the token to be able to answer.
			const { askToken, reply: replyPromise } = awaitAsk({
				sessionId: deps.sessionId,
				askId,
				kind: "user_answered_question",
				timeoutMs,
			});

			deps.service.emitFromRunner(deps.sessionId, {
				type: "ask_user_question",
				askId,
				askToken,
				question: input.question,
				mode: input.mode,
				options: input.options,
				defaultId: input.defaultId,
				timeoutMs,
			});

			const reply: AgentReplyPayload = await replyPromise;
			return formatReplyForLlm(reply, input);
		},
	});
}

/**
 * Format the user's reply into a compact, deterministic string the LLM
 * can read. The shape always says "user_answered" then a structured
 * body so the LLM doesn't need to parse JSON; we keep punctuation
 * stable across modes for prompt-engineering consistency.
 *
 * @internal exported for tests
 */
export function formatReplyForLlm(reply: AgentReplyPayload, input: AskUserQuestionInput): string {
	if (reply.kind !== "user_answered_question") {
		return `user_answered status=unexpected kind=${reply.kind}`;
	}
	const answer = reply.answer;
	switch (answer.mode) {
		case "single": {
			const opt = input.options?.find((o) => o.id === answer.selectedId);
			const label = opt?.label ?? answer.selectedId;
			return `user_answered mode=single selected_id=${answer.selectedId} label=${JSON.stringify(label)}`;
		}
		case "multi": {
			const labels = answer.selectedIds.map((id) => {
				const opt = input.options?.find((o) => o.id === id);
				return opt?.label ?? id;
			});
			return (
				`user_answered mode=multi selected_ids=${JSON.stringify(answer.selectedIds)} ` +
				`labels=${JSON.stringify(labels)}`
			);
		}
		case "free_text":
			return `user_answered mode=free_text text=${JSON.stringify(answer.text)}`;
		case "timeout":
			return "user_answered mode=timeout note=用户在超时窗口内未回应,请基于上下文做合理默认或重新组织问题";
		default: {
			// Exhaustiveness check — if AgentReplyPayload gains a new `answer.mode`
			// variant, the TS compiler will flag `_unreachable` as non-`never` here,
			// forcing the dev to extend this switch instead of silently returning
			// `undefined` (which would corrupt the LLM tool-result string).
			const _unreachable: never = answer;
			return `user_answered mode=unknown raw=${JSON.stringify(_unreachable)}`;
		}
	}
}
