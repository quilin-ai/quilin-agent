import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ConflictChoice = "keep_a" | "keep_b" | "merge_manual";

interface ResolveConflictBody {
	readonly memoryId?: string;
	readonly memory_id?: string;
	readonly choice?: string;
	readonly decision?: string;
	readonly mergedContent?: string;
	readonly merged_content?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function pickNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asChoice(value: unknown): ConflictChoice | null {
	return value === "keep_a" || value === "keep_b" || value === "merge_manual" ? value : null;
}

function parseResolveConflictBody(value: unknown):
	| {
			readonly ok: true;
			readonly memoryId: string;
			readonly choice: ConflictChoice;
			readonly mergedContent?: string;
	  }
	| { readonly ok: false; readonly message: string } {
	if (!isObject(value)) {
		return { ok: false, message: "expected JSON object body" };
	}
	const body = value as ResolveConflictBody;
	const memoryId = pickNonEmptyString(body.memoryId) ?? pickNonEmptyString(body.memory_id);
	if (memoryId == null) {
		return { ok: false, message: "expected non-empty memoryId or memory_id" };
	}
	const choice = asChoice(body.choice ?? body.decision);
	if (choice == null) {
		return { ok: false, message: "expected choice keep_a, keep_b, or merge_manual" };
	}
	const mergedContent =
		pickNonEmptyString(body.mergedContent) ?? pickNonEmptyString(body.merged_content);
	if (choice === "merge_manual" && mergedContent == null) {
		return { ok: false, message: "merge_manual requires mergedContent or merged_content" };
	}
	return mergedContent == null
		? { ok: true, memoryId, choice }
		: { ok: true, memoryId, choice, mergedContent };
}

function parseToolContent(content: string): unknown {
	const trimmed = content.trim();
	if (trimmed.length === 0) return null;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return trimmed;
	}
}

function inferResolved(parsed: unknown): boolean {
	if (!isObject(parsed)) return true;
	if (typeof parsed.resolved === "boolean") return parsed.resolved;
	if (typeof parsed.ok === "boolean") return parsed.ok;
	return true;
}

export async function POST(request: Request): Promise<Response> {
	try {
		let rawBody: unknown;
		try {
			const text = await request.text();
			rawBody = text.length > 0 ? JSON.parse(text) : {};
		} catch {
			return Response.json(
				{
					ok: false,
					error: { code: "invalid_body", message: "request body must be JSON" },
				},
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}

		const parsedBody = parseResolveConflictBody(rawBody);
		if (!parsedBody.ok) {
			return Response.json(
				{
					ok: false,
					error: { code: "invalid_body", message: parsedBody.message },
				},
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}

		const catalog = await getToolsCatalog();
		const toolNames = [
			"quilin-mem/memory_resolve_conflict",
			"quilin-mem/resolve_conflict",
			"memory_resolve_conflict",
			"resolve_conflict",
		];
		const activeTool = catalog.rawTools.find((tool) => toolNames.includes(tool.name));
		if (activeTool == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_resolve_conflict_unavailable",
						message:
							"quilin-mem MCP server is not connected, or memory_resolve_conflict/resolve_conflict tool is missing.",
					},
				},
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		const toolArgs: {
			memory_id: string;
			decision: ConflictChoice;
			merged_content?: string;
		} = {
			memory_id: parsedBody.memoryId,
			decision: parsedBody.choice,
		};
		if (parsedBody.mergedContent != null) {
			toolArgs.merged_content = parsedBody.mergedContent;
		}

		const result = await activeTool.execute(toolArgs);
		if (result.isError) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_resolve_conflict_failed",
						message: result.error?.message ?? result.content,
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		const output = parseToolContent(result.content);
		return Response.json(
			{
				ok: true,
				data: {
					memoryId: parsedBody.memoryId,
					choice: parsedBody.choice,
					resolved: inferResolved(output),
					toolName: activeTool.name,
					result: output,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/memory/resolve-conflict] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "memory_resolve_conflict_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
