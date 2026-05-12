/**
 * Integration test: spin up a real `startControlPlaneServer`, hit /api/v2/*
 * via `fetch`, and verify the envelope shape, status codes, and zod-parseable
 * bodies for every Phase 1a endpoint.
 *
 * 集成测试：起一个真实的 `startControlPlaneServer`，用 fetch 调
 * /api/v2/* 的每个 endpoint，校验 envelope 形态、状态码、以及 zod
 * 解析能否通过。
 */

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneServer } from "../handler.js";
import {
	AgentSummarySchema,
	ConfigSchema,
	MCPRegistrySchema,
	MemoryTiersSchema,
	RuntimeSnapshotSchema,
	SessionsListResponse,
	SkillsCatalogSchema,
	ToolsCatalogSchema,
} from "./index.js";
import { createStubRuntime } from "./test-fixtures.js";

const servers: Awaited<ReturnType<typeof startControlPlaneServer>>[] = [];

async function startServer(): Promise<string> {
	const runtime = createStubRuntime();
	const handle = await startControlPlaneServer({
		v2Runtime: runtime,
		v2SseOptions: { heartbeatIntervalMs: 5 },
	});
	servers.push(handle);
	const address = handle.server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(handle) =>
				new Promise<void>((resolve, reject) => {
					handle.server.close((error) =>
						error == null ? resolve() : reject(error),
					);
				}),
		),
	);
});

describe("v2 control-plane API — integration", () => {
	it("snapshot returns runtime snapshot through envelope", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/snapshot`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(RuntimeSnapshotSchema.safeParse(body.data).success).toBe(true);
	});

	it("returns 503 for /api/v2/* when v2Runtime is not configured", async () => {
		const handle = await startControlPlaneServer({});
		servers.push(handle);
		const address = handle.server.address() as AddressInfo;
		const base = `http://127.0.0.1:${address.port}`;
		const response = await fetch(`${base}/api/v2/snapshot`);
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body.ok).toBe(false);
		expect(body.error?.code).toBe("v2_runtime_not_configured");
	});

	it("sessions list parses against SessionsListResponse", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/sessions?limit=5`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(SessionsListResponse.safeParse(body.data).success).toBe(true);
	});

	it("session detail returns 404 on missing", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/sessions/nope`);
		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error?.code).toBe("session_not_found");
	});

	it("memory tiers parses against MemoryTiersSchema", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/memory/tiers`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(MemoryTiersSchema.safeParse(body.data).success).toBe(true);
	});

	it("memory recent returns an { items } envelope", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/memory/recent?limit=2`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(Array.isArray(body.data?.items)).toBe(true);
	});

	it("skills/tools/mcp catalogs parse against their schemas", async () => {
		const base = await startServer();
		const [skills, tools, mcp] = await Promise.all([
			(await fetch(`${base}/api/v2/skills`)).json(),
			(await fetch(`${base}/api/v2/tools`)).json(),
			(await fetch(`${base}/api/v2/mcp`)).json(),
		]);
		expect(SkillsCatalogSchema.safeParse(skills.data).success).toBe(true);
		expect(ToolsCatalogSchema.safeParse(tools.data).success).toBe(true);
		expect(MCPRegistrySchema.safeParse(mcp.data).success).toBe(true);
	});

	it("config GET/POST round-trip applies patch and returns updated config", async () => {
		const base = await startServer();
		const get = await fetch(`${base}/api/v2/config`);
		const getBody = await get.json();
		expect(ConfigSchema.safeParse(getBody.data).success).toBe(true);

		const post = await fetch(`${base}/api/v2/config`, {
			method: "POST",
			body: JSON.stringify({ autoReflect: false }),
			headers: { "content-type": "application/json" },
		});
		const postBody = await post.json();
		expect(post.status).toBe(200);
		expect(postBody.data?.autoReflect).toBe(false);
	});

	it("config POST malformed body returns validation_error", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/config`, {
			method: "POST",
			body: "not-json",
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error?.code).toBe("validation_error");
	});

	it("agents endpoint parses each item against AgentSummarySchema", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/agents`);
		const body = await response.json();
		expect(Array.isArray(body.data?.items)).toBe(true);
		for (const agent of body.data.items) {
			expect(AgentSummarySchema.safeParse(agent).success).toBe(true);
		}
	});

	it("authorize approves successfully", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/authorize`, {
			method: "POST",
			body: JSON.stringify({ requestId: "any", decision: "approve" }),
		});
		expect(response.status).toBe(200);
	});

	it("authorize rejects malformed body with 400", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/authorize`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(400);
	});

	it("returns 404 for unknown v2 sub-path", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/api/v2/does-not-exist`);
		expect(response.status).toBe(404);
	});

	it("does not break legacy /control-plane snapshot route", async () => {
		const base = await startServer();
		const response = await fetch(`${base}/control-plane/snapshot`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.schemaVersion).toBe("quilin.control_plane.snapshot.v1");
	});

	it("SSE stream connects, sends heartbeat, then live event, then closes", async () => {
		const subscribers: Array<(event: unknown) => void> = [];
		const runtime = createStubRuntime({
			subscribeSse: (_options, subscriber) => {
				subscribers.push(subscriber as (event: unknown) => void);
				return {
					unsubscribe: () => {
						/* noop */
					},
				};
			},
		});
		const handle = await startControlPlaneServer({
			v2Runtime: runtime,
			v2SseOptions: { heartbeatIntervalMs: 5 },
		});
		servers.push(handle);
		const address = handle.server.address() as AddressInfo;
		const base = `http://127.0.0.1:${address.port}`;

		const controller = new AbortController();
		const response = await fetch(`${base}/api/v2/events?session=s`, {
			signal: controller.signal,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		// First read should yield the initial heartbeat
		const first = await reader?.read();
		expect(decoder.decode(first?.value ?? new Uint8Array())).toContain(
			"event: heartbeat",
		);
		// Fire a live event from the captured subscriber
		const subscriber = subscribers[0];
		if (subscriber == null) throw new Error("subscriber not captured");
		subscriber({
			kind: "tool-call",
			payload: { foo: "bar" },
		});
		const second = await reader?.read();
		const secondText = decoder.decode(second?.value ?? new Uint8Array());
		expect(secondText).toContain("event: tool-call");
		controller.abort();
		try {
			await reader?.cancel();
		} catch {
			/* signal-aborted reads can throw — fine */
		}
	});
});
