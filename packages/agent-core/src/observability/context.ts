import { AsyncLocalStorage } from "node:async_hooks";

export interface ObservabilityRuntimeContext {
	readonly requestId?: string;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
}

const storage = new AsyncLocalStorage<ObservabilityRuntimeContext>();

export function getObservabilityContext(): ObservabilityRuntimeContext {
	return storage.getStore() ?? {};
}

export function runWithObservabilityContext<T>(
	context: ObservabilityRuntimeContext,
	callback: () => T,
): T {
	return storage.run(
		{
			...getObservabilityContext(),
			...context,
		},
		callback,
	);
}

export function createMCPRequestMetadata():
	| Record<string, unknown>
	| undefined {
	const { requestId } = getObservabilityContext();
	if (requestId == null) {
		return undefined;
	}

	return {
		request_id: requestId,
	};
}
