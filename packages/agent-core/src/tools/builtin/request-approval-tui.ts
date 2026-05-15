/**
 * `request_approval` agent-core tool — TUI variant for Slice 3c.
 *
 * Companion to the TUI `ask_user_question` tool. Where ask collects an
 * answer to a question, approval collects a decision (allow / deny /
 * allow_always_low / allow_always_medium). Same TUI-native pattern:
 * readline prompt directly, no SSE/IPC required.
 *
 * Path A advisory: the tool returns the user's decision to the LLM
 * but does not enforce anything. The LLM must respect the result.
 *
 * Slice 3c TUI 实现:本地 readline 拿决定。一次性 allow / 拒绝 / 永久
 * 白名单。空回复 / Ctrl-C / Ctrl-D 折成 deny 而不是 timeout —— 跟
 * web 端 `pending-asks.syntheticTimeoutReply` 对 user_decision 的
 * 处理一致(decision=deny, reason=timeout)。
 */

import { createInterface } from "node:readline";
import { z } from "zod";
import type { ToolResult } from "../types.js";
import type { ToolWithMetadata } from "../tool-metadata.js";

const MAX_TOOL_NAME_CHARS = 120;
const MAX_SUMMARY_CHARS = 1000;
const MAX_DETAIL_CHARS = 4000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export const requestApprovalTuiParametersSchema = z.object({
	tool: z
		.string()
		.min(1)
		.max(MAX_TOOL_NAME_CHARS)
		.regex(/^[a-zA-Z0-9_-]+$/, "tool name must be alphanumeric / underscore / dash only"),
	riskLevel: z.enum(["low", "medium", "high", "critical"]),
	summary: z.string().min(1).max(MAX_SUMMARY_CHARS),
	detail: z.string().max(MAX_DETAIL_CHARS).optional(),
	origin: z.enum(["user", "agent", "idle"]).default("agent"),
	timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
});

export type RequestApprovalTuiInput = z.infer<typeof requestApprovalTuiParametersSchema>;

export type TuiDecision = "allow" | "deny" | "allow_always_low" | "allow_always_medium";

export interface RequestApprovalTuiToolOptions {
	readonly stdin?: NodeJS.ReadStream;
	readonly stdout?: NodeJS.WriteStream;
	readonly stderr?: NodeJS.WriteStream;
	/** Test seam: replaces the real readline prompt. Returns the raw
	 *  user input string, or null for timeout / EOF. */
	readonly promptOverride?: (rendered: string, timeoutMs: number) => Promise<string | null>;
}

function renderPrompt(input: RequestApprovalTuiInput): string {
	const lines: string[] = [
		`\n🔐 approval requested: ${input.tool} (${input.riskLevel.toUpperCase()})`,
		`   ${input.summary}`,
	];
	if (input.detail != null && input.detail.length > 0) {
		lines.push(`   detail: ${input.detail}`);
	}
	lines.push("Decision:");
	lines.push("  [y] allow this once");
	lines.push("  [n] deny");
	if (input.riskLevel === "low" || input.riskLevel === "medium") {
		lines.push(`  [a] allow + always for ${input.riskLevel} risk this session`);
	}
	lines.push("(empty / Ctrl-C = deny)");
	return `${lines.join("\n")}\n> `;
}

/**
 * Map raw stdin input to a TuiDecision. Empty / null / unrecognized
 * input all map to `deny` — same as the web wire's synthetic
 * timeout-reply contract for user_decision.
 *
 * @internal exported for tests
 */
export function parseRawDecision(
	raw: string | null,
	input: RequestApprovalTuiInput,
): TuiDecision {
	if (raw == null) return "deny";
	const trimmed = raw.trim().toLowerCase();
	if (trimmed.length === 0) return "deny";
	if (trimmed === "y" || trimmed === "yes" || trimmed === "allow") return "allow";
	if (trimmed === "n" || trimmed === "no" || trimmed === "deny") return "deny";
	if (trimmed === "a" || trimmed === "always") {
		if (input.riskLevel === "low") return "allow_always_low";
		if (input.riskLevel === "medium") return "allow_always_medium";
		// 'always' on high / critical is not supported — fall back to allow-once
		return "allow";
	}
	return "deny";
}

/** @internal exported for tests */
export function formatDecisionForLlm(
	decision: TuiDecision,
	input: RequestApprovalTuiInput,
): string {
	switch (decision) {
		case "allow":
			return `user_decision decision=allow tool=${input.tool} risk=${input.riskLevel} note=一次性批准,执行后回报结果`;
		case "deny":
			return (
				`user_decision decision=deny tool=${input.tool} risk=${input.riskLevel} ` +
				`note=不要执行该工具,告知用户已被拒绝并询问下一步`
			);
		case "allow_always_low":
			return (
				`user_decision decision=allow_always_low tool=${input.tool} risk=${input.riskLevel} ` +
				`note=用户将本 session 内 low risk 全部加入白名单,后续 low risk 操作不需要再调 request_approval`
			);
		case "allow_always_medium":
			return (
				`user_decision decision=allow_always_medium tool=${input.tool} risk=${input.riskLevel} ` +
				`note=用户将本 session 内 low + medium risk 全部加入白名单,后续可直接执行`
			);
		default: {
			const _unreachable: never = decision;
			return `user_decision decision=unknown raw=${JSON.stringify(_unreachable)}`;
		}
	}
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

export function createRequestApprovalTuiTool(
	options: RequestApprovalTuiToolOptions = {},
): ToolWithMetadata {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const prompt = options.promptOverride;

	return {
		name: "request_approval",
		description:
			"TUI 中向用户请求一次性批准敏感 / 不可逆操作。allow / deny / allow_always_low (low risk) / allow_always_medium (low+medium)。" +
			"空回复 / Ctrl-C 折成 deny。⚠️ 路径 A 顾问式:服务端不强制执行,LLM 自律。",
		category: "interactive",
		riskLevel: "read",
		parameters: requestApprovalTuiParametersSchema,
		async execute(args: unknown): Promise<ToolResult> {
			let input: RequestApprovalTuiInput;
			try {
				input = requestApprovalTuiParametersSchema.parse(args);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					toolCallId: "request_approval",
					content: `request_approval invalid input: ${msg}`,
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

			const decision = parseRawDecision(raw, input);
			const content = formatDecisionForLlm(decision, input);
			return {
				toolCallId: "request_approval",
				content,
				isError: false,
			};
		},
	};
}
