import type { MemoryClient, MemoryRecallOptions } from "./client.js";
import type { LocalMemoryItem } from "./local-backend.js";
import { LocalMemoryBackend } from "./local-backend.js";
import type { MemoryItem, MemoryMetadata } from "./types.js";

function toLocalItem(
	item: MemoryItem,
): Omit<LocalMemoryItem, "id"> & { readonly id: string } {
	const score = item.importance_score ?? item.metadata.score ?? 0;
	const timestamp = Date.parse(item.created_at) || Date.now();
	const metadata_json = JSON.stringify(item.metadata);

	return {
		id: item.id,
		content: item.content,
		layer: item.layer,
		score,
		timestamp,
		metadata_json,
	};
}

function toMemoryItem(local: LocalMemoryItem): MemoryItem {
	let parsedMetadata: Record<string, unknown> = {};
	try {
		parsedMetadata = JSON.parse(local.metadata_json);
	} catch {
		// metadata_json is corrupt; use empty defaults
	}
	const metadata: MemoryMetadata = {
		schema_version: 1,
		...parsedMetadata,
	};

	return {
		id: local.id,
		content: local.content,
		content_type: "text/plain",
		layer: local.layer,
		metadata,
		embedding: null,
		created_at: new Date(local.timestamp).toISOString(),
		last_accessed: new Date().toISOString(),
		access_count: 0,
		importance_score: local.score,
	};
}

export class LocalMemoryClient implements MemoryClient {
	private backend: LocalMemoryBackend;

	constructor(dbPath?: string) {
		this.backend = new LocalMemoryBackend(dbPath);
	}

	async recall(
		query: string,
		options: MemoryRecallOptions = {},
	): Promise<ReadonlyArray<MemoryItem>> {
		const results = this.backend.recall(query, {
			limit: options.limit,
			layer: options.layer,
		});

		return results.map(toMemoryItem);
	}

	async store(item: MemoryItem): Promise<void> {
		this.backend.store(toLocalItem(item));
	}

	dispose(): void {
		this.backend.close();
	}
}
