/**
 * In-memory agent registry for the demo subagent spawn feature.
 * Lives in the Next.js process (module-singleton survives between requests
 * within the same dev/server lifetime). Frontend reads via GET /api/agents
 * and mutates via POST /api/agents/spawn.
 */

export type AgentKind = "main" | "subagent";
export type AgentStatus =
	| "pending"
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "cancelled";

export interface AgentRecord {
	readonly id: string;
	readonly kind: AgentKind;
	readonly parentId: string | null;
	readonly task: string | null;
	status: AgentStatus;
	readonly startedAt: string;
	lastHeartbeatAt: string | null;
	streamedText: string;
}

export interface AgentSummary {
	readonly id: string;
	readonly kind: AgentKind;
	readonly parentId: string | null;
	readonly task: string | null;
	readonly status: AgentStatus;
	readonly startedAt: string;
	readonly elapsedMs: number;
	readonly lastHeartbeatAt: string | null;
}

function nowIso(): string {
	return new Date().toISOString();
}

class InMemoryAgentRegistry {
	private readonly records = new Map<string, AgentRecord>();

	constructor() {
		this.records.set("main", {
			id: "main",
			kind: "main",
			parentId: null,
			task: null,
			status: "running",
			startedAt: nowIso(),
			lastHeartbeatAt: nowIso(),
			streamedText: "",
		});
	}

	list(): readonly AgentRecord[] {
		return [...this.records.values()];
	}

	register(
		input: Omit<AgentRecord, "startedAt" | "lastHeartbeatAt" | "streamedText">,
	): AgentRecord {
		const started = nowIso();
		const record: AgentRecord = {
			...input,
			startedAt: started,
			lastHeartbeatAt: started,
			streamedText: "",
		};
		this.records.set(record.id, record);
		return record;
	}

	updateStatus(id: string, status: AgentStatus): void {
		const r = this.records.get(id);
		if (!r) return;
		r.status = status;
		r.lastHeartbeatAt = nowIso();
	}

	appendStream(id: string, delta: string): void {
		const r = this.records.get(id);
		if (!r) return;
		r.streamedText += delta;
		r.lastHeartbeatAt = nowIso();
	}

	toSummaries(): readonly AgentSummary[] {
		const now = Date.now();
		return this.list().map((r) => ({
			id: r.id,
			kind: r.kind,
			parentId: r.parentId,
			task: r.task,
			status: r.status,
			startedAt: r.startedAt,
			elapsedMs: Math.max(0, now - new Date(r.startedAt).getTime()),
			lastHeartbeatAt: r.lastHeartbeatAt,
		}));
	}
}

// Module-level singleton — survives across requests within one Next.js worker.
// In dev with Turbopack HMR this resets on file edit; that's acceptable for demo.
declare global {
	// biome-ignore lint/style/noVar: needed for module-level singleton in Next.js
	var __quilin_agent_registry__: InMemoryAgentRegistry | undefined;
}

export const agentRegistry: InMemoryAgentRegistry =
	globalThis.__quilin_agent_registry__ ?? new InMemoryAgentRegistry();
if (!globalThis.__quilin_agent_registry__) {
	globalThis.__quilin_agent_registry__ = agentRegistry;
}

export function shortId(): string {
	return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}
