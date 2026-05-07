import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentState } from "../state/types.js";
import { createControlPlaneHandler } from "./handler.js";

const servers: ReturnType<typeof createServer>[] = [];
const NOW = "2026-05-07T08:00:00.000Z";

function state(sessionId: string): AgentState {
	return {
		createdAt: "2026-05-07T07:00:00.000Z",
		lastActiveAt:
			sessionId === "session-new"
				? "2026-05-07T07:30:00.000Z"
				: "2026-05-07T07:10:00.000Z",
		isTerminal: false,
		turnCount: 1,
		messages: [{ role: "user", content: `hello from ${sessionId}` }],
	};
}

async function startHandler(): Promise<string> {
	const server = createServer(
		createControlPlaneHandler({
			now: () => new Date(NOW),
			runtimeState: {
				generation: 1,
				booted: true,
				inFlight: false,
				inFlightGenerations: [],
				lastSuccess: null,
				lastFailure: null,
			},
			checkpoint: {
				list: async () => ["session-new", "session-old"],
				load: async (sessionId) => state(sessionId),
			},
			providerProbe: {
				env: {},
				existingCredentialPaths: [],
			},
		}),
	);
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error == null ? resolve() : reject(error)));
				}),
		),
	);
});

describe("control-plane handler", () => {
	it("serves the snapshot endpoint with session_limit support", async () => {
		const baseUrl = await startHandler();

		const response = await fetch(
			`${baseUrl}/control-plane/snapshot?session_limit=1`,
		);
		const snapshot = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(snapshot.generatedAt).toBe(NOW);
		expect(snapshot.agent.status).toBe("ready");
		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.sessions[0]).toMatchObject({
			sessionId: "session-new",
			messageCount: 1,
		});
	});

	it("supports HEAD and deterministic request errors", async () => {
		const baseUrl = await startHandler();

		const head = await fetch(`${baseUrl}/control-plane`, { method: "HEAD" });
		const missing = await fetch(`${baseUrl}/missing`);
		const badQuery = await fetch(`${baseUrl}/?session_limit=-1`);
		const post = await fetch(`${baseUrl}/control-plane`, { method: "POST" });

		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "not_found" });
		expect(badQuery.status).toBe(400);
		expect(await badQuery.json()).toEqual({
			error: "bad_request",
			message: "session_limit must be a non-negative integer",
		});
		expect(post.status).toBe(405);
		expect(await post.json()).toEqual({ error: "method_not_allowed" });
	});
});
