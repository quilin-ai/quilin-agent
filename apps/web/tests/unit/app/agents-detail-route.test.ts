import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/agents/[id]/route";
import { agentRegistry, type AgentStatus } from "@/lib/agent-registry";

function routeContext(id: string) {
	return { params: Promise.resolve({ id }) };
}

describe("GET /api/agents/[id]", () => {
	it("returns terminal subagent statuses unchanged for live progress polling", async () => {
		const terminalStatuses: readonly AgentStatus[] = ["completed", "failed", "cancelled", "blocked"];

		for (const status of terminalStatuses) {
			const id = `subagent-route-${status}`;
			agentRegistry.register({
				id,
				kind: "subagent",
				parentId: "parent-route-test",
				displayName: `route ${status}`,
				task: `status ${status}`,
				status,
			});

			const res = await GET(new Request(`http://localhost/api/agents/${id}`), routeContext(id));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: true; data: { status: AgentStatus } };
			expect(body.data.status).toBe(status);
		}
	});
});
