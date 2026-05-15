export interface RawPart {
	readonly type: string;
	readonly text?: string;
	readonly toolName?: string;
	readonly toolCallId?: string;
	readonly state?: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly errorText?: string;
	/**
	 * AI SDK v6 custom data parts surface their payload here. Used by
	 * the Iter F interaction primitives (`data-ask` / `data-approval` /
	 * `data-aside`) — see InteractionBlock below + sse-translator.ts.
	 */
	readonly data?: unknown;
}

export interface ReasoningItem {
	readonly type: "reasoning";
	readonly part: RawPart;
}

export interface ToolGroupItem {
	readonly type: "tool-group";
	readonly name: string;
	readonly calls: readonly RawPart[];
}

export type ProcessItem = ReasoningItem | ToolGroupItem;

export interface ProcessBlock {
	readonly type: "process";
	readonly id: string;
	readonly items: readonly ProcessItem[];
}

export interface TextBlock {
	readonly type: "text";
	readonly id: string;
	readonly text: string;
}

/**
 * Iter F 交互 primitives — inline interaction blocks dispatched from
 * `data-ask` / `data-approval` / `data-aside` UIMessage parts.
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §3.2.
 */
export interface InteractionBlock {
	readonly type: "interaction";
	readonly id: string;
	readonly kind: "question" | "approval" | "aside";
	readonly data: unknown;
}

export type TranscriptBlock = ProcessBlock | TextBlock | InteractionBlock;

export function isReasoningPart(p: RawPart): boolean {
	return p.type === "reasoning";
}

/**
 * AI SDK v6 tool-part lifecycle states that mean "still in flight":
 * - `input-streaming`: tool args still being emitted by the LLM
 * - `input-available`: args complete, awaiting execute()
 * Anything else (`output-available`, `output-error`, missing) means
 * the call has terminated.
 *
 * 仍在 in-flight 的 tool part state(args 还在流 / 已结束等执行)。其他
 * 状态都视为已结束。
 */
const TOOL_RUNNING_STATES = new Set(["input-streaming", "input-available"]);

/**
 * True if this process block contains at least one tool call whose
 * state is still non-terminal — used by ConversationView to keep the
 * matching Process panel labelled "正在输出" / status="running" even
 * when subsequent transcript blocks have already streamed in.
 *
 * 用于 ConversationView 判断:某个 process block 内部还有正在跑的 tool
 * call 时,即使后面已经有新 block 来,本 block 仍应当展示 running 状态。
 */
export function processBlockHasRunningTool(block: ProcessBlock): boolean {
	for (const item of block.items) {
		if (item.type !== "tool-group") continue;
		for (const call of item.calls) {
			const state = call.state;
			if (typeof state === "string" && TOOL_RUNNING_STATES.has(state)) return true;
		}
	}
	return false;
}

export function isToolPart(p: RawPart): boolean {
	return p.type.startsWith("tool-") || p.type === "dynamic-tool";
}

export function isInteractionPart(p: RawPart): boolean {
	return p.type === "data-ask" || p.type === "data-approval" || p.type === "data-aside";
}

export function interactionKindOf(p: RawPart): "question" | "approval" | "aside" | null {
	if (p.type === "data-ask") return "question";
	if (p.type === "data-approval") return "approval";
	if (p.type === "data-aside") return "aside";
	return null;
}

export function toolNameOf(p: RawPart): string {
	if (p.toolName) return p.toolName;
	return p.type.replace(/^tool-/, "");
}

export function extractToolCallId(p: RawPart): string | null {
	if (typeof p.toolCallId === "string" && p.toolCallId.length > 0) {
		return p.toolCallId;
	}
	return null;
}

function dedupeRenderableParts(parts: readonly RawPart[]): readonly RawPart[] {
	const preferredToolById = new Map<string, RawPart>();
	for (const part of parts) {
		if (!isToolPart(part)) continue;
		const id = extractToolCallId(part);
		if (id == null) continue;
		const existing = preferredToolById.get(id);
		if (existing == null || (existing.type === "dynamic-tool" && part.type !== "dynamic-tool")) {
			preferredToolById.set(id, part);
		}
	}

	const emittedToolIds = new Set<string>();
	return parts.filter((part) => {
		if (!isToolPart(part)) return true;
		const id = extractToolCallId(part);
		if (id == null) return true;
		if (preferredToolById.get(id) !== part || emittedToolIds.has(id)) return false;
		emittedToolIds.add(id);
		return true;
	});
}

export function buildTranscriptBlocks(
	parts: readonly RawPart[],
	messageId: string,
): readonly TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	let processItems: ProcessItem[] = [];
	let processOrdinal = 0;
	let textOrdinal = 0;

	const flushProcess = (): void => {
		if (processItems.length === 0) return;
		processOrdinal += 1;
		blocks.push({
			type: "process",
			id: `${messageId}-process-${processOrdinal}`,
			items: processItems,
		});
		processItems = [];
	};

	const appendText = (text: string): void => {
		if (text.length === 0) return;
		const last = blocks[blocks.length - 1];
		if (last?.type === "text") {
			blocks[blocks.length - 1] = { ...last, text: `${last.text}${text}` };
			return;
		}
		textOrdinal += 1;
		blocks.push({
			type: "text",
			id: `${messageId}-text-${textOrdinal}`,
			text,
		});
	};

	let interactionOrdinal = 0;
	for (const part of dedupeRenderableParts(parts)) {
		if (part.type === "text" && typeof part.text === "string") {
			flushProcess();
			appendText(part.text);
			continue;
		}
		const interactionKind = interactionKindOf(part);
		if (interactionKind != null) {
			flushProcess();
			interactionOrdinal += 1;
			blocks.push({
				type: "interaction",
				id: `${messageId}-interaction-${interactionOrdinal}`,
				kind: interactionKind,
				data: part.data ?? {},
			});
			continue;
		}
		if (isReasoningPart(part)) {
			processItems.push({ type: "reasoning", part });
			continue;
		}
		if (isToolPart(part)) {
			const name = toolNameOf(part);
			const lastItem = processItems[processItems.length - 1];
			if (lastItem?.type === "tool-group" && lastItem.name === name) {
				processItems[processItems.length - 1] = {
					...lastItem,
					calls: [...lastItem.calls, part],
				};
			} else {
				processItems.push({ type: "tool-group", name, calls: [part] });
			}
		}
	}
	flushProcess();

	return blocks;
}

export function extractToolPartsFromBlocks(blocks: readonly TranscriptBlock[]): readonly RawPart[] {
	return blocks.flatMap((block) =>
		block.type === "process"
			? block.items.flatMap((item) => (item.type === "tool-group" ? item.calls : []))
			: [],
	);
}
