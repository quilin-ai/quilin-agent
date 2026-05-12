/**
 * POST /api/v2/authorize
 * 解决 WriteAuthority 待批准请求 / Resolve a pending WriteAuthority request.
 */

import { readJsonBody } from "../json-body.js";
import {
	errorResponse,
	errorToResponse,
	methodNotAllowedResponse,
	successResponse,
	validationErrorResponse,
} from "../responses.js";
import type { V2Runtime } from "../runtime.js";
import { AuthorizePostSchema, ERROR_CODES } from "../schemas.js";

export async function handle(
	request: Request,
	runtime: V2Runtime,
): Promise<Response> {
	if (request.method !== "POST") {
		return methodNotAllowedResponse(["POST"]);
	}

	let body: unknown;
	try {
		body = await readJsonBody(request);
	} catch (error) {
		return validationErrorResponse({
			/* c8 ignore next: non-Error branch is defensive */
			reason: error instanceof Error ? error.message : String(error),
		});
	}

	const parsed = AuthorizePostSchema.safeParse(body);
	if (!parsed.success) {
		return validationErrorResponse(parsed.error.flatten());
	}

	try {
		const result = await runtime.authorize(parsed.data);
		if (result.kind === "ok") {
			return successResponse({
				requestId: parsed.data.requestId,
				resolved: true,
			});
		}
		if (result.kind === "expired") {
			return errorResponse(410, ERROR_CODES.authRequestExpired, result.message);
		}
		if (result.kind === "already_resolved") {
			return errorResponse(
				409,
				ERROR_CODES.authRequestAlreadyResolved,
				result.message,
			);
		}
		// not_found
		return errorResponse(404, result.code, result.message);
	} catch (error) {
		return errorToResponse(error);
	}
}
