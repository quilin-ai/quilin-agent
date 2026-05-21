import { NextResponse } from "next/server";
import { z } from "zod";

import {
	buildOnboardingPreviewBundle,
	issueOnboardingApprovalToken,
} from "@/lib/onboarding-soul-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ScanBodySchema = z
	.object({
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
	const parsed = ScanBodySchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return NextResponse.json(
			{
				ok: false,
				error: {
					code: "invalid_body",
					message: "Invalid scan request",
					detail: parsed.error.issues,
				},
			},
			{ status: 400 },
		);
	}

	try {
		const data = buildOnboardingPreviewBundle(parsed.data ?? {});
		return NextResponse.json(
			{ ok: true, data: { ...data, approvalToken: issueOnboardingApprovalToken(data) } },
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json(
			{ ok: false, error: { code: "scan_failed", message } },
			{ status: 500 },
		);
	}
}
