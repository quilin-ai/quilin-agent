/**
 * GET /api/v2/memory/tiers      4-tier counts + previews
 * GET /api/v2/memory/recent     recent entries (filterable by tier)
 */

import {
	errorToResponse,
	methodNotAllowedResponse,
	notFoundResponse,
	successResponse,
	validationErrorResponse,
} from "../responses.js";
import type { V2Runtime } from "../runtime.js";
import { MemoryTierName } from "../schemas.js";

const MAX_RECENT_LIMIT = 200;
const DEFAULT_RECENT_LIMIT = 50;

export async function handle(
	request: Request,
	runtime: V2Runtime,
	pathRemainder = "",
): Promise<Response> {
	if (request.method !== "GET") {
		return methodNotAllowedResponse(["GET"]);
	}

	const trimmed = pathRemainder.replace(/^\/+|\/+$/g, "");

	if (trimmed === "tiers") {
		try {
			const data = await runtime.listMemoryTiers();
			return successResponse(data);
		} catch (error) {
			return errorToResponse(error);
		}
	}

	if (trimmed === "recent") {
		const url = new URL(request.url);
		const tierParam = url.searchParams.get("tier");
		let tier: import("../schemas.js").MemoryTier["tier"] | undefined;
		if (tierParam != null) {
			const check = MemoryTierName.safeParse(tierParam);
			if (!check.success) {
				return validationErrorResponse({
					field: "tier",
					reason: "must be one of working/episodic/semantic/skill",
				});
			}
			tier = check.data;
		}
		const limitStr = url.searchParams.get("limit");
		let limit = DEFAULT_RECENT_LIMIT;
		if (limitStr != null && limitStr !== "") {
			const parsed = Number(limitStr);
			if (!Number.isInteger(parsed) || parsed < 0) {
				return validationErrorResponse({
					field: "limit",
					reason: "must be a non-negative integer",
				});
			}
			limit = Math.min(parsed, MAX_RECENT_LIMIT);
		}
		try {
			const items = await runtime.listMemoryRecent(
				tier == null ? { limit } : { tier, limit },
			);
			return successResponse({ items });
		} catch (error) {
			return errorToResponse(error);
		}
	}

	return notFoundResponse();
}
