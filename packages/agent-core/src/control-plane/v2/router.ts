/**
 * Path-based router for /api/v2/* requests.
 *
 * Returns a Fetch-API `Response`. The Node http delegation layer in
 * `control-plane/handler.ts` is responsible for translating between the
 * IncomingMessage / ServerResponse pair and the Fetch Request/Response.
 *
 * /api/v2/* 路由分发器。返回 Fetch API 的 Response；与 Node http 的
 * IncomingMessage/ServerResponse 之间的桥接由 handler.ts 负责。
 */

import { notFoundResponse } from "./responses.js";
import * as agentsRoute from "./routes/agents.js";
import * as authorizeRoute from "./routes/authorize.js";
import * as configRoute from "./routes/config.js";
import * as eventsSseRoute from "./routes/events-sse.js";
import * as mcpRoute from "./routes/mcp.js";
import * as memoryRoute from "./routes/memory.js";
import * as sessionsRoute from "./routes/sessions.js";
import * as skillsRoute from "./routes/skills.js";
import * as snapshotRoute from "./routes/snapshot.js";
import * as toolsRoute from "./routes/tools.js";
import type { V2Runtime } from "./runtime.js";

const PREFIX = "/api/v2";

export interface RouteContext {
	readonly runtime: V2Runtime;
	readonly sseOptions?: import("./routes/events-sse.js").SseHandleOptions;
}

/**
 * Inspect the URL and dispatch to the appropriate handler. Returns null
 * if the path is not under `/api/v2/`, so callers can fall through to
 * legacy routes without overlap.
 *
 * 检查 URL，分发到对应处理器；非 /api/v2/* 返回 null，外层可继续走
 * 旧路由。
 */
export async function handleV2(
	request: Request,
	context: RouteContext,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(`${PREFIX}/`) && url.pathname !== PREFIX) {
		return null;
	}

	const pathAfterPrefix = url.pathname.slice(PREFIX.length); // includes leading '/' or empty
	const normalized = pathAfterPrefix === "" ? "/" : pathAfterPrefix;
	const segments = normalized.split("/").filter((segment) => segment !== "");
	const head = segments[0];

	if (head == null) {
		return notFoundResponse();
	}

	const { runtime, sseOptions } = context;

	switch (head) {
		case "snapshot":
			return snapshotRoute.handle(request, runtime);
		case "sessions": {
			const remainder = segments.slice(1).join("/");
			return sessionsRoute.handle(request, runtime, remainder);
		}
		case "memory": {
			const remainder = segments.slice(1).join("/");
			return memoryRoute.handle(request, runtime, remainder);
		}
		case "skills":
			return skillsRoute.handle(request, runtime);
		case "tools":
			return toolsRoute.handle(request, runtime);
		case "mcp":
			return mcpRoute.handle(request, runtime);
		case "config":
			return configRoute.handle(request, runtime);
		case "agents":
			return agentsRoute.handle(request, runtime);
		case "authorize":
			return authorizeRoute.handle(request, runtime);
		case "events":
			return eventsSseRoute.handle(request, runtime, sseOptions ?? {});
		default:
			return notFoundResponse();
	}
}
