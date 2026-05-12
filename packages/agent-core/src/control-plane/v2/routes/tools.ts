/**
 * GET /api/v2/tools
 */

import {
	errorToResponse,
	methodNotAllowedResponse,
	successResponse,
} from "../responses.js";
import type { V2Runtime } from "../runtime.js";

export async function handle(
	request: Request,
	runtime: V2Runtime,
): Promise<Response> {
	if (request.method !== "GET") {
		return methodNotAllowedResponse(["GET"]);
	}

	try {
		const data = await runtime.listTools();
		return successResponse(data);
	} catch (error) {
		return errorToResponse(error);
	}
}
