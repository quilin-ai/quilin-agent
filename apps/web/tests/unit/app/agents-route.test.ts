import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "@/lib/agent-service-client";

const state = vi.hoisted(() => ({
	sessions: [] as AgentSession[],
}));

vi.mock("@/lib/agent-service-client", () => ({
	getAgentService: vi.fn(async () => ({
		getSession(id: string) {
			return state.sessions.find((session) => session.id === id) ?? null;
		},
	})),
}));

import { GET } from "@/app/api/agents/route";

function makeSession(overrides: Partial<AgentSession>): AgentSession {
	return {
		id: "session-1",
		title: "Session 1",
		origin: "web",
		status: "running",
		turnCount: 1,
		createdAt: "2026-05-20T00:00:00.000Z",
		lastActiveAt: "2026-05-20T00:00:00.000Z",
		...overrides,
	};
}

describe("GET /api/agents", () => {
	beforeEach(() => {
		state.sessions = [];
	});

	it("derives the session-scoped main agent status from AgentService", async () => {
		state.sessions = [
			makeSession({
				id: "session-completed",
				status: "completed",
				createdAt: "2026-05-20T00:00:00.000Z",
				lastActiveAt: "2026-05-20T00:00:07.000Z",
			}),
		];

		const res = await GET(new Request("http://localhost/api/agents?parent=session-completed"));

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			readonly ok: boolean;
			readonly data: {
				readonly items: ReadonlyArray<{
					readonly id: string;
					readonly kind: string;
					readonly status: string;
					readonly startedAt: string;
					readonly elapsedMs: number;
					readonly lastHeartbeatAt: string | null;
				}>;
			};
		};
		const main = body.data.items.find((agent) => agent.kind === "main");
		expect(main).toMatchObject({
			id: "main",
			status: "completed",
			startedAt: "2026-05-20T00:00:00.000Z",
			elapsedMs: 7000,
			lastHeartbeatAt: "2026-05-20T00:00:07.000Z",
		});
	});
});
