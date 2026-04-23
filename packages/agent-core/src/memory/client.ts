import type { MemoryItem, MemoryLayer } from "./types.js";

export interface MemoryRecallOptions {
	readonly limit?: number;
	readonly layer?: MemoryLayer;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryClient {
	recall(
		query: string,
		options?: MemoryRecallOptions,
	): Promise<ReadonlyArray<MemoryItem>>;
	store(item: MemoryItem): Promise<void>;
}

export class NullMemoryClient implements MemoryClient {
	async recall(
		_query: string,
		_options: MemoryRecallOptions = {},
	): Promise<ReadonlyArray<MemoryItem>> {
		return [];
	}

	async store(_item: MemoryItem): Promise<void> {}
}
