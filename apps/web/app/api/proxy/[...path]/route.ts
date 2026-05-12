/**
 * Quilin Agent · Next.js Route Handler proxy to the agent-core control plane.
 *
 * The agent-core HTTP server binds to 127.0.0.1 only (per
 * `packages/agent-core/src/control-plane/handler.ts`). The browser cannot
 * reach it directly when this Next.js dev server is on a different port, so
 * we forward every `/api/proxy/...` request through this Node runtime route.
 *
 * Env: `QUILIN_CONTROL_PLANE_URL` (default `http://127.0.0.1:0`). The default
 * is intentionally unusable so the user must explicitly point the proxy at a
 * running agent-core during local dev.
 */
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TARGET_BASE = process.env.QUILIN_CONTROL_PLANE_URL ?? "http://127.0.0.1:0";

const FORWARD_HEADERS = new Set([
	"accept",
	"accept-language",
	"content-type",
	"cache-control",
	"last-event-id",
	"authorization",
	"x-quilin-trace-id",
]);

function filterRequestHeaders(input: Headers): Headers {
	const out = new Headers();
	for (const [key, value] of input) {
		if (FORWARD_HEADERS.has(key.toLowerCase())) {
			out.set(key, value);
		}
	}
	return out;
}

async function forward(
	request: NextRequest,
	params: Promise<{ path: string[] }>,
): Promise<Response> {
	const { path } = await params;
	const search = request.nextUrl.search;
	const targetPath = path.join("/");
	const targetUrl = `${TARGET_BASE}/${targetPath}${search}`;

	// Read body lazily — never buffer SSE / streaming responses.
	const init: RequestInit = {
		method: request.method,
		headers: filterRequestHeaders(request.headers),
		// `duplex: "half"` required for streaming request bodies in undici.
		// Casting because TS lib types don't yet include the field.
		...(request.method === "GET" || request.method === "HEAD"
			? {}
			: { body: request.body, duplex: "half" }),
	} as RequestInit;

	let upstream: Response;
	try {
		upstream = await fetch(targetUrl, init);
	} catch (error) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "upstream_unreachable",
					message:
						"Quilin control-plane is not reachable. Set QUILIN_CONTROL_PLANE_URL or start the agent-core HTTP server.",
					detail: error instanceof Error ? error.message : String(error),
				},
			},
			{ status: 502 },
		);
	}

	// SSE responses must be streamed back unbuffered.
	const contentType = upstream.headers.get("content-type") ?? "";
	const isStream = contentType.includes("text/event-stream");

	const responseHeaders = new Headers();
	upstream.headers.forEach((value, key) => {
		// strip hop-by-hop headers
		const lower = key.toLowerCase();
		if (lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding") {
			return;
		}
		responseHeaders.set(key, value);
	});

	if (isStream) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: responseHeaders,
		});
	}

	const buffer = await upstream.arrayBuffer();
	return new Response(buffer, {
		status: upstream.status,
		headers: responseHeaders,
	});
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
	return forward(request, context.params);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
	return forward(request, context.params);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
	return forward(request, context.params);
}

export async function DELETE(
	request: NextRequest,
	context: { params: Promise<{ path: string[] }> },
) {
	return forward(request, context.params);
}

export async function PATCH(
	request: NextRequest,
	context: { params: Promise<{ path: string[] }> },
) {
	return forward(request, context.params);
}
