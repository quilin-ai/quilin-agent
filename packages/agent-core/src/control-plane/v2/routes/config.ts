/**
 * GET  /api/v2/config    返回当前 config / current config
 * POST /api/v2/config    应用 partial patch / apply partial patch
 *
 * POST 体经 ConfigPatchSchema 校验；critical 字段（trustMode / modelDefault）
 * 在 runtime 实现里走 WriteAuthority gate，未通过返回 403
 * `forbidden_critical_write`。
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
import { ConfigPatchSchema, ERROR_CODES } from "../schemas.js";

export async function handle(
	request: Request,
	runtime: V2Runtime,
): Promise<Response> {
	if (request.method === "GET") {
		try {
			const data = await runtime.getConfig();
			return successResponse(data);
		} catch (error) {
			return errorToResponse(error);
		}
	}

	if (request.method === "POST") {
		let body: unknown;
		try {
			body = await readJsonBody(request);
		} catch (error) {
			return validationErrorResponse({
				/* c8 ignore next: non-Error branch is defensive */
				reason: error instanceof Error ? error.message : String(error),
			});
		}
		const parsed = ConfigPatchSchema.safeParse(body);
		if (!parsed.success) {
			return validationErrorResponse(parsed.error.flatten());
		}
		try {
			const result = await runtime.writeConfig(parsed.data);
			if (result.kind === "forbidden") {
				return errorResponse(
					403,
					ERROR_CODES.forbiddenCriticalWrite,
					result.message,
					result.detail,
				);
			}
			return successResponse(result.config);
		} catch (error) {
			return errorToResponse(error);
		}
	}

	return methodNotAllowedResponse(["GET", "POST"]);
}
