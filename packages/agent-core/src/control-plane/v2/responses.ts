/**
 * Response helpers for v2 control-plane routes.
 *
 * Centralizes the `{ ok, data?, error? }` envelope shape, the standard
 * HTTP status table per planning doc §4.13, and the validation_error
 * helper for failed zod parses.
 *
 * v2 控制面路由的响应辅助函数：统一 envelope 形态、标准 HTTP 状态码
 * (planning doc §4.13)，以及 zod 校验失败的 validation_error 帮助函数。
 */

import { ERROR_CODES, type ErrorCode } from "./schemas.js";

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
} as const;

export interface SuccessEnvelope<T> {
	readonly ok: true;
	readonly data: T;
}

export interface ErrorEnvelope {
	readonly ok: false;
	readonly error: {
		readonly code: string;
		readonly message: string;
		readonly detail?: unknown;
	};
}

export function successEnvelope<T>(data: T): SuccessEnvelope<T> {
	return { ok: true, data };
}

export function errorEnvelope(
	code: string,
	message: string,
	detail?: unknown,
): ErrorEnvelope {
	if (detail === undefined) {
		return { ok: false, error: { code, message } };
	}
	return { ok: false, error: { code, message, detail } };
}

export function jsonResponse(
	statusCode: number,
	body: unknown,
	extraHeaders: Readonly<Record<string, string>> = {},
): Response {
	return new Response(`${JSON.stringify(body)}\n`, {
		status: statusCode,
		headers: { ...JSON_HEADERS, ...extraHeaders },
	});
}

export function successResponse<T>(data: T, statusCode = 200): Response {
	return jsonResponse(statusCode, successEnvelope(data));
}

export function errorResponse(
	statusCode: number,
	code: string,
	message: string,
	detail?: unknown,
): Response {
	return jsonResponse(statusCode, errorEnvelope(code, message, detail));
}

export function notFoundResponse(
	code: ErrorCode = ERROR_CODES.notFound,
	message = "Not found",
): Response {
	return errorResponse(404, code, message);
}

export function methodNotAllowedResponse(allowed: readonly string[]): Response {
	return jsonResponse(
		405,
		errorEnvelope(ERROR_CODES.methodNotAllowed, "Method not allowed"),
		{ allow: allowed.join(", ") },
	);
}

export function validationErrorResponse(detail: unknown): Response {
	return errorResponse(
		400,
		ERROR_CODES.validationError,
		"Request payload validation failed",
		detail,
	);
}

export function internalErrorResponse(message: string): Response {
	return errorResponse(500, ERROR_CODES.internal, message);
}

/**
 * Map a thrown error into a 500 response. Logs nothing — the caller can
 * wire a logger in higher-level middleware.
 *
 * 把异常转成 500 响应；日志由上层处理，避免在多 logger/路由间产生
 * 重复输出。
 */
export function errorToResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	return internalErrorResponse(message);
}
