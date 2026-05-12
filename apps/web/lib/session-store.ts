/**
 * Browser-side session store for the demo. Persists conversations in
 * `localStorage` keyed by session id, so the /sessions list can show
 * previous conversations and restore them.
 *
 * Phase 1c will swap this out for a real server-side session DB via
 * `GET /api/v2/sessions` + `GET /api/v2/sessions/:id`.
 */

import type { UIMessage } from "ai";

const STORAGE_KEY = "quilin.web.sessions.v1";
const MAX_SESSIONS = 50;

export interface PersistedSession {
	readonly id: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
	readonly preview: string;
	readonly messages: readonly UIMessage[];
}

function readAll(): PersistedSession[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw == null) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed as PersistedSession[];
	} catch {
		return [];
	}
}

function writeAll(sessions: readonly PersistedSession[]): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
	} catch {
		/* quota or storage unavailable — silent fail */
	}
}

function extractText(message: UIMessage): string {
	const parts = (message.parts ?? []).filter(
		(p: { type: string }): p is { type: "text"; text: string } => p.type === "text",
	);
	return parts.map((p) => p.text).join("");
}

export function saveSession(input: {
	readonly id: string;
	readonly messages: readonly UIMessage[];
}): void {
	const { id, messages } = input;
	if (messages.length === 0) return;
	const all = readAll();
	const idx = all.findIndex((s) => s.id === id);
	const firstUser = messages.find((m) => m.role === "user");
	const lastAny = messages[messages.length - 1];
	const title = firstUser != null ? extractText(firstUser).slice(0, 80) : "(empty session)";
	const preview = lastAny != null ? extractText(lastAny).slice(0, 200) : "";
	const now = new Date().toISOString();
	const next: PersistedSession = {
		id,
		title: title || "(无标题)",
		createdAt: idx >= 0 && all[idx] != null ? all[idx].createdAt : now,
		updatedAt: now,
		messageCount: messages.length,
		preview,
		messages,
	};
	if (idx >= 0) {
		all[idx] = next;
	} else {
		all.unshift(next);
	}
	while (all.length > MAX_SESSIONS) all.pop();
	writeAll(all);
}

export function loadSession(id: string): PersistedSession | undefined {
	return readAll().find((s) => s.id === id);
}

export function listSessions(): readonly PersistedSession[] {
	return readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteSession(id: string): void {
	writeAll(readAll().filter((s) => s.id !== id));
}
