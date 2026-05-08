import { LRUCache } from "lru-cache";

export interface WebFetchCacheEntry {
	readonly bytes: number;
	readonly status: number;
	readonly contentType: string;
	readonly markdown: string;
	readonly truncated: boolean;
	readonly url: string;
}

export interface WebFetchCache {
	get(url: string): WebFetchCacheEntry | undefined;
	set(url: string, entry: WebFetchCacheEntry): void;
	clear(): void;
}

export interface WebFetchCacheOptions {
	readonly ttlMs?: number;
	readonly maxSizeBytes?: number;
	readonly clock?: () => number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;

export function createWebFetchCache(
	options: WebFetchCacheOptions = {},
): WebFetchCache {
	const inner = new LRUCache<string, WebFetchCacheEntry>({
		maxSize: options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
		ttl: options.ttlMs ?? DEFAULT_TTL_MS,
		sizeCalculation: (entry) => Math.max(1, entry.bytes),
		ttlAutopurge: false,
	});

	return {
		get(url) {
			return inner.get(url);
		},
		set(url, entry) {
			inner.set(url, entry);
		},
		clear() {
			inner.clear();
		},
	};
}
