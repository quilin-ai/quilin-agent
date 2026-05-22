/**
 * POST /api/memory/recover
 *
 * 真人 QA dogfood 发现的 D.15 修复:
 * - DB schema 真有 `recovered_at` + 7 天 `forget_after` window
 * - quilin-mem MCP 真有 `memory_recover` tool + `_recover_memory_sync`
 * - 但 Web 端没 route → /memory page 删错的记忆**永远找不回**
 *
 * 本 route 调 `memory_recover` MCP tool,把 `deleted=1` 的 record 翻回
 * `deleted=0` + 写 `recovered_at` 时间戳。
 *
 * Request body: { memoryId: string }
 * Response 200: { ok: true, data: { recovered: true } }
 * Response 4xx: { ok: false, error: { code, message } }
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RecoverBodySchema = z.object({
	memoryId: z.string().min(1, "memoryId required"),
});

interface ToolContentItem {
	readonly type?: string;
	readonly text?: string;
}

function parseToolContent(content: unknown): unknown {
	if (Array.isArray(content)) {
		const textItem = (content as ToolContentItem[]).find(
			(c) => c?.type === "text" && typeof c.text === "string",
		);
		if (textItem?.text != null) {
			try {
				return JSON.parse(textItem.text);
			} catch {
				return textItem.text;
			}
		}
	}
	if (typeof content === "string") {
		try {
			return JSON.parse(content);
		} catch {
			return content;
		}
	}
	return content;
}

export async function POST(req: Request): Promise<Response> {
	let parsed: z.infer<typeof RecoverBodySchema>;
	try {
		const body = (await req.json()) as unknown;
		parsed = RecoverBodySchema.parse(body);
	} catch (e) {
		return NextResponse.json(
			{
				ok: false,
				error: {
					code: "invalid_request",
					message: e instanceof Error ? e.message : String(e),
				},
			},
			{ status: 400 },
		);
	}

	const catalog = await getToolsCatalog();
	const tool = catalog.rawTools.find((t) => t.name === "quilin-mem/memory_recover");
	if (tool == null) {
		return NextResponse.json(
			{
				ok: false,
				error: {
					code: "tool_not_available",
					message: "quilin-mem MCP server is not connected or memory_recover tool not registered",
				},
			},
			{ status: 503 },
		);
	}

	try {
		const result = await tool.execute({ memory_id: parsed.memoryId });
		const isError = result.isError === true;
		const body = parseToolContent(result.content);
		if (isError) {
			return NextResponse.json(
				{
					ok: false,
					error: {
						code: "recover_failed",
						message: typeof body === "string" ? body : JSON.stringify(body),
					},
				},
				{ status: 500 },
			);
		}
		// memory_recover_tool returns { recovered: bool, memory_id, recovered_at? }
		const recovered = (body as { recovered?: boolean })?.recovered === true;
		return NextResponse.json({
			ok: true,
			data: {
				recovered,
				memoryId: parsed.memoryId,
				recoveredAt: (body as { recovered_at?: string })?.recovered_at ?? null,
			},
		});
	} catch (e) {
		return NextResponse.json(
			{
				ok: false,
				error: {
					code: "recover_exception",
					message: e instanceof Error ? e.message : String(e),
				},
			},
			{ status: 500 },
		);
	}
}
