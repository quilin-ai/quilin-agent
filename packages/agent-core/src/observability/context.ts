import { AsyncLocalStorage } from "node:async_hooks";

export interface ObservabilityRuntimeContext {
	readonly requestId?: string;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
}

export function createTraceparent(
	traceId: string | undefined,
	spanId: string | undefined,
): string | undefined {
	if (
		traceId == null ||
		spanId == null ||
		!/^[a-f0-9]{32}$/.test(traceId) ||
		!/^[a-f0-9]{16}$/.test(spanId)
	) {
		return undefined;
	}

	return `00-${traceId}-${spanId}-01`;
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
	const { requestId, spanId, traceId } = getObservabilityContext();
	if (requestId == null) {
		return undefined;
	}
	const traceparent = createTraceparent(traceId, spanId);

	return {
		request_id: requestId,
		...(traceparent == null ? {} : { traceparent }),
	};
}
