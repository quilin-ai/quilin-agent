import { NextResponse } from "next/server";
import { z } from "zod";

import { installOnboardingSoulImport } from "@/lib/onboarding-soul-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InstallBodySchema = z
	.object({
		confirmed: z.boolean().optional(),
		approvalToken: z.string().min(1).optional(),
		maxSnippetChars: z.number().int().min(256).max(20_000).optional(),
	})
	.optional();

async function readJson(request: Request): Promise<unknown> {
	if (request.headers.get("content-length") === "0") {
		return {};
	}
	try {
		return await request.json();
	} catch {
		return {};
	}
}

export async function POST(request: Request): Promise<Response> {
	const parsed = InstallBodySchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return NextResponse.json(
			{
				ok: false,
				error: {
					code: "invalid_body",
					message: "Invalid install request",
					detail: parsed.error.issues,
				},
			},
			{ status: 400 },
		);
	}

	try {
		const data = await installOnboardingSoulImport(parsed.data ?? {});
		return NextResponse.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json(
			{ ok: false, error: { code: "install_failed", message } },
			{ status: 500 },
		);
	}
}
