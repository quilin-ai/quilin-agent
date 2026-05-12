/**
 * GET /api/v2/sessions          列表 / List
 * GET /api/v2/sessions/:id      详情 / Detail
 */

import {
	errorResponse,
	errorToResponse,
	methodNotAllowedResponse,
	notFoundResponse,
	successResponse,
	validationErrorResponse,
} from "../responses.js";
import type { V2Runtime } from "../runtime.js";
import { ERROR_CODES, SessionId } from "../schemas.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function parseLimit(value: string | null): number | undefined {
	if (value == null || value === "") {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return Number.NaN;
	}
	if (parsed > MAX_LIMIT) {
		return MAX_LIMIT;
	}
	return parsed === 0 ? 0 : parsed;
}

export async function handle(
	request: Request,
	runtime: V2Runtime,
	pathRemainder = "",
): Promise<Response> {
	if (request.method !== "GET") {
		return methodNotAllowedResponse(["GET"]);
	}

	const trimmed = pathRemainder.replace(/^\/+|\/+$/g, "");

	// GET /api/v2/sessions  (list)
	if (trimmed === "" || trimmed === "/") {
		const url = new URL(request.url);
		const limit = parseLimit(url.searchParams.get("limit"));
		if (Number.isNaN(limit)) {
			return validationErrorResponse({
				field: "limit",
				reason: "must be a non-negative integer",
			});
		}
		const cursor = url.searchParams.get("cursor");
		try {
			const data = await runtime.listSessions({
				limit: limit ?? DEFAULT_LIMIT,
				cursor: cursor,
			});
			return successResponse(data);
		} catch (error) {
			return errorToResponse(error);
		}
	}

	// GET /api/v2/sessions/:id
	const idCandidate = decodeURIComponent(trimmed);
	const idCheck = SessionId.safeParse(idCandidate);
	if (!idCheck.success) {
		return validationErrorResponse({
			field: "id",
			reason: "must match SessionId schema",
			detail: idCheck.error.flatten(),
		});
	}

	try {
		const detail = await runtime.getSession(idCheck.data);
		if (detail == null) {
			return notFoundResponse(
				ERROR_CODES.sessionNotFound,
				`Session ${idCheck.data} not found`,
			);
		}
		return successResponse(detail);
	} catch (error) {
		if (error instanceof RangeError) {
			return errorResponse(400, ERROR_CODES.validationError, error.message);
		}
		return errorToResponse(error);
	}
}
