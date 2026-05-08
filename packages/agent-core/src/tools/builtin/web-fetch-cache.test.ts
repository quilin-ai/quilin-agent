import { describe, expect, it } from "vitest";
import {
	createWebFetchCache,
	type WebFetchCacheEntry,
} from "./web-fetch-cache.js";

function makeEntry(
	overrides: Partial<WebFetchCacheEntry> = {},
): WebFetchCacheEntry {
	return {
		bytes: 100,
		status: 200,
		contentType: "text/html",
		markdown: "hello",
		truncated: false,
		url: "https://example.com/",
		...overrides,
	};
}

describe("createWebFetchCache", () => {
	it("stores and retrieves entries by url", () => {
		const cache = createWebFetchCache();
		const entry = makeEntry();

		cache.set("https://example.com/", entry);

		expect(cache.get("https://example.com/")).toEqual(entry);
		expect(cache.get("https://other.example/")).toBeUndefined();
	});

	it("clears all entries", () => {
		const cache = createWebFetchCache();

		cache.set("https://example.com/", makeEntry());
		cache.set("https://example.org/", makeEntry({ url: "https://example.org/" }));
		cache.clear();

		expect(cache.get("https://example.com/")).toBeUndefined();
		expect(cache.get("https://example.org/")).toBeUndefined();
	});

	it("evicts entries that exceed the configured size budget", () => {
		const cache = createWebFetchCache({ maxSizeBytes: 200 });

		cache.set("https://a.example/", makeEntry({ bytes: 150 }));
		cache.set("https://b.example/", makeEntry({ bytes: 150 }));

		expect(cache.get("https://a.example/")).toBeUndefined();
		expect(cache.get("https://b.example/")).toBeDefined();
	});

	it("handles zero-byte entries by clamping size to 1", () => {
		const cache = createWebFetchCache({ maxSizeBytes: 4 });

		cache.set("https://a.example/", makeEntry({ bytes: 0 }));
		cache.set("https://b.example/", makeEntry({ bytes: 0 }));

		expect(cache.get("https://a.example/")).toBeDefined();
		expect(cache.get("https://b.example/")).toBeDefined();
	});
});
