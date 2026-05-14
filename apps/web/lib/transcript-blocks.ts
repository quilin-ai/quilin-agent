export interface RawPart {
	readonly type: string;
	readonly text?: string;
	readonly toolName?: string;
	readonly toolCallId?: string;
	readonly state?: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly errorText?: string;
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

export type TranscriptBlock = ProcessBlock | TextBlock;

export function isReasoningPart(p: RawPart): boolean {
	return p.type === "reasoning";
}

export function isToolPart(p: RawPart): boolean {
	return p.type.startsWith("tool-") || p.type === "dynamic-tool";
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

	for (const part of dedupeRenderableParts(parts)) {
		if (part.type === "text" && typeof part.text === "string") {
			flushProcess();
			appendText(part.text);
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
