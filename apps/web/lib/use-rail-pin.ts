"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared pinned-state for the left navigation rail.
 *
 * Behavior contract:
 *   - When the user clicks any rail item, the rail pins (expanded) and stays
 *     expanded across the page navigation.
 *   - When the rail is pinned and the user clicks anywhere outside the rail,
 *     it unpins (collapses; CSS `:hover` still works to expand on demand).
 *
 * 实现方式 / Implementation:
 *   - Persisted in `sessionStorage` so the state survives Next.js client-side
 *     navigation (page unmount + remount preserves the flag).
 *   - Cross-component subscription via a module-level Set of listeners +
 *     `useSyncExternalStore` so every mounted RailStrip stays in sync.
 *   - Per-tab scope (sessionStorage) — opening a new tab starts unpinned.
 */

const STORAGE_KEY = "q-rail-pinned";
const listeners = new Set<() => void>();

function readPinned(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.sessionStorage.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function writePinned(value: boolean): void {
	if (typeof window === "undefined") return;
	try {
		if (value) {
			window.sessionStorage.setItem(STORAGE_KEY, "true");
		} else {
			window.sessionStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		/* private mode / storage quota — non-fatal */
	}
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}

/**
 * Returns `[pinned, setPinned]`. Identical signature to `useState<boolean>`
 * but the value is shared across every RailStrip mounted in the same tab.
 */
export function useRailPin(): readonly [boolean, (next: boolean) => void] {
	const pinned = useSyncExternalStore(
		subscribe,
		readPinned,
		() => false, // SSR default — server always renders as unpinned
	);
	return [pinned, writePinned];
}
