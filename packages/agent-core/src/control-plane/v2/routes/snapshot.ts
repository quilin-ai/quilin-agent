/**
 * GET /api/v2/snapshot
 * 返回首次加载用的完整运行时快照 / Full runtime snapshot for first load.
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
		const data = await runtime.getRuntimeSnapshot();
		return successResponse(data);
	} catch (error) {
		return errorToResponse(error);
	}
}
