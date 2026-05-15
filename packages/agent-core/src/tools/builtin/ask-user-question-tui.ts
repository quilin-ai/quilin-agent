/**
 * `ask_user_question` agent-core tool — TUI variant for Slice 3c.
 *
 * The web-side `makeAskUserQuestionTool` (apps/web/lib/tools/ask-user-question.ts)
 * uses an SSE event + pending-asks registry + InlineQuestion UI to round-trip
 * an answer from the browser back to the LLM. That wire doesn't reach the TUI
 * because pending-asks lives in the web Node process and the TUI is a
 * separate process.
 *
 * This TUI-native variant short-circuits the entire wire: the tool handler
 * prompts directly on the TUI's stdin via Node `readline`. No SSE, no
 * registry, no IPC. The factory takes io streams as deps so tests pass
 * mocks. Mode parsing matches the spec contract:
 *   - single → user types the number (1-indexed) of the chosen option
 *   - multi  → user types comma-separated numbers
 *   - free_text → user types the free-form answer
 *
 * Empty input + Ctrl-C / Ctrl-D both surface as `mode=timeout` so the
 * LLM contract is identical to the web path.
 *
 * Slice 3c TUI 实现:不走 IPC,直接 readline 提示 + 解析。同一进程内的
 * agent loop tool 调 readline,得到答案后返回给 LLM。Empty / Ctrl-C / Ctrl-D
 * 折成 timeout,跟 web 端一致。
 */

import { createInterface } from "node:readline";
import { z } from "zod";
import type { ToolResult } from "../types.js";
import type { ToolWithMetadata } from "../tool-metadata.js";

const MAX_QUESTION_CHARS = 2000;
const MAX_OPTIONS = 8;
const MAX_OPTION_LABEL_CHARS = 200;
const MAX_OPTION_DESCRIPTION_CHARS = 500;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const optionSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9_-]+$/, "id must be alphanumeric / underscore / dash only"),
	label: z.string().min(1).max(MAX_OPTION_LABEL_CHARS),
	description: z.string().max(MAX_OPTION_DESCRIPTION_CHARS).optional(),
});

export const askUserQuestionTuiParametersSchema = z
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

export type AskUserQuestionTuiInput = z.infer<typeof askUserQuestionTuiParametersSchema>;

export type TuiAnswer =
	| { readonly mode: "single"; readonly selectedId: string }
	| { readonly mode: "multi"; readonly selectedIds: readonly string[] }
	| { readonly mode: "free_text"; readonly text: string }
	| { readonly mode: "timeout" };

/** Stream / readline injection for tests. */
export interface AskUserQuestionTuiToolOptions {
	readonly stdin?: NodeJS.ReadStream;
	readonly stdout?: NodeJS.WriteStream;
	readonly stderr?: NodeJS.WriteStream;
	/** Test seam: replaces the real readline prompt. Receives the
	 *  rendered question + options, returns the raw user input string,
	 *  or null for timeout / Ctrl-C / Ctrl-D / EOF. */
	readonly promptOverride?: (rendered: string, timeoutMs: number) => Promise<string | null>;
}

function renderPrompt(input: AskUserQuestionTuiInput): string {
	const lines: string[] = [];
	lines.push(`\n❓ ${input.question}`);
	if (input.mode === "single") {
		input.options?.forEach((o, i) => {
			const marker = input.defaultId === o.id ? " [default]" : "";
			lines.push(
				`  [${i + 1}] ${o.label}${marker}${o.description ? ` — ${o.description}` : ""}`,
			);
		});
		lines.push("Enter the number of your choice (or empty for timeout):");
	} else if (input.mode === "multi") {
		input.options?.forEach((o, i) => {
			lines.push(`  [${i + 1}] ${o.label}${o.description ? ` — ${o.description}` : ""}`);
		});
		lines.push("Enter comma-separated numbers (e.g. 1,3) or empty for timeout:");
	} else {
		lines.push("Enter your answer (or empty for timeout):");
	}
	return `${lines.join("\n")}\n> `;
}

function defaultPrompt(
	stdin: NodeJS.ReadStream,
	stdout: NodeJS.WriteStream,
	rendered: string,
	timeoutMs: number,
): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		const rl = createInterface({ input: stdin, output: stdout });
		const timer = setTimeout(() => {
			rl.close();
			resolve(null);
		}, timeoutMs);
		rl.question(rendered, (answer) => {
			clearTimeout(timer);
			rl.close();
			resolve(answer);
		});
		rl.on("close", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
}

/** Convert raw stdin input into a structured TuiAnswer. Returns null
 *  on malformed input so the caller can surface a re-prompt or timeout. */
export function parseRawAnswer(
	raw: string | null,
	input: AskUserQuestionTuiInput,
): TuiAnswer {
	if (raw == null) return { mode: "timeout" };
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { mode: "timeout" };

	if (input.mode === "free_text") {
		return { mode: "free_text", text: trimmed };
	}

	if (input.mode === "single") {
		const num = Number.parseInt(trimmed, 10);
		const options = input.options ?? [];
		if (!Number.isFinite(num) || num < 1 || num > options.length) {
			return { mode: "timeout" };
		}
		const selected = options[num - 1];
		if (selected == null) return { mode: "timeout" };
		return { mode: "single", selectedId: selected.id };
	}

	// mode === "multi"
	const options = input.options ?? [];
	const nums = trimmed
		.split(/[,\s]+/)
		.filter((s) => s.length > 0)
		.map((s) => Number.parseInt(s, 10));
	if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n < 1 || n > options.length)) {
		return { mode: "timeout" };
	}
	const selectedIds = nums.map((n) => {
		const opt = options[n - 1];
		return opt == null ? null : opt.id;
	});
	if (selectedIds.some((id) => id == null)) return { mode: "timeout" };
	return { mode: "multi", selectedIds: selectedIds as readonly string[] };
}

/** Format the parsed answer into the same LLM-facing shape the web
 *  variant uses (formatReplyForLlm in apps/web/lib/tools/ask-user-question.ts).
 *  Kept exported for tests. */
export function formatTuiAnswerForLlm(
	answer: TuiAnswer,
	input: AskUserQuestionTuiInput,
): string {
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
			const _unreachable: never = answer;
			return `user_answered mode=unknown raw=${JSON.stringify(_unreachable)}`;
		}
	}
}

export function createAskUserQuestionTuiTool(
	options: AskUserQuestionTuiToolOptions = {},
): ToolWithMetadata {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const prompt = options.promptOverride;

	return {
		name: "ask_user_question",
		description:
			"在 TUI 中向用户提问并等待回答。三种模式:single(单选,带 options)、multi(多选,带 options)、" +
			"free_text(自由文本)。空回复或超时(默认 5 分钟)折成 timeout。用于真的需要用户拍板的场景,不要滥用。",
		category: "interactive",
		riskLevel: "read",
		parameters: askUserQuestionTuiParametersSchema,
		async execute(args: unknown): Promise<ToolResult> {
			let input: AskUserQuestionTuiInput;
			try {
				input = askUserQuestionTuiParametersSchema.parse(args);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					toolCallId: "ask_user_question",
					content: `ask_user_question invalid input: ${msg}`,
					isError: true,
					error: { code: "invalid_arguments", message: msg },
				};
			}

			const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const rendered = renderPrompt(input);
			stderr.write(rendered);

			let raw: string | null;
			if (prompt != null) {
				raw = await prompt(rendered, timeoutMs);
			} else {
				raw = await defaultPrompt(stdin, stdout, "", timeoutMs);
			}

			const answer = parseRawAnswer(raw, input);
			const content = formatTuiAnswerForLlm(answer, input);
			return {
				toolCallId: "ask_user_question",
				content,
				isError: false,
			};
		},
	};
}
