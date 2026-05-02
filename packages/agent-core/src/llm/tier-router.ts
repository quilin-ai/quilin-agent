import type { AssembledPrompt } from "../context/prompt-types.js";
import type { Message } from "../state/types.js";
import type { Tool } from "../tools/types.js";
import type {
	LLMModelTier,
	LLMRoutingMode,
	LLMTierRouteSelection,
	LLMTierRoutingConfig,
} from "./types.js";

export interface LLMTierRouteInput {
	readonly messages: readonly Message[];
	readonly tools: readonly Tool[];
	readonly prompt?: AssembledPrompt;
}

const WRITE_OR_EXEC_TOOL_PATTERN =
	/(?:^|\/|_)(?:file_write|write|shell_exec|exec|skill_manage|scaffold|patch|delete|remove|apply|commit)(?:$|_)/iu;

const PRO_INTENT_PATTERN =
	/\b(?:implement|modify|edit|refactor|debug|fix|patch|write|delete|remove|commit|shell|execute|run tests?|security|permission|credential|secret|token|self[- ]?evolution|architecture|cross[- ]?file|multi[- ]?file)\b|实现|修改|编辑|重构|调试|修复|补丁|写入|删除|提交|执行|运行测试|安全|权限|密钥|令牌|自进化|架构|跨文件|多文件/u;

const LITE_INTENT_PATTERN =
	/\b(?:analy[sz]e|inspect|read|review|plan|compare|trace|search|lookup|explain code|summari[sz]e code|linear|status|tool|file|git)\b|分析|查看|读取|审查|计划|比较|追踪|搜索|查询|解释代码|总结代码|状态|工具|文件/u;

const FLASH_INTENT_PATTERN =
	/\b(?:summari[sz]e|rewrite|translate|format|explain|what is|what are|status|why|how do i)\b|总结|改写|翻译|格式|解释|是什么|为什么|怎么/u;

const TIER_RANK: Readonly<Record<LLMModelTier, number>> = {
	flash: 0,
	lite: 1,
	pro: 2,
};

function lastUserText(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") {
			return message.content;
		}
	}

	return "";
}

function hasToolResume(messages: readonly Message[]): boolean {
	return messages.some((message) => message.role === "tool");
}

function hasWriteOrExecToolHistory(messages: readonly Message[]): boolean {
	return messages.some(
		(message) =>
			message.role === "assistant" &&
			message.toolCalls?.some((toolCall) =>
				WRITE_OR_EXEC_TOOL_PATTERN.test(toolCall.name),
			) === true,
	);
}

function hasWriteOrExecToolAvailable(tools: readonly Tool[]): boolean {
	return tools.some((tool) => WRITE_OR_EXEC_TOOL_PATTERN.test(tool.name));
}

function estimateChars(input: LLMTierRouteInput): number {
	const messageChars = input.messages.reduce(
		(total, message) => total + message.content.length,
		0,
	);
	const promptChars =
		input.prompt?.segments.reduce(
			(total, segment) => total + segment.text.length,
			0,
		) ?? 0;
	return messageChars + promptChars;
}

function forcedTier(mode: LLMRoutingMode): LLMModelTier | null {
	return mode === "auto" ? null : mode;
}

function applyEscalationPolicy(
	routing: LLMTierRoutingConfig,
	selection: LLMTierRouteSelection,
): LLMTierRouteSelection {
	if (
		routing.allowEscalation ||
		TIER_RANK[selection.tier] <= TIER_RANK[routing.defaultTier]
	) {
		return selection;
	}

	return {
		tier: routing.defaultTier,
		mode: selection.mode,
		reason: `escalation_disabled_${selection.reason}`,
	};
}

function isShortNoToolTask(text: string, input: LLMTierRouteInput): boolean {
	return (
		text.length > 0 &&
		text.length <= 600 &&
		!hasToolResume(input.messages) &&
		!hasWriteOrExecToolHistory(input.messages) &&
		!PRO_INTENT_PATTERN.test(text) &&
		(FLASH_INTENT_PATTERN.test(text) || input.tools.length === 0)
	);
}

export function selectLLMModelTier(
	routing: LLMTierRoutingConfig,
	input: LLMTierRouteInput,
): LLMTierRouteSelection {
	const forced = forcedTier(routing.mode);
	if (forced != null) {
		return {
			tier: forced,
			mode: routing.mode,
			reason: `forced_${forced}`,
		};
	}

	const text = lastUserText(input.messages);
	const lowerText = text.toLowerCase();
	const totalChars = estimateChars(input);
	const select = (tier: LLMModelTier, reason: string): LLMTierRouteSelection =>
		applyEscalationPolicy(routing, { tier, mode: "auto", reason });

	if (hasWriteOrExecToolHistory(input.messages)) {
		return select("pro", "write_or_exec_tool_resume");
	}

	if (PRO_INTENT_PATTERN.test(lowerText)) {
		return select("pro", "high_complexity_or_risk");
	}

	if (totalChars > 32_000) {
		return select("pro", "large_context");
	}

	if (hasToolResume(input.messages)) {
		return select("lite", "tool_resume");
	}

	if (totalChars > 8_000) {
		return select("lite", "medium_context");
	}

	if (LITE_INTENT_PATTERN.test(lowerText)) {
		return select("lite", "agentic_read_or_tool_intent");
	}

	if (isShortNoToolTask(lowerText, input)) {
		return select("flash", "short_low_risk_no_tool");
	}

	if (hasWriteOrExecToolAvailable(input.tools) && text.length > 900) {
		return select("lite", "tool_available_medium_task");
	}

	return select(routing.defaultTier, "default_tier");
}
