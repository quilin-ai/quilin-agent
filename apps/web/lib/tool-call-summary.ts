import {
	type ProcessBlock,
	type RawPart,
	type ToolGroupItem,
	toolNameOf,
} from "@/lib/transcript-blocks";

const CALL_SUMMARY_MAX = 140;
const PROCESS_TITLE_MAX = 92;

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
	const normalized = normalizeText(value);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
	const value = record?.[key];
	return typeof value === "string" && normalizeText(value).length > 0 ? normalizeText(value) : null;
}

function arrayField(
	record: Record<string, unknown> | null,
	key: string,
): readonly unknown[] | null {
	const value = record?.[key];
	return Array.isArray(value) ? value : null;
}

/**
 * Recursive field walk caps at depth 4 — Round 4 RECOMMEND fix. Real
 * tool input depth is ≤ 3 (request → params → key), so 4 is defensive
 * without losing reach. Without the cap, a pathological deeply-nested
 * object could overflow the JS call stack.
 *
 * Recursive walk with depth ≤ 4 — protects against pathologically
 * nested input objects exhausting the JS stack.
 */
function firstStringField(
	record: Record<string, unknown> | null,
	keys: readonly string[],
	depth = 0,
): { readonly key: string; readonly value: string } | null {
	if (record == null || depth > 4) return null;
	for (const key of keys) {
		const value = stringField(record, key);
		if (value != null) return { key, value };
	}
	for (const nestedKey of ["request", "params", "args", "body", "payload"]) {
		const nested = asRecord(record[nestedKey]);
		const found = firstStringField(nested, keys, depth + 1);
		if (found != null) return found;
	}
	return null;
}

function jsonPreview(value: unknown): string | null {
	if (value == null) return null;
	try {
		const text = JSON.stringify(value);
		if (text == null || text === "{}" || text === "[]") return null;
		return truncateText(text, CALL_SUMMARY_MAX);
	} catch {
		return null;
	}
}

function labelForField(key: string): string {
	switch (key) {
		case "cmd":
		case "command":
			return "command";
		case "q":
		case "query":
			return "query";
		case "task":
			return "task";
		case "url":
			return "url";
		default:
			return key;
	}
}

function summaryFromField(field: { readonly key: string; readonly value: string }): string {
	return truncateText(`${labelForField(field.key)}：${field.value}`, CALL_SUMMARY_MAX);
}

function waitForSubagentsSummary(agentCount: number, state: string | undefined): string {
	if (state === "output-available") return `${agentCount} 个子代理已完成`;
	if (state === "output-error") return `${agentCount} 个子代理等待失败`;
	return `等待 ${agentCount} 个子代理完成`;
}

export function summarizeToolCall(part: RawPart): string {
	const name = toolNameOf(part);
	const input = asRecord(part.input);
	const output = asRecord(part.output);
	const genericKeys = [
		"query",
		"q",
		"url",
		"task",
		"prompt",
		"message",
		"command",
		"cmd",
		"path",
		"file",
		"selector",
		"title",
	] as const;

	if (name === "wait_for_subagents") {
		const agentIds = arrayField(input, "agentIds");
		if (agentIds != null && agentIds.length > 0) {
			return waitForSubagentsSummary(agentIds.length, part.state);
		}
	}

	if (name === "spawn_subagent") {
		const task =
			firstStringField(output, ["task", "query", "prompt", "message"]) ??
			firstStringField(input, ["task", "query", "prompt", "message"]);
		const displayName = stringField(output, "displayName") ?? stringField(input, "displayName");
		if (task != null && displayName != null) {
			return truncateText(`${displayName}：${task.value}`, CALL_SUMMARY_MAX);
		}
		if (task != null) return summaryFromField(task);
		if (displayName != null) return truncateText(displayName, CALL_SUMMARY_MAX);
	}

	if (name.includes("fetch")) {
		const url = firstStringField(input, ["url", "query", "q"]);
		if (url != null) return summaryFromField(url);
	}

	if (name.includes("search")) {
		const query = firstStringField(input, ["query", "q", "url"]);
		if (query != null) return summaryFromField(query);
	}

	const direct = firstStringField(input, genericKeys);
	if (direct != null) return summaryFromField(direct);

	const outputHint = firstStringField(output, ["query", "q", "url", "task", "title", "path"]);
	if (outputHint != null) return summaryFromField(outputHint);

	return jsonPreview(part.input) ?? jsonPreview(part.output) ?? name;
}

function actionForToolGroup(item: ToolGroupItem): string {
	const name = item.name;
	const count = item.calls.length;
	if (name === "wait_for_subagents") {
		const first = item.calls[0];
		const firstInput = asRecord(first?.input);
		const agentIds = arrayField(firstInput, "agentIds");
		if (agentIds != null && agentIds.length > 0) {
			return waitForSubagentsSummary(agentIds.length, first?.state);
		}
		return "等待子代理完成";
	}
	if (name === "spawn_subagent") return count > 1 ? `派遣 ${count} 个子代理` : "派遣子代理";
	if (name.includes("web_fetch") || name.includes("fetch")) {
		return count > 1 ? `抓取 ${count} 个网页` : "抓取网页";
	}
	if (name.includes("search")) return count > 1 ? `搜索 ${count} 次` : "搜索";
	if (name.includes("shell") || name.includes("exec") || name.includes("bash")) {
		return count > 1 ? `执行 ${count} 条命令` : "执行命令";
	}
	if (name.includes("read")) return count > 1 ? `读取 ${count} 项` : "读取";
	if (name.includes("write") || name.includes("edit"))
		return count > 1 ? `修改 ${count} 项` : "修改";
	if (name.includes("memory") || name.includes("mem"))
		return count > 1 ? `检索 ${count} 段记忆` : "检索记忆";
	return count > 1 ? `调用 ${name} × ${count}` : `调用 ${name}`;
}

function summarizeToolGroupForTitle(item: ToolGroupItem): string {
	const action = actionForToolGroup(item);
	if (item.calls.length !== 1) return action;
	const first = item.calls[0];
	if (first == null) return action;
	const detail = summarizeToolCall(first).replace(/^[a-zA-Z_]+：/, "");
	if (detail === action) return action;
	return truncateText(`${action}：${detail}`, PROCESS_TITLE_MAX);
}

export function summarizeProcessBlock(block: ProcessBlock, running: boolean): string {
	const segments: string[] = [];
	if (block.items.some((item) => item.type === "reasoning")) segments.push("思考");
	for (const item of block.items) {
		if (item.type === "tool-group") segments.push(summarizeToolGroupForTitle(item));
	}
	if (segments.length === 0) return running ? "正在处理" : "处理完成";
	const visibleSegments = segments.slice(0, 2);
	const suffix = segments.length > visibleSegments.length ? ` 等 ${segments.length} 项` : "";
	const title = truncateText(`${visibleSegments.join(" + ")}${suffix}`, PROCESS_TITLE_MAX);
	return running ? `正在${title}` : title;
}
